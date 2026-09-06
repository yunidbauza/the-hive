// @vitest-environment node
import { execFileSync, spawn } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { createServer } from 'node:http';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

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
 * Three more sessions measure what the payload half of HIVE-135 would then
 * depend on: a non-2xx status, a slow response inside the handler's timeout,
 * and one past it.
 *
 * ## Why it is opt-in
 *
 * Four real `claude` sessions, real tokens, a few minutes.
 *
 * ```
 * pnpm test:hook-context
 * ```
 *
 * The user's own `~/.claude/settings.json` is excluded with
 * `--setting-sources project`: it carries `command` hooks of its own, and a
 * token that arrived through one of those would be evidence about the wrong
 * handler.
 */
const enabled = process.env.HIVE_LIVE_HOOK_CONTEXT_PROOF === '1';

const EVENTS = ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse'] as const;
type Event = (typeof EVENTS)[number];
type Transport = 'http' | 'command';

const PROMPT =
  'Run exactly this command with the Bash tool: echo hive-spike. ' +
  'Then reply with every string of the form TOKEN_x_y_z that appears anywhere in your context, ' +
  'one per line and nothing else. If you can see none, reply NONE.';

/** Cold start, the trust dialog if any, one Haiku turn with a tool call, a slow hook. */
const BUDGET_S = 110;

interface Run {
  label: string;
  /** The stub path the `UserPromptSubmit` http handler posts to. */
  upsPath: string;
  /** The `timeout` written on every http handler, in seconds. */
  timeout: number;
  /** Attach the full matrix: `command` handlers, and http on the other events. */
  matrix: boolean;
  /** What the `UserPromptSubmit` http response did, as measured. */
  outcome: 'context' | 'error-shown' | 'timed-out';
}

const RUNS: Run[] = [
  { label: 'matrix', upsPath: '/ctx', timeout: 10, matrix: true, outcome: 'context' },
  { label: 'status-500', upsPath: '/ctx-500', timeout: 10, matrix: false, outcome: 'error-shown' },
  { label: 'slow-in-time', upsPath: '/slow-5000', timeout: 10, matrix: false, outcome: 'context' },
  { label: 'slow-past-timeout', upsPath: '/slow-15000', timeout: 5, matrix: false, outcome: 'timed-out' },
];

interface Arrival {
  at: number;
  path: string;
  event: string;
  respondedAt: number | null;
}

interface Hit {
  type: string;
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
  turnMs: number | null;
  ptyHookLines: string[];
  transcriptFound: boolean;
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

/**
 * The stub receiver. Behaviour is chosen by path so one server serves every
 * run: `/ctx` answers 200 with context, `/ctx-500` the same body with a 500,
 * `/slow-<ms>` waits that long first, `/sink` is the 204 the app sends today
 * and is what `Stop` posts to, which is how a turn's end is timed.
 */
function startStub(
  tokens: Map<string, string>,
  arrivals: Arrival[],
): Promise<{ url: string; close: () => Promise<void> }> {
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const path = req.url ?? '/';
      let event = '?';
      try {
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>;
        if (typeof body.hook_event_name === 'string') event = body.hook_event_name;
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
      else if (slow !== null) setTimeout(() => reply(200, contextBody(event, token)), Number(slow[1]));
      else reply(204, null);
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address !== null ? address.port : 0;
      resolve({
        url: `http://127.0.0.1:${port}`,
        close: () =>
          new Promise<void>((done) => {
            server.closeAllConnections();
            server.close(() => done());
          }),
      });
    });
  });
}

function settingsFor(run: Run, base: string, tokens: Map<string, string>): unknown {
  const http = (path: string): unknown => ({ type: 'http', url: `${base}${path}`, timeout: run.timeout });
  const command = (event: Event): unknown => ({
    type: 'command',
    command: `printf '%s' '${contextBody(event, tokens.get(tokenKey('command', event)) ?? '')}'`,
    timeout: run.timeout,
  });
  const hooks: Record<string, unknown> = {
    UserPromptSubmit: [
      { matcher: '*', hooks: run.matrix ? [http(run.upsPath), command('UserPromptSubmit')] : [http(run.upsPath)] },
    ],
    Stop: [{ matcher: '*', hooks: [http('/sink')] }],
  };
  if (run.matrix) {
    for (const event of EVENTS) {
      if (event === 'UserPromptSubmit') continue;
      hooks[event] = [{ matcher: '*', hooks: [http('/ctx'), command(event)] }];
    }
  }
  return { hooks };
}

/** Escape sequences out, so the pty dump can be searched as prose. */
const ESC = String.fromCharCode(27);
const BEL = String.fromCharCode(7);
const OSC = new RegExp(`${ESC}\\][^${BEL}${ESC}]*(?:${BEL}|${ESC}\\\\)`, 'gu');
const CSI = new RegExp(`${ESC}\\[[0-9;?]*[ -/]*[@-~]`, 'gu');
const stripAnsi = (s: string): string => s.replace(OSC, '').replace(CSI, '');

function readTranscript(sessionUuid: string): string[] | null {
  const projects = join(homedir(), '.claude', 'projects');
  if (!existsSync(projects)) return null;
  const transcript = readdirSync(projects)
    .map((dir) => join(projects, dir, `${sessionUuid}.jsonl`))
    .find((path) => existsSync(path));
  if (transcript === undefined) return null;
  return readFileSync(transcript, 'utf8').split('\n').filter((line) => line !== '');
}

function analyse(lines: string[], tokens: Map<string, string>): { hits: Record<string, Hit[]>; echoed: string[] } {
  const hits: Record<string, Hit[]> = {};
  let assistantText = '';
  for (const line of lines) {
    let record: Record<string, unknown>;
    try {
      record = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    const type = typeof record.type === 'string' ? record.type : '?';
    const message = record.message as Record<string, unknown> | undefined;
    const role = typeof message?.role === 'string' ? message.role : null;
    if (role === 'assistant' && Array.isArray(message?.content)) {
      for (const block of message.content as Record<string, unknown>[]) {
        if (block.type === 'text' && typeof block.text === 'string') assistantText += `${block.text}\n`;
      }
    }
    for (const [key, token] of tokens) {
      const index = line.indexOf(token);
      if (index === -1) continue;
      (hits[key] ??= []).push({
        type,
        role,
        snippet: line.slice(Math.max(0, index - 120), index + token.length + 40),
      });
    }
  }
  const echoed = [...tokens]
    .filter(([, token]) => assistantText.includes(token))
    .map(([key]) => key);
  return { hits, echoed };
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
  const sessionUuid = randomUUID();
  const dir = mkdtempSync(join(tmpdir(), `hive-hook-context-${run.label}-`));
  const settingsPath = join(dir, 'settings.json');
  const dump = join(dir, 'pty.bin');
  const doneFile = join(dir, 'done');
  writeFileSync(settingsPath, JSON.stringify(settingsFor(run, stub.url, tokens)), 'utf8');

  /*
    `--setting-sources project` keeps the user's own hooks out of the session,
    while `--settings` still applies (the flag's own help says so). The cwd is
    this repository, which the user has trusted, so no dialog; the trust
    handling from `title-conformance` is kept regardless because a worktree
    path is new to Claude.
  */
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
  const driver = [
    'import os, pty, select, time',
    "env = dict(os.environ, TERM='xterm-256color')",
    "env.pop('CLAUDE_CODE_CHILD_SESSION', None)",
    `argv = ${JSON.stringify(argv)}`,
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
    `    if step == 0 and now > 8: os.write(fd, ${JSON.stringify(PROMPT)}.encode()); step = 1`,
    "    elif step == 1 and now > 11: os.write(fd, b'\\r'); step = 2",
    `    elif step == 2 and os.path.exists(${JSON.stringify(doneFile)}): break`,
    'try: os.kill(pid, 9)',
    'except Exception: pass',
    `open(${JSON.stringify(dump)}, 'wb').write(bytes(buf))`,
  ].join('\n');

  const child = spawn('python3', ['-c', driver], { stdio: 'ignore' });
  const exited = new Promise<void>((resolve) => child.on('exit', () => resolve()));

  // The turn is over when Stop lands; a few seconds more lets the transcript flush.
  const poll = setInterval(() => {
    if (arrivals.some((a) => a.event === 'Stop')) {
      clearInterval(poll);
      setTimeout(() => writeFileSync(doneFile, ''), 4000);
    }
  }, 250);
  await exited;
  clearInterval(poll);
  await stub.close();

  const lines = readTranscript(sessionUuid);
  const { hits, echoed } = lines === null ? { hits: {}, echoed: [] } : analyse(lines, tokens);
  const ups = arrivals.find((a) => a.event === 'UserPromptSubmit');
  const stop = arrivals.find((a) => a.event === 'Stop');
  const pty = existsSync(dump) ? stripAnsi(readFileSync(dump, 'utf8')) : '';
  const ptyHookLines = [
    ...new Set(
      pty
        .split(/[\r\n]+/u)
        .map((l) => l.trim())
        .filter((l) => /hook|TOKEN_|error|failed|timed out/iu.test(l))
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
    ptyHookLines,
    transcriptFound: lines !== null,
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
    console.info('TURN     ', finding.turnMs, 'ms');
    console.info('PTY      ', JSON.stringify(finding.ptyHookLines, null, 1));

    expect(finding.transcriptFound).toBe(true);
    const events = finding.arrivals.map((a) => a.event);
    expect(events).toContain('UserPromptSubmit');
    // The turn ran to its end in every case: a hook's failure is not the turn's.
    expect(events).toContain('Stop');

    const upsHits = finding.hits['http:UserPromptSubmit'] ?? [];
    const screen = finding.ptyHookLines.join('\n');

    /*
      Pinned to what Claude Code 2.1.263 did, so a release that moves any of
      it fails here rather than in a shipped payload. The note beside
      `HOOK_EVENTS` in `hook-contract.ts` is the prose version of these.
    */
    switch (run.outcome) {
      case 'context': {
        // Reached the transcript as a `hook_additional_context` attachment, and the model.
        expect(upsHits.some((h) => h.type === 'attachment')).toBe(true);
        expect(finding.echoed).toContain('http:UserPromptSubmit');
        break;
      }
      case 'error-shown': {
        // A non-2xx status: body discarded, and the user is told, on screen.
        expect(upsHits).toEqual([]);
        expect(finding.echoed).toEqual([]);
        expect(screen).toMatch(/UserPromptSubmit hook error/u);
        break;
      }
      case 'timed-out': {
        expect(upsHits).toEqual([]);
        expect(finding.echoed).toEqual([]);
        expect(screen).toMatch(/timed out/u);
        break;
      }
    }

    if (run.matrix) {
      // Both transports, on every event that arrives. Only `SessionStart` over http does not.
      for (const event of EVENTS) {
        expect(finding.echoed).toContain(tokenKey('command', event));
        if (event !== 'SessionStart') expect(finding.echoed).toContain(tokenKey('http', event));
      }
      expect(events).not.toContain('SessionStart');
      expect(finding.echoed).not.toContain(tokenKey('http', 'SessionStart'));
    }

    if (run.label === 'slow-in-time') {
      // The prompt waited on the hook: the round trip is the response's delay, at least.
      expect(finding.turnMs ?? 0).toBeGreaterThanOrEqual(5000);
    }
  });
});
