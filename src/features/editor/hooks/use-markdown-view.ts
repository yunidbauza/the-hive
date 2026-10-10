import { useCallback } from 'react';

import { useMarkdownOpensIn } from '@stores/appearance-store';
import {
  useActiveMarkdownFile,
  useEditorActions,
  type MarkdownView,
} from '@stores/editor-store';

interface ActiveMarkdownView {
  key: string;
  view: MarkdownView;
  setView: (view: MarkdownView) => void;
}

/**
 * The active file's markdown view, or `null` when it has no preview.
 *
 * Derived here, never stored: the file's own choice wins, the setting fills in
 * otherwise. A changed setting therefore moves every file nobody chose for.
 */
export function useMarkdownView(): ActiveMarkdownView | null {
  const active = useActiveMarkdownFile();
  const opensIn = useMarkdownOpensIn();
  const { setView } = useEditorActions();
  const key = active?.key ?? null;

  const choose = useCallback(
    (view: MarkdownView) => {
      if (key !== null) setView(key, view);
    },
    [key, setView],
  );

  if (active === null) return null;
  return { key: active.key, view: active.chosen ?? opensIn, setView: choose };
}
