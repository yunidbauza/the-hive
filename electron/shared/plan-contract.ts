/**
 * A session's plan: the task list the plan panel draws (HIVE-178).
 *
 * One plan per session, owned by one source at a time. Types plus one
 * constant, so both processes may import it.
 */
export type PlanTaskStatus = 'pending' | 'in_progress' | 'completed';

/** Rank order: 'task-tools' (1) beats 'plan-file' (2) beats 'plan-mode' (3). */
export type PlanSource = 'task-tools' | 'plan-file' | 'plan-mode';

export interface PlanStep {
  text: string;
  done: boolean;
}

export interface PlanTask {
  /** task-tools: Claude's id; plan-file: the task number; plan-mode: 1-based index. */
  id: string;
  title: string;
  status: PlanTaskStatus;
  /** plan-file only (HIVE-180). */
  steps?: PlanStep[];
}

export interface PlanBuild {
  askId: string;
  state: 'building' | 'failed' | 'blocked';
}

export interface SessionPlan {
  entityId: string;
  source: PlanSource;
  tasks: PlanTask[];
  /** No task left unfinished. Main drops the plan {@link PLAN_GRACE_MS} later. */
  allDone: boolean;
  /** plan-file: the absolute path it was read from (HIVE-180). */
  file?: string;
  /** A builder is working this plan (HIVE-180). */
  build?: PlanBuild;
}

/** `plan: null` means the session has no plan any more. */
export interface PlanChangedEvent {
  entityId: string;
  plan: SessionPlan | null;
}

export interface PlansSnapshot {
  plans: SessionPlan[];
}

/** How long an all-done plan stays on screen before main drops it. */
export const PLAN_GRACE_MS = 5_000;
