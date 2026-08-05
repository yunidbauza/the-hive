import {
  BOOTSTRAP_DEBOUNCE_MS,
  BOOTSTRAP_FALLBACK_MS,
} from '@shared/session-contract';

/**
 * When to write `claude` into a freshly spawned shell (story 096).
 *
 * The command is written as **input**, not passed as an argument, and the
 * timing is the whole of this module.
 *
 * ## Why input rather than `$SHELL -l -c claude`
 *
 * `-c` would run `claude` as the shell's only job and the shell would exit with
 * it — leaving the user looking at a corpse in the middle of a repository they
 * were working in, unable to run `git diff`, rerun the tests, or start another
 * turn without creating a new session. Writing it into the pty makes it an
 * ordinary interactive command, and the shell survives it.
 *
 * ## Why not immediately
 *
 * Characters written before the shell has installed its line discipline land in
 * a buffer it may discard. The session then sits at a bare prompt having
 * silently swallowed the command, which looks like the app failing to start
 * `claude` at all.
 *
 * So: wait for the first output, then a short debounce for the prompt to
 * settle, then write. If nothing arrives at all within the fallback window,
 * write anyway and record it — a genuinely silent startup is unusual but real.
 */

/**
 * The command line a session is bootstrapped with.
 *
 * ## Why `&& exit` — and why this reverses story 096
 *
 * Story 096 chose `$SHELL -l` with `claude` typed into it *specifically* so the
 * shell would outlive the agent: quitting Claude dropped the user into a live
 * shell in the right repository on the right branch, where they could run
 * `git diff` or rerun the tests without starting a new session. That was a
 * deliberate decision and this deliberately undoes it.
 *
 * The reason is that The Hive is a fleet view. A session whose agent has quit
 * is finished work, and leaving thirteen idle login shells in the rail — each
 * indistinguishable from a session that is merely quiet — makes the one list
 * the app exists to render steadily less true. `/exit` should retire the row.
 *
 * ## Why `&&` and not `;`
 *
 * `;` would exit the shell however `claude` ended, which includes the two
 * endings the user most needs to see:
 *
 * - `claude: command not found` (127) — a mistyped `claudeCommand` (story 090)
 *   would make every new session vanish the instant it opened, with the error
 *   scrolling past inside a pty that is already closing.
 * - a crash — the stack trace would go with it.
 *
 * `&&` exits only on a **clean** exit, which is what `/exit` and `Ctrl-D`
 * produce. Anything else leaves the login shell up with the wreckage on screen.
 * The session then stays open, which is the correct outcome for a session that
 * did not finish so much as fail.
 *
 * There is no new status. Story 096 already maps a pty exit to `done`, exactly,
 * and its "keep the transcript readable" rule keeps the tab and its scrollback
 * in place afterwards.
 */
export const sessionCommand = (claudeCommand: string): string =>
  `${claudeCommand} && exit`;

export interface BootstrapOptions {
  /** Send the command to a session's pty. */
  write: (entityId: string, data: string) => void;
  /**
   * Called when the bootstrap went in without ever seeing output.
   *
   * Recorded rather than silent: it means the shell produced nothing for five
   * seconds, and if the command *also* fails to take, that is the fact that
   * explains it.
   */
  onSilentStart?: (entityId: string) => void;
  /**
   * The session has finished bootstrapping — every stage written, nothing left
   * pending.
   *
   * The signal main needs to release input it held back: until this fires the
   * session is a bare login shell, and a user's message written into it would
   * be run by the *shell* as a command line rather than reaching the agent.
   */
  onComplete?: (entityId: string) => void;
  debounceMs?: number;
  fallbackMs?: number;
}

export interface Bootstrap {
  /**
   * Arm a freshly spawned session. Idempotent per entity.
   *
   * With a `task`, the session gets a second stage: the command goes in first,
   * then the task once *its* output has settled. See {@link createBootstrap}.
   */
  arm(entityId: string, command: string, task?: string): void;
  /** Report output. The first one starts the debounce. */
  sawOutput(entityId: string): void;
  /** Abandon a pending bootstrap — the session died before it ran. */
  cancel(entityId: string): void;
  /** Whether a bootstrap is still pending, for diagnostics and tests. */
  isPending(entityId: string): boolean;
  dispose(): void;
}

interface Pending {
  command: string;
  /**
   * Restart the debounce on **every** chunk rather than only the first.
   *
   * Set for the task stage, and the difference is the whole correctness of it.
   * Stage one's first output genuinely is the shell's prompt, so first-chunk +
   * debounce is right there — and restarting on every chunk would let a long
   * motd postpone the bootstrap indefinitely, which is what the fallback and
   * this flag's absence guard against.
   *
   * Stage two has no such luck: the first output after `claude\r` is the line
   * discipline's **echo of the command**, arriving in milliseconds, so a
   * first-chunk clock fires ~150ms after `claude` was invoked and long before
   * its TUI has painted. Waiting for the output to go *quiet* is the observable
   * that "the TUI has finished starting" actually has, and `fallbackMs` still
   * caps it for a TUI that never stops animating.
   */
  settleOnEveryChunk?: boolean;
  /**
   * Written after the *next* settle, once `command`'s own output has quietened
   * (story 097). Undefined for an ordinary bootstrap and for the second stage
   * itself, which is what makes the re-arm terminate.
   */
  task?: string;
  timer: ReturnType<typeof setTimeout>;
  /** True once the first chunk has arrived and the debounce is running. */
  settling: boolean;
}

export function createBootstrap(options: BootstrapOptions): Bootstrap {
  const {
    write,
    onSilentStart,
    onComplete,
    debounceMs = BOOTSTRAP_DEBOUNCE_MS,
    fallbackMs = BOOTSTRAP_FALLBACK_MS,
  } = options;

  const pending = new Map<string, Pending>();
  /** Absolute cap for a stage that restarts its debounce. See `Pending`. */
  const deadlines = new Map<string, number>();

  function fire(entityId: string, silent: boolean): void {
    const entry = pending.get(entityId);
    if (!entry) return;
    pending.delete(entityId);
    deadlines.delete(entityId);
    if (silent) onSilentStart?.(entityId);
    /**
     * `\r`, not `\n`. A pty's line discipline turns carriage return into the
     * "line submitted" signal; a bare newline is inserted as a literal in some
     * shells and readline configurations, leaving the command typed but never
     * run.
     */
    write(entityId, `${entry.command}\r`);

    /**
     * The task is the same problem one level down, so it gets the same answer.
     *
     * `claude` has to start and paint its prompt before it will accept input,
     * and writing into that window loses the text exactly as writing into the
     * shell's startup would. The renderer cannot time it — `session:status`
     * carries `working | idle | done` and deliberately nothing finer — so main
     * does, with the mechanism it already has.
     *
     * Re-arming rather than chaining is what makes this cheap: `settling:
     * false` means the TUI's first paint restarts the identical debounce, the
     * fallback still covers a TUI that prints nothing, and `cancel` already
     * reaches it — a session that dies between the two stages drops its task
     * with everything else. The new entry carries no `task` of its own, which
     * is what terminates the recursion.
     */
    if (entry.task === undefined) {
      onComplete?.(entityId);
      return;
    }
    pending.set(entityId, {
      command: entry.task,
      settleOnEveryChunk: true,
      settling: false,
      timer: setTimeout(() => fire(entityId, true), fallbackMs),
    });
    // The fallback is the cap on "quiet": a TUI that never stops painting still
    // gets its instruction, once, rather than never.
    deadlines.set(entityId, Date.now() + fallbackMs);
  }

  return {
    arm(entityId, command, task) {
      // Re-arming would stack a second timer and write the command twice.
      if (pending.has(entityId)) return;
      pending.set(entityId, {
        command,
        ...(task === undefined ? {} : { task }),
        settling: false,
        timer: setTimeout(() => fire(entityId, true), fallbackMs),
      });
    },

    sawOutput(entityId) {
      const entry = pending.get(entityId);
      if (!entry) return;

      if (entry.settleOnEveryChunk) {
        /**
         * Wait for quiet, capped by the fallback the stage was armed with.
         *
         * Without the cap this could be postponed forever by a TUI that paints
         * continuously; without the restart it fires on the command's own echo.
         */
        const deadline = deadlines.get(entityId);
        if (deadline !== undefined && Date.now() >= deadline) return;
        entry.settling = true;
        clearTimeout(entry.timer);
        entry.timer = setTimeout(() => fire(entityId, false), debounceMs);
        return;
      }

      // Only the *first* chunk starts the clock. Restarting the debounce on
      // every chunk would postpone the bootstrap indefinitely behind a shell
      // that prints a long motd.
      if (entry.settling) return;

      entry.settling = true;
      clearTimeout(entry.timer);
      entry.timer = setTimeout(() => fire(entityId, false), debounceMs);
    },

    cancel(entityId) {
      const entry = pending.get(entityId);
      if (!entry) return;
      clearTimeout(entry.timer);
      pending.delete(entityId);
      deadlines.delete(entityId);
    },

    isPending: (entityId) => pending.has(entityId),

    dispose() {
      for (const entry of pending.values()) clearTimeout(entry.timer);
      pending.clear();
      deadlines.clear();
    },
  };
}
