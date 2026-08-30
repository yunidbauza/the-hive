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
export type UsageCommand = 'open' | 'send' | 'spawn' | 'ledger' | 'ask' | 'answer';

/**
 * How many entries `ledger` prints when `-n` is not given (HIVE-113).
 *
 * Here rather than in the store because this file is already "the command
 * grammar, as data": the parser resolves the flag into `limit`, so the store
 * never has to know there was a default at all.
 */
export const LEDGER_TAIL_DEFAULT = 20;

export type ParsedCommand =
  /** Whitespace only. Execution is a no-op — not an error. */
  | { kind: 'empty'; raw: string }
  | { kind: 'help'; raw: string }
  | { kind: 'status'; raw: string }
  | { kind: 'clear'; raw: string }
  | { kind: 'open'; raw: string; target: string }
  | { kind: 'send'; raw: string; target: string; message: string }
  /**
   * `project` is whatever the user typed — a key, an id or a name (HIVE-94).
   *
   * Not `repo`, and not resolved here: the parser cannot know which projects
   * exist, so this carries the raw reference and the store resolves it through
   * `resolveProjectRef`. The rename is not cosmetic — the field used to be
   * called `repo` back when a project *was* a repository, and the console now
   * spawns into any directory a PTY can take as a `cwd`.
   */
  | { kind: 'spawn'; raw: string; project: string; task: string }
  /**
   * The ledger tail (HIVE-113).
   *
   * `from` and `to` are *party* filters rather than dates — they map straight
   * onto `LedgerReadQuery`, which is what keeps the console and main agreeing
   * about what a filter means. `limit` is resolved by the parser rather than
   * left optional, so there is exactly one copy of the default.
   */
  | {
      kind: 'ledger';
      raw: string;
      open: boolean;
      events: boolean;
      from?: string;
      to?: string;
      limit: number;
    }
  | { kind: 'ask'; raw: string; target: string; message: string }
  /**
   * `thread` is whatever the user typed — a short ref (`a12`) or a canonical
   * id. The parser cannot know which exist, so it does not try: `resolveRef`
   * in main accepts either and always stores the canonical id.
   */
  | { kind: 'answer'; raw: string; thread: string; message: string }
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
  spawn: 'usage: spawn <project> <task>',
  ledger: 'usage: ledger [--open] [--events] [--from <party>] [--to <party>] [-n <count>]',
  ask: 'usage: ask <session> <message>',
  answer: 'usage: answer <id> <text>',
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
  'ledger',
  'open',
  'send',
  'ask',
  'answer',
  'spawn',
  'clear',
] as const satisfies readonly ParsedCommand['kind'][];
