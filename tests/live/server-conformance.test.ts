// @vitest-environment node
import assert from 'node:assert/strict';
import { execFile, spawn, type ChildProcess } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { get as httpGet } from 'node:http';
import { createRequire } from 'node:module';
import { connect as netConnect, createServer as createNetServer, type Socket } from 'node:net';
import { homedir, hostname, tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { promisify } from 'node:util';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';

import { parseConfig } from '../../electron/main/config/parse';
import { mintDevice, type MintedDevice } from '../../electron/main/server/devices';
import {
  CONFIG_PATH_ENV,
  CONFIG_VERSION,
  type BrowseListing,
  type ConfigSnapshot,
  type RemoteConfig,
  type SetRemoteResult,
} from '../../electron/shared/config-contract';
import { HOOK_PATH } from '../../electron/shared/hook-contract';
import {
  CH,
  REPLAY_BYTES,
  type AppInfo,
  type Channel,
  type DataEvent,
  type NotificationReadEvent,
  type RemoteLinkStatus,
} from '../../electron/shared/ipc-contract';
import { type HiveNotification } from '../../electron/shared/notification-contract';
import {
  CALL_DEADLINE_MS,
  CALL_TIMEOUT_CODE,
  REMOTE_PROTOCOL_VERSION,
  SNAPSHOT_CHANNELS,
  type AttachRequest,
  type ClientFrame,
  type ErrorFrame,
  type EventFrame,
  type ResultFrame,
  type ResumePoint,
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
 * 14. `config:choose-directory` is refused `window-bound`, naming the browse
 *     channel that replaced it.
 * 26. `config:browse-directory` answers a real listing of the answering
 *     machine’s home, contained, over the socket (HIVE-146).
 * 27. A path outside that home is refused `EOUTSIDE` as a `result` frame, not
 *     an `error` — the shape cases 12 and 13 established for the fs verbs.
 * 29. A hand-built `remote:forget` is refused `remote-refused`, and the
 *     server's own credential file survives it byte for byte (HIVE-155): the
 *     receiving half of the fence `PROCESS_LOCAL` puts on the sender.
 * 15. `ledger:changed` and `agents:changed` reach the attached client.
 * 16. A socket killed mid-output resumes contiguously, transcript whole.
 * 17. A gap forced past `REPLAY_BYTES` is marked on attach by one empty
 *     `pty:data` at the head seq — the discontinuity the renderer's existing
 *     gap notice keys on (`src/lib/terminal/pty-transport.ts`, asserted at
 *     `tests/lib/terminal/pty-transport.test.ts:463` and not duplicated here),
 *     delivered without waiting for output that an idle session never sends.
 *
 * ## The full flip: HIVE-144's five live cases
 *
 * HIVE-144 turns the link into a **second app**. Tasks 1-14 unit-tested every
 * piece of that; these five are the acceptance criteria no unit test can
 * reach, because each is a property of two real OS processes rather than of a
 * module:
 *
 * 18. A session **restarted while a client was away** answers `gap`, not a
 *     contiguous replay. This is the blocking bug the ticket was written
 *     around: `registry.open()` mints pty session ids from a *global*
 *     counter while seq numbers restart at 0 per session, so a `resumeFrom`
 *     carrying a bare seq handed a reattaching client the **new**
 *     generation's batches numbered contiguously and its gap detector raised
 *     nothing — silent data loss that looked like success. The fixture makes
 *     the two generations' heads deliberately **far apart** (a slow 30-line
 *     loop on gen 1, a single line on gen 2), because a fixture where both
 *     rings happen to sit at the same head cannot tell the fix from the bug.
 * 19. An `attach-accepted` carries a **populated** snapshot — the six
 *     `SNAPSHOT_CHANNELS` read against a server that has a project, a
 *     ledger and live sessions, not an empty object that would satisfy
 *     "has a `snapshot` key".
 * 20. A **v1** client — a genuinely older build, not `VERSION + 1` — is
 *     refused `protocol-mismatch` and gets no frame afterwards.
 * 21. **Two real built apps.** One serves; the other boots with a window,
 *     is handed a credential minted by the first, and flips itself into
 *     remote mode through the very IPC channel that switch unbinds. Driven
 *     through the client's own renderer over the Chrome DevTools Protocol —
 *     see {@link openRenderer} for why that, and not a second `ws` client,
 *     is the only surface that can observe Rulings 24 and 28 at all. Then it
 *     flips back: 21g asserts the detach lands on *this* window and leaves
 *     the server's config byte-for-byte alone — the direct inverse of the
 *     defect this task found, where a detach was proxied to the server and a
 *     client could enter remote mode and never leave it.
 * 22. A call that never settles is answered `call-timeout` at
 *     `CALL_DEADLINE_MS`. See {@link deadlineCall} for how that two-minute
 *     wait is paid for by the rest of the file rather than added to it.
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

/** A loopback TCP relay in front of a served app, see {@link openRelay}. */
interface Relay {
  port: number;
  /** Destroys every connection through the relay, both halves, and keeps listening. Answers how many it cut. */
  cut(): number;
  close(): Promise<void>;
}

/**
 * A loopback TCP relay in front of the served app, whose connections a case
 * can cut without touching either end (HIVE-160).
 *
 * Case 21k drops a client by killing the server, which takes every session on
 * it down too. A case that needs a session to **outlive** the drop, so the
 * returning client can be asked what it is watching, needs the socket to die
 * on its own. This is the shape a network blip actually has: both processes
 * alive, the TCP connection gone.
 *
 * Plain byte piping, no parsing. The server's guard compares only the host
 * part of `Host` (`http-guard.ts`), so `127.0.0.1:<relay port>` is admitted
 * exactly as the served port would be, and a `ws` client sends no `Origin`.
 */
async function openRelay(targetPort: number): Promise<Relay> {
  const pairs = new Set<{ inbound: Socket; outbound: Socket }>();
  const server = createNetServer((inbound) => {
    const outbound = netConnect({ host: '127.0.0.1', port: targetPort });
    const pair = { inbound, outbound };
    pairs.add(pair);
    const drop = (): void => {
      pairs.delete(pair);
      inbound.destroy();
      outbound.destroy();
    };
    inbound.on('error', drop);
    outbound.on('error', drop);
    inbound.on('close', drop);
    outbound.on('close', drop);
    inbound.pipe(outbound);
    outbound.pipe(inbound);
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('could not determine the relay port');
  }

  const cut = (): number => {
    const count = pairs.size;
    for (const { inbound, outbound } of [...pairs]) {
      inbound.destroy();
      outbound.destroy();
    }
    pairs.clear();
    return count;
  };

  return {
    port: address.port,
    cut,
    close: () =>
      new Promise((resolve) => {
        cut();
        server.close(() => resolve());
      }),
  };
}

/**
 * A live session's hook credential, read out of its own pty — the only place
 * it is ever written down.
 *
 * `HIVE_RECEIVER_URL` is the bare origin (`envFor` hands the MCP host
 * `running.origin`), so the hook route is appended by {@link raiseBlocked},
 * and it works against whatever loopback port the server bound.
 */
async function hookEnvOf(
  client: LiveClient,
  sessionId: string,
): Promise<{ receiverOrigin: string; hookToken: string }> {
  client.notify(CH.ptyWrite, {
    sessionId,
    data: "printf 'HOOKENV=%s=%s\\n' \"$HIVE_RECEIVER_URL\" \"$HIVE_HOOK_TOKEN\"\r",
  });
  const envChunk = (await client.collectPtyUntil(sessionId, /HOOKENV=\S+=[0-9a-f]{64}/))
    .map((frame) => frame.chunk)
    .join('');
  const env = /HOOKENV=(\S+?)=([0-9a-f]{64})/.exec(envChunk);
  assert(env !== null, 'the session carries HIVE_RECEIVER_URL and HIVE_HOOK_TOKEN');
  const [, receiverOrigin, hookToken] = env;
  return { receiverOrigin, hookToken };
}

/** Raises a `PermissionRequest` for `sessionId` through the real hook receiver: a `session.blocked` row. */
function raiseBlocked(
  env: { receiverOrigin: string; hookToken: string },
  sessionId: string,
  toolUseId: string,
): Promise<Response> {
  return fetch(`${env.receiverOrigin}${HOOK_PATH}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-hive-session': sessionId,
      'x-hive-token': env.hookToken,
    },
    body: JSON.stringify({
      hook_event_name: 'PermissionRequest',
      session_id: sessionId,
      tool_use_id: toolUseId,
      tool_name: 'Bash',
      tool_input: { command: 'true' },
    }),
  });
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
  /**
   * `refusing` boots a server whose config refused its bind host (HIVE-140
   * audit, gap 3): it must come up running and listening *nowhere*, so there is
   * no socket to health-check. Ready is its one log line saying so.
   */
  expect: 'listening' | 'refusing' = 'listening',
): Promise<BootedApp> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    const port = await freePort();
    writeFileSync(configPath, JSON.stringify(buildConfig(port), null, 2), 'utf8');
    const { child, record } = spawnApp(['--server'], configPath, userDataDir);
    if (expect === 'refusing') {
      const deadline = Date.now() + 30_000;
      while (!record.stderr.includes('server mode is not listening') && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
      if (record.stderr.includes('server mode is not listening')) return { child, record, port };
      await stopApp(child);
      throw new Error(`the refusing server never said so. stderr:\n${record.stderr || '(empty)'}`);
    }
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
/**
 * The byte count for a session once it has stopped moving (HIVE-145).
 *
 * A paused producer is proved by a plateau, not by a single reading: the pause
 * happens when the unacked window crosses the high-water mark, which is a few
 * batches after the flood starts, and asserting before that would measure a
 * stream that simply had not got there yet.
 */
async function settledBytes(client: LiveClient, sessionId: string): Promise<number> {
  let last = -1;
  for (let stable = 0; stable < 8; ) {
    await delay(250);
    const now = client.ptyBytes(sessionId);
    stable = now === last ? stable + 1 : 0;
    last = now;
  }
  return last;
}

async function waitFor(predicate: () => boolean, what: string, timeoutMs = 30_000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (predicate()) return;
    await delay(25);
  }
  throw new Error(`timed out after ${String(timeoutMs)}ms waiting for ${what}`);
}

/**
 * {@link waitFor} for a condition that has to be *asked for* (HIVE-150).
 *
 * Its own function rather than a widened `waitFor`: every existing caller polls
 * a value this process already holds, at 25ms, and each of those polls is free.
 * This one is a CDP round trip into another process's renderer, so it polls
 * far more slowly and tolerates a throw — a window mid-reload answers by
 * failing, and that is a "not yet", not a fault.
 */
async function waitForAsync(
  predicate: () => Promise<boolean>,
  what: string,
  timeoutMs = 60_000,
): Promise<void> {
  const start = Date.now();
  let lastError: unknown;
  while (Date.now() - start < timeoutMs) {
    try {
      if (await predicate()) return;
      lastError = undefined;
    } catch (cause) {
      lastError = cause;
    }
    await delay(250);
  }
  throw new Error(
    `timed out after ${String(timeoutMs)}ms waiting for ${what}` +
      (lastError === undefined ? '' : ` (last attempt threw: ${String(lastError)})`),
  );
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
 * `work`, or a failure naming `what` if it has not settled in `timeoutMs`.
 *
 * The bound is part of the assertion wherever this is used, not a convenience
 * (HIVE-144, Task 10's review): `config:set-remote` unbinds the channel it is
 * answering on, and the failure that leaves is a **hang** — which is
 * indistinguishable from a slow dial without a bound to tell them apart. The
 * timer is cleared on the winning path rather than left to run out, so a
 * settled case does not hold the event loop open for the length of its own
 * unused patience.
 */
async function bounded<T>(work: Promise<T>, timeoutMs: number, what: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error(`${what} did not settle within ${String(timeoutMs)}ms`)),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/** A plain `GET` whose body is parsed as JSON — the DevTools target list, and nothing else. */
function getJson(url: string): Promise<unknown> {
  return new Promise((resolve, reject) => {
    httpGet(url, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk: string) => (body += chunk));
      res.on('end', () => {
        try {
          resolve(JSON.parse(body));
        } catch (cause) {
          reject(cause instanceof Error ? cause : new Error(String(cause)));
        }
      });
    }).on('error', reject);
  });
}

/**
 * `expression`, run inside a real window of a real app, answering the value
 * it resolves to (HIVE-144, case 21).
 *
 * `close()` drops the DevTools socket. It does not stop the app — the caller
 * owns that, through {@link stopApp}, exactly as it does for every other
 * process this file spawns.
 */
interface RendererDriver {
  evaluate<T>(expression: string): Promise<T>;
  close(): void;
}

/**
 * Attaches to a spawned app's **renderer** over the Chrome DevTools Protocol,
 * so a case can call `window.hive.*` the way the app's own UI does (HIVE-144).
 *
 * ## Why this, and not a second `ws` client
 *
 * Every other case in this file reaches the app through its *server* socket,
 * which `remote-host/listener.ts` dispatches into `remoteRegistry` — the
 * registry `registerIpcHandlers` fills. That surface is deliberately **not**
 * `ipcMain`, and the whole of HIVE-144 lives on `ipcMain`: `config:set-remote`
 * unbinds the channel it is answering on there, `registerRemoteProxy` rebinds
 * those same channel names against a socket there, and Ruling 24's three
 * `PROCESS_LOCAL` channels are the ones that keep answering locally *there*
 * while everything beside them is proxied. A `ws` client cannot see any of it.
 * The renderer is the only caller that can, because it is the only caller
 * `ipcMain` has — which is precisely why "a second app attaches" was left as a
 * live case rather than folded into `remote-composition.test.ts`.
 *
 * ## Why the app is safe to drive this way
 *
 * `--remote-debugging-port` is a Chromium switch; `parseInvocation`
 * (`electron/main/cli.ts`) walks argv looking for exactly four of its own
 * flags and ignores everything else, which its own doc comment states as a
 * property rather than an accident. Nothing about the app's behaviour changes
 * — this opens a viewer onto the window it was already going to open.
 *
 * Polls the target list rather than sleeping, for {@link waitForListener}'s
 * reason: the window appears when the renderer has loaded, which is a
 * different amount of time on a cold filesystem than on a warm one.
 */
async function openRenderer(debugPort: number, what: string): Promise<RendererDriver> {
  const driver = await openCdpTarget(
    debugPort,
    what,
    (candidate) => candidate.type === 'page' && (candidate.url ?? '').includes('index.html'),
    {},
  );

  /*
    The page target exists before `contextBridge` has run, so the first
    `evaluate` can land on a window with no `window.hive` on it at all —
    measured, as `TypeError: Cannot read properties of undefined (reading
    'config')`, on the very first run of case 21a. Polled rather than slept
    on for {@link waitForListener}'s reason, and waited for **here** rather
    than in each case, so no case has to remember: a driver handed back by
    this function has a bridge behind it.
  */
  const bridgeStart = Date.now();
  while (Date.now() - bridgeStart < 60_000) {
    if ((await driver.evaluate<string>('typeof window.hive')) === 'object') return driver;
    await delay(100);
  }
  throw new Error(`${what} loaded a window, but window.hive never appeared on it`);
}

/**
 * The same driver onto a spawned app's **main process**, over the Node
 * inspector its `--inspect` flag opens (HIVE-160).
 *
 * For the one thing no renderer can reach: what `BrowserWindow.isFocused()`
 * answers. A client whose window is not in front reports `focused: false` on
 * every foreground report — correctly, and fatally for a case that needs it
 * watching (case 21m). `includeCommandLineAPI` is what puts `require` in scope, so an
 * expression can reach `electron`'s `app` and `BrowserWindow`.
 */
function openMainProcess(inspectPort: number, what: string): Promise<RendererDriver> {
  return openCdpTarget(inspectPort, what, (candidate) => candidate.type === 'node', {
    includeCommandLineAPI: true,
  });
}

interface DevToolsTarget {
  type?: string;
  url?: string;
  webSocketDebuggerUrl?: string;
}

async function openCdpTarget(
  debugPort: number,
  what: string,
  pick: (candidate: DevToolsTarget) => boolean,
  evaluateParams: Record<string, unknown>,
): Promise<RendererDriver> {
  let target: DevToolsTarget | undefined;
  const start = Date.now();
  while (Date.now() - start < 60_000) {
    try {
      const listed = (await getJson(`http://127.0.0.1:${String(debugPort)}/json/list`)) as DevToolsTarget[];
      target = listed.find(
        (candidate) => typeof candidate.webSocketDebuggerUrl === 'string' && pick(candidate),
      );
      if (target !== undefined) break;
    } catch {
      // The debugging port is not up yet, or the app has not created a window.
    }
    await delay(200);
  }
  if (target?.webSocketDebuggerUrl === undefined) {
    throw new Error(`timed out waiting for ${what} to expose a CDP target on port ${String(debugPort)}`);
  }

  const socket = new WebSocket(target.webSocketDebuggerUrl, { maxPayload: 64 * 1024 * 1024 });
  await new Promise<void>((resolve, reject) => {
    socket.once('open', () => resolve());
    socket.once('error', reject);
  });

  interface CdpAnswer {
    id?: number;
    result?: {
      result?: { value?: unknown };
      exceptionDetails?: { text?: string; exception?: { description?: string } };
    };
    error?: { message?: string };
  }

  let nextId = 0;
  const pending = new Map<number, (answer: CdpAnswer) => void>();
  socket.on('message', (data) => {
    const answer = JSON.parse(String(data)) as CdpAnswer;
    if (answer.id === undefined) return;
    const waiting = pending.get(answer.id);
    pending.delete(answer.id);
    waiting?.(answer);
  });
  // Registered for the reason `openClient` registers one: an `'error'` with no
  // listener throws out of the emitter and takes the Vitest worker with it.
  socket.on('error', (cause) => {
    console.error(`[live] ${what} CDP socket error:`, cause.message);
  });

  const driver: RendererDriver = {
    async evaluate<T>(expression: string): Promise<T> {
      nextId += 1;
      const id = nextId;
      const answer = await new Promise<CdpAnswer>((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error(`${what} never answered CDP evaluate: ${expression}`));
        }, 60_000);
        pending.set(id, (settled) => {
          clearTimeout(timer);
          resolve(settled);
        });
        socket.send(
          JSON.stringify({
            id,
            method: 'Runtime.evaluate',
            params: { expression, awaitPromise: true, returnByValue: true, ...evaluateParams },
          }),
        );
      });

      if (answer.error !== undefined) {
        throw new Error(`${what} refused CDP evaluate (${answer.error.message ?? '?'}): ${expression}`);
      }
      const thrown = answer.result?.exceptionDetails;
      if (thrown !== undefined) {
        throw new Error(
          `${what} threw evaluating \`${expression}\`: ` +
            `${thrown.exception?.description ?? thrown.text ?? 'unknown'}`,
        );
      }
      return answer.result?.result?.value as T;
    },
    close() {
      if (socket.readyState === WebSocket.OPEN) socket.close();
      else socket.terminate();
    },
  };

  return driver;
}

/**
 * A stand-in for `claude` that **hangs** on a `-p` headless run and on nothing
 * else, written to `dir` and answered as an absolute path (HIVE-144, case 22).
 *
 * Two behaviours, both load-bearing:
 *
 * - `-p …` sleeps past `CALL_DEADLINE_MS`. That argv belongs to `slack:test`,
 *   whose `probeSlack` runs `claude -p …` under a **three-minute** timeout
 *   (`SLACK_PROBE_TIMEOUT_MS`) and, unlike `slack:sign-in`, without a
 *   controlling terminal. `slack:sign-in` was the obvious candidate — it is
 *   one of the two channels `CALL_DEADLINE_MS`'s own doc comment names — and
 *   it does not work here: it goes through `/usr/bin/script`, which needs a
 *   tty this suite's spawned app does not have (`script: tcgetattr/ioctl:
 *   Operation not supported on socket`, measured). `slack:test` reaches the
 *   same runner with the same 'a handler can simply not settle' shape and no
 *   tty in the way. The `sleep` is bounded, and deliberately shorter than that
 *   three-minute timeout: a stray child of a killed app reaps itself, and
 *   nothing here depends on which of the two bounds would have won.
 * - Anything else exits **non-zero**, which is what lets the same script stand
 *   in as `claudeCommand` for a pty bootstrap. `sessionCommand` builds
 *   `<claudeCommand> && exit` (`electron/main/sessions/bootstrap.ts`), so a
 *   stub that ended cleanly would take the login shell with it — the identical
 *   reasoning behind `stubClaudeCommand`'s `; false` below.
 *
 * As with that stub, this exists so that a machine with a real `claude` on its
 * PATH never has one started by this suite.
 */
function writeStubClaude(dir: string): string {
  const path = join(dir, 'stub-claude');
  writeFileSync(
    path,
    [
      '#!/bin/sh',
      '# Live-suite stand-in for `claude`. See writeStubClaude in',
      '# tests/live/server-conformance.test.ts.',
      'if [ "$1" = "-p" ]; then exec sleep 170; fi',
      'exit 1',
      '',
    ].join('\n'),
    { encoding: 'utf8', mode: 0o755 },
  );
  return path;
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
  /**
   * Send a `call` frame with a fresh id; resolve its `result` or `error`.
   *
   * `timeoutMs` is this *client's* patience and has nothing to do with
   * `CALL_GIVE_UP_MS` — a raw `ws` client is not `RemoteClient`. It is a
   * parameter only because case 22 waits on the server's own
   * `CALL_DEADLINE_MS`, which is longer than any other call here should ever
   * take; every other caller takes the default and a call that outruns it is
   * a failure, not a wait.
   */
  call(channel: Channel, payload: unknown, timeoutMs?: number): Promise<ResultFrame | ErrorFrame>;
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
  /** Total `chunk` bytes seen for `sessionId` right now (HIVE-145). */
  ptyBytes(sessionId: string): number;
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
  options: {
    resumeFrom?: Record<string, ResumePoint>;
    /**
     * Keep this socket out of {@link liveClients}, so the HIVE-143 block's own
     * `afterAll` — which closes every client in that array — cannot close it
     * (HIVE-144, case 22). Case 22's call has to still be outstanding on an
     * **open** socket when its deadline fires two minutes later: the server
     * checks `readyState` before sending the timeout frame, so a socket closed
     * by an unrelated block's teardown would make that case wait its full
     * patience for an answer that is never sent. The one caller that passes
     * this closes the socket itself.
     */
    unmanaged?: boolean;
    /**
     * Ack this many `pty:data` frames per session, then go quiet — a
     * deliberately stalled consumer (HIVE-145).
     *
     * The flow-control window follows the **slowest** surface *watching* a
     * session, and a surface enrols by acking: a client that never acked at all
     * is one whose user has not opened that session, and gating on it would
     * freeze the session for the person who has. So a stalled client has to ack
     * at least once before it can hold anything — which is also what a real one
     * does, since its renderer acks each batch as xterm parses it and only
     * stops when the link or the renderer does.
     */
    stallAfter?: number;
  } = {},
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
    if (options.stallAfter !== undefined && counted.frames > options.stallAfter) return;
    send({ kind: 'notify', channel: CH.ptyAck, payload: { sessionId: event.sessionId, seq: event.seq } });
  });

  await attached;

  const forSession = (sessionId: string): DataEvent[] =>
    ptyEvents.filter((event) => event.sessionId === sessionId);
  const bytesFor = (sessionId: string): number =>
    forSession(sessionId).reduce((total, event) => total + Buffer.byteLength(event.chunk), 0);

  const client: LiveClient = {
    call(channel, payload, timeoutMs = 60_000) {
      nextCallId += 1;
      const id = `live-${String(nextCallId)}`;
      return new Promise((resolve, reject) => {
        const callTimer = setTimeout(() => {
          pending.delete(id);
          reject(new Error(`call ${channel} (${id}) was never answered`));
        }, timeoutMs);
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

    ptyBytes: (sessionId) => bytesFor(sessionId),

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

  if (options.unmanaged !== true) liveClients.push(client);
  return client;
}

/**
 * Case 22's call, fired at the very top of the run and collected at the very
 * bottom (HIVE-144).
 *
 * ## Why the deadline is not a two-minute wait
 *
 * `CALL_DEADLINE_MS` is 120s and is a hard-coded constant with no seam — no
 * env override, no injectable clock, and the process that owns the timer is a
 * separate OS process, so neither Vitest's fake timers nor anything else this
 * file can reach makes it fire sooner. A case that issued the call and then
 * waited would add two minutes of dead time to every run.
 *
 * It does not have to. The deadline is wall-clock, and this file already
 * spends far more than two minutes of wall clock booting four Electron apps,
 * flooding a pty past `REPLAY_BYTES` and restarting a session. So the call is
 * issued from the outermost `beforeAll`, against an app of its own, and
 * awaited by the last case in the file: the timer runs *underneath* every
 * other case rather than after them. `startedAt` is recorded so the case can
 * assert the answer really took `CALL_DEADLINE_MS` — an answer that arrived
 * early would be some other error wearing the same code, and the elapsed
 * assertion is what tells those apart.
 */
interface DeadlineRun {
  app: ChildProcess | undefined;
  client: LiveClient;
  startedAt: number;
  answer: Promise<ResultFrame | ErrorFrame>;
}

let deadlineRun: DeadlineRun | null = null;

describe.skipIf(!RUN)('server mode, against a real built app (HIVE-142)', () => {
  let evidenceDir: string;

  beforeAll(async () => {
    if (!existsSync(MAIN_ENTRY)) {
      throw new Error(`${MAIN_ENTRY} is missing. Run \`pnpm desktop:build\` before \`pnpm test:server\`.`);
    }
    evidenceDir = mkdtempSync(join(tmpdir(), 'hive-live-server-evidence-'));

    /*
      Case 22's clock starts here — see {@link DeadlineRun} for why it is
      started at the top of the file and collected at the bottom rather than
      inside the case that asserts on it. Its own app, its own config and its
      own device: `slack:test` needs a `claudeCommand` that resolves to a
      single executable (`resolveClaude`), and the HIVE-143 block's
      `stubClaudeCommand` is a shell fragment that deliberately does not.
    */
    const dir = mkdtempSync(join(tmpdir(), 'hive-live-server-deadline-'));
    const configPath = join(dir, 'config.json');
    const userDataDir = join(dir, 'user-data');
    assertScratchPath(configPath);
    scratchConfigPaths.push(configPath);
    const device = mintDevice('Deadline-Device');

    const booted = await bootServerApp(configPath, userDataDir, (bootPort) => ({
      version: CONFIG_VERSION,
      shell: '/bin/sh',
      claudeCommand: writeStubClaude(dir),
      projects: [],
      server: {
        bind: { host: '127.0.0.1', port: bootPort, allowedOrigins: [] },
        devices: [device.device],
      },
    }));

    const client = await openClient(
      `ws://127.0.0.1:${String(booted.port)}`,
      { id: device.device.id, token: device.token },
      { unmanaged: true },
    );
    deadlineRun = {
      app: booted.child,
      client,
      startedAt: Date.now(),
      /*
        Patience well past the server's own deadline, so the failure this case
        can report is "the server never answered" rather than "this client
        stopped listening" — two very different findings that a patience at or
        near `CALL_DEADLINE_MS` would make indistinguishable.
      */
      answer: client.call(CH.slackTest, undefined, CALL_DEADLINE_MS + 60_000),
    };
  }, 120_000);

  afterAll(async () => {
    deadlineRun?.client.close();
    await stopApp(deadlineRun?.app);
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
  }, 30_000);

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

    it('20. refuses a v1 client with protocol-mismatch, and sends no frame afterward (HIVE-144)', async () => {
      /*
        The same mechanism case 4 drives, from the direction that will actually
        happen. Case 4 sends `REMOTE_PROTOCOL_VERSION + 1` — a client from the
        future, which exists only in that test — and proves the *refusal path*
        works at all. This one sends `1`: the protocol HIVE-143 shipped, and
        therefore a real build someone can still be running, which is the
        version this server has to keep refusing rather than half-speaking.
        The two are one assertion only for as long as `REMOTE_PROTOCOL_VERSION`
        stays 2; a future bump makes case 4 test 4-against-3 and leaves this
        one still testing the oldest client in the wild.
      */
      expect(REMOTE_PROTOCOL_VERSION).toBeGreaterThan(1);

      const messages: Record<string, unknown>[] = [];
      await new Promise<void>((resolve, reject) => {
        const socket = new WebSocket(url);
        socket.on('open', () =>
          socket.send(
            JSON.stringify({
              kind: 'attach',
              protocol: 1,
              deviceId: active.device.id,
              token: active.token,
            }),
          ),
        );
        socket.on('message', (data) => messages.push(JSON.parse(String(data)) as Record<string, unknown>));
        socket.on('close', () => resolve());
        socket.on('error', reject);
      });

      // One frame, and only one, after the socket has fully closed — a v1
      // client is refused, not downgraded to.
      expect(messages).toHaveLength(1);
      expect(messages[0]).toMatchObject({ kind: 'attach-refused', code: 'protocol-mismatch' });
      const message = String(messages[0]?.['message']);
      expect(message).toContain(String(REMOTE_PROTOCOL_VERSION));
      // `\b1\b`, not `toContain('1')`: the server's own version is in this
      // same sentence, and a bare substring check would pass on the `1` inside
      // a two-digit version long after this case stopped meaning anything.
      expect(message).toMatch(/\b1\b/u);
      /*
        An explicit bound rather than Vitest's 5s default. This case waits on
        the socket **closing**, and the failure mode when a version stops being
        refused is that it never does — proved by pointing this case at the
        server's own version, which produced `Test timed out in 5000ms` rather
        than an assertion. That is the right failure, and 5s of it is too tight
        a margin to hang a real refusal on.
      */
    }, 20_000);

    it('5. refuses a call frame that arrives on an unattached socket', async () => {
      const outcome = await attach(url, {
        kind: 'call',
        id: 'req-1',
        channel: 'config:get',
        payload: {},
      });
      expect(outcome.frame).toMatchObject({ kind: 'attach-refused', code: 'unauthorized' });
    });

    it('refuses --update while the local server is running', async () => {
      const result = await runOneShot(['--update'], configPath, userDataDir);

      expect(result.code).toBe(5);
      expect(result.stdout).toMatch(/server.*running/i);
      expect(result.stderr).toBe('');
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

  describe('the headless update one-shot (HIVE-158)', () => {
    let configPath: string;
    let userDataDir: string;

    beforeAll(() => {
      const dir = mkdtempSync(join(tmpdir(), 'hive-live-update-'));
      configPath = join(dir, 'config.json');
      userDataDir = join(dir, 'user-data');
      assertScratchPath(configPath);
      scratchConfigPaths.push(configPath);
    });

    it('exits readably rather than opening a UI when its update channel is unavailable', async () => {
      const result = await runOneShot(['--update'], configPath, userDataDir);

      expect(result.code).toBe(3);
      expect(result.stdout).toMatch(/updates are not available|download updates/i);
      expect(result.stderr).toBe('');
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
      }), 'refusing');
      app = booted.child;
      appRecord = booted.record;
      port = booted.port;
      // Booted as `refusing` (HIVE-140 audit, gap 3): a refused host binds
      // nothing, so the ready signal is the one log line saying so rather than
      // a health check against a socket that must not exist.
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

      // The behavioural half (HIVE-140 audit, gap 3): with `host` refused, the
      // server binds nothing at all. It used to fall back to `127.0.0.1` and
      // answer there, reachable by nobody else and reported as serving. The
      // running app says why, in the words the tray shows.
      await expect(httpStatus(`http://127.0.0.1:${String(port)}/`)).rejects.toThrow(/ECONNREFUSED/);
      expect(appRecord?.stderr).toMatch(/server mode is not listening: .*0\.0\.0\.0 binds every interface/);

      // And the app itself has not gone down over a config error — proved by
      // a second, independent process (the `--devices` one-shot) that
      // reaches the very same file, on the same profile the running app
      // uses.
      expect(app?.exitCode).toBeNull();
      const devices = await runOneShot(['--devices'], configPath, userDataDir);
      expect(devices.code).toBe(0);
    });

    it('8b. the OS holds no listening socket on that port at all — the socket itself, not a network probe', async () => {
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

      /*
        Not the wildcard, and not the loopback fallback it used to take either
        (HIVE-140 audit, gap 3): nothing. Case 8c proves this same check can see
        a wildcard bind when one exists, so an empty answer here is a real one.
      */
      expect(
        forThisPort,
        `lsof -p ${String(app.pid)} reported: ${addresses.join(', ') || '(nothing)'}`,
      ).toEqual([]);
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
    /** The second tree, so two surfaces can watch different projects (HIVE-145). */
    const otherProjectId = 'live-other';
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
    /** A genuinely second device, so "two clients" is two credentials (HIVE-145). */
    let secondDevice: MintedDevice;
    /** A second project, so two surfaces can watch different trees (HIVE-145). */
    let otherProjectDir: string;

    /** A client that has completed a real handshake, optionally resuming. */
    const attached = async (options: { resumeFrom?: Record<string, ResumePoint>; stallAfter?: number } = {}): Promise<LiveClient> =>
      openClient(url, { id: device.device.id, token: device.token }, options);

    /** The same, on the other device's credential. */
    const attachedSecond = async (options: { stallAfter?: number } = {}): Promise<LiveClient> =>
      openClient(url, { id: secondDevice.device.id, token: secondDevice.token }, options);

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
      secondDevice = mintDevice('Link-Device-2');
      otherProjectDir = mkdtempSync(join(tmpdir(), 'hive-live-server-other-'));
      writeFileSync(join(otherProjectDir, 'README.md'), 'the other tree\n', 'utf8');

      const booted = await bootServerApp(configPath, userDataDir, (bootPort) => ({
        version: CONFIG_VERSION,
        // `sh` rather than the developer's own `$SHELL`, for the reason the e2e
        // fixture pins it: zsh and bash differ in prompt behaviour and a suite
        // that passes only on the author's machine is worthless.
        shell: '/bin/sh',
        claudeCommand: stubClaudeCommand,
        projects: [
          { id: seededProjectId, name: 'Live Remote', path: projectDir, icon: 'ph-cube' },
          { id: otherProjectId, name: 'Live Other', path: otherProjectDir, icon: 'ph-cube' },
        ],
        server: {
          bind: { host: '127.0.0.1', port: bootPort, allowedOrigins: [] },
          devices: [device.device, secondDevice.device],
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
      // The refusal names the route forward rather than a ticket (HIVE-146).
      expect((result as ErrorFrame).message).toMatch(/config:browse-directory/);
    }, 30_000);

    /**
     * 26. The replacement for the channel case 14 refuses (HIVE-146).
     *
     * What this adds over `home-browse.test.ts` is the wire: a real listing,
     * resolved by the process that answered, arriving as a `result` frame with
     * its shape intact.
     *
     * What it deliberately does **not** claim is that the home is the
     * *server's* rather than the client's. Both apps in this suite run on one
     * machine and inherit one `HOME`, so the two are the same directory here
     * and no assertion could tell them apart. That half is the unit test's,
     * where `HOME` is moved to a temporary directory and the resolution is
     * observed directly.
     */
    it('26. answers a real listing of the answering machine’s home', async () => {
      const client = await attached();

      const result = await client.call(CH.configBrowseDirectory, { path: '' });

      expect(result).toMatchObject({ kind: 'result', payload: { ok: true } });
      const listing = (result as { payload: { value: BrowseListing } }).payload
        .value;

      expect(listing.home).toBe(realpathSync(homedir()));
      expect(listing.path).toBe(listing.home);
      // Every offered path is a directory inside that root — the containment
      // the fence promises, observed on what actually crossed the socket.
      for (const entry of listing.entries) {
        expect(entry.kind).toBe('directory');
        expect(entry.path.startsWith(`${listing.home}/`)).toBe(true);
      }
    }, 30_000);

    /**
     * 27. The fence, over a real socket.
     *
     * `home-browse.test.ts` proves containment against a temporary home in
     * process. This proves the same refusal survives the wire: an `FsResult`
     * failure arrives as a **`result`** frame carrying `EOUTSIDE`, the way
     * cases 12 and 13 established for the fs verbs, rather than as an `error`
     * frame the renderer's wrappers would swallow.
     */
    it('27. refuses a path outside the server’s home, as a result not an error', async () => {
      const client = await attached();

      const result = await client.call(CH.configBrowseDirectory, {
        path: '/etc',
      });

      expect(result).toMatchObject({
        kind: 'result',
        payload: { ok: false, error: { code: 'EOUTSIDE' } },
      });
    }, 30_000);

    /**
     * 29. A process-local channel, refused where it lands (HIVE-155).
     *
     * `client.call` builds the frame by hand and writes it to the socket, which
     * is the one sender `PROCESS_LOCAL`'s fence cannot see: the proxy answers
     * `remote:forget` on the machine that asked, so no shipped client sends it.
     *
     * The server's credential file is seeded first, with known bytes. A server
     * that only serves has no credential of its own, and "absent before and
     * after" passes with the defect present. `applyRemoteForget` is an
     * `rmSync`, so the file surviving byte for byte is the observation that
     * tells the fix from the bug.
     */
    it('29. refuses a hand-built remote:forget and leaves the server’s credential alone', async () => {
      const credentialFile = join(userDataDir, 'remote-credential.bin');
      const seeded = Buffer.from('live proof: the server’s own credential\n', 'utf8');
      writeFileSync(credentialFile, seeded);

      try {
        const client = await attached();
        const result = await client.call(CH.remoteForget, undefined);

        expect(result).toMatchObject({ kind: 'error', code: 'remote-refused' });
        expect((result as ErrorFrame).message).toMatch(/own credential/);
        expect(existsSync(credentialFile)).toBe(true);
        expect(readFileSync(credentialFile).equals(seeded)).toBe(true);
      } finally {
        rmSync(credentialFile, { force: true });
      }
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
      (`{"kind":"event","channel":"pty:data","payload":{"sessionId":…,"chunk":…,"seq":…}}`)
      is ~120 bytes per frame counted directly against that JSON with a
      realistic (UUID) session id, so at 64 KiB batches it is still under 0.2%
      and is *not* what this number is made of. Essentially all of it is JSON
      string escaping — this flood is 20,000 CRLF-terminated lines, and `\r`
      and `\n` each cost two bytes instead of one, which is 40,000 of the
      41,193-byte difference on its own, and the remaining ~1,200 is the 13
      envelopes this flood actually sent. Those land nearer 90 bytes each,
      not 120: `live-gap`, this case's own session id, is eight characters,
      well short of the UUID a real session gets.

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
      /*
        Read off the wire, never written as a literal (HIVE-144).

        `registry.open()`'s counter is **global**, not per entity
        (`electron/main/sessions/registry.ts`): this app's second session gets
        generation 2 whether or not anything was ever restarted. A literal
        `gen: 1` here is therefore only correct for whichever case happens to
        spawn first, and a case further down the file that wrote one would be
        asking for a generation mismatch while claiming to test something else
        — which is exactly what case 17 below was doing until this run. A
        client learns its generation the only way a real one can, from
        `DataEvent.gen` on the frames it has already been sent.
      */
      const lastGen = before.at(-1)!.gen;
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

      // The same generation throughout: nothing here restarts the session,
      // only the socket watching it — so `lastGen`, read off the frames this
      // client was already sent, is still the live one and the replay arm is
      // the one taken. Case 18 is the other side of that branch.
      const resumed = await attached({ resumeFrom: { [sessionId]: { gen: lastGen, seq: lastSeq } } });
      const after = await resumed.collectPtyUntil(sessionId, /line-400\b/);
      measurements.push({
        case: '16. resume across a killed socket',
        generation: lastGen,
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
      const ready = (await client.collectPtyUntil(sessionId, /READY-MARK/)).at(-1)!;
      const lastSeq = ready.seq;
      /*
        **This case used to write `gen: 1` here, and that made it vacuous**
        (found while writing case 18, HIVE-144).

        `registry.open()`'s generation counter is global across entities, so
        `live-gap` — this app's *second* session — is generation 2, not 1. A
        literal 1 therefore took `Sessions.resume`'s **generation-mismatch**
        arm, which returns a gap without ever consulting the ring; the case
        asserted a gap, got one, and proved nothing at all about
        `REPLAY_BYTES`. It passed for a reason its own comment denied. Reading
        the generation off the frames the client was actually sent puts it back
        on the arm it names — same generation, ring overrun — and leaves the
        mismatch arm to case 18, where it is the claim rather than an accident.
      */
      const lastGen = ready.gen;
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

      // One generation throughout — the flood is on the same generation, so
      // the gap below is the ring, not a restart. Case 18 is the restart.
      const resumed = await attached({ resumeFrom: { [sessionId]: { gen: lastGen, seq: lastSeq } } });
      /*
        The resuming client is sent no *transcript* for a gap — that is still by
        design (`ipc/pty.ts`'s `ResumeResult`) — but it is sent one **empty**
        `pty:data` stamped at the head seq, on attach, and that marker is what
        this case now waits for.

        It used to force the discontinuity into view with a `printf`, because
        nothing arrived until the next live batch did. That crutch was hiding
        the bug it worked around (HIVE-143 review): a client reattaching to a
        session that has gone *idle* — the ordinary case, a build that finished
        while it was away — got no frames at all and redrew its cached
        transcript with an unmarked hole. Waiting for the marker instead is both
        the stronger assertion and the honest one: the shell here is idle after
        the flood, so nothing but the marker can arrive.
      */
      const after = await resumed.collectPtyCount(sessionId, 1);
      const marker = after[0]!;
      measurements.push({
        case: '17. seqs across the forced gap',
        generation: lastGen,
        markerGeneration: marker.gen,
        lastSeqBeforeKill: lastSeq,
        markerSeq: marker.seq,
        markerChunkLength: marker.chunk.length,
      });

      /*
        The generation is unchanged across this gap, which is what separates
        this case from case 18. Asserted rather than assumed: without it the
        `gen: 1` bug above could come back as any other wrong generation and
        this case would go on passing on the mismatch arm.
      */
      expect(marker.gen).toBe(lastGen);

      // A discontinuity is what the renderer's existing gap notice keys on
      // (`src/lib/terminal/pty-transport.ts`), and an empty chunk is what makes
      // the marker free — the write that follows the check puts nothing on
      // screen.
      expect(marker.chunk).toBe('');
      expect(marker.seq).not.toBe(lastSeq + 1);
      expect(marker.seq).toBeGreaterThan(lastSeq + 1);

      /*
        And live output still follows it contiguously: the marker is stamped at
        the head, so the next real batch is `marker.seq + 1` and the client's
        assertion is satisfied from here on. A marker that raised a *second*
        false gap would be worse than the silence it replaced.
      */
      resumed.notify(CH.ptyWrite, { sessionId, data: "printf 'DONE-%s\\n' MARK\r" });
      const live = await resumed.collectPtyUntil(sessionId, /DONE-MARK/);
      expect(live[1]!.seq).toBe(marker.seq + 1);
    }, 180_000);

    it('18. a restarted session answers gap to a reattaching client (HIVE-144)', async () => {
      /*
        **The blocking bug this ticket was written around, end to end.**

        `registry.open()` mints pty session ids as `${entityId}.g${N}` from a
        counter that is global to the process, while `ipc/pty.ts`'s seq numbers
        restart at 0 for each new session id. Before this branch `resumeFrom`
        was `Record<entityId, number>` — a bare seq, with no generation beside
        it — so a client that reattached after a restart was handed the **new**
        generation's batches, numbered from wherever that generation's ring
        happened to be, and its own contiguity check raised nothing. Data loss
        that rendered as success.

        The fixture is built so that a `gap` and a contiguous replay cannot
        look the same: generation A runs a slow 30-line loop so its head climbs
        well past anything a one-line generation can reach, and generation B
        prints once. `expect(headB).toBeLessThan(lastSeqA)` below is not a
        sanity check on the shell — it is the precondition the case's whole
        claim rests on, asserted rather than assumed, because a fixture where
        both rings sat at the same head would have passed identically with the
        bug present. (That exact mistake was made once already on this branch.)
      */
      const client = await attached();
      const sessionId = await client.spawnSession(seededProjectId, 'live-restart');

      /*
        A line every ~10ms, for case 16's reason: 30 `echo`s in the tightest
        loop land in one or two 8ms batches, and the point here is a *high*
        head seq, which needs many batches rather than many bytes.
      */
      client.notify(CH.ptyWrite, {
        sessionId,
        data: 'i=1; while [ $i -le 30 ]; do echo gen-a-$i; i=$((i+1)); sleep 0.01; done\r',
      });
      const beforeRestart = (await client.collectPtyUntil(sessionId, /gen-a-30\b/)).at(-1)!;
      const lastSeqA = beforeRestart.seq;
      const genA = beforeRestart.gen;
      client.kill();

      /*
        The restart itself, over a socket of its own — the reconnecting client
        is gone by design, and something still has to reach the app. `pty:restart`
        is graded `execute` (`remote-contract.ts`'s `DEVICE_GRANT`) and a paired
        device holds `execute`, so this is the same verb a client's own restart
        button sends.
      */
      const driver = await attached();
      const restarted = await driver.call(CH.ptyRestart, {
        sessionId,
        projectId: seededProjectId,
        cols: 200,
        rows: 24,
      });
      expect(restarted, `pty:restart was refused: ${JSON.stringify(restarted)}`).toMatchObject({
        kind: 'result',
      });

      // One line, and only one, on the new generation.
      driver.notify(CH.ptyWrite, { sessionId, data: "printf 'GEN-B-%s\\n' MARK\r" });
      await driver.collectPtyUntil(sessionId, /GEN-B-MARK/);
      const genBFrames = (await driver.collectPtyCount(sessionId, 1)).filter(
        (event) => event.gen !== genA,
      );
      expect(
        genBFrames.length,
        'the restart produced no frames on a new generation — nothing was restarted',
      ).toBeGreaterThan(0);
      const genB = genBFrames.at(-1)!.gen;
      const headB = genBFrames.at(-1)!.seq;
      driver.kill();

      measurements.push({
        case: '18. gap across a restart',
        sessionId,
        generationA: genA,
        lastSeqOnA: lastSeqA,
        generationB: genB,
        headSeqOnB: headB,
      });

      // The precondition, not a formality — see this case's own comment.
      expect(genB).not.toBe(genA);
      expect(headB).toBeLessThan(lastSeqA);

      /*
        The reattach: the client knows only what it was told before it went
        away — generation A, and the last seq it rendered. This is the exact
        frame the old `Record<entityId, number>` could not express.
      */
      const resumed = await attached({ resumeFrom: { [sessionId]: { gen: genA, seq: lastSeqA } } });
      const after = await resumed.collectPtyCount(sessionId, 1);
      const marker = after[0]!;

      // A gap marker, not a replay: empty chunk, stamped at the *new*
      // generation's head, carrying the new generation rather than the stale
      // one the client sent.
      expect(marker.chunk).toBe('');
      expect(marker.seq).toBe(headB);
      expect(marker.gen).toBe(genB);

      /*
        And the shape the bug produced, named directly: a client resuming at
        `lastSeqA` that is handed `lastSeqA + 1` sees no discontinuity and
        writes the new generation's output into the old one's transcript. That
        is the assertion this whole ticket exists for.
      */
      expect(marker.seq).not.toBe(lastSeqA + 1);
      for (const event of after) expect(event.seq).not.toBe(lastSeqA + 1);

      /*
        Live output still follows the marker contiguously, for case 17's
        reason: a marker that raised a second, false gap would be worse than
        the silence it replaced.
      */
      resumed.notify(CH.ptyWrite, { sessionId, data: "printf 'GEN-B-%s\\n' AFTER\r" });
      const live = await resumed.collectPtyUntil(sessionId, /GEN-B-AFTER/);
      expect(live[1]!.seq).toBe(marker.seq + 1);
      expect(live[1]!.gen).toBe(genB);
    }, 180_000);

    it('19. an attach accept carries a populated snapshot (HIVE-144)', async () => {
      /*
        Read through `attach`, not `openClient`: this case wants the accept
        frame itself, and `attach` is the helper that reads exactly one frame
        and closes. Run late in this block on purpose — by now the server has a
        project, agents written by case 15, a ledger entry, and three live pty
        sessions, so an empty snapshot here would be a real failure rather than
        an honest answer about an idle server.
      */
      const outcome = await attach(url, {
        kind: 'attach',
        protocol: REMOTE_PROTOCOL_VERSION,
        deviceId: device.device.id,
        token: device.token,
      });
      expect(outcome.frame).toMatchObject({ kind: 'attach-accepted', serverName: hostname() });

      const snapshot = (outcome.frame?.['snapshot'] ?? {}) as Partial<Record<Channel, unknown>>;
      const keys = Object.keys(snapshot);
      measurements.push({ case: '19. attach snapshot', keys });

      /*
        Every key is one this contract names — a snapshot that grew a key the
        client does not know how to read is as wrong as one that lost one.
      */
      for (const key of keys) expect(SNAPSHOT_CHANNELS).toContain(key);

      /*
        Five of the six asserted individually rather than by count, so a
        failure names which one went missing. `github:prs` is deliberately not
        among them: it shells out to a real `gh` and races
        `SNAPSHOT_READ_BUDGET_MS`, and Ruling 15 says a read that misses that
        budget is dropped — so requiring it here would make this case fail on a
        slow network rather than on a regression.
      */
      for (const channel of [
        CH.configGet,
        CH.sessionHistory,
        CH.agentsList,
        CH.ledgerList,
        CH.notificationsList,
      ]) {
        expect(keys, `snapshot was missing ${channel}`).toContain(channel);
      }

      /*
        Populated, not merely present. `config:get` is checked against the
        project *this* server was seeded with — a snapshot answered from some
        other config, or from a default one, fails here — and `ledger:list`
        against the entry case 15 posted through this same socket.
      */
      const config = snapshot[CH.configGet] as { projects: { id: string }[] };
      expect(config.projects.map((project) => project.id)).toContain(seededProjectId);
      expect(JSON.stringify(snapshot[CH.ledgerList])).toContain('live proof');
    }, 30_000);

    /**
     * Two clients attached to one server at the same time (HIVE-145).
     *
     * Every case above this point attaches one socket. The N-way fan-out has
     * been there since HIVE-143 and the machinery to make two of them safe
     * landed in HIVE-145, but nothing had ever put two on the wire at once
     * against a real server — which is the only place the per-surface state can
     * actually be shown to be per surface.
     *
     * Two devices, not one credential twice: `RemoteConfig`'s own model is one
     * socket per device, and two laptops is the deployment this Epic is for.
     */
    describe('two attached clients (HIVE-145)', () => {
      it('23. renders the same session output on both', async () => {
        const a = await attached();
        const b = await attachedSecond();
        const sessionId = `two-clients-${String(Date.now())}`;
        await a.spawnSession(seededProjectId, sessionId);

        a.notify(CH.ptyWrite, { sessionId, data: 'echo BOTH-SEE-THIS\n' });

        /*
          Collected on each socket independently. The assertion is not "the
          server sent it" — the fan-out already had a unit test for that — but
          that two real sockets, on two real device credentials, each receive
          the whole of one session's output.
        */
        await a.collectPtyUntil(sessionId, /BOTH-SEE-THIS/);
        await b.collectPtyUntil(sessionId, /BOTH-SEE-THIS/);

        a.notify(CH.ptyWrite, { sessionId, data: 'exit\n' });
      }, 60_000);

      it('24. lets a stalled client pause the producer rather than buffer without bound, and releases on its drop', async () => {
        const fast = await attached();
        /*
          Acks the first batch and then goes quiet. That first ack is what
          enrols it in this session's window — a client that never acked at all
          is one whose user has not opened the session, and must not hold it for
          the person who has.
        */
        const stalled = await attachedSecond({ stallAfter: 1 });
        const sessionId = `stalled-client-${String(Date.now())}`;
        await fast.spawnSession(seededProjectId, sessionId);

        /*
          More than `HIGH_WATER_BYTES` (512 KiB) of output, so the window
          genuinely closes rather than the whole flood fitting inside it.
        */
        fast.notify(CH.ptyWrite, {
          sessionId,
          data: `yes 0123456789012345678901234567890123456789 | head -40000\n`,
        });

        /*
          The window follows the **slowest** surface, so the fast client's own
          stream stops too. That is what backpressure *is*: the pty is paused at
          the fd and the producing process blocks on write, rather than the
          server holding megabytes in the stalled socket's `ws` send buffer,
          which is the failure this replaced.

          Waited for as a plateau rather than asserted once: the pause happens
          when the unacked window crosses the mark, which is a few batches in.
        */
        await fast.collectPtyBytes(sessionId, 256 * 1024);
        const paused = await settledBytes(fast, sessionId);
        expect(paused, 'the producer never paused for the stalled client').toBeLessThan(
          40_000 * 41,
        );

        /*
          And the trap the HIVE-143 review named, closed: a surface that goes
          away releases whatever it was holding. Without that, a slow client
          could freeze a session for everyone else permanently, simply by
          disconnecting — its mark would sit at the bottom of the window forever.
        */
        stalled.kill();

        await waitFor(
          () => fast.ptyBytes(sessionId) > paused,
          'the stream to resume once the stalled client dropped',
          30_000,
        );

        fast.notify(CH.ptyWrite, { sessionId, data: 'exit\n' });
      }, 90_000);

      it('25. watches a different project per client, and sends each only its own changes', async () => {
        const a = await attached();
        const b = await attachedSecond();

        const watchedByA = await a.call(CH.fsWatch, { projectId: seededProjectId });
        const watchedByB = await b.call(CH.fsWatch, { projectId: otherProjectId });
        expect(watchedByA.kind, JSON.stringify(watchedByA)).toBe('result');
        expect(watchedByB.kind, JSON.stringify(watchedByB)).toBe('result');

        /*
          The single watch slot this replaced would have had B's call close A's
          watcher, leaving A's explorer silently stale — so a change in A's tree
          would reach nobody, and every change would reach whoever asked last.
        */
        writeFileSync(join(otherProjectDir, 'touched.txt'), 'b only\n', 'utf8');

        const changesFor = (client: LiveClient): EventFrame[] =>
          client.collectEvents()().filter((event) => event.channel === CH.fsChanged);

        await waitFor(
          () => changesFor(b).length > 0,
          'fs:changed on the client that asked for that project',
          30_000,
        );

        /*
          Targeted, not broadcast. Through the fan-out both sockets received
          every surface's tree churn, and an explorer re-read its expanded
          directories on a flush about a repository it was not showing.
        */
        expect(changesFor(a)).toEqual([]);
        expect(
          (changesFor(b)[0]?.payload as { projectId: string }).projectId,
        ).toBe(otherProjectId);

        /*
          A file in A's own tree still reaches A, which is what says its watcher
          survived B's — the theft, stated as the property rather than as the
          absence of one.
        */
        writeFileSync(join(projectDir, 'touched.txt'), 'a only\n', 'utf8');
        await waitFor(
          () => changesFor(a).length > 0,
          'fs:changed on the surviving watcher',
          30_000,
        );
        expect(
          (changesFor(a)[0]?.payload as { projectId: string }).projectId,
        ).toBe(seededProjectId);
      }, 60_000);

      it('28. a row is unread until every attached surface has seen it (HIVE-154)', async () => {
        /*
          "Every surface" ranges over every socket the server is tracking, and
          the cases above leave theirs attached until this block's `afterAll`.
          Each of those is a surface not watching the session, so the fleet
          would never be all-watching and leg 2 could not be reached. Closed
          here so the fleet is exactly A and B; the attaches, the spawn and the
          pty round-trip below outlast the loopback close handshakes by orders
          of magnitude, and a straggler shows up as a failure, never a pass.
        */
        for (const stale of liveClients.splice(0)) stale.close();

        const a = await attached();
        const b = await attachedSecond();
        const eventsA = a.collectEvents();
        const eventsB = b.collectEvents();
        const rows = (events: () => EventFrame[], channel: Channel): EventFrame[] =>
          events().filter((frame) => frame.channel === channel);
        /*
          A `notify` has no answer, and the hook POST travels on a different
          connection, so nothing orders the two. A `call` on the same socket
          does: frames on one socket are handled in order, so its answer means
          every foreground report sent before it has landed.
        */
        const landed = async (client: LiveClient): Promise<void> => {
          const barrier = await client.call(CH.configGet, undefined);
          expect(barrier.kind).toBe('result');
        };

        const sessionId = `read-state-${String(Date.now())}`;
        await a.spawnSession(seededProjectId, sessionId);
        const env = await hookEnvOf(a, sessionId);
        const block = (toolUseId: string): Promise<Response> => raiseBlocked(env, sessionId, toolUseId);

        /*
          Leg 1 — the bug itself. B is watching the session, A is not. The row
          used to be written `unread: false` on the strength of B's attention;
          it must arrive unread on both, and the toast must still reach only
          the device that is not looking.
        */
        b.notify(CH.uiForeground, { terminalId: sessionId, focused: true });
        a.notify(CH.uiForeground, { terminalId: null, focused: true });
        await landed(a);
        await landed(b);

        const first = await block('toolu_live_154_1');
        expect(first.status).toBe(204);

        await waitFor(
          () =>
            rows(eventsA, CH.notificationsNew).length > 0 &&
            rows(eventsB, CH.notificationsNew).length > 0,
          'a notifications:new on both clients',
        );
        const firstRowA = rows(eventsA, CH.notificationsNew).at(-1)!.payload as HiveNotification;
        const firstRowB = rows(eventsB, CH.notificationsNew).at(-1)!.payload as HiveNotification;
        expect(firstRowA.unread).toBe(true);
        expect(firstRowB.unread).toBe(true);
        await waitFor(
          () => rows(eventsA, CH.notificationsToast).length > 0,
          'the toast on the device that is not looking',
        );
        expect(rows(eventsB, CH.notificationsToast)).toHaveLength(0);

        /*
          Leg 2 — the quiet foreground survives the widening. A joins B on the
          session; a second block is the fleet's own business and arrives
          already-read, exactly as one watching device has always worked.
        */
        a.notify(CH.uiForeground, { terminalId: sessionId, focused: true });
        await landed(a);
        const seenBefore = rows(eventsA, CH.notificationsNew).length;
        const toastsBefore = rows(eventsA, CH.notificationsToast).length;
        const second = await block('toolu_live_154_2');
        expect(second.status).toBe(204);

        await waitFor(
          () => rows(eventsA, CH.notificationsNew).length > seenBefore,
          'the second notifications:new',
        );
        const secondRow = rows(eventsA, CH.notificationsNew).at(-1)!.payload as HiveNotification;
        expect(secondRow.unread).toBe(false);

        /*
          Leg 3 — the re-arm is the any-surface question. B looks away while A
          keeps watching: no read flip, no nag, because somebody is still
          attending. Then A looks away too, and only then does the row promote.

          The settle waits on real time because it asserts an *absence*, which
          no poll can hurry — case 22's precedent.

          A `session.blocked` row, which the arrival sweep never takes, so this
          proves the any-surface hold for that kind only. The drain's other
          change — an idle or input-needed row released only once *every*
          surface was watching — is the notifier unit spec's ("releases a held
          arrival-kind row only once every surface is watching").
        */
        b.notify(CH.uiForeground, { terminalId: null, focused: true });
        await landed(b);
        await new Promise((resolve) => setTimeout(resolve, 2_000));
        expect(rows(eventsA, CH.notificationsRead)).toHaveLength(0);
        expect(rows(eventsA, CH.notificationsToast)).toHaveLength(toastsBefore);
        expect(rows(eventsB, CH.notificationsToast)).toHaveLength(0);

        a.notify(CH.uiForeground, { terminalId: null, focused: true });
        await waitFor(
          () => rows(eventsA, CH.notificationsRead).length > 0,
          'the re-arm once the last watcher leaves',
        );
        const readFlip = rows(eventsA, CH.notificationsRead).at(-1)!
          .payload as NotificationReadEvent;
        expect(readFlip).toMatchObject({ id: secondRow.id, unread: true });

        // The promotion toasts the devices that were never interrupted at raise.
        await waitFor(
          () => rows(eventsB, CH.notificationsToast).length > 0,
          'the promoted toast on the device that was watching at raise',
        );

        measurements.push({ case: '28. HIVE-154 read-state', rowId: secondRow.id });
        a.notify(CH.ptyWrite, { sessionId, data: 'exit\n' });
      }, 120_000);
    });
  });

  describe('two real built apps, one serving and one attaching (HIVE-144)', () => {
    /**
     * The server's project, and the client's own. Deliberately different ids
     * on deliberately different paths: `config:get` answered by the far end has
     * to be distinguishable from `config:get` answered locally by *something
     * only the far process could produce*, and a scratch directory this run
     * made on the server side is exactly that. "It resolved" would not be.
     */
    const servedProjectId = 'served-fleet';
    const clientProjectId = 'client-only';
    /**
     * A **second** project on the client, and only on the client (Ruling 29).
     *
     * The two configs have to differ in project *count*, not only in ids,
     * because case 21h needs a signal that the Advanced pane's Reload button
     * was answered by one machine rather than the other — and the only thing
     * that button renders is "Reloaded — N projects." One each would print the
     * same sentence for both, which is a wait that cannot tell the two apart
     * and therefore a wait that proves nothing.
     */
    const clientProjectId2 = 'client-only-two';

    let serverDir: string;
    let serverConfigPath: string;
    let serverUserDataDir: string;
    let serverPort: number;
    let serverProjectDir: string;
    let serverApp: ChildProcess | undefined;
    let serverRecord: ProcessRecord | undefined;

    let clientDir: string;
    let clientConfigPath: string;
    let clientUserDataDir: string;
    let clientProjectDir: string;
    let clientProjectDir2: string;
    let clientApp: ChildProcess | undefined;
    let clientRecord: ProcessRecord | undefined;
    let renderer: RendererDriver | undefined;
    /** The attaching app's main process, for pinning its window's focus (HIVE-160). */
    let clientMain: RendererDriver | undefined;

    /** The device the server minted for the client, through the real `--pair` CLI. */
    let credential: { id: string; token: string } | null = null;
    /** A raw `ws` client on the *server*, so this case can see the server's own answers. */
    let onServer: LiveClient | undefined;
    /** The live session the client is supposed to be able to watch. */
    const watchedSessionId = 'live-fleet';

    beforeAll(async () => {
      serverDir = mkdtempSync(join(tmpdir(), 'hive-live-two-app-server-'));
      serverConfigPath = join(serverDir, 'config.json');
      serverUserDataDir = join(serverDir, 'user-data');
      serverProjectDir = mkdtempSync(join(tmpdir(), 'hive-live-two-app-served-project-'));
      assertScratchPath(serverConfigPath);
      scratchConfigPaths.push(serverConfigPath);

      const booted = await bootServerApp(serverConfigPath, serverUserDataDir, (bootPort) => ({
        version: CONFIG_VERSION,
        shell: '/bin/sh',
        // The same no-op bootstrap the HIVE-143 block uses, for the same
        // reason: a machine with a real `claude` on its PATH must not have one
        // started by this suite.
        claudeCommand: 'true; false',
        projects: [
          { id: servedProjectId, name: 'Served Fleet', path: serverProjectDir, icon: 'ph-cube' },
        ],
        server: { bind: { host: '127.0.0.1', port: bootPort, allowedOrigins: [] }, devices: [] },
      }));
      serverApp = booted.child;
      serverRecord = booted.record;
      serverPort = booted.port;

      /*
        The client is an ordinary app: no `--server`, a real window, its own
        profile and its own config. `--remote-debugging-port` is the one
        addition, and it changes nothing the app does — see {@link openRenderer}.
      */
      clientDir = mkdtempSync(join(tmpdir(), 'hive-live-two-app-client-'));
      clientConfigPath = join(clientDir, 'config.json');
      clientUserDataDir = join(clientDir, 'user-data');
      clientProjectDir = mkdtempSync(join(tmpdir(), 'hive-live-two-app-client-project-'));
      clientProjectDir2 = mkdtempSync(join(tmpdir(), 'hive-live-two-app-client-project-two-'));
      assertScratchPath(clientConfigPath);
      scratchConfigPaths.push(clientConfigPath);
      writeFileSync(
        clientConfigPath,
        JSON.stringify(
          {
            version: CONFIG_VERSION,
            shell: '/bin/sh',
            claudeCommand: 'true; false',
            projects: [
              { id: clientProjectId, name: 'Client Only', path: clientProjectDir, icon: 'ph-cube' },
              { id: clientProjectId2, name: 'Client Two', path: clientProjectDir2, icon: 'ph-cube' },
            ],
          },
          null,
          2,
        ),
        'utf8',
      );

      const debugPort = await freePort();
      // `--inspect` is Node's, opened on the main process and ignored by
      // `parseInvocation` for the same reason the Chromium switch is.
      const inspectPort = await freePort();
      const spawned = spawnApp(
        [`--remote-debugging-port=${String(debugPort)}`, `--inspect=${String(inspectPort)}`],
        clientConfigPath,
        clientUserDataDir,
      );
      clientApp = spawned.child;
      clientRecord = spawned.record;
      renderer = await openRenderer(debugPort, 'the attaching app');
      clientMain = await openMainProcess(inspectPort, 'the attaching app’s main process');
    }, 150_000);

    afterAll(async () => {
      renderer?.close();
      clientMain?.close();
      onServer?.close();
      await stopApp(clientApp);
      await stopApp(serverApp);
    }, 30_000);

    it('21a. the client boots local, answering from its own config and its own process', async () => {
      assert(renderer !== undefined, 'the client app must have a renderer');
      const config = await renderer.evaluate<ConfigSnapshot>('window.hive.config.get()');
      expect(
        config.projects.map((project) => project.id),
        `the attaching app's stderr so far:\n${clientRecord?.stderr || '(empty)'}`,
      ).toEqual([clientProjectId, clientProjectId2]);
      expect(config.remote.mode).toBe('local');

      const info = await renderer.evaluate<AppInfo>('window.hive.appInfo()');
      // Nothing is attached and nothing is served — the baseline the two
      // Ruling-24 assertions below move away from.
      expect(info.attachedServerName).toBeNull();
      expect(info.serverBoundHost).toBeNull();
      expect(info.servingDeviceCount).toBe(0);
    }, 60_000);

    it('21b. --pair on the server hands the client a credential it never writes to config.json', async () => {
      // The real CLI, in its own process, against the already-running server —
      // case 6's mechanism, now used the way production uses it.
      const paired = await runOneShot(['--pair', 'The-Client'], serverConfigPath, serverUserDataDir);
      expect(paired.code).toBe(0);
      const lines = paired.stdout.trim().split('\n');
      const token = lines[0] ?? '';
      const deviceId = (lines[1] ?? '').replace(/^Device id: /, '');
      expect(token).toMatch(/^[0-9A-HJKMNP-TV-Z]{4}(-[0-9A-HJKMNP-TV-Z]{4}){3}$/u);
      expect(deviceId).not.toBe('');
      credential = { id: deviceId, token };

      assert(renderer !== undefined, 'the client app must have a renderer');
      const stored = await renderer.evaluate<{ paired: true } | { error: string }>(
        `window.hive.remote.pair({ deviceId: ${JSON.stringify(deviceId)}, token: ${JSON.stringify(token)} })`,
      );
      expect(stored).toEqual({ paired: true });

      /*
        The client half of case 7's claim. `devices.ts` states the two places a
        token's plaintext may exist — stdout at mint time, and the client's own
        `safeStorage` — and this file already asserts the server never writes
        one. The receiving end deserves the same assertion, against the exact
        string that was printed rather than a shape.
      */
      expect(readFileSync(clientConfigPath, 'utf8')).not.toContain(token);
      const credentialFile = join(clientUserDataDir, 'remote-credential.bin');
      expect(existsSync(credentialFile)).toBe(true);
      // Encrypted, not merely elsewhere: the bytes on disk are not the token.
      expect(readFileSync(credentialFile).toString('binary')).not.toContain(token);
    }, 60_000);

    it('21c. a set-remote to a dead port resolves, refuses, and leaves the local snapshot alone', async () => {
      /*
        Reviewer assertion (d), and it runs **before** the successful switch on
        purpose: the property is that the reply survives a full unbind → dial
        fail → rebind-local cycle *inside one invocation*, and that is only
        observable from a window that was local to begin with and is local
        afterwards.

        It runs **after** pairing for a reason the first run of this suite
        supplied: with no credential stored, `requireCredential` throws before
        `connectRemote` is ever called, so the `connect-failed` this case
        asserts arrived without a socket having been attempted at all — the
        case passed while exercising none of the cycle it names. The message is
        checked below precisely so that cannot come back silently.

        A port nothing is listening on, not an unroutable host: the address has
        to pass `isRemoteTarget` (loopback does) so the refusal comes from the
        dial rather than from the plaintext fence, which is a different arm
        with a different remedy.
      */
      assert(renderer !== undefined, 'the client app must have a renderer');
      const deadPort = await freePort();

      const started = Date.now();
      const result = await bounded(
        renderer.evaluate<SetRemoteResult>(
          `window.hive.config.setRemote({ mode: 'remote', host: '127.0.0.1', port: ${String(deadPort)} })`,
        ),
        60_000,
        'setRemote to a dead loopback port (a hang here is the failure, not a refusal)',
      );
      const elapsed = Date.now() - started;
      measurements.push({ case: '21c. set-remote to a dead port', elapsed, result: result.switched });

      expect(result.switched).toMatchObject({ ok: false, reason: 'connect-failed' });
      // The dial is what failed, and the message says so — see this case's own
      // comment for the refusal that used to stand in for it.
      const message = String((result.switched as { message?: string }).message);
      expect(message).toContain(String(deadPort));
      expect(message).not.toContain('device credential');
      // Ruling 19: a target this app could never reach is never written.
      expect(result.config.remote.mode).toBe('local');

      /*
        And the surface is alive again. `config:get` answering at all is the
        half that proves the rebind happened — the failure this guards is a
        window with no IPC — and the projects being the *client's* is the half
        that proves it rebound to the local handlers rather than to anything
        else.
      */
      const after = await renderer.evaluate<ConfigSnapshot>('window.hive.config.get()');
      expect(after.projects.map((project) => project.id)).toEqual([clientProjectId, clientProjectId2]);
      expect(readFileSync(clientConfigPath, 'utf8')).not.toContain(String(deadPort));
    }, 90_000);

    it('21d. set-remote resolves on the channel it unbound, and the server answers afterwards', async () => {
      /*
        Reviewer assertions (a), (b) and (c). `config:set-remote`'s handler
        unbinds the very channel it is answering on — `switchIpcMode` calls
        `resetIpcHandlers` mid-invocation — and only a real Electron process
        can show the reply still lands. The failure mode is a **hang**, not an
        error, which is indistinguishable from a slow dial without a bound, so
        the bound is part of the assertion rather than a convenience.
      */
      assert(renderer !== undefined, 'the client app must have a renderer');

      // Installed before the switch: after it, `pty:data` for the server's
      // session has to arrive through the socket, the remote proxy and the
      // broadcaster to reach this window at all.
      await renderer.evaluate(
        'window.__liveFleet = []; window.hive.pty.onData((event) => window.__liveFleet.push(event)); true',
      );

      const started = Date.now();
      const result = await bounded(
        renderer.evaluate<SetRemoteResult>(
          `window.hive.config.setRemote({ mode: 'remote', host: '127.0.0.1', port: ${String(serverPort)} })`,
        ),
        60_000,
        'setRemote to the live server (its reply has to survive unbinding its own channel)',
      );
      const elapsed = Date.now() - started;
      measurements.push({ case: '21d. set-remote to the live server', elapsed, switched: result.switched });

      // (a) and (b): it resolved, inside the bound, and the value it resolved
      // with was built by code that ran *after* the await — on a channel that
      // no longer existed by then.
      expect(result.switched).toEqual({ ok: true });
      expect(result.config.remote.mode).toBe('remote');
      expect(result.config.remote.port).toBe(serverPort);

      /*
        (c) A *subsequent* call is answered by the far process. Asserted on the
        server's own seeded project and its scratch path — something only that
        process can produce — and, in the negative, on the client's own project
        being gone. "It resolved" would have been satisfied by the local
        handlers answering, which is the failure this is looking for.
      */
      const config = await renderer.evaluate<ConfigSnapshot>('window.hive.config.get()');
      expect(config.projects.map((project) => project.id)).toEqual([servedProjectId]);
      // `realpathSync`, because `resolveProjects` stores the resolved path and
      // `mkdtempSync` under macOS's `/var` symlink hands back the unresolved
      // one — a difference that is entirely about this machine's filesystem
      // and nothing about which process answered.
      expect(config.projects[0]?.path).toBe(realpathSync(serverProjectDir));
      expect(config.projects.map((project) => project.id)).not.toContain(clientProjectId);
    }, 120_000);

    it('21e. appInfo stays this process’s own while attached (Ruling 24)', async () => {
      /*
        `CH.appInfo`, `CH.updatesStatus` and `CH.updatesCheck` are
        `PROCESS_LOCAL`: answered by the window's own process even while
        attached, never proxied. Before that fix an attached client read the
        **server's** app info, so the attached chip could never appear, the
        About box showed the server's Electron version and a log path that does
        not exist on this machine, and the amber exposure chip reported the
        server's exposure as this one's.

        The fields checked are chosen because they *provably* differ between
        these two processes rather than because they might: one app is serving
        on a real port with a paired device and is attached to nothing, the
        other is attached and serving nothing.

        The server's half used to be read over a raw socket, as a measured value
        to compare against. HIVE-155 closed that route: the server refuses
        `app:info` to every remote caller, so the raw read now asserts the
        refusal instead. That is a stronger proof of Ruling 24 than the
        comparison was. A proxy that forwarded the renderer's call would get the
        same `remote-refused` error back, so a `result` in the renderer can only
        have been answered by the client's own process.
      */
      assert(renderer !== undefined, 'the client app must have a renderer');
      assert(credential !== null, 'case 21b must have run and paired a device');

      // Opened here because 21f onwards drive the server's fleet through it.
      onServer = await openClient(`ws://127.0.0.1:${String(serverPort)}`, credential, {
        unmanaged: true,
      });
      const answer = await onServer.call(CH.appInfo, undefined);
      expect(
        answer,
        `the served app's stderr so far:\n${serverRecord?.stderr || '(empty)'}`,
      ).toMatchObject({ kind: 'error', code: 'remote-refused' });
      expect((answer as ErrorFrame).message).toMatch(/app:info/);

      const clientInfo = await renderer.evaluate<AppInfo>('window.hive.appInfo()');
      measurements.push({
        case: '21e. Ruling 24',
        server: { appInfo: (answer as ErrorFrame).code },
        client: {
          serverBoundHost: clientInfo.serverBoundHost,
          servingDeviceCount: clientInfo.servingDeviceCount,
          attachedServerName: clientInfo.attachedServerName,
          remoteLink: null,
        },
      });

      // The client's, which is the assertion: three fields, each the opposite of
      // what a serving, unattached process reports, read from a window whose
      // every other channel is being answered by that server right now.
      expect(clientInfo.serverBoundHost).toBeNull();
      expect(clientInfo.servingDeviceCount).toBe(0);
      expect(clientInfo.attachedServerName).toBe(hostname());
    }, 90_000);

    it('21l. config:get-remote stays this process’s own while attached (HIVE-149)', async () => {
      /*
        HIVE-149, and the pair of reads is the assertion rather than either one
        alone.

        `config:get` is proxied on purpose — Settings names the machine whose
        config it is editing, and while attached that is the far end — so the
        `remote` block it answers with is the *server's*, whose own `mode` reads
        `local` because the server is the thing being attached to.
        `config:get-remote` is `PROCESS_LOCAL`, so it is answered here and
        reports `remote` with the address this window actually dialled.

        Taking both from the same window in the same breath is what makes this
        prove the routing. Either read alone passes on a wrongly-routed channel,
        because in local mode the two blocks are the same file read twice; only
        their disagreement while attached shows which process answered. That is
        also why this belongs in the live suite at all — a unit test can only
        assert that the local arm was chosen, never that a real socket was left
        untouched by a real renderer's call.

        Lettered last and placed here on purpose: the letters in this block run
        in authorship order, but the cases run in *precondition* order, and this
        one needs the window 21d attached and 21g gives back.
      */
      assert(renderer !== undefined, 'the client app must have a renderer');

      const proxied = await renderer.evaluate<ConfigSnapshot>('window.hive.config.get()');
      const local = await renderer.evaluate<RemoteConfig>('window.hive.config.getRemote()');

      measurements.push({
        case: '21l. HIVE-149',
        proxied: { mode: proxied.remote.mode, host: proxied.remote.host },
        local: { mode: local.mode, host: local.host },
      });

      // The proxied read, answered by the server: a machine attached to nobody.
      expect(
        proxied.remote.mode,
        `the served app's stderr so far:\n${serverRecord?.stderr || '(empty)'}`,
      ).toBe('local');

      // And this window's own, which is the assertion: the mode and the address
      // it dialled, from the one channel on this pane the socket never carries.
      expect(local.mode).toBe('remote');
      expect(local.host).toBe('127.0.0.1');
      expect(local.port).toBe(serverPort);
      expect(local.mode).not.toBe(proxied.remote.mode);
    }, 90_000);

    it('21f. the attached client sees the server’s live session', async () => {
      /*
        The fleet half. A pty is spawned on the server over the raw socket —
        the server's own process, the server's own project — and the *client's
        renderer* is where its output is asserted. That path is socket →
        `RemoteClient.onEvent` → `registerRemoteProxy` → the broadcaster → this
        window, none of which a unit test can stand up together.
      */
      assert(renderer !== undefined, 'the client app must have a renderer');
      assert(onServer !== undefined, 'case 21e must have opened a socket on the server');

      await onServer.spawnSession(servedProjectId, watchedSessionId);
      onServer.notify(CH.ptyWrite, {
        sessionId: watchedSessionId,
        data: "printf 'FLEET-%s\\n' MARK\r",
      });
      // Confirmed on the server's own socket first, so a failure below is
      // about the client's path rather than about the session.
      await onServer.collectPtyUntil(watchedSessionId, /FLEET-MARK/);

      // Captured into a local so it stays narrowed inside the loop below —
      // `renderer` is a mutable `let` on the enclosing block, which TypeScript
      // will not carry an assertion across an `await`.
      const view = renderer;
      const seen = (): Promise<string> =>
        view.evaluate<string>(
          `(window.__liveFleet || []).filter((e) => e.sessionId === ${JSON.stringify(watchedSessionId)}).map((e) => e.chunk).join('')`,
        );

      const start = Date.now();
      let transcript = '';
      while (Date.now() - start < 60_000) {
        transcript = await seen();
        if (/FLEET-MARK/u.test(transcript)) break;
        await delay(250);
      }
      measurements.push({
        case: '21f. the server’s session in the client’s window',
        transcriptBytes: transcript.length,
      });
      expect(transcript, 'the server’s pty output never reached the client’s window').toMatch(
        /FLEET-MARK/u,
      );
    }, 120_000);

    it('21g. flips back to local, and the detach never touches the server (HIVE-144, Ruling 28)', async () => {
      /*
        ## The criterion, and the defect it used to hide

        This case was, for one commit, written the other way round: it pinned
        what an attached client *actually did*, because it did not do this.
        `CH.configSetRemote` was graded `mutate`, absent from `WINDOW_BOUND`
        and absent from `PROCESS_LOCAL`, so `registerRemoteProxy` forwarded a
        detach down the socket like any other write. The server parsed it, ran
        its *own* `switchIpcMode('local')` (already local, so `{ ok: true }`),
        wrote its *own* `config.json`, and handed back its *own* snapshot. The
        pane read `switched.ok` and `config.remote.mode === 'local'`, both
        true, and rendered success over a window that never detached — and
        because the client's file still said `remote`, the next launch
        reattached. A client could enter remote mode and never leave it.

        Ruling 28 put the channel on `PROCESS_LOCAL` and widened that list's
        membership test from "every field of its payload describes this
        process" to "reads or changes this process's own identity or
        attachment", because the old wording could not classify a *command*
        at all. `applySetRemote` (`electron/main/ipc/set-remote.ts`) is the one
        body both surfaces call.

        ## What is asserted, and why the server's file is read

        Three things, and the third is the one no in-process test can reach:
        the window is answered locally again; its runtime attachment readout
        agrees; and the **server's `config.json` is byte-for-byte what it was**.
        That last assertion is the direct inverse of the defect's own evidence
        — the file used to grow a `"remote": { "mode": "local" }` block it
        never had — so a regression that re-proxied this channel fails here
        rather than merely somewhere.
      */
      assert(renderer !== undefined, 'the client app must have a renderer');

      const beforeServerConfig = readFileSync(serverConfigPath, 'utf8');
      // The fixture in `beforeAll` writes no `remote` block at all, which is
      // what makes the byte comparison below a sharp instrument rather than a
      // comparison of two things that were always going to match.
      expect(beforeServerConfig).not.toContain('"remote"');

      const result = await bounded(
        renderer.evaluate<SetRemoteResult>("window.hive.config.setRemote({ mode: 'local' })"),
        60_000,
        'setRemote back to local',
      );
      /*
        Bounded, for case 21d's reason and one more: this call is answered by
        `registerRemoteProxy`'s own `ipcMain.handle`, and what it awaits
        (`switchIpcMode`) unbinds that handler mid-flight. The failure mode is
        a hang, and only a real Electron process can show the reply landing
        anyway — the local surface's version of this is 21d, and this is the
        proxy's.
      */
      expect(result.switched).toEqual({ ok: true });
      expect(result.config.remote.mode).toBe('local');

      // Answering locally again: this window's own project is back, and the
      // server's is gone from it.
      const config = await renderer.evaluate<ConfigSnapshot>('window.hive.config.get()');
      expect(config.projects.map((project) => project.id)).toEqual([clientProjectId, clientProjectId2]);

      // And the runtime readout agrees with the file, which is the pair
      // `AppInfo.attachedServerName`'s doc comment says can disagree.
      const info = await renderer.evaluate<AppInfo>('window.hive.appInfo()');
      expect(info.attachedServerName).toBeNull();

      // The client's own file is what the next launch reads, so this is the
      // half that makes the detach survive a relaunch rather than only this
      // session.
      const clientOnDisk = JSON.parse(readFileSync(clientConfigPath, 'utf8')) as {
        remote?: { mode?: string };
      };
      expect(clientOnDisk.remote?.mode).toBe('local');

      // The inverse of the defect's own evidence — see this case's comment.
      const afterServerConfig = readFileSync(serverConfigPath, 'utf8');
      expect(afterServerConfig).toBe(beforeServerConfig);

      measurements.push({
        case: '21g. detach applied locally, server untouched',
        switched: result.switched,
        clientRemoteBlockAfter: clientOnDisk.remote,
        serverConfigUnchanged: afterServerConfig === beforeServerConfig,
        attachedServerNameAfter: info.attachedServerName,
      });
    }, 120_000);

    it('21h. the Settings switch attaches and detaches, clicked for real (Ruling 29)', async () => {
      /*
        ## The control, not the channel

        21g proves `config:set-remote` detaches this window. It says nothing
        about whether a **user** can reach it — and for one commit they could
        not. Everything in the attach half keyed on `remote.mode`, which while
        attached is read off the *server's* snapshot and says `'local'`, so the
        switch rendered unchecked on an attached window, the panel stayed
        collapsed, and `handleDetach`'s guard was unreachable by any click.
        Ruling 28 fixed the channel and left the only caller of it dead.

        So this case clicks. Nothing here goes through `window.hive` except to
        *read back* what happened: the attach and the detach are both real
        pointer events on the real Settings pane, driven over CDP, which is the
        only way to exercise `setRemoteConfig` — the app's own wrapper, the one
        that installs the returned snapshot into the store the pane renders
        from. A bridge call would have skipped exactly the state the defect
        lived in.

        The `Reload` click at the top is not decoration. Every earlier case in
        this block drove the bridge directly, so the renderer's store still
        holds the snapshot it booted with; `Reload` is the one control that
        re-reads this machine's own file, and it is what puts the real host and
        port into the address fields for the Attach below.
      */
      assert(renderer !== undefined, 'the client app must have a renderer');
      const ui = renderer;

      /**
       * Poll a renderer-side predicate — `waitFor`, across the bridge.
       *
       * A throw counts as "not yet", and that is not laziness: **while a
       * switch is dialling, this window has no IPC at all.** `switchIpcMode`
       * unbinds both surfaces and *then* `await`s `connectRemote`, so for the
       * length of the dial every `invoke` rejects with Electron's raw
       * `No handler registered for 'app:info'` — measured here, on a loopback
       * dial, by a poll that happened to land in that gap. A predicate that
       * reads the bridge therefore cannot assume the bridge answers.
       *
       * The last failure is kept and reported on timeout, so a *persistent*
       * error still fails loudly and readably rather than as a bare "timed
       * out" — the difference between absorbing a known transient and
       * swallowing a real break.
       */
      const untilUi = async (expression: string, what: string, timeoutMs = 30_000): Promise<void> => {
        const start = Date.now();
        let lastError: unknown;
        while (Date.now() - start < timeoutMs) {
          try {
            if (await ui.evaluate<boolean>(expression)) return;
            lastError = undefined;
          } catch (cause) {
            lastError = cause;
          }
          await delay(100);
        }
        throw new Error(
          `timed out after ${String(timeoutMs)}ms waiting for ${what}` +
            (lastError === undefined
              ? ''
              : `; last error: ${lastError instanceof Error ? lastError.message : String(lastError)}`),
        );
      };

      /*
        The switch is found the way its own markup allows: `Switch` renders a
        `<label htmlFor>` beside a Radix root carrying that id, so the label
        text leads to the control. Chosen over an index into
        `querySelectorAll('[role="switch"]')` because this pane has three, and
        an index would silently follow whichever one moved.
      */
      const SWITCH = `(() => {
        const label = [...document.querySelectorAll('label')]
          .find((el) => el.textContent.trim() === 'Attach to a server');
        return label ? document.getElementById(label.htmlFor) : null;
      })()`;
      /*
        `TextField` labels the same way `Switch` does — a sibling `<label
        htmlFor>`, deliberately not a wrapper, so that its hint text stays out
        of the accessible name. So the input is reached through the label's
        `htmlFor`, and `input.closest('label')` (the obvious first guess, and
        the one this case was written with) is always `null`.
      */
      const FIELD = (label: string): string => `(() => {
        const el = [...document.querySelectorAll('label')]
          .find((l) => ${JSON.stringify(label)} === l.textContent.trim());
        return el ? document.getElementById(el.htmlFor) : null;
      })()`;
      const addressField = `${FIELD('Server address')} !== null`;

      await ui.evaluate(`document.querySelector('button[aria-label="Settings"]').click()`);
      await untilUi(
        `[...document.querySelectorAll('button')].some((b) => b.textContent.trim() === 'Advanced')`,
        'the Settings overlay to offer an Advanced section',
      );
      await ui.evaluate(
        `[...document.querySelectorAll('button')].find((b) => b.textContent.trim() === 'Advanced').click()`,
      );
      await untilUi(`${SWITCH} !== null`, 'the Attach to a server switch to render');

      await ui.evaluate(
        `[...document.querySelectorAll('button')].find((b) => b.textContent.trim() === 'Reload').click()`,
      );
      await untilUi(
        `/Reloaded —/.test(document.body.innerText)`,
        'the Reload to land, so the store holds this machine’s own file',
      );

      /*
        Detached to begin with, which 21g left it as — and the panel is
        *closed*, because this machine's own `remote.mode` is now `'local'`
        and nothing is attached. The switch reveals; it does not dial
        (Ruling 27), which is why the address only becomes readable after the
        click below.
      */
      expect(await ui.evaluate<string | null>(`${SWITCH}.getAttribute('aria-checked')`)).toBe('false');
      expect(await ui.evaluate<boolean>(addressField)).toBe(false);

      await ui.evaluate(`${SWITCH}.click()`);
      await untilUi(
        `${FIELD('Server address')}?.value === '127.0.0.1'`,
        "the address field to show this machine's own stored host",
      );
      expect(await ui.evaluate<string>(`${FIELD('Port')}.value`)).toBe(String(serverPort));

      // Attach: the button is what dials.
      await ui.evaluate(
        `[...document.querySelectorAll('button')].find((b) => /^Attach$/.test(b.textContent.trim())).click()`,
      );
      /*
        Waited on the **socket**, not on the switch.

        `aria-checked` is the wrong signal here and this case was written with
        it once: the reveal click above already set it to `'true'`, so the wait
        resolved instantly, every assertion below ran against a pane
        mid-dial, and the case failed reading a window that had moved on. A
        wait that is already satisfied when it is set up is the live-suite
        version of a test that cannot fail — see the block comment on this
        file's evidence for why that shape is the one this task hunts.
        `attachedServerName` is `PROCESS_LOCAL` and answers `null` until a
        socket is genuinely open, so it can only become non-null here by the
        attach having landed.
      */
      await untilUi(
        `window.hive.appInfo().then((i) => i.attachedServerName !== null)`,
        'the Attach button to open a real socket',
        60_000,
      );
      await untilUi(
        `/Attached to/.test(document.body.innerText)`,
        'the pane to redraw as attached',
        30_000,
      );

      /*
        **Then Reload, and this is the step that makes the case discriminating.**

        Attaching from this pane does not by itself put the window in the state
        the defect lives in. `setRemoteConfig` installs whatever
        `config:set-remote` returned, and since Ruling 28 that verb is answered
        *locally* — so the snapshot the store holds right after a successful
        attach is this machine's own, with `mode: 'remote'` freshly written,
        and a pane keyed on `remote.mode` looks perfectly correct. Written
        without this step, and run against a deliberately reverted pane, this
        case passed with the bug present (measured — the whole reason the step
        is here).

        The broken state is the *next* `config:get`: a Reload, a reopened
        Settings, or the ordinary case of a client that attached at **boot**,
        where the store is hydrated from the proxied read and gets the
        server's block — `mode: 'local'`, because a server is not attached to
        anything. Clicking Reload reproduces exactly that, in one click.

        "Reloaded — 1 project." is the far end answering: this client has two
        projects and the server has one, which is what
        {@link clientProjectId2} exists for.
      */
      await ui.evaluate(
        `[...document.querySelectorAll('button')].find((b) => b.textContent.trim() === 'Reload').click()`,
      );
      await untilUi(
        `/Reloaded — 1 project\\./.test(document.body.innerText)`,
        "a Reload answered by the server, which is what puts this window in a boot-attached client's state",
      );

      /*
        What an attached client now shows, which is the whole of Ruling 29:
        the panel is open, and it names the machine the **socket** is open to
        (`attachedServerName`, not a config field the far end answered).
      */
      const attachedText = await ui.evaluate<string>('document.body.innerText');
      expect(attachedText).toContain('Attached to');
      expect(attachedText).toContain(hostname());

      /*
        The header chip, read off the page rather than a component test
        (HIVE-140 audit, gap 4): HIVE-144's acceptance asked for it present
        while attached and absent in local mode, in a real window.
      */
      const HEADER_CHIPS = `document.querySelector('[data-testid="header-chips"]')?.innerText ?? ''`;
      await untilUi(
        `(${HEADER_CHIPS}).includes('attached · ${hostname()}')`,
        'the header chip to name the attached server',
      );

      /*
        **The address field is present and correct here, and HIVE-149 is what
        changed that.** This asserted its absence, and the copy explaining the
        absence, for as long as the field could only read the proxied block:
        while attached that is the *server's* — `mode: 'local'` and an empty
        host — under a control that writes locally, so showing it was worse than
        hiding it.

        It reads `config:get-remote` now, which is `PROCESS_LOCAL`, so the field
        holds the address this window actually dialled. That is the end-to-end
        assertion the unit tests cannot make: this value came out of a real
        renderer, in a real attached client, through the one channel on this
        pane that a real open socket does not carry.

        `127.0.0.1` because that is what case 21d dialled — read against the
        server's own port rather than a literal, so the two cannot drift.
      */
      /*
        Waited for rather than read once: the field is populated by an async
        `config:get-remote`, and until it answers the pane renders the pending
        line instead of the fields. It happens to have answered already by this
        point today, which is exactly the kind of incidental safety worth not
        depending on.
      */
      await untilUi(
        `${FIELD('Server address')}?.value === '127.0.0.1'`,
        "the address field to show the host this window dialled, read from its own config",
      );
      await untilUi(
        `${FIELD('Port')}?.value === '${String(serverPort)}'`,
        'the port field to show the port this window dialled',
      );
      expect(await ui.evaluate<boolean>(addressField)).toBe(true);
      expect(await ui.evaluate<string>('document.body.innerText')).toMatch(
        /read from this machine/i,
      );
      /*
        **Forget is present while attached, and that is HIVE-153's fix rather
        than a regression in this one.**

        This asserted `false` when the pairing block sat inside the
        `attached ?` branch and `remote:forget` was *proxied* — a click then
        cleared the **server's** stored credential, so hiding the control was
        the only safe thing to do. HIVE-153 made both pairing verbs answer on
        this machine, which is what makes the control correct to offer here:
        it forgets what *this* window was handed, and, as its own hint says,
        does not end a live attachment.

        Corrected on this branch because this is the branch that runs the live
        suite. HIVE-153 shipped without it — `pnpm test:server` is not part of
        the routine gate — so `origin/main` fails this case on its own, and the
        merge is simply where it became visible.
      */
      expect(
        await ui.evaluate<boolean>(
          `[...document.querySelectorAll('button')].some((b) => /^Forget$/.test(b.textContent.trim()))`,
        ),
      ).toBe(true);
      // Confirmed against the runtime, not only the pixels: the pane is
      // describing a socket that is genuinely open.
      expect((await ui.evaluate<AppInfo>('window.hive.appInfo()')).attachedServerName).toBe(hostname());

      // And the detach — the click that was unreachable.
      await ui.evaluate(`${SWITCH}.click()`);
      // On the socket again, for the reason the attach wait is: the switch's
      // own state is not evidence that anything happened to it.
      await untilUi(
        `window.hive.appInfo().then((i) => i.attachedServerName === null)`,
        'the switch click to close the socket',
        60_000,
      );
      expect(await ui.evaluate<string | null>(`${SWITCH}.getAttribute('aria-checked')`)).toBe('false');
      // And the chip goes with the socket: nothing in the header claims a link.
      await untilUi(`!(${HEADER_CHIPS}).includes('attached ·')`, 'the header chip to go once detached');

      const info = await ui.evaluate<AppInfo>('window.hive.appInfo()');
      expect(info.attachedServerName).toBeNull();
      const config = await ui.evaluate<ConfigSnapshot>('window.hive.config.get()');
      expect(config.projects.map((project) => project.id)).toEqual([clientProjectId, clientProjectId2]);

      // The file, because that is what the next launch reads — a detach that
      // lasted only this session would be the defect in a slower form.
      const clientOnDisk = JSON.parse(readFileSync(clientConfigPath, 'utf8')) as {
        remote?: { mode?: string };
      };
      expect(clientOnDisk.remote?.mode).toBe('local');

      // And the far machine is untouched by any of it.
      const serverOnDisk = JSON.parse(readFileSync(serverConfigPath, 'utf8')) as {
        remote?: unknown;
      };
      expect(serverOnDisk.remote).toBeUndefined();

      measurements.push({
        case: '21h. the Settings switch, clicked',
        attachedServerNameAfterDetach: info.attachedServerName,
        clientRemoteBlockAfter: clientOnDisk.remote,
        serverHasNoRemoteBlock: serverOnDisk.remote === undefined,
      });

      // Leave the overlay closed, so 21i reads a window in its ordinary state.
      await ui.evaluate(
        `(() => { const b = [...document.querySelectorAll('button')].find((x) => /close/i.test(x.getAttribute('aria-label') || '')); if (b) b.click(); return true; })()`,
      );
    }, 180_000);

    it('21i. a detached client is answered by its own process again, end to end', async () => {
      /*
        21g and 21h prove the detach; this proves the surface it left behind is a
        whole one rather than the one channel that was asked about. The
        rebind-local arm of `switchIpcMode` re-registers *every* channel, and
        a partial rebind — the failure `remote-composition.test.ts` asserts by
        count in-process — looks exactly like a working app until the user
        touches whichever channel is missing.

        Three different layers, deliberately: a `read` off the config module, a
        `PROCESS_LOCAL` channel that was answered locally even while attached
        (so it must not have been *doubly* bound by the rebind), and an
        `execute`-graded channel that reaches the pty layer this process
        re-created. `pty:spawn` on the client's own project is the strongest of
        the three: it can only be answered by a local sessions layer, which
        `resetIpcHandlers` had disposed of.
      */
      assert(renderer !== undefined, 'the client app must have a renderer');

      const info = await renderer.evaluate<AppInfo>('window.hive.appInfo()');
      expect(info.attachedServerName).toBeNull();
      expect(info.receiverBoundHost).not.toBeNull();

      const status = await renderer.evaluate<{ state?: string }>('window.hive.updates.status()');
      expect(status).toBeDefined();

      const spawned = await bounded(
        renderer.evaluate<{ ok: boolean; error?: string }>(
          `window.hive.pty.spawn({ sessionId: 'after-detach', projectId: ${JSON.stringify(clientProjectId)}, cols: 80, rows: 24 })` +
            `.then(() => ({ ok: true })).catch((e) => ({ ok: false, error: String(e && e.message ? e.message : e) }))`,
        ),
        60_000,
        'pty:spawn on the detached client',
      );
      expect(spawned).toEqual({ ok: true });
      measurements.push({ case: '21i. the local surface after a detach', spawned });

      await renderer.evaluate("window.hive.pty.kill('after-detach')");
    }, 120_000);

    it('21j. the server’s sessions keep running whatever the client does', async () => {
      /*
        The last half of the "flips back" criterion: the sessions a client
        watched belong to the other machine, so a detach must not touch them.
        `switchIpcMode`'s doc comment says `remote → local` is never refused
        for exactly this reason — there is nothing to strand, so nothing to
        refuse over. This is that claim against the real thing, driven over the
        raw socket, which never detached, after the window on the other connection
        has detached twice — once through the channel, once through the switch — and re-spawned a pty of its own.
      */
      assert(onServer !== undefined, 'case 21e must have opened a socket on the server');
      onServer.notify(CH.ptyWrite, {
        sessionId: watchedSessionId,
        data: "printf 'STILL-%s\\n' ALIVE\r",
      });
      await onServer.collectPtyUntil(watchedSessionId, /STILL-ALIVE/);
    }, 120_000);

    /**
     * The reconnect, against two real apps (HIVE-150).
     *
     * HIVE-144's own delivery notes list "nothing re-attaches after a socket
     * drops" as a deliberately deferred gap, and every case above it left the
     * client attached to a server that stayed up. This is the case where the
     * server goes away underneath a real attached window.
     *
     * It has to be here rather than in the raw-`ws` block, for this block's own
     * stated reason: the reconnect lives on `ipcMain`. `router.ts` holds the
     * client, `remote-proxy.ts` holds bindings that close over it, and the loop
     * rebinds them — none of which a socket on the *server* can see. The
     * renderer is the only caller that can.
     */
    it('21k. reattaches on its own after the server disappears, and rebinds the surface to it', async () => {
      assert(renderer !== undefined, 'the client app must have a renderer');
      assert(credential !== null, 'case 21b must have paired this client');

      /*
        The window records every link status it is pushed. Installed *before*
        the attach, so the `attached` this case starts from is captured too —
        and because a subscription installed after a drop would miss the very
        transition it exists to observe.
      */
      await renderer.evaluate(
        'window.__link = null; window.hive.remote.onLinkStatus((status) => { window.__link = status; }); true',
      );

      /*
        Attach again. Case 21i left this window local on purpose, and a case
        that inherited an attachment would be resting on its predecessor's
        teardown rather than on its own fixture.

        Polled rather than asserted once, because HIVE-144's interlock is real
        and this case has to clear it rather than pretend it is not there:
        local → remote is refused while a local session is live, 21i spawned
        one and killed it, and a pty takes a moment to actually die. A
        `live-sessions` refusal here is "not yet"; anything else is a failure,
        and the last one seen is what the timeout reports.
      */
      let lastRefusal: SetRemoteResult['switched'] | undefined;
      await waitForAsync(
        async () => {
          const result = await renderer!.evaluate<SetRemoteResult>(
            `window.hive.config.setRemote({ mode: 'remote', host: '127.0.0.1', port: ${String(serverPort)} })`,
          );
          lastRefusal = result.switched;
          if (result.switched.ok) return true;
          if (result.switched.reason !== 'live-sessions') {
            throw new Error(`the re-attach was refused: ${JSON.stringify(result.switched)}`);
          }
          return false;
        },
        `the re-attach this case starts from (last refusal: ${JSON.stringify(lastRefusal)})`,
        90_000,
      );

      // Watch the server's live session, so this window is a surface that acks
      // it — which is what puts it in `resumeFrom` at all (HIVE-145's ruling).
      await renderer.evaluate(
        'window.__reattach = []; window.hive.pty.onData((event) => window.__reattach.push(event)); true',
      );
      onServer!.notify(CH.ptyWrite, {
        sessionId: watchedSessionId,
        data: "printf 'BEFORE-%s\\n' DROP\r",
      });
      await waitForAsync(
        async () =>
          (
            await renderer!.evaluate<{ chunk: string }[]>('window.__reattach')
          ).some((event) => event.chunk.includes('BEFORE-DROP')),
        'the client window to render the server’s output before the drop',
        30_000,
      );

      const linkWhileUp = await renderer.evaluate<AppInfo>('window.hive.appInfo()');
      expect(linkWhileUp.attachedServerName).not.toBeNull();

      /*
        The drop itself: the server process is killed outright. No close frame,
        no detach — the shape a rebooting mini or a tailnet going down actually
        has, and the one HIVE-144 left unhandled.
      */
      await stopApp(serverApp);
      serverApp = undefined;
      onServer?.close();
      onServer = undefined;

      /*
        The client says so, rather than going on claiming an attachment. This
        is the whole defect in one assertion: before this story `attached`
        stayed pointed at the dead client for the life of the window, so
        `attachedServerName` answered a machine that no longer existed and the
        header chip kept naming it.
      */
      await waitForAsync(
        async () =>
          (await renderer!.evaluate<RemoteLinkStatus | null>(
            'window.__link ?? null',
          ))?.state === 'reconnecting',
        'the client to report it is reconnecting, not attached',
        60_000,
      );

      /*
        The server comes back on the same port, from the same config — which by
        now carries the device case 21b paired, so the returning client's
        credential is still good. Rebooted rather than re-created for the reason
        the transcript claim needs: `pty:restart` would be a *new* generation
        and prove the opposite of what this case is about.
      */
      const rebooted = spawnApp(['--server'], serverConfigPath, serverUserDataDir);
      serverApp = rebooted.child;
      serverRecord = rebooted.record;
      await waitForListener('127.0.0.1', serverPort, 60_000);

      /*
        And it comes back on its own. Nothing in this case dials — no switch is
        flipped, no button clicked. The bound is the backoff's own ceiling plus
        room for the app to finish booting; a client that needed a human would
        simply never satisfy this.
      */
      await waitForAsync(
        async () =>
          (await renderer!.evaluate<RemoteLinkStatus | null>(
            'window.__link ?? null',
          ))?.state === 'attached',
        'the client to reattach with nobody asking it to',
        120_000,
      );

      const linkAfter = await renderer.evaluate<RemoteLinkStatus | null>('window.__link ?? null');
      /*
        The epoch moved, which is what the renderer keys its per-surface effects
        on. A reattach that came back without moving it would leave the
        explorer's watcher and the foreground record pointing at a surface the
        server released when the old socket died.
      */
      expect(linkAfter?.epoch ?? 0).toBeGreaterThan(0);

      const infoAfter = await renderer.evaluate<AppInfo>('window.hive.appInfo()');
      expect(infoAfter.attachedServerName).toBe(linkWhileUp.attachedServerName);

      /*
        And the surface is genuinely rebound rather than merely reported: a call
        answered by the far process, on the server's own seeded project, which
        the client's own config cannot produce. Before the rebind these
        bindings closed over the dead client and every one of them rejected.
      */
      const config = await renderer.evaluate<ConfigSnapshot>('window.hive.config.get()');
      expect(config.projects.map((project) => project.id)).toEqual([servedProjectId]);
    }, 300_000);

    /**
     * 21l. `notifications:act` is routed by the action it carries, not by its
     * channel name (HIVE-151).
     *
     * ## What is being proved, and why it is proved this way
     *
     * Three of the seven verbs this channel carries reach *hardware*: `url`
     * goes to `shell.openExternal` and `update.download`/`update.install` reach
     * this process's own updater singleton. Proxied by name, an inbox row
     * clicked on the laptop opened a browser on the mini and drove the mini's
     * updater — a second door into the defect HIVE-144 closed by the front one
     * when it made `updates:check` and `updates:status` `PROCESS_LOCAL`.
     *
     * A browser opening on the right machine cannot be observed from inside a
     * test, and neither can the absence of one. What *can* be observed is
     * whether the call needed the socket at all: **the server is killed, and
     * then the two halves are asked for.** A machine-local action must still
     * resolve with no server in existence; a fleet action must fail, because
     * there is genuinely nowhere for it to go.
     *
     * That second half is the control, and it is what stops the first from
     * passing for the wrong reason. Without it, "the `update.download` call
     * resolved" would be equally true of a client that was still quietly
     * attached to something.
     *
     * Red before the fix, which is the only reason it is worth running: with
     * `notifications:act` proxied wholesale, the `update.download` call is a
     * frame sent into a dead socket and rejects exactly like the `ask` does.
     *
     * ## Two deliberate choices
     *
     * `update.download` rather than `url`, because a `url` that routed
     * correctly would open a real browser window on the machine running this
     * suite. The update branch is fire-and-forget into an updater that this
     * unsigned local build cannot use, so it is observable without being felt.
     *
     * The server is restarted at the end rather than left dead. This case is
     * last today and `afterAll` would clean up either way, but a block whose
     * final state depends on nothing being added after it is a trap for
     * whoever adds 21m.
     */
    it('21l. a machine-local notification action needs no server at all (HIVE-151)', async () => {
      assert(renderer !== undefined, 'the client app must have a renderer');

      /*
        The starting state is read from `appInfo`, not from a link-status
        subscription. `onLinkStatus` pushes on *change* and replays nothing, so
        a listener installed here would sit at `null` for as long as the
        attachment held steady — which is exactly the state this case needs to
        confirm. `attachedServerName` is the standing fact rather than the
        transition, so it can be asked.
      */
      const before = await renderer.evaluate<AppInfo>('window.hive.appInfo()');
      assert(
        before.attachedServerName !== null,
        'case 21k must leave this client attached for 21l to take the server away',
      );

      /*
        The subscription is for the *drop*, which is a transition and so does
        arrive. Installed before the kill, or it would miss the one push it
        exists to see.
      */
      await renderer.evaluate(
        'window.__link151 = null; window.hive.remote.onLinkStatus((status) => { window.__link151 = status; }); true',
      );

      await stopApp(serverApp);
      serverApp = undefined;
      /*
        Asserted on a status that has actually *arrived*, not on the absence of
        one. `window.__link151` starts `null`, and `(null)?.state !== 'attached'`
        is true on the very first poll — so a negated predicate here would be
        satisfied before any push had landed, and the two calls below would race
        the client's own socket teardown rather than follow it.
      */
      await waitForAsync(
        async () => {
          const status = await renderer!.evaluate<RemoteLinkStatus | null>(
            'window.__link151 ?? null',
          );
          return status !== null && status.state !== 'attached';
        },
        'the link to notice the server has gone',
        120_000,
      );

      /*
        The control first, so a green machine-local result below cannot be read
        as "the socket was fine all along". Nothing is listening on that port;
        an `ask` resolves against a ledger thread only the server holds, so it
        has nowhere to go and must say so.
      */
      const fleet = await renderer.evaluate<string>(
        "window.hive.notifications.act({ type: 'ask', thread: 'hive-151-control' })" +
          ".then(() => 'resolved', () => 'rejected')",
      );

      const local = await renderer.evaluate<string>(
        "window.hive.notifications.act({ type: 'update.download' })" +
          ".then(() => 'resolved', () => 'rejected')",
      );

      measurements.push({
        case: '21l. HIVE-151 payload-scoped routing',
        withNoServer: { ask: fleet, 'update.download': local },
      });

      expect(
        fleet,
        `a fleet action reached something with no server running — the client's stderr so far:\n${clientRecord?.stderr || '(empty)'}`,
      ).toBe('rejected');
      expect(
        local,
        'a machine-local action was sent to the socket instead of being answered here',
      ).toBe('resolved');

      /*
        Put back, and waited for properly. `waitForListener` returns when the
        port opens, which is up to a backoff interval before the client is
        attached again — so a case added after this one would inherit a
        half-reattached client, which is the trap the reboot exists to avoid.
      */
      const rebooted = spawnApp(['--server'], serverConfigPath, serverUserDataDir);
      serverApp = rebooted.child;
      serverRecord = rebooted.record;
      await waitForListener('127.0.0.1', serverPort, 60_000);
      await waitForAsync(
        async () =>
          (await renderer!.evaluate<RemoteLinkStatus | null>(
            'window.__link151 ?? null',
          ))?.state === 'attached',
        'the client to reattach after this case put the server back',
        120_000,
      );
    }, 300_000);

    /**
     * 21m. A reattached client says again what it has on screen, so a session
     * every device is watching stays quiet (HIVE-160).
     *
     * ## What is being proved
     *
     * A reconnect is a new surface. The server released the old socket's
     * foreground record when it died, and the client's main process starts a
     * fresh `createForegroundStamp` that has nothing to re-send until its
     * renderer reports. Since HIVE-154 the inbox row asks whether **every**
     * surface is watching, so one returning client that stays silent about its
     * stage turns the quiet path off for the whole fleet: every block on a
     * session both devices are watching arrives unread and bumps the badge.
     *
     * What closes it is `useForegroundSession`, whose report is keyed on the
     * reattach epoch (HIVE-150). Its unit spec proves the effect fires; only
     * this proves the report crosses a real reattach — a fresh proxy, a fresh
     * stamp, a fresh surface id — and lands where the row's question is asked.
     *
     * ## How
     *
     * Two surfaces, one session. A is a raw socket; B is the attaching app,
     * routed through {@link openRelay} so its connection can be cut while both
     * processes and the session stay up. The control leg runs first: with both
     * watching, a block arrives already-read. Without it a green second leg
     * could not be told apart from a case that never reached the quiet path at
     * all — a window that is not in front reads as not watching, by design
     * (`isForegroundFor`).
     *
     * Then the relay cuts B, B reattaches on its own, and a second block must
     * arrive already-read with nothing clicked in between. (An earlier cut,
     * before the session is on B's stage, is only how the session reaches B's
     * store at all — see the comment at that cut.)
     *
     * Red with `reattachEpoch` taken out of `useForegroundSession`'s
     * dependencies, which is the only reason it is worth running.
     */
    it('21m. a reattached client re-states its foreground, so the fleet stays quiet (HIVE-160)', async () => {
      assert(renderer !== undefined, 'the client app must have a renderer');
      assert(credential !== null, 'case 21b must have paired this client');
      const view = renderer;
      assert(clientMain !== undefined, 'the client app must have an inspectable main process');
      const owner = clientMain;

      const relay = await openRelay(serverPort);
      // The relay closed if the attach itself fails, since the `finally` below
      // is only reached once both are open.
      const a = await openClient(`ws://127.0.0.1:${String(serverPort)}`, credential).catch(
        async (cause: unknown) => {
          await relay.close();
          throw cause;
        },
      );
      const sessionId = `reattach-foreground-${String(Date.now())}`;
      try {
        const events = a.collectEvents();
        const rows = (channel: Channel): EventFrame[] =>
          events().filter((frame) => frame.channel === channel);
        // Frames on one socket are handled in order, so a call's answer means
        // every notify sent before it on that socket has landed (case 28).
        const landedA = async (): Promise<void> => {
          expect((await a.call(CH.configGet, undefined)).kind).toBe('result');
        };
        const landedB = async (): Promise<void> => {
          await view.evaluate('window.hive.config.get()');
        };
        const nextRow = async (toolUseId: string, what: string): Promise<HiveNotification> => {
          const before = rows(CH.notificationsNew).length;
          expect((await raiseBlocked(env, sessionId, toolUseId)).status).toBe(204);
          await waitFor(() => rows(CH.notificationsNew).length > before, what);
          return rows(CH.notificationsNew).at(-1)!.payload as HiveNotification;
        };
        const cutAndReattach = async (what: string): Promise<void> => {
          const before = (await view.evaluate<RemoteLinkStatus[]>('window.__link160')).length;
          expect(relay.cut(), `B’s connection through the relay (${what})`).toBeGreaterThan(0);
          await waitForAsync(
            async () => {
              const since = (await view.evaluate<RemoteLinkStatus[]>('window.__link160')).slice(before);
              const dropped = since.findIndex((status) => status.state === 'reconnecting');
              return dropped >= 0 && since.slice(dropped).some((status) => status.state === 'attached');
            },
            `${what}: B to drop and reattach through the relay with nobody asking it to`,
            60_000,
          );
        };
        /*
          B's window counted as in front, pinned from B's main process.
          `isForegroundFor` reads a socket's own `focused`, and B's is
          `BrowserWindow.isFocused()`, which a window behind the terminal
          running this suite answers `false`. Raising it for real was tried —
          `app.focus({ steal: true })` — and did not hold through a leg: the
          window read focused, then not, before the row was raised.

          So the answer is pinned on the window objects instead, and nobody's
          front app is taken. What is under test is whether a report crosses
          the reattach at all; how a report is stamped with focus is
          `remote-foreground.ts`'s own unit spec, and pinning that one input
          leaves everything this case asserts on real.
        */
        const pinFocus = (): Promise<boolean> =>
          owner.evaluate<boolean>(`(() => {
            const { BrowserWindow } = require('electron');
            for (const window of BrowserWindow.getAllWindows()) window.isFocused = () => true;
            return BrowserWindow.getAllWindows().some((window) => window.isFocused());
          })()`);

        /*
          Off the direct port 21l left B on, and back on through the relay.
          Every link status is kept rather than the last, because a cut goes
          `reconnecting` → `attached` inside one backoff second, faster than a
          poll can promise to catch the middle of it.
        */
        const local = await view.evaluate<SetRemoteResult>(
          "window.hive.config.setRemote({ mode: 'local' })",
        );
        expect(local.config.remote.mode).toBe('local');
        await view.evaluate(
          'window.__link160 = []; window.hive.remote.onLinkStatus((status) => { window.__link160.push(status); }); true',
        );
        const viaRelay = await bounded(
          view.evaluate<SetRemoteResult>(
            `window.hive.config.setRemote({ mode: 'remote', host: '127.0.0.1', port: ${String(relay.port)} })`,
          ),
          60_000,
          'setRemote through the relay',
        );
        expect(viaRelay.switched).toMatchObject({ ok: true });

        /*
          The session, then a first cut to bring it into B's store. A switch
          made through the bridge, as above, does not hydrate the renderer:
          `applyModeChange` runs from the Settings pane that asked for it, and
          nothing asked here. A reattach does hydrate, from the snapshot its
          link status carries (`use-remote-link.ts`), with this session marked
          live. It is also a first run of the path under test, before anything
          depends on it.
        */
        await a.spawnSession(servedProjectId, sessionId);
        const env = await hookEnvOf(a, sessionId);
        await cutAndReattach('the first cut, which brings the session into B’s rail');

        /*
          B puts the session on its stage the way a person does: a click on its
          row. Clicked until the row says it is current, because the row only
          exists once the snapshot has hydrated.

          Settings first, closed if open. Case 21h opens it for real, and its
          own close is best-effort — the first button whose label mentions
          "close", which need not be Settings' own. An open Settings is a stage
          with no terminal on it (`resolveView`), so this window would report
          `null` whatever row was current behind it.
        */
        await view.evaluate(
          `document.querySelector('button[aria-label="Close settings"]')?.click(); true`,
        );
        expect(await pinFocus(), 'B’s window pinned as in front').toBe(true);
        const staged = waitForAsync(
          () =>
            view.evaluate<boolean>(`(() => {
              const row = [...document.querySelectorAll('button')].find((button) =>
                (button.textContent ?? '').includes(${JSON.stringify(sessionId)}),
              );
              if (row === undefined) return false;
              if (row.getAttribute('aria-current') === 'true') return true;
              row.click();
              return false;
            })()`),
          'the attaching app to put the session on its stage',
          60_000,
        );
        await staged.catch(async (cause: unknown) => {
          const page = await view.evaluate<string>('document.body.innerText.slice(0, 1500)');
          const history = await a.call(CH.sessionHistory, undefined);
          throw new Error(
            `${String(cause)}\n--- the server's session:history:\n${JSON.stringify(history)}` +
              `\n--- the attaching app's page text:\n${page}`,
          );
        });

        a.notify(CH.uiForeground, { terminalId: sessionId, focused: true });
        await landedA();
        /*
          The renderer reports from an effect, which runs after the commit that
          marked the row current. The settle covers that; the call behind it is
          the ordering barrier on B's own socket.
        */
        await delay(500);
        await landedB();

        // Leg 1, the control: both surfaces watching, so the fleet is quiet.
        const control = await nextRow('toolu_live_160_1', 'the control row');
        expect(control.unread, 'with both surfaces watching, the control row arrived unread').toBe(
          false,
        );

        // Leg 2: the relay drops B, and B comes back on its own.
        await cutAndReattach('the second cut');

        // Nothing on B changed: the same row is still current, and nobody clicked.
        expect(
          await view.evaluate<boolean>(
            `[...document.querySelectorAll('button[aria-current="true"]')].some((button) => (button.textContent ?? '').includes(${JSON.stringify(sessionId)}))`,
          ),
        ).toBe(true);
        await delay(500);
        await landedB();

        const afterReattach = await nextRow('toolu_live_160_2', 'the row raised after the reattach');
        measurements.push({
          case: '21m. HIVE-160 foreground after reattach',
          control: control.unread,
          afterReattach: afterReattach.unread,
        });
        expect(
          afterReattach.unread,
          'a block on a session both surfaces are watching arrived unread after B reattached — B never re-stated its foreground',
        ).toBe(false);
      } finally {
        /*
          Every step guarded, and the relay closed last whatever happened
          above it. An unguarded step that threw here — B's inspector gone
          with the app, say — would replace the failure the case actually hit
          with its own, and skip every step after it.
        */
        const quietly = async (step: () => unknown): Promise<void> => {
          try {
            await step();
          } catch {
            // Cleanup only; the case's own outcome is the one worth reporting.
          }
        };
        await quietly(() =>
          owner.evaluate(
            "(() => { for (const window of require('electron').BrowserWindow.getAllWindows()) delete window.isFocused; return true; })()",
          ),
        );
        await quietly(() => a.notify(CH.ptyWrite, { sessionId, data: 'exit\n' }));
        await quietly(() => a.close());
        /*
          Back on the direct port, so a case added after this one inherits the
          attachment 21l left rather than one through a relay that no longer
          exists.
        */
        await quietly(() => view.evaluate("window.hive.config.setRemote({ mode: 'local' })"));
        await quietly(() =>
          bounded(
            view.evaluate(
              `window.hive.config.setRemote({ mode: 'remote', host: '127.0.0.1', port: ${String(serverPort)} })`,
            ),
            60_000,
            'setRemote back to the direct port',
          ),
        );
        await relay.close();
      }
    }, 240_000);

    /**
     * 21n. HIVE-146's two e2e acceptance items, driven through the Settings pane
     * of a real attached client (HIVE-140 audit, gap 4). Until this, both were
     * proven only by component tests and channel-level cases.
     *
     * A project is added **on the server**, through the server's own folder
     * browser: the scratch folder exists only because this case made it under
     * the home the served app lists, and the project must land in the server's
     * config file and nowhere in the client's. A theme is imported **on this
     * machine**: the renderer reads the file itself, so the server's config must
     * not change by a byte.
     *
     * The file chooser is the one seam: a CDP renderer cannot answer a native
     * chooser, so `HTMLInputElement.prototype.click` is replaced for one file
     * input to set the fixture and fire `change`, exactly what a chosen file
     * does. Everything before and after it is the shipped path.
     */
    it('21n. adds a project on the server through its browser, and imports a theme on this machine only', async () => {
      assert(renderer !== undefined, 'the client app must have a renderer');
      const ui = renderer;
      const scratch = join(homedir(), `hive-live-146-${String(process.pid)}`);
      const name = basename(scratch);
      mkdirSync(scratch, { recursive: true });

      const until = (expression: string, what: string, timeoutMs = 30_000): Promise<void> =>
        waitForAsync(
          async () => {
            try {
              return await ui.evaluate<boolean>(expression);
            } catch {
              // Mid-switch the bridge has no handlers at all — see 21h's `untilUi`.
              return false;
            }
          },
          what,
          timeoutMs,
        );
      const clickButton = (text: string, scope = 'document'): Promise<unknown> =>
        ui.evaluate(
          `[...${scope}.querySelectorAll('button')].find((b) => b.textContent.trim() === ${JSON.stringify(text)}).click()`,
        );
      // Section buttons are scoped to the Settings nav: the window has other
      // buttons with the same words, and `find` takes the first.
      const NAV = `document.querySelector('[aria-label="Settings sections"]')`;
      const hasButton = (text: string, scope = 'document'): string =>
        `[...${scope}.querySelectorAll('button')].some((b) => b.textContent.trim() === ${JSON.stringify(text)})`;

      try {
        if ((await ui.evaluate<AppInfo>('window.hive.appInfo()')).attachedServerName === null) {
          await waitForAsync(
            async () => {
              const result = await ui.evaluate<SetRemoteResult>(
                `window.hive.config.setRemote({ mode: 'remote', host: '127.0.0.1', port: ${String(serverPort)} })`,
              );
              if (result.switched.ok) return true;
              if (result.switched.reason !== 'live-sessions') {
                throw new Error(`the attach was refused: ${JSON.stringify(result.switched)}`);
              }
              return false;
            },
            'the attach this case starts from',
            90_000,
          );
        }

        await ui.evaluate(`document.querySelector('button[aria-label="Settings"]').click()`);
        await until(hasButton('Advanced'), 'the Settings overlay');
        // A bridge-driven attach does not hydrate the store; Reload is the
        // control that does, answered by the server (see 21h).
        await clickButton('Advanced', NAV);
        await until(hasButton('Reload'), 'the Reload control');
        await clickButton('Reload');
        await until(`/Reloaded —/.test(document.body.innerText)`, 'a Reload answered by the server');

        // HIVE-146, first item: add a project on the mini from the laptop.
        await clickButton('Projects', NAV);
        await until(hasButton('Add project'), 'the Add project control');
        await clickButton('Add project');
        // By its title: the Settings overlay is a dialog too, and comes first.
        const DIALOG = `[...document.querySelectorAll('[role="dialog"]')].find((d) => d.innerText.includes('Choose a project folder'))`;
        await until(`/not this Mac/.test(${DIALOG}?.innerText ?? '')`, 'the picker, reading the server');
        const ROWS = `[...${DIALOG}.querySelectorAll('ul[aria-label="Folders"] button')]`;
        await until(
          `${ROWS}.some((b) => b.textContent.includes(${JSON.stringify(name)}))`,
          'the scratch folder in the server’s listing',
        );
        await ui.evaluate(`${ROWS}.find((b) => b.textContent.includes(${JSON.stringify(name)})).click()`);
        await until(
          `[...${DIALOG}.querySelectorAll('nav[aria-label="Path"] button')].some((b) => b.getAttribute('aria-current') === 'true' && b.textContent.trim() === ${JSON.stringify(name)})`,
          'the picker to descend into the scratch folder',
        );
        await clickButton('Add project', DIALOG);

        const pathsIn = (file: string): string[] =>
          ((JSON.parse(readFileSync(file, 'utf8')) as { projects?: { path?: string }[] }).projects ?? [])
            .map((project) => project.path ?? '');
        await waitForAsync(
          () => Promise.resolve(pathsIn(serverConfigPath).some((path) => path.endsWith(`/${name}`))),
          'the project to land in the server’s own config',
          30_000,
        );
        expect(pathsIn(clientConfigPath).some((path) => path.endsWith(`/${name}`))).toBe(false);
        const answered = await ui.evaluate<ConfigSnapshot>('window.hive.config.get()');
        expect(answered.projects.some((project) => project.path?.endsWith(`/${name}`) === true)).toBe(true);

        // HIVE-146, second item: a theme file on this machine, imported while attached.
        const serverBefore = readFileSync(serverConfigPath, 'utf8');
        const theme = readFileSync(
          join(import.meta.dirname, '../e2e/fixtures/nord.hive-theme.json'),
          'utf8',
        );
        await ui.evaluate(`(() => {
          const original = HTMLInputElement.prototype.click;
          HTMLInputElement.prototype.click = function () {
            if (this.type !== 'file') return original.call(this);
            HTMLInputElement.prototype.click = original;
            const chosen = new DataTransfer();
            chosen.items.add(new File([${JSON.stringify(theme)}], 'nord.hive-theme.json', { type: 'application/json' }));
            this.files = chosen.files;
            this.dispatchEvent(new Event('change', { bubbles: true }));
          };
          return true;
        })()`);
        await clickButton('Appearance', NAV);
        await until(hasButton('Import theme…'), 'the Import theme control');
        await clickButton('Import theme…');
        await until(`/imported and activated/.test(document.body.innerText)`, 'the theme to import and activate here');
        expect(readFileSync(serverConfigPath, 'utf8')).toBe(serverBefore);
      } finally {
        rmSync(scratch, { recursive: true, force: true });
      }
    }, 240_000);

    /**
     * 21o. The three proofs the HIVE-140 audit found only in mocks, all from one
     * row raised on the server while nobody watches its session:
     *
     * - HIVE-143: a server-pushed event reaches the attached client's store. Read
     *   back through the client's own dock badge, which its renderer computes
     *   from nothing but that store's unread count (`use-dock-badge.ts`).
     * - HIVE-159: the badge lands on the dock of the machine the user is looking
     *   at, the client, through `notifications:badge` answered on that machine.
     * - HIVE-145: the client raises a real OS notification for it: Electron's own
     *   `Notification.show` in the client's main process, wrapped to record the
     *   call and then let it through, rather than a mocked constructor.
     *
     * The serving half of HIVE-159, that the server's own dock stays blank, is
     * not read here: the served app in this block has no inspector, and the hub
     * no longer badging a serving machine is proven by its unit spec.
     */
    it('21o. a row raised on the server badges the client’s dock and raises its OS notification', async () => {
      assert(renderer !== undefined, 'the client app must have a renderer');
      assert(credential !== null, 'case 21b must have paired this client');
      assert(clientMain !== undefined, 'the client app must have an inspectable main process');
      const view = renderer;
      const owner = clientMain;
      const sessionId = `audit-140-${String(Date.now())}`;
      const a = await openClient(`ws://127.0.0.1:${String(serverPort)}`, credential);

      try {
        if ((await view.evaluate<AppInfo>('window.hive.appInfo()')).attachedServerName === null) {
          await waitForAsync(
            async () => {
              const result = await view.evaluate<SetRemoteResult>(
                `window.hive.config.setRemote({ mode: 'remote', host: '127.0.0.1', port: ${String(serverPort)} })`,
              );
              if (result.switched.ok) return true;
              if (result.switched.reason !== 'live-sessions') {
                throw new Error(`the attach was refused: ${JSON.stringify(result.switched)}`);
              }
              return false;
            },
            'the attach this case starts from',
            90_000,
          );
        }
        // An open Settings would be a stage with no terminal; nothing here
        // needs it, and nothing here stages the session either.
        await view.evaluate(`document.querySelector('button[aria-label="Close settings"]')?.click(); true`);

        await owner.evaluate(`(() => {
          const { Notification, app } = require('electron');
          app.dock.setBadge('');
          globalThis.__audit140Shown = [];
          globalThis.__audit140Show = Notification.prototype.show;
          Notification.prototype.show = function () {
            globalThis.__audit140Shown.push({ title: String(this.title), body: String(this.body) });
            return globalThis.__audit140Show.call(this);
          };
          return true;
        })()`);

        await a.spawnSession(servedProjectId, sessionId);
        const env = await hookEnvOf(a, sessionId);
        // Nobody reports this session in front — not A, which never sends a
        // foreground, and not B, which never staged it — so the row arrives
        // unread for every surface, which is what badges and toasts.
        expect((await raiseBlocked(env, sessionId, 'toolu_live_140_audit')).status).toBe(204);

        await waitForAsync(
          async () => (await owner.evaluate<string>("require('electron').app.dock.getBadge()")) !== '',
          'the client’s own dock to badge the row its store now holds',
          30_000,
        );
        await waitForAsync(
          async () => (await owner.evaluate<number>('globalThis.__audit140Shown.length')) > 0,
          'the client to raise a real OS notification for the row',
          30_000,
        );
        const shown = await owner.evaluate<{ title: string; body: string }[]>('globalThis.__audit140Shown');
        expect(shown[0]?.title.length ?? 0).toBeGreaterThan(0);
        measurements.push({
          case: '21o. a server row on the client’s dock and OS',
          badge: await owner.evaluate<string>("require('electron').app.dock.getBadge()"),
          shown,
        });
      } finally {
        const quietly = async (step: () => unknown): Promise<void> => {
          try {
            await step();
          } catch {
            // Best effort: a failed restore must not hide the failure above.
          }
        };
        await quietly(() =>
          owner.evaluate(`(() => {
            const { Notification, app } = require('electron');
            if (globalThis.__audit140Show) Notification.prototype.show = globalThis.__audit140Show;
            app.dock.setBadge('');
            return true;
          })()`),
        );
        await quietly(() => a.notify(CH.ptyWrite, { sessionId, data: 'exit\n' }));
        await quietly(() => a.close());
      }
    }, 240_000);
  });

  describe('a call that never settles (HIVE-144)', () => {
    it('22. is answered call-timeout at the deadline, not left hanging', async () => {
      /*
        See {@link DeadlineRun}: this call was issued from the outermost
        `beforeAll`, so the two minutes it takes have been running underneath
        every other case in this file rather than being added to the end of it.
        `CALL_DEADLINE_MS` is a hard constant in `remote-contract.ts` with no
        env override and no injectable clock, and the timer belongs to a
        separate OS process — overlapping the wait is the only way to pay for
        it that does not either weaken the assertion or add two dead minutes to
        every run.
      */
      assert(deadlineRun !== null, 'the outermost beforeAll must have fired the deadline call');
      const answer = await deadlineRun.answer;
      const elapsed = Date.now() - deadlineRun.startedAt;
      measurements.push({
        case: '22. call-timeout at the deadline',
        elapsedMs: elapsed,
        deadlineMs: CALL_DEADLINE_MS,
        answer,
      });

      expect(answer).toMatchObject({ kind: 'error', code: CALL_TIMEOUT_CODE });
      expect((answer as ErrorFrame).message).toContain(String(CALL_DEADLINE_MS));

      /*
        And it really was the deadline that answered. Without this, any error
        frame arriving in the first second — a refusal, a handler that threw —
        satisfies the code assertion above and the case says nothing about the
        timer at all. `slack:test` is a channel that genuinely fails to
        settle here (its stub `claude` sleeps past the deadline on a `-p` run,
        see {@link writeStubClaude}), so anything faster than the deadline is
        by definition a different failure wearing the same code.
      */
      expect(elapsed).toBeGreaterThanOrEqual(CALL_DEADLINE_MS);
    }, 200_000);
  });
});
