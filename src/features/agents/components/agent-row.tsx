import { Pause, Play } from '@phosphor-icons/react';
import { useEffect, useState } from 'react';

import { cn } from '@/lib/utils';
import { isAgent } from '@/types/entity';

import { STATUS_LABEL } from '@components/ui/status-dot';
import { AgentTile, type TileTone } from '@features/shared/components/agent-tile';
import { useAge } from '@hooks/use-relative-time';
import type { LedgerKind } from '@shared/ledger-contract';
import {
  agentRunQueued,
  agentRunRefusal,
  useAgentLastWord,
  useAgentLiveCount,
  useEntity,
  useOpenEntity,
} from '@stores/hive-store';
import { useAgentPage } from '@stores/ui-store';

interface AgentRowProps {
  id: string;
}

/** Line 2's keyword, in the colour of what the entry was. */
const KEYWORD_TONE: Partial<Record<LedgerKind, string>> = {
  ask: 'text-amber-text',
  failed: 'text-red',
  event: 'text-brand',
  post: 'text-subtle',
  done: 'text-green',
};

/** How long a Run now or Pause answer holds line 2 before the last word comes back. */
const NOTICE_MS = 5000;

const messageOf = (cause: unknown) => (cause instanceof Error ? cause.message : String(cause));

/**
 * One background agent in the panel (HIVE-204): a hexagon tile, the name with
 * the age of its last word, and the last word itself.
 *
 * Renders nothing for an id that is not an agent, matching the session rows —
 * panels stay defensive about a store that other stories mutate underneath
 * them.
 *
 * ## Line 2 is what the agent last said
 *
 * The row used to carry a status word and a detail column (the next wake, the
 * skip count). The lane already says the state, so line 2 now answers the next
 * question, *what is it doing?*, with the agent's newest ledger entry: its kind
 * as a coloured keyword (an ask by its ref, so it can be answered by name) and
 * the entry's first line. A definition that does not parse shows `invalid` and
 * its reason instead, because that is the one thing that helps; a paused agent
 * says `paused` in place of the keyword, beside its last word if it has one.
 *
 * ## The slot
 *
 * At rest the slot at the end of line 1 shows the last word's age. On hover or
 * focus Run now and Pause (Resume alone, for a paused agent) show over it, through
 * the bridge calls the page used. They sit beside the row's button rather than
 * inside it, so each keeps its own tab stop, and the slot's width is fixed so
 * the name never moves. An answer that is not a start (a refusal, a queued
 * wake, a rejected pause) takes line 2 for five seconds, as a status.
 *
 * ## The state in words
 *
 * The tile is decoration. The accessible name says the state, the live-run
 * count and the last word, so the colour is never the only carrier.
 */
export function AgentRow({ id }: AgentRowProps) {
  const entity = useEntity(id);
  const page = useAgentPage();
  const openEntity = useOpenEntity();
  const live = useAgentLiveCount(id);
  const last = useAgentLastWord(id);
  // `0` when it has never written: a fixed timestamp keeps the ticking clock's
  // effect from re-arming on every render, and the age is not drawn then.
  const age = useAge(last?.ts ?? 0);
  const [notice, setNotice] = useState<string | null>(null);

  // Re-armed by each new notice, and cleared on unmount.
  useEffect(() => {
    if (notice === null) return undefined;

    const timer = setTimeout(() => setNotice(null), NOTICE_MS);

    return () => clearTimeout(timer);
  }, [notice]);

  if (!entity || !isAgent(entity)) return null;

  const paused = entity.status === 'paused';

  /*
    The wording comes from `agentRunRefusal` and `agentRunQueued` (HIVE-117):
    they switch exhaustively over the union, so the next refusal is a compile
    error rather than a plausible sentence.
  */
  const runNow = () => {
    setNotice(null);
    void window.hive?.agents
      .run({ name: id })
      .then((result) => {
        if (result.started) return;
        setNotice('queued' in result ? agentRunQueued(id, result) : agentRunRefusal(id, result));
      })
      .catch((cause: unknown) => setNotice(messageOf(cause)));
  };

  // Both channels reject when the runtime is not up, so both need the catch.
  const togglePause = () => {
    setNotice(null);

    const bridge = window.hive?.agents;

    if (bridge === undefined) return;

    void (paused ? bridge.resume({ name: id }) : bridge.pause({ name: id })).catch((cause: unknown) =>
      setNotice(messageOf(cause)),
    );
  };

  const broken = entity.invalid !== undefined;
  const current = page?.name === id;

  let tone: TileTone = 'resting';
  if (entity.status === 'asking') tone = 'asking';
  else if (entity.status === 'failed') tone = 'failed';
  else if (broken) tone = 'invalid';
  else if (entity.status === 'working') tone = 'working';

  let keyword = '';
  if (broken) keyword = 'invalid';
  else if (entity.status === 'paused') keyword = 'paused';
  else if (last !== undefined) keyword = last.kind === 'ask' && last.ref !== undefined ? `ask ${last.ref}` : last.kind;

  const text = broken ? entity.invalid : (last?.line ?? '');
  // The second line is drawn only when it has something to say.
  const twoLines = notice !== null || keyword !== '' || text !== '';
  const keywordTone =
    broken || paused || last === undefined ? 'text-amber-text' : (KEYWORD_TONE[last.kind] ?? 'text-subtle');

  const state = broken ? 'invalid' : STATUS_LABEL[entity.status];
  const name =
    [`${id}, ${state}`, live > 1 ? `${String(live)} runs live` : null].filter(Boolean).join(', ') +
    (last === undefined ? '' : `. Last: ${last.kind}, ${last.line}, ${age}`);

  return (
    <div className="group relative">
      <button
        type="button"
        onClick={() => openEntity(id)}
        aria-current={current ? 'true' : undefined}
        aria-label={name}
        className={cn(
          // Centred: with a second line the text outgrows the tile, which would otherwise sit at the top.
          'flex w-full items-center gap-2.5 rounded-xl p-2 text-left',
          current ? 'bg-active' : 'hover:bg-hover',
        )}
      >
        <AgentTile icon={entity.icon} tone={tone} live={live} size="sm" />
        <span className="flex min-w-0 flex-1 flex-col gap-[3px]">
          <span className="flex items-center gap-2">
            <b className="truncate text-ui font-semibold text-ink">{id}</b>
            <span className="flex-1" />
            <span className="w-[44px] shrink-0 text-right text-ui-sm text-subtle group-focus-within:invisible group-hover:invisible">
              {last === undefined ? '' : age}
            </span>
          </span>
          {notice === null ? (
            <span className="truncate text-ui-sm text-muted">
              {keyword === '' ? null : (
                <i className={cn('mr-1 not-italic', keywordTone)}>{keyword}</i>
              )}
              {text}
            </span>
          ) : (
            <span role="status" className="truncate text-ui-sm text-amber-text">
              {notice}
            </span>
          )}
        </span>
      </button>
      {/* Level with the name: the first line when there are two, the middle of the row when there is one. */}
      <span
        className={cn(
          'invisible absolute right-2 flex gap-2.5 group-focus-within:visible group-hover:visible',
          twoLines ? 'top-2' : 'top-1/2 -translate-y-1/2',
        )}
      >
        {/* A paused agent refuses a run, and its Resume is a play icon too: one ▶, not two. */}
        {paused ? null : (
          <button
            type="button"
            aria-label={`Run ${id} now`}
            title="Wake this agent once, now."
            onClick={runNow}
            className="rounded-full p-0.5 text-muted hover:text-ink"
          >
            <Play size={13} aria-hidden="true" />
          </button>
        )}
        <button
          type="button"
          aria-label={paused ? `Resume ${id}` : `Pause ${id}`}
          title={paused ? 'Let this agent wake again' : 'Stop this agent waking. A turn already running finishes.'}
          onClick={togglePause}
          className="rounded-full p-0.5 text-muted hover:text-ink"
        >
          {paused ? <Play size={13} aria-hidden="true" /> : <Pause size={13} aria-hidden="true" />}
        </button>
      </span>
    </div>
  );
}
