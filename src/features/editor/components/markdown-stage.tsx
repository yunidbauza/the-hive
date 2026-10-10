import type { ReactNode } from 'react';

import { MarkdownPreview } from '@components/editor/markdown-preview';
import { EditorNotice, NoticeAction } from '@features/editor/components/editor-notice';
import { useMarkdownDoc } from '@features/editor/hooks/use-markdown-doc';
import { useOpenMarkdownLink } from '@features/editor/hooks/use-open-markdown-link';
import { useScrollSync } from '@features/editor/hooks/use-scroll-sync';
import { useEditorAppearance } from '@stores/appearance-store';

/** What split view hands the source surface so the two scroll together. */
export interface SourceSync {
  onTopLineChange: (line: number) => void;
  revealLine: number | null;
  onRevealApplied: () => void;
}

interface MarkdownStageProps {
  file: { projectId: string; relPath: string; rootKey: string; sessionId?: string; text: string };
  view: 'preview' | 'split';
  /**
   * The pane's own editor surface. A render prop so its configuration — font,
   * read-only, save — stays in one place, and split only adds the sync props.
   */
  renderSource: (sync: SourceSync | null) => ReactNode;
}

/**
 * A markdown file in Preview or Split. Mount it with `key={file.key}`, so the
 * parsed document, the sync and a link notice never carry over from another
 * file.
 */
export function MarkdownStage({ file, view, renderSource }: MarkdownStageProps) {
  const { doc, failed } = useMarkdownDoc(file.text);
  const { fontSize } = useEditorAppearance();
  const sync = useScrollSync();
  const link = useOpenMarkdownLink(file);

  if (failed) {
    return (
      <>
        <EditorNotice tone="amber" icon="ph-warning">
          Preview unavailable — showing source.
        </EditorNotice>
        {renderSource(null)}
      </>
    );
  }

  const split = view === 'split';
  const preview = (
    <MarkdownPreview
      doc={doc}
      fontSize={fontSize}
      onOpenLink={(target) => void link.open(target)}
      topLine={split ? sync.previewTopLine : null}
      onTopLineChange={split ? sync.onPreviewTopLine : undefined}
    />
  );

  return (
    <>
      {link.missing === null ? null : (
        <EditorNotice
          tone="amber"
          icon="ph-warning"
          actions={<NoticeAction onClick={link.dismiss}>Dismiss</NoticeAction>}
        >
          {`Not found in this project: ${link.missing}`}
        </EditorNotice>
      )}
      {split ? (
        <div className="grid min-h-0 flex-1 grid-cols-2">
          <div className="flex min-h-0 min-w-0 flex-col border-r border-border-soft">
            {renderSource({
              onTopLineChange: sync.onSourceTopLine,
              revealLine: sync.revealLine,
              onRevealApplied: sync.onRevealApplied,
            })}
          </div>
          <div className="flex min-h-0 min-w-0 flex-col">{preview}</div>
        </div>
      ) : (
        preview
      )}
    </>
  );
}
