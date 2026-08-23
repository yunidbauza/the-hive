import { AUTH_ENV_KEYS } from '@shared/config-contract';
import {
  BOOTSTRAP_DEBOUNCE_MS,
  BOOTSTRAP_FALLBACK_MS,
  isSendableSessionName,
  SUBMIT_DELAY_MS,
  type SessionEffort,
  type SessionModel,
} from '@shared/session-contract';

/**
 * `--session-id` takes a uuid and rejects anything else.
 *
 * Checked here rather than assumed because a malformed value makes `claude`
 * exit non-zero, which `&&` turns into "the session opened and did nothing".
 */
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Single-quote a path for a POSIX shell.
 *
 * The one argument on this command line that genuinely needs it. `--name` and
 * `--session-id` are filtered against closed patterns and `--model`/`--effort`
 * against closed lists, so none of them can carry a metacharacter — but the
 * settings path is `app.getPath('userData')`, and on macOS that is
 * `~/Library/Application Support/the-hive/…`. **It contains a space on every
 * Mac**, which the shell splits, so `claude` received `--settings
 * /Users/…/Application` plus a stray positional argument it read as an initial
 * prompt, and hook status never worked at all.
 *
 * An earlier comment here claimed an app-generated path "has none of them".
 * That was wrong on the most common platform this app runs on, which is why the
 * rule is now enforced in code instead of asserted in prose.
 *
 * Single quotes rather than escaping: inside them a POSIX shell interprets
 * nothing, so the only character needing care is the single quote itself, and
 * `'\''` closes, escapes and reopens.
 */
const shellQuote = (value: string): string => `'${value.replaceAll("'", `'\\''`)}'`;

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
 * What the session was started *as* (story 109).
 *
 * Both optional, and omitting one omits its flag rather than substituting a
 * default. A spawn that names neither produces exactly the command line this
 * module has always produced, which is what keeps a fixture opened for the
 * first time — or a `spawn` typed into the console — running under whatever the
 * user's own `claude` configuration says.
 */
export interface SessionOptions {
  /**
   * Whether to unset the API credentials before invoking `claude` (HIVE-79).
   *
   * Defaults to `false` here rather than to the config's own default, so a
   * caller that does not know about authentication cannot silently opt a
   * session into a billing change. `sessions/index.ts` is the one caller that
   * reads the config and passes it.
   */
  subscriptionAuth?: boolean;
  model?: SessionModel;
  effort?: SessionEffort;
  /**
   * What to call the session inside Claude (HIVE-61).
   *
   * The Hive's own entity id, so the agent's prompt box, its `/resume` picker
   * entry and its terminal title all say `sess-07` rather than an auto-title
   * derived from whatever the first message happened to be.
   *
   * Filtered by {@link isSendableSessionName} rather than trusted: unlike
   * `--model` and `--effort` this has no closed list behind it, so the
   * no-quoting rule below does not cover it on its own. A name that fails the
   * pattern omits the flag — the session starts unnamed, which is what it did
   * before this story, rather than starting with a mangled command line.
   */
  name?: string;
  /**
   * The conversation's session id, pinned rather than left to Claude.
   *
   * Pinning it makes the transcript path deterministic
   * (`~/.claude/projects/<escaped-cwd>/<uuid>.jsonl`), which is what later work
   * needs to resume a session, read its cost, or read the `custom-title` and
   * `ai-title` records back. Cheap to add now and impossible to add
   * retroactively for a session that has already started.
   */
  sessionUuid?: string;
  /**
   * Continue the conversation {@link SessionOptions.sessionUuid} names rather
   * than start one under it (HIVE-88).
   *
   * `--resume <uuid>` where `--session-id <uuid>` would have gone: the same
   * identifier, the opposite claim about it. Ignored without a uuid — there is
   * nothing to resume — so a caller that asked to resume a record written
   * before uuids were recorded gets the plain spawn it would have got anyway.
   */
  resume?: boolean;
  /**
   * A settings file to merge on top of the user's own (HIVE-62).
   *
   * Carries the hook configuration that reports session status back to the app.
   * `--settings` *merges*, so the user's own hooks, permissions and preferences
   * are untouched; the app never writes to `~/.claude/settings.json`.
   *
   * A path rather than the inline JSON `--settings` also accepts: inline JSON
   * on a shell-parsed command line is braces, quotes and colons in exactly the
   * position the no-quoting rule below does not cover.
   *
   * The path is **quoted** by {@link shellQuote}, and that is not belt and
   * braces. It is `app.getPath('userData')`, which on macOS contains a space —
   * so the unquoted version split into two arguments on every Mac.
   */
  settingsPath?: string;
  /**
   * The session's opening instruction, as `claude`'s initial prompt.
   *
   * An **argument**, not a second thing typed into the shell afterwards, and
   * that distinction is the whole of HIVE-91. See {@link sessionCommand} for
   * what the two-stage version did when `claude` failed to start.
   *
   * Untrusted free text — it comes from the console's `spawn <repo> <task…>` and
   * from the picker's message box — so unlike every other value here it is
   * {@link shellQuote}d rather than covered by a closed-list guard. It is the
   * second argument on this command line to need that, for the same reason
   * `settingsPath` does and a much more obvious one.
   */
  task?: string;
}

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
 * Story 108 revisited the status this produces. This story said "there is no new
 * status" and mapped the exit onto `done`, which turned out to be the wrong
 * word: `done` is a fixture's judgement about the *work*, and a pty exit is an
 * observation about a *process*. `/exit` now yields `terminated`. The rest of
 * the reasoning above stands unchanged, including the "keep the transcript
 * readable" rule that keeps the tab and its scrollback in place afterwards.
 *
 * ## Why the flags are not quoted (story 109)
 *
 * `--model opus --effort high` is interpolated into a string a login shell will
 * parse, which is normally exactly where a value needs quoting or escaping.
 * These do not, and the reason is upstream: both are validated at the IPC
 * boundary against a closed list of literals (`assertOneOf` in
 * `shared/guards.ts`), so by the time either arrives here it is one of eight
 * known words with no shell metacharacter in any of them.
 *
 * That is a **guarantee about the guard**, not an observation about today's
 * values, and it is why the sets live in `shared/session-contract.ts` where
 * both processes read them. Widening either list to something a shell could
 * interpret would need quoting here — obvious while writing the list, invisible
 * six months later. If a value with a space, a quote or a `$` is ever added,
 * this is the line that breaks.
 *
 * ## Why the flags and the task go *before* `&&`, and nothing goes after
 *
 * They are arguments to `claude`, so they bind to it and not to `exit`. The
 * short-circuit still measures what it always measured: `claude` ending
 * cleanly. A session started with a bad flag exits non-zero, `&&` does not
 * fire, and the login shell stays up with the CLI's own complaint on screen —
 * which is the right outcome for a mistyped model and the same failure mode a
 * mistyped `claudeCommand` already has.
 *
 * ## Why the task is an argument, and not typed in afterwards (HIVE-91)
 *
 * It used to be a **second stage**: this command went in, `createBootstrap`
 * waited for `claude`'s TUI to stop painting, and then wrote the task as a
 * separate line. That is a timing guess about another program's startup, and
 * when the guess is wrong there is no safe failure — the task is written into
 * whatever is reading the pty. When `claude` does not start at all the thing
 * reading the pty is **the login shell**, so it ran the user's instruction as a
 * command line:
 *
 * ```
 * $ claude --model opus … && exit
 * zsh: command not found: claude          # or a recursive ~/.zshrc wrapper
 * $ what time is it
 * what: time: No such file or directory
 * ```
 *
 * Which is both a lost task and arbitrary text handed to a shell. Passing it as
 * `claude <flags> '<task>'` closes the window structurally rather than making
 * the guess better: there is only one write, so there is no moment at which the
 * task exists as pty input on its own. If `claude` never starts, the task never
 * goes anywhere — it was an argument to a process that failed.
 *
 * Verified against Claude Code 2.1.232 on a real pty before this was written:
 * the positional argument is read as the initial prompt, it is **submitted**
 * rather than merely typed into the box, and the session stays interactive
 * afterwards instead of exiting once it has answered. All three matter — the
 * middle one is what the removed stage existed to achieve, and the last is what
 * makes it safe to keep `&& exit` bound to a clean quit.
 *
 * This also retires the paste-threshold problem HIVE-63 worked around. A task
 * longer than ~64 characters was treated by the TUI as a paste, which swallowed
 * its own carriage return; an argument has no input box to be pasted into.
 */
export const sessionCommand = (
  claudeCommand: string,
  {
    model,
    effort,
    name,
    sessionUuid,
    resume = false,
    settingsPath,
    subscriptionAuth = false,
    task,
  }: SessionOptions = {},
): string => {
  const flags = [
    ...(model === undefined ? [] : ['--model', model]),
    ...(effort === undefined ? [] : ['--effort', effort]),
    /**
     * Dropped rather than escaped when it fails the pattern. See
     * {@link SessionOptions.name} — the guard is at the IPC boundary and this
     * is the second, local check, because the value also reaches here from
     * main's own spawn path where no IPC guard ever ran.
     */
    ...(name !== undefined && isSendableSessionName(name) ? ['--name', name] : []),
    ...(sessionUuid !== undefined && UUID_PATTERN.test(sessionUuid)
      ? [resume ? '--resume' : '--session-id', sessionUuid]
      : []),
    ...(settingsPath === undefined ? [] : ['--settings', shellQuote(settingsPath)]),
  ];
  /**
   * Unset the API credentials **here**, not only in the spawned environment
   * (HIVE-79).
   *
   * `stripEnv` removes them from the environment node-pty is handed, and that
   * is necessary but not sufficient: a session runs `$SHELL -l` and `claude` is
   * *typed into that shell*. A login shell sources the user's profile, so an
   * `export ANTHROPIC_API_KEY=…` in `~/.zshrc` — the dominant way that variable
   * is set, and precisely the population `AUTH_ENV_KEYS` exists for — is
   * re-established before `claude` ever runs. Both limit gauges would then read
   * `—` forever, which is the exact failure the feature exists to prevent.
   *
   * `env.ts` already documents this mechanism from the other direction: it
   * notes that stripping `CLAUDE_*` in the host "is not lossy" *because* the
   * login shell re-establishes anything the user genuinely exports. The same
   * sentence, read as a warning rather than a reassurance, is this bug.
   *
   * `unset` rather than `env -u`: `claudeCommand` is user-configurable and may
   * be a shell alias or function, which `env` cannot invoke. A `;` rather than
   * `&&` so the `&&` that follows still binds `exit` to `claude`'s own status —
   * and because `unset` on an already-unset name succeeds anyway.
   */
  const prefix = subscriptionAuth ? `unset ${AUTH_ENV_KEYS.join(' ')}; ` : '';

  /**
   * An empty task is **omitted**, not quoted into an empty argument.
   *
   * The picker spawns with `''` rather than `undefined` — see
   * `new-session-picker.tsx` — so this is the common path, not a defensive
   * flourish. `claude ''` is a positional argument that happens to be empty,
   * which is a request to open with a blank prompt rather than no prompt at all.
   *
   * Newlines are flattened for the reason the whole module exists: this string
   * is written into a pty and terminated by one `\r`, so an embedded newline
   * would submit the line early and leave the tail of the task to be read by the
   * shell. The console's grammar cannot produce one (`parse-command.ts` splits on
   * whitespace) but the picker's message box can, and "cannot happen today" is a
   * weaker guarantee than one `replaceAll` here.
   */
  const initialPrompt =
    task === undefined || task.trim() === ''
      ? []
      : [shellQuote(task.replaceAll(/[\r\n]+/g, ' ').trim())];

  return `${prefix}${[claudeCommand, ...flags, ...initialPrompt].join(' ')} && exit`;
};

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
  /** How long after a stage's text to send its submitting `\r` (HIVE-63). */
  submitDelayMs?: number;
}

export interface Bootstrap {
  /**
   * Arm a freshly spawned session. Idempotent per entity.
   *
   * One stage, always: the command goes in once the shell has settled and that
   * is the end of it. The session's task rides *inside* `command` as `claude`'s
   * initial prompt — see {@link sessionCommand} — rather than following it as a
   * second write, which is what HIVE-91 removed.
   */
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
    onComplete,
    debounceMs = BOOTSTRAP_DEBOUNCE_MS,
    fallbackMs = BOOTSTRAP_FALLBACK_MS,
    submitDelayMs = SUBMIT_DELAY_MS,
  } = options;

  const pending = new Map<string, Pending>();
  /** Stages whose text is written and whose `\r` has not gone yet (HIVE-63). */
  const submits = new Map<string, ReturnType<typeof setTimeout>>();

  function fire(entityId: string, silent: boolean): void {
    const entry = pending.get(entityId);
    if (!entry) return;
    pending.delete(entityId);
    if (silent) onSilentStart?.(entityId);
    /**
     * The text and its `\r` go in as **two** writes (HIVE-63).
     *
     * `\r`, not `\n`, for the reason it always was: a pty's line discipline
     * turns carriage return into the "line submitted" signal, and a bare
     * newline is inserted as a literal in some shells and readline
     * configurations, leaving the command typed but never run.
     *
     * The split is newer and fixes a defect one level up. Sent as a single
     * write, a stage longer than ~64 characters is treated by Claude Code's TUI
     * as a *paste*, and the trailing carriage return is inserted into the input
     * box instead of submitting it — so the session sat there holding a task
     * nobody could see it had been given. Separating them makes the text a
     * paste (which it is) and the `\r` a keystroke (which is unambiguous).
     *
     * Every stage is split, not just the long ones. See {@link SUBMIT_DELAY_MS}
     * for why a measured threshold is deliberately not branched on.
     */
    write(entityId, entry.command);
    /**
     * Tracked so `cancel` and `dispose` can clear it. A session killed in the
     * window between the text and its `\r` would otherwise write into a pty
     * that is already gone.
     */
    submits.set(
      entityId,
      setTimeout(() => {
        submits.delete(entityId);
        write(entityId, '\r');

        /**
         * **Everything after the stage happens here, after the `\r`.**
         *
         * Held input is released only now. Releasing it beside the *text* write
         * would leave a 300ms window in which a user's keystrokes are appended
         * to the command line itself — the shell then ran
         * `claude --name sess-01 && exithello`.
         *
         * That window is also what made the old second stage unfixable by
         * timing: its debounce was started by the pty's echo of *this* text and
         * fired inside the gap, appending the task to the command line
         * (`…&& exitRefactor the checkout flow…`). The task is now an argument
         * inside `entry.command`, so there is no second stage to order against
         * this one, and the rule reduces to: submit, then release.
         */
        onComplete?.(entityId);
      }, submitDelayMs),
    );
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
      /**
       * A pending `\r` is cancelled even when no *stage* is pending.
       *
       * The two are not the same window: `fire` deletes the pending entry
       * before it writes, so a session killed between a stage's text and its
       * carriage return has nothing in `pending` and a live timer in `submits`.
       * Returning early on the entry alone would leave that timer to write into
       * a dead pty.
       */
      const submit = submits.get(entityId);
      if (submit !== undefined) {
        clearTimeout(submit);
        submits.delete(entityId);
      }

      const entry = pending.get(entityId);
      if (!entry) return;
      clearTimeout(entry.timer);
      pending.delete(entityId);
    },

    /**
     * A stage awaiting its `\r` counts as pending (HIVE-63).
     *
     * `fire` deletes the pending entry *before* it writes, so between the text
     * and its carriage return there is no `pending` entry and the stage is
     * demonstrably not finished. `sessions.write` gates held input on this, so
     * the narrower reading opened a 300ms window in which a keystroke went
     * straight to the pty and was appended to the command line — the shell then
     * ran `claude --name sess-01 && exithello`.
     *
     * Moving `onComplete` after the `\r` fixed input that was *already* held;
     * this fixes input that arrives inside the window the split opened.
     */
    isPending: (entityId) => pending.has(entityId) || submits.has(entityId),

    dispose() {
      for (const entry of pending.values()) clearTimeout(entry.timer);
      for (const submit of submits.values()) clearTimeout(submit);
      pending.clear();
      submits.clear();
    },
  };
}
