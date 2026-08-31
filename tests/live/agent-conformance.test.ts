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
import { createLedger, type Ledger } from '../../electron/main/ledger';
import { mcpConfig } from '../../electron/main/mcp/config';
import { createSkillsRuntime } from '../../electron/main/skills';
import type { AgentRunState, RunLine } from '../../electron/shared/agent-contract';
import {
  HOOK_ENV_RECEIVER_URL,
  HOOK_ENV_SESSION,
  HOOK_ENV_TOKEN,
  type HookAgentEvent,
  type HookStatusEvent,
} from '../../electron/shared/hook-contract';
import { CONFIG_PATH_ENV } from '../../electron/shared/config-contract';
import { LEDGER_DIR, OVERMIND } from '../../electron/shared/ledger-contract';

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
const AGENTS = [NAME, ASKER, RESPONDER, FENCE];

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
    ] as const) {
      await mkdir(join(agentsRoot(), name), { recursive: true });
      await writeFile(join(agentsRoot(), name, 'AGENT.md'), body, 'utf8');
    }

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

    const buildWakeCommand = createWakeCommand({
      agentsRoot,
      workdir: agentWorkdir,
      promptFile: (name) => agentPromptFile(userDataPath, name),
      pluginDir: () => pluginDir ?? '',
      agentSettingsPath: () => settingsPath,
      mcpConfig: () => mcpConfigPath,
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
      newUuid: () => randomUUID(),
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
      ledger: {
        read: () => ledger.read({}),
        append: (request) => ledger.append(request),
      },
      now: () => Date.now(),
    });

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

  /** Wake the agent and resolve when the tracker has finalized the run. */
  const wake = (trigger: string, name: string = NAME): Promise<void> =>
    new Promise((resolve, reject) => {
      settlers.set(name, resolve);

      const started = runs.run(name, trigger);

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
});
