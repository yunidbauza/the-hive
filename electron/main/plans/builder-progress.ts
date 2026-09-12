import type { LedgerEntry } from '@shared/ledger-contract';
import type { PlanTaskStatus, SessionPlan } from '@shared/plan-contract';

import type { Plans } from './store';
import { isAllDone } from './task-tools';

/** A build ask, tied to the session that asked it and the plan file it names. */
interface Link {
  entityId: string;
  /** The party the ask went to: the only one whose posts tick it. */
  builder: string | undefined;
  /** The plan file's realpath when the link was made. */
  file: string;
}

/**
 * A builder's progress, ticked onto the session that asked for the build
 * (HIVE-180).
 *
 * The builder's own hooks arrive under its name and never touch a session's
 * plan (HIVE-179); the ledger is the only path. Authorship is the predicate:
 * the link is the ask's `from` — a session id main minted from the caller's
 * header, never body text — and only the party the ask went to may tick it.
 * Main never reads a file on the ledger's word: an ask links only to a plan
 * the session already holds from its own plan file.
 *
 * - **Link.** A `build` ask naming `meta.plan` from a known session whose
 *   current plan is that plan file sets `build: building`.
 * - **Ticks.** A `build` post from the builder in the ask's thread, with an
 *   integer `meta.task`: `state: 'started'` is in progress, otherwise done.
 * - **End.** An answer in the thread: `failed:` or `blocked:` marks the build
 *   and keeps the ticks; anything else completes every task, so the usual
 *   all-done grace runs. The link is forgotten either way.
 *
 * A plan that has since been replaced — another source, another file, another
 * build — is never edited on this build's word.
 */
/** What `ipc/index.ts` feeds every ledger entry to (HIVE-180). */
export interface BuilderProgress {
  onEntry(entry: LedgerEntry): void;
}

export function createBuilderProgress({
  plans,
  knowsSession,
}: {
  plans: Plans;
  knowsSession: (id: string) => boolean;
}): BuilderProgress {
  const links = new Map<string, Link>();

  const edit = (askId: string, link: Link, change: (plan: SessionPlan) => SessionPlan): void => {
    const plan = plans.get(link.entityId);
    if (plan?.source !== 'plan-file' || plan.file !== link.file || plan.build?.askId !== askId) return;
    plans.offer(link.entityId, 'plan-file', change(plan));
  };

  function link(entry: LedgerEntry, meta: Record<string, unknown>): void {
    const planPath = meta.plan;
    if (meta.stage !== 'build' || typeof planPath !== 'string' || !knowsSession(entry.from)) return;
    /*
      A broadcast ask is never linked: nobody could tick it, and the ledger
      lets any party answer a thread with no `to` — so any session or agent
      could fail or complete a build that is not theirs.
    */
    if (entry.to === undefined) return;
    const plan = plans.get(entry.from);
    const suffix = `/${planPath.replace(/^\.?\//, '')}`;
    if (plan?.source !== 'plan-file' || plan.file === undefined || !plan.file.endsWith(suffix)) return;
    links.set(entry.id, { entityId: entry.from, builder: entry.to, file: plan.file });
    plans.offer(entry.from, 'plan-file', { ...plan, build: { askId: entry.id, state: 'building' } });
  }

  return {
    onEntry(entry) {
      const meta = entry.meta ?? {};
      if (entry.kind === 'ask') {
        link(entry, meta);
        return;
      }
      const askId = entry.thread;
      const linked = askId === undefined ? undefined : links.get(askId);
      if (askId === undefined || linked === undefined) return;

      if (entry.kind === 'post') {
        const task = meta.task;
        if (entry.from !== linked.builder || meta.stage !== 'build' || !Number.isInteger(task)) return;
        const id = String(task);
        const status: PlanTaskStatus = meta.state === 'started' ? 'in_progress' : 'completed';
        edit(askId, linked, (plan) => {
          if (!plan.tasks.some((t) => t.id === id)) return plan;
          const tasks = plan.tasks.map((t) => (t.id === id ? { ...t, status } : t));
          return { ...plan, tasks, allDone: isAllDone(tasks) };
        });
        return;
      }

      if (entry.kind === 'answer') {
        const ended = /^(failed|blocked):/i.exec(entry.body.trimStart());
        edit(askId, linked, (plan) => {
          if (ended !== null) {
            const state = ended[1]?.toLowerCase() === 'blocked' ? 'blocked' : 'failed';
            return { ...plan, build: { askId, state } };
          }
          const tasks = plan.tasks.map((t) => ({ ...t, status: 'completed' as const }));
          return { ...plan, tasks, allDone: true };
        });
        links.delete(askId);
      }
    },
  };
}
