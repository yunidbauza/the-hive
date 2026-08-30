import type { AgentDefinition } from '@shared/agent-contract';
import { AUTH_ENV_KEYS, isSessionEnvDenied } from '@shared/config-contract';

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
}

export interface WakeCommand {
  file: string;
  args: string[];
  env: Record<string, string>;
  cwd: string;
}

export function wakePrompt(trigger: string, extra?: string): string {
  const because =
    extra === undefined || extra === ''
      ? `You woke because: ${trigger}.`
      : `You woke because: ${trigger} — ${extra}.`;

  return `${because} Read your ledger inbox first, then do your job. End your turn when nothing is left or when you are waiting on an answer.`;
}

export function systemPromptFor(
  preamble: string,
  def: AgentDefinition,
): string {
  return `${preamble.trimEnd()}\n\n---\n\n${def.body.trim()}\n`;
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
    wakePrompt(input.trigger, input.extra),
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

  return {
    file: input.claudePath,
    args,
    env: { ...merged, ...env.hook, HIVE_AGENT: '1' },
    cwd: paths.workdir,
  };
}
