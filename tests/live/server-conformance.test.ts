// @vitest-environment node
import assert from 'node:assert/strict';
import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { get as httpGet } from 'node:http';
import { createRequire } from 'node:module';
import { connect as netConnect, createServer as createNetServer } from 'node:net';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';

import { parseConfig } from '../../electron/main/config/parse';
import { mintDevice, type MintedDevice } from '../../electron/main/server/devices';
import { CONFIG_PATH_ENV, CONFIG_VERSION } from '../../electron/shared/config-contract';
import { CH, REPLAY_BYTES, type Channel, type DataEvent } from '../../electron/shared/ipc-contract';
import {
  REMOTE_PROTOCOL_VERSION,
  type AttachRequest,
  type ClientFrame,
  type ErrorFrame,
  type EventFrame,
  type ResultFrame,
  type ServerFrame,
} from '../../electron/shared/remote-contract';

/**
 * Server-mode conformance (HIVE-142): the eight acceptance criteria plus the
 * data-loss half of the freshness fix, proved against the **built** app —
 * `pnpm desktop:build` first — spawned as a real Electron process, and a real
 * `ws` client speaking the wire protocol from outside that process entirely.
 *
 * ## Why this cannot be a unit test
 *
 * `tests/electron/remote-host/listener.test.ts` already proves the handshake
 * in-process, against `createRemoteListener` called directly. That is the
 * exact shape that cannot catch what this story's three review rounds were
 * actually about: whether `index.ts` wires the listener up at all in server
 * mode, whether `--pair` — a **second OS process**, spawned after the server
 * is already listening — actually lands a device the running server's
 * unauthenticated-read getter picks up without a restart, and whether the
 * config file that process just wrote is safe to leave on a served machine's
 * disk. None of those are properties of `listener.ts` in isolation; they are
 * properties of the composition in `electron/main/index.ts`, and the only way
 * to observe a composition bug is to run the composed thing.
 *
 * ## The eight cases, plus one
 *
 * 1. Boots with `--server`, binds loopback, opens no window.
 * 2. A raw `ws` client completes the handshake and is accepted.
 * 3. A wrong token, a revoked token and a disallowed `Origin` are each
 *    refused, asserting the refusal code.
 * 4. A forced protocol mismatch names both versions, and no frame follows.
 * 5. A call frame on an unattached socket is refused.
 * 6. `--pair` in a second process is seen by the running server with no
 *    restart — the headline claim, and the one this file exists for.
 * 7. `config.json` is read back and contains no token — checked against the
 *    literal string the mint printed, not a shape assertion.
 * 8. A config asking for `0.0.0.0` is refused with a message naming why, the
 *    app keeps serving on the safe loopback fallback, and the served
 *    process's own listening socket — inspected with `lsof`, not a network
 *    probe — is bound to `127.0.0.1` and never the wildcard, with a positive
 *    control proving that same check can see a genuine wildcard bind on this
 *    machine when one exists.
 * 9. Pairing a second device from the CLI while the server runs does not
 *    erase the first — the data-loss half of the same freshness fix, added
 *    here because an earlier implementation of it replaced the whole roster
 *    from a stale in-memory copy and silently dropped a concurrently paired
 *    device.
 *
 * Case 1's assertion is deliberately thin: it proves the served app answers
 * on its socket, and nothing about the absence of a window. A live client
 * outside the process cannot observe `BrowserWindow.getAllWindows()`, and a
 * stdout marker that exists only so this file could read it would be
 * production code written to serve a test — `registerLifecycle`'s own unit
 * test already proves the window never opens.
 *
 * ## Case 6/9's one-shots share the running app's own profile, on purpose
 *
 * `electron/main/index.ts` runs a one-shot's whole body (`--pair`, `--revoke`,
 * `--devices`) **before** `app.requestSingleInstanceLock()`, with a comment
 * explaining why: on a served machine the app is always running, so a
 * one-shot that requested the lock would lose it to the running server and
 * quit before printing anything. That ordering is the entire mechanism that
 * makes `--pair` work against a running server in production — and it can
 * only be exercised by giving the one-shot the **same** `--user-data-dir` as
 * the already-running app. A one-shot pointed at a *different* profile would
 * never contend for that lock at all, so a regression that moved the
 * one-shot check to *after* `requestSingleInstanceLock()` would not turn this
 * suite red (HIVE-142 review, important 2).
 *
 * ## Past the handshake: the eight HIVE-143 cases
 *
 * The paragraph that used to stand here said "nothing past the handshake",
 * because an attached socket was handed nothing further. HIVE-143 wired the
 * frame loop, the dispatch registry, the socket fan-out and the replay ring, so
 * the second `describe` below drives all four over the same real socket:
 *
 * 10. `config:get` — a `read` channel answers with the real config snapshot.
 * 11. `github:prs` — an `execute`-graded channel is reached and answers.
 * 12. `fs:read-file` through a symlink out of the project carries `EOUTSIDE`
 *     **as a `result`**, not as an `error` frame.
 * 13. The same for `ENOENT`, which is the code the editor branches on.
 * 14. `config:choose-directory` is refused `window-bound`, naming HIVE-146.
 * 15. `ledger:changed` and `agents:changed` reach the attached client.
 * 16. A socket killed mid-output resumes contiguously, transcript whole.
 * 17. A gap forced past `REPLAY_BYTES` leaves a seq discontinuity — the thing
 *     the renderer's existing gap notice keys on
 *     (`src/lib/terminal/pty-transport.ts`, asserted at
 *     `tests/lib/terminal/pty-transport.test.ts:463` and not duplicated here).
 *
 * Those cases spawn **real PTYs** through the socket: `pty:spawn` is graded
 * `execute` and a paired device holds `execute`, which is the whole premise the
 * authorization table is written from. The session runs `/bin/sh` with a
 * stubbed `claudeCommand`, the same discipline every Playwright spec in
 * `tests/e2e/electron` uses, so no real agent is ever started.
 *
 * ## `HIVE_CONFIG_PATH` is mandatory, and never inherited
 *
 * `--user-data-dir` only relocates Electron's own profile (window state, the
 * single-instance lock) — the workspace config lives at `~/.hive/config.json`
 * (`electron/main/config/paths.ts`) unless `HIVE_CONFIG_PATH` says otherwise
 * (`config-contract.ts`'s `CONFIG_PATH_ENV`), and nothing here ever spawns a
 * process without it explicitly set. That one variable relocates the *whole*
 * `~/.hive` tree, not only the config file: `ledger-contract.ts` derives the
 * ledger, agents and work directories from `dirname(configPath())`, so this
 * suite cannot reach a developer's ledger or agent state either.
 * {@link REAL_CONFIG_PATH} is asserted against on every scratch path this
 * file is about to write to, at the moment it is computed — not as a
 * formality, but because a mistake here writes a real device credential into
 * the person running this suite's actual config, which is exactly how the
 * brief for this task was written in the first place. Every `HIVE_*`
 * variable a spawned process gets is named explicitly by {@link scrubbedEnv},
 * which strips whatever the same name happens to be set to in this shell
 * before applying the ones this file actually wants — so an ambient
 * `HIVE_CONFIG_PATH`, or a leftover `HIVE_LIVE_*_PROOF`, cannot leak into a
 * child and make this suite pass for the wrong reason.
 *
 * ## Evidence
 *
 * A `vitest run` off a TTY (a background shell) prints totals only, so a
 * failure here would otherwise be unreadable. Every spawned process's argv,
 * exit code and captured stdout/stderr is collected into {@link processLog},
 * and every attach attempt's frame and outcome into {@link attachLog} — the
 * suite's most likely failure is frame-level (an `attach-refused` where
 * `attach-accepted` was expected), which argv and exit codes alone would not
 * show. Both, plus every scratch config path used, are written once, at the
 * very end, to `finding.json` inside {@link evidenceDir} — which this file
 * does **not** delete, on the same reasoning `hook-context-conformance.test.ts`
 * gives for leaving its own evidence directory behind: a scratch dir in
 * `os.tmpdir()` costs nothing to leave and is the only place a failed
 * background run's detail survives.
 *
 * Gated behind `HIVE_LIVE_SERVER_PROOF=1` (`pnpm test:server`) because it
 * spawns real Electron processes and binds real sockets.
 */

const RUN = process.env['HIVE_LIVE_SERVER_PROOF'] === '1';

const execFileAsync = promisify(execFile);

/** The one path this file must never write to. See the header comment. */
const REAL_CONFIG_PATH = join(homedir(), '.hive', 'config.json');

/** Refuses to proceed if `path` is the developer's real config file. */
function assertScratchPath(path: string): void {
  if (path === REAL_CONFIG_PATH) {
    throw new Error(
      `refusing to run: this suite would write to ${REAL_CONFIG_PATH}, the real workspace config`,
    );
  }
}

/**
 * The Electron binary this suite drives, resolved the same way Electron's own
 * docs describe for an npm script: `require('electron')` answers the
 * executable's path when the caller is plain Node rather than Electron
 * itself. A static `import` of the `electron` package types this as the
 * `Electron.CrossProcessExports` namespace — correct inside the app, and a
 * lie about what this process, which is Node under Vitest, actually gets back
 * — so a `require` reached through `createRequire` is used instead of an
 * `import` that `tsc` would accept but that would be wrong at runtime.
 */
const electronBinary = createRequire(import.meta.url)('electron') as string;

/** The built app's entry point — the same file `desktop:build` produces and `package.json`'s `main` names. */
const MAIN_ENTRY = join(import.meta.dirname, '../../out/main/index.js');

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** A free loopback port, found by binding ephemeral (port 0) and releasing it — the only way to get a fixed number to hand to `server.bind.port`, which (unlike the hook receiver's) is not OS-assigned. */
function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createNetServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address();
      probe.close(() => {
        if (address === null || typeof address === 'string') {
          reject(new Error('could not determine a free port'));
          return;
        }
        resolve(address.port);
      });
    });
  });
}

/** Polls a raw TCP connect until it succeeds, or throws once `deadlineMs` has passed. */
async function waitForListener(host: string, port: number, deadlineMs: number): Promise<void> {
  const start = Date.now();
  const tryOnce = (): Promise<boolean> =>
    new Promise((resolve) => {
      const socket = netConnect({ host, port }, () => {
        socket.end();
        resolve(true);
      });
      socket.on('error', () => resolve(false));
    });

  while (Date.now() - start < deadlineMs) {
    if (await tryOnce()) return;
    await delay(200);
  }
  throw new Error(`timed out waiting for ${host}:${String(port)} to accept connections`);
}

/**
 * Every `host:port` a pid is listening on over TCP, exactly as `lsof` reports
 * it — `127.0.0.1:54321` for a loopback-only bind, `*:54321` for a wildcard
 * one.
 *
 * This replaces an earlier version of case 8 that tried to tell a wildcard
 * bind apart from a loopback one by connecting from a real non-loopback
 * address on this machine and treating a refusal (or a timeout) as proof of
 * the latter. Review caught the vacuity that left in place: macOS's
 * Application Firewall filters *inbound* TCP per application and silently
 * drops a `SYN` to a binary outside its allow list — which is not a corner
 * case for an unsigned, unnotarized dev build, it is the common one. A
 * wildcard bind that *was* genuinely listening on that address could produce
 * the exact same silence a refused one does, so the probe could pass with
 * the bug present. Asking the kernel what a pid actually holds open sidesteps
 * every bit of that: no packet leaves the machine, no firewall is consulted,
 * and the answer is exact rather than inferred from a socket's behaviour.
 */
async function listeningAddresses(pid: number): Promise<string[]> {
  try {
    /*
      `-a` is load-bearing, and its absence does not fail loudly: `lsof`
      combines separate selection options (`-p`, `-i`) with OR by default, not
      AND, so `-p <pid> -iTCP -sTCP:LISTEN` without it lists every listening
      TCP socket on the *machine* — this pid's or anyone else's — not this
      pid's alone. Measured directly against this repo's own dev machine: it
      returned 90-odd sockets belonging to Docker, VS Code, Redis, and every
      other unrelated LISTEN owner on the box, identical for two different
      pids. The port-specific filter below still happened to find the right
      line either way, purely because a TCP port is unique machine-wide, so
      the original bug hid behind a coincidentally-correct answer — `-a`
      makes the query actually mean what it claims rather than working by
      accident on this one property of the address space.
    */
    const { stdout } = await execFileAsync('lsof', [
      '-a',
      '-nP',
      '-p',
      String(pid),
      '-iTCP',
      '-sTCP:LISTEN',
    ]);
    return stdout
      .split('\n')
      .map((line) => /(\S+:\d+)\s*\(LISTEN\)\s*$/u.exec(line.trim())?.[1])
      .filter((address): address is string => address !== undefined);
  } catch (err) {
    // Some `lsof` builds exit non-zero rather than printing an empty table
    // when a pid holds no matching socket at all — itself a fact worth
    // returning to the caller rather than a suite failure. Anything else
    // (no `lsof` on PATH, a permissions failure) still throws.
    if (typeof err === 'object' && err !== null && 'stdout' in err) return [];
    throw err;
  }
}

/** The HTTP status a plain GET gets back — proof the socket is a real HTTP(S) upgrade server, not merely an open file descriptor. */
function httpStatus(url: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = httpGet(url, (res) => {
      res.resume();
      resolve(res.statusCode ?? 0);
    });
    req.on('error', reject);
  });
}

/** One spawned process's evidence, kept whether it passes or fails. */
interface ProcessRecord {
  label: string;
  args: readonly string[];
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
}

const processLog: ProcessRecord[] = [];

/** Every scratch `config.json` path this run wrote to — part of the evidence, and a second, independent confirmation that none of them is {@link REAL_CONFIG_PATH}. */
const scratchConfigPaths: string[] = [];

/**
 * `env`, with every `HIVE_*` key this shell happens to carry stripped first.
 *
 * Spreading `process.env` and layering overrides on top is what every other
 * `tests/live` file does, and it is exactly the trap this task's dispatch
 * warns about: an ambient `HIVE_CONFIG_PATH` (or any other `HIVE_*` a
 * developer's own shell profile sets) would otherwise ride along underneath
 * `overrides` and only matter on the keys `overrides` does not also name.
 * Stripping first and layering explicit values after means the only `HIVE_*`
 * variables a spawned process ever sees are the ones named right here.
 */
function scrubbedEnv(overrides: Record<string, string>): NodeJS.ProcessEnv {
  const base: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined || key.startsWith('HIVE_')) continue;
    base[key] = value;
  }
  return { ...base, ...overrides };
}

/** Spawns the app itself — a long-running process this file must stop with {@link stopApp}. */
function spawnApp(
  extraArgs: readonly string[],
  configPath: string,
  userDataDir: string,
): { child: ChildProcess; record: ProcessRecord } {
  assertScratchPath(configPath);
  const args = [MAIN_ENTRY, `--user-data-dir=${userDataDir}`, ...extraArgs];
  const child = spawn(electronBinary, args, {
    env: scrubbedEnv({ [CONFIG_PATH_ENV]: configPath, HIVE_E2E: '1' }),
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const record: ProcessRecord = {
    label: `app ${extraArgs.join(' ')}`,
    args,
    code: null,
    signal: null,
    stdout: '',
    stderr: '',
  };
  processLog.push(record);
  child.stdout?.on('data', (chunk: Buffer) => (record.stdout += chunk.toString()));
  child.stderr?.on('data', (chunk: Buffer) => (record.stderr += chunk.toString()));
  child.on('exit', (code, signal) => {
    record.code = code;
    record.signal = signal;
  });
  /*
    Unlike `runOneShot` below (which rejects a promise on a spawn error), this
    process is long-running and handed back synchronously — there is no
    promise left to reject into. Without this handler a missing or
    non-executable binary (running this file without `desktop:build` first,
    say) surfaces as an unhandled `ChildProcess` `error` event, which crashes
    the whole Vitest worker rather than failing one test readably (HIVE-142
    review, minor 3).
  */
  child.on('error', (err) => {
    record.stderr += `\n[spawn error] ${err instanceof Error ? err.message : String(err)}`;
  });
  return { child, record };
}

/** Stops a process started by {@link spawnApp}: `SIGTERM` first, `SIGKILL` if it has not gone in 10s. A no-op on `undefined`, so a teardown that runs after a `beforeAll` failed partway (before the app was even spawned) does not itself throw. */
function stopApp(child: ChildProcess | undefined): Promise<void> {
  return new Promise((resolve) => {
    if (!child || child.exitCode !== null || child.signalCode !== null) {
      resolve();
      return;
    }
    const timer = setTimeout(() => child.kill('SIGKILL'), 10_000);
    child.once('exit', () => {
      clearTimeout(timer);
      resolve();
    });
    child.kill('SIGTERM');
  });
}

interface BootedApp {
  child: ChildProcess;
  record: ProcessRecord;
  port: number;
}

/**
 * Boots the served app end to end: picks a free port, writes `configPath` via
 * `buildConfig(port)`, spawns it with `--server`, waits for the socket, and
 * health-checks it with a plain GET expecting `426`.
 *
 * Retried once, with a **fresh** port, if that health check does not come
 * back `426`. This exists because of a disclosed, low-probability race in
 * {@link freePort}: releasing the probe socket before this function's own
 * `spawnApp` binds it leaves a window another process could steal the same
 * port in. Reviewed concern: a stolen port would otherwise make the caller's
 * own health assertion report "expected 426, got X" with nothing pointing at
 * a collision (HIVE-142 review, minor 8). A genuine regression in the
 * listener fails the health check identically on the retry — a fresh port
 * changes nothing about whether the *code* is broken — so this cannot mask a
 * real defect, only absorb the port race.
 */
async function bootServerApp(
  configPath: string,
  userDataDir: string,
  buildConfig: (port: number) => unknown,
): Promise<BootedApp> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    const port = await freePort();
    writeFileSync(configPath, JSON.stringify(buildConfig(port), null, 2), 'utf8');
    const { child, record } = spawnApp(['--server'], configPath, userDataDir);
    try {
      await waitForListener('127.0.0.1', port, 30_000);
      const status = await httpStatus(`http://127.0.0.1:${String(port)}/`);
      if (status === 426) return { child, record, port };
      throw new Error(
        `boot health check on 127.0.0.1:${String(port)} got status ${String(status)}, not 426 ` +
          `(attempt ${String(attempt)}/2 — possibly the disclosed freePort race). stderr:\n${record.stderr || '(empty)'}`,
      );
    } catch (err) {
      lastError = err;
      await stopApp(child);
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

/**
 * Runs one of the CLI one-shots (`--pair`, `--revoke`, `--devices`) to
 * completion in its own, separate process — the exact shape `--pair` has in
 * production, and the only way to prove case 6's claim that a *second*
 * process reaches an *already-running* server with no restart.
 *
 * `userDataDir` must be the **same** profile as the already-running app —
 * see the header comment's "Case 6/9's one-shots share the running app's own
 * profile" section for why a separate one would remove the exact lock
 * ordering this is meant to exercise.
 */
function runOneShot(
  args: readonly string[],
  configPath: string,
  userDataDir: string,
  timeoutMs = 20_000,
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  assertScratchPath(configPath);
  return new Promise((resolve, reject) => {
    const fullArgs = [MAIN_ENTRY, ...args, `--user-data-dir=${userDataDir}`];
    const child = spawn(electronBinary, fullArgs, {
      env: scrubbedEnv({ [CONFIG_PATH_ENV]: configPath }),
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const record: ProcessRecord = {
      label: `one-shot ${args.join(' ')}`,
      args: fullArgs,
      code: null,
      signal: null,
      stdout: '',
      stderr: '',
    };
    processLog.push(record);

    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`one-shot ${args.join(' ')} timed out after ${String(timeoutMs)}ms`));
    }, timeoutMs);

    child.stdout?.on('data', (chunk: Buffer) => (record.stdout += chunk.toString()));
    child.stderr?.on('data', (chunk: Buffer) => (record.stderr += chunk.toString()));
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on('exit', (code, signal) => {
      clearTimeout(timer);
      record.code = code;
      record.signal = signal;
      resolve({ code, stdout: record.stdout, stderr: record.stderr });
    });
  });
}

/** What one attach attempt resolved to: a parsed frame, the HTTP status an upgrade was refused with, or (logged, never returned to a caller — see `attach`'s `'error'` handler) the message a raw socket error carried. */
interface AttachOutcome {
  httpStatus?: number;
  frame?: Record<string, unknown>;
  error?: string;
}

/** One call to {@link attach}, kept for `finding.json` regardless of pass/fail — the suite's most likely failure is frame-level, which argv/exit-code evidence alone cannot show. */
interface AttachLogEntry {
  at: string;
  url: string;
  frame: unknown;
  outcome: AttachOutcome;
}

const attachLog: AttachLogEntry[] = [];

/**
 * Sends one frame over a fresh `ws` connection and resolves with whatever
 * comes back — a JSON frame, or (for an Origin refused at the upgrade itself)
 * the HTTP status the server answered with instead of `101`. Mirrors
 * `tests/electron/remote-host/listener.test.ts`'s own `attach`/`attachTolerant`
 * helpers, merged into one shape because this file's callers need both.
 */
function attach(
  url: string,
  frame: unknown,
  headers: Record<string, string> = {},
): Promise<AttachOutcome> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url, { headers });
    let settled = false;
    const settle = (outcome: AttachOutcome): void => {
      if (settled) return;
      settled = true;
      attachLog.push({ at: new Date().toISOString(), url, frame, outcome });
      resolve(outcome);
    };

    socket.on('open', () => socket.send(JSON.stringify(frame)));
    socket.on('message', (data) => {
      settle({ frame: JSON.parse(String(data)) as Record<string, unknown> });
      socket.close();
    });
    // Fires instead of `error` only because this handler is registered —
    // exactly the refusal an disallowed Origin produces (a 403 at the upgrade,
    // never a JSON frame).
    socket.on('unexpected-response', (_req, res) => {
      settle({ httpStatus: res.statusCode });
      res.resume();
    });
    // A close with nothing ever received — the handshake-timeout drop, most
    // likely — resolves empty rather than hanging the test.
    socket.on('close', () => settle({}));
    socket.on('error', (err) => {
      if (settled) return;
      settled = true;
      // The one outcome `settle` never produces, because a caller expecting
      // a rejection should still get one — but it is still logged, so a
      // genuine connection failure (a stale `url` from a killed app, say)
      // leaves a trace in `finding.json` instead of only a thrown error the
      // test framework already reports elsewhere (HIVE-142 review, low 2).
      attachLog.push({
        at: new Date().toISOString(),
        url,
        frame,
        outcome: { error: err instanceof Error ? err.message : String(err) },
      });
      reject(err);
    });
  });
}

/**
 * Polls `predicate` until it holds, or throws naming what never happened.
 *
 * The same shape as {@link waitForListener} above, and for the same reason a
 * fixed sleep is refused everywhere in this repo's live suites: a sleep long
 * enough to be reliable on a loaded machine is dead time on every run, and one
 * short enough to be quick fails as a timeout with nothing saying what was
 * being waited for. `what` is what turns that timeout into a readable failure.
 */
async function waitFor(predicate: () => boolean, what: string, timeoutMs = 30_000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (predicate()) return;
    await delay(25);
  }
  throw new Error(`timed out after ${String(timeoutMs)}ms waiting for ${what}`);
}

/**
 * Waits until `count` has stopped moving for `quietMs`, or throws naming what
 * never settled.
 *
 * Not a sleep dressed up: it is the only way to say "nothing is armed" about a
 * debounced watcher from outside the process holding the timer. The agents
 * registry announces 120ms after the last filesystem event it saw
 * (`electron/main/agents/registry.ts`), so a counter that has not moved for
 * several times that has no announce pending behind it — which is exactly what
 * makes a baseline taken afterwards mean something.
 */
async function settled(
  count: () => number,
  what: string,
  quietMs = 600,
  timeoutMs = 30_000,
): Promise<void> {
  const start = Date.now();
  let last = count();
  let lastChangedAt = Date.now();
  while (Date.now() - start < timeoutMs) {
    await delay(50);
    const now = count();
    if (now !== last) {
      last = now;
      lastChangedAt = Date.now();
      continue;
    }
    if (Date.now() - lastChangedAt >= quietMs) return;
  }
  throw new Error(`timed out after ${String(timeoutMs)}ms waiting for ${what} to go quiet`);
}

/**
 * Bytes on the wire against bytes of `chunk` — the story's framing measurement.
 *
 * Accounted **per session**, not per socket, because the measurement is a claim
 * about one flood and a socket sees every session the server is running. Case
 * 16's shell is still alive when case 17's flood client attaches, so a
 * socket-wide counter folds that session's trickle into a total the comment
 * above the PTY cases attributes entirely to the flood (review, item 2).
 */
interface PtyTraffic {
  frames: number;
  /** The whole JSON text of every `pty:data` frame, as `ws` delivered it. */
  wireBytes: number;
  /** Only the `chunk` inside those frames — the payload a binary frame would carry. */
  chunkBytes: number;
}

/** Anything a case wants recorded in `finding.json` beyond argv and frames. */
const measurements: Record<string, unknown>[] = [];

/**
 * One attached client: a real socket that has completed a real handshake, with
 * the post-attach frame loop driven from outside the app entirely (HIVE-143).
 *
 * Built on {@link attach}'s own conventions rather than beside them — the
 * handshake frame is the same shape, the outcome is written to the same
 * {@link attachLog} — but it keeps the socket **open** afterwards, which
 * `attach` deliberately does not: that helper exists to read exactly one frame
 * off an unattached socket and close it.
 */
interface LiveClient {
  /** Send a `call` frame with a fresh id; resolve its `result` or `error`. */
  call(channel: Channel, payload: unknown): Promise<ResultFrame | ErrorFrame>;
  /**
   * Send a `notify` frame. There is no answer to wait for, by contract —
   * `FRAME_KIND` grades `pty:write`, `pty:resize` and `pty:ack` as `notify`, and
   * a `call` naming one of them is refused `wrong-frame-kind`.
   */
  notify(channel: Channel, payload: unknown): void;
  /** Every `event` frame seen since this socket attached. */
  collectEvents(): () => EventFrame[];
  /** The `pty:data` events for `sessionId`, once their joined chunks match. */
  collectPtyUntil(sessionId: string, pattern: RegExp, timeoutMs?: number): Promise<DataEvent[]>;
  /** The `pty:data` events for `sessionId`, once there are at least `count` of them. */
  collectPtyCount(sessionId: string, count: number, timeoutMs?: number): Promise<DataEvent[]>;
  /** Waits until at least `bytes` of `chunk` have arrived for `sessionId`. */
  collectPtyBytes(sessionId: string, bytes: number, timeoutMs?: number): Promise<void>;
  /** `pty:spawn` a real session on `projectId`, answering the entity id used. */
  spawnSession(projectId: string, sessionId: string): Promise<string>;
  /** Drop the socket with no close frame — the reconnect case. */
  kill(): void;
  /** Close it politely. The suite's own teardown, never a case's assertion. */
  close(): void;
  /** What this socket carried for `sessionId` alone. */
  ptyTraffic(sessionId: string): PtyTraffic;
}

/** Every client this run opened, so teardown can close one a failing case left behind. */
const liveClients: LiveClient[] = [];

/**
 * Completes a real handshake and hands back a client that stays attached.
 *
 * `resumeFrom` is passed through verbatim, **including its absence**: the
 * contract is explicit that an absent key and an empty map are different
 * questions, so this spreads rather than always writing the field.
 */
async function openClient(
  url: string,
  device: { id: string; token: string },
  options: { resumeFrom?: Record<string, number> } = {},
): Promise<LiveClient> {
  const socket = new WebSocket(url);
  const events: EventFrame[] = [];
  const ptyEvents: DataEvent[] = [];
  const pending = new Map<string, (frame: ResultFrame | ErrorFrame) => void>();
  const traffic = new Map<string, PtyTraffic>();
  let nextCallId = 0;

  const frame: AttachRequest = {
    kind: 'attach',
    protocol: REMOTE_PROTOCOL_VERSION,
    deviceId: device.id,
    token: device.token,
    ...(options.resumeFrom === undefined ? {} : { resumeFrom: options.resumeFrom }),
  };

  const send = (outgoing: ClientFrame): void => {
    socket.send(JSON.stringify(outgoing));
  };

  let settled = false;
  let onAttached: () => void = () => {};
  let onFailed: (cause: Error) => void = () => {};
  const attached = new Promise<void>((resolve, reject) => {
    onAttached = resolve;
    onFailed = reject;
  });
  const timer = setTimeout(() => {
    onFailed(new Error(`attach to ${url} produced no answer in 15s`));
  }, 15_000);
  const settle = (outcome: AttachOutcome, cause: Error | null): void => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    attachLog.push({ at: new Date().toISOString(), url, frame, outcome });
    if (cause === null) onAttached();
    else onFailed(cause);
  };

  socket.on('open', () => {
    send(frame);
  });
  // Present for the reason `listener.ts` installs one on its own sockets: an
  // `'error'` event with no listener throws synchronously out of the emitter,
  // which here would take the whole Vitest worker down rather than fail a case.
  socket.on('error', (cause) => {
    settle({ error: cause.message }, cause);
  });
  socket.on('close', () => {
    settle({}, new Error(`socket to ${url} closed before it attached`));
  });

  /*
    One listener for the whole life of the socket, registered before the attach
    frame is even sent. That ordering is load-bearing for the resume cases: the
    server writes the replayed `pty:data` frames immediately after
    `attach-accepted`, in the same turn, so a handler installed only once the
    attach promise resolved would miss exactly the frames those cases are about.
  */
  socket.on('message', (data) => {
    const text = String(data);
    const incoming = JSON.parse(text) as ServerFrame;

    if (incoming.kind === 'attach-accepted') {
      settle({ frame: incoming as unknown as Record<string, unknown> }, null);
      return;
    }
    if (incoming.kind === 'attach-refused') {
      settle(
        { frame: incoming as unknown as Record<string, unknown> },
        new Error(`attach refused: ${incoming.code} — ${incoming.message}`),
      );
      return;
    }
    if (incoming.kind === 'result' || incoming.kind === 'error') {
      const waiting = pending.get(incoming.id);
      pending.delete(incoming.id);
      waiting?.(incoming);
      return;
    }

    events.push(incoming);
    if (incoming.channel !== CH.ptyData) return;

    const event = incoming.payload as DataEvent;
    ptyEvents.push(event);

    const counted = traffic.get(event.sessionId) ?? { frames: 0, wireBytes: 0, chunkBytes: 0 };
    counted.frames += 1;
    counted.wireBytes += Buffer.byteLength(text);
    counted.chunkBytes += Buffer.byteLength(event.chunk);
    traffic.set(event.sessionId, counted);
    /*
      Acked exactly as the renderer acks (`pty-transport.ts`), and not as a
      courtesy: `HIGH_WATER_BYTES` is 512 KiB of unacked output, past which main
      pauses the pty at the fd. A client that never acked would stall its own
      flood halfway through and the case waiting on the tail would time out
      against a session that is not broken, only paused.
    */
    send({ kind: 'notify', channel: CH.ptyAck, payload: { sessionId: event.sessionId, seq: event.seq } });
  });

  await attached;

  const forSession = (sessionId: string): DataEvent[] =>
    ptyEvents.filter((event) => event.sessionId === sessionId);
  const bytesFor = (sessionId: string): number =>
    forSession(sessionId).reduce((total, event) => total + Buffer.byteLength(event.chunk), 0);

  const client: LiveClient = {
    call(channel, payload) {
      nextCallId += 1;
      const id = `live-${String(nextCallId)}`;
      return new Promise((resolve, reject) => {
        const callTimer = setTimeout(() => {
          pending.delete(id);
          reject(new Error(`call ${channel} (${id}) was never answered`));
        }, 60_000);
        pending.set(id, (answer) => {
          clearTimeout(callTimer);
          resolve(answer);
        });
        send({ kind: 'call', id, channel, payload });
      });
    },

    notify(channel, payload) {
      send({ kind: 'notify', channel, payload });
    },

    collectEvents: () => () => [...events],

    async collectPtyUntil(sessionId, pattern, timeoutMs = 60_000) {
      await waitFor(
        () => pattern.test(forSession(sessionId).map((event) => event.chunk).join('')),
        `pty:data for ${sessionId} matching ${String(pattern)}`,
        timeoutMs,
      );
      return forSession(sessionId);
    },

    async collectPtyCount(sessionId, count, timeoutMs = 60_000) {
      await waitFor(
        () => forSession(sessionId).length >= count,
        `${String(count)} pty:data frames for ${sessionId}`,
        timeoutMs,
      );
      return forSession(sessionId);
    },

    async collectPtyBytes(sessionId, bytes, timeoutMs = 60_000) {
      await waitFor(
        () => bytesFor(sessionId) >= bytes,
        `${String(bytes)} bytes of pty:data for ${sessionId}`,
        timeoutMs,
      );
    },

    async spawnSession(projectId, sessionId) {
      const answer = await client.call(CH.ptySpawn, { sessionId, projectId, cols: 200, rows: 24 });
      assert(
        answer.kind === 'result',
        `pty:spawn was refused: ${JSON.stringify(answer)}`,
      );
      return sessionId;
    },

    kill() {
      socket.terminate();
    },

    close() {
      if (socket.readyState === WebSocket.OPEN) socket.close();
      else socket.terminate();
    },

    ptyTraffic: (sessionId) => ({
      frames: 0,
      wireBytes: 0,
      chunkBytes: 0,
      ...traffic.get(sessionId),
    }),
  };

  liveClients.push(client);
  return client;
}

describe.skipIf(!RUN)('server mode, against a real built app (HIVE-142)', () => {
  let evidenceDir: string;

  beforeAll(() => {
    if (!existsSync(MAIN_ENTRY)) {
      throw new Error(`${MAIN_ENTRY} is missing. Run \`pnpm desktop:build\` before \`pnpm test:server\`.`);
    }
    evidenceDir = mkdtempSync(join(tmpdir(), 'hive-live-server-evidence-'));
  });

  afterAll(() => {
    const findingPath = join(evidenceDir, 'finding.json');
    writeFileSync(
      findingPath,
      JSON.stringify(
        {
          ranAt: new Date().toISOString(),
          scratchConfigPaths,
          measurements,
          processes: processLog,
          attaches: attachLog,
        },
        null,
        2,
      ),
      'utf8',
    );
    console.info('EVIDENCE ', findingPath);
  });

  describe('the handshake, the CLI in a second process, and the token never on disk', () => {
    let dir: string;
    let configPath: string;
    let userDataDir: string;
    let port: number;
    let url: string;
    let app: ChildProcess | undefined;
    let appRecord: ProcessRecord | undefined;
    let active: MintedDevice;
    let revoked: MintedDevice;
    let liveA: { id: string; token: string } | null = null;
    let liveB: { id: string; token: string } | null = null;

    beforeAll(async () => {
      dir = mkdtempSync(join(tmpdir(), 'hive-live-server-main-'));
      configPath = join(dir, 'config.json');
      userDataDir = join(dir, 'user-data');
      assertScratchPath(configPath);
      scratchConfigPaths.push(configPath);

      active = mintDevice('Seed-Active');
      revoked = mintDevice('Seed-Revoked');

      const booted = await bootServerApp(configPath, userDataDir, (bootPort) => ({
        version: CONFIG_VERSION,
        projects: [],
        server: {
          bind: { host: '127.0.0.1', port: bootPort, allowedOrigins: [] },
          devices: [active.device, { ...revoked.device, revoked: true }],
        },
      }));
      app = booted.child;
      appRecord = booted.record;
      port = booted.port;
      url = `ws://127.0.0.1:${String(port)}`;
    }, 90_000);

    afterAll(async () => {
      await stopApp(app);
    }, 15_000);

    it('1. boots with --server and answers on its socket', async () => {
      // A plain GET, not an upgrade: proof this is the real HTTP(S) server
      // `remote-host/listener.ts` builds (426 is its own "Upgrade required"
      // answer to anything that is not a `ws` handshake), not merely a TCP
      // port something else happens to hold open. Window-absence is
      // `registerLifecycle`'s unit test, not this file — see the header
      // comment.
      const status = await httpStatus(`http://127.0.0.1:${String(port)}/`);
      expect(status, `served app's stderr so far:\n${appRecord?.stderr || '(empty)'}`).toBe(426);
    });

    it('2. a raw ws client completes the attach handshake and is accepted', async () => {
      const outcome = await attach(url, {
        kind: 'attach',
        protocol: REMOTE_PROTOCOL_VERSION,
        deviceId: active.device.id,
        token: active.token,
      });
      expect(outcome.frame).toMatchObject({ kind: 'attach-accepted' });
    });

    it('3a. refuses a wrong token, naming it unauthorized', async () => {
      const outcome = await attach(url, {
        kind: 'attach',
        protocol: REMOTE_PROTOCOL_VERSION,
        deviceId: active.device.id,
        token: 'ZZZZ-ZZZZ-ZZZZ-ZZZZ',
      });
      expect(outcome.frame).toMatchObject({ kind: 'attach-refused', code: 'unauthorized' });
    });

    it('3b. refuses a revoked device presenting its own correct token, naming it revoked', async () => {
      const outcome = await attach(url, {
        kind: 'attach',
        protocol: REMOTE_PROTOCOL_VERSION,
        deviceId: revoked.device.id,
        token: revoked.token,
      });
      expect(outcome.frame).toMatchObject({ kind: 'attach-refused', code: 'revoked' });
    });

    it('3c. refuses a disallowed Origin at the upgrade, before any frame is read', async () => {
      const outcome = await attach(
        url,
        {
          kind: 'attach',
          protocol: REMOTE_PROTOCOL_VERSION,
          deviceId: active.device.id,
          token: active.token,
        },
        { Origin: 'http://evil.test' },
      );
      // `allowedOrigins: []` above refuses every Origin, so this proves the
      // guard runs before the attach frame is ever inspected — a structured
      // `attach-refused` needs a completed upgrade, and this one never gets
      // one.
      expect(outcome.httpStatus).toBe(403);
    });

    it('4. a forced protocol mismatch names both versions, and sends no frame afterward', async () => {
      const clientProtocol = REMOTE_PROTOCOL_VERSION + 1;
      const messages: Record<string, unknown>[] = [];
      await new Promise<void>((resolve, reject) => {
        const socket = new WebSocket(url);
        socket.on('open', () =>
          socket.send(
            JSON.stringify({
              kind: 'attach',
              protocol: clientProtocol,
              deviceId: active.device.id,
              token: active.token,
            }),
          ),
        );
        socket.on('message', (data) => messages.push(JSON.parse(String(data)) as Record<string, unknown>));
        socket.on('close', () => resolve());
        socket.on('error', reject);
      });

      // Exactly one frame total, even after the socket has fully closed —
      // that is what "no frame follows" means: not merely that the refusal
      // came first, but that nothing else ever arrived.
      expect(messages).toHaveLength(1);
      expect(messages[0]).toMatchObject({ kind: 'attach-refused', code: 'protocol-mismatch' });
      const message = String(messages[0]?.['message']);
      expect(message).toContain(String(REMOTE_PROTOCOL_VERSION));
      expect(message).toContain(String(clientProtocol));
    });

    it('5. refuses a call frame that arrives on an unattached socket', async () => {
      const outcome = await attach(url, {
        kind: 'call',
        id: 'req-1',
        channel: 'config:get',
        payload: {},
      });
      expect(outcome.frame).toMatchObject({ kind: 'attach-refused', code: 'unauthorized' });
    });

    it('6. --pair in a second process is seen by the already-running server, with no restart', async () => {
      // Same `userDataDir` as the already-running `app` — see the header
      // comment's section on why that sharing is load-bearing here.
      const result = await runOneShot(['--pair', 'Live-Device-A'], configPath, userDataDir);
      expect(result.code).toBe(0);

      // The token, then the device id, are the first two of four lines
      // `runPair` prints (`one-shot.ts`) — HIVE-142 review, I5: the attach
      // handshake needs both, and the id used to be readable only inside
      // config.json. Four groups of four Crockford-base32 characters for
      // the token.
      const lines = result.stdout.trim().split('\n');
      expect(lines).toHaveLength(4);
      const token = lines[0] ?? '';
      expect(token).toMatch(/^[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/u);
      const idLine = lines[1] ?? '';
      expect(idLine).toMatch(/^Device id: /);
      const printedId = idLine.replace(/^Device id: /, '');

      // Cross-checked against the config file the one-shot just wrote — the
      // same file the running server's `devices` getter re-reads on every
      // handshake (`file-backed-io.ts`'s `readServerDevicesFromDisk`) — so
      // this proves the printed id is not merely well-shaped but the exact
      // one that was actually persisted.
      const parsed = parseConfig(readFileSync(configPath, 'utf8'), 'config');
      const minted = parsed.server?.devices?.find((device) => device.name === 'Live-Device-A');
      expect(minted).toBeDefined();
      expect(minted?.id).toBe(printedId);
      liveA = { id: printedId, token };

      // The proof itself: attach against the SAME server process that was
      // already listening before `--pair` ever ran, with no restart in
      // between.
      const outcome = await attach(url, {
        kind: 'attach',
        protocol: REMOTE_PROTOCOL_VERSION,
        deviceId: liveA.id,
        token: liveA.token,
      });
      expect(outcome.frame).toMatchObject({ kind: 'attach-accepted' });
    }, 25_000);

    it('9. pairing a second device from the CLI does not erase the first', async () => {
      assert(liveA !== null, 'case 6 must run before case 9 and set liveA');

      const result = await runOneShot(['--pair', 'Live-Device-B'], configPath, userDataDir);
      expect(result.code).toBe(0);
      const lines = result.stdout.trim().split('\n');
      expect(lines).toHaveLength(4);
      const token = lines[0] ?? '';
      const printedId = (lines[1] ?? '').replace(/^Device id: /, '');

      const parsed = parseConfig(readFileSync(configPath, 'utf8'), 'config');
      const devices = parsed.server?.devices ?? [];
      const survivedA = devices.find((device) => device.id === liveA?.id);
      const b = devices.find((device) => device.name === 'Live-Device-B');

      // A's own record is untouched — not merely "a device named
      // Live-Device-A exists somewhere", but the exact id minted for it.
      expect(survivedA).toBeDefined();
      expect(survivedA?.revoked).toBe(false);
      expect(b).toBeDefined();
      expect(b?.id).toBe(printedId);
      liveB = { id: printedId, token };

      // The server, still the same process, still running, still answers for
      // A after B was added — the roster it re-read did not just gain B, it
      // kept A.
      const outcome = await attach(url, {
        kind: 'attach',
        protocol: REMOTE_PROTOCOL_VERSION,
        deviceId: liveA.id,
        token: liveA.token,
      });
      expect(outcome.frame).toMatchObject({ kind: 'attach-accepted' });
    }, 25_000);

    it('7. config.json never contains a literal token, checked against the exact strings the mints printed', () => {
      // Explicit rather than a silent `if (liveA)` — a case-6 (or case-9)
      // failure must fail this assertion too, not quietly drop a third of it
      // (HIVE-142 review, minor 6). Declaration order inside this `describe`
      // already makes 6 and 9 run first; this makes that dependency loud
      // rather than load-bearing-but-invisible.
      assert(liveA !== null, 'case 6 must have run and set liveA before this assertion is meaningful');
      assert(liveB !== null, 'case 9 must have run and set liveB before this assertion is meaningful');

      const text = readFileSync(configPath, 'utf8');
      expect(text).not.toContain(active.token);
      expect(text).not.toContain(revoked.token);
      expect(text).not.toContain(liveA.token);
      expect(text).not.toContain(liveB.token);
      // The digest format the credential is stored as instead — proof the
      // file legitimately describes these four devices, rather than this
      // assertion passing because the file is simply empty. Exact, not a
      // floor: by this point the roster is known completely (active, revoked,
      // A, B), so a fifth or a third digest is just as wrong as zero.
      expect(text).toMatch(/"kind":\s*"sha256"/u);
      expect(text.match(/"digest":\s*"[0-9a-f]{64}"/gu)?.length).toBe(4);
    });
  });

  describe('a config asking for the wildcard bind (spec §8)', () => {
    let dir: string;
    let configPath: string;
    let userDataDir: string;
    let port: number;
    let app: ChildProcess | undefined;
    let appRecord: ProcessRecord | undefined;

    beforeAll(async () => {
      dir = mkdtempSync(join(tmpdir(), 'hive-live-server-wildcard-'));
      configPath = join(dir, 'config.json');
      userDataDir = join(dir, 'user-data');
      assertScratchPath(configPath);
      scratchConfigPaths.push(configPath);

      const booted = await bootServerApp(configPath, userDataDir, (bootPort) => ({
        version: CONFIG_VERSION,
        projects: [],
        server: { bind: { host: '0.0.0.0', port: bootPort, allowedOrigins: [] } },
      }));
      app = booted.child;
      appRecord = booted.record;
      port = booted.port;
      // The health check inside `bootServerApp` already confirms the
      // fallback host (`127.0.0.1`) answers — see case 8b below for why that
      // alone does not yet distinguish a refused wildcard from an honoured
      // one, and for the actual proof.
    }, 90_000);

    afterAll(async () => {
      await stopApp(app);
    }, 15_000);

    it('8. refuses the wildcard bind with a message naming why, and the app keeps running', async () => {
      // The structural half: the same parser `getConfig()` calls at boot
      // refuses `0.0.0.0` and says why — `parse.ts`'s
      // `optionalServerBind`, read back against the exact bytes on disk.
      const parsed = parseConfig(readFileSync(configPath, 'utf8'), 'config');
      expect(
        parsed.errors.some(
          (message) => message.includes('0.0.0.0') && message.includes('binds every interface'),
        ),
      ).toBe(true);
      // Confirms the failure is real refusal, not a bind the parser merely
      // complained about while still honouring it.
      expect(parsed.server?.bind?.host).toBeUndefined();

      // The behavioural half: with `host` refused, the block falls back to
      // `DEFAULT_SERVER.bind.host` (`127.0.0.1`) — the app is still serving
      // on the address it fell back to. This alone does **not** prove the
      // wildcard itself was refused (a bind that genuinely honoured
      // `0.0.0.0` also answers on `127.0.0.1`, since the wildcard includes
      // loopback) — see case 8b for the assertion that actually tells the
      // two apart.
      const status = await httpStatus(`http://127.0.0.1:${String(port)}/`);
      expect(status, `served app's stderr so far:\n${appRecord?.stderr || '(empty)'}`).toBe(426);

      // And the app itself has not gone down over a config error — proved by
      // a second, independent process (the `--devices` one-shot) that
      // reaches the very same file, on the same profile the running app
      // uses.
      expect(app?.exitCode).toBeNull();
      const devices = await runOneShot(['--devices'], configPath, userDataDir);
      expect(devices.code).toBe(0);
    });

    it('8b. the OS-level bind is loopback-only — the socket itself, not a network probe', async () => {
      /*
        Review round 2's finding: an earlier version of this case connected
        from a real non-loopback address on this machine and treated a
        refusal (or a timeout) as proof the wildcard was never bound. That is
        vacuous on macOS by default — the Application Firewall drops an
        inbound SYN to an unsigned/unnotarised binary's listening socket
        whether or not that socket is actually the wildcard, so the exact
        failure this case exists to catch could pass through the same
        silence a correct refusal produces.

        Asking the kernel what the served app's own pid actually holds open
        has no such hole: no packet leaves the machine, no firewall is
        consulted, and `lsof` reports `127.0.0.1:<port>` or `*:<port>`
        exactly, not an inference from how a connection attempt behaved.
      */
      assert(app?.pid !== undefined, 'the served app must have a pid to inspect with lsof');

      const addresses = await listeningAddresses(app.pid);
      console.info(`8b lsof -p ${String(app.pid)} -iTCP -sTCP:LISTEN ->`, addresses);
      const forThisPort = addresses.filter((address) => address.endsWith(`:${String(port)}`));

      expect(
        forThisPort,
        `lsof -p ${String(app.pid)} reported: ${addresses.join(', ') || '(nothing)'}`,
      ).toHaveLength(1);
      // Not merely "not the wildcard" — the exact loopback address the
      // fallback names, so this fails just as loudly if the fallback itself
      // ever changed to some other non-wildcard host.
      expect(forThisPort[0]).toBe(`127.0.0.1:${String(port)}`);
    });

    it('8c. the lsof-based check above genuinely can see a wildcard bind, on this same machine', async () => {
      /*
        A positive control for case 8b's own mechanism, per review: 8b's
        result is a negative ("not found in the list"), and a negative is
        only meaningful if the same check can also return a positive on this
        machine. Rather than relying on network topology (a second interface,
        a firewall's exact posture) the control stays entirely inside this
        process: bind a throwaway `net` server to the real wildcard, in this
        Vitest worker's own pid, and confirm `listeningAddresses` reports it
        as `*:<port>` — proving the parsing in `listeningAddresses` is not
        itself the reason 8b found nothing.
      */
      const probePort = await freePort();
      const probe = createNetServer();
      await new Promise<void>((resolve, reject) => {
        probe.once('error', reject);
        probe.listen(probePort, '0.0.0.0', () => resolve());
      });

      try {
        const addresses = await listeningAddresses(process.pid);
        console.info(`8c lsof -p ${String(process.pid)} -iTCP -sTCP:LISTEN ->`, addresses);
        const forThisPort = addresses.filter((address) => address.endsWith(`:${String(probePort)}`));
        expect(
          forThisPort,
          `lsof -p ${String(process.pid)} reported: ${addresses.join(', ') || '(nothing)'}`,
        ).toHaveLength(1);
        expect(forThisPort[0]).toMatch(/^(\*|0\.0\.0\.0):/u);
      } finally {
        await new Promise<void>((resolve) => probe.close(() => resolve()));
      }
    });
  });

  describe('calls, events and PTY resume over an attached socket (HIVE-143)', () => {
    /** The project this suite's `fs:read-file` and `pty:spawn` cases address. */
    const seededProjectId = 'live-remote';
    /**
     * A no-op bootstrap, and the `; false` is not decoration.
     *
     * `sessionCommand` bootstraps a session as `<claudeCommand> && exit`
     * (`electron/main/sessions/bootstrap.ts`), so a stub that ends cleanly takes
     * the login shell with it and leaves no shell for these cases to type into.
     * Ending badly short-circuits the `&&`. Copied from
     * `tests/e2e/electron/fixtures/hive-app.ts`'s `STUB_CLAUDE_COMMAND`, which
     * carries the same reasoning at length — and, as there, this exists so that
     * a machine with a real `claude` on its PATH does not have one started, in
     * a directory this suite made up, by a socket.
     */
    const stubClaudeCommand = 'true; false';

    let dir: string;
    let configPath: string;
    let userDataDir: string;
    let projectDir: string;
    let outsideDir: string;
    let url: string;
    let app: ChildProcess | undefined;
    let appRecord: ProcessRecord | undefined;
    let device: MintedDevice;

    /** A client that has completed a real handshake, optionally resuming. */
    const attached = async (options: { resumeFrom?: Record<string, number> } = {}): Promise<LiveClient> =>
      openClient(url, { id: device.device.id, token: device.token }, options);

    beforeAll(async () => {
      dir = mkdtempSync(join(tmpdir(), 'hive-live-server-link-'));
      configPath = join(dir, 'config.json');
      userDataDir = join(dir, 'user-data');
      assertScratchPath(configPath);
      scratchConfigPaths.push(configPath);

      /*
        A scratch project, and a scratch directory beside it that is **not**
        inside it. `EOUTSIDE` is unreachable through a `..` path — `assertRelPath`
        refuses a `..` segment at the IPC guard, long before the fs layer — so
        the only way to actually resolve out of a project root is a symlink,
        which `resolveExisting` follows with `realpath` *before* it tests
        containment (`electron/main/fs/paths.ts`). That is what case 12 sends.
      */
      projectDir = mkdtempSync(join(tmpdir(), 'hive-live-server-project-'));
      outsideDir = mkdtempSync(join(tmpdir(), 'hive-live-server-outside-'));
      writeFileSync(join(projectDir, 'README.md'), 'live proof\n', 'utf8');
      writeFileSync(join(outsideDir, 'secret.txt'), 'not yours\n', 'utf8');
      symlinkSync(outsideDir, join(projectDir, 'escape'));

      device = mintDevice('Link-Device');

      const booted = await bootServerApp(configPath, userDataDir, (bootPort) => ({
        version: CONFIG_VERSION,
        // `sh` rather than the developer's own `$SHELL`, for the reason the e2e
        // fixture pins it: zsh and bash differ in prompt behaviour and a suite
        // that passes only on the author's machine is worthless.
        shell: '/bin/sh',
        claudeCommand: stubClaudeCommand,
        projects: [{ id: seededProjectId, name: 'Live Remote', path: projectDir, icon: 'ph-cube' }],
        server: {
          bind: { host: '127.0.0.1', port: bootPort, allowedOrigins: [] },
          devices: [device.device],
        },
      }));
      app = booted.child;
      appRecord = booted.record;
      url = `ws://127.0.0.1:${String(booted.port)}`;
    }, 90_000);

    afterAll(async () => {
      for (const client of liveClients) client.close();
      await stopApp(app);
    }, 20_000);

    it('10. answers config:get over an attached socket', async () => {
      const client = await attached();
      const result = await client.call(CH.configGet, undefined);

      expect(result, `served app's stderr so far:\n${appRecord?.stderr || '(empty)'}`).toMatchObject({
        kind: 'result',
      });
      expect(result).toHaveProperty('payload.projects');
      // Not merely "a projects key": the project this suite seeded, so a
      // snapshot that answered from some other config would fail here.
      const payload = (result as ResultFrame).payload as { projects: { id: string }[] };
      expect(payload.projects.map((project) => project.id)).toContain(seededProjectId);
    }, 30_000);

    it('11. answers github:prs over an attached socket', async () => {
      const client = await attached();
      const result = await client.call(CH.githubPrs, undefined);

      // `gh` may be absent or unauthenticated on the machine running this; what
      // is proved here is that an `execute`-graded channel is reached and
      // answers, not what it answers. `GhResult` is a result either way — the
      // handler reports a missing `gh` as a value, never as a throw.
      expect(result.kind).toBe('result');
    }, 60_000);

    it('12. carries the EOUTSIDE code itself, not a flattened message', async () => {
      const client = await attached();
      const result = await client.call(CH.fsReadFile, {
        projectId: seededProjectId,
        relPath: 'escape/secret.txt',
      });

      /*
        A `result`, not an `error`. `FsResult` refusals are return values — the
        explorer and the editor branch on `error.code`, and a transport that
        turned this into an `error` frame would delete that behaviour while
        still looking like it worked. This assertion is the whole reason
        `ErrorFrame` carries a `code` at all (`remote-contract.ts`).
      */
      expect(result).toMatchObject({
        kind: 'result',
        payload: { ok: false, error: { code: 'EOUTSIDE' } },
      });

      /*
        The other half of the same distinction, on the same channel: a `..`
        path is refused by `assertRelPath` at the IPC guard, which *throws*
        `IpcValidationError` — so it comes back as an `error` frame carrying
        that name, while the containment refusal above comes back as a
        `result`. A transport that collapsed the two would still satisfy one of
        these assertions and never both, which is why both are here rather than
        the first alone.
      */
      const rejected = await client.call(CH.fsReadFile, {
        projectId: seededProjectId,
        relPath: '../../../etc/passwd',
      });
      expect(rejected).toMatchObject({ kind: 'error', code: 'IpcValidationError' });
    }, 30_000);

    it('13. carries ENOENT, the code the editor actually branches on', async () => {
      const client = await attached();
      const result = await client.call(CH.fsReadFile, {
        projectId: seededProjectId,
        relPath: 'no-such-file.txt',
      });

      expect(result).toMatchObject({
        kind: 'result',
        payload: { ok: false, error: { code: 'ENOENT' } },
      });
    }, 30_000);

    it('14. refuses a window-bound channel by name', async () => {
      const client = await attached();
      const result = await client.call(CH.configChooseDirectory, undefined);

      expect(result).toMatchObject({ kind: 'error', code: 'window-bound' });
      expect((result as ErrorFrame).message).toMatch(/HIVE-146/);
    }, 30_000);

    it('15. delivers ledger:changed and agents:changed to the attached client', async () => {
      const client = await attached();
      const seen = client.collectEvents();

      const posted = await client.call(CH.ledgerPost, {
        kind: 'post',
        to: 'overmind',
        body: 'live proof',
      });
      expect(posted.kind).toBe('result');

      await waitFor(
        () => seen().some((frame) => frame.channel === CH.ledgerChanged),
        'a ledger:changed event',
      );
      expect(seen().find((frame) => frame.channel === CH.ledgerChanged)).toMatchObject({
        kind: 'event',
        payload: { body: 'live proof' },
      });

      /*
        The second half of this case's name, and a different mechanism from the
        first: `ledger:changed` is emitted straight from `Ledger.append`'s own
        listener, while `agents:changed` comes from a real `fs.watch` on the
        agents root. `agents:list` first, because that verb is what creates the
        root and binds (or rebinds) that watcher — without it, a fresh profile
        has nothing to watch and the event would never fire.
      */
      const agentSource = (name: string): string =>
        `---\nname: ${name}\ndescription: Proves the fan-out.\nicon: ChatCircleDots\n---\nDo nothing.\n`;
      const changedCount = (): number =>
        seen().filter((frame) => frame.channel === CH.agentsChanged).length;

      const listed = await client.call(CH.agentsList, undefined);
      expect(listed.kind).toBe('result');

      /*
        **Two writes, and the second is the one this case rests on** (review
        round 1, item 1).

        Waiting for "any `agents:changed` since attach" is satisfiable without
        the write emitting anything: `agents:list` above creates the root, and
        creating a watched folder is itself a filesystem event. A pass would
        then be evidence for the watcher having been bound, not for the story's
        claim that `agents:changed` reaches a remote client.

        So the first write drains whatever the root's creation armed, `settled`
        waits for the watcher to go quiet — nothing pending, because an
        announce fires within 120ms of the last event and nothing else touches
        this folder — and only then is the baseline taken. The count moving
        past it can only be the second write, which is the assertion the
        acceptance criterion actually wants.
      */
      const first = await client.call(CH.agentsWrite, {
        name: 'live-proof',
        source: agentSource('live-proof'),
      });
      expect(first).toMatchObject({ kind: 'result', payload: { ok: true } });
      await waitFor(() => changedCount() >= 1, 'a first agents:changed');
      await settled(changedCount, 'the agents watcher');

      const baseline = changedCount();
      const second = await client.call(CH.agentsWrite, {
        name: 'live-proof-two',
        source: agentSource('live-proof-two'),
      });
      expect(second).toMatchObject({ kind: 'result', payload: { ok: true } });
      await waitFor(
        () => changedCount() > baseline,
        `an agents:changed past the baseline of ${String(baseline)}, caused by the second write`,
      );

      /*
        There is nothing in the frame to identify *which* write it announces —
        `agents:changed` is emitted with no payload at all (`ipc/index.ts`'s
        `fanOut.emit(CH.agentsChanged, undefined)`), and `JSON.stringify` drops
        an `undefined` value's key rather than writing `null`. That absence is
        itself worth pinning: it is the absent-versus-empty distinction
        `socket-broadcaster.ts` argues for, and a broadcaster that started
        substituting `null` would invent a value the local push never had.
      */
      measurements.push({
        case: '15. agents:changed past a baseline',
        baselineAfterFirstWrite: baseline,
        countAfterSecondWrite: changedCount(),
      });

      const announced = seen().find((frame) => frame.channel === CH.agentsChanged);
      expect(announced).toMatchObject({ kind: 'event', channel: CH.agentsChanged });
      expect(announced).not.toHaveProperty('payload');
    }, 90_000);

    /*
      JSON framing overhead, measured 2026-09-08 on this repo's dev machine
      (macOS 25.6.0, arm64, the built app from `pnpm desktop:build`): **4.9%**
      over raw chunk bytes, at `BATCH_FLUSH_BYTES`-sized batches. Taken from
      case 17's own flood, and from **that session alone** — 13 `pty:data`
      frames, 881,320 bytes of JSON text off the socket against 840,127 bytes of
      `chunk` inside them — and re-recorded into `finding.json` on every run
      rather than trusted from this comment.

      The per-session filter is why this is a claim about the flood rather than
      about a socket: a socket sees every session the server is running, and
      case 16's shell lives on the same server. It happens to be idle by the
      time case 17 runs, so the filter did not move this figure — the point is
      that the number no longer depends on that being true.

      Where it goes, because the split is the whole argument: the frame envelope
      (`{"kind":"event","channel":"pty:data","payload":{"sessionId":…,"seq":…}}`)
      is ~90 bytes per frame, so at 64 KiB batches it is under 0.2% and is
      *not* what this number is made of. Essentially all of it is JSON string
      escaping — this flood is 20,000 CRLF-terminated lines, and `\r` and `\n`
      each cost two bytes instead of one, which is 40,000 of the 41,193-byte
      difference on its own, and the remaining ~1,200 is the 13 envelopes.

      The design left a binary frame for `pty:data` open "only if measurement
      says so". This measurement does not say so: 4.9% on a 64 KiB batch is
      cheaper than the second wire format, the second decode path and the
      `REMOTE_PROTOCOL_VERSION` bump that a binary frame would cost.

      What it honestly does not settle is the content it did not measure. The
      overhead is a property of the *bytes*, not of the transport: a TUI
      redrawing itself emits ESC (0x1b), which JSON escapes to a six-character
      backslash-u-0-0-1-b sequence — six bytes for one — so an escape-dense
      stream costs more than this one by an amount this flood cannot tell you.
      If a later story measures that and finds it material, a binary `pty:data`
      is its own story with its own protocol bump, not a late addition to this
      one.
    */

    it('16. resumes a killed socket mid-output with the transcript whole', async () => {
      const client = await attached();
      const sessionId = await client.spawnSession(seededProjectId, 'live-resume');
      /*
        A line every ~10ms rather than the tightest loop that would print 400
        lines, because the tightest loop is not a test of resume at all: 400
        `echo`s finish inside one 8ms batch window (`BATCH_INTERVAL_MS`) and
        arrive as one or two `pty:data` frames, so there is no output still in
        flight for the reconnect to be in the middle of. This is a delay inside
        the *shell*, to make a stream long enough to interrupt; every wait in
        this file is still a polled condition with a loud timeout.

        Written without waiting for the bootstrap: main holds input for a
        session whose bootstrap is still pending and releases it, in order, once
        the bootstrap completes (`sessions/index.ts`'s `heldInput`).
      */
      client.notify(CH.ptyWrite, {
        sessionId,
        data: 'i=1; while [ $i -le 400 ]; do echo line-$i; i=$((i+1)); sleep 0.01; done\r',
      });

      const before = await client.collectPtyUntil(sessionId, /line-50\b/);
      const lastSeq = before.at(-1)!.seq;
      client.kill();

      /*
        A witness socket, attached with no `resumeFrom`, which exists only to
        prove the stream really moved on while the resuming client was away.

        Without it this case has a hole: a reconnect fast enough to have missed
        nothing satisfies `after[0].seq === lastSeq + 1` with the replay ring
        never consulted, and the assertion below would be about the reconnect's
        latency rather than about resume. Five live frames after the break puts
        the stream at `lastSeq + 5` or beyond, so the frame the resuming client
        is handed at `lastSeq + 1` can only have come out of the ring — it was
        flushed before that socket existed.
      */
      const witness = await attached();
      const witnessLastSeq = (await witness.collectPtyCount(sessionId, 5)).at(-1)!.seq;
      witness.kill();
      expect(witnessLastSeq).toBeGreaterThan(lastSeq + 1);

      const resumed = await attached({ resumeFrom: { [sessionId]: lastSeq } });
      const after = await resumed.collectPtyUntil(sessionId, /line-400\b/);
      measurements.push({
        case: '16. resume across a killed socket',
        lastSeqBeforeKill: lastSeq,
        seqReachedWhileAway: witnessLastSeq,
        firstSeqAfterResume: after[0]?.seq,
        framesAfterResume: after.length,
      });

      // Contiguous across the break: the first frame after resume is the next
      // seq, and no seq is missing or repeated.
      expect(after[0]!.seq).toBe(lastSeq + 1);
      const seqs = after.map((event) => event.seq);
      expect(seqs).toEqual(seqs.map((_, index) => seqs[0]! + index));

      const transcript = [...before, ...after].map((event) => event.chunk).join('');
      for (const n of [1, 200, 400]) expect(transcript).toContain(`line-${String(n)}`);
    }, 120_000);

    it('17. leaves a seq discontinuity when the gap is forced past the ring', async () => {
      const client = await attached();
      const sessionId = await client.spawnSession(seededProjectId, 'live-gap');
      // `%s` so the marker exists only in the *output*: the pty echoes what is
      // typed, so a literal `READY-MARK` in the command line would match this
      // pattern against the echo rather than against anything the shell ran.
      client.notify(CH.ptyWrite, { sessionId, data: "printf 'READY-%s\\n' MARK\r" });
      const lastSeq = (await client.collectPtyUntil(sessionId, /READY-MARK/)).at(-1)!.seq;
      client.kill();

      /*
        More than `REPLAY_BYTES` of output past `lastSeq`, while the socket that
        holds `lastSeq` is gone.

        Driven and observed over a **second** socket, which is not a hedge: a
        `pty:write` has to reach the app over some socket, and the only way to
        know the ring has actually overrun — rather than to sleep and hope — is
        for something to count the bytes that crossed it. The ring is per
        session, not per socket (`ipc/pty.ts`'s `Channel.replay`), so what the
        flood client saw changes nothing about what the resuming client is owed:
        it is a different connection, holding a seq from before the flood began.
      */
      const flood = await attached();
      flood.notify(CH.ptyWrite, {
        sessionId,
        data: "yes 0123456789012345678901234567890123456789 | head -n 20000\r",
      });
      await flood.collectPtyBytes(sessionId, REPLAY_BYTES * 2, 120_000);
      // This session alone: case 16's shell is still alive on the same server,
      // and its trickle is not part of a claim about this flood.
      const traffic = flood.ptyTraffic(sessionId);
      measurements.push({
        case: '17. gap forced past the ring',
        sessionId,
        ptyDataFrames: traffic.frames,
        wireBytes: traffic.wireBytes,
        chunkBytes: traffic.chunkBytes,
        overheadPercent: Number(
          (((traffic.wireBytes - traffic.chunkBytes) / traffic.chunkBytes) * 100).toFixed(2),
        ),
        replayBytes: REPLAY_BYTES,
      });
      flood.kill();

      const resumed = await attached({ resumeFrom: { [sessionId]: lastSeq } });
      /*
        The resuming client is sent **nothing** for a gap — no transcript, by
        design (`ipc/pty.ts`'s `ResumeResult`) — so the discontinuity only
        becomes observable on the next live batch. This is that batch.
      */
      resumed.notify(CH.ptyWrite, { sessionId, data: "printf 'DONE-%s\\n' MARK\r" });
      const after = await resumed.collectPtyUntil(sessionId, /DONE-MARK/);
      measurements.push({
        case: '17. seqs across the forced gap',
        lastSeqBeforeKill: lastSeq,
        firstSeqAfterResume: after[0]?.seq,
      });

      // A discontinuity is what the renderer's existing gap notice keys on
      // (`src/lib/terminal/pty-transport.ts`).
      expect(after[0]!.seq).not.toBe(lastSeq + 1);
      expect(after[0]!.seq).toBeGreaterThan(lastSeq + 1);
    }, 180_000);
  });
});
