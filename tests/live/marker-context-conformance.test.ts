// @vitest-environment node
import { execFileSync, spawn } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, readdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { createReceiver, type Receiver } from '../../electron/main/hooks/receiver';
import { hookSettings, type HookTransport } from '../../electron/main/hooks/settings';
import { readTranscript as readScreen } from '../../electron/main/integrations/slack/tty';
import { createLedger } from '../../electron/main/ledger';
import { ledgerMarker } from '../../electron/shared/ledger-contract';

/**
 * A marker landing in a real session carries its entry whole (HIVE-138).
 *
 * ## What this proves, and what the spike could not
 *
 * `tests/live/hook-context-conformance.test.ts` (HIVE-136) proved the
 * transport: a stub receiver's `additionalContext` reaches the model. This
 * suite proves the app's half of it against the same real `claude`: the
 * **real** `createReceiver`, reading a **real** `createLedger`, with the
 * settings file the **real** `hookSettings()` writes, timeout included. A
 * marker line typed into the pty exactly as `deliver.ts` writes it comes
 * back out of the receiver as the ask, untruncated, meta intact, and the
 * model acts on the part of the body that never touched the pty.
 *
 * Two prompts in one session. The first is the marker of an ask addressed to
 * the session, whose third line, past where the old nudge would have cut,
 * tells the model what word to reply with. The second is a marker nothing
 * resolves, `📒 a999`, which must be answered 204 and draw nothing.
 *
 * Once per transport. A host session's hooks are `http`; a container's are
 * `command` hooks around `curl` (HIVE-137, `statusCommand`), and a command
 * hook's stdout is its output, so the curl must print the body or the
 * container's model gets the marker and never the entry. The second session
 * runs the same settings the container would get, on the host, which is
 * what proves the curl and not the container.
 *
 * ## Why it is opt-in
 *
 * Two real `claude` sessions, real tokens, about a minute each.
 *
 * ```
 * pnpm test:marker
 * ```
 *
 * The session runs in its own throwaway directory with `--setting-sources
 * project`, so the user's own hooks are out of the picture and the run never
 * lands in this repository's `--resume` history.
 */
const enabled = process.env.HIVE_LIVE_MARKER_PROOF === '1';

const SESSION = 'sess-marker';

/** Cold start, the trust dialog, two Haiku turns. */
const BUDGET_S = 120;

interface Arrival {
  at: number;
  event: string;
}

interface Finding {
  version: string;
  transport: HookTransport;
  ref: string;
  arrivals: Arrival[];
  contextLines: number;
  wordInContext: boolean;
  intentInContext: boolean;
  assistantText: string;
  screenLines: string[];
  transcriptPath: string | null;
}

/** Where Claude keeps the transcript of a session started in `cwd`. */
function transcriptPathFor(cwd: string, sessionUuid: string): string | null {
  const projects = join(homedir(), '.claude', 'projects');
  const direct = join(projects, realpathSync(cwd).replaceAll('/', '-'), `${sessionUuid}.jsonl`);
  if (existsSync(direct)) return direct;
  if (!existsSync(projects)) return null;
  for (const project of readdirSync(projects)) {
    const candidate = join(projects, project, `${sessionUuid}.jsonl`);
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

interface Analysis {
  contextLines: number;
  wordInContext: boolean;
  intentInContext: boolean;
  assistantText: string;
}

function analyse(lines: string[], word: string, intent: string): Analysis {
  let contextLines = 0;
  let wordInContext = false;
  let intentInContext = false;
  let assistantText = '';
  for (const line of lines) {
    let record: Record<string, unknown>;
    try {
      record = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    const attachment = record.attachment as Record<string, unknown> | undefined;
    if (attachment?.type === 'hook_additional_context') {
      contextLines += 1;
      if (line.includes(word)) wordInContext = true;
      if (line.includes(intent)) intentInContext = true;
    }
    const message = record.message as Record<string, unknown> | undefined;
    if (message?.role === 'assistant' && Array.isArray(message.content)) {
      for (const block of message.content as Record<string, unknown>[]) {
        if (block.type === 'text' && typeof block.text === 'string') assistantText += `${block.text}\n`;
      }
    }
  }
  return { contextLines, wordInContext, intentInContext, assistantText };
}

describe.skipIf(!enabled)('a marker carries its entry as context, against a real claude (HIVE-138)', () => {
  let receiver: Receiver | null = null;

  afterEach(async () => {
    await receiver?.stop();
  });

  it.each<HookTransport>(['http', 'command'])('over %s: the woken session reads the whole ask, and an unresolved marker draws nothing', { timeout: (BUDGET_S + 30) * 1000 }, async (transport) => {
    const version = execFileSync('claude', ['--version'], { encoding: 'utf8' }).trim();
    const nonce = randomBytes(3).toString('hex');
    const word = `ZEBRA_${nonce}`;
    const intent = `INTENT_${nonce}`;
    const dir = mkdtempSync(join(tmpdir(), `hive-marker-${transport}-`));
    const arrivals: Arrival[] = [];

    /*
      The real ledger, in a `~/.hive` of its own, and the real receiver over
      it, wired the way `hooks/index.ts` wires them: the query goes down
      untouched and the receiver's own identity filters do the narrowing.
    */
    const ledger = createLedger({ dir: join(dir, 'hive'), knowsParty: () => true });
    receiver = createReceiver({
      onEvent: (event) => arrivals.push({ at: Date.now(), event: event.event }),
      onCleared: () => {},
      onTicketIntent: () => {},
      onPromptName: () => {},
      onMetrics: () => {},
      onDone: () => {},
      onReady: () => {},
      knowsSession: (id) => id === SESSION,
      knowsAgent: () => false,
      onAgentEvent: () => {},
      onAgentsList: () => Promise.reject(new Error('not exercised by this suite')),
      onLedgerRead: (_caller, query) => ledger.read(query),
      onLedgerPost: (caller, request) => ledger.append({ ...request, from: caller }),
    });
    const url = await receiver.start();
    expect(url).not.toBeNull();

    /*
      The ask, as a coordinator would write it. Three lines and well past the
      120 characters the old nudge carried, with the confirmation code on the
      third line, so the only way the model can know the word is the context.

      Written as a message, not a demand. The first run of this suite asked
      for "exactly the word X and nothing else", and the model called that a
      prompt injection and refused; the wording of `context.ts` changed for
      it, and so did this. A roll call that asks to be acknowledged is what a
      real ask looks like.
    */
    const asked = ledger.append({
      from: 'overmind',
      to: SESSION,
      kind: 'ask',
      body:
        'Roll call from the overmind before I hand out the afternoon\'s work. There is nothing to investigate and nothing to run; this is only to see which sessions are awake and reading the ledger.\n' +
        'The second line is here so that the entry has more than one, which is the part the old one-line nudge used to cut.\n' +
        `If you can read this, acknowledge it in one short line and include the confirmation code ${word} in it, so I can tick you off the list.`,
      meta: { intent: `so that ${intent} is known`, probe: nonce },
    });
    expect(asked.ok).toBe(true);
    const ref = asked.ok ? (asked.ref ?? asked.id) : '';
    const marker = ledgerMarker({ id: asked.ok ? asked.id : '', kind: 'ask', ref });

    // The settings file the app writes, identity baked, the real timeout.
    const settingsPath = join(dir, 'settings.json');
    writeFileSync(
      settingsPath,
      JSON.stringify(
        hookSettings(url as string, undefined, { session: SESSION, token: receiver.tokenFor(SESSION) }, transport),
      ),
      'utf8',
    );

    const sessionUuid = randomUUID();
    const dump = join(dir, 'pty.bin');
    const doneFile = join(dir, 'done');
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
    ];

    /*
      The driver is the one `hook-context-conformance` uses: a real pty, the
      trust dialog answered, a prompt typed and submitted. Two prompts here,
      the second once the first turn's `Stop` has reached the receiver.
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
      'start = time.time(); step = 0; typed = 0',
      `stop1 = ${JSON.stringify(join(dir, 'stop1'))}`,
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
      `    if step == 0 and now > 8 and (trusted or now > 20): os.write(fd, ${JSON.stringify(marker)}.encode()); step = 1; typed = now`,
      "    elif step == 1 and now > typed + 2: os.write(fd, b'\\r'); step = 2",
      '    elif step == 2 and os.path.exists(stop1): step = 3; typed = now',
      `    elif step == 3 and now > typed + 4: os.write(fd, ${JSON.stringify('📒 a999')}.encode()); step = 4; typed = now`,
      "    elif step == 4 and now > typed + 2: os.write(fd, b'\\r'); step = 5",
      `    elif step == 5 and os.path.exists(${JSON.stringify(doneFile)}): break`,
      'try: os.kill(pid, 9)',
      'except Exception: pass',
      `open(${JSON.stringify(dump)}, 'wb').write(bytes(buf))`,
    ].join('\n');

    const child = spawn('python3', ['-c', driver], { stdio: 'ignore' });
    const exited = new Promise<void>((resolve) => {
      child.on('exit', () => resolve());
      child.on('error', () => resolve());
    });

    // Each turn is over when its `Stop` reaches the real receiver.
    const poll = setInterval(() => {
      const stops = arrivals.filter((a) => a.event === 'Stop').length;
      if (stops >= 1 && !existsSync(join(dir, 'stop1'))) writeFileSync(join(dir, 'stop1'), '');
      if (stops >= 2 && !existsSync(doneFile)) {
        clearInterval(poll);
        setTimeout(() => writeFileSync(doneFile, ''), 4000).unref();
      }
    }, 250);
    await exited;
    clearInterval(poll);

    const transcriptPath = transcriptPathFor(dir, sessionUuid);
    const lines =
      transcriptPath !== null
        ? readFileSync(transcriptPath, 'utf8').split('\n').filter((line) => line !== '')
        : [];
    const analysis = analyse(lines, word, intent);
    const screen = existsSync(dump) ? readScreen(readFileSync(dump, 'utf8')) : '';
    const screenLines = [
      ...new Set(
        screen
          .split('\n')
          .map((l) => l.trim())
          .filter((l) => /hook|ZEBRA_|error|failed|timed out|refused|📒/iu.test(l))
          .map((l) => l.slice(0, 200)),
      ),
    ].slice(0, 16);

    const finding: Finding = {
      version,
      transport,
      ref,
      arrivals,
      ...analysis,
      screenLines,
      transcriptPath,
    };
    writeFileSync(join(dir, 'finding.json'), JSON.stringify(finding, null, 2), 'utf8');
    console.info('EVIDENCE ', dir);
    console.info(`=== ${version} · ${transport} · marker ${marker} ===`);
    console.info('ARRIVALS ', arrivals.map((a) => `${a.event} +${a.at - (arrivals[0]?.at ?? a.at)}ms`).join(' | '));
    console.info('CONTEXT  ', JSON.stringify({ lines: analysis.contextLines, word: analysis.wordInContext, intent: analysis.intentInContext }));
    console.info('REPLY    ', JSON.stringify(analysis.assistantText.slice(0, 400)));
    console.info('SCREEN   ', JSON.stringify(screenLines, null, 1));

    const events = arrivals.map((a) => a.event);
    // Both prompts arrived at the real receiver, and both turns ran to their end.
    expect(events.filter((e) => e === 'UserPromptSubmit')).toHaveLength(2);
    expect(events.filter((e) => e === 'Stop')).toHaveLength(2);
    expect(transcriptPath).not.toBeNull();

    // The entry reached the transcript as context: the third line and the meta intent.
    expect(analysis.wordInContext).toBe(true);
    expect(analysis.intentInContext).toBe(true);
    // Once. The marker nothing resolves carried nothing.
    expect(analysis.contextLines).toBe(1);
    // And the model acted on the part of the body that never touched the pty.
    expect(analysis.assistantText).toContain(word);
    // A 2xx and a 204 draw nothing: no hook line on screen, for either prompt.
    expect(screenLines.join('\n')).not.toMatch(/hook error|timed out/u);
  });
});
