import type { PlanTask, PlanTaskStatus, SessionPlan } from '@shared/plan-contract';

/**
 * One main-agent `PostToolUse` of a plan tool, as the hook receiver hands it
 * over (HIVE-179). The receiver has already filtered out Pre, subagents and
 * truncated bodies; this module only folds.
 */
export interface PlanToolCall {
  entityId: string;
  toolName: string;
  toolInput: unknown;
  toolResponse: unknown;
  cwd?: string;
  /**
   * The body was over the hook route's cap and only its prefix was read
   * (HIVE-180). Only a plan-file `Write` or `Edit` is ever handed over like
   * this, carrying nothing but `file_path`.
   */
  truncated?: true;
}

/**
 * A `hive:plan` file: `<anything>/.hive/plans/<name>.md`, one level deep
 * (HIVE-180). A path with an escaped quote never reaches here — the prefix
 * read refuses it — and main confines the read to the session's cwd besides.
 */
export const PLAN_FILE_PATH = /\/\.hive\/plans\/[^/]+\.md$/;

/** Whether a hook payload's `file_path` names a plan file. */
export const isPlanFilePath = (value: unknown): value is string =>
  typeof value === 'string' && PLAN_FILE_PATH.test(value);

/** Claude's task tools. `TodoWrite` is not offered by 2.1.269 `-p`, but older builds send it. */
export const TASK_TOOL_NAMES: ReadonlySet<string> = new Set(['TaskCreate', 'TaskUpdate', 'TodoWrite']);

const STATUSES: ReadonlySet<string> = new Set<PlanTaskStatus>(['pending', 'in_progress', 'completed']);

const isStatus = (value: unknown): value is PlanTaskStatus =>
  typeof value === 'string' && STATUSES.has(value);

const record = (value: unknown): Record<string, unknown> =>
  typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};

const str = (value: unknown): string | undefined =>
  typeof value === 'string' && value !== '' ? value : undefined;

/** At least one task, and none left unfinished. */
export const isAllDone = (tasks: readonly PlanTask[]): boolean =>
  tasks.length > 0 && tasks.every((task) => task.status === 'completed');

const withTasks = (entityId: string, tasks: PlanTask[]): SessionPlan => ({
  entityId,
  source: 'task-tools',
  tasks,
  allDone: isAllDone(tasks),
});

/**
 * One `PostToolUse` of a task tool, folded into the session's plan.
 *
 * Returns the same object when the call changes nothing, so the store can
 * skip a publish by identity. Measured shapes: `.hive/specs/fixtures`,
 * claude 2.1.269, copied to `tests/fixtures/hooks`.
 *
 * - `TaskCreate` appends; its id exists only in `tool_response.task.id`.
 * - `TaskUpdate` sets a status, renames on `subject`, or removes on
 *   `deleted`. An id the plan does not hold is ignored, which is how a
 *   subagent's task (same id space) stays out if one ever slips through.
 * - `TodoWrite` replaces the whole list; ids are `"1".."n"` by position.
 */
export function reduceTaskTool(
  plan: SessionPlan | undefined,
  call: PlanToolCall,
): SessionPlan | undefined {
  const input = record(call.toolInput);
  switch (call.toolName) {
    case 'TaskCreate': {
      const id = str(record(record(call.toolResponse).task).id);
      const title = str(input.subject);
      if (id === undefined || title === undefined) return plan;
      // A task-tools plan is the base only while it is live; anything else starts fresh.
      const base = plan?.source === 'task-tools' && !plan.allDone ? plan.tasks : [];
      return withTasks(call.entityId, [...base, { id, title, status: 'pending' }]);
    }
    case 'TaskUpdate': {
      if (plan?.source !== 'task-tools') return plan;
      const id = str(input.taskId);
      const current = plan.tasks.find((task) => task.id === id);
      if (current === undefined) return plan;
      if (input.status === 'deleted') {
        return withTasks(
          call.entityId,
          plan.tasks.filter((task) => task !== current),
        );
      }
      const status = isStatus(input.status) ? input.status : current.status;
      const title = str(input.subject) ?? current.title;
      if (status === current.status && title === current.title) return plan;
      return withTasks(
        call.entityId,
        plan.tasks.map((task) => (task === current ? { ...current, status, title } : task)),
      );
    }
    case 'TodoWrite': {
      if (!Array.isArray(input.todos)) return plan;
      const tasks = input.todos.flatMap((todo: unknown, index): PlanTask[] => {
        const fields = record(todo);
        const title = str(fields.content);
        if (title === undefined) return [];
        const status = isStatus(fields.status) ? fields.status : 'pending';
        return [{ id: String(index + 1), title, status }];
      });
      return withTasks(call.entityId, tasks);
    }
    default:
      return plan;
  }
}
