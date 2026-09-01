// @vitest-environment node
import { spawn as spawnProcess, type SpawnOptions } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  agentPromptFile,
  agentStateFile,
  agentWorkdir,
  agentsRoot,
} from '../../electron/main/agents/paths';
import { createPermissions, type Permissions } from '../../electron/main/agents/permissions';
import { createAgentRegistry, type AgentRegistry } from '../../electron/main/agents/registry';
import { createRunTracker, type ChildLike, type RunTracker } from '../../electron/main/agents/runs';
import {
  createScheduler,
  type Scheduler,
} from '../../electron/main/agents/scheduler';
import { createAgentState, type AgentState } from '../../electron/main/agents/state';
import { createWakeCommand } from '../../electron/main/agents/wake-command';
import { createReceiver, type Receiver } from '../../electron/main/hooks/receiver';
import { writeAgentSettings } from '../../electron/main/hooks/settings';
import { runAsync } from '../../electron/main/integrations/github/run';
import { readSlackStatus } from '../../electron/main/integrations/slack/status';
import { createLedger, type Ledger } from '../../electron/main/ledger';
import { agentMcpConfigFile } from '../../electron/main/mcp';
import { hiveServerSpec, mcpConfig } from '../../electron/main/mcp/config';
import { createSkillsRuntime } from '../../electron/main/skills';
import type {
  AgentRunState,
  RunLine,
  WakeSpec,
} from '../../electron/shared/agent-contract';
import {
  HOOK_ENV_RECEIVER_URL,
  HOOK_ENV_SESSION,
  HOOK_ENV_TOKEN,
  type HookAgentEvent,
  type HookStatusEvent,
} from '../../electron/shared/hook-contract';
import { CONFIG_PATH_ENV } from '../../electron/shared/config-contract';
import { LEDGER_DIR, OVERMIND } from '../../electron/shared/ledger-contract';
import { SLACK_TOOL_GLOB, SLACK_TOOL_PREFIX } from '../../electron/shared/slack-contract';

/**
 * What only a real `claude` can prove about a wake (HIVE-115).
 *
 * Every other test in this story is written against a recording `child_process`
 * fake, and every one of them would pass just as happily on a build whose argv
 * names a flag that does not exist. That is the whole weakness: `--max-turns`
 * and `--append-system-prompt-file` are both hidden from `--help`,
 * `--setting-sources ""` is the flag that decides whether the user's own
 * `permissions.defaultMode: "auto"` leaks into an unattended turn, and
 * `--resume` is the difference between an agent with a memory and an agent that
 * starts from nothing every wake. A fake cannot answer any of those.
 *
 * So this composes the *real* modules — `createWakeCommand`, `createRunTracker`,
 * a real `createReceiver` and a real `createLedger` — the same way
 * `ipc/index.ts` does, and runs two wakes against the binary on PATH.
 *
 * ## What it asserts, and why each one needs a real process
 *
 * 1. One wake spawns exactly one process, and that process exits. A fake can
 *    only prove the tracker *called* spawn.
 * 2. The `Stop` hook came back **under the agent's name**, and no session status
 *    was ever published. This is the whole of `--settings` surviving
 *    `--setting-sources ""`, and of the receiver's two id spaces staying apart.
 * 3. `run.started` and `run.ended` are both in the ledger — the run is legible
 *    afterwards, not only while it was live.
 * 4. `agents.json` gained a `sessionUuid` and a run summary with a `costUsd`,
 *    both read off the `result` event the CLI actually emitted.
 * 5. The **second** wake's argv carries `--resume <that same uuid>`, the run it
 *    starts does not fail, and it reports **the same uuid back** — which is the
 *    only proof the uuid the first run reported is one the binary will accept,
 *    and will keep, rather than replacing with a fresh one on resume.
 * 6. The run log holds at least one `ink` line: the agent actually spoke, and
 *    `foldRunLog` read a real `stream-json` stream rather than a hand-written
 *    one.
 *
 * ## Why it is opt-in
 *
 * It needs the binary, a network, an authenticated account, `out/main/mcp-host.js`
 * from `pnpm desktop:build`, and about a minute and a half of real model time.
 * `describe.skipIf` makes the default cost one skipped suite. Run it with
 * `pnpm test:agent`, and run it whenever the Claude Code version this app
 * targets moves — it is the only thing in this story that can notice a flag
 * being removed under it.
 *
 * ## The two things it has to pin, or it fails confusingly
 *
 * **The tools.** `--allowedTools` grants and cannot restrict (see `waker.ts`),
 * so a turn that reaches for something ungranted is not blocked there — it is
 * routed to `mcp__hive__approve` (HIVE-119), which checks it against
 * `HIVE_GRANTS` and, finding no match, writes a permission ask to the ledger
 * and denies the call. That is a real fence, not a hang: the model gets a
 * denial back, the preamble tells it to end its turn rather than retry, and
 * the run finishes with an open ask — but an *unplanned* denial still lands on
 * an assertion far from the one it broke, and takes real model minutes to get
 * there. The definitions below therefore grant the read-only set a small model
 * plausibly reaches for, and the body tells it not to reach for anything else;
 * the one scenario that deliberately reaches for an ungranted tool (below)
 * pins its own agent's tools just as narrowly, so the only denial it can hit
 * is the one it is testing for.
 *
 * **The timeout.** Real turns take far longer than Vitest's default five
 * seconds; a short timeout here produces a red run that looks like a product
 * bug and is not one.
 */

const LIVE = process.env['HIVE_LIVE_AGENT_PROOF'] === '1';

/**
 * How long teardown waits for a signalled child to actually be gone.
 *
 * Comfortably past `AGENT_KILL_GRACE_MS`, so the SIGTERM → SIGKILL escalation
 * gets its full chance before this gives up on a process it cannot reach.
 */
const TEARDOWN_WAIT_MS = 10_000;

/** The agent this suite creates, wakes twice, and throws away. */
const NAME = 'probe-agent';

/**
 * The agent that asks, is answered, and is woken by the answer (HIVE-120).
 *
 * A second definition rather than a second body for {@link NAME}, because the
 * two prove different things and the first one's value is that it *never*
 * asks — an agent whose turn ends `asking` would change what every assertion
 * above it means.
 */
const ASKER = 'probe-asker';

/** The agent a *session* asks, to prove the wake is not the overmind's alone. */
const RESPONDER = 'probe-responder';

/**
 * The agent whose `tools:` does not include `Bash` (HIVE-119).
 *
 * Its own definition, not a fourth body for {@link NAME}, for the reason
 * {@link ASKER} already is one: this is the one agent in the suite that is
 * *meant* to hit the fence, and every assertion below it depends on that
 * being the only ungranted reach it makes.
 *
 * `wake.on: [ledger]` **is** declared, and the second wake below is left to
 * the scheduler rather than driven by hand — on purpose. An earlier version
 * of this suite drove both wakes itself, off the same worry `ipc/index.ts`'s
 * listener now names explicitly: the overmind's answer is also a grant, and
 * a wake that races the still-in-flight `AGENT.md` write would retry into a
 * second denial. Hand-driving the second wake made that race unreachable —
 * which meant this suite could not have noticed it either way. The fix
 * belongs in `ipc/index.ts` (`permissions.isPermissionAnswer` sequences the
 * wake behind the grant, for a permission answer only); this suite's own
 * `ledger.onChange` wiring below reproduces that same sequencing, so a wake
 * this agent takes through the real path is the one thing actually proven.
 */
const FENCE = 'probe-fence';

/** A party that stands in for a live session, which this suite has none of. */
const SESSION = 'sess-live-probe';

/** Every party the ledger and the receiver accept in this suite. */
/**
 * The agent the **clock** wakes, twice (HIVE-121).
 *
 * Its own definition rather than a fifth body for {@link NAME}, because it is
 * the only one here whose runs nothing in this file calls `runs.run` for: both
 * come out of `scheduler.tickSchedules`, which is the whole assertion. It
 * declares `check: always` so the tick has nothing to decide — an `onchange`
 * agent with an empty inbox would correctly skip, and prove nothing.
 */
const INTERVAL = 'probe-interval';

/**
 * The agent that hands its memory to a fresh copy of itself (HIVE-122).
 *
 * Its own definition for a reason no other probe here has: its frontmatter
 * pins `rotate_after: 1`, and every other definition in this file pins **50**
 * precisely so it never rotates. A shared body could not carry both numbers,
 * and an accidental rotation under any of the others would break the
 * `--resume <same uuid>` assertions they exist for.
 *
 * The codeword it is told is the whole instrument. It exists only inside the
 * first conversation, so a third wake that can still name it is a wake that
 * read the handoff — there is nowhere else for it to have come from.
 */
const ROTATOR = 'probe-rotator';

/**
 * The agent that names Slack in `mcp:` (HIVE-123).
 *
 * Its own definition rather than a sixth body for {@link NAME}, because it is
 * the only probe here whose `mcp:` list is non-empty — that is what makes
 * `wake-command.ts` write it a per-agent `<name>.mcp.json` instead of pointing
 * it at the shared `hive.mcp.json`, and this scenario exists to prove that
 * file actually puts a working Slack server in the process.
 *
 * The scenario this agent drives skips (never fails) when this machine has no
 * signed-in Slack — `slackConnected`, read once in `beforeAll` off a real
 * `claude mcp get slack`, exactly the check the pane itself makes.
 */
const SLACK = 'probe-slack';

const AGENTS = [NAME, ASKER, RESPONDER, FENCE, INTERVAL, ROTATOR, SLACK];

const AGENT_MD = `---
name: ${NAME}
description: Proves one real headless wake, end to end.
icon: Ghost
model: haiku
tools: [Read, Glob, Grep, TodoWrite]
limits:
  turns: 8
  rotate_after: 50
---
This is a conformance probe. Do not read files, search the disk, or run
commands — there is nothing here to find. After your ledger inbox, reply with
the single sentence "probe agent reporting in" and end your turn.
`;

const INTERVAL_MD = `---
name: ${INTERVAL}
description: Proves the scheduler's clock starts a real run.
icon: Ghost
model: haiku
wake:
  every: 1m
  check: always
tools: [Read, Glob, Grep, TodoWrite]
limits:
  turns: 8
  rotate_after: 50
---
This is a conformance probe. Do not read files, search the disk, or run
commands — there is nothing here to find. After your ledger inbox, reply with
the single sentence "interval probe reporting in" and end your turn.
`;

/**
 * The rotating probe, as a definition (HIVE-122).
 *
 * `rotate_after: 1` is the only interesting line: it makes the *second* wake
 * the handoff wake, which is the shortest run of the protocol that still has
 * all three phases in it.
 *
 * The body says the codeword is the one fact worth handing over, and nothing
 * else about how a handoff should be written — the preamble already says that,
 * and this scenario exists to prove that prose holds against a real model
 * rather than to restate it. What the body does have to pin is how the answer
 * comes back: an assistant text block is not a ledger entry, and the only
 * evidence this suite can read off disk is one the agent wrote there itself.
 */
const ROTATOR_MD = `---
name: ${ROTATOR}
description: Proves a rotation carries what the old session knew.
icon: Ghost
model: haiku
tools: [TodoWrite]
limits:
  turns: 8
  rotate_after: 1
---
This is a conformance probe. Do not read files, search the disk, or run
commands — there is nothing here to find.

You are keeping exactly one fact for this user: a codeword. It is the one thing
a fresh copy of you would have no other way to learn, so any handoff you write
must state it.

After your ledger inbox, do exactly one of these and end your turn:

- If you have just been told a codeword, remember it and say nothing.
- If you are asked for the codeword, call \`ledger_post\` with that codeword as
  the entire body.

Say nothing else.
`;

/**
 * The Slack probe, as a definition (HIVE-123).
 *
 * `mcp: [slack]` is the one line that matters — it is what makes
 * `wake-command.ts` write `${SLACK}.mcp.json` instead of leaving this agent on
 * the shared file. `tools:` grants the Slack glob and nothing else, so the one
 * ungranted reach this scenario could hit is the one it is not testing for.
 *
 * The body is worded like `probe.ts`'s own live probe on purpose: **use
 * ToolSearch, then call one tool** — because MCP tool schemas are deferred, a
 * model that skips the search has no schema to call the tool with, and this
 * is the ordering the live scenario exists to prove actually holds.
 */
const SLACK_MD = `---
name: ${SLACK}
description: Proves a wake that names Slack in mcp: actually reaches it.
icon: Ghost
model: haiku
mcp: [slack]
tools: [${SLACK_TOOL_GLOB}, TodoWrite]
limits:
  turns: 8
  rotate_after: 50
---
This is a conformance probe. Do not read files, search the disk, or run
commands — there is nothing here to find. After your ledger inbox, use
ToolSearch to load the schema for a Slack tool that reports who I am, then
call that tool and reply with the single sentence "slack probe reporting in".
If the call fails, quote the error message verbatim instead. Do not call any
other tool.
`;

/**
 * The two-wake conversation, as a definition (HIVE-120).
 *
 * The branch is on the **inbox**, not on the wake prompt: `ledger_read` is the
 * first thing the preamble tells any agent to do, so branching on what it
 * returns asks the model for one decision it has already gathered the evidence
 * for. Reading the trigger out of its own prompt would be a second, avoidable
 * chance to get it wrong.
 *
 * `ledger_done` carries no `thread`, deliberately: the `answer` has already
 * closed the ask (`CLOSING_KINDS`), so requiring the model to quote an id back
 * would risk the assertion on a step the story does not depend on.
 */
const ASKER_MD = `---
name: ${ASKER}
description: Asks once, is answered, and reports done on the second wake.
icon: Ghost
model: haiku
wake:
  on: [ledger]
tools: [TodoWrite]
limits:
  turns: 8
  rotate_after: 50
---
This is a conformance probe. Do not read files, search the disk, or run
commands — there is nothing here to find.

Read your ledger inbox, then do exactly one of these and end your turn:

- If your inbox contains an **answer**, call \`ledger_done\` with the body
  "probe asker finished".
- Otherwise, call \`ledger_ask\` with \`to\` set to "overmind" and the body
  "which branch should the probe use?".

Say nothing else.
`;

/**
 * The agent a session asks (HIVE-120).
 *
 * It answers rather than asks, which is the half of "a session asks an agent"
 * that only a live run can show: the ask has to reach a real model, and the
 * `thread` has to come back off what `ledger_read` handed it.
 */
const RESPONDER_MD = `---
name: ${RESPONDER}
description: Answers the ask a session addressed to it.
icon: Ghost
model: haiku
wake:
  on: [ledger]
tools: [TodoWrite]
limits:
  turns: 8
  rotate_after: 50
---
This is a conformance probe. Do not read files, search the disk, or run
commands — there is nothing here to find.

Read your ledger inbox. If it contains an ask addressed to you, call
\`ledger_answer\` with \`thread\` set to that ask's \`id\` and the body
"probe responded". Then end your turn. Say nothing else.
`;

/**
 * The fence probe, as a definition (HIVE-119).
 *
 * `tools:` pins exactly the read-only set every other probe in this file
 * pins, and no `Bash` — the one thing its body asks it to do. The instruction
 * says nothing about permission, retrying, or the ledger: the preamble
 * (`preamble.ts`) already covers all three ("a denied permission means wait,
 * not retry" / "if you were woken because a permission ask was answered,
 * retry that one call exactly once"), and this scenario exists to prove that
 * prose actually holds against a real model, not to repeat it in the body.
 *
 * `marker` is a path outside every agent's own working directory — this
 * suite's own temp root — so the file the command writes survives being
 * checked from the test process without needing to know `agentWorkdir`'s
 * layout.
 *
 * `wake.on: [ledger]` is declared, unlike every earlier draft of this
 * probe — see {@link FENCE}'s own doc comment for why leaving it out would
 * have made this scenario unable to prove anything about the ordering it
 * exists to check.
 */
const fenceMd = (marker: string) => `---
name: ${FENCE}
description: Proves the permission fence denies an ungranted Bash call.
icon: Ghost
model: haiku
wake:
  on: [ledger]
tools: [Read, Glob, Grep, TodoWrite]
limits:
  turns: 8
  rotate_after: 50
---
This is a conformance probe. After your ledger inbox, call the Bash tool
with exactly this command and nothing else:

touch ${marker}

Do not call any other tool, and say nothing else.
`;

describe.skipIf(!LIVE)('one real headless wake, against a real claude', () => {
  /** `undefined` until `beforeAll` gets past its prerequisite check. */
  let dir: string | undefined;
  let hiveDir: string;
  let userDataPath: string;
  let previousConfigPath: string | undefined;
  /** The absolute path {@link FENCE}'s one permitted command writes to. */
  let marker: string;

  let receiver: Receiver | null = null;
  let ledger: Ledger;
  let agentState: AgentState;
  let runs: RunTracker;
  let scheduler: Scheduler | null = null;
  let agentRegistry: AgentRegistry;
  let permissions: Permissions;
  /**
   * Read once in `beforeAll` off a real `claude mcp get slack` — the same
   * check the pane makes. `false` on any machine that has never signed in,
   * which is what lets the slack scenario skip instead of failing there.
   */
  let slackConnected = false;

  /** Every argv this suite spawned, in order. */
  const spawns: { file: string; args: string[] }[] = [];
  /** Every hook event that came back on the **agent** register. */
  const agentEvents: HookAgentEvent[] = [];
  /** Every hook event that came back on the **session** register. Must stay empty. */
  const sessionEvents: HookStatusEvent[] = [];
  /** Every run-log line the tracker folded out of the child's stdout. */
  const lines: RunLine[] = [];

  /**
   * Resolved by `pushStatus` the moment that agent's run stops being `working`.
   *
   * Keyed by name since HIVE-120: a run the *scheduler* started is not one this
   * file called `runs.run` for, so the only way to await it is to have said
   * which agent to listen for before the entry that wakes it is appended.
   */
  const settlers = new Map<string, () => void>();
  /** What `scheduleFor` answers, filled by the interval scenario alone. */
  const schedules = new Map<
    string,
    { wake: WakeSpec; dailyUsd?: number }
  >();
  /** The scheduler's tick, captured off its injected interval. */
  let fireTick: (() => void) | undefined;

  beforeAll(async () => {
    /*
      `out/main/mcp-host.js` is what gives the run its `ledger_*` tools, and the
      first line of every agent's system prompt tells it to call one. Without
      the build this suite would still spawn a process, but it would be
      measuring a turn that could not do the one thing the preamble asks — so it
      says so rather than reporting a softer pass.
    */
    const host = join(process.cwd(), 'out', 'main', 'mcp-host.js');

    if (!existsSync(host)) {
      throw new Error(
        `${host} is missing. Run \`pnpm desktop:build\` before \`pnpm test:agent\`.`,
      );
    }

    dir = await mkdtemp(join(tmpdir(), 'hive-live-agent-'));
    hiveDir = join(dir, '.hive');
    userDataPath = join(dir, 'userData');

    /*
      The isolation, and it is one line because the runtime was built for it:
      every path an agent touches — `~/.hive/agents`, `~/.hive/ledger/agents.json`,
      `~/.hive/work/<name>`, `~/.hive/skills` — is derived from `configPath()`,
      which reads this variable per call. Pointing it at a temp directory moves
      all of them at once, so nothing here can reach the developer's own `~/.hive`.
      `userData` is passed explicitly rather than read from Electron, which is not
      running under Vitest.
    */
    previousConfigPath = process.env[CONFIG_PATH_ENV];
    process.env[CONFIG_PATH_ENV] = join(hiveDir, 'config.json');

    // Outside `hiveDir` on purpose: `rm(dir, { recursive: true })` in
    // `afterAll` cleans it up as one directory rather than two.
    marker = join(dir, 'bash-ran.txt');

    for (const [name, body] of [
      [NAME, AGENT_MD],
      [ASKER, ASKER_MD],
      [RESPONDER, RESPONDER_MD],
      [FENCE, fenceMd(marker)],
      [INTERVAL, INTERVAL_MD],
      [ROTATOR, ROTATOR_MD],
      [SLACK, SLACK_MD],
    ] as const) {
      await mkdir(join(agentsRoot(), name), { recursive: true });
      await writeFile(join(agentsRoot(), name, 'AGENT.md'), body, 'utf8');
    }

    /*
      The same fact the pane reads, off the same command — `claude mcp get
      slack` — via the real `readSlackStatus` this app ships, not a
      hand-rolled shell-out. Awaited, because that read is asynchronous: `mcp
      get` health-checks the server over HTTP and has no business on the
      synchronous runner (HIVE-123 self-review). A `connected` result here is
      the only thing that arms the slack scenario; anything else — no server
      added, needs-auth, pending-approval, or a broken `claude` on PATH —
      leaves it skipped rather than failing a suite that never signed in.
    */
    slackConnected = (await readSlackStatus('claude', runAsync)).kind === 'connected';

    ledger = createLedger({
      dir: join(dirname(process.env[CONFIG_PATH_ENV]), LEDGER_DIR),
      // The agent is a party, exactly as `ipc/index.ts` makes it one the moment
      // a command has been built for it — or `run.started` is refused 404 and
      // assertion 3 has nothing to find. `SESSION` stands in for the live
      // session this suite has no pty for (HIVE-120).
      knowsParty: (party) =>
        AGENTS.includes(party) || party === OVERMIND || party === SESSION,
    });

    /*
      Composed exactly as `ipc/index.ts` composes them (HIVE-119): the
      registry's own `read`/`write` handed straight to `PermissionDeps`, so a
      grant this suite writes goes through the same `parseAgent` validation a
      real save would, rather than a hand-rolled file write that could accept
      a shape production would refuse.
    */
    agentRegistry = createAgentRegistry({
      root: agentsRoot(),
      skillNames: async () => ({ all: [], hive: [] }),
    });

    permissions = createPermissions({
      entries: () => ledger.read({}).entries,
      append: (request) => {
        ledger.append(request);
      },
      read: (name) => agentRegistry.read(name),
      write: (name, source) => agentRegistry.write(name, source),
    });

    receiver = createReceiver({
      // No sessions at all: this suite has no pty, and the assertion that no
      // session status was published is only meaningful if the session register
      // is empty rather than merely unused.
      knowsSession: () => false,
      knowsAgent: (id) => AGENTS.includes(id),
      onAgentEvent: (event) => agentEvents.push(event),
      onEvent: (event) => sessionEvents.push(event),
      onLedgerRead: (_caller, query) => ledger.read(query),
      onLedgerPost: (caller, request) => ledger.append({ ...request, from: caller }),
      onTicketIntent: () => undefined,
      onCleared: () => undefined,
      onMetrics: () => undefined,
      onDone: () => undefined,
      onReady: () => undefined,
    });

    const url = await receiver.start();

    expect(url).not.toBeNull();

    /*
      The agent-space file, not the session one (HIVE-119): production wakes
      read `hooks.agentSettingsPathFor()`, which carries the `permissions.ask`
      rule that routes every tool call through `approve`. Every tool this
      suite's agents actually call — `ledger_*` via `mcp__hive__*`, and each
      definition's own `tools:` list — is already in `HIVE_GRANTS`, so
      `approve` auto-approves them without ever writing an ask; nothing here
      can hang waiting on a card nobody will answer.
    */
    const settingsPath = await writeAgentSettings(userDataPath, url ?? '');

    const mcpConfigPath = join(userDataPath, 'hive', 'hive.mcp.json');

    await mkdir(dirname(mcpConfigPath), { recursive: true });
    await writeFile(
      mcpConfigPath,
      mcpConfig({ execPath: process.execPath, scriptPath: host }),
      'utf8',
    );

    /*
      The generated plugin directory, written by the real skills runtime rather
      than mocked into place: `--plugin-dir` is on every wake's argv, and a
      directory that is not there is a difference between this run and a real
      one that only the binary would notice.
    */
    const skills = createSkillsRuntime({ userDataPath, version: '0.0.0-live' });

    await skills.sync();

    const pluginDir = skills.pluginDirPath();

    expect(pluginDir).not.toBeNull();

    agentState = createAgentState({ path: agentStateFile() });

    // One generator for both the wake builder and the tracker's rotation, as
    // the real composition does it (HIVE-122).
    const newUuid = (): string => randomUUID();

    const buildWakeCommand = createWakeCommand({
      agentsRoot,
      workdir: agentWorkdir,
      promptFile: (name) => agentPromptFile(userDataPath, name),
      pluginDir: () => pluginDir ?? '',
      agentSettingsPath: () => settingsPath,
      mcpConfig: () => mcpConfigPath,
      hiveServer: () =>
        hiveServerSpec({ execPath: process.execPath, scriptPath: host }),
      agentMcpFile: (name) => agentMcpConfigFile(userDataPath, name),
      hookEnv: (name) => ({
        [HOOK_ENV_SESSION]: name,
        [HOOK_ENV_TOKEN]: receiver?.tokenFor(name) ?? '',
        [HOOK_ENV_RECEIVER_URL]: receiver?.origin ?? '',
      }),
      claudeCommand: () => 'claude',
      /*
        False, so the child inherits this shell's environment untouched — the
        same environment every other live suite spawns `claude` with. Stripping
        the API-key variables here would test the developer's auth setup rather
        than the waker.
      */
      subscriptionAuth: () => false,
      state: agentState,
      env: () => process.env,
      newUuid,
      // Composed with the real `permissions` runtime (HIVE-119): a one-shot
      // `allow-once` this suite never exercises would otherwise have nowhere
      // to come from, and `grantsFor` is a no-op for every other agent here,
      // none of which ever answers a permission ask that way.
      pendingGrants: (name) => permissions.grantsFor(name),
    });

    runs = createRunTracker({
      spawn: (file, args, options) => {
        spawns.push({ file, args: [...args] });

        return spawnProcess(
          file,
          [...args],
          options as SpawnOptions,
        ) as unknown as ChildLike;
      },
      command: buildWakeCommand,
      state: agentState,
      appendLedger: (entry) => {
        const result = ledger.append(entry);

        // A refused append would leave assertion 3 looking for an entry that was
        // never written, and the reason would be invisible in the failure.
        expect(result.ok).toBe(true);
      },
      openAsksFor: (name, run) => {
        const { entries, openAsks } = ledger.read({ from: name });
        const started = entries.find(
          (entry) => entry.kind === 'event' && entry.meta?.['run'] === run,
        );

        return openAsks.some(
          (ask) => ask.from === name && (started === undefined || ask.id >= started.id),
        );
      },
      // The real reader, so a live run that rotates is decided the way the app
      // decides it (HIVE-122).
      handoffFor: (name, run) => {
        const { entries } = ledger.read({ from: name });
        const started = entries.find(
          (entry) => entry.kind === 'event' && entry.meta?.['run'] === run,
        );

        // Fails closed with no start entry, exactly as production does: a
        // fallback to "any handoff this agent ever wrote" would rotate off a
        // previous rotation's body.
        if (started === undefined) return undefined;

        return entries.findLast(
          (entry) => entry.kind === 'handoff' && entry.id >= started.id,
        )?.body;
      },
      newUuid,
      pushStatus: (name) => {
        if (agentState.read(name).status === 'working') return;

        const settle = settlers.get(name);

        settlers.delete(name);
        settle?.();
      },
      pushLines: (_name, pushed) => lines.push(...pushed),
      onRunClosed: (name) => scheduler?.onRunClosed(name),
      now: () => Date.now(),
      newRunId: () => randomUUID(),
    });

    /*
      The wake half, composed exactly as `ipc/index.ts` composes it (HIVE-120):
      built from the tracker, handed the same party register the ledger
      authenticates against, and subscribed to `ledger.onChange`. A different
      wiring here would prove the scheduler works in a shape production does
      not use.
    */
    scheduler = createScheduler({
      run: (name, trigger, extra) => runs.run(name, trigger, extra),
      state: agentState,
      isAgent: (id) => AGENTS.includes(id),
      // `ASKER`, `RESPONDER` and `FENCE` all declare `wake.on: [ledger]` —
      // the gate `ipc/index.ts` reads off the parsed definition into
      // `ledgerAgents`. Only `NAME` does not.
      wakesOnLedger: (id) => id === ASKER || id === RESPONDER || id === FENCE,
      /*
        Empty until the interval scenario fills it (HIVE-121). Every other
        scenario drives its wake from a ledger entry or by hand, and a schedule
        left standing would spend real model minutes on a run nothing is
        asserting about.
      */
      schedules: () => schedules,
      pushStatus: () => {},
      ledger: {
        read: () => ledger.read({}),
        append: (request) => ledger.append(request),
      },
      now: () => Date.now(),
      /*
        Captured rather than armed. The tick's period is sixty seconds and its
        floor is one minute, so letting it run on real time would add two
        minutes of waiting to a suite that already spends real model time — and
        would buy nothing: what is under test is that `tickSchedules` starts a
        real `claude`, not that `setInterval` counts.
      */
      setIntervalFn: ((handler: () => void) => {
        fireTick = handler;
        return 0 as unknown as ReturnType<typeof setInterval>;
      }) as unknown as typeof setInterval,
      clearIntervalFn: (() => {
        fireTick = undefined;
      }) as unknown as typeof clearInterval,
    });

    // Arms the captured tick. The immediate tick inside `start()` finds no
    // schedules and does nothing.
    scheduler.start();

    /*
      Reproduces `ipc/index.ts`'s own sequencing (HIVE-119), not the plain
      `scheduler?.onEntry(entry)` an earlier draft of this suite used. That
      plainer version is what let the ordering bug in `ipc/index.ts` ship
      unnoticed: it scheduled every wake synchronously, including the wake a
      permission answer triggers, so nothing here ever raced the still-in-
      flight `AGENT.md` write `permissions.onAnswer` makes for that same
      answer — the exact race `FENCE`'s scenario exists to catch.

      An ordinary answer still schedules synchronously, same as before:
      there is nothing to write first. Only an answer to a *permission* ask
      — `permissions.isPermissionAnswer` — has a grant that has to land on
      disk before the wake it causes reads that file, so only that one path
      is deferred behind `onAnswer`, via `.finally` rather than `.then` so a
      failed write still wakes the agent to retry and report.
    */
    ledger.onChange((entry) => {
      const schedule = () => scheduler?.onEntry(entry);

      if (entry.kind === 'answer' && permissions.isPermissionAnswer(entry)) {
        permissions.onAnswer(entry).catch(() => undefined).finally(schedule);
      } else {
        schedule();
      }
    });
  }, 180_000);

  afterAll(async () => {
    /*
      Awaited, not fired and forgotten. `killAll` sends SIGTERM and arms an
      **unref'd** SIGKILL three seconds later, so nothing holds the Vitest
      worker open while the child winds down — the worker can exit first and
      leave a real `claude` running with nobody left to signal it. Polling
      `live()` is what turns "we asked it to stop" into "it stopped", and the
      bound means a child that will not go still ends the suite rather than
      hanging it.
    */
    runs?.killAll('suite ended');

    const deadline = Date.now() + TEARDOWN_WAIT_MS;

    while ((runs?.live().length ?? 0) > 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }

    // `dispose`, not `flush`: the directory the write would land in is deleted
    // three lines below.
    agentState?.dispose();
    await receiver?.stop();
    // Stops the folder watch before `rm` below deletes what it is watching.
    agentRegistry?.close();

    if (previousConfigPath === undefined) delete process.env[CONFIG_PATH_ENV];
    else process.env[CONFIG_PATH_ENV] = previousConfigPath;

    /*
      Guarded, because `dir` is assigned *after* `beforeAll`'s prerequisite
      check. A missing `out/main/mcp-host.js` throws before the `mkdtemp`, and
      an unguarded `rm(undefined)` would then raise ERR_INVALID_ARG_TYPE on top
      of it — burying the one error that says what to run. Everything else here
      is already `?.`-guarded for the same reason.
    */
    if (dir !== undefined) await rm(dir, { recursive: true, force: true });
  }, TEARDOWN_WAIT_MS + 30_000);

  /**
   * A promise for this agent's *next* finalized run, armed before the thing
   * that starts it.
   *
   * Separate from {@link wake} because a ledger wake is started by the
   * scheduler, from inside `ledger.append` — there is no call here to await.
   */
  const settled = (name: string): Promise<void> =>
    new Promise((resolve) => {
      settlers.set(name, resolve);
    });

  /**
   * Wake the agent and resolve when the tracker has finalized the run.
   *
   * `extra` is the same sentence the scheduler appends to a ledger wake, and it
   * is what lets a scenario say something to the model that only this wake
   * knows — which is the whole instrument the rotation scenario is built on.
   */
  const wake = (
    trigger: string,
    name: string = NAME,
    extra?: string,
  ): Promise<void> =>
    new Promise((resolve, reject) => {
      settlers.set(name, resolve);

      const started = runs.run(name, trigger, extra);

      if (!started.started) {
        reject(
          new Error(
            `the wake was refused (${started.refused}): ${started.reason ?? 'no reason given'}`,
          ),
        );
      }
    });

  /** `agents.json` as it is on disk, which is what the next launch would read. */
  const persisted = async (name: string = NAME): Promise<AgentRunState> => {
    agentState.flush();

    const parsed = JSON.parse(await readFile(agentStateFile(), 'utf8')) as Record<
      string,
      AgentRunState
    >;
    const state = parsed[name];

    if (state === undefined) throw new Error(`${name} is not in agents.json`);

    return state;
  };

  /** Every ledger entry on disk, across however many day-files there are. */
  const onDisk = async (): Promise<Record<string, unknown>[]> => {
    const ledgerDir = join(hiveDir, LEDGER_DIR);
    const files = (await readdir(ledgerDir)).filter((file) => file.endsWith('.jsonl'));

    return (
      await Promise.all(
        files.map(async (file) => {
          const text = await readFile(join(ledgerDir, file), 'utf8');

          return text
            .split('\n')
            .filter((line) => line !== '')
            .map((line) => JSON.parse(line) as Record<string, unknown>);
        }),
      )
    ).flat();
  };

  /**
   * The `id` of every rung a permission ask's `meta.rungs` carries, in order.
   *
   * Takes the raw shape {@link onDisk} returns rather than a `LedgerEntry` —
   * this is only ever called on an entry read back off disk as JSON, so
   * `meta` is `unknown` all the way down.
   */
  const rungIdsOf = (entry: Record<string, unknown>): unknown[] => {
    const meta = entry['meta'];
    const raw =
      typeof meta === 'object' && meta !== null
        ? (meta as Record<string, unknown>)['rungs']
        : undefined;

    return Array.isArray(raw)
      ? raw.map((rung) =>
          typeof rung === 'object' && rung !== null
            ? (rung as Record<string, unknown>)['id']
            : undefined,
        )
      : [];
  };

  it('runs one process, reports its Stop under the agent name, and records the run', async () => {
    await wake('manual');

    // 1. One process, and it is gone: `wake` only resolves from the finalizer,
    //    which `runs.ts` reaches on 'close' or the flush-window backstop.
    expect(spawns).toHaveLength(1);
    expect(runs.live()).toEqual([]);

    // 2. The Stop hook came back, under the **agent's** name — and nothing at
    //    all arrived on the session register.
    const stops = agentEvents.filter((event) => event.event === 'Stop');

    expect(stops.length).toBeGreaterThan(0);
    expect(stops.every((stop) => stop.entityId === NAME)).toBe(true);
    expect(sessionEvents).toEqual([]);

    // 3. The run is legible in the log afterwards, from both ends.
    const entries = await onDisk();
    const bodies = entries
      .filter((entry) => entry['from'] === NAME)
      .map((entry) => String(entry['body']));

    expect(bodies.some((body) => body.startsWith('run.started'))).toBe(true);
    expect(bodies.some((body) => body.startsWith('run.ended'))).toBe(true);

    // 4. The uuid and the cost, both read off the CLI's own `result` event.
    const state = await persisted();

    expect(state.sessionUuid).toBeTypeOf('string');
    expect(state.sessionUuid).not.toBe('');
    expect(state.runs).toHaveLength(1);
    expect(state.runs[0]?.costUsd).toBeTypeOf('number');
    expect(state.runs[0]?.costUsd).toBeGreaterThan(0);
    expect(state.runs[0]?.outcome).not.toBe('failed');

    // 6. The agent spoke: `ink` is the colour `foldRunLog` gives an assistant
    //    text block, and nothing else emits it.
    expect(lines.some((line) => line.color === 'ink')).toBe(true);
  }, 300_000);

  it('resumes that same session on the next wake', async () => {
    const first = await persisted();
    const uuid = first.sessionUuid ?? '';

    expect(uuid).not.toBe('');
    // The first run minted its uuid rather than resuming one.
    expect(spawns[0]?.args).toContain('--session-id');
    expect(spawns[0]?.args).not.toContain('--resume');

    await wake('manual');

    expect(spawns).toHaveLength(2);

    // 5. The argv the binary was actually handed, and the uuid the first run
    //    reported — the assertion the whole `sessionUuid` round trip exists for.
    const args = spawns[1]?.args ?? [];

    expect(args).toContain('--resume');
    expect(args[args.indexOf('--resume') + 1]).toBe(uuid);
    expect(args).not.toContain('--session-id');

    /*
      And the binary accepted it. A `--resume` naming a conversation `claude`
      does not have exits immediately and non-zero, which lands here as
      `failed` — so this is what separates "we spelled the flag" from "the
      session really was picked back up".
    */
    const second = await persisted();

    expect(second.runs).toHaveLength(2);
    expect(second.runs[1]?.outcome).not.toBe('failed');
    expect(second.runs[1]?.costUsd).toBeTypeOf('number');

    /*
      And the uuid survived the resume unchanged.

      `finalizeRun` writes `sessionUuid` from the `result` event of the run
      that just ended, so this is the CLI reporting its own id back: measured
      at 2.1.251, `--session-id <uuid>` reports that uuid, and a following
      `--resume <uuid>` reports the same one again.

      It is worth an assertion of its own because a *quiet* change here would
      not fail anything else. `noteTurnEnded(name, sessionUuid)` correlates a
      Stop hook to the live run by uuid, and ignores a Stop whose uuid does not
      match. If a resume ever minted a fresh id, every Stop after the first
      wake would be discarded as stale — the stall watchdog would arm on first
      runs only, and nothing would say so. This is the one place that would go
      red instead.
    */
    expect(second.sessionUuid).toBe(uuid);
  }, 300_000);

  /**
   * The two-wake conversation of the design's §5, end to end (HIVE-120).
   *
   * The assertion that matters is the *second* run: nothing in this test calls
   * `runs.run` for it. It is started by the scheduler, from inside
   * `ledger.answer` — which is the whole story, and the reason the wake is
   * awaited through {@link settled} rather than through {@link wake}.
   */
  it('wakes a second time when its ask is answered, and reports done', async () => {
    await wake('manual', ASKER);

    // The first turn ended holding a question: `openAsksFor` saw an ask this
    // run opened and nobody had closed.
    const first = await persisted(ASKER);

    expect(first.runs).toHaveLength(1);
    expect(first.runs[0]?.outcome).toBe('asking');
    expect(agentState.read(ASKER).status).toBe('asking');

    const uuid = first.sessionUuid ?? '';

    expect(uuid).not.toBe('');

    const open = ledger.read({}).openAsks.filter((ask) => ask.from === ASKER);

    expect(open).toHaveLength(1);

    const askId = open[0]?.id ?? '';
    const before = spawns.length;
    const second = settled(ASKER);

    /*
      The overmind answers, as the console's `answer` verb does. The wake is
      synchronous inside this call — `ledger.onChange` runs within `append`,
      the scheduler decides `wake`, and `RunTracker.run` spawns before this
      line returns. That is why the spawn count is asserted immediately after.
    */
    const answered = ledger.answer({ thread: askId, body: 'main' }, OVERMIND);

    expect(answered.ok).toBe(true);
    expect(spawns).toHaveLength(before + 1);

    // Resumed, not restarted: the second wake continues the same conversation.
    const args = spawns[before]?.args ?? [];

    expect(args).toContain('--resume');
    expect(args[args.indexOf('--resume') + 1]).toBe(uuid);

    /*
      And the agent was told *why* it woke, in the prompt the binary was handed.
      `wakePrompt` writes the trigger and the extra the scheduler built, so this
      is the one assertion that reaches the string a model actually reads.

      The id named is the **answer's**, not the ask's: the extra says which
      entry woke you, and an agent that wants the thread reads its inbox — which
      the same prompt's next sentence tells it to do.
    */
    const prompt = args.at(-1) ?? '';

    expect(prompt).toContain('You woke because: ledger');
    expect(prompt).toContain(`answer ${answered.ok ? answered.id : ''} from ${OVERMIND}`);

    await second;

    // The conversation closed: the ask is no longer open, and the agent said so.
    expect(ledger.read({}).openAsks.some((ask) => ask.id === askId)).toBe(false);

    const entries = await onDisk();
    const done = entries.filter(
      (entry) => entry['from'] === ASKER && entry['kind'] === 'done',
    );

    expect(done).toHaveLength(1);

    const closed = await persisted(ASKER);

    expect(closed.runs).toHaveLength(2);
    expect(closed.runs[1]?.outcome).not.toBe('failed');
    // The queue is empty: this wake was immediate, never queued.
    expect(closed.pendingWake ?? []).toEqual([]);
  }, 300_000);

  /**
   * A session asks an agent, and the agent answers it (HIVE-120).
   *
   * The half a live run is needed for is the agent's: `ledger_ask(to: <agent>)`
   * has to reach a real model and come back as an `answer` naming the thread.
   * The other half — that answer written into the asking session's terminal as
   * a 📒 line — is `deliver.ts`'s, and belongs to a test that has a pty;
   * `tests/electron/main/ledger/deliver.test.ts` covers it, and treats an
   * agent's `from` no differently from anyone else's.
   */
  it('wakes an agent a session asked, and answers back to that session', async () => {
    const before = spawns.length;
    const woken = settled(RESPONDER);

    const asked = ledger.append({
      from: SESSION,
      to: RESPONDER,
      kind: 'ask',
      body: 'is the branch green?',
    });

    expect(asked.ok).toBe(true);
    // Woken by a session's ask, with no console and no timer involved.
    expect(spawns).toHaveLength(before + 1);

    const prompt = spawns[before]?.args.at(-1) ?? '';

    expect(prompt).toContain('You woke because: ledger');
    expect(prompt).toContain(`ask ${asked.ok ? asked.id : ''} from ${SESSION}`);

    await woken;

    /*
      The answer came back addressed to the session that asked.

      `to` is what `deliver.ts` routes on, so an answer that named nobody would
      reach no terminal however well the wake worked — this is the assertion
      that makes the round trip a round trip rather than two halves.
    */
    const entries = await onDisk();
    const answers = entries.filter(
      (entry) => entry['from'] === RESPONDER && entry['kind'] === 'answer',
    );

    expect(answers).toHaveLength(1);
    expect(answers[0]?.['to']).toBe(SESSION);
    expect(answers[0]?.['thread']).toBe(asked.ok ? asked.id : undefined);
    expect(ledger.read({}).openAsks.some((ask) => ask.from === SESSION)).toBe(false);
  }, 300_000);

  /**
   * The permission fence, end to end (HIVE-119).
   *
   * {@link FENCE}'s `tools:` does not include `Bash`; its one instruction is
   * to call it anyway. Four things only a live run can prove, in the order
   * they happen:
   *
   * 1. the fence itself: the ledger gains a `permission` ask naming `Bash`,
   *    with the ladder `rungsFor` computed for this exact call;
   * 2. the command never ran — proved from the filesystem, because a model's
   *    own account of a denial is not evidence. `permission-rules.ts`'s own
   *    doc comment records why: an earlier probe narrated the deny message as
   *    though it were the output of the call it never made;
   * 3. the turn ends `asking`, the same resting state `ledger_ask` produces —
   *    a denial is a question with nobody answering it yet;
   * 4. answering with a permanent rung (`allow-family`) patches `AGENT.md` on
   *    disk, and the *next* wake — started by the scheduler off the answer
   *    itself, not by this test calling `wake()` a second time — carries the
   *    grant, and the same command actually runs.
   *
   * Point 4 is what this scenario exists for. An earlier draft drove both of
   * `FENCE`'s wakes by hand and awaited `permissions.onAnswer` directly, which
   * sidestepped a real ordering bug in `ipc/index.ts`'s listener — production
   * scheduled the wake *before* the grant it depends on had reached disk —
   * rather than proving it fixed. This version lets the answer wake the agent
   * the same way a user's click on "allow for this agent" does: through
   * `ledger.onChange`, reproduced in this file's `beforeAll` with the same
   * sequencing `ipc/index.ts` now uses. A regression in that ordering fails
   * here, not only in `permissions.test.ts`'s narrower unit coverage.
   */
  it('denies an ungranted Bash call, then carries a permanent grant to the next wake', async () => {
    await wake('manual', FENCE);

    // 1. The fence held by writing an ask, not by hanging: a `permission` ask
    //    naming the exact tool and the ladder `approve` computed for it.
    const entries = await onDisk();
    const asks = entries.filter(
      (entry) =>
        entry['from'] === FENCE &&
        entry['kind'] === 'ask' &&
        (entry['meta'] as Record<string, unknown> | undefined)?.['kind'] === 'permission',
    );

    expect(asks).toHaveLength(1);

    const ask = asks[0] as Record<string, unknown>;
    const meta = ask['meta'] as Record<string, unknown> | undefined;

    expect(meta?.['tool']).toBe('Bash');
    expect(rungIdsOf(ask)).toEqual(['allow-once', 'allow-family', 'allow-tool']);

    // 2. The command did not run. Not the model's word for it — the
    //    filesystem's: nothing else in this suite ever writes this path.
    expect(existsSync(marker)).toBe(false);

    // 3. The turn ended holding an unanswered question, exactly as it would
    //    have if the agent had called `ledger_ask` itself.
    const first = await persisted(FENCE);

    expect(first.runs).toHaveLength(1);
    expect(first.runs[0]?.outcome).toBe('asking');
    expect(agentState.read(FENCE).status).toBe('asking');

    const open = ledger.read({}).openAsks.filter((candidate) => candidate.from === FENCE);

    expect(open).toHaveLength(1);

    const askId = open[0]?.id ?? '';

    expect(askId).not.toBe('');

    /*
      4. `allow-family` is the ladder's default for a `Bash` call with a head
      (`defaultRungFor`, `permission-rules.ts`) — answering with it is what a
      card's own default button would send.

      The wake this answer causes is not started here. `ledger.answer`
      returns as soon as the entry is on disk; the second wake fires from
      *inside* that same call, asynchronously, off the scheduler this file's
      `beforeAll` wires behind `permissions.onAnswer`'s `AGENT.md` write —
      exactly as `ipc/index.ts` now wires it. `settled` is armed first, the
      same way `wake()` arms it for a wake this test starts directly, so
      there is something to await either way.
    */
    const second = settled(FENCE);
    const answered = ledger.answer({ thread: askId, body: 'allow-family' }, OVERMIND);

    expect(answered.ok).toBe(true);

    await second;

    const patched = await readFile(join(agentsRoot(), FENCE, 'AGENT.md'), 'utf8');

    expect(patched).toContain('Bash(touch *)');

    // The grant reached the wake itself, not only the file: the second run's
    // own argv names the rule `matches()` checked the retried call against.
    const args = spawns.at(-1)?.args ?? [];
    const allowedIndex = args.indexOf('--allowedTools');

    expect(allowedIndex).toBeGreaterThan(-1);
    expect(args[allowedIndex + 1]).toContain('Bash(touch *)');

    // And the call actually ran — the one thing no transcript can fake, and
    // the one proof that the wake really did land behind the grant rather
    // than racing it.
    expect(existsSync(marker)).toBe(true);

    const closed = await persisted(FENCE);

    expect(closed.runs).toHaveLength(2);
    expect(closed.runs[1]?.outcome).not.toBe('asking');
    expect(closed.runs[1]?.outcome).not.toBe('failed');
  }, 300_000);

  /**
   * The clock starts a real run, twice, on one conversation (HIVE-121).
   *
   * Nothing in this test calls `runs.run`. Both wakes come out of
   * `tickSchedules`, which is the entire assertion — every other proof of the
   * tick is a unit test against a recording `run` dep, and every one of them
   * would pass just as happily on a build whose scheduled wake could never
   * actually spawn anything.
   *
   * What only a real process can show here:
   *
   * 1. A tick that finds an overdue `nextRunAt` reaches `RunTracker.run` and a
   *    `claude` really starts — with `interval` as the trigger word, which is
   *    what the model reads in its own wake prompt.
   * 2. The **second** tick resumes the first run's uuid. A scheduled wake is
   *    not a special case of the resume path; it is the same path, and this is
   *    what says so.
   * 3. `today` counted both runs. That accumulator is what the daily ceiling is
   *    compared against, and no unit test can prove it is fed by a real run's
   *    real cost rather than by a fixture.
   *
   * The tick is fired by hand rather than waited for. Its period is sixty
   * seconds and the grammar's floor is one minute, so real time would add two
   * minutes to a suite that already spends real model minutes — and would
   * prove only that `setInterval` counts.
   */
  it('wakes an agent twice on its own schedule, resuming the same session', async () => {
    const spec: WakeSpec = { everyMs: 60_000, check: 'always', on: [] };

    schedules.set(INTERVAL, { wake: spec });

    /*
      Due now. The tick seeds `nextRunAt` for an agent that has never been
      scheduled rather than firing — saving a definition starts a schedule, it
      does not owe a wake dated from the epoch — so the first tick would only
      arm it.
    */
    agentState.patch(INTERVAL, { nextRunAt: Date.now() - 1 });

    const first = settled(INTERVAL);

    fireTick?.();
    await first;

    const after = await persisted(INTERVAL);

    expect(after.runs).toHaveLength(1);
    expect(after.runs[0]?.trigger).toBe('interval');
    expect(after.runs[0]?.outcome).not.toBe('failed');

    const uuid = after.sessionUuid ?? '';

    expect(uuid).not.toBe('');

    // Armed forward by the tick itself, off the clock rather than off a timer.
    expect(after.nextRunAt).toBeGreaterThan(Date.now());

    // Due again, without touching anything else.
    agentState.patch(INTERVAL, { nextRunAt: Date.now() - 1 });

    const second = settled(INTERVAL);

    fireTick?.();
    await second;

    const twice = await persisted(INTERVAL);

    expect(twice.runs).toHaveLength(2);
    expect(twice.runs[1]?.outcome).not.toBe('failed');

    // Same conversation: a scheduled wake takes the resume path like any other.
    const args = spawns.at(-1)?.args ?? [];

    expect(args).toContain('--resume');
    expect(args[args.indexOf('--resume') + 1]).toBe(uuid);
    expect(twice.sessionUuid).toBe(uuid);

    /*
      And the day's accumulator counted both. This is the number
      `limits.daily_usd` is compared against and the number the `Today` tile
      draws — fed here by two real runs reporting real costs, which is the one
      thing a fixture cannot stand in for.
    */
    expect(twice.today?.runs).toBe(2);
    expect(twice.today?.usd).toBeGreaterThan(0);
  }, 300_000);

  /**
   * A rotation is a handover, and this is the only proof of it (HIVE-122).
   *
   * Every unit test of this protocol is written against a recording spawn and a
   * `handoffFor` that returns whatever the test hands it, so all of them would
   * pass on a build where the last-turn prompt reaches no model, the handoff
   * body is dropped between `pendingSession` and the argv, or `--session-id`
   * names a conversation the binary then quietly replaces. The codeword is the
   * instrument that reaches all three: it is said **once**, into the first
   * conversation, by a wake whose `extra` this test wrote — so a build that
   * loses it anywhere along the chain has nothing to put in the handoff, in the
   * argv, or in the answer.
   *
   * **What it is not** is a proof of exclusivity, and the comments below say so
   * rather than overclaiming. `receiver.ts`'s visibility rule is
   * `entry.from === caller` among its terms, so an agent always sees its own
   * lines; the fresh session runs in a new MCP host with no read cursor, and its
   * first `ledger_read` can hand it its own `handoff` entry. The model
   * therefore has two routes to the word, and this scenario cannot tell them
   * apart from the answer alone. What closes the gap is the **argv** assertion
   * further down: the codeword is pinned in the exact prompt string the binary
   * was handed, so the carry is proved from the close's decision through to the
   * bytes the model reads, and the ledger answer proves the round trip on top
   * of it.
   *
   * Three wakes, and the middle one is the whole mechanism:
   *
   * 1. an ordinary wake, which learns the codeword and advances the counter
   *    to `rotate_after`;
   * 2. the handoff wake — still `--resume`, still the old conversation, under
   *    the last-turn prompt. Its **close** is what rotates, and only because a
   *    `handoff` entry landed: `pendingSession` gains a uuid and the body, and
   *    the counter goes to zero;
   * 3. the fresh session, started under `--session-id <that uuid>` with the
   *    handoff — codeword and all — prefixed onto its prompt, and answering
   *    with that codeword.
   *
   * A failure here is a failure of the feature, not a flake. The handoff was
   * either not written or not carried, and which of the two is legible from
   * whichever assertion goes red first.
   */
  it('hands its memory to a fresh session and remembers across the break', async () => {
    await wake('manual', ROTATOR, 'the codeword is HALCYON. Remember it.');

    const first = await persisted(ROTATOR);

    expect(first.runs).toHaveLength(1);
    expect(first.runs[0]?.outcome).not.toBe('failed');
    // At `rotate_after`, so the next wake is the last turn on this session.
    expect(first.runsSinceRotate).toBe(1);

    const before = first.sessionUuid ?? '';

    expect(before).not.toBe('');

    /*
      The handoff wake. Nothing about the argv marks it — that is the point:
      the conversation is resumed exactly as any other wake resumes it, and
      only the prompt is different.
    */
    await wake('manual', ROTATOR);

    const handoffArgs = spawns.at(-1)?.args ?? [];

    expect(handoffArgs).toContain('--resume');
    expect(handoffArgs[handoffArgs.indexOf('--resume') + 1]).toBe(before);
    expect(handoffArgs.at(-1) ?? '').toContain('last turn on this session');

    /*
      And the close rotated, which it only does for a run that actually left a
      handoff. `pendingSession` is the parking spot: a decision already made,
      waiting for a wake to spend it.
    */
    const rotated = await persisted(ROTATOR);

    expect(rotated.runs).toHaveLength(2);
    expect(rotated.runs[1]?.outcome).not.toBe('failed');
    expect(rotated.runsSinceRotate).toBe(0);
    expect(rotated.rotateFailures ?? 0).toBe(0);

    const next = rotated.pendingSession?.uuid ?? '';
    const handoff = rotated.pendingSession?.handoff ?? '';

    expect(next).not.toBe('');
    expect(next).not.toBe(before);
    // The conversation being left behind is still the recorded one until a
    // wake actually starts the new session.
    expect(rotated.sessionUuid).toBe(before);
    // Asserted here rather than only through the answer below, so a handoff
    // that was written badly fails differently from one that was not carried.
    expect(handoff).toContain('HALCYON');

    const mark = (await onDisk()).findLast(
      (entry) => entry['from'] === ROTATOR && entry['kind'] === 'handoff',
    );

    expect(mark).toBeDefined();

    // The fresh session, which has never been told the codeword.
    await wake('manual', ROTATOR, 'reply with the codeword you were given.');

    const freshArgs = spawns.at(-1)?.args ?? [];

    expect(freshArgs).not.toContain('--resume');
    expect(freshArgs).toContain('--session-id');
    expect(freshArgs[freshArgs.indexOf('--session-id') + 1]).toBe(next);
    /*
      The handoff really did reach the string the model reads, and it leads.

      Both halves are needed, and the second is the load-bearing one.
      `wakePrompt` branches on `handoff === undefined`, not on emptiness — so a
      build that carried the `pendingSession` record but dropped or mangled its
      body between there and the argv still emits the "continuing from" preamble
      and would pass the first line alone. Pinning the codeword *in the argv* is
      what closes that gap: `wake-command.ts` spells it from the same
      `pending.handoff` already asserted above, so this follows the body all the
      way from the close's decision to the bytes handed to the binary.
    */
    expect(freshArgs.at(-1) ?? '').toContain('continuing from a previous session');
    expect(freshArgs.at(-1) ?? '').toContain('HALCYON');

    const fresh = await persisted(ROTATOR);

    expect(fresh.runs).toHaveLength(3);
    expect(fresh.runs[2]?.outcome).not.toBe('failed');
    // The binary accepted the minted uuid and reported it back, and the
    // parking spot was consumed rather than left to rotate twice.
    expect(fresh.sessionUuid).toBe(next);
    expect(fresh.sessionUuid).not.toBe(before);
    expect(fresh.pendingSession).toBeUndefined();

    /*
      And the round trip closes: a codeword spoken into a conversation this
      session never had, said back by a session that was handed it in its own
      prompt — which the argv assertion above already pinned, so this is the
      model acting on the handoff rather than the only evidence it arrived.

      Filtered to entries **after** the handoff, since the handoff itself
      contains the word — counting it would make this pass on a build that never
      carried anything. It is not filtered against the agent *reading* its own
      handoff back off the ledger, which `receiver.ts`'s `entry.from === caller`
      term allows and this suite cannot prevent; the docblock says so.
    */
    const since = String(mark?.['id'] ?? '');
    const said = (await onDisk())
      .filter(
        (entry) =>
          entry['from'] === ROTATOR &&
          entry['kind'] === 'post' &&
          String(entry['id']) > since,
      )
      .map((entry) => String(entry['body']))
      .join('\n');

    expect(said).toContain('HALCYON');
  }, 300_000);

  /**
   * The honest one (HIVE-123): skips rather than fails without a signed-in
   * Slack, so `pnpm test:agent` stays green on a machine that has never run
   * `claude mcp add slack`. `ctx.skip(condition, note)` is Vitest's dynamic
   * skip — a no-op when `slackConnected` is `true`, and otherwise throws
   * before a single assertion runs, which is what keeps this from ever
   * reporting a false pass or a false fail on an unconnected machine.
   *
   * What it proves when it does run: the `init` event's `mcp_servers` really
   * did carry `slack`'s status (not just that a file was written), and the
   * model actually called `ToolSearch` before its first `mcp__slack__` call —
   * the ordering HIVE-123's own spec note calls correct, not noise, because
   * MCP tool schemas are deferred and there is no schema to invoke a tool
   * with until `ToolSearch` has loaded one.
   */
  it(
    'reaches Slack when mcp: names it, loading the schema before calling the tool',
    async (ctx) => {
      ctx.skip(
        !slackConnected,
        'Slack is not signed in on this machine (`claude mcp get slack` did ' +
          'not report connected) — the live Slack scenario needs a real ' +
          'sign-in and cannot fake one.',
      );

      // Everything this run's own stdout produces lands after this point;
      // slicing from here is what keeps the ordering assertion below about
      // *this* wake rather than every line the suite has pushed so far.
      const before = lines.length;

      await wake('manual', SLACK);

      const state = await persisted(SLACK);
      const run = state.runs.at(-1);

      expect(run?.outcome).not.toBe('failed');
      // Read straight off the init event's own `mcp_servers` array
      // (`runs.ts`'s `slackStatus`) — proof the per-agent `probe-slack.mcp.json`
      // this wake wrote actually put a *working* Slack server in the process,
      // not merely a well-formed one.
      expect(run?.slack).toBe('connected');

      const produced = lines.slice(before);
      const toolSearchAt = produced.findIndex((line) =>
        line.text.startsWith('ToolSearch'),
      );
      const slackToolAt = produced.findIndex((line) =>
        line.text.startsWith(SLACK_TOOL_PREFIX),
      );

      expect(toolSearchAt).toBeGreaterThanOrEqual(0);
      expect(slackToolAt).toBeGreaterThanOrEqual(0);
      expect(toolSearchAt).toBeLessThan(slackToolAt);
    },
    300_000,
  );
});
