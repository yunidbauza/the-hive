import { CH } from '@shared/ipc-contract';
import type { PlanChangedEvent, PlanSource, SessionPlan } from '@shared/plan-contract';

import { parsePlanFile } from './parse-plan-file';
import { parsePlanMode } from './parse-plan-mode';
import { readPlanFile } from './read-plan-file';
import { isAllDone, reduceTaskTool, TASK_TOOL_NAMES, type PlanToolCall } from './task-tools';

/** Every session's plan, owned by main (HIVE-179). */
export interface Plans {
  /**
   * A main-agent PostToolUse of a plan tool (the receiver already filtered).
   * A plan-file write returns the read's promise, which never rejects.
   */
  onTool(call: PlanToolCall): Promise<void> | void;
  /** Offer a whole plan from `source`; accepted by the rank rule. */
  offer(entityId: string, source: PlanSource, next: SessionPlan | undefined): void;
  /** Current plan, or undefined. */
  get(entityId: string): SessionPlan | undefined;
  /** Forget the session's plan and publish `plan: null`, if it had one. */
  drop(entityId: string): void;
  /** Session ended: the plan and the plan file it was read from (HIVE-201). */
  forget(entityId: string): void;
  list(): SessionPlan[];
}

/** Lower wins. A source is accepted over a live plan of the same or a higher number. */
export const PLAN_SOURCE_RANK: Readonly<Record<PlanSource, number>> = {
  'task-tools': 1,
  'plan-file': 2,
  'plan-mode': 3,
};

/**
 * The plans store: one plan per session, and the rank rule between sources.
 *
 * Every accepted change publishes the full plan on `CH.planChanged`. A plan
 * that becomes all done stays, `N/N`, until the session ends (`forget`) or a
 * new plan replaces it (HIVE-229).
 */
export function createPlans({
  send,
  now = Date.now,
}: {
  send: (channel: string, payload: unknown) => void;
  /** Stamps task times and the plan file's read (HIVE-201). */
  now?: () => number;
}): Plans {
  const plans = new Map<string, SessionPlan>();
  /** Plan-file paths already refused once, so a refused file warns once, not per edit. */
  const refused = new Set<string>();
  /** The last plan file each session read, kept across sources and a finished plan's replacement (HIVE-201). */
  const planFiles = new Map<string, { file: string; at: number }>();

  const publish = (entityId: string, plan: SessionPlan | null): void => {
    send(CH.planChanged, { entityId, plan } satisfies PlanChangedEvent);
  };

  function drop(entityId: string): void {
    if (plans.delete(entityId)) publish(entityId, null);
  }

  function set(entityId: string, proposed: SessionPlan | undefined): void {
    if (proposed === plans.get(entityId)) return;
    if (proposed === undefined || proposed.tasks.length === 0) {
      drop(entityId);
      return;
    }
    let next = proposed;
    // A plan from another source still names the session's plan file (HIVE-201).
    const record = planFiles.get(entityId);
    if (record !== undefined && next.file === undefined) {
      next = { ...next, file: record.file, fileAt: record.at };
    }
    plans.set(entityId, next);
    publish(entityId, next);
  }

  const accepts = (current: SessionPlan | undefined, source: PlanSource): boolean =>
    current === undefined ||
    current.allDone ||
    PLAN_SOURCE_RANK[source] <= PLAN_SOURCE_RANK[current.source];

  function offer(entityId: string, source: PlanSource, next: SessionPlan | undefined): void {
    if (!accepts(plans.get(entityId), source)) return;
    set(entityId, next);
  }

  /**
   * Source 2 (HIVE-180): re-read the plan file on every write to it. The path
   * came from a hook payload, so `readPlanFile` confines it to the session's
   * cwd. A re-read of the file a builder is working keeps its build link.
   */
  async function readPlan(call: PlanToolCall): Promise<void> {
    const filePath = (call.toolInput as { file_path?: unknown } | null | undefined)?.file_path;
    if (typeof filePath !== 'string') return;
    const read = await readPlanFile(filePath, call.cwd);
    if (read === undefined) {
      if (!refused.has(filePath)) {
        refused.add(filePath);
        console.warn(`[hive] plan file not read (outside the session, too large, or missing): ${filePath}`);
      }
      return;
    }
    const tasks = parsePlanFile(read.text);
    if (tasks.length === 0) return;
    const at = now();
    planFiles.set(call.entityId, { file: read.file, at });
    const current = plans.get(call.entityId);
    const build = current?.source === 'plan-file' && current.file === read.file ? current.build : undefined;
    offer(call.entityId, 'plan-file', {
      entityId: call.entityId,
      source: 'plan-file',
      tasks,
      allDone: isAllDone(tasks),
      file: read.file,
      fileAt: at,
      ...(build === undefined ? {} : { build }),
    });
  }

  return {
    onTool(call) {
      if (call.toolName === 'Write' || call.toolName === 'Edit') return readPlan(call);
      if (call.toolName === 'ExitPlanMode') {
        // Source 3: plan mode's approved plan, every task proposed. claude
        // 2.1.270's PostToolUse sends `tool_input: {}` and the plan in
        // `tool_response.plan`; older builds sent it in the input.
        const plan =
          (call.toolResponse as { plan?: unknown } | null | undefined)?.plan ??
          (call.toolInput as { plan?: unknown } | null | undefined)?.plan;
        const tasks = typeof plan === 'string' ? parsePlanMode(plan) : [];
        if (tasks.length > 0) {
          offer(call.entityId, 'plan-mode', { entityId: call.entityId, source: 'plan-mode', tasks, allDone: false });
        }
        return;
      }
      if (!TASK_TOOL_NAMES.has(call.toolName)) return;
      // Rank 1 is always accepted, so no `accepts` check here.
      set(call.entityId, reduceTaskTool(plans.get(call.entityId), call, now()));
    },
    offer,
    get: (entityId) => plans.get(entityId),
    drop,
    forget(entityId) {
      planFiles.delete(entityId);
      drop(entityId);
    },
    list: () => [...plans.values()],
  };
}
