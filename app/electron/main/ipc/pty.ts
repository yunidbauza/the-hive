import {
  BATCH_FLUSH_BYTES,
  BATCH_INTERVAL_MS,
  CH,
  HIGH_WATER_BYTES,
  LOW_WATER_BYTES,
  RESIZE_THROTTLE_MS,
  type DataEvent,
  type ExitEvent,
  type PtyDiagnostics,
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
}

export interface PtyIpc {
  /** Called by the channel handlers once the payload has been validated. */
  spawn(request: PtySpawn): void;
  write(sessionId: string, data: string): void;
  resize(sessionId: string, cols: number, rows: number): void;
  kill(sessionId: string): void;
  ack(sessionId: string, seq: number): void;
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

      const event: DataEvent = { sessionId, chunk, seq: channel.seq };
      send(CH.ptyData, event);

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
     * Errors and lost sessions have **no renderer channel yet**.
     *
     * The contract carries no error event, and the terminal that writes
     * `SESSION_LOST_NOTICE` is story 095's surface. Until then they are logged
     * rather than dropped on the floor: a session that silently fails to start
     * is indistinguishable from one that started and produced nothing, and
     * that is the harder bug to chase.
     */
    supervisor.onError((event) => {
      console.error(
        `[hive] pty error${event.sessionId ? ` (${event.sessionId})` : ''}: ${event.message}`,
      );
    }),
    supervisor.onSessionLost((event) => {
      console.error(`[hive] pty session lost: ${event.sessionId} (${event.reason})`);
      const channel = channels.get(event.sessionId);
      // Its host is gone, so nothing more is coming. Marking it exited stops
      // in-flight output being delivered to a terminal that is already dead.
      if (channel) channel.exited = true;
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
