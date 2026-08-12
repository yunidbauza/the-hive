import { strict as assert } from 'node:assert';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createSessionManager } from '../../out/main/session-manager.js';

/**
 * The conformance harness (story 098).
 *
 * A test runner is not the interesting part of this suite and gets no more code
 * than it needs. What it does own is the **discipline** the story requires, in
 * one place so no individual assertion can forget it:
 *
 * - every wait is a polled predicate with a deadline, never a fixed sleep;
 * - every test gets a scratch directory under the OS temp dir, removed after;
 * - every session is killed in teardown and its **process group asserted gone**,
 *   so a leak fails the test that caused it rather than a later one.
 *
 * It drives the real session manager from story 092 — the built one, under
 * Electron's ABI — because a suite that talked to its own pty wrapper would
 * prove that wrapper works and nothing about the product.
 */

export { assert };

/** Registered groups, in declaration order. The runner reads this. */
export const groups = [];

let current = null;

export function describe(name, fn) {
  current = { name, tests: [] };
  groups.push(current);
  fn();
  current = null;
}

export function it(name, fn) {
  if (!current) throw new Error(`it("${name}") outside a describe`);
  current.tests.push({ name, fn });
}

/**
 * Poll a predicate to a deadline.
 *
 * The only waiting primitive in the suite. Real processes decide when they are
 * ready, and a fixed sleep encodes the author's machine speed as the contract —
 * too short and it flakes in CI, too long and the suite stops being cheap
 * enough to run on every push.
 */
export async function waitFor(predicate, { timeout = 5_000, interval = 20, message } = {}) {
  const deadline = Date.now() + timeout;
  let last;
  for (;;) {
    try {
      last = await predicate();
      if (last) return last;
    } catch (cause) {
      last = cause;
    }
    if (Date.now() >= deadline) {
      throw new Error(
        `timed out after ${timeout}ms waiting for ${message ?? 'predicate'}` +
          (last instanceof Error ? `: ${last.message}` : ''),
      );
    }
    await new Promise((resolve) => setTimeout(resolve, interval));
  }
}

/**
 * A shell fragment that prints `token`, without containing `token` literally.
 *
 * **The trap this exists for catches every conformance suite once.** A pty
 * echoes what is typed into it, so `echo ALL-DONE` puts `ALL-DONE` in the
 * transcript *immediately* — before the command has run, and before any of the
 * output the sentinel was meant to mark the end of. A test that waits for it
 * proceeds instantly and asserts against a fifth of the output, which looks
 * like data loss and is nothing of the sort.
 *
 * Splitting the token across a quote boundary defeats that: the shell
 * concatenates the halves and prints the whole thing, while the echoed command
 * line contains only `ALL""-DONE`.
 */
export function emitSentinel(token) {
  const cut = Math.max(1, Math.floor(token.length / 2));
  return `echo "${token.slice(0, cut)}""${token.slice(cut)}"`;
}

/**
 * Start a long-lived **grandchild** and return its pid.
 *
 * The pid comes back through a file rather than `$!`, deliberately. `$!` is
 * only meaningful where the shell has job control enabled, which varies by
 * shell, by platform and by whether the shell considers itself interactive —
 * and a suite that silently measures nothing on one of those combinations is
 * worse than no suite. The process writes its own `$$`, which is true
 * everywhere.
 *
 * A grandchild, not the shell itself, because the property under test is that
 * the whole **process group** is signalled: SIGTERM to the shell alone leaves
 * `claude` — and anything it spawned — running with a dangling pty.
 *
 * ## `set +m`, and the gap it marks
 *
 * Job control is turned **off** for the backgrounding, so the grandchild stays
 * in the shell's process group — which is what `claude` does, since the
 * bootstrap runs it in the foreground, and therefore what these tests are about.
 *
 * With job control left on (an interactive shell's default) `&` puts the job in
 * a **new process group of its own**, and `kill(-shellPid)` does not reach it:
 * measured at 8480 against the shell's 8463. So a process the user explicitly
 * backgrounds — `pnpm dev &` — survives both `kill` and app shutdown. That is a
 * real hole in "no orphans on shutdown", it is **not** fixed by this story, and
 * it is recorded on HIVE-49 rather than papered over here. Closing it means
 * signalling the pty's *session* rather than one process group, which is a
 * product change with its own risks.
 */
export async function startGrandchild(session, scratch, name) {
  const pidFile = join(scratch, `${name}.pid`);
  /**
   * `trap '' HUP` is what makes this test test anything.
   *
   * When the session leader dies the kernel sends SIGHUP to the controlling
   * terminal's foreground process group, so a plain grandchild dies whether or
   * not the *group* was signalled — and the assertion passes against an
   * implementation that only ever signals the shell. Verified: mutating
   * `kill(-pid)` to `kill(pid)` was caught only after this was added.
   *
   * An ignored disposition survives `exec`, which a handler would not, so the
   * `sleep` that replaces this shell inherits the immunity.
   */
  session.send(
    `set +m; sh -c 'trap "" HUP; echo $$ > "${pidFile}"; exec sleep 100' &`,
  );

  const pid = await waitFor(
    () => {
      if (!existsSync(pidFile)) return null;
      const text = readFileSync(pidFile, 'utf8').trim();
      return /^\d+$/.test(text) ? Number(text) : null;
    },
    { message: `${name} to record its pid` },
  );

  await waitFor(() => isAlive(pid), { message: `${name} (${pid}) to be running` });
  return pid;
}

/** Is this pid still around? `kill -0` asks without signalling anything. */
export function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * A live session, plus everything a test needs to interrogate it.
 *
 * `sh` is the default rather than the user's `$SHELL` wherever the shell's
 * identity is not the subject: zsh and bash differ in prompt behaviour and
 * startup output, and a suite that passes only on the author's machine is
 * worthless.
 */
export function createContext() {
  const manager = createSessionManager();
  const scratch = mkdtempSync(join(tmpdir(), 'hive-conformance-'));
  const opened = [];
  let counter = 0;

  function open({
    shell = '/bin/sh',
    args = [],
    cwd = scratch,
    env = {},
    cols = 80,
    rows = 24,
  } = {}) {
    const sessionId = `s${(counter += 1)}`;
    const state = {
      sessionId,
      cwd,
      output: '',
      chunks: [],
      pid: null,
      exit: null,
      errors: [],
    };

    manager.spawn(
      { type: 'spawn', sessionId, shell, args, cwd, env, cols, rows },
      (message) => {
        switch (message.type) {
          case 'spawned':
            state.pid = message.pid;
            return;
          case 'data':
            state.chunks.push(message.chunk);
            state.output += message.chunk;
            return;
          case 'exit':
            state.exit = { code: message.exitCode, signal: message.signal };
            return;
          case 'error':
            state.errors.push(message.message);
        }
      },
    );

    const session = {
      ...state,
      get output() {
        return state.output;
      },
      get chunks() {
        return state.chunks;
      },
      get pid() {
        return state.pid;
      },
      get exit() {
        return state.exit;
      },
      get errors() {
        return state.errors;
      },
      /** Type a line, the way a person would: text then carriage return. */
      send: (line) => manager.write(sessionId, `${line}\r`),
      write: (data) => manager.write(sessionId, data),
      resize: (c, r) => manager.resize(sessionId, c, r),
      kill: (signal) => manager.kill(sessionId, signal),
      pause: () => manager.pause(sessionId),
      resume: () => manager.resume(sessionId),
      replay: () => manager.replay(sessionId),
      clear: () => {
        state.output = '';
        state.chunks.length = 0;
      },
      /**
       * Wait until the accumulated output matches.
       *
       * On timeout the error carries the tail of what actually arrived. A CI
       * failure that says only "timed out waiting for TTY-YES" sends someone
       * to a machine with a terminal; one that shows the last 600 bytes of the
       * transcript usually explains itself.
       */
      waitForOutput: (pattern, options = {}) =>
        waitFor(
          () =>
            (typeof pattern === 'string'
              ? state.output.includes(pattern)
              : pattern.test(state.output)) || false,
          {
            ...options,
            message: `output to match ${pattern}\n  --- last 600 bytes seen ---\n${JSON.stringify(
              state.output.slice(-600),
            )}\n  --- end ---`,
          },
        ),
      waitForExit: (options = {}) =>
        waitFor(() => state.exit, { message: 'the process to exit', ...options }),
    };

    opened.push(session);
    return session;
  }

  /**
   * Wait for a session's shell to be genuinely ready for input.
   *
   * A shell that has not installed its line discipline discards what is written
   * to it, so a test that types too early fails in a way that looks exactly
   * like the feature being broken. Asking it to echo a token and waiting for
   * the answer is the only honest readiness signal — a prompt is not one,
   * because `PS1` differs per shell and per platform.
   */
  async function ready(session) {
    await waitFor(() => session.output.length > 0, {
      message: 'the shell to say anything',
    });
    session.send('echo hive-ready-marker');
    await session.waitForOutput(/hive-ready-marker[\s\S]*hive-ready-marker/, {
      timeout: 8_000,
    });
    session.clear();
    return session;
  }

  async function dispose() {
    /**
     * Kill everything, then prove it is gone.
     *
     * The most important few lines in the suite. A leaked `claude` outlives the
     * app, consumes tokens invisibly, and can write to a repository — so a leak
     * must fail the test that caused it, not a later one, and not nothing.
     */
    const pids = opened.map((session) => session.pid).filter((pid) => pid !== null);
    for (const session of opened) {
      try {
        session.kill('SIGKILL');
      } catch {
        // Already gone. Nothing to do, and nothing to fail a test over.
      }
    }

    const leaked = [];
    for (const pid of pids) {
      try {
        await waitFor(() => !isAlive(pid), {
          timeout: 5_000,
          message: `pid ${pid} to exit`,
        });
      } catch {
        leaked.push(pid);
      }
    }

    rmSync(scratch, { recursive: true, force: true });

    if (leaked.length > 0) {
      throw new Error(
        `leaked ${leaked.length} process(es) after teardown: ${leaked.join(', ')}`,
      );
    }
  }

  return { manager, scratch, open, ready, dispose };
}
