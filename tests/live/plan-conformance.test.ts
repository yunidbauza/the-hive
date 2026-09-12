// @vitest-environment node
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  HOOK_ENV_RECEIVER_URL,
  HOOK_ENV_SESSION,
  HOOK_ENV_TOKEN,
} from '../../electron/shared/hook-contract';
import { CH } from '../../electron/shared/ipc-contract';
import type { PlanChangedEvent } from '../../electron/shared/plan-contract';

import { createReceiver, type Receiver } from '../../electron/main/hooks/receiver';
import { writeHookSettings } from '../../electron/main/hooks/settings';
import { createPlans, type Plans } from '../../electron/main/plans';

/**
 * Plan state against a real `claude` (HIVE-179).
 *
 * The unit suites replay bodies recorded from claude 2.1.269. This asks the
 * binary installed today: a real `claude -p` with the generated hook settings,
 * posting to the real receiver, feeding the real plans store. It creates three
 * tasks, moves one to in progress and then completed, and dispatches a
 * foreground subagent that creates a fourth — which shares the session's id
 * space and must never reach the session's plan.
 *
 * `-p` with the prompt on **stdin**, every tool the turn needs pinned in
 * `--allowedTools` (a permission prompt would strand it), and the environment
 * stripped of every ambient `HIVE_*` before this suite's own are set: run from
 * inside a Hive session or agent, the child would otherwise inherit that app's
 * receiver, token or run and report to it instead.
 *
 * `finding.json` is written every run, beside nothing else, with every push
 * and the child's output: vitest hides console output off a TTY, and a live
 * failure is only worth something if what the binary did can be read after.
 */

const enabled = process.env.HIVE_LIVE_PLAN_PROOF === '1';

const ENTITY = 'sess-live-plan';

const PROMPT =
  'Create three tasks with TaskCreate, subjects Alpha, Beta, Gamma. ' +
  'Set Alpha in_progress, then completed. ' +
  'Then dispatch one foreground subagent whose only job is to call TaskCreate once with subject Delta. ' +
  'Reply DONE.';

const noLedger = {
  onLedgerRead: () => ({ entries: [], openAsks: [], claims: {} }),
  onLedgerPost: () => ({ ok: false as const, status: 503, reason: 'not exercised by this test' }),
};

const noAgents = {
  knowsAgent: () => false,
  onAgentEvent: () => {},
  onAgentsList: () => Promise.resolve({ agents: [] }),
};

/** `process.env` without a single `HIVE_*`, so nothing ambient reaches the child. */
const ambient = (): Record<string, string> =>
  Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] => !entry[0].startsWith('HIVE_') && entry[1] !== undefined,
    ),
  );

const claude = (
  cwd: string,
  settingsPath: string,
  env: Record<string, string>,
): Promise<{ code: number | null; stdout: string; stderr: string }> =>
  new Promise((resolve) => {
    const child = spawn(
      'claude',
      [
        '--settings',
        settingsPath,
        '--allowedTools',
        'TaskCreate,TaskUpdate,Agent,ToolSearch',
        '-p',
      ],
      { cwd, env: { ...ambient(), ...env }, stdio: ['pipe', 'pipe', 'pipe'] },
    );
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    const timer = setTimeout(() => child.kill('SIGKILL'), 240_000);
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
    child.stdin.end(PROMPT);
  });

describe.skipIf(!enabled)('plan conformance (HIVE-179)', () => {
  let receiver: Receiver;
  let plans: Plans;
  let sent: PlanChangedEvent[];
  let cwd: string;
  let dumpDir: string;
  let settingsPath: string;

  beforeAll(async () => {
    sent = [];
    plans = createPlans({
      send: (channel, payload) => {
        if (channel === CH.planChanged) sent.push(payload as PlanChangedEvent);
      },
    });
    receiver = createReceiver({
      onEvent: () => {},
      onPlanTool: (call) => plans.onTool(call),
      onTicketIntent: () => {},
      onPromptName: () => {},
      onCleared: () => {},
      onMetrics: () => {},
      onDone: () => {},
      onReady: () => {},
      knowsSession: (entityId) => entityId === ENTITY,
      ...noLedger,
      ...noAgents,
    });

    const url = await receiver.start();
    expect(url).not.toBeNull();

    cwd = mkdtempSync(join(tmpdir(), 'hive-plan-cwd-'));
    dumpDir = mkdtempSync(join(tmpdir(), 'hive-plan-dump-'));
    const userData = mkdtempSync(join(tmpdir(), 'hive-plan-data-'));
    // Generated as a real launch generates it, from the receiver actually listening.
    settingsPath = await writeHookSettings(userData, url as string);
  });

  afterAll(async () => {
    plans.dispose();
    await receiver.stop();
  });

  it(
    "builds the main agent's plan in order and keeps the subagent's task out",
    { timeout: 300_000 },
    async () => {
      const { code, stdout, stderr } = await claude(cwd, settingsPath, {
        [HOOK_ENV_SESSION]: ENTITY,
        [HOOK_ENV_TOKEN]: receiver.tokenFor(ENTITY),
        [HOOK_ENV_RECEIVER_URL]: receiver.origin as string,
      });

      const finding = join(dumpDir, 'finding.json');
      writeFileSync(finding, JSON.stringify({ code, stdout, stderr, sent }, null, 2));
      const why = `what claude did is in ${finding}`;

      const last = sent.filter((event) => event.plan !== null).at(-1)?.plan;

      expect(last?.source, why).toBe('task-tools');
      expect(last?.tasks.map((task) => task.title), why).toEqual(['Alpha', 'Beta', 'Gamma']);
      expect(last?.tasks.map((task) => task.status), why).toEqual([
        'completed',
        'pending',
        'pending',
      ]);
      // An intermediate push saw Alpha in progress: the ticks arrive one by one.
      expect(
        sent.some((event) =>
          event.plan?.tasks.some((task) => task.title === 'Alpha' && task.status === 'in_progress'),
        ),
        why,
      ).toBe(true);
      // The subagent's task shares the session's id space and never reaches its plan.
      expect(
        sent.some((event) => event.plan?.tasks.some((task) => task.title === 'Delta')),
        why,
      ).toBe(false);
    },
  );
});
