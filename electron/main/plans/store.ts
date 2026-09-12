import { CH } from '@shared/ipc-contract';
import {
  PLAN_GRACE_MS,
  type PlanChangedEvent,
  type PlanSource,
  type SessionPlan,
} from '@shared/plan-contract';

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
  list(): SessionPlan[];
  /** Cancel every pending all-done drop. */
  dispose(): void;
}

/** Lower wins. A source is accepted over a live plan of the same or a higher number. */
export const PLAN_SOURCE_RANK: Readonly<Record<PlanSource, number>> = {
  'task-tools': 1,
  'plan-file': 2,
  'plan-mode': 3,
};

/**
 * The plans store: one plan per session, the rank rule between sources, and
 * the all-done grace timer.
 *
 * Every accepted change publishes the full plan on `CH.planChanged`. A plan
 * that becomes all done stays for `graceMs`, so the panel can say so, then
 * drops; any accepted change in the meantime cancels the drop.
 */
export function createPlans({
  send,
  graceMs = PLAN_GRACE_MS,
}: {
  send: (channel: string, payload: unknown) => void;
  graceMs?: number;
}): Plans {
  const plans = new Map<string, SessionPlan>();
  const timers = new Map<string, ReturnType<typeof setTimeout>>();
  /** Plan-file paths already refused once, so a refused file warns once, not per edit. */
  const refused = new Set<string>();

  const publish = (entityId: string, plan: SessionPlan | null): void => {
    send(CH.planChanged, { entityId, plan } satisfies PlanChangedEvent);
  };

  const cancel = (entityId: string): void => {
    clearTimeout(timers.get(entityId));
    timers.delete(entityId);
  };

  function drop(entityId: string): void {
    cancel(entityId);
    if (plans.delete(entityId)) publish(entityId, null);
  }

  function set(entityId: string, next: SessionPlan | undefined): void {
    if (next === plans.get(entityId)) return;
    cancel(entityId);
    if (next === undefined || next.tasks.length === 0) {
      drop(entityId);
      return;
    }
    plans.set(entityId, next);
    publish(entityId, next);
    if (next.allDone) {
      timers.set(
        entityId,
        setTimeout(() => {
          timers.delete(entityId);
          drop(entityId);
        }, graceMs),
      );
    }
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
    const current = plans.get(call.entityId);
    const build = current?.source === 'plan-file' && current.file === read.file ? current.build : undefined;
    offer(call.entityId, 'plan-file', {
      entityId: call.entityId,
      source: 'plan-file',
      tasks,
      allDone: isAllDone(tasks),
      file: read.file,
      ...(build === undefined ? {} : { build }),
    });
  }

  return {
    onTool(call) {
      if (call.toolName === 'Write' || call.toolName === 'Edit') return readPlan(call);
      if (call.toolName === 'ExitPlanMode') {
        // Source 3: plan mode's approved plan, every task proposed.
        const plan = (call.toolInput as { plan?: unknown } | null | undefined)?.plan;
        const tasks = typeof plan === 'string' ? parsePlanMode(plan) : [];
        if (tasks.length > 0) {
          offer(call.entityId, 'plan-mode', { entityId: call.entityId, source: 'plan-mode', tasks, allDone: false });
        }
        return;
      }
      if (!TASK_TOOL_NAMES.has(call.toolName)) return;
      // Rank 1 is always accepted, so no `accepts` check here.
      set(call.entityId, reduceTaskTool(plans.get(call.entityId), call));
    },
    offer,
    get: (entityId) => plans.get(entityId),
    drop,
    list: () => [...plans.values()],
    dispose() {
      for (const entityId of [...timers.keys()]) cancel(entityId);
    },
  };
}
