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
  /** Present continuous wording Claude shows in its spinner ("Pushing the branch"). task-tools only. */
  activeForm?: string;
  /** Epoch ms the task first went `in_progress` (HIVE-201). Never re-stamped. */
  startedAt?: number;
  /** Epoch ms the task went `completed` (HIVE-201). */
  endedAt?: number;
  /** plan-file only (HIVE-180). */
  steps?: PlanStep[];
}

interface PlanBuild {
  askId: string;
  state: 'building' | 'failed' | 'blocked';
}

export interface SessionPlan {
  entityId: string;
  source: PlanSource;
  tasks: PlanTask[];
  /** No task left unfinished. The plan stays until the session ends or a new plan replaces it (HIVE-229). */
  allDone: boolean;
  /** The session's last plan file, absolute (HIVE-180). Set on a plan-file plan, and carried onto a later plan from any source (HIVE-201). */
  file?: string;
  /** Epoch ms main accepted the read of {@link file} (HIVE-201). */
  fileAt?: number;
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
