// @vitest-environment node
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  importLoginEnv,
  loginEnvStatus,
  mergePath,
  parseLoginEnv,
  resetLoginEnvImport,
  runLoginShell,
  startLoginEnvImport,
} from '../../../../electron/main/config/login-env';
import {
  LOGIN_ENV_DELIMITER,
  LOGIN_ENV_IMPORT_KEYS,
  LOGIN_ENV_PROBE_ARGS,
  LOGIN_ENV_RECORD_SEPARATOR,
} from '../../../../electron/shared/config-contract';

/**
 * The login-environment import (HIVE-84).
 *
 * Proven against **real, disposable shells** — scripts this test writes and
 * makes executable — rather than a mocked `execFile`, following
 * `env-diagnostic.test.ts` and `gh.test.ts`. The reason is the same one those
 * files give: what is worth testing is how a real spawn's outcome becomes a
 * status, and a mocked child process would only ever assert the mock. The two
 * failures that matter most here — a shell that cannot be started, and one
 * that refuses to die — cannot be faked convincingly at all.
 *
 * The pure halves (`parseLoginEnv`, `mergePath`) are tested directly, because
 * they hold the decisions: what counts as this app's output inside a noisy
 * transcript, and what order the resulting `PATH` ends up in.
 *
 * **`target` is always a plain object**, never `process.env`. A test that
 * repaired the environment of the process running it would leak into every
 * other test in the file, and the failure would look like flakiness.
 */

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'hive-login-env-'));
  resetLoginEnvImport();
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  resetLoginEnvImport();
});

/** Write an executable script and hand back its path. */
function script(name: string, body: string): string {
  const path = join(dir, name);
  writeFileSync(path, `#!/bin/sh\n${body}\n`, 'utf8');
  chmodSync(path, 0o755);
  return path;
}

const NUL = LOGIN_ENV_RECORD_SEPARATOR;

/**
 * A transcript shaped exactly as {@link LOGIN_ENV_PROBE_ARGS} emits one.
 *
 * Banner text ends at a newline and is followed by the probe's *leading* NUL,
 * so the banner is a record of its own rather than being glued to the opening
 * marker. That leading NUL is the whole reason the marker can be matched by
 * equality instead of by "ends with".
 */
function transcript(records: readonly string[], banner = ''): string {
  // Each record carries the newline `printenv` appends; the markers, printed by
  // `printf`, do not. The parser has to tell those apart.
  const body = records.map((record) => `${record}\n`);
  return (
    banner +
    NUL +
    [LOGIN_ENV_DELIMITER, ...body, LOGIN_ENV_DELIMITER].join(NUL) +
    NUL
  );
}

/**
 * The shell lines that print a well-formed NUL-delimited transcript.
 *
 * Shared by every fake shell below, so the protocol is stated once — a
 * hand-typed second copy is what let the old `echo`-per-line shape linger in
 * two tests after the parser had moved on.
 */
function emit(records: readonly string[]): string[] {
  const quoted = records.map((record) => `'${record}'`).join(' ');
  return [
    `printf '\\0%s\\0' '${LOGIN_ENV_DELIMITER}'`,
    `printf '%s\\0' ${quoted}`,
    `printf '%s\\0' '${LOGIN_ENV_DELIMITER}'`,
  ];
}

/** A shell that prints a well-formed transcript, wrapped in rc-file noise. */
function goodShell(records: readonly string[]): string {
  return script(
    'good-shell',
    ["echo 'nvm: Now using node v22.14.0'", ...emit(records)].join('\n'),
  );
}

describe('parseLoginEnv', () => {
  it('reads only what falls between the markers', () => {
    const stdout =
      transcript(
        ['PATH=/opt/homebrew/bin', 'HOME=/Users/someone'],
        'Last login: Tue Aug 12\nMOTD=this line is before the marker\n',
      ) + 'TRAILING=after the marker';

    expect(parseLoginEnv(stdout)).toEqual({
      PATH: '/opt/homebrew/bin',
      HOME: '/Users/someone',
    });
  });

  it('splits on the first = only, so a value may contain one', () => {
    expect(
      parseLoginEnv(transcript(['URL=https://example.com/?a=1&b=2'])).URL,
    ).toBe('https://example.com/?a=1&b=2');
  });

  it('yields nothing when a marker is missing, rather than guessing', () => {
    // A shell that never printed the closing marker did not get as far as
    // reporting its environment either — parsing what it did print would
    // invent variables.
    expect(
      parseLoginEnv(`${NUL}${LOGIN_ENV_DELIMITER}${NUL}PATH=/opt/bin${NUL}`),
    ).toEqual({});
    expect(parseLoginEnv(`PATH=/opt/bin${NUL}`)).toEqual({});
  });

  it('ignores records that are not assignments', () => {
    expect(
      parseLoginEnv(
        transcript(['not an assignment', '=leading equals is not a name', 'GOOD=yes']),
      ),
    ).toEqual({ GOOD: 'yes' });
  });

  /**
   * The regression this protocol exists for (HIVE-86).
   *
   * A `PATH` may legitimately *contain newlines*. The case that produced this
   * test is real and ordinary: `~/.zshrc` doing
   * `export PATH="$PATH:$(npm bin -g)"`, where `npm bin` was removed in npm 9+
   * and substitutes its multi-line "Unknown command" error straight into the
   * value. The line-oriented `printenv` protocol this replaced truncated `PATH`
   * at the first newline and silently dropped every entry after it.
   */
  it('keeps a value that contains newlines whole', () => {
    const brokenPath = [
      '/Users/someone/.bun/bin',
      '/Users/someone/.local/bin',
      '/usr/bin',
      // Exactly what npm 9+ substitutes into the value.
      'Unknown command: "bin"\n\nTo see a list of supported npm commands, run:\n  npm help',
      '/Users/someone/.nvm/versions/node/v22.14.0/bin/npx',
    ].join(':');

    const vars = parseLoginEnv(transcript([`PATH=${brokenPath}`]));

    expect(vars.PATH).toBe(brokenPath);
    // The tail after the embedded newlines is what used to be lost.
    expect(vars.PATH?.split(':')).toContain(
      '/Users/someone/.nvm/versions/node/v22.14.0/bin/npx',
    );
  });

  /**
   * Exactly one trailing newline is `printenv`'s, and only that one is dropped.
   *
   * A value that genuinely ends in a newline arrives as `value\n` plus
   * `printenv`'s own, and must come back with one still attached. Stripping
   * greedily would corrupt it just as surely as not stripping at all.
   */
  it("removes printenv's newline without eating the value's own", () => {
    // `transcript` appends printenv's newline; this value brings its own too.
    expect(parseLoginEnv(transcript(['GH_TOKEN=ends-with\n'])).GH_TOKEN).toBe(
      'ends-with\n',
    );
    expect(parseLoginEnv(transcript(['GH_TOKEN=no-newline'])).GH_TOKEN).toBe(
      'no-newline',
    );
  });

  /**
   * An unset variable prints nothing, so its record is a bare `KEY=`.
   *
   * It arrives present-but-empty rather than absent, which `isSet` rejects —
   * `importLoginEnv` must never write an empty token into `process.env`.
   */
  it('reads a variable the shell had no value for as empty', () => {
    const stdout =
      NUL +
      [LOGIN_ENV_DELIMITER, 'GITHUB_TOKEN=', LOGIN_ENV_DELIMITER].join(NUL) +
      NUL;

    expect(parseLoginEnv(stdout)).toEqual({ GITHUB_TOKEN: '' });
  });

  /**
   * A newline-bearing value must not be able to *forge* a variable either.
   *
   * Under the old protocol a continuation line of the form `NAME=value` was
   * indistinguishable from a real assignment, so any process able to influence
   * one variable could inject another — including one on the import allowlist.
   */
  it('cannot be made to invent a variable from inside a value', () => {
    const vars = parseLoginEnv(
      transcript([`MOTD=harmless\nGH_TOKEN=forged\nPATH=/injected`]),
    );

    expect(vars).toEqual({ MOTD: 'harmless\nGH_TOKEN=forged\nPATH=/injected' });
    expect(vars.GH_TOKEN).toBeUndefined();
    expect(vars.PATH).toBeUndefined();
  });
});

describe('LOGIN_ENV_PROBE_ARGS', () => {
  it('asks only for the allowlist, so no other value is ever emitted', () => {
    const command = LOGIN_ENV_PROBE_ARGS.at(-1) ?? '';

    for (const key of LOGIN_ENV_IMPORT_KEYS) {
      expect(command).toContain(`printenv '${key}'`);
    }
    // The old protocol dumped the whole environment and filtered afterwards.
    // A bare `printenv`, with no key, would do that again.
    expect(command).not.toMatch(/printenv\s*(;|$)/);
  });

  it('is still a login, interactive shell — .zshrc is where PATH is built', () => {
    expect(LOGIN_ENV_PROBE_ARGS.slice(0, 3)).toEqual(['-l', '-i', '-c']);
  });

  /**
   * No variable-expansion syntax, because the login shell may not be POSIX.
   *
   * `defaultShell()` reads `getpwuid`, so fish is a login shell this probe can
   * genuinely be handed. fish rejects `${` at parse time, which would abort the
   * whole command before anything was printed — reinstating HIVE-84 for those
   * users. `printf`, `printenv` and `;` are the only constructs used, exactly
   * as in the protocol this replaced.
   */
  it('uses no shell variable expansion, so a non-POSIX login shell still answers', () => {
    const command = LOGIN_ENV_PROBE_ARGS.at(-1) ?? '';

    expect(command).not.toContain('${');
    expect(command).not.toMatch(/\$[A-Za-z_]/);
  });
});

/**
 * The emitting half, executed for real (HIVE-86).
 *
 * Every other test in this file hand-rolls a transcript, which proves the
 * parser and nothing about the command that is supposed to produce one. This
 * PR changed *both* ends of the protocol at once, so a `printf` that did not
 * honour `\0`, a quoting slip, or syntax one shell rejects would leave the
 * whole suite green. This closes the loop: the real `LOGIN_ENV_PROBE_ARGS`, run
 * by a real shell, parsed by the real `parseLoginEnv`.
 *
 * Every shell the config may name is covered, because portability across them
 * is the property being asserted — not an implementation detail.
 */
describe('the probe and the parser agree, run against a real shell', () => {
  /**
   * The newline-bearing value is carried in `GH_TOKEN`, not `PATH`, on purpose.
   *
   * A login shell sources `/etc/profile`, which on macOS runs `path_helper` —
   * it rewrites `PATH` wholesale, reordering entries and splitting on `:`. So
   * an exact-match assertion on `PATH` would be asserting `path_helper`'s
   * behaviour, not this protocol's. `GH_TOKEN` is passed through untouched by
   * every system rc file, which makes it the honest place to prove that a value
   * survives byte-for-byte. `PATH` is still checked, for what it can prove:
   * that the entries handed in come back.
   */
  const NOISY_VALUE = 'ghp_first\n\nUnknown command: "bin"\n  npm help=yes';

  for (const shell of ['/bin/sh', '/bin/bash', '/bin/zsh']) {
    it(`round-trips a newline-bearing value through ${shell}`, async () => {
      const { stdout } = await runLoginShell(shell, LOGIN_ENV_PROBE_ARGS, {
        cwd: dir,
        env: {
          PATH: '/opt/hive-probe-one:/opt/hive-probe-two',
          GH_TOKEN: NOISY_VALUE,
          // A home with no rc files, so this asserts the protocol rather than
          // whatever the developer running it keeps in ~/.zshrc.
          HOME: dir,
        },
        timeout: 10_000,
      });

      const vars = parseLoginEnv(stdout);

      // The property this protocol exists for: newlines and `=` both survive.
      expect(vars.GH_TOKEN).toBe(NOISY_VALUE);

      const entries = (vars.PATH ?? '').split(delimiter);
      expect(entries).toContain('/opt/hive-probe-one');
      expect(entries).toContain('/opt/hive-probe-two');

      // Unset reads as empty, which `isSet` then rejects — never imported.
      expect(vars.GITHUB_TOKEN).toBe('');

      // Nothing outside the allowlist was ever printed by the shell at all.
      expect(Object.keys(vars).sort()).toEqual(
        [...LOGIN_ENV_IMPORT_KEYS].sort(),
      );
    });
  }
});

describe('mergePath', () => {
  it('puts the login shell first and keeps inherited entries it lacks', () => {
    expect(mergePath('/opt/homebrew/bin:/usr/bin', '/usr/bin:/sbin')).toBe(
      ['/opt/homebrew/bin', '/usr/bin', '/sbin'].join(delimiter),
    );
  });

  it('de-duplicates, so a repeated entry cannot grow the PATH each launch', () => {
    expect(mergePath('/usr/bin:/usr/bin', '/usr/bin')).toBe('/usr/bin');
  });

  it('drops empty entries, which mean "the current directory" to some shells', () => {
    expect(mergePath('/opt/bin::', ':/usr/bin')).toBe(
      ['/opt/bin', '/usr/bin'].join(delimiter),
    );
  });
});

describe('importLoginEnv', () => {
  it('adopts the login shell PATH and the token it supplies', async () => {
    const shell = goodShell([
      'PATH=/opt/homebrew/bin:/usr/bin',
      'GH_TOKEN=a-secret-nobody-should-see',
      'UNRELATED=ignored',
    ]);
    const target: NodeJS.ProcessEnv = { PATH: '/usr/bin:/bin' };

    const status = await importLoginEnv({ enabled: true, shell, target, cwd: dir });

    expect(status.imported).toBe(true);
    expect(status.error).toBeNull();
    expect(status.shell).toBe(shell);
    expect(target.PATH).toBe(
      ['/opt/homebrew/bin', '/usr/bin', '/bin'].join(delimiter),
    );
    expect(target.GH_TOKEN).toBe('a-secret-nobody-should-see');
    // The allowlist is the whole point: everything else stays out.
    expect(target.UNRELATED).toBeUndefined();
    expect(status.varsImported).toEqual(['PATH', 'GH_TOKEN']);
  });

  it('reports entry counts as a pair, so a no-op reads as one', async () => {
    const shell = goodShell(['PATH=/opt/homebrew/bin:/usr/bin:/bin']);
    const target: NodeJS.ProcessEnv = { PATH: '/usr/bin:/bin' };

    const status = await importLoginEnv({ enabled: true, shell, target, cwd: dir });

    expect(status.inheritedEntries).toBe(2);
    expect(status.effectiveEntries).toBe(3);
  });

  it('never reports a value, only the names it imported', async () => {
    const shell = goodShell([
      'PATH=/opt/homebrew/bin',
      'GITHUB_TOKEN=ghp_thisMustNotAppearAnywhere',
    ]);
    const target: NodeJS.ProcessEnv = { PATH: '/usr/bin' };

    const status = await importLoginEnv({ enabled: true, shell, target, cwd: dir });

    expect(status.varsImported).toContain('GITHUB_TOKEN');
    expect(JSON.stringify(status)).not.toContain('ghp_thisMustNotAppearAnywhere');
  });

  it('does not overwrite a token this process already has', async () => {
    const shell = goodShell([
      'PATH=/opt/homebrew/bin',
      'GH_TOKEN=from-the-rc-file',
    ]);
    const target: NodeJS.ProcessEnv = {
      PATH: '/usr/bin',
      GH_TOKEN: 'from-the-terminal-that-launched-us',
    };

    const status = await importLoginEnv({ enabled: true, shell, target, cwd: dir });

    // A deliberate value beats a fallback: an rc file must not silently swap
    // the credential the app authenticates with.
    expect(target.GH_TOKEN).toBe('from-the-terminal-that-launched-us');
    expect(status.varsImported).not.toContain('GH_TOKEN');
  });

  it('treats an exported-but-blank variable as unset', async () => {
    const shell = goodShell(['PATH=/opt/homebrew/bin', 'GH_TOKEN=   ']);
    const target: NodeJS.ProcessEnv = { PATH: '/usr/bin' };

    const status = await importLoginEnv({ enabled: true, shell, target, cwd: dir });

    expect(target.GH_TOKEN).toBeUndefined();
    expect(status.varsImported).toEqual(['PATH']);
  });

  it('reports a clean run that changed nothing as success, not an error', async () => {
    // Launching from a terminal: the environment was already the login
    // shell's. A warning here would be shown to the users with nothing wrong.
    const shell = goodShell(['PATH=/usr/bin:/bin']);
    const target: NodeJS.ProcessEnv = { PATH: '/usr/bin:/bin' };

    const status = await importLoginEnv({ enabled: true, shell, target, cwd: dir });

    expect(status.imported).toBe(false);
    expect(status.error).toBeNull();
    expect(status.effectiveEntries).toBe(status.inheritedEntries);
  });

  it('is a reported no-op when the config turns it off', async () => {
    const shell = goodShell(['PATH=/opt/homebrew/bin']);
    const target: NodeJS.ProcessEnv = { PATH: '/usr/bin' };

    const status = await importLoginEnv({
      enabled: false,
      shell,
      target,
      cwd: dir,
    });

    expect(status).toEqual({
      enabled: false,
      imported: false,
      shell: null,
      inheritedEntries: 1,
      effectiveEntries: 1,
      varsImported: [],
      error: null,
    });
    expect(target.PATH).toBe('/usr/bin');
  });

  it('keeps the inherited PATH when the shell cannot be started', async () => {
    const target: NodeJS.ProcessEnv = { PATH: '/usr/bin' };

    const status = await importLoginEnv({
      enabled: true,
      shell: join(dir, 'no-such-shell'),
      target,
      cwd: dir,
    });

    expect(status.imported).toBe(false);
    expect(status.error).toMatch(/ENOENT/);
    expect(target.PATH).toBe('/usr/bin');
  });

  it('keeps the inherited PATH when the shell exits non-zero', async () => {
    const shell = script('angry-shell', 'echo "broken rc" >&2; exit 3');
    const target: NodeJS.ProcessEnv = { PATH: '/usr/bin' };

    const status = await importLoginEnv({ enabled: true, shell, target, cwd: dir });

    expect(status.imported).toBe(false);
    expect(status.error).toBe('the shell exited with status 3');
    expect(target.PATH).toBe('/usr/bin');
  });

  it('is bounded by SIGKILL against a shell that traps SIGTERM', async () => {
    // The defect `env-diagnostic.ts` records, in the one place where it would
    // land at startup: a trapping rc file must not hold the main process.
    // `/bin/sleep` by absolute path: the probe runs the shell with `target` as
    // its environment, and `target.PATH` is deliberately a single directory
    // that does not contain `sleep`. A bare name would exit 127 and this test
    // would pass for the wrong reason — it would never reach the timeout at all.
    const shell = script('stubborn-shell', "trap '' TERM; /bin/sleep 20");
    const target: NodeJS.ProcessEnv = { PATH: '/usr/bin' };

    const started = Date.now();
    const status = await importLoginEnv({
      enabled: true,
      shell,
      target,
      cwd: dir,
      timeoutMs: 200,
    });
    const elapsed = Date.now() - started;

    expect(status.imported).toBe(false);
    expect(status.error).toMatch(/did not finish within 0\.2s and was killed/);
    // Generously bounded: the point is that it returned in something like the
    // timeout rather than the 20 seconds `sleep` was asked for.
    expect(elapsed).toBeLessThan(5_000);
    expect(target.PATH).toBe('/usr/bin');
  });

  it('reports a shell that printed no markers rather than inventing variables', async () => {
    const shell = script('silent-shell', "echo 'just a banner, no markers'");
    const target: NodeJS.ProcessEnv = { PATH: '/usr/bin' };

    const status = await importLoginEnv({ enabled: true, shell, target, cwd: dir });

    expect(status.imported).toBe(false);
    expect(status.error).toMatch(/printed no environment between the markers/);
    expect(target.PATH).toBe('/usr/bin');
  });
});

describe('startLoginEnvImport', () => {
  it('runs once, however many callers ask for it', async () => {
    // Proven by the side effect rather than a spy: the counter script appends
    // a line per run, so a second spawn would be visible in the file.
    const marker = join(dir, 'runs');
    const shell = script(
      'counting-shell',
      [`echo run >> '${marker}'`, ...emit(['PATH=/opt/homebrew/bin'])].join(
        '\n',
      ),
    );
    const target: NodeJS.ProcessEnv = { PATH: '/usr/bin' };
    const options = { enabled: true, shell, target, cwd: dir };

    const [first, second] = await Promise.all([
      startLoginEnvImport(options),
      startLoginEnvImport(options),
    ]);

    expect(first).toBe(second);
    expect(await loginEnvStatus()).toBe(first);
    expect(target.PATH).toBe(['/opt/homebrew/bin', '/usr/bin'].join(delimiter));
  });

  /**
   * The property the pty-host fork depends on (HIVE-84).
   *
   * `forkPtyHost` passes no `env`, so the utility process snapshots
   * `process.env` once, at fork time, and keeps it for the life of the app.
   * The `ptySpawn` handler therefore awaits `loginEnvStatus()` before the host
   * can come up — which is only worth anything if awaiting it genuinely blocks
   * until the environment has been repaired. This asserts exactly that: the
   * await does not resolve early, and by the time it does, `target` is already
   * fixed.
   */
  it('does not resolve until the environment has actually been repaired', async () => {
    const shell = script(
      'slow-shell',
      ['/bin/sleep 0.3', ...emit(['PATH=/opt/homebrew/bin'])].join('\n'),
    );
    const target: NodeJS.ProcessEnv = { PATH: '/usr/bin' };

    startLoginEnvImport({ enabled: true, shell, target, cwd: dir });

    // Synchronously after starting, nothing has been repaired yet.
    expect(target.PATH).toBe('/usr/bin');

    await loginEnvStatus();

    expect(target.PATH).toBe(['/opt/homebrew/bin', '/usr/bin'].join(delimiter));
  });

  it('answers "disabled" when nothing ever started an import', async () => {
    // The honest answer for a harness that skipped boot — never a claim that
    // an import happened.
    const status = await loginEnvStatus();

    expect(status.enabled).toBe(false);
    expect(status.imported).toBe(false);
    expect(status.shell).toBeNull();
  });
});
