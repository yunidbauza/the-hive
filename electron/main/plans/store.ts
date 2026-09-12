import { CH } from '@shared/ipc-contract';
import {
  PLAN_GRACE_MS,
  type PlanChangedEvent,
  type PlanSource,
  type SessionPlan,
} from '@shared/plan-contract';

import { reduceTaskTool, TASK_TOOL_NAMES, type PlanToolCall } from './task-tools';

/** Every session's plan, owned by main (HIVE-179). */
export interface Plans {
  /** A main-agent PostToolUse of a plan tool (the receiver already filtered). */
  onTool(call: PlanToolCall): void;
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

  return {
    onTool(call) {
      if (!TASK_TOOL_NAMES.has(call.toolName)) return;
      // Rank 1 is always accepted, so no `accepts` check here.
      set(call.entityId, reduceTaskTool(plans.get(call.entityId), call));
    },
    offer(entityId, source, next) {
      if (!accepts(plans.get(entityId), source)) return;
      set(entityId, next);
    },
    get: (entityId) => plans.get(entityId),
    drop,
    list: () => [...plans.values()],
    dispose() {
      for (const entityId of [...timers.keys()]) cancel(entityId);
    },
  };
}
