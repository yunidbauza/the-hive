import { SegmentedControl, type SegmentedOption } from '@components/ui/segmented-control';
import { useMarkdownView } from '@features/editor/hooks/use-markdown-view';
import type { MarkdownView } from '@stores/editor-store';

const VIEW_OPTIONS: readonly SegmentedOption<MarkdownView>[] = [
  { value: 'source', label: 'Source' },
  { value: 'preview', label: 'Preview' },
  { value: 'split', label: 'Split' },
];

/** Source · Preview · Split, for the active markdown file. Nothing otherwise. */
export function ViewToggle() {
  const markdown = useMarkdownView();
  if (!markdown) return null;

  return (
    <SegmentedControl
      label="Markdown view"
      options={VIEW_OPTIONS}
      value={markdown.view}
      onChange={markdown.setView}
      className="my-auto mr-2 ml-2 shrink-0"
    />
  );
}
