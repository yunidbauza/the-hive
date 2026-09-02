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
export type UsageCommand =
  | 'open'
  | 'send'
  | 'spawn'
  | 'ledger'
  | 'ask'
  | 'answer'
  | 'run'
  | 'pause'
  | 'resume'
  | 'kill'
  | 'rotate';

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
  /**
   * The first five agent verbs (HIVE-117); `rotate` below is the sixth
   * (HIVE-122).
   *
   * `run` carries a target **and an optional prompt** (HIVE-126), which makes
   * it the one agent verb shaped like `send` rather than `open`. It used to
   * take a bare name, and the grammar was recording a decision in the contract:
   * `AgentRunRequest` was `{ name }` with a closed key set, so a task had
   * nowhere to travel. HIVE-126 opened that key set for prose — the prompt
   * reaches the agent as the tail of `You woke because: manual — …` — because
   * a verb that silently dropped what a user typed was worse than the widening.
   *
   * The other four here, and `rotate` below, still take a bare name and share
   * `open`'s shape. The asymmetry is not an inconsistency: each of them means
   * exactly one thing, and `run` is the only one a person can have a *reason*
   * for. `agents` takes nothing at all.
   */
  | { kind: 'agents'; raw: string }
  | { kind: 'run'; raw: string; target: string; prompt?: string }
  | { kind: 'pause'; raw: string; target: string }
  | { kind: 'resume'; raw: string; target: string }
  | { kind: 'kill'; raw: string; target: string }
  /**
   * The sixth (HIVE-122).
   *
   * A bare name like the four above, and for the same reason: the payload it
   * becomes is an `AgentNameRequest`. What it means is "end this session after
   * a handoff" — the rotation `rotate-after` performs unattended, brought
   * forward by hand.
   */
  | { kind: 'rotate'; raw: string; target: string }
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
  ask: 'usage: ask <agent> <message>',
  answer: 'usage: answer <id> <text>',
  /*
    `<agent>`, not `<session>`, on all five — these four and `rotate` below.
    The word is what tells a reader that `send` is not the verb for these and
    that a session id will not do — the console's only other cue is the
    refusal they get after guessing wrong.

    `run` alone takes a second argument (HIVE-126), and `[prompt]` is bracketed
    because a bare `run <agent>` is still a whole command.
  */
  run: 'usage: run <agent> [prompt]',
  pause: 'usage: pause <agent>',
  resume: 'usage: resume <agent>',
  kill: 'usage: kill <agent>',
  /*
    The one usage line here that explains rather than only spells. `rotate` is
    the only verb whose name does not say what happens — a user who reads
    "rotate" guesses log rotation — and the half that matters is the half a
    bare `rotate <agent>` would hide: the agent is asked to hand off first, so
    nothing is thrown away.
  */
  rotate: 'usage: rotate <agent> — end this agent’s session after a handoff',
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
  /*
    The agent verbs sit after the session ones and before `clear`, keeping the
    file's "read, then act" order within a second group rather than
    interleaving the two vocabularies: `agents` lists, and the five that follow
    act on one. A reader scanning the footer meets the whole fleet first and
    the tenants second, which is the order the stage itself is in.

    `rotate` goes last of the five (HIVE-122): it is the rarest — most
    rotations happen on the counter, unattended — and the only one whose
    consequence outlives the run it starts.
  */
  'agents',
  'run',
  'pause',
  'resume',
  'kill',
  'rotate',
  'clear',
] as const satisfies readonly ParsedCommand['kind'][];

/**
 * The verbs the console keeps quiet about: still parsed, still executed, but
 * absent from the hint bar and from `help`.
 *
 * `answer` is the one so far. An open ask reaches the user as a card in the
 * inbox with its own reply field, and that card is the route worth teaching —
 * it shows the question, the agent and the short ref, none of which a bare
 * `answer <id> <text>` line does. Advertising the verb beside it taught two
 * ways to do one thing and made the harder one look official. The parser
 * keeps it because a typed `answer a12 yes` should still work for whoever
 * already knows it, and because a verb that vanished from the grammar would
 * turn every old transcript's advice into `command not found`.
 */
export const QUIET_VERBS: ReadonlySet<ParsedCommand['kind']> = new Set(['answer']);

/**
 * {@link CONSOLE_VERBS} minus {@link QUIET_VERBS} — what the hint bar prints.
 *
 * Derived rather than listed a second time, so hiding a verb is one line in
 * the set above and can never leave the two lists disagreeing about order.
 */
export const ADVERTISED_VERBS: readonly ParsedCommand['kind'][] = CONSOLE_VERBS.filter(
  (verb) => !QUIET_VERBS.has(verb),
);
