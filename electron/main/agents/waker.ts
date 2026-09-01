import type { AgentDefinition, Autonomy } from '@shared/agent-contract';
import { AUTH_ENV_KEYS, isSessionEnvDenied } from '@shared/config-contract';
import { HOOK_ENV_GRANTS } from '@shared/hook-contract';

/**
 * The command line one wake runs (HIVE-115).
 *
 * Pure on purpose: no spawn, no disk, no `app.getPath`. Everything variable is
 * an argument, so the entire command line — the thing that is hardest to be
 * sure of and most expensive to get wrong — is assertable in a unit test
 * rather than only observable in a live run.
 *
 * ## Why `--setting-sources ""`
 *
 * Without it the run loads the user's own `~/.claude/settings.json`. On a
 * developer machine that routinely carries `permissions.defaultMode: "auto"`,
 * which would auto-approve every tool an unattended agent asked for, and would
 * fire the user's personal hooks inside the agent's turn. Verified that
 * `--settings` still applies alongside it, so the Hive's own hooks — the ones
 * that close a run — keep firing.
 *
 * ## Why `--allowedTools` is a grant and not a fence
 *
 * Measured at 2.1.251: the flag is additive. Asked for Bash with
 * `--allowedTools "Read"`, the model used Bash — with or without
 * `--setting-sources ""`, and under `--permission-mode dontAsk` too. There is
 * no default-deny in `-p`. `def.tools` therefore *grants*; confinement is
 * HIVE-119's permission-prompt tool, which is the mechanism built for it.
 */

export interface WakePaths {
  settings: string;
  pluginDir: string;
  mcpConfig: string;
  systemPrompt: string;
  workdir: string;
}

export interface WakeEnv {
  base: NodeJS.ProcessEnv;
  /** `HIVE_SESSION_ID`, `HIVE_HOOK_TOKEN`, `HIVE_RECEIVER_URL`. */
  hook: Record<string, string>;
  subscriptionAuth: boolean;
}

export interface WakeInput {
  claudePath: string;
  def: AgentDefinition;
  /** Absent on the very first run, which mints one instead. */
  sessionUuid?: string;
  newUuid: string;
  trigger: string;
  extra?: string;
  paths: WakePaths;
  env: WakeEnv;
  /**
   * Grants that apply to **this wake only** — an answered `allow-once`.
   *
   * Not merged into `def.tools`, because the definition is the durable record
   * and this is deliberately not durable. A permanent grant takes the other
   * road: it is written into `AGENT.md` when the answer arrives, and reaches
   * the next wake as an ordinary `def.tools` entry.
   */
  grants?: readonly string[];
  /**
   * This wake is the agent's last turn on this session (HIVE-122).
   *
   * Replaces the wake prompt with the one that asks for a handoff. The command
   * line is otherwise identical — a handoff wake still `--resume`s the old
   * conversation, because a handoff written by an agent that cannot remember
   * anything would be worthless.
   */
  lastTurn?: true;
  /**
   * The previous session's handoff, prefixed onto this wake's prompt.
   *
   * Set only on the first wake of a fresh session, together with the
   * `--session-id` that starts it. Never set with {@link WakeInput.lastTurn}.
   */
  handoff?: string;
}

export interface WakeCommand {
  file: string;
  args: string[];
  env: Record<string, string>;
  cwd: string;
}

export function wakePrompt(
  trigger: string,
  extra?: string,
  rotation?: { lastTurn?: true; handoff?: string },
): string {
  /*
    A last turn replaces the instruction rather than adding to it: "do the work,
    then end" and "wind this session up" are one instruction, not two, and an
    agent given both tends to do only the first.

    It still has to name the work the same way {@link normal} does. This branch
    was missed when the other two strings were reworded, and it said "do your
    normal work if something is waiting" — the inbox-conditional framing the
    rest of this change exists to remove. With `every: 5m` and the default
    `rotate_after: 50` a rotation wake lands about every four hours, so that
    left the original defect alive on one wake in fifty.
  */
  if (rotation?.lastTurn === true) {
    return `This is your last turn on this session. Carry out your instructions for this wake as usual — they are standing work whether or not anything is waiting in your inbox — then post a handoff with ledger_handoff: what you watch, open threads and their ids, decisions and preferences you have learned, anything a fresh copy of you must know. Then finish your turn.`;
  }

  const because =
    extra === undefined || extra === ''
      ? `You woke because: ${trigger}.`
      : `You woke because: ${trigger} — ${extra}.`;

  /*
    "Read your ledger inbox first, then do your job" left "your job" undefined
    at the one moment it decided anything: a wake whose inbox is empty. Sixteen
    consecutive wakes of a real agent ended in about four seconds having done
    nothing, while its body sat in the system prompt saying what to do.

    The failure is on the *resumed* wake specifically, which is every scheduled
    wake after the first. A fresh session acts on its body under either wording;
    a resumed one can see in its own transcript that the work is already behind
    it, and the old prompt gave it no reason to do it again. Proved both ways in
    `tests/live/agent-conformance.test.ts`, which is also why the sentence about
    an empty inbox is load-bearing rather than decorative — without it, "read the
    inbox" and "do the work" read as one instruction with a precondition rather
    than two separate things to do.
  */
  const normal = `${because} Read your ledger inbox, then carry out the instructions you were given. An empty inbox does not mean there is nothing to do — your instructions are standing work and this wake is one of the times to do them. End your turn when that work is done, or when you are waiting on an answer.`;

  // The handoff comes first: it is the context the rest of the prompt assumes.
  return rotation?.handoff === undefined
    ? normal
    : `You are continuing from a previous session of yourself. Its handoff:\n\n${rotation.handoff}\n\n${normal}`;
}

/**
 * What `autonomy:` actually does, in one sentence per mode.
 *
 * The field parsed into {@link AgentDefinition} and was then read by nothing:
 * not this prompt, not the argv, not the fence — while the form's help text
 * described its behaviour in detail. It is spelled out here because the system
 * prompt is the only place it *can* take effect. Neither clause is a security
 * boundary and neither pretends to be: the tool fence is what stops a call, and
 * `act` does not pre-allow anything. This is about what the agent does with a
 * judgement call the fence has no opinion on.
 *
 * `ask` is the parsed default (`definition.ts`), so it is the clause a
 * definition with no `autonomy:` line receives — which, since nothing read the
 * field before, is every definition written so far. That makes its wording
 * load-bearing in a way `act`'s is not, and it is why the sentence says
 * outright that carrying out its instructions is not the kind of thing to ask
 * about. An agent that asked once per wake would be worse than one that never
 * asked: `scheduler.ts` deliberately leaves an `asking` agent's `nextRunAt`
 * stale until the answer lands, so a needless ask costs it every scheduled wake
 * until someone replies or the ask expires.
 */
const AUTONOMY_CLAUSE: Record<Autonomy, string> = {
  ask: '**Check before you act on anything consequential.** Post a `ledger_ask` describing what you propose to do, then end your turn and wait for the answer. This is not a reason to skip your instructions or to ask permission to follow them: carrying out the work you were given is what you are awake for, and the routine steps it already covers need no asking. Ask about a *decision* their author would want a say in — something outward, irreversible, or not covered by what you were told.',
  act: '**Proceed without asking, and report afterwards.** Your instructions are your authority: carry them out and say what you did with `ledger_done`. Ask only when you are genuinely blocked, not to confirm what you were already told to do.',
};

export function systemPromptFor(
  preamble: string,
  def: AgentDefinition,
): string {
  /*
    The body stays last, below the separator, and the app-owned sentences all
    sit above it. Appending one underneath would put words the user did not
    write in the position their own instructions occupy — and make an
    app-owned sentence the final thing the model reads.
  */
  return `${preamble.trimEnd()}\n\n${AUTONOMY_CLAUSE[def.autonomy]}\n\n---\n\n${def.body.trim()}\n`;
}

export function wakeCommand(input: WakeInput): WakeCommand {
  const { def, paths, env } = input;

  const args = [
    '-p',
    ...(input.sessionUuid === undefined
      ? ['--session-id', input.newUuid]
      : ['--resume', input.sessionUuid]),
    '--name',
    def.name,
    ...(def.model === undefined ? [] : ['--model', def.model]),
    ...(def.effort === undefined ? [] : ['--effort', def.effort]),
    '--settings',
    paths.settings,
    // The isolation flag. See the module comment.
    '--setting-sources',
    '',
    '--plugin-dir',
    paths.pluginDir,
    '--mcp-config',
    paths.mcpConfig,
    '--strict-mcp-config',
    '--allowedTools',
    ['mcp__hive__*', ...def.tools].join(','),
    /*
      The fence (HIVE-119). `--allowedTools` above is a grant and cannot deny;
      what actually stops an ungranted call is the `permissions.ask: ["*"]` rule
      in the agent settings file, which routes every call here. Measured: the
      flag is hidden from `--help` but real, and does nothing without that rule.

      Never add `--permission-mode`: `dontAsk` skips this tool and auto-denies.
    */
    '--permission-prompt-tool',
    'mcp__hive__approve',
    '--max-turns',
    String(def.limits.turns),
    ...(def.limits.budgetUsd === undefined
      ? []
      : ['--max-budget-usd', String(def.limits.budgetUsd)]),
    '--append-system-prompt-file',
    paths.systemPrompt,
    '--output-format',
    'stream-json',
    '--verbose',
    wakePrompt(input.trigger, input.extra, {
      ...(input.lastTurn === undefined ? {} : { lastTurn: input.lastTurn }),
      ...(input.handoff === undefined ? {} : { handoff: input.handoff }),
    }),
  ];

  const merged: Record<string, string> = {};

  /*
    The same deny rule a pty gets, through the same predicate.

    `buildSessionEnv` is deliberately *not* called here: it also forces `TERM`,
    `COLORTERM` and `PWD`, which are a terminal's identity and mean nothing to a
    headless child with no tty. What a headless child does need is
    `isSessionEnvDenied`, and it needs it more than a pty does.

    Launch The Hive with `pnpm desktop:dev` from inside a Claude Code session —
    which is how it gets developed — and main inherits `CLAUDECODE=1`,
    `CLAUDE_CODE_SESSION_ID` and `CLAUDE_CODE_CHILD_SESSION=1`. Handed on, every
    agent **joins the launching session instead of starting its own**: `--name`
    is ignored, `Stop` reports the launching session's `session_id` so
    `noteTurnEnded` discards it and the stall watchdog can never arm, and the
    inherited child-session marker turns transcript saving off, which is what
    `--resume` reads on the next wake. `ELECTRON_RUN_AS_NODE`, `NODE_OPTIONS`
    and `NODE_PATH` are the other half: Electron's own wiring, meaningless to a
    node CLI started from it and actively harmful to one.
  */
  for (const [key, value] of Object.entries(env.base)) {
    if (value !== undefined && !isSessionEnvDenied(key)) merged[key] = value;
  }

  /*
    Deletion, not a shell `unset` prefix.

    `bootstrap.ts` prefixes `unset …` because a session runs inside a login
    shell that re-sources the user's rc files and could export the key again.
    There is no shell here, so the key simply never exists.
  */
  if (env.subscriptionAuth) {
    for (const key of AUTH_ENV_KEYS) delete merged[key];
  }

  /*
    `mcp__hive__*` is first and unconditional: an agent that cannot call
    `ledger_read` cannot read the inbox that would tell it why it was woken,
    and would deadlock on its own fence. `input.grants` is a one-shot
    `allow-once` for this wake only — never merged into `def.tools`.

    `ToolSearch` sits beside it, unconditional for the same reason and found
    the same way — a live run, not a unit test. MCP tool schemas are
    deferred: the model sees `mcp__hive__ledger_read` by name in its tool
    list, but must call the *built-in* `ToolSearch` to fetch that schema
    before it can invoke it. `ToolSearch` never appears in any `def.tools` —
    nobody would think to grant a built-in — so without this the fence denies
    the very first thing an agent's preamble tells it to do: read its ledger
    inbox. Granting `mcp__hive__*` is worthless if nothing can load the
    schema to call it. This grants no *capability*: `ToolSearch` only reveals
    tool schemas, and every tool it surfaces is still checked by the fence
    the moment it is actually called — so widening this list widens nothing
    an agent can do, only what it can find out it could ask to do.
  */
  merged[HOOK_ENV_GRANTS] = JSON.stringify([
    'mcp__hive__*',
    'ToolSearch',
    ...def.tools,
    ...(input.grants ?? []),
  ]);

  return {
    file: input.claudePath,
    args,
    env: { ...merged, ...env.hook, HIVE_AGENT: '1' },
    cwd: paths.workdir,
  };
}
