/**
 * The session lifecycle contract (story 096).
 *
 * Separate from `ipc-contract.ts` for the same reason that file is separate
 * from `pty-host-protocol.ts`: these describe *sessions*, which are a main-side
 * concept built on top of PTYs, and the two should be free to change
 * independently. A pty knows nothing about projects, bootstraps or attention.
 *
 * Types and constants only — both processes import it.
 */

/**
 * What main can honestly derive about a session from its pty.
 *
 * Deliberately **not** the full `SessionStatus`. The fixture model includes
 * `waiting` — blocked on the user — and it is not derivable here: a TUI that has
 * asked a question and a TUI that is thinking both produce no output.
 * Distinguishing them by scraping rendered text would be a heuristic that fails
 * silently, and the app's whole attention model is built on this field.
 *
 * The type is what enforces that. A `waiting` main could never produce cannot be
 * accidentally produced by a later edit.
 */
export type DerivedStatus = 'working' | 'idle' | 'done';

/** Main telling the renderer what a real session is doing. */
export interface SessionStatusEvent {
  /** The *entity* id — the renderer never sees a pty session id. */
  entityId: string;
  status: DerivedStatus;
}

/** Silence for this long means idle. */
export const ACTIVITY_IDLE_MS = 2_000;

/**
 * How long to wait after the shell's first output before writing the bootstrap.
 *
 * A prompt is not the end of a shell's startup — profile scripts print, then
 * the prompt draws, then readline installs its handlers. Writing into that
 * window lands characters in a buffer the shell may discard, leaving a session
 * sitting at a bare prompt having silently swallowed the command.
 */
export const BOOTSTRAP_DEBOUNCE_MS = 150;

/**
 * How long to wait for *any* output before writing the bootstrap regardless.
 *
 * A genuinely silent startup is unusual but real — a bare `sh` with no profile
 * and `PS1` unset prints nothing at all. Waiting forever would leave the session
 * permanently empty, so the bootstrap goes in anyway and the fact is recorded.
 */
export const BOOTSTRAP_FALLBACK_MS = 5_000;

/** How long every session's process group gets to exit on quit. */
export const QUIT_GRACE_MS = 3_000;

/**
 * Why a session could not start.
 *
 * A closed set, each member naming something the *user* can act on. A generic
 * "could not start a session" would be honest and useless: "the project is not
 * mapped" and "the pty host is down" are different problems with different
 * fixes, and only one of them is the user's to solve.
 *
 * The union spans both processes; the **wording** does not, and cannot. Three of
 * these are decided in main and worded by {@link spawnRefusal}. `not-desktop` is
 * decided in the renderer — it is the one precondition main cannot evaluate,
 * because in the browser build there is no main — and it is worded there, in
 * `src/features/sessions/session-control.ts`. This module stays importable
 * type-only from `src/**`, which is the rule that makes the contract a
 * compile-time artifact instead of a runtime edge between the processes.
 */
export type SpawnRefusal =
  | { reason: 'not-desktop' }
  | { reason: 'unmapped'; projectId: string; configPath: string }
  | { reason: 'at-capacity'; limit: number }
  | { reason: 'host-unavailable' };

/** The refusals main decides, and the exact wording each reaches the user with. */
export type MainSpawnRefusal = Exclude<SpawnRefusal, { reason: 'not-desktop' }>;

export function spawnRefusal(refusal: MainSpawnRefusal): string {
  switch (refusal.reason) {
    case 'unmapped':
      /**
       * Names the project *and* the file to edit. "Not mapped" alone sends the
       * user looking for a setting that does not exist; the path is the whole
       * actionable part.
       */
      return `${refusal.projectId} is not mapped — add it to ${refusal.configPath}`;
    case 'at-capacity':
      return `session limit reached (${refusal.limit})`;
    case 'host-unavailable':
      return 'pty host unavailable — see the activity feed';
  }
}
