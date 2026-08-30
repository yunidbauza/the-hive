import { cn } from '@/lib/utils';

import type { LedgerKind } from '@shared/ledger-contract';
import { useAgentThread } from '@stores/hive-store';

interface AgentLedgerProps {
  name: string;
}

/**
 * One agent's side of the log — what it said, and what it was told.
 *
 * ## Why the chip sits above the body, not beside it
 *
 * This column is 280px at its floor, and an inline chip takes 44px of every
 * line it shares. Stacking gives the sentence the whole width, which is the
 * difference between an entry that wraps to three readable lines and one that
 * truncates to four words. The timestamp rides with the chip for the same
 * reason.
 *
 * ## Every kind gets a chip
 *
 * All nine of them, not the four the ask/answer/done/event story needs today:
 * `failed` and `handoff` both land in an agent's thread — the first when a run
 * ends badly, the second when HIVE-122 rotates its session — and a kind with
 * no chip renders as an unlabelled paragraph with no way to tell what it is.
 *
 * An open ask draws no option buttons here. HIVE-118 builds that control for
 * the inbox, and until it exists the input below this column is how an ask is
 * answered — one way to do it rather than a second, worse one.
 */
export function AgentLedger({ name }: AgentLedgerProps) {
  const entries = useAgentThread(name);

  return (
    <div
      className="flex min-h-0 flex-col gap-2.5 overflow-y-auto rounded-lg border border-border-soft bg-panel p-2.5"
      data-region="ledger"
    >
      <p className="text-[10px] tracking-[0.12em] text-subtle uppercase">
        Ledger
      </p>

      {entries.length === 0 ? (
        <p className="text-[11px] text-subtle">
          Nothing on the record yet.
        </p>
      ) : (
        entries.map((entry) => (
          <div key={entry.id} className="flex flex-col gap-1">
            <div className="flex items-center gap-1.5">
              <span
                className={cn(
                  'rounded border px-1 py-px text-[9px] tracking-[0.06em] uppercase',
                  KIND_TONE[entry.kind],
                )}
              >
                {entry.kind}
                {entry.ref === undefined ? null : ` ${entry.ref}`}
              </span>
              <span className="ml-auto text-[9.5px] text-subtle">
                {new Date(entry.ts).toLocaleTimeString([], {
                  hour: '2-digit',
                  minute: '2-digit',
                })}
              </span>
            </div>
            <p className="text-[11px] leading-relaxed break-words text-muted">
              {entry.body}
            </p>
          </div>
        ))
      )}
    </div>
  );
}

/**
 * A kind's colour, borrowed from what the app already means by each hue.
 *
 * `ask` is amber because an open question is the "needs you" state everywhere
 * else in the app; `done` and `answer` are green because they close something;
 * `failed` is red. The bookkeeping kinds — `post`, `claim`, `release` — are
 * deliberately muted: they are the record working, not news.
 */
const KIND_TONE: Record<LedgerKind, string> = {
  ask: 'text-amber',
  answer: 'text-green',
  done: 'text-green',
  failed: 'text-red',
  event: 'text-brand',
  handoff: 'text-brand',
  post: 'text-muted',
  claim: 'text-muted',
  release: 'text-muted',
};
