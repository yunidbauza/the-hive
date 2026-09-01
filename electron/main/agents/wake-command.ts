/**
 * Turning an agent's *name* into the command line that wakes it (HIVE-115).
 *
 * The seam between `runs.ts` — which knows about processes and outcomes and
 * nothing about disks — and `waker.ts`, which is pure and knows only how to
 * spell an argv. Everything with a side effect that has to happen *before* a
 * spawn lives here: reading the definition, resolving the binary, writing the
 * system prompt, making the working directory.
 *
 * ## Why it is synchronous
 *
 * `RunTrackerDeps.command` is synchronous, and that is not an oversight to work
 * around. `run()` must decide "started" or "refused" in one turn — the renderer
 * gets a value back from `agents:run`, and a tracker that awaited here would
 * have a window in which `running` does not yet hold the agent and a second
 * `run` could slip past the one-at-a-time rule. So the reads are `*Sync`, and
 * they are three small local files.
 *
 * ## Why the definition is re-parsed rather than taken from `agents:list`
 *
 * `list()` returns {@link AgentSummary}, which carries what a row draws — not
 * `tools`, `limits`, `model` or the body, which is everything the argv is made
 * of. Re-reading also means a wake uses the file **as it is now**, which
 * matters most for the case the epic is built on: the user edits an AGENT.md in
 * their own editor and expects the next wake to obey it.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import {
  AGENT_FILE,
  KNOWN_AGENT_MCP,
  parseList,
  readFrontmatter,
  type AgentDefinition,
} from '@shared/agent-contract';

import { agentMcpConfig, type McpServerSpec } from '../mcp/agent-config';

import { resolveClaude } from './claude-path';
import { parseAgent } from './definition';
import { AGENT_PREAMBLE } from './preamble';
import type { AgentState } from './state';
import { systemPromptFor, wakeCommand, type WakeCommand } from './waker';

/** The three file operations a wake performs, injected so a test can watch them. */
export interface WakeFs {
  read: (path: string) => string;
  write: (path: string, text: string) => void;
  mkdir: (path: string) => void;
}

const REAL_FS: WakeFs = {
  read: (path) => readFileSync(path, 'utf8'),
  write: (path, text) => {
    writeFileSync(path, text, 'utf8');
  },
  mkdir: (path) => {
    mkdirSync(path, { recursive: true });
  },
};

export interface WakeCommandDeps {
  /** `~/.hive/agents`. Read per call, so a relocated config is honoured. */
  agentsRoot: () => string;
  /** `~/.hive/work/<name>`, created before the spawn. */
  workdir: (name: string) => string;
  /** `<userData>/hive/agents/<name>.system.md`, rewritten before the spawn. */
  promptFile: (name: string) => string;
  /** `<userData>/hive/plugin` — the skills The Hive generates. */
  pluginDir: () => string;
  /**
   * `hooks.agentSettingsPathFor()`. `null` until the receiver has bound.
   *
   * The agent-space twin of a session's settings file — it carries the
   * `permissions.ask: ["*"]` rule that routes every tool call through
   * `mcp__hive__approve` (HIVE-119). A wake must never read
   * `hooks.settingsPathFor()`: that file has no such rule, and an agent
   * started against it would run with no fence at all.
   */
  agentSettingsPath: () => string | null;
  /** `mcp.configPathFor()`. `null` until the config has been written. */
  mcpConfig: () => string | null;
  /**
   * `mcp.hiveServerSpec()`. `null` on the same condition `mcpConfig` is.
   *
   * Needed only for an agent that names an integration: its file is written
   * here rather than by the runtime, because it is per-wake content and this
   * is where per-wake files are written — the same place, and the same `fs`,
   * as `<name>.system.md`.
   */
  hiveServer: () => McpServerSpec | null;
  /** `<userData>/hive/agents/<name>.mcp.json`. */
  agentMcpFile: (name: string) => string;
  /** `hooks.envFor(name)` — the three variables that make a hook attributable. */
  hookEnv: (name: string) => Record<string, string>;
  claudeCommand: () => string;
  subscriptionAuth: () => boolean;
  /**
   * Read for `sessionUuid`, `runsSinceRotate` and the rotation the close left
   * pending; written only to *consume* that — never to record one.
   */
  state: AgentState;
  /** `process.env`, by the time HIVE-84 has repaired its `PATH`. */
  env: () => NodeJS.ProcessEnv;
  newUuid: () => string;
  /**
   * `permissions.grantsFor(name)` — the one-shot `allow-once` grants an
   * answered ask owes this particular wake (HIVE-119).
   *
   * Read once, right before the argv is spelled, and handed straight to
   * `wakeCommand` as `grants`: this wake's `HIVE_GRANTS`, never `def.tools`.
   * Calling it here rather than earlier is what makes the grant apply to the
   * wake it answered rather than to whichever wake happened to be building
   * next.
   */
  pendingGrants: (name: string) => string[];
  fs?: WakeFs;
  /**
   * How `resolveClaude` decides a candidate is runnable.
   *
   * Injected for the reason {@link WakeFs} is: without it, every test in this
   * module would depend on a `claude` binary being installed at whatever path
   * the fixture invented, and would then be asserting on the developer's
   * machine rather than on this function.
   */
  isExecutable?: (path: string) => boolean;
}

/**
 * What the tracker asks for: the argv, plus **which conversation it invokes**.
 *
 * The uuid is returned rather than left implicit because `runs.ts` uses it to
 * tell a late `Stop` hook for a finished run apart from one for the run now
 * live under the same name. Only this builder knows it — it is either the uuid
 * being resumed or the one `--session-id` starts — minted here on a first wake,
 * or taken from the rotation the close left pending — and which of the two it
 * is gets decided here.
 *
 * `lastTurn` travels for the same reason and to the same reader: the close
 * rotates only a run that was *asked* for a handoff, and nothing downstream can
 * re-derive that — the counter it was decided from is still sitting at its old
 * value, deliberately (HIVE-122).
 */
export type WakeInvocation = WakeCommand & {
  sessionUuid: string;
  lastTurn: boolean;
};

export type BuildWakeCommand = (
  name: string,
  trigger: string,
  extra?: string,
) => WakeInvocation | { problem: string };

const describe = (cause: unknown): string =>
  cause instanceof Error ? cause.message : String(cause);

/**
 * The refusal for both `mcpConfig` and `hiveServer` reading `null` — the same
 * wording, because they are the same fact told twice: the shared config and
 * the per-agent one both depend on the hive server having been written, and
 * an agent that cannot read its inbox has nothing to do.
 */
const MCP_NOT_READY =
  'The ledger tools are not configured yet, and an agent reads its ' +
  'inbox before anything else. Try again in a moment.';

/**
 * Parse an AGENT.md for the purpose of **running** it.
 *
 * The one difference from the registry's parse, and it is deliberate: the
 * skills the file declares are passed in as the set of skills that exist, and
 * `hiveSkillNames` is empty.
 *
 * `parseAgent`'s skill check answers "did you spell this right?", and the place
 * that question belongs is the editor, where the author is still present and
 * `readAvailableSkillNames` has scanned the machine. At wake time it answers a
 * different and worse question: a skill folder renamed, a plugin uninstalled,
 * or a `~/.claude` that has simply not been scanned yet would make this refuse
 * to wake the agent **at all** — where the honest consequence of a missing
 * skill is an agent that runs without it. The same goes for the name-clash rule
 * `hiveSkillNames` drives: it stops a *new* agent taking a skill's name, and
 * re-litigating it against a definition already sitting on disk could only ever
 * strand an agent the user cannot fix from the pane.
 *
 * Every other rule in the grammar — required fields, the two wake modes, the
 * closed key set, the folder/name match — still applies, because those are
 * facts about the file rather than about the machine, and a file that fails
 * them cannot produce an argv.
 */
function parseForWake(
  source: string,
  folder: string,
): { def: AgentDefinition } | { problem: string } {
  const read = readFrontmatter(source);
  const declared =
    read === null
      ? []
      : (parseList(read.fields.get('skills')?.value ?? '[]') ?? []);

  const result = parseAgent(source, {
    folder,
    skillNames: declared,
    hiveSkillNames: [],
    integrations: KNOWN_AGENT_MCP,
  });

  if ('def' in result) return result;

  const first = result.problems[0];

  if (first === undefined) return { problem: `${folder} could not be read.` };

  return {
    problem:
      first.field === ''
        ? first.reason
        : `${first.field}: ${first.reason}`,
  };
}

export function createWakeCommand(deps: WakeCommandDeps): BuildWakeCommand {
  const fs = deps.fs ?? REAL_FS;

  return (name, trigger, extra) => {
    /*
      Both of these are refusals rather than a wake without the flag, and the
      reason is the same for each: the flag is not decoration.

      Without `--settings` the run loads no Hive hooks, so nothing arms the
      stall watchdog and a wedged turn sits until the app quits. Without
      `--mcp-config` there are no `ledger_*` tools — and the preamble's first
      instruction is to call one. An agent that cannot read its inbox has
      nothing to do, so starting it would burn a turn to accomplish nothing.
    */
    const settings = deps.agentSettingsPath();

    if (settings === null) {
      return {
        problem:
          'The agent settings file has not been written yet, so a run could ' +
          'not be tracked. Try again in a moment.',
      };
    }

    const mcpConfig = deps.mcpConfig();

    if (mcpConfig === null) {
      return { problem: MCP_NOT_READY };
    }

    let source: string;

    try {
      source = fs.read(join(deps.agentsRoot(), name, AGENT_FILE));
    } catch {
      return { problem: `There is no agent called ${name}.` };
    }

    const parsed = parseForWake(source, name);

    if ('problem' in parsed) return parsed;

    const claude =
      deps.isExecutable === undefined
        ? resolveClaude(deps.claudeCommand(), deps.env()['PATH'])
        : resolveClaude(
            deps.claudeCommand(),
            deps.env()['PATH'],
            deps.isExecutable,
          );

    if ('problem' in claude) return claude;

    const { def } = parsed;
    const previous = deps.state.read(name);
    /*
      A resumed session carries every earlier turn, so its cost per wake climbs
      without bound. Rotation bounds it — but as a handover, not an amnesia
      (HIVE-122).

      Two wakes, and this decides which of them is happening. The wake that
      crosses the threshold still `--resume`s the old conversation: an agent
      asked to summarise what it knows must still be able to remember it. What
      changes is the prompt. Whether the rotation then actually happens is the
      *close's* call, gated on a handoff having been posted — which is why
      nothing here resets the counter or touches the uuid any more.

      `pendingSession` is the other side: a rotation the close already decided,
      waiting for a wake to start it.

      The `sessionUuid` term is what keeps a *forced* rotation coherent
      (HIVE-122). Only a run sets that field, so the counter can never reach
      this arm with it missing — but the console's `rotate` verb can, on an
      agent installed a minute ago. Without the term that wake would be a last
      turn on a brand-new `--session-id` session: an agent asked to summarise a
      conversation that has never happened, and a handoff that could only be
      invention. With it, a forced rotation on a never-run agent degrades to
      the ordinary first wake, which is already the fresh session the user was
      asking for.
    */
    const pending = previous.pendingSession;
    const lastTurn =
      pending === undefined &&
      previous.sessionUuid !== undefined &&
      (previous.forceRotate === true ||
        previous.runsSinceRotate >= def.limits.rotateAfter);
    const workdir = deps.workdir(name);
    const systemPrompt = deps.promptFile(name);
    let agentMcp: string | null = null;

    try {
      fs.mkdir(workdir);
      fs.mkdir(dirname(systemPrompt));
      // Rewritten on every wake, so an app update to the preamble reaches every
      // agent without anyone editing anything.
      fs.write(systemPrompt, systemPromptFor(AGENT_PREAMBLE, def));

      /*
        Only for an agent that names one. An agent with an empty `mcp:` keeps
        pointing at the shared file: its per-agent copy would be byte-identical,
        and a second file per agent is a second thing to go stale.
      */
      if (def.mcp.length > 0) {
        const hive = deps.hiveServer();

        if (hive === null) return { problem: MCP_NOT_READY };

        agentMcp = deps.agentMcpFile(name);
        fs.mkdir(dirname(agentMcp));
        fs.write(agentMcp, agentMcpConfig(hive, def.mcp));
      }
    } catch (cause) {
      return { problem: `Could not prepare the run: ${describe(cause)}` };
    }

    /*
      Consumed **after** the writes that can fail, and only on the path that
      returns a command — the same ordering the rotation record already used,
      for a sharper version of the same reason. Clearing `pendingSession` before
      a transient fs error would discard the handoff permanently: no run, and
      the agent's memory gone anyway, which is strictly worse than the stale
      counter that ordering was originally written to prevent.
    */
    if (pending !== undefined || previous.forceRotate === true) {
      deps.state.patch(name, {
        pendingSession: undefined,
        forceRotate: undefined,
      });
    }

    const resuming = pending === undefined ? previous.sessionUuid : undefined;
    const minted = pending?.uuid ?? deps.newUuid();

    const command = wakeCommand({
      claudePath: claude.path,
      def,
      ...(resuming === undefined ? {} : { sessionUuid: resuming }),
      newUuid: minted,
      trigger,
      ...(extra === undefined ? {} : { extra }),
      ...(lastTurn ? { lastTurn: true as const } : {}),
      ...(pending === undefined ? {} : { handoff: pending.handoff }),
      paths: {
        settings,
        pluginDir: deps.pluginDir(),
        mcpConfig: agentMcp ?? mcpConfig,
        systemPrompt,
        workdir,
      },
      env: {
        base: deps.env(),
        hook: deps.hookEnv(name),
        subscriptionAuth: deps.subscriptionAuth(),
      },
      grants: deps.pendingGrants(name),
    });

    // Whichever of the two `wakeCommand` actually spelled — `--resume <uuid>`
    // or `--session-id <uuid>`. The tracker matches a Stop hook against it.
    return { ...command, sessionUuid: resuming ?? minted, lastTurn };
  };
}
