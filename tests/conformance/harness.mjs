import { strict as assert } from 'node:assert';
import { execFileSync } from 'node:child_process';
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
 * backgrounds — `pnpm dev &` — survives the group kill on its own.
 *
 * That was recorded here as an open hole under HIVE-49, and **it is no longer
 * one**: HIVE-72's descendant sweep in `process-tree.ts` walks `ps` rather than
 * the process group, so it reaches a job whatever group it escaped into. The
 * `descendants` group measures exactly that, on the per-tab `kill` path as well
 * as `killAll`, and it is mutation-verified — disabling `sweep` fails all three
 * of its assertions with five of five escaped children outliving their session.
 *
 * What stays true is the division of labour this helper encodes: `set +m` keeps
 * *this* helper testing the group kill in isolation, so a regression in the
 * group signal and a regression in the sweep fail different tests. Use
 * {@link startEscapedGrandchild} for the sweep.
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

/**
 * Start a long-lived grandchild that **escapes the shell's process group**.
 *
 * The counterpart to {@link startGrandchild}, and the difference is one
 * character: job control is left **on** (`set -m`) rather than turned off, so
 * `&` puts the job in a process group of its own. `kill(-shellPid)` cannot
 * reach it — which is the whole point.
 *
 * ## Why this shape is the one that matters
 *
 * It is what an agent's own long-lived children look like. A `claude` that
 * starts an MCP server gets a process tree the session shell's group kill does
 * not cover on its own, and the failure mode is silent: the tab closes, the
 * terminal disappears, and the server keeps running — holding memory, holding
 * whatever single-consumer resource it claimed, and invisible to the app that
 * started it.
 *
 * `startGrandchild`'s `set +m` was deliberate — it isolates "is the *group*
 * signalled?" from "is the *tree* swept?" — but it means every existing
 * no-descendant assertion passes against an implementation that only ever
 * group-kills. This helper is what exercises HIVE-72's descendant sweep.
 *
 * Returns `{ pid, pgid }`, and callers should assert the pgid actually differs
 * from the shell's: a shell that decided it was non-interactive would leave the
 * job in the shell's group, quietly turning this into a duplicate of the easier
 * test rather than failing.
 */
export async function startEscapedGrandchild(session, scratch, name) {
  const pidFile = join(scratch, `${name}.pid`);

  /**
   * `set -m` rather than trusting the default.
   *
   * An interactive shell enables job control on its own, and the shell here is
   * on a real pty so it should qualify — but "should" is how a test quietly
   * stops testing anything. Asking for it explicitly means the pgid assertion
   * below is measuring the implementation rather than the shell's mood.
   *
   * `trap "" HUP` for the same reason as `startGrandchild`: without an ignored
   * disposition the kernel's SIGHUP to the foreground group on session-leader
   * death kills this anyway, and the assertion passes against an
   * implementation that sweeps nothing.
   */
  session.send(
    `set -m; sh -c 'trap "" HUP; echo $$ > "${pidFile}"; exec sleep 100' &`,
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

  const pgid = pgidOf(pid);

  /**
   * An unreadable pgid fails here rather than travelling as `null`.
   *
   * The callers' guard is `assert.notEqual(child.pgid, shellPgid)`, and
   * `null !== 8463` passes — so a `ps` that failed, or a child that died before
   * it could be read, would silently satisfy the one assertion that exists to
   * prove this helper did its job. A guard that cannot fail is worse than no
   * guard, because it reads like one.
   */
  assert.equal(
    typeof pgid,
    'number',
    `could not read the process group of ${name} (pid ${pid}) — without it the ` +
      'escape guard in the calling test would pass vacuously',
  );

  return { pid, pgid };
}

/**
 * The process group a pid belongs to, or `null` if it has already gone.
 *
 * Shells out to `ps` for the same reason `process-tree.ts` does: Node exposes
 * no way to read another process's group, and this suite's whole subject is
 * what the kernel thinks rather than what the app believes.
 */
export function pgidOf(pid) {
  try {
    const text = execFileSync('/bin/ps', ['-p', String(pid), '-o', 'pgid='], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    return /^\d+$/.test(text) ? Number(text) : null;
  } catch {
    return null;
  }
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
