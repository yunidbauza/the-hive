import {
  BATCH_FLUSH_BYTES,
  BATCH_INTERVAL_MS,
  CH,
  HIGH_WATER_BYTES,
  LOW_WATER_BYTES,
  REPLAY_BYTES,
  RESIZE_THROTTLE_MS,
  type DataEvent,
  type ExitEvent,
  type PtyDiagnostics,
  type SessionLostEvent,
} from '@shared/ipc-contract';

import type { PtyHostSupervisor } from '../pty-host/supervisor';

/**
 * PTY IPC: batching, flow control, sequencing (story 093).
 *
 * `pty:data` is the only high-volume channel in the app. A single `pnpm build`
 * emits tens of thousands of small writes, and forwarding each as its own IPC
 * message produces two *distinct* failures that need different fixes:
 *
 * - **Message storm.** Electron IPC has real per-message overhead —
 *   serialisation, a hop through main, structured clone into the renderer.
 *   Thousands of tiny messages per second saturate the main process, which is
 *   also the thing drawing the window.
 * - **Unbounded queueing.** A pty can produce output faster than xterm can
 *   parse it. With no backpressure the queue grows without limit: memory
 *   climbs and the terminal falls further behind real time, until Ctrl-C
 *   appears to do nothing because the user is watching output from ten
 *   seconds ago.
 *
 * **Batching fixes the first. Only acknowledgement fixes the second.**
 *
 * Nothing here imports `electron`. `send` and the supervisor are injected, so
 * every timing rule below is asserted with fake timers rather than by flooding
 * a real terminal.
 */

export interface PtyIpcOptions {
  supervisor: PtyHostSupervisor;
  /** Push an event to the renderer. Injected — no `BrowserWindow` in here. */
  send: (channel: string, payload: unknown) => void;
  batchIntervalMs?: number;
  batchFlushBytes?: number;
  highWaterBytes?: number;
  lowWaterBytes?: number;
  resizeThrottleMs?: number;
  replayBytes?: number;
}

/**
 * `replay` — the events after `lastSeq`, contiguous, possibly empty.
 * `gap`    — the ring cannot reach back to `lastSeq`. The caller sends one
 *            **empty** `pty:data` stamped at {@link ResumeResult.seq}, which
 *            trips the client's own sequence assertion immediately and writes
 *            nothing to the terminal (`src/lib/terminal/pty-transport.ts`).
 * `null`   — no such session, never spawned or already exited.
 *
 * `gap` carries the channel's current head seq, and that number has exactly one
 * job: it is what the synthetic marker frame is stamped with (HIVE-143 review).
 * It is **not** a stamp for a replayed transcript — there is no transcript in
 * main to send (`PtyHostSupervisor` has no `replay`, and the only one in the
 * tree is `SessionManager`'s inside the pty-host child process, unreachable
 * without a protocol change this story does not make), and sending one would be
 * wrong besides: a client that sent `resumeFrom` has already rendered
 * everything up to `lastSeq` into its own terminal, so a transcript would
 * duplicate that output rather than fill a hole.
 *
 * Why the marker rather than nothing at all, which is what this returned
 * before: "say nothing and let the next live batch raise the notice" has no
 * branch for *there is no next batch*. A client that watched to seq 40, went
 * away, missed three megabytes and reattached to a now-idle shell would receive
 * zero frames and render its cached transcript with an unmarked hole in it —
 * and the notice, when output eventually resumed, would read as a fresh gap
 * rather than as the one its reconnect caused.
 *
 * The two variants stay distinct all the same. `replay` means "here is exactly
 * what you missed, no notice"; `gap` means "you missed more than I kept, here
 * is the discontinuity" — the caller does different things with them, and a
 * single nullable event list could not tell them apart.
 */
export type ResumeResult =
  | { kind: 'replay'; events: DataEvent[] }
  | { kind: 'gap'; seq: number };

/**
 * The `gen` every `DataEvent` this file constructs is built with (HIVE-144).
 *
 * This module is keyed by **pty session id** — `hero-refresh.g2`, per
 * generation — and never learns the entity behind one or which generation
 * counter minted it; that mapping belongs to `sessions/index.ts`'s registry,
 * on purpose (see `registry.ts`'s doc comment on why a session id's shape is
 * not an API this file gets to parse). `DataEvent.gen` is a required field
 * all the same, so every event built here needs *some* value, and `0` is
 * never it: `sessions/index.ts` unconditionally overwrites `gen` with the
 * entity's live generation on the way out — in `forward`, for a live batch,
 * and in `resume`, for a replayed one — the same way it already overwrites
 * `sessionId` with the entity id. Spelled out as a named constant, rather
 * than a bare `0` at each call site, so a reader does not mistake it for a
 * considered value.
 */
const PLACEHOLDER_GEN = { gen: 0 };

export interface PtyIpc {
  /** Called by the channel handlers once the payload has been validated. */
  spawn(request: PtySpawn): void;
  write(sessionId: string, data: string): void;
  resize(sessionId: string, cols: number, rows: number): void;
  kill(sessionId: string): void;
  ack(sessionId: string, seq: number): void;
  /**
   * What a reconnecting client missed since `lastSeq` (HIVE-143). See
   * {@link ResumeResult}.
   */
  resume(sessionId: string, lastSeq: number): ResumeResult | null;
  /**
   * The channel's current head `seq`, with no ring lookup and no replay
   * (HIVE-144).
   *
   * Exists so a caller that already knows it is not going to accept whatever
   * `resume` would answer — `sessions/index.ts`'s `resume`, on a generation
   * mismatch — can still learn where this session's stream actually is,
   * without asking `resume` to do replay-arithmetic work whose answer it is
   * about to discard, and without depending on the coincidence that `resume`
   * called with an enormous `lastSeq` happens to return the same number today
   * because of *that* function's branch order rather than because it was ever
   * asked to provide it.
   *
   * `undefined` for a session that was never spawned, or has exited — the
   * same cases {@link resume} answers `null` for.
   */
  headSeq(sessionId: string): number | undefined;
  /** Dev-only counters, surfaced through `app:info`. */
  diagnostics(): PtyDiagnostics[];
  /** Drop every timer. Called on teardown so nothing outlives the app. */
  dispose(): void;
}

/** A spawn, with everything already resolved by main (stories 090, 096). */
export interface PtySpawn {
  sessionId: string;
  shell: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
  cols: number;
  rows: number;
}

/** One outstanding batch, kept so an ack can release exactly its bytes. */
interface Outstanding {
  seq: number;
  bytes: number;
}

interface Channel {
  /** Chunks waiting for the next flush. Concatenated on the way out. */
  pending: string[];
  pendingBytes: number;
  timer: ReturnType<typeof setTimeout> | null;

  seq: number;
  outstanding: Outstanding[];
  unacked: number;
  paused: boolean;

  /**
   * Batches already sent, kept so a reconnecting socket can be given exactly
   * what it missed (HIVE-143).
   *
   * Distinct from `outstanding`, which holds *unacknowledged* byte counts for
   * flow control and is emptied by an ack. This holds *content*, and an ack
   * says nothing about whether it can be discarded: a client that acked a
   * batch and then lost its socket still needs that batch on reconnect.
   *
   * `bytes` is carried on the entry rather than re-measured on the way out
   * (HIVE-143 review). The ring accrues the batch's `pendingBytes` — the sum of
   * `Buffer.byteLength` over the individual `onData` pieces — and the trim used
   * to subtract `Buffer.byteLength(entry.chunk)`, which is the length of those
   * same pieces *joined*. Those are not the same number: a surrogate pair split
   * across two pty reads is two lone surrogates measuring 3 bytes each and one
   * astral character measuring 4 once joined, so every emoji landing on a read
   * boundary left `replayBytes` two bytes permanently high and the ring trimmed
   * that much early, for the life of the session. Storing the number that was
   * added is what makes the two sides the same measure by construction rather
   * than by two expressions agreeing.
   */
  replay: { seq: number; chunk: string; bytes: number }[];
  replayBytes: number;

  /** Held until the last data for this session has been flushed. */
  exitEvent: ExitEvent | null;
  exited: boolean;

  resizeTimer: ReturnType<typeof setTimeout> | null;
  trailingResize: { cols: number; rows: number } | null;

  bytesIn: number;
  bytesAcked: number;
  pauses: number;
  batches: number;
  dropped: number;
}

function emptyChannel(): Channel {
  return {
    pending: [],
    pendingBytes: 0,
    timer: null,
    seq: 0,
    outstanding: [],
    unacked: 0,
    paused: false,
    replay: [],
    replayBytes: 0,
    exitEvent: null,
    exited: false,
    resizeTimer: null,
    trailingResize: null,
    bytesIn: 0,
    bytesAcked: 0,
    pauses: 0,
    batches: 0,
    dropped: 0,
  };
}

export function createPtyIpc(options: PtyIpcOptions): PtyIpc {
  const {
    supervisor,
    send,
    batchIntervalMs = BATCH_INTERVAL_MS,
    batchFlushBytes = BATCH_FLUSH_BYTES,
    highWaterBytes = HIGH_WATER_BYTES,
    lowWaterBytes = LOW_WATER_BYTES,
    resizeThrottleMs = RESIZE_THROTTLE_MS,
    replayBytes = REPLAY_BYTES,
  } = options;

  const channels = new Map<string, Channel>();
  /** Messages for a session main has never heard of. Not attributable. */
  let orphanDrops = 0;

  function flush(sessionId: string, channel: Channel): void {
    if (channel.timer !== null) {
      clearTimeout(channel.timer);
      channel.timer = null;
    }

    if (channel.pending.length > 0) {
      const chunk = channel.pending.join('');
      channel.pending = [];
      const bytes = channel.pendingBytes;
      channel.pendingBytes = 0;

      channel.seq += 1;
      channel.batches += 1;
      channel.unacked += bytes;
      channel.outstanding.push({ seq: channel.seq, bytes });

      const event: DataEvent = { sessionId, chunk, seq: channel.seq, ...PLACEHOLDER_GEN };
      send(CH.ptyData, event);

      /*
        Recorded after the send, not before: what a resuming client wants is
        what was actually put on the wire, and recording first would leave a
        batch in the ring that a throwing `send` never delivered.
      */
      channel.replay.push({ seq: channel.seq, chunk, bytes });
      channel.replayBytes += bytes;
      while (channel.replayBytes > replayBytes && channel.replay.length > 0) {
        // Whole batches from the front, the way `Scrollback` drops whole
        // chunks. Slicing one in half would leave a seq that maps to a
        // fragment, and the seq is the only thing making resume possible.
        const dropped = channel.replay.shift();
        if (dropped === undefined) break;
        // The batch's own recorded `bytes`, not a fresh measurement of its
        // joined text — see `Channel.replay` for why those differ.
        channel.replayBytes -= dropped.bytes;
      }

      /**
       * Above the high-water mark, stop the producer.
       *
       * `pause()` stops the host reading the fd; the kernel pty buffer fills
       * and the producing process blocks on `write`. That is real, correct
       * backpressure — the same thing that happens when you pipe to a slow
       * consumer in a shell — rather than a queue growing somewhere the user
       * cannot see.
       */
      if (!channel.paused && channel.unacked > highWaterBytes) {
        channel.paused = true;
        channel.pauses += 1;
        supervisor.pause(sessionId);
      }
    }

    /**
     * Exit is delivered only once every pending byte has gone.
     *
     * Delivering it early truncates the last output — which is usually the
     * error message the user is about to need.
     */
    if (channel.exitEvent && channel.pending.length === 0) {
      const event = channel.exitEvent;
      channel.exitEvent = null;
      channel.exited = true;
      // The channel stays in `channels` for diagnostics, but a resumed
      // session is never coming back for this one — reclaiming the ring here
      // stops every exited session holding up to `replayBytes` for the rest
      // of the process's life on an always-on host (HIVE-143).
      channel.replay = [];
      channel.replayBytes = 0;
      send(CH.ptyExit, event);
    }
  }

  function onData({ sessionId, chunk }: { sessionId: string; chunk: string }): void {
    const channel = channels.get(sessionId);

    /**
     * The ordinary race: a session killed while output is still in flight.
     * Dropped in main with a counter rather than forwarded to a terminal that
     * no longer exists.
     */
    if (!channel) {
      orphanDrops += 1;
      return;
    }
    if (channel.exited) {
      channel.dropped += 1;
      return;
    }

    channel.pending.push(chunk);
    const bytes = Buffer.byteLength(chunk);
    channel.pendingBytes += bytes;
    channel.bytesIn += bytes;

    // The size cap keeps a firehose from building a large string before the
    // timer fires.
    if (channel.pendingBytes >= batchFlushBytes) {
      flush(sessionId, channel);
      return;
    }

    /**
     * One timer per session, not one globally: a noisy session must not delay
     * another session's echo.
     */
    if (channel.timer === null) {
      channel.timer = setTimeout(() => {
        channel.timer = null;
        flush(sessionId, channel);
      }, batchIntervalMs);
    }
  }

  function onExit(event: ExitEvent): void {
    const channel = channels.get(event.sessionId);
    if (!channel) {
      orphanDrops += 1;
      return;
    }
    // A session exits once. A second exit would arrive after the flush that
    // already closed the stream, so it is dropped rather than delivered to a
    // terminal that has already been told the process is gone.
    if (channel.exited) {
      channel.dropped += 1;
      return;
    }
    channel.exitEvent = event;
    // Flush now rather than waiting out the batch timer: the process is gone,
    // so there is nothing more coming to coalesce with.
    flush(event.sessionId, channel);
  }

  const disposers = [
    supervisor.onData(onData),
    supervisor.onExit(onExit),
    /**
     * Errors still have no renderer channel.
     *
     * Deliberate, and narrower than it looks: the errors reaching here are
     * `unknown session "x"` races and host-level failures, none of which a
     * *terminal* can act on. They are logged rather than dropped on the floor,
     * because a session that silently fails to start is indistinguishable from
     * one that started and produced nothing. Surfacing them as user-visible
     * activity is story 096's, which has a feed to put them in.
     */
    supervisor.onError((event) => {
      console.error(
        `[hive] pty error${event.sessionId ? ` (${event.sessionId})` : ''}: ${event.message}`,
      );
    }),
    /**
     * A lost session **is** forwarded (story 094).
     *
     * Story 093 could only log this, because the contract carried no event for
     * it. It does now, and the difference matters to the user: a terminal whose
     * host crashed otherwise just stops, mid-line, with no explanation and no
     * exit code — indistinguishable from a process that is simply thinking.
     */
    supervisor.onSessionLost((event) => {
      console.error(`[hive] pty session lost: ${event.sessionId} (${event.reason})`);
      const channel = channels.get(event.sessionId);
      if (!channel) {
        orphanDrops += 1;
        return;
      }
      if (channel.exited) {
        channel.dropped += 1;
        return;
      }

      /**
       * Flush first, then report the loss.
       *
       * Whatever the process managed to emit before its host died is the most
       * useful thing on screen — usually the last thing it was doing. Sending
       * the notice first would put the epitaph above the body.
       */
      flush(event.sessionId, channel);

      const lost: SessionLostEvent = {
        sessionId: event.sessionId,
        reason: event.reason,
      };
      send(CH.ptyLost, lost);

      // Its host is gone, so nothing more is coming. Marking it exited stops
      // in-flight output being delivered to a terminal that is already dead.
      channel.exited = true;
      // Same reclamation as the ordinary-exit path: nothing will ever resume
      // this session again, so the ring is dead weight on an always-on host.
      channel.replay = [];
      channel.replayBytes = 0;
    }),
  ];

  function clearTimers(channel: Channel): void {
    if (channel.timer !== null) clearTimeout(channel.timer);
    if (channel.resizeTimer !== null) clearTimeout(channel.resizeTimer);
    channel.timer = null;
    channel.resizeTimer = null;
  }

  return {
    spawn(request) {
      // A re-spawn of the same id starts a fresh accounting window; leaving
      // the old one would carry stale unacked bytes into a session that never
      // sent them and pause it for no reason.
      const existing = channels.get(request.sessionId);
      if (existing) clearTimers(existing);
      channels.set(request.sessionId, emptyChannel());
      supervisor.spawn(request);
    },

    write(sessionId, data) {
      supervisor.write(sessionId, data);
    },

    resize(sessionId, cols, rows) {
      const channel = channels.get(sessionId);
      // Resizing a session whose process is gone would reach the supervisor as
      // an unknown-session error for something the user cannot act on.
      if (!channel || channel.exited) return;

      /**
       * Leading edge immediately, then at most one per window, with a
       * **trailing** call so the final geometry always lands.
       *
       * Without the trailing call a drag ends on a stale size and the pty
       * disagrees with the terminal until the next resize — `stty size` says
       * one thing, the rendering says another.
       */
      if (channel.resizeTimer === null) {
        supervisor.resize(sessionId, cols, rows);
        channel.resizeTimer = setTimeout(function tick() {
          const trailing = channel.trailingResize;
          channel.trailingResize = null;
          if (!trailing) {
            channel.resizeTimer = null;
            return;
          }
          supervisor.resize(sessionId, trailing.cols, trailing.rows);
          channel.resizeTimer = setTimeout(tick, resizeThrottleMs);
        }, resizeThrottleMs);
        return;
      }

      channel.trailingResize = { cols, rows };
    },

    kill(sessionId) {
      supervisor.kill(sessionId);
    },

    ack(sessionId, seq) {
      const channel = channels.get(sessionId);
      if (!channel) return;

      let released = 0;
      while (channel.outstanding.length > 0 && channel.outstanding[0]!.seq <= seq) {
        released += channel.outstanding.shift()!.bytes;
      }
      if (released === 0) return;

      channel.unacked -= released;
      channel.bytesAcked += released;

      // Below the low-water mark, let the producer run again. The gap between
      // the marks is what stops pause/resume oscillating on every batch.
      if (channel.paused && channel.unacked < lowWaterBytes) {
        channel.paused = false;
        supervisor.resume(sessionId);
      }
    },

    resume(sessionId, lastSeq) {
      const channel = channels.get(sessionId);
      /*
        Never spawned, or exited. An exited channel stays in `channels` so
        `diagnostics()` can still attribute late drops to it (see `onData`),
        but there is nothing left to resume — the caller skips this session
        entirely rather than replaying a transcript for a terminal that is
        already gone.
      */
      if (channel === undefined || channel.exited) return null;

      if (lastSeq === channel.seq) return { kind: 'replay', events: [] };

      /*
        A client claiming to have seen more than was ever sent is not
        necessarily lying: a server restart resets `seq` to 0, so a client
        holding 400 from the previous process is being honest about a number
        that no longer means anything here. Treated as a gap rather than an
        error, which tells the truth on screen rather than crashing.
      */
      const oldest = channel.replay[0]?.seq;
      if (lastSeq > channel.seq || oldest === undefined || lastSeq + 1 < oldest) {
        /*
          No events to hand back, but a number the caller needs — see
          {@link ResumeResult}. `channel.seq` is where this session's stream
          actually is, and the caller stamps its one empty marker frame with it
          so the client's sequence assertion fires now rather than whenever
          output next happens.
        */
        return { kind: 'gap', seq: channel.seq };
      }

      return {
        kind: 'replay',
        events: channel.replay
          .filter((entry) => entry.seq > lastSeq)
          .map((entry) => ({ sessionId, chunk: entry.chunk, seq: entry.seq, ...PLACEHOLDER_GEN })),
      };
    },

    headSeq(sessionId) {
      return channels.get(sessionId)?.seq;
    },

    diagnostics() {
      const perSession = [...channels.entries()].map(([sessionId, channel]) => ({
        sessionId,
        bytesIn: channel.bytesIn,
        bytesAcked: channel.bytesAcked,
        unacked: channel.unacked,
        pauses: channel.pauses,
        batches: channel.batches,
        dropped: channel.dropped,
        paused: channel.paused,
      }));

      /**
       * Messages for a session main never knew about belong to no channel, so
       * they get a synthetic row rather than being silently discarded. A
       * non-zero count here means main and the host disagree about what
       * exists, which is worth seeing.
       */
      if (orphanDrops > 0) {
        perSession.push({
          sessionId: '(unknown)',
          bytesIn: 0,
          bytesAcked: 0,
          unacked: 0,
          pauses: 0,
          batches: 0,
          dropped: orphanDrops,
          paused: false,
        });
      }

      return perSession;
    },

    dispose() {
      for (const dispose of disposers) dispose();
      for (const channel of channels.values()) clearTimers(channel);
      channels.clear();
      orphanDrops = 0;
    },
  };
}
