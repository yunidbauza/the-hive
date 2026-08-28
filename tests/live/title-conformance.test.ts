// @vitest-environment node
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { createTitleReader } from '../../electron/main/sessions/title';
import { hiveNameFromTitle } from '../../electron/shared/session-contract';

/**
 * That a session left unnamed names *itself*, against a real `claude` (HIVE-108).
 *
 * ## Why this suite has to exist
 *
 * The whole feature is a flag that is no longer sent. Everything else — the
 * normaliser, the pin, the ledger merge — is downstream of one claim about
 * someone else's binary: **`--name` suppresses Claude Code's own titling.**
 *
 * That claim cannot be tested against a mock, because a mock is where the belief
 * came from. It also cannot be inferred from absence: the first evidence for it
 * was 25+ Hive transcripts carrying a `custom-title` and no `ai-title`, which is
 * consistent with the flag suppressing titles *and* with Claude simply never
 * titling anything. Only running both arms separates the two.
 *
 * And it fails silently in the direction that matters. If a future release of
 * Claude Code stops emitting `ai-title`, or renames the record, or stops
 * painting it to OSC 0, every unit test in this repository still passes and the
 * app quietly returns to naming sessions `sess-07` forever — the state it was in
 * for its entire history, which nobody noticed because there was nothing to
 * compare against. This suite is the comparison.
 *
 * ## What it proves that nothing else can
 *
 * Two arms of the same binary, same prompt, same moment, differing only in
 * `--name`:
 *
 * - the unnamed arm reaches an `ai-title` **and** paints it to the OSC-0 stream,
 *   which is what makes `createTitleReader` a sufficient channel;
 * - the named arm reaches neither, which is what makes the dropped flag the
 *   *cause* rather than a coincidence.
 *
 * ## Why it is opt-in
 *
 * It spawns two real `claude` sessions, which costs real tokens and takes a
 * couple of minutes.
 *
 * ```
 * pnpm test:title
 * ```
 */
const enabled = process.env.HIVE_LIVE_TITLE_PROOF === '1';

/** Short, cheap, and unmistakably about one topic, so the title is predictable. */
const PROMPT = 'In one short sentence, explain what a mutex is. Then stop.';

/** Long enough for a cold start plus one Haiku turn plus the title write. */
const BUDGET_S = 150;

interface Arm {
  /** Every distinct OSC-0 name the pty painted, in order, glyphs stripped. */
  names: string[];
  /** `aiTitle` records found in the transcript this run pinned. */
  aiTitles: string[];
  /** `customTitle` records, which is where `--name` lands. */
  customTitles: string[];
}

/**
 * Drive one real `claude` through a pty and report what it called itself.
 *
 * Python rather than `node-pty`, for the reason `hook-conformance` gives: the
 * TUI behaves differently without a real pty, and this suite is entirely about
 * what the TUI paints.
 */
async function run(label: string, named: boolean): Promise<Arm> {
  const sessionUuid = randomUUID();
  const cwd = mkdtempSync(join(tmpdir(), `hive-title-${label}-`));
  const dump = join(cwd, 'pty.bin');

  const argv = ['claude', '--session-id', sessionUuid, '--model', 'haiku'];
  if (named) argv.push('--name', 'sess-probe');
  argv.push(PROMPT);

  const driver = [
    'import os, pty, select, time',
    "env = dict(os.environ, TERM='xterm-256color')",
    "env.pop('CLAUDE_CODE_CHILD_SESSION', None)",
    `argv = ${JSON.stringify(argv)}`,
    `os.chdir(${JSON.stringify(cwd)})`,
    'pid, fd = pty.fork()',
    "if pid == 0: os.execvpe('claude', argv, env)",
    'buf = bytearray()',
    'trusted = False',
    'start = time.time()',
    `while time.time() - start < ${BUDGET_S}:`,
    '    r, _, _ = select.select([fd], [], [], 0.3)',
    '    if r:',
    '        try: d = os.read(fd, 65536)',
    '        except OSError: break',
    '        if not d: break',
    '        buf += d',
    /*
      A directory `claude` has never seen opens on the trust dialog, and the
      default choice is "No, exit". Matched on a single token because the TUI
      interleaves cursor-positioning escapes between words, so no longer phrase
      is ever contiguous in the byte stream.
    */
    '        if not trusted and b"safety" in bytes(buf):',
    '            time.sleep(0.6)',
    '            os.write(fd, b"\\x1b[B")',
    '            time.sleep(0.3)',
    '            os.write(fd, b"\\r")',
    '            trusted = True',
    'try: os.kill(pid, 9)',
    'except Exception: pass',
    `open(${JSON.stringify(dump)}, 'wb').write(bytes(buf))`,
  ].join('\n');

  await new Promise<void>((resolve) => {
    const child = spawn('python3', ['-c', driver], { stdio: 'ignore' });
    child.on('exit', () => resolve());
  });

  /*
    Parsed with the app's own reader rather than a regex, so this also covers the
    thing `title.test.ts` can only stage: that real pty chunk boundaries are
    handled. A title split across two reads is the failure that is invisible in
    testing and permanent in production.
  */
  const reader = createTitleReader();
  const names: string[] = [];
  for (const name of reader.read(readFileSync(dump, 'utf8'))) {
    if (names.at(-1) !== name) names.push(name);
  }

  /*
    Found by uuid rather than by rebuilding the escaped-cwd directory name.
    That name is Claude's own encoding of the *real* path, and on macOS
    `tmpdir()` answers `/var/folders/…` for a directory that really lives at
    `/private/var/folders/…` — so the obvious construction misses every time,
    silently, and the suite reports "no title" for a session that titled itself
    perfectly. Scanning for the uuid also survives any future change to the
    escaping, which is not this repository's to know.
  */
  const projects = join(homedir(), '.claude', 'projects');
  const transcript = existsSync(projects)
    ? readdirSync(projects)
        .map((dir) => join(projects, dir, `${sessionUuid}.jsonl`))
        .find((path) => existsSync(path))
    : undefined;

  const aiTitles: string[] = [];
  const customTitles: string[] = [];
  if (transcript !== undefined) {
    for (const line of readFileSync(transcript, 'utf8').split('\n')) {
      if (line === '') continue;
      const record: unknown = JSON.parse(line);
      if (typeof record !== 'object' || record === null) continue;
      const { type, aiTitle, customTitle } = record as Record<string, unknown>;
      if (type === 'ai-title' && typeof aiTitle === 'string') aiTitles.push(aiTitle);
      if (type === 'custom-title' && typeof customTitle === 'string') {
        customTitles.push(customTitle);
      }
    }
  }

  rmSync(cwd, { recursive: true, force: true });
  return { names, aiTitles, customTitles };
}

describe.skipIf(!enabled)('session-title conformance', () => {
  it('names itself when unnamed, and does not when named', async () => {
    const [free, pinned] = await Promise.all([run('free', false), run('named', true)]);

    console.info('UNNAMED  osc', free.names, 'ai', free.aiTitles);
    console.info('NAMED    osc', pinned.names, 'ai', pinned.customTitles);

    /*
      The claim the feature rests on, in both directions. The negative arm is
      the load-bearing half: without it, a release that titled every session
      regardless of the flag would still pass, and the flag would have been
      dropped for nothing.
    */
    expect(free.aiTitles.length).toBeGreaterThan(0);
    expect(pinned.aiTitles).toEqual([]);
    expect(pinned.customTitles).toContain('sess-probe');

    /*
      And that the title reaches the OSC stream, which is the channel the app
      actually reads. A transcript record nobody paints would need a file
      watcher this design deliberately does not have.
    */
    const inferred = free.names.filter((name) => name !== 'Claude Code');
    expect(inferred.length).toBeGreaterThan(0);

    /*
      A named session paints its name and never wavers from it — the same
      observation from the other side.
    */
    expect(pinned.names).toEqual(['sess-probe']);

    /*
      Finally, that what arrives is nameable. Not an assertion about the words
      Claude chose — those are its business and will drift — but that the
      normaliser turns them into a rail name rather than dropping them.
    */
    const name = hiveNameFromTitle(inferred.at(-1) as string);
    expect(name).toBeDefined();
    expect(name).toMatch(/^[A-Za-z0-9][A-Za-z0-9-]*$/);
    expect(name).not.toBe('claude-code');
  }, 300_000);
});
