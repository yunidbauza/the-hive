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
  debounceMs?: number;
  fallbackMs?: number;
}

export interface Bootstrap {
  /** Arm a freshly spawned session. Idempotent per entity. */
  arm(entityId: string, command: string): void;
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
  timer: ReturnType<typeof setTimeout>;
  /** True once the first chunk has arrived and the debounce is running. */
  settling: boolean;
}

export function createBootstrap(options: BootstrapOptions): Bootstrap {
  const {
    write,
    onSilentStart,
    debounceMs = BOOTSTRAP_DEBOUNCE_MS,
    fallbackMs = BOOTSTRAP_FALLBACK_MS,
  } = options;

  const pending = new Map<string, Pending>();

  function fire(entityId: string, silent: boolean): void {
    const entry = pending.get(entityId);
    if (!entry) return;
    pending.delete(entityId);
    if (silent) onSilentStart?.(entityId);
    /**
     * `\r`, not `\n`. A pty's line discipline turns carriage return into the
     * "line submitted" signal; a bare newline is inserted as a literal in some
     * shells and readline configurations, leaving the command typed but never
     * run.
     */
    write(entityId, `${entry.command}\r`);
  }

  return {
    arm(entityId, command) {
      // Re-arming would stack a second timer and write the command twice.
      if (pending.has(entityId)) return;
      pending.set(entityId, {
        command,
        settling: false,
        timer: setTimeout(() => fire(entityId, true), fallbackMs),
      });
    },

    sawOutput(entityId) {
      const entry = pending.get(entityId);
      if (!entry) return;
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
    },

    isPending: (entityId) => pending.has(entityId),

    dispose() {
      for (const entry of pending.values()) clearTimeout(entry.timer);
      pending.clear();
    },
  };
}
