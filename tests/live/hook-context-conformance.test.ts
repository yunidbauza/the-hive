// @vitest-environment node
import { execFileSync, spawn } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { readTranscript as readScreen } from '../../electron/main/integrations/slack/tty';
import type { HookEvent } from '../../electron/shared/hook-contract';

/**
 * Can a hook's response put text into a session's context? (HIVE-136)
 *
 * ## Why this suite has to exist
 *
 * The receiver answers 204 to every hook route and has never returned hook
 * output, so nothing in this codebase has ever exercised the path. The one
 * precedent is recorded in `hook-contract.ts`: `SessionStart` is subscribed
 * over http and never arrives, while a `command` handler on the same event
 * runs fine. Hook transport behaviour here is not something to reason about
 * from documentation, and the documentation's claim — that an http handler's
 * response body "uses the same JSON output format as command hooks" — is
 * exactly the claim under test.
 *
 * ## What it measures
 *
 * One real `claude` in a real pty, outside the app, with a stub receiver that
 * answers `hookSpecificOutput.additionalContext` instead of 204. Every
 * handler carries its own secret token, so one session measures the whole
 * matrix: http and `command` on `UserPromptSubmit`, `PreToolUse`,
 * `PostToolUse` and `SessionStart`. The transcript says which tokens reached
 * the conversation, and the model is asked to echo every token it can see,
 * which says which of those it can act on.
 *
 * Four more sessions measure what the payload half of HIVE-135 would then
 * depend on: a non-2xx status, a slow response inside the handler's timeout,
 * one past it, and a receiver that is not there at all.
 *
 * ## Why it is opt-in
 *
 * Five real `claude` sessions, real tokens, a few minutes.
 *
 * ```
 * pnpm test:hook-context
 * ```
 *
 * Each session runs in its own throwaway directory, so it neither reads this
 * repository's `CLAUDE.md` nor lands in its `--resume` history. The user's own
 * `~/.claude/settings.json` is excluded with `--setting-sources project`,
 * which the runs prove leaves `--settings` in force: it carries `command`
 * hooks of its own, and a token that arrived through one of those would be
 * evidence about the wrong handler.
 */
const enabled = process.env.HIVE_LIVE_HOOK_CONTEXT_PROOF === '1';

const EVENTS = [
  'SessionStart',
  'UserPromptSubmit',
  'PreToolUse',
  'PostToolUse',
] as const satisfies readonly HookEvent[];
type Event = (typeof EVENTS)[number];
type Transport = 'http' | 'command';

const PROMPT =
  'Run exactly this command with the Bash tool: echo hive-spike. ' +
  'Then reply with every string of the form TOKEN_x_y_z that appears anywhere in your context, ' +
  'one per line and nothing else. If you can see none, reply NONE.';

/** Cold start, the trust dialog, one Haiku turn with a tool call, a slow hook. */
const BUDGET_S = 110;

/** The delay of the slow-but-in-time response, which the prompt must wait out. */
const SLOW_MS = 5000;

interface Run {
  label: string;
  /** The stub path the `UserPromptSubmit` http handler posts to. */
  upsPath: string;
  /** The `timeout` written on every http handler, in seconds. */
  timeout: number;
  /** Attach the full matrix: `command` handlers, and http on the other events. */
  matrix: boolean;
  /** Point the `UserPromptSubmit` handler at a port nothing listens on. */
  gone: boolean;
  /** What the `UserPromptSubmit` http response did, as measured. */
  outcome: 'context' | 'error-shown' | 'timed-out' | 'refused';
}

const RUNS: Run[] = [
  { label: 'matrix', upsPath: '/ctx', timeout: 10, matrix: true, gone: false, outcome: 'context' },
  { label: 'status-500', upsPath: '/ctx-500', timeout: 10, matrix: false, gone: false, outcome: 'error-shown' },
  { label: 'slow-in-time', upsPath: `/slow-${SLOW_MS}`, timeout: 10, matrix: false, gone: false, outcome: 'context' },
  { label: 'slow-past-timeout', upsPath: '/slow-15000', timeout: 5, matrix: false, gone: false, outcome: 'timed-out' },
  { label: 'receiver-gone', upsPath: '/ctx', timeout: 10, matrix: false, gone: true, outcome: 'refused' },
];

interface Arrival {
  at: number;
  path: string;
  event: string;
  respondedAt: number | null;
}

interface Hit {
  /** The record's own `type`. */
  type: string;
  /** `attachment.type` when the record is one: `hook_success`, `hook_additional_context`. */
  attachment: string | null;
  role: string | null;
  snippet: string;
}

interface Finding {
  label: string;
  version: string;
  tokens: Record<string, string>;
  arrivals: Arrival[];
  hits: Record<string, Hit[]>;
  echoed: string[];
  /** `Stop` arrival relative to the `UserPromptSubmit` arrival. */
  turnMs: number | null;
  /** The first assistant record's timestamp relative to the `UserPromptSubmit` arrival. */
  firstReplyMs: number | null;
  screenLines: string[];
  transcriptPath: string | null;
}

const tokenKey = (transport: Transport, event: string): string => `${transport}:${event}`;

function contextBody(event: string, token: string): string {
  return JSON.stringify({
    hookSpecificOutput: {
      hookEventName: event,
      additionalContext: `${token} (placed by the ${event} hook)`,
    },
  });
}

interface Stub {
  url: string;
  /** From the first hook body: where Claude says this session's transcript is. */
  transcriptPath: string | null;
  close: () => Promise<void>;
}

/**
 * The stub receiver. Behaviour is chosen by path so one server serves every
 * run: `/ctx` answers 200 with context, `/ctx-500` the same body with a 500,
 * `/slow-<ms>` waits that long first, `/sink` is the 204 the app sends today
 * and is what `Stop` posts to, which is how a turn's end is timed.
 */
function startStub(tokens: Map<string, string>, arrivals: Arrival[]): Promise<Stub> {
  const stub: Stub = { url: '', transcriptPath: null, close: () => Promise.resolve() };
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const path = req.url ?? '/';
      let event = '?';
      try {
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>;
        if (typeof body.hook_event_name === 'string') event = body.hook_event_name;
        if (typeof body.transcript_path === 'string') stub.transcriptPath ??= body.transcript_path;
      } catch {
        // A body that is not JSON is itself a finding; it is logged as '?'.
      }
      const arrival: Arrival = { at: Date.now(), path, event, respondedAt: null };
      arrivals.push(arrival);

      const token = tokens.get(tokenKey('http', event)) ?? `TOKEN_http_${event}_unplanned`;
      const reply = (status: number, body: string | null): void => {
        arrival.respondedAt = Date.now();
        if (body === null) {
          res.writeHead(status).end();
          return;
        }
        res.writeHead(status, { 'content-type': 'application/json' }).end(body);
      };

      const slow = /^\/slow-(\d+)$/u.exec(path);
      if (path === '/ctx') reply(200, contextBody(event, token));
      else if (path === '/ctx-500') reply(500, contextBody(event, token));
      else if (slow !== null) {
        // Unref'd: a reply Claude has already given up on must not hold the suite open.
        setTimeout(() => reply(200, contextBody(event, token)), Number(slow[1])).unref();
      } else reply(204, null);
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address !== null ? address.port : 0;
      stub.url = `http://127.0.0.1:${port}`;
      stub.close = () =>
        new Promise<void>((done) => {
          server.closeAllConnections();
          server.close(() => done());
        });
      resolve(stub);
    });
  });
}

/** A loopback port that was just listened on and released, so nothing answers it. */
function closedPort(): Promise<number> {
  return new Promise((resolve) => {
    const probe = createServer();
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address();
      const port = typeof address === 'object' && address !== null ? address.port : 0;
      probe.close(() => resolve(port));
    });
  });
}

function settingsFor(run: Run, base: string, upsBase: string, tokens: Map<string, string>): unknown {
  const http = (origin: string, path: string): unknown => ({
    type: 'http',
    url: `${origin}${path}`,
    timeout: run.timeout,
  });
  const command = (event: Event): unknown => ({
    type: 'command',
    command: `printf '%s' '${contextBody(event, tokens.get(tokenKey('command', event)) ?? '')}'`,
    timeout: run.timeout,
  });
  const ups = http(upsBase, run.upsPath);
  const hooks: Record<string, unknown> = {
    UserPromptSubmit: [{ matcher: '*', hooks: run.matrix ? [ups, command('UserPromptSubmit')] : [ups] }],
    Stop: [{ matcher: '*', hooks: [http(base, '/sink')] }],
  };
  if (run.matrix) {
    for (const event of EVENTS) {
      if (event === 'UserPromptSubmit') continue;
      hooks[event] = [{ matcher: '*', hooks: [http(base, '/ctx'), command(event)] }];
    }
  }
  return { hooks };
}

interface Analysis {
  hits: Record<string, Hit[]>;
  echoed: string[];
  firstAssistantAt: number | null;
}

function analyse(lines: string[], tokens: Map<string, string>): Analysis {
  const hits: Record<string, Hit[]> = {};
  let assistantText = '';
  let firstAssistantAt: number | null = null;
  for (const line of lines) {
    let record: Record<string, unknown>;
    try {
      record = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    const type = typeof record.type === 'string' ? record.type : '?';
    const attachment = record.attachment as Record<string, unknown> | undefined;
    const message = record.message as Record<string, unknown> | undefined;
    const role = typeof message?.role === 'string' ? message.role : null;
    if (role === 'assistant' && Array.isArray(message?.content)) {
      if (firstAssistantAt === null && typeof record.timestamp === 'string') {
        firstAssistantAt = Date.parse(record.timestamp);
      }
      for (const block of message.content as Record<string, unknown>[]) {
        if (block.type === 'text' && typeof block.text === 'string') assistantText += `${block.text}\n`;
      }
    }
    for (const [key, token] of tokens) {
      const index = line.indexOf(token);
      if (index === -1) continue;
      (hits[key] ??= []).push({
        type,
        attachment: typeof attachment?.type === 'string' ? attachment.type : null,
        role,
        snippet: line.slice(Math.max(0, index - 120), index + token.length + 40),
      });
    }
  }
  const echoed = [...tokens]
    .filter(([, token]) => assistantText.includes(token))
    .map(([key]) => key);
  return { hits, echoed, firstAssistantAt };
}

async function measure(run: Run): Promise<Finding> {
  const version = execFileSync('claude', ['--version'], { encoding: 'utf8' }).trim();
  const nonce = randomBytes(2).toString('hex');
  const tokens = new Map<string, string>();
  for (const event of EVENTS) {
    for (const transport of ['http', 'command'] as const) {
      tokens.set(tokenKey(transport, event), `TOKEN_${transport}_${event}_${nonce}`);
    }
  }

  const arrivals: Arrival[] = [];
  const stub = await startStub(tokens, arrivals);
  const upsBase = run.gone ? `http://127.0.0.1:${await closedPort()}` : stub.url;
  const sessionUuid = randomUUID();
  const dir = mkdtempSync(join(tmpdir(), `hive-hook-context-${run.label}-`));
  const settingsPath = join(dir, 'settings.json');
  const dump = join(dir, 'pty.bin');
  const doneFile = join(dir, 'done');
  writeFileSync(settingsPath, JSON.stringify(settingsFor(run, stub.url, upsBase, tokens)), 'utf8');

  const argv = [
    'claude',
    '--settings',
    settingsPath,
    '--setting-sources',
    'project',
    '--session-id',
    sessionUuid,
    '--model',
    'haiku',
    '--allowedTools',
    'Bash(echo *)',
  ];
  /*
    The cwd is the run's own directory, which Claude has never seen, so the
    trust dialog opens first and is answered the way `title-conformance` does.
    Typing waits for that answer: a prompt typed into the dialog is dropped,
    and the run would then wait its whole budget for a submit that never came.
    The late fallback covers a release that stops asking.
  */
  const driver = [
    'import os, pty, select, time',
    "env = dict(os.environ, TERM='xterm-256color')",
    "env.pop('CLAUDE_CODE_CHILD_SESSION', None)",
    `argv = ${JSON.stringify(argv)}`,
    `os.chdir(${JSON.stringify(dir)})`,
    'pid, fd = pty.fork()',
    "if pid == 0: os.execvpe('claude', argv, env)",
    'buf = bytearray()',
    'trusted = False',
    'start = time.time(); step = 0',
    `while time.time() - start < ${BUDGET_S}:`,
    '    r, _, _ = select.select([fd], [], [], 0.3)',
    '    if r:',
    '        try: d = os.read(fd, 65536)',
    '        except OSError: break',
    '        if not d: break',
    '        buf += d',
    '        if not trusted and b"safety" in bytes(buf):',
    '            time.sleep(0.6)',
    '            os.write(fd, b"\\x1b[B")',
    '            time.sleep(0.3)',
    '            os.write(fd, b"\\r")',
    '            trusted = True',
    '    now = time.time() - start',
    `    if step == 0 and now > 8 and (trusted or now > 20): os.write(fd, ${JSON.stringify(PROMPT)}.encode()); step = 1; typed = now`,
    "    elif step == 1 and now > typed + 3: os.write(fd, b'\\r'); step = 2",
    `    elif step == 2 and os.path.exists(${JSON.stringify(doneFile)}): break`,
    'try: os.kill(pid, 9)',
    'except Exception: pass',
    `open(${JSON.stringify(dump)}, 'wb').write(bytes(buf))`,
  ].join('\n');

  const child = spawn('python3', ['-c', driver], { stdio: 'ignore' });
  const exited = new Promise<void>((resolve) => {
    child.on('exit', () => resolve());
    // No `python3` on PATH is a broken harness, reported at once, not after the budget.
    child.on('error', () => resolve());
  });

  // The turn is over when Stop lands; a few seconds more lets the transcript flush.
  const poll = setInterval(() => {
    if (arrivals.some((a) => a.event === 'Stop')) {
      clearInterval(poll);
      setTimeout(() => writeFileSync(doneFile, ''), 4000).unref();
    }
  }, 250);
  await exited;
  clearInterval(poll);
  await stub.close();

  const lines =
    stub.transcriptPath !== null && existsSync(stub.transcriptPath)
      ? readFileSync(stub.transcriptPath, 'utf8').split('\n').filter((line) => line !== '')
      : null;
  const { hits, echoed, firstAssistantAt } =
    lines === null ? { hits: {}, echoed: [], firstAssistantAt: null } : analyse(lines, tokens);
  const ups = arrivals.find((a) => a.event === 'UserPromptSubmit');
  const stop = arrivals.find((a) => a.event === 'Stop');
  const screen = existsSync(dump) ? readScreen(readFileSync(dump, 'utf8')) : '';
  const screenLines = [
    ...new Set(
      screen
        .split('\n')
        .map((l) => l.trim())
        .filter((l) => /hook|TOKEN_|error|failed|timed out|refused/iu.test(l))
        .map((l) => l.slice(0, 200)),
    ),
  ].slice(0, 12);

  const finding: Finding = {
    label: run.label,
    version,
    tokens: Object.fromEntries(tokens),
    arrivals,
    hits,
    echoed,
    turnMs: ups !== undefined && stop !== undefined ? stop.at - ups.at : null,
    firstReplyMs: ups !== undefined && firstAssistantAt !== null ? firstAssistantAt - ups.at : null,
    screenLines,
    transcriptPath: stub.transcriptPath,
  };
  // Beside the pty dump, so a run's evidence survives whatever the reporter shows.
  writeFileSync(join(dir, 'finding.json'), JSON.stringify(finding, null, 2), 'utf8');
  console.info('EVIDENCE ', dir);
  return finding;
}

describe.skipIf(!enabled)('a hook response as context, against a real claude (HIVE-136)', () => {
  it.each(RUNS)('$label', { timeout: (BUDGET_S + 30) * 1000 }, async (run) => {
    const finding = await measure(run);
    const t0 = finding.arrivals[0]?.at ?? 0;
    console.info(`\n=== ${finding.label} · ${finding.version} ===`);
    console.info(
      'ARRIVALS ',
      finding.arrivals
        .map((a) => `${a.event}${a.path} +${a.at - t0}ms${a.respondedAt === null ? ' (unanswered)' : ` ->${a.respondedAt - a.at}ms`}`)
        .join(' | '),
    );
    console.info('HITS     ', JSON.stringify(finding.hits, null, 1));
    console.info('ECHOED   ', JSON.stringify(finding.echoed));
    console.info('TURN     ', finding.turnMs, 'ms · first reply', finding.firstReplyMs, 'ms');
    console.info('SCREEN   ', JSON.stringify(finding.screenLines, null, 1));

    const events = finding.arrivals.map((a) => a.event);
    // The turn ran to its end in every case: a hook's failure is not the turn's.
    expect(events).toContain('Stop');
    expect(finding.transcriptPath).not.toBeNull();

    const upsHits = finding.hits['http:UserPromptSubmit'] ?? [];
    const screen = finding.screenLines.join('\n');

    /*
      Pinned to what Claude Code 2.1.263 did, so a release that moves any of
      it fails here rather than in a shipped payload. The note beside
      `HOOK_EVENTS` in `hook-contract.ts` is the prose version of these.
    */
    switch (run.outcome) {
      case 'context': {
        expect(events).toContain('UserPromptSubmit');
        // In the transcript as `hook_additional_context`, not merely as raw hook stdout.
        expect(upsHits.map((h) => h.attachment)).toContain('hook_additional_context');
        // And in the model: it echoed the token back.
        expect(finding.echoed).toContain('http:UserPromptSubmit');
        // A 2xx draws nothing: no hook line on screen (204 from `/sink` included).
        expect(screen).not.toMatch(/hook error|timed out/u);
        break;
      }
      case 'error-shown': {
        expect(events).toContain('UserPromptSubmit');
        // A non-2xx status: body discarded, and the user is told, on screen.
        expect(upsHits).toEqual([]);
        expect(finding.echoed).toEqual([]);
        expect(screen).toMatch(/UserPromptSubmit hook error/u);
        break;
      }
      case 'timed-out': {
        expect(events).toContain('UserPromptSubmit');
        expect(upsHits).toEqual([]);
        expect(finding.echoed).toEqual([]);
        expect(screen).toMatch(/timed out/u);
        break;
      }
      case 'refused': {
        // Nothing listened: the request never reached the stub, and the user is told.
        expect(events).not.toContain('UserPromptSubmit');
        expect(upsHits).toEqual([]);
        expect(finding.echoed).toEqual([]);
        expect(screen).toMatch(/UserPromptSubmit hook error/u);
        break;
      }
    }

    if (run.matrix) {
      // Both transports, on every event that arrives. Only `SessionStart` over http does not.
      for (const event of EVENTS) {
        expect(finding.echoed).toContain(tokenKey('command', event));
        if (event !== 'SessionStart') expect(finding.echoed).toContain(tokenKey('http', event));
      }
      expect(
        events,
        'SessionStart arrived over http: the note beside HOOK_EVENTS in hook-contract.ts is out of date, and the app is better for it',
      ).not.toContain('SessionStart');
    }

    if (run.label === 'slow-in-time') {
      /*
        The prompt waited on the hook. The model's first reply cannot come
        before the response did; a release that fired the request without
        awaiting the hook would answer within a second or two, and fail here.
      */
      expect(finding.firstReplyMs ?? 0).toBeGreaterThanOrEqual(SLOW_MS);
    }
  });
});
