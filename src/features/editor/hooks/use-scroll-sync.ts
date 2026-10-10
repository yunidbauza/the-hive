import { useCallback, useRef, useState } from 'react';

/** How long the side that last moved owns the sync. */
export const SYNC_LATCH_MS = 100;

type Side = 'source' | 'preview';

interface Owner {
  side: Side;
  until: number;
}

/**
 * Whether `side` may drive the other one now. The owner's own scrolls extend
 * its window; the other side's scrolls inside it are echoes and are dropped.
 */
function claim(owner: { current: Owner | null }, side: Side): boolean {
  const now = Date.now();
  const current = owner.current;
  if (current && current.side !== side && now < current.until) return false;
  owner.current = { side, until: now + SYNC_LATCH_MS };
  return true;
}

/** Split view's scroll sync between the source surface and the preview. */
export function useScrollSync() {
  const [previewTopLine, setPreviewTopLine] = useState<number | null>(null);
  const [revealLine, setRevealLine] = useState<number | null>(null);
  const owner = useRef<Owner | null>(null);

  const onSourceTopLine = useCallback((line: number) => {
    if (claim(owner, 'source')) setPreviewTopLine(line);
  }, []);

  const onPreviewTopLine = useCallback((line: number) => {
    if (claim(owner, 'preview')) setRevealLine(line);
  }, []);

  const onRevealApplied = useCallback(() => setRevealLine(null), []);

  return { previewTopLine, revealLine, onSourceTopLine, onPreviewTopLine, onRevealApplied };
}
