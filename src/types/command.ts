/**
 * The orchestrator console's command grammar, as data.
 *
 * Parsing and execution are split on purpose (story 041): the parser is pure
 * and lives in `features/orchestrator/utils/parse-command.ts`, the executor is
 * a store action. This type is the contract between them, and it lives in
 * `types/` because `stores/` may not import `features/` — the store takes an
 * already-parsed command rather than a raw string.
 *
 * That split is not just tidiness. This union is the closest thing the
 * prototype has to the future daemon's API surface: every command the user can
 * issue, with its arguments already validated, in one place.
 */

/** Commands whose failure is a *shape* problem the parser can see by itself. */
export type UsageCommand = 'open' | 'send' | 'spawn';

export type ParsedCommand =
  /** Whitespace only. Execution is a no-op — not an error. */
  | { kind: 'empty'; raw: string }
  | { kind: 'help'; raw: string }
  | { kind: 'status'; raw: string }
  | { kind: 'clear'; raw: string }
  | { kind: 'open'; raw: string; target: string }
  | { kind: 'send'; raw: string; target: string; message: string }
  | { kind: 'spawn'; raw: string; repo: string; task: string }
  /** Right verb, wrong arguments. */
  | { kind: 'usage'; raw: string; command: UsageCommand }
  /** No such verb. */
  | { kind: 'unknown'; raw: string; command: string };

/**
 * The usage line for each command that takes arguments.
 *
 * Exported so the parser and the executor cannot disagree about what a command
 * looks like — and so the console's placeholder text has one source too.
 */
export const USAGE: Record<UsageCommand, string> = {
  open: 'usage: open <session>',
  send: 'usage: send <session> <message>',
  spawn: 'usage: spawn <repo> <task>',
};

/**
 * Every verb a user can type, in the order the hint bar shows them (HIVE-93).
 *
 * The console's footer used to spend its third slot on
 * `read-only — the orchestrator coordinates in the background`, so the grammar
 * was discoverable only by typing `help` — which you have to already know
 * exists. This is that list, and it lives here because this file is already "the
 * command grammar, as data" and is the one thing both the parser and the store
 * are allowed to share.
 *
 * `satisfies` rather than a bare array: it does not prove the list is
 * *complete* — nothing short of restructuring the parser's switch could — but it
 * does mean renaming a verb in {@link ParsedCommand} stops this compiling
 * instead of leaving the footer advertising a command that no longer parses.
 *
 * Ordered by what a new user needs first (`help`), then read, then act. Not
 * alphabetical: `clear` is last because it is the only destructive one.
 */
export const CONSOLE_VERBS = [
  'help',
  'status',
  'open',
  'send',
  'spawn',
  'clear',
] as const satisfies readonly ParsedCommand['kind'][];
