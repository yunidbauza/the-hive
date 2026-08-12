import { ACTIVITY_IDLE_MS, type DerivedStatus } from '@shared/session-contract';

/**
 * Session status, derived from the only thing main can actually observe
 * (story 096).
 *
 * The fixture model is `working | waiting | idle | done | terminated`, and
 * `waiting` — the state the whole inbox and attention model is built around — is
 * **not derivable from a pty**. A TUI that has asked a question and a TUI that
 * is thinking both produce no output. The only way to tell them apart from here
 * would be to scrape rendered text for question marks, a heuristic that fails
 * silently and constantly; an attention model built on it would be worse than
 * no attention model.
 *
 * So this derives three states and refuses to guess the ones it cannot see.
 * Sessions still show `waiting` where a fixture says so, and no real session
 * ever enters it on its own. The real mechanism is a Claude Code hook — a
 * `Notification`/`Stop` hook writing a structured event the app watches — which
 * is a first-class integration with its own design, named here so the gap is
 * recorded rather than discovered.
 *
 * ## Exit is `terminated`, not `done` (story 108)
 *
 * The same discipline, applied to the ending. A pty exit is an observation: the
 * process is gone. "Done" is a claim about the work, and this module has no way
 * to evaluate it — `/exit` after an abandoned attempt and `/exit` after a merged
 * PR produce byte-identical evidence. Reporting both as `done` made the fleet
 * view assert something it had not observed, and left the user unable to tell a
 * finished session from a quit one.
 *
 * ## Why this lives in main
 *
 * A per-chunk store write at firehose rates would re-render the shell
 * continuously, which is precisely what the store split exists to prevent. The
 * debounce collapses a build log's worth of output into one `working`, and one
 * `idle` two seconds after it stops.
 */

export interface ActivityOptions {
  /** Called only when the derived status actually changes. */
  onStatus: (entityId: string, status: DerivedStatus) => void;
  idleAfterMs?: number;
}

export interface ActivityTracker {
  /** A chunk arrived for this session. */
  sawOutput(entityId: string): void;
  /** The process exited. Terminal state — no further transitions. */
  exited(entityId: string): void;
  /** Drop everything known about a session. */
  forget(entityId: string): void;
  /** Current derived status, or `undefined` if never seen. */
  statusOf(entityId: string): DerivedStatus | undefined;
  /** Clear every timer so nothing outlives the app. */
  dispose(): void;
}

interface Entry {
  status: DerivedStatus;
  timer: ReturnType<typeof setTimeout> | null;
}

export function createActivityTracker(options: ActivityOptions): ActivityTracker {
  const { onStatus, idleAfterMs = ACTIVITY_IDLE_MS } = options;
  const entries = new Map<string, Entry>();

  function clearTimer(entry: Entry): void {
    if (entry.timer === null) return;
    clearTimeout(entry.timer);
    entry.timer = null;
  }

  function set(entityId: string, entry: Entry, status: DerivedStatus): void {
    // Only on a real change: an idle session emitting nothing must not produce
    // a status write every two seconds forever.
    if (entry.status === status) return;
    entry.status = status;
    onStatus(entityId, status);
  }

  return {
    sawOutput(entityId) {
      const entry = entries.get(entityId) ?? { status: 'idle', timer: null };
      entries.set(entityId, entry);

      /**
       * Output after an exit is not a resurrection.
       *
       * The last bytes of a process routinely arrive after main has already
       * seen the exit, and flipping back to `working` there would leave a dead
       * session permanently claiming to be busy — the status would never
       * correct itself, because nothing more is coming.
       */
      if (entry.status === 'terminated') return;

      set(entityId, entry, 'working');

      clearTimer(entry);
      entry.timer = setTimeout(() => {
        entry.timer = null;
        set(entityId, entry, 'idle');
      }, idleAfterMs);
    },

    exited(entityId) {
      const entry = entries.get(entityId) ?? { status: 'idle', timer: null };
      entries.set(entityId, entry);
      clearTimer(entry);
      set(entityId, entry, 'terminated');
    },

    forget(entityId) {
      const entry = entries.get(entityId);
      if (!entry) return;
      clearTimer(entry);
      entries.delete(entityId);
    },

    statusOf: (entityId) => entries.get(entityId)?.status,

    dispose() {
      for (const entry of entries.values()) clearTimer(entry);
      entries.clear();
    },
  };
}
