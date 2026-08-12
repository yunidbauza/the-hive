
import type { TermColor } from '@/types/terminal';


import { colorize } from '@lib/terminal/ansi';
import { signalName } from '@lib/terminal/signals';
import type {
  TerminalDataHandler,
  TerminalTransport,
} from '@lib/terminal/terminal-transport';
import { CLONE_ENTITY_ID } from '@shared/config-contract';
import type {
  SessionEffort,
  SessionModel,
  SessionTheme,
} from '@shared/session-contract';

/**
 * The desktop transport: a real PTY, behind the same three methods (story 094).
 *
 * This module is the claim the architecture has been making since story 042 —
 * that swapping the backend touches `src/lib/terminal/` and nothing else —
 * being cashed in. Two things about it are load-bearing:
 *
 * - **It reads no store.** `StaticTransport` does, and the lint zone permits it
 *   here too; this file must not, and the fence cannot enforce that. Session and
 *   project ids arrive as arguments. Everything else is the bridge.
 * - **The interface did not grow a method.** It grew one *optional argument* to
 *   the data callback (`parsed`), for a reason documented on
 *   `TerminalDataHandler` and surfaced loudly rather than slipped in: story
 *   093's flow control is meaningless without an ack, and no layer but the
 *   surface knows when xterm has parsed a chunk.
 */

/**
 * Geometry for the very first spawn.
 *
 * The transport has no viewport — it is not a component and never measures
 * anything. 80×24 is the conventional default a shell assumes when nothing tells
 * it otherwise, and it is corrected within a frame: `TerminalSurface`'s
 * `ResizeObserver` fires on mount and calls `resize` with the real size. The
 * alternative — plumbing geometry into a factory that has no business knowing
 * it — would put a layout concern in the transport permanently to save one
 * `SIGWINCH` once.
 */
const DEFAULT_COLS = 80;
const DEFAULT_ROWS = 24;

/**
 * How much output is kept per entity for a surface that subscribes late.
 *
 * Counted in **UTF-16 code units**, not UTF-8 bytes, and the distinction is
 * deliberate. What is being bounded here is a JavaScript string held in the
 * renderer's heap, which costs about two bytes per code unit regardless of how
 * the same text would encode on the wire. `Buffer.byteLength` is the right
 * measure in main, where the thing being counted really is a byte buffer; using
 * it here would under-count a box-drawing TUI by a factor of three and bound
 * the wrong quantity.
 *
 * A count rather than a line cap for the obvious reason: a single `pnpm build`
 * line can be kilobytes wide, and a line-capped buffer bounds nothing.
 */
const REPLAY_UNITS = 256 * 1024;

/**
 * A lifecycle line, written into the transcript rather than rendered as chrome.
 *
 * These belong to the terminal, in the place and order they happened — a React
 * banner beside the terminal would float to the bottom and lose its position in
 * the story the transcript is telling.
 *
 * The leading CRLF is not decoration. A pty's last output routinely ends
 * mid-line (a prompt, a progress bar), and appending to it would produce
 * `$ ── session exited ──`.
 */
function notice(text: string, color: TermColor): string {
  return `\r\n${colorize(`── ${text} ──`, color)}\r\n`;
}

/**
 * Colour by what the user has to *do* about it, not by severity theatre.
 *
 * A clean exit is dim: it is the expected end of a program and needs no
 * attention. A non-zero code and an abnormal termination are amber — something
 * finished badly and the transcript above it is worth reading; the story
 * specifies amber for the non-zero case and this extends the same reading to
 * signals, which are the same class of outcome. A lost host is red because it
 * is the only one of these that is *our* fault rather than the program's: no
 * conclusion was reached, and the output above it may simply stop mid-thought.
 *
 * `TERM.amber` — not `--cc-amber`. They are different values in different
 * systems, and only one of them has a path to a terminal cell (see `ansi.ts`).
 */
const EXITED = notice('session exited', 'dim');
const LOST = notice('session lost (pty host crashed)', 'red');
const GAP = notice('output gap detected', 'amber');

const exitedWithCode = (code: number): string =>
  notice(`session exited (code ${code})`, 'amber');

const terminatedBy = (signal: number): string =>
  notice(`session terminated (${signalName(signal)})`, 'amber');

const spawnRefused = (reason: string): string => notice(reason, 'red');

/**
 * Everything the renderer knows about one entity's PTY.
 *
 * Shared per entity, not per subscriber, because **two surfaces bound to one
 * session must both receive output and neither may spawn a second process**.
 * The prototype already mounts a session's terminal in more than one place, and
 * a per-subscriber spawn would fork a second `claude` in the same repository —
 * a data-loss bug wearing a rendering bug's clothes.
 */
interface EntityChannel {
  subscribers: Set<TerminalDataHandler>;
  /**
   * The transcript so far, for a surface that mounts late.
   *
   * Held here rather than fetched from the host's replay buffer on demand. The
   * host's copy exists for a renderer that was never running (story 092); this
   * one exists for a tab switch, and it is both exact and *synchronous* — a
   * replay that resolved asynchronously would interleave with live chunks
   * arriving in the meantime, and the transcript would come out shuffled.
   */
  buffer: string[];
  /** Size of {@link buffer} in UTF-16 code units. See {@link REPLAY_UNITS}. */
  bufferUnits: number;
  /** Last `seq` seen, for gap detection. `null` until the first chunk. */
  lastSeq: number | null;
  /**
   * A spawn has been requested. Never reset — not even after an exit or a lost
   * host.
   *
   * This is what makes `ensureSpawned` idempotent *and* keeps the transport from
   * auto-respawning. Unmounting a surface happens on every tab switch; if a
   * remount could restart a dead session, navigating past a finished agent would
   * silently start it working again. Restarting is an explicit user action
   * (story 096).
   */
  spawnRequested: boolean;
  /**
   * The in-flight (or settled) spawn request, shared by every caller.
   *
   * `spawnRequested` answers "has one been asked for"; this answers "how did
   * it go", which is what a console that must print main's refusal needs
   * (story 097). Held on the channel rather than in a second map, so the two
   * can never disagree about whether a process was asked for.
   */
  spawnResult: Promise<SpawnOutcome> | null;
  /** The process is gone. Further data for this id is stale and dropped. */
  closed: boolean;
  /** Drops this channel's three bridge subscriptions. Test-only. */
  dispose: () => void;
}

const channels = new Map<string, EntityChannel>();

function pty(): NonNullable<Window['hive']>['pty'] {
  const bridge = window.hive;
  // Unreachable through `resolveTransport`, which branches on `isDesktop()`.
  // Explicit anyway: the alternative is a TypeError from inside a keystroke
  // handler, which reads as an xterm bug.
  if (!bridge) throw new Error('pty transport requires the desktop bridge');
  return bridge.pty;
}

/** Deliver to every subscriber, and remember it for the next one to arrive. */
function emit(channel: EntityChannel, chunk: string, parsed?: () => void): void {
  channel.buffer.push(chunk);
  channel.bufferUnits += chunk.length;
  while (channel.bufferUnits > REPLAY_UNITS && channel.buffer.length > 1) {
    channel.bufferUnits -= channel.buffer.shift()!.length;
  }

  /**
   * Every subscriber is handed the *same* `parsed`, so the first one to finish
   * parsing releases the batch for all of them.
   *
   * Harmless today and worth knowing about tomorrow. `TerminalHost` mounts one
   * surface per entity, so there is only ever one; and main's `ack` is
   * idempotent, so a second call releases nothing rather than corrupting the
   * window. If split panes ever put two live surfaces on one session, this
   * becomes "backpressure follows the fastest pane" — at which point the ack
   * needs to wait for the slowest, not the first.
   */
  // Copied before iterating: a subscriber may dispose itself from inside its
  // own callback, and mutating the set mid-iteration would skip its neighbour.
  for (const subscriber of [...channel.subscribers]) subscriber(chunk, parsed);
}

function openChannel(entityId: string): EntityChannel {
  const channel: EntityChannel = {
    subscribers: new Set(),
    buffer: [],
    bufferUnits: 0,
    lastSeq: null,
    spawnRequested: false,
    spawnResult: null,
    closed: false,
    dispose: () => {},
  };

  const bridge = pty();

  const disposers = [
    bridge.onData((event) => {
      // One `pty:data` channel carries every session (story 082 — a channel per
      // session would make the allowlist dynamic), so the filter is not an
      // optimisation, it is correctness.
      if (event.sessionId !== entityId) return;
      if (channel.closed) return;

      /**
       * A skipped sequence number means a batch was lost between main and here.
       * Saying so is the whole point: a terminal that quietly drops a batch
       * renders output that never existed in that order, and the user debugs
       * something that never happened.
       */
      if (channel.lastSeq !== null && event.seq !== channel.lastSeq + 1) {
        emit(channel, GAP);
      }
      channel.lastSeq = event.seq;

      /**
       * The ack is deferred to whoever renders this chunk. See
       * `TerminalDataHandler`: acking here would confirm delivery to a
       * *transport*, and the question flow control is asking is whether the
       * terminal is keeping up.
       */
      emit(channel, event.chunk, () => {
        bridge.ack({ sessionId: entityId, seq: event.seq });
      });
    }),

    bridge.onExit((event) => {
      if (event.sessionId !== entityId) return;
      if (channel.closed) return;
      channel.closed = true;

      /**
       * `0` means *no signal*, and it arrives far more often than `undefined`.
       *
       * `node-pty` reports a numeric signal on every exit and uses zero for
       * "the process just ended", which main forwards unchanged. Testing only
       * for `undefined` sends every ordinary exit down the signal branch, and
       * the terminal reports `session terminated (signal 0)` where it should
       * have said `session exited (code 3)` — which is exactly what the desktop
       * e2e caught, and what no amount of stubbing the bridge would have.
       */
      if (event.signal !== undefined && event.signal !== 0) {
        emit(channel, terminatedBy(event.signal));
        return;
      }
      emit(channel, event.exitCode === 0 ? EXITED : exitedWithCode(event.exitCode));
    }),

    bridge.onLost((event) => {
      if (event.sessionId !== entityId) return;
      if (channel.closed) return;
      channel.closed = true;
      emit(channel, LOST);
    }),
  ];

  channel.dispose = () => {
    for (const dispose of disposers) dispose();
  };

  channels.set(entityId, channel);
  return channel;
}

/**
 * Whether there is a process to write to right now (story 097).
 *
 * Deliberately a different question from `isLiveTerminal`, which answers
 * "should a PTY back this surface?" — a fact about the target and the build.
 * This answers a fact about the world, and the channel map is the only thing
 * in the renderer that knows it: a session that was never opened has no
 * process yet, and one that exited needs a restart. Those are different
 * problems with different fixes, and `session-input.ts` words them apart.
 */
export type ChannelState = 'live' | 'exited' | 'none';

export function sessionChannelState(entityId: string): ChannelState {
  const channel = channels.get(entityId);
  if (!channel || !channel.spawnRequested) return 'none';
  return channel.closed ? 'exited' : 'live';
}

export type SpawnOutcome = { ok: true } | { ok: false; reason: string };

/**
 * What a spawn asks for beyond a process (story 109).
 *
 * An options object rather than three more positional parameters, because
 * `requestSpawn(id, project, task, model, effort)` is a call site where two
 * adjacent strings mean entirely different things and nothing catches them
 * being swapped.
 *
 * Every field is optional and every one means "say nothing" when absent — this
 * module never substitutes a default. A default belongs to whoever *has* the
 * user's choice, which is the store; inventing one here would quietly override
 * a setting the user made in `claude` itself.
 */
export interface SpawnOptions {
  task?: string;
  model?: SessionModel;
  effort?: SessionEffort;
  /**
   * What the agent should call itself (HIVE-78).
   *
   * Absent for every ordinary spawn, and absent means main names the session
   * after its entity id — the HIVE-61 behaviour. The store sets it for exactly
   * one case: a session started from a ticket card, named after its issue key,
   * so the agent's prompt box says `HIVE-73` rather than `sess-07`.
   *
   * Not validated here, on this module's own stated principle that it never
   * substitutes or judges — the guard at the IPC boundary owns the vocabulary,
   * and the store owns the collision-free construction.
   */
  name?: string;
  /**
   * Which way round to paint `claude`'s own UI inside the terminal.
   *
   * The one option here that describes the *app* rather than the session. It
   * exists because the app's theme lives in `localStorage`, which main cannot
   * read, and `claude` decides its own chrome from a settings file main writes
   * — so without this a light-themed Hive ran dark-themed agents and drew the
   * user's own submitted prompt as a near-black bar across a white terminal.
   *
   * Absent means dark, which is both defaults agreeing rather than a guess.
   */
  theme?: SessionTheme;
}

/**
 * Request a process for this entity, at most once, and report the outcome.
 *
 * Two callers with two different needs, and one request between them: the
 * console needs main's refusal *as a value* so it can print it in the
 * transcript, and the terminal needs it as a notice. Sharing the promise is
 * what stops the second caller starting a second process — which would put two
 * `claude` instances in one repository, a data-loss bug wearing a rendering
 * bug's clothes.
 *
 * Never rejects. A refusal is an outcome, not an exception: the fire-and-forget
 * caller below has nowhere to catch one.
 */
export function requestSpawn(
  entityId: string,
  projectId: string,
  { task, model, effort, name, theme }: SpawnOptions = {},
): Promise<SpawnOutcome> {
  /**
   * The bridge is read inside the try, not before it.
   *
   * `pty()` throws when there is no bridge, and this function promises never
   * to reject — the store calls it fire-and-forget from `spawnSession`, where
   * a synchronous throw would take the whole action down after the entity had
   * already been created.
   */
  let channel: EntityChannel;
  try {
    channel = channels.get(entityId) ?? openChannel(entityId);
  } catch (cause) {
    return Promise.resolve({
      ok: false,
      reason: cause instanceof Error ? cause.message : String(cause),
    });
  }
  if (channel.spawnResult) return channel.spawnResult;

  channel.spawnRequested = true;
  channel.spawnResult = pty()
    .spawn({
      sessionId: entityId,
      projectId,
      cols: DEFAULT_COLS,
      rows: DEFAULT_ROWS,
      /**
       * Spread rather than `task: undefined`. The IPC guard rejects unexpected
       * keys, and an own property whose value is undefined survives the
       * structured clone as a key that is present.
       *
       * An **empty** task is absent too, not an empty instruction. The picker
       * starts a session with no job — the first message gives it one (story
       * 044) — and it says so by passing `''`. Sending that on the wire made
       * main's `assertText` reject the whole spawn, so every session started
       * from the picker failed on desktop with `spawn.task: must not be empty`.
       * Normalised here rather than only at the call site, because this is the
       * one place every spawn passes through.
       */
      ...(task === undefined || task.trim() === '' ? {} : { task }),
      /**
       * Same conditional spread, same reason (story 109): the guard rejects
       * unexpected keys, and an own property whose value is `undefined`
       * survives the structured clone as a key that is present. Unlike `task`
       * there is no empty case to normalise — these are closed-set literals, so
       * a value is either one of them or the guard's problem.
       */
      ...(model === undefined ? {} : { model }),
      ...(effort === undefined ? {} : { effort }),
      /**
       * Same spread, same reason (HIVE-78). No empty case to normalise here
       * either: the store only ever builds this from a Jira key, so it is
       * either a well-formed name or the guard's problem — and the guard
       * rejects rather than drops, which is what surfaces a mistake here as a
       * refusal in the console instead of a session that quietly opens unnamed.
       */
      ...(name === undefined ? {} : { name }),
      /** Same spread, same reason. A closed set, so the guard owns the rest. */
      ...(theme === undefined ? {} : { theme }),
    })
    .then((): SpawnOutcome => ({ ok: true }))
    .catch((cause: unknown): SpawnOutcome => {
      const reason = cause instanceof Error ? cause.message : String(cause);
      /**
       * A refusal is *information*, and it belongs in the terminal.
       *
       * Main rejects a spawn with a specific, actionable message — an unmapped
       * project names the config file to edit. Swallowing it leaves an empty
       * black rectangle, which is the failure mode this whole path exists to
       * avoid.
       *
       * Guarded like every other writer here. Unreachable today — main throws
       * synchronously before a channel exists, so no exit or loss can land
       * first — but that is a fact about main's ordering, and this file should
       * not depend on it staying true.
       */
      if (!channel.closed) {
        channel.closed = true;
        emit(channel, spawnRefused(reason));
      }
      return { ok: false, reason };
    });

  return channel.spawnResult;
}

/**
 * The lazy path: a surface mounted, so something had better be running.
 *
 * Fire-and-forget by design — the caller is `onData`, which must return a
 * disposer synchronously, and awaiting the spawn there is precisely the bug
 * the subscribe-then-spawn ordering exists to avoid. When the console asked
 * first, this is a no-op.
 */
function ensureSpawned(
  channel: EntityChannel,
  entityId: string,
  projectId: string,
  options: SpawnOptions,
): void {
  if (channel.spawnRequested) return;
  void requestSpawn(entityId, projectId, options);
}

/**
 * The two transports differ in exactly one moment: what happens when a surface
 * mounts (story 102).
 *
 * A session's transport spawns, because mounting its surface is what starts it.
 * A clone's does not — main started `git` before this view existed, and a
 * transport that spawned on mount would start a *second* clone the first time
 * React remounted the pane.
 *
 * Parameterising that one moment is what keeps the replay-then-subscribe
 * ordering, the sequence-gap detection and the ack loop identical for both,
 * rather than duplicated and free to drift.
 */
function createTransport(
  entityId: string,
  onMount: (channel: EntityChannel) => void,
): TerminalTransport {
  return {
    write: (data) => pty().write({ sessionId: entityId, data }),

    resize: (cols, rows) => pty().resize({ sessionId: entityId, cols, rows }),

    onData(cb) {
      const channel = channels.get(entityId) ?? openChannel(entityId);

      /**
       * Replay, then subscribe, then spawn — and the order of all three is the
       * design.
       *
       * Subscribing *before* requesting the spawn is what guarantees no output
       * is lost. A shell prints its prompt the instant it starts; a transport
       * that awaited the spawn before subscribing would race those first bytes
       * and drop the prompt roughly once in twenty runs — a bug that reproduces
       * rarely and looks like a rendering glitch every time.
       *
       * Replaying before subscribing keeps the transcript in order: a chunk
       * arriving mid-replay would otherwise be delivered ahead of the history it
       * follows.
       */
      if (channel.buffer.length > 0) cb(channel.buffer.join(''));

      channel.subscribers.add(cb);

      if (!channel.closed) onMount(channel);

      /**
       * Unsubscribe only. **This must never kill the PTY.**
       *
       * Unmounting happens on tab switches and re-renders. A session has to keep
       * running while the user looks at something else — that is the product,
       * not an optimisation. The channel itself outlives the last subscriber for
       * the same reason: its buffer keeps filling, so switching away for thirty
       * seconds and back shows what happened while away.
       */
      return () => {
        channel.subscribers.delete(cb);
      };
    },
  };
}

/**
 * A live session's transport: mounting a surface is what starts the process.
 *
 * `options` covers the sessions the picker never touched (story 109) — a
 * fixture opened for the first time carries a model on its entity and reaches
 * this path, not the store's eager `requestSpawn`. Resolved by
 * `resolve-transport.ts`, which is the store-aware half of the seam and already
 * turns an entity into a project id for exactly this reason; this module still
 * takes everything as arguments and reads nothing.
 */
export function createPtyTransport(
  entityId: string,
  projectId: string,
  options: SpawnOptions = {},
): TerminalTransport {
  return createTransport(entityId, (channel) =>
    ensureSpawned(channel, entityId, projectId, options),
  );
}

/**
 * The clone terminal's transport (story 102).
 *
 * No spawn, and no project — a clone has neither. Main started `git` before
 * this surface existed, so mounting must attach and nothing more; everything
 * that carries bytes is the session path's, unchanged.
 *
 * It lives here rather than in a file of its own because the channel map, the
 * replay buffer, the sequence tracking and the ack loop it needs are all
 * module-private. A separate module would either duplicate them or force them
 * to be exported, and both are worse than one extra factory.
 */
export function createCloneTransport(): TerminalTransport {
  return createTransport(CLONE_ENTITY_ID, () => {});
}

/**
 * Start the clone channel over (story 102).
 *
 * A session's channel is deliberately sticky in two ways, and **both are wrong
 * for a clone**:
 *
 * - `closed` is a one-way latch, so a remount cannot resurrect a finished
 *   agent. But every clone reuses {@link CLONE_ENTITY_ID}, so without this the
 *   *second* clone of a session renders nothing at all — `onData` returns early
 *   on a channel the first clone closed, and the terminal sits empty while git
 *   runs perfectly well underneath it.
 * - the buffer survives so that switching tabs and back shows what happened
 *   while away. A clone is a fresh task, not a session being revisited, so
 *   replaying the previous clone's transcript above the new one is noise.
 *
 * Called when a clone actually starts, not when the view mounts: a mount that
 * cleared the transcript would wipe the terminal on any re-render.
 */
export function resetCloneChannel(): void {
  const channel = channels.get(CLONE_ENTITY_ID);
  if (!channel) return;
  channel.closed = false;
  channel.lastSeq = null;
  channel.spawnRequested = false;
  channel.spawnResult = null;
  channel.buffer.length = 0;
  channel.bufferUnits = 0;
}

/**
 * Reopen a channel for a fresh generation of the same entity (story 096).
 *
 * `closed` is a one-way latch by design — it is what stops a remount
 * resurrecting a finished agent — so a restart, which is the one legitimate way
 * to get a new process for an existing entity, has to clear it explicitly.
 * Without this the renderer drops every chunk the new process produces
 * (`onData` returns early on `closed`) and `sendToSession` keeps refusing with
 * "restart it to send again", pointing at the action the user just took.
 *
 * `lastSeq` is reset for the same reason: main's sequence counter starts at 0
 * for each new session id, so a retained `lastSeq` reports a spurious gap on
 * the first chunk of every restart.
 *
 * `spawnResult` is dropped so the next `requestSpawn` genuinely asks again.
 */
export function reopenChannel(entityId: string): void {
  const channel = channels.get(entityId);
  if (!channel) return;
  channel.closed = false;
  channel.lastSeq = null;
  channel.spawnRequested = false;
  channel.spawnResult = null;
}

/**
 * Drop every channel and its bridge subscriptions.
 *
 * Test-only. The module-level map is deliberate — "one spawn per entity" is a
 * property of the *renderer*, not of any one surface — and a shared map that
 * survives between tests is a shared map that makes them order-dependent.
 */
export function resetPtyChannels(): void {
  for (const channel of channels.values()) channel.dispose();
  channels.clear();
}
