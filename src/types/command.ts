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
