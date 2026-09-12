import type { PlanStep, PlanTask, PlanTaskStatus } from '@shared/plan-contract';

/** `## Task 3: Name` or `### Task: Name`; the number is optional. */
const TASK = /^#{2,3}\s+Task\s*(\d+)?\s*:\s*(.+)$/;
/** The skill's `risk: … est: …` trailer, set off by a run of two or more spaces. */
const TRAILER = /\s{2,}(?:risk|est):.*$/;
/** A checkbox at any indent, so nested sub-steps count. */
const STEP = /^\s*[-*]\s+\[([ xX])\]\s+(.+)$/;
const FENCE = /^\s*(?:```|~~~)/;
const HEADING = /^#{1,6}\s/;

const statusOf = (steps: readonly PlanStep[]): PlanTaskStatus => {
  const done = steps.filter((step) => step.done).length;
  if (steps.length > 0 && done === steps.length) return 'completed';
  return done > 0 ? 'in_progress' : 'pending';
};

/**
 * A `hive:plan` file's tasks (HIVE-180).
 *
 * `## Task N: <name>   risk: … est: …` is the skill's shape; `###` is
 * accepted too, and a task with no number takes its 1-based position. Steps
 * are checkbox lines under a task, outside code fences, until the next
 * heading. Status comes from the steps: all ticked is completed, some is in
 * progress, none (or no steps) is pending. No task headings is no plan — an
 * empty list, never an error.
 */
export function parsePlanFile(markdown: string): PlanTask[] {
  const tasks: { id: string; title: string; steps: PlanStep[] }[] = [];
  let current: (typeof tasks)[number] | undefined;
  let fenced = false;
  for (const line of markdown.split(/\r?\n/)) {
    if (FENCE.test(line)) {
      fenced = !fenced;
      continue;
    }
    if (fenced) continue;
    const task = TASK.exec(line);
    if (task !== null) {
      current = {
        id: task[1] ?? String(tasks.length + 1),
        title: (task[2] ?? '').replace(TRAILER, '').trim(),
        steps: [],
      };
      tasks.push(current);
      continue;
    }
    if (HEADING.test(line)) {
      current = undefined;
      continue;
    }
    const step = current === undefined ? null : STEP.exec(line);
    if (current !== undefined && step !== null) {
      current.steps.push({ text: (step[2] ?? '').trim(), done: step[1] !== ' ' });
    }
  }
  return tasks.map(({ id, title, steps }) => ({ id, title, status: statusOf(steps), steps }));
}
