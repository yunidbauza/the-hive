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
import { createRunTracker, type ChildLike, type RunTracker } from '../../electron/main/agents/runs';
import { createAgentState, type AgentState } from '../../electron/main/agents/state';
import { createWakeCommand } from '../../electron/main/agents/wake-command';
import { createReceiver, type Receiver } from '../../electron/main/hooks/receiver';
import { writeHookSettings } from '../../electron/main/hooks/settings';
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
 * ## The two things it has to pin, or it hangs or lies
 *
 * **The tools.** `--allowedTools` grants and cannot restrict, so a turn that
 * reaches for something ungranted hits a permission prompt with no tty to
 * answer it and sits there until the suite's timeout. The definition below
 * therefore grants the read-only set a small model plausibly reaches for, and
 * the body tells it not to reach at all.
 *
 * **The timeout.** Two real turns take far longer than Vitest's default five
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

describe.skipIf(!LIVE)('one real headless wake, against a real claude', () => {
  /** `undefined` until `beforeAll` gets past its prerequisite check. */
  let dir: string | undefined;
  let hiveDir: string;
  let userDataPath: string;
  let previousConfigPath: string | undefined;

  let receiver: Receiver | null = null;
  let ledger: Ledger;
  let agentState: AgentState;
  let runs: RunTracker;

  /** Every argv this suite spawned, in order. */
  const spawns: { file: string; args: string[] }[] = [];
  /** Every hook event that came back on the **agent** register. */
  const agentEvents: HookAgentEvent[] = [];
  /** Every hook event that came back on the **session** register. Must stay empty. */
  const sessionEvents: HookStatusEvent[] = [];
  /** Every run-log line the tracker folded out of the child's stdout. */
  const lines: RunLine[] = [];

  /** Resolved by `pushStatus` the moment a run stops being `working`. */
  let settle: (() => void) | null = null;

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

    await mkdir(join(agentsRoot(), NAME), { recursive: true });
    await writeFile(join(agentsRoot(), NAME, 'AGENT.md'), AGENT_MD, 'utf8');

    ledger = createLedger({
      dir: join(dirname(process.env[CONFIG_PATH_ENV]), LEDGER_DIR),
      // The agent is a party, exactly as `ipc/index.ts` makes it one the moment
      // a command has been built for it — or `run.started` is refused 404 and
      // assertion 3 has nothing to find.
      knowsParty: (party) => party === NAME || party === OVERMIND,
    });

    receiver = createReceiver({
      // No sessions at all: this suite has no pty, and the assertion that no
      // session status was published is only meaningful if the session register
      // is empty rather than merely unused.
      knowsSession: () => false,
      knowsAgent: (id) => id === NAME,
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

    const settingsPath = await writeHookSettings(userDataPath, url ?? '');

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
      settingsPath: () => settingsPath,
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
        if (agentState.read(name).status !== 'working') settle?.();
      },
      pushLines: (_name, pushed) => lines.push(...pushed),
      now: () => Date.now(),
      newRunId: () => randomUUID(),
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

  /** Wake the agent and resolve when the tracker has finalized the run. */
  const wake = (trigger: string): Promise<void> =>
    new Promise((resolve, reject) => {
      settle = resolve;

      const started = runs.run(NAME, trigger);

      if (!started.started) {
        reject(
          new Error(
            `the wake was refused (${started.refused}): ${started.reason ?? 'no reason given'}`,
          ),
        );
      }
    });

  /** `agents.json` as it is on disk, which is what the next launch would read. */
  const persisted = async (): Promise<AgentRunState> => {
    agentState.flush();

    const parsed = JSON.parse(await readFile(agentStateFile(), 'utf8')) as Record<
      string,
      AgentRunState
    >;
    const state = parsed[NAME];

    if (state === undefined) throw new Error(`${NAME} is not in agents.json`);

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
});
