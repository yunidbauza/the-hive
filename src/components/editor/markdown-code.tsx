import { highlightCode } from '@lezer/highlight';
import { useEffect, useState, type ReactNode } from 'react';

import { codeClassHighlighter } from '@components/editor/editor-theme';
import { languageFor } from '@lib/explorer/language';

/** Fence names people write that are not file extensions. */
const FENCE_ALIASES: Record<string, string> = {
  typescript: 'ts',
  javascript: 'js',
  python: 'py',
  rust: 'rs',
  golang: 'go',
  shell: 'sh',
  console: 'sh',
};

interface MarkdownCodeProps {
  lang: string;
  text: string;
  /** The source line, when this is a top-level block (split-view sync). */
  line?: number;
}

/**
 * A fenced code block in the preview.
 *
 * The text renders at once as plain mono; the grammar arrives through the
 * editor's own lazy table and the highlighted version replaces it. Highlighted
 * nodes are kept against the exact `lang` + `text` they were made from, so a
 * stale result from before an edit is never shown over newer text.
 */
export function MarkdownCode({ lang, text, line }: MarkdownCodeProps) {
  const [highlighted, setHighlighted] = useState<{ source: string; nodes: ReactNode[] } | null>(
    null,
  );
  const source = `${lang}\u0000${text}`;

  useEffect(() => {
    const key = lang.toLowerCase();
    const def = key === '' ? null : languageFor(`fence.${FENCE_ALIASES[key] ?? key}`);
    if (!def) return;

    let cancelled = false;
    void def.load().then((support) => {
      if (cancelled) return;
      const nodes: ReactNode[] = [];
      highlightCode(
        text,
        support.language.parser.parse(text),
        codeClassHighlighter,
        (piece, classes) =>
          nodes.push(
            classes === '' ? (
              piece
            ) : (
              <span key={nodes.length} className={classes}>
                {piece}
              </span>
            ),
          ),
        () => nodes.push('\n'),
      );
      setHighlighted({ source: `${lang}\u0000${text}`, nodes });
    });

    return () => {
      cancelled = true;
    };
  }, [lang, text]);

  return (
    <pre
      data-line={line}
      className="relative mb-3.5 overflow-x-auto rounded-lg border border-border-soft bg-panel px-3.5 py-3 font-mono text-[0.86em] leading-[1.55] text-ink"
    >
      {lang === '' ? null : (
        <span className="absolute top-1.5 right-2.5 font-sans text-micro text-subtle select-none">
          {lang}
        </span>
      )}
      <code>{highlighted?.source === source ? highlighted.nodes : text}</code>
    </pre>
  );
}
