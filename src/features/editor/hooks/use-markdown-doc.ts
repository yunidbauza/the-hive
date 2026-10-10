import { useEffect, useRef, useState } from 'react';

import type { MdDocument } from '@lib/markdown/model';
import { parseMarkdown } from '@lib/markdown/parse';

/** Long enough to skip a burst of keystrokes; short enough to read as live. */
export const PARSE_DEBOUNCE_MS = 150;

/**
 * The buffer's text as a document.
 *
 * The first parse runs at once so opening a file shows it rendered; later ones
 * wait out a burst of typing. The last good document stays on screen while a
 * parse is pending. Mount it per file (`key={file.key}`), so a new file never
 * starts from the previous one's document.
 */
export function useMarkdownDoc(text: string | null): { doc: MdDocument | null; failed: boolean } {
  const [state, setState] = useState<{ doc: MdDocument | null; failed: boolean }>({
    doc: null,
    failed: false,
  });
  /** Whether a parse has succeeded — a ref, so landing one does not re-run the effect. */
  const parsedRef = useRef(false);

  useEffect(() => {
    if (text === null) return;
    let cancelled = false;

    const timer = setTimeout(
      () => {
        parseMarkdown(text).then(
          (doc) => {
            if (cancelled) return;
            parsedRef.current = true;
            setState({ doc, failed: false });
          },
          () => {
            if (!cancelled) setState((previous) => ({ doc: previous.doc, failed: true }));
          },
        );
      },
      parsedRef.current ? PARSE_DEBOUNCE_MS : 0,
    );

    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [text]);

  return state;
}
