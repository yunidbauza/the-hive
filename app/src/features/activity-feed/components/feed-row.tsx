import type { FeedItem } from '@/types/feed';
import type { Tone } from '@/types/notification';

import { Icon } from '@components/ui/icon';

const TONE_TEXT: Record<Tone, string> = {
  amber: 'text-amber',
  green: 'text-green',
  brand: 'text-brand',
  red: 'text-red',
};

interface FeedRowProps {
  item: FeedItem;
}

/**
 * One line of what the orchestrator did.
 *
 * Deliberately not a button. Every other card in this rail navigates somewhere,
 * and the temptation is to make these do the same — but a feed entry is a
 * record of something that already happened, and half of them (a PR poll, a
 * Slack answer) have nowhere to go. A row that navigates only sometimes is
 * worse than one that never does.
 */
export function FeedRow({ item }: FeedRowProps) {
  return (
    <div className="flex items-start gap-2.5">
      <span className="flex size-[22px] shrink-0 items-center justify-center rounded-full bg-chip">
        <Icon name={item.icon} size={12} className={TONE_TEXT[item.tone]} />
      </span>

      <span className="flex min-w-0 flex-1 flex-col">
        <span className="font-mono text-[10px] text-subtle">{item.time}</span>
        <span className="text-[12.5px] leading-[1.45] text-muted">
          {item.txt}
        </span>
      </span>
    </div>
  );
}
