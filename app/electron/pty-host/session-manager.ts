import { StringDecoder } from 'node:string_decoder';

import { spawn as spawnPty, type IPty } from 'node-pty';

import {
  KILL_GRACE_MS,
  MAX_SESSIONS,
  SCROLLBACK_BYTES,
  type HostMessage,
  type SpawnCommand,
} from '@shared/pty-host-protocol';

import { TERM, buildEnv } from './env';
import { Scrollback } from './scrollback';
import type { SessionOperations } from './sessions';

/**
 * The PTY session manager (story 092).
 *
 * **This is the story the whole desktop epic exists for.** Everything else is
 * plumbing around it.
 *
 * What makes a terminal real is not the renderer — xterm.js has been rendering
 * this app's fixtures since story 042. What has been missing is a kernel-level
 * pty pair behind it, with a process whose controlling terminal it is. That
 * gives, for free and without a line of UI code: SGR colour, cursor
 * addressing, the alternate screen, `SIGWINCH` on resize, `SIGINT` from
 * Ctrl-C, job control, and `isatty()` returning true so tools enable their
 * interactive paths — which is precisely why Claude Code's TUI renders at all.
 */

export interface SessionManagerOptions {
  maxSessions?: number;
  scrollbackBytes?: number;
  killGraceMs?: number;
  /** The environment sessions inherit from. Injected so tests are hermetic. */
  baseEnv?: NodeJS.ProcessEnv;
  /** Signals a process **group**. Injected so tests never signal anything. */
  killGroup?: (pid: number, signal: NodeJS.Signals) => void;
  /** Injected so tests never load the real native addon. */
  spawn?: typeof spawnPty;
}

export interface SessionManager extends SessionOperations {
  /**
   * The buffered transcript, or `null` for a session that never existed.
   *
   * The seam story 093 reaches for when a surface attaches: it sends this
   * before the first live chunk, which is what makes a late-mounting terminal
   * show what it missed.
   */
  replay(sessionId: string): string | null;
  /** Live session ids, in creation order. */
  sessionIds(): string[];
  /** Whether a session exists and has not exited. */
  isLive(sessionId: string): boolean;
}

interface Session {
  pty: IPty;
  pid: number;
  /**
   * Holds a partial multi-byte sequence until the next chunk completes it.
   *
   * Not fastidiousness — a real defect. A multi-byte character can straddle a
   * read boundary, and decoding each chunk independently turns the split
   * character into replacement characters *permanently*, since the damage
   * happens before the bytes reach xterm. A terminal running Claude Code
   * renders box-drawing characters and emoji constantly, so this is a when,
   * not an if.
   */
  decoder: StringDecoder;
  buffer: Scrollback;
  emit: (message: HostMessage) => void;
  status: 'live' | 'exited';
  /** Tracked so a redundant pause/resume cannot desynchronise the fd. */
  paused: boolean;
  cols: number;
  rows: number;
  killTimer: ReturnType<typeof setTimeout> | null;
}

/** Kill the group, not just the shell. */
function killProcessGroup(pid: number, signal: NodeJS.Signals): void {
  // Negative pid means "the process group led by pid". SIGTERM to the shell
  // alone leaves `claude` — and anything it spawned — running with a dangling
  // pty, which is the difference between quitting the app and leaving a dozen
  // agents running.
  process.kill(-pid, signal);
}

export function createSessionManager(
  options: SessionManagerOptions = {},
): SessionManager {
  const {
    maxSessions = MAX_SESSIONS,
    scrollbackBytes = SCROLLBACK_BYTES,
    killGraceMs = KILL_GRACE_MS,
    baseEnv = process.env,
    killGroup = killProcessGroup,
    spawn = spawnPty,
  } = options;

  const sessions = new Map<string, Session>();

  /**
   * Notified whenever a session reaches `exited`.
   *
   * `killAll` waits on this rather than polling: teardown is on the app's quit
   * path, where a 10ms interval is both wasteful and the kind of thing that
   * keeps an event loop alive just long enough to be confusing.
   */
  const exitWatchers = new Set<() => void>();

  function fail(
    sessionId: string,
    emit: (message: HostMessage) => void,
    message: string,
  ): void {
    emit({ type: 'error', sessionId, message });
  }

  /** Signal a group, tolerating a process that is already gone. */
  function signal(session: Session, sig: NodeJS.Signals): void {
    try {
      killGroup(session.pid, sig);
    } catch {
      // ESRCH — it died between the decision and the signal. Nothing to do,
      // and certainly nothing to fail the app over.
    }
  }

  function clearKillTimer(session: Session): void {
    if (session.killTimer === null) return;
    clearTimeout(session.killTimer);
    session.killTimer = null;
  }

  function handleExit(
    sessionId: string,
    session: Session,
    exitCode: number,
    exitSignal?: number,
  ): void {
    // A process exits once, but nothing about `onExit` guarantees the event
    // fires once. A second `exit` message would break story 093's ordering
    // contract, which promises exit lands after the final data flush — twice
    // means the second one lands after nothing.
    if (session.status === 'exited') return;

    clearKillTimer(session);

    // Flush whatever the decoder was still holding, so a transcript never ends
    // mid-character.
    const tail = session.decoder.end();
    if (tail !== '') {
      session.buffer.push(tail);
      session.emit({ type: 'data', sessionId, chunk: tail });
    }

    session.status = 'exited';

    /**
     * The buffer is **retained**, not cleared.
     *
     * A terminal that empties itself the instant a process dies destroys the
     * error the user needed to read. Cleanup happens when the user closes the
     * session, not when the process ends.
     */
    session.emit({ type: 'exit', sessionId, exitCode, signal: exitSignal });

    for (const watcher of [...exitWatchers]) watcher();
  }

  return {
    spawn(command: SpawnCommand, emit) {
      const { sessionId, shell, args, cwd, cols, rows } = command;

      if (sessions.has(sessionId)) {
        fail(sessionId, emit, `session "${sessionId}" already exists`);
        return;
      }

      /**
       * The cap counts **live** sessions, not registry entries.
       *
       * Exited entries are retained on purpose — their transcript is the error
       * the user still needs to read — but they own no process. Counting them
       * would mean an app that has opened and closed 24 sessions over a long
       * session can never open a 25th, with a message blaming a limit that
       * nothing is currently using.
       */
      const live = [...sessions.values()].filter(
        (session) => session.status === 'live',
      ).length;

      if (live >= maxSessions) {
        // Refused with a clear error rather than letting the app fork-bomb a
        // laptop.
        fail(
          sessionId,
          emit,
          `session limit reached (${maxSessions}) — close a session before opening another`,
        );
        return;
      }

      let pty: IPty;
      try {
        pty = spawn(shell, args, {
          // `TERM` in the child. See `env.ts` — the single most consequential
          // option here.
          name: TERM,
          cwd,
          env: buildEnv(baseEnv, cwd, command.env),
          cols: Math.max(1, cols),
          rows: Math.max(1, rows),
          /**
           * Buffers rather than strings, decoded through a per-session
           * `StringDecoder`. See {@link Session.decoder} — this is what stops
           * a character split across a read boundary becoming permanent
           * mojibake.
           */
          encoding: null,
        });
      } catch (cause) {
        fail(
          sessionId,
          emit,
          `could not start ${shell} in ${cwd}: ${cause instanceof Error ? cause.message : String(cause)}`,
        );
        return;
      }

      const session: Session = {
        pty,
        pid: pty.pid,
        decoder: new StringDecoder('utf8'),
        buffer: new Scrollback(scrollbackBytes),
        emit,
        status: 'live',
        paused: false,
        cols: Math.max(1, cols),
        rows: Math.max(1, rows),
        killTimer: null,
      };
      sessions.set(sessionId, session);

      pty.onData((chunk: string | Buffer) => {
        // node-pty types `onData` as `string`, but `encoding: null` yields
        // Buffers — the one option its types do not model. Both are handled
        // rather than asserting away the discrepancy.
        const text = session.decoder.write(
          typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk,
        );
        if (text === '') return;
        session.buffer.push(text);
        session.emit({ type: 'data', sessionId, chunk: text });
      });

      pty.onExit(({ exitCode, signal: exitSignal }) => {
        handleExit(sessionId, session, exitCode, exitSignal);
      });

      emit({ type: 'spawned', sessionId, pid: pty.pid });
    },

    write(sessionId, data) {
      const session = sessions.get(sessionId);
      if (!session || session.status !== 'live') return;
      /**
       * Straight through. No interpretation, no line handling, no echo — the
       * pty and the shell own all of that. A transport that helpfully appended
       * a newline would break every interactive prompt.
       */
      session.pty.write(data);
    },

    resize(sessionId, cols, rows) {
      const session = sessions.get(sessionId);
      if (!session || session.status !== 'live') return;

      /**
       * **Dropped, not clamped** — found by the conformance suite (story 098).
       *
       * xterm reports 0 transiently while its container is hidden or
       * mid-layout, and resizing a pty to zero columns puts curses
       * applications into states they do not recover from. That much was
       * always right. Clamping to 1 was not: a 1×1 pty is not a recovery, it
       * is the same catastrophe one column wider — and nothing ever resizes it
       * back, because the *renderer's* own geometry never changed, so it has
       * no reason to send anything new. The session is simply ruined until
       * something else happens to resize it.
       *
       * A nonsensical size is not a request to be honoured approximately; it
       * is a frame of bad measurement to be ignored. Story 098's matrix says
       * so directly: "zero-size resizes are dropped → geometry unchanged".
       */
      const nextCols = Math.floor(cols);
      const nextRows = Math.floor(rows);
      if (!Number.isFinite(nextCols) || !Number.isFinite(nextRows)) return;
      if (nextCols < 1 || nextRows < 1) return;

      // A no-op resize is still a SIGWINCH to the child, and a redraw.
      if (nextCols === session.cols && nextRows === session.rows) return;

      session.cols = nextCols;
      session.rows = nextRows;
      session.pty.resize(nextCols, nextRows);
    },

    kill(sessionId, sig = 'SIGTERM') {
      const session = sessions.get(sessionId);
      if (!session || session.status !== 'live') return;

      signal(session, sig as NodeJS.Signals);

      // Ask, wait, then insist. A process that ignores SIGTERM must not be
      // able to keep the app alive or leave a pty dangling.
      clearKillTimer(session);
      session.killTimer = setTimeout(() => {
        session.killTimer = null;
        if (session.status !== 'live') return;
        signal(session, 'SIGKILL');
      }, killGraceMs);
    },

    pause(sessionId) {
      const session = sessions.get(sessionId);
      if (!session || session.status !== 'live' || session.paused) return;
      session.paused = true;
      // Stops reading the fd. The kernel pty buffer fills and the producing
      // process blocks on write — the same thing that happens when you pipe to
      // a slow consumer in a shell.
      session.pty.pause();
    },

    resume(sessionId) {
      const session = sessions.get(sessionId);
      if (!session || session.status !== 'live' || !session.paused) return;
      session.paused = false;
      session.pty.resume();
    },

    async killAll() {
      const live = [...sessions.values()].filter(
        (session) => session.status === 'live',
      );
      if (live.length === 0) return;

      for (const session of live) {
        clearKillTimer(session);
        signal(session, 'SIGTERM');
      }

      const allGone = () => live.every((session) => session.status !== 'live');

      await new Promise<void>((resolve) => {
        if (allGone()) {
          resolve();
          return;
        }

        const finish = () => {
          clearTimeout(timer);
          exitWatchers.delete(watcher);
          resolve();
        };

        const timer = setTimeout(() => {
          // Grace expired. Anything still alive gets SIGKILL, and the app
          // stops waiting on it — "the app would not quit" is worse than "one
          // teardown step was abrupt".
          for (const session of live) {
            if (session.status === 'live') signal(session, 'SIGKILL');
          }
          finish();
        }, killGraceMs);

        const watcher = () => {
          if (allGone()) finish();
        };

        exitWatchers.add(watcher);
      });
    },

    replay(sessionId) {
      return sessions.get(sessionId)?.buffer.read() ?? null;
    },

    sessionIds: () => [...sessions.keys()],

    isLive: (sessionId) => sessions.get(sessionId)?.status === 'live',
  };
}
