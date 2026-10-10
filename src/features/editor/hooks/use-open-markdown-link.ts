import { useCallback, useRef, useState } from 'react';

import { resolvePaths } from '@lib/explorer/fs-client';
import type { RelativeHref } from '@lib/markdown/href';
import { linkCandidate, linkSessionId } from '@lib/markdown/link-target';
import { useEditorLayout } from '@stores/appearance-store';
import { fileKey, useEditorActions, useEditorTabs } from '@stores/editor-store';

interface LinkSource {
  projectId: string;
  relPath: string;
  rootKey: string;
  sessionId?: string;
}

/**
 * Follow a relative link from a previewed file.
 *
 * Main decides whether the link names a file it would serve (`fs:resolve`);
 * the renderer never decides containment. A miss — including a resolve call
 * that failed outright — is named in the pane rather than ignored, because a
 * dead link that does nothing reads as a broken app.
 *
 * Following a link never costs an edit. One-at-a-time mode replaces the open
 * file, as the explorer does, **unless** something open is dirty — in split
 * view the unsaved source sits right beside the link — and a target that is
 * already open is only focused, never re-read. Answers can return out of
 * order, so only the latest click acts on its answer.
 */
export function useOpenMarkdownLink({ projectId, relPath, rootKey, sessionId }: LinkSource) {
  const { openFile, closeAll } = useEditorActions();
  const { nav } = useEditorLayout();
  const tabs = useEditorTabs();
  const [missing, setMissing] = useState<string | null>(null);
  const latest = useRef(0);

  const open = useCallback(
    async (link: RelativeHref): Promise<void> => {
      const request = ++latest.current;
      const candidate = linkCandidate({ relPath, rootKey }, link);
      const [hit] = await resolvePaths(projectId, linkSessionId({ rootKey, sessionId }), [
        candidate,
      ]).catch(() => [null]);
      if (request !== latest.current) return;

      if (!hit) {
        setMissing(link.path);
        return;
      }
      setMissing(null);

      const alreadyOpen = tabs.some((tab) => tab.key === fileKey(projectId, hit.relPath, hit.rootKey));
      const anyDirty = tabs.some((tab) => tab.dirty);
      if (nav === 'single' && !alreadyOpen && !anyDirty) closeAll();
      // The session that named the root main checked: none for the project root.
      openFile(projectId, hit.relPath, linkSessionId({ rootKey: hit.rootKey, sessionId }), hit.rootKey);
    },
    [projectId, relPath, rootKey, sessionId, nav, tabs, openFile, closeAll],
  );

  const dismiss = useCallback(() => setMissing(null), []);

  return { open, missing, dismiss };
}
