// @vitest-environment node
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { spawn as spawnPty } from 'node-pty';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { writeSharedContainerFiles } from '../../electron/main/container/generated';
import { PLUGIN_DIR } from '../../electron/main/skills/paths';
import { writePluginDir } from '../../electron/main/skills/plugin';
import type { SkillsRead } from '../../electron/main/skills/read';

/**
 * The container session profile, end to end (HIVE-133).
 *
 * Everything about `container` that can be asserted against a fake — the
 * `{env}` substitution, the path map, the generated `exec-env`/`rewrite`
 * file sets — already is, in `tests/electron/main/sessions/`,
 * `tests/electron/main/container/` and friends. None of it proves the thing
 * a containerised session actually depends on: that `docker exec` really
 * carries an environment across, that the paths this app writes really
 * resolve on the other side of that boundary, and — the case no staged
 * buffer can settle — that a resize typed at the host's terminal really
 * reaches the container's.
 *
 * Split into two gates behind two different prerequisites, not two tiers of
 * importance:
 *
 * - **mechanism** needs only a container and a shell — plain `alpine:3` — and
 *   runs whenever Docker is up.
 * - **claude** needs an image with a real `claude` installed and
 *   authenticated inside it. Naming that image is the user's job; this app
 *   never builds or bakes one. Unset, those two cases are left as `.todo` —
 *   documented, not faked — rather than skipped silently or asserted against
 *   nothing.
 *
 * ```
 * pnpm test:container
 * ```
 */
const RUN = process.env.HIVE_LIVE_CONTAINER_PROOF === '1';

/*
 * An image with `claude` installed, for the two cases that need one. Unset is
 * the ordinary case and leaves them as `.todo` rather than failing: this
 * machine's images are alpine, postgres and friends, and building a `claude`
 * image is not something a test suite should do behind the user's back.
 */
const CLAUDE_IMAGE = process.env.HIVE_LIVE_CONTAINER_IMAGE;

/* A shell is all the mechanism cases need — no `claude`, no custom image. */
const IMAGE = 'alpine:3';
/* Unique per process and per run, so a crashed previous run cannot collide. */
const NAME = `hive-conformance-${process.pid}-${Date.now()}`;

const hasDocker = (): boolean =>
  spawnSync('docker', ['info'], { stdio: 'ignore' }).status === 0;

/**
 * Everything this suite hands a container, set **explicitly**.
 *
 * `tests/live` spreads `process.env` in every suite, so a developer running
 * this inside a Hive session would otherwise inherit that app's receiver and
 * POST this test's token to it. The symptom is a 403 that blames the token and
 * says nothing about the URL — see `done-conformance.test.ts:155-163`, which
 * documents the same trap for the same reason.
 */
const hiveEnv = (overrides: Record<string, string>): Record<string, string> => ({
  HIVE_SESSION_ID: '',
  HIVE_HOOK_TOKEN: '',
  HIVE_RECEIVER_URL: '',
  HIVE_RUN_ID: '',
  ...overrides,
});

/**
 * `hiveEnv`, plus everything `docker` itself needs to be found and run.
 *
 * `node-pty`'s `env` option **replaces** the spawned process's environment
 * rather than extending it — unlike a login shell, which inherits by default
 * — so a bare `hiveEnv({})` here hands `docker` a `PATH`-less environment and
 * it is never found (`execvp` fails, the pty exits 1 with no output). Only
 * the two `node-pty` spawns below need this: the `docker exec -e …` case
 * builds its flag list from `hiveEnv` directly and never touches the spawned
 * process's own environment.
 */
const ptyEnv = (overrides: Record<string, string>): Record<string, string | undefined> => ({
  ...process.env,
  ...hiveEnv(overrides),
});

/** Run a command inside the container and return its stdout. */
const inContainer = (script: string): string =>
  execFileSync('docker', ['exec', NAME, 'sh', '-c', script], {
    encoding: 'utf8',
  }).trim();

/** No custom skills — only the generated *paths* are under test here. */
const NO_SKILLS: SkillsRead = { skills: [], invalid: [] };

describe.skipIf(!RUN)('container conformance — mechanism', () => {
  let userData: string;

  beforeAll(async () => {
    if (!hasDocker()) {
      throw new Error(
        'docker is not available — this suite needs a real runtime. Start Docker, or unset HIVE_LIVE_CONTAINER_PROOF.',
      );
    }

    userData = mkdtempSync(join(tmpdir(), 'hive-container-'));

    /*
      The two writers a real launch calls before a containerised session ever
      spawns (HIVE-132, HIVE-133) — run here exactly as the app runs them, so
      "resolves inside the container" below is about the paths a session
      actually gets rather than an empty directory this suite invented.
    */
    await writeSharedContainerFiles(userData, {
      url: 'http://127.0.0.1:0/hook',
      origin: 'http://127.0.0.1:0',
    });
    await writePluginDir(join(userData, PLUGIN_DIR), '0.0.0-test', NO_SKILLS);

    execFileSync('docker', [
      'run', '-d', '--name', NAME,
      '-v', `${join(userData, 'hive')}:/hive:ro`,
      IMAGE, 'sleep', 'infinity',
    ]);
  }, 120_000);

  afterAll(() => {
    spawnSync('docker', ['rm', '-f', NAME], { stdio: 'ignore' });
    rmSync(userData, { recursive: true, force: true });
  });

  it('carries all three variables across the boundary', () => {
    const env = hiveEnv({
      HIVE_SESSION_ID: 'hero-refresh',
      HIVE_HOOK_TOKEN: 'a3f',
      HIVE_RECEIVER_URL: 'http://host.docker.internal:63999',
    });

    const args = Object.entries(env)
      .filter(([, value]) => value !== '')
      .flatMap(([name, value]) => ['-e', `${name}=${value}`]);

    const seen = execFileSync(
      'docker',
      [
        'exec',
        ...args,
        NAME,
        'sh',
        '-c',
        'echo "$HIVE_SESSION_ID|$HIVE_HOOK_TOKEN|$HIVE_RECEIVER_URL"',
      ],
      { encoding: 'utf8' },
    ).trim();

    expect(seen).toBe('hero-refresh|a3f|http://host.docker.internal:63999');
  });

  it('names generated files at paths that resolve inside the container', () => {
    // Written by `writeSharedContainerFiles` and `writePluginDir` above, under
    // `<userData>/hive`, mounted here at `/hive`.
    for (const file of [
      '/hive/container/claude-hooks.settings.json',
      '/hive/container/hive.mcp.json',
      '/hive/plugin',
    ]) {
      expect(inContainer(`test -e ${file} && echo ok`)).toBe('ok');
    }
  });

  it(
    'allocates a real TTY with -it, which -i alone does not',
    async () => {
      /*
        `-i` alone hands the container a pipe, not a terminal: `isatty()` is
        false and a TUI either refuses interactive mode or renders wrong. A
        plain child process proves this half — its own stdin need not be a
        terminal for docker to satisfy `-i`.
      */
      const withoutTty = execFileSync(
        'docker',
        ['exec', '-i', NAME, 'sh', '-c', 'test -t 0 && echo tty || echo pipe'],
        { encoding: 'utf8' },
      ).trim();

      expect(withoutTty).toBe('pipe');

      /*
        `-t` is the other half, and it is where a plain child process stops
        being able to prove anything: docker refuses to attach a TTY-enabled
        exec to a client whose own stdin is not itself a terminal — exactly
        what a test runner's stdin is. A pty is what the real spawn path gives
        it (`node-pty` under the login shell), so it is what this assertion
        needs too.
      */
      const withTty = await new Promise<string>((resolve, reject) => {
        const pty = spawnPty(
          'docker',
          ['exec', '-it', NAME, 'sh', '-c', 'test -t 0 && echo tty || echo pipe'],
          { cols: 80, rows: 24, env: ptyEnv({}) },
        );

        let out = '';
        pty.onData((data) => {
          out += data;
        });
        pty.onExit(({ exitCode }) => {
          if (exitCode !== 0) {
            reject(new Error(`docker exec -it exited ${exitCode}:\n${out}`));
            return;
          }
          resolve(out);
        });
      });

      expect(withTty).toContain('tty');
    },
    30_000,
  );

  it(
    'propagates a resize into the container TTY',
    () => {
      // The case no staged buffer can prove: whether SIGWINCH crosses xterm →
      // node-pty → `docker exec -t` into the container. A `claude` that
      // believes it has eighty columns forever is a bad first impression.
      const pty = spawnPty(
        'docker',
        ['exec', '-it', NAME, 'sh', '-c', 'sleep 2; stty size'],
        { cols: 80, rows: 24, env: ptyEnv({}) },
      );

      let out = '';
      pty.onData((data) => {
        out += data;
      });

      pty.resize(132, 40);

      return new Promise<void>((resolve) => {
        pty.onExit(() => {
          expect(out).toContain('132');
          resolve();
        });
      });
    },
    30_000,
  );
});

/*
  The two cases that need a real `claude` **inside** the container, behind
  their own gate.

  Split from the four above rather than folded in with them, because they have
  a different prerequisite: those need only a container, these need an image
  with `claude` installed and authenticated. Naming that image is the user's
  job — the app never builds or names one — so the suite asks for it and stays
  honest about what it could not prove when it is absent.

  Left as `.todo` rather than given a fake passing body: an empty `it` with no
  assertions reports green while proving nothing, which is worse than no test
  at all. `.todo` reports neither pass nor fail — it says plainly that the
  case is designed but not yet implemented, and it disappears from the report
  the moment either becomes real.
*/
describe.skipIf(!RUN || CLAUDE_IMAGE === undefined)('container conformance — claude', () => {
  it.todo(
    'reads a container session ledger post from a host session, and the reverse — ' +
      'model on ledger-conformance.test.ts:100-141 (its runClaude/receiver pattern): ' +
      'point one claude at `docker exec -it <name> claude -p --mcp-config …` with the ' +
      'container-flavoured HIVE_* env from writeSessionContainerFiles\'s rewrite set, ' +
      'leave the other on the host with the same receiver, and assert each session\'s ' +
      'post is readable through the other\'s ledger_read',
  );

  it.todo(
    'authenticates an existing container after a Hive restart in rewrite mode — ' +
      'call writeSessionContainerFiles twice with two different HookIdentity tokens ' +
      '(a new launchSecret rewrites the per-session set), and assert claude accepts ' +
      'the second token and is refused with the first',
  );
});
