import type { PlanTask } from '@shared/plan-contract';

const H3 = /^###\s+(.+)$/;
/** Top level only: no leading space, so a nested item is skipped. */
const ITEM = /^\d+[.)]\s+(.+)$/;
const clean = (title: string): string => title.replace(/[*_`]/g, '').trim();

/**
 * Plan mode's approved plan (HIVE-180).
 *
 * `###` headings when there are any, otherwise the top-level numbered list;
 * neither is no plan. Plan mode has no status of its own, so every task is
 * pending — the panel shows it as proposed because the source is `plan-mode`.
 */
export function parsePlanMode(markdown: string): PlanTask[] {
  const lines = markdown.split(/\r?\n/);
  const headings = lines.flatMap((line) => H3.exec(line)?.[1] ?? []);
  const titles =
    headings.length > 0 ? headings : lines.flatMap((line) => ITEM.exec(line)?.[1] ?? []);
  return titles.map((title, index) => ({
    id: String(index + 1),
    title: clean(title),
    status: 'pending',
  }));
}
