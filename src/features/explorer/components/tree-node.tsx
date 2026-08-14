import { useSwarmPhrase } from '@/hooks/use-swarm-phrase';
import { cn } from '@/lib/utils';

import { Icon } from '@components/ui/icon';
import { useDirectory } from '@features/explorer/hooks/use-directory';
import { fileIconName, folderIconName } from '@lib/explorer/file-icon';
import { childPath } from '@lib/explorer/fs-client';
import type { DirEntry } from '@shared/fs-contract';
import { useActiveFileKey, fileKey } from '@stores/editor-store';
import { useExplorerExpanded, useToggleExplorerDir } from '@stores/ui-store';

interface TreeNodeProps {
  projectId: string;
  entry: DirEntry;
  /** The **parent's** relative path. This node's is `parent + name`. */
  parentPath: string;
  depth: number;
  refreshToken: number;
  onOpenFile: (relPath: string) => void;
}

/**
 * One row in the explorer, and — for a directory — its children.
 *
 * The whole row is a `<button>`, like `ProjectRow`, so the tree is reachable by
 * keyboard and `aria-expanded` tells assistive tech which way a directory is
 * pointing. Files get `aria-current` when they are the one on screen, which is
 * the same question the highlight answers visually.
 *
 * Indentation is padding on the button rather than a nested container with a
 * margin: the hover and selection backgrounds have to run the full width of the
 * rail, and a nested box would inset them by one level per depth — the classic
 * tree bug where the highlight on a deep file is a short stub.
 *
 * ## Why the row is not a `role="treeitem"`
 *
 * A real ARIA tree needs roving tabindex, typeahead, and arrow-key navigation
 * across the whole widget to be *correct*; a half-built one announces
 * capabilities that are not there, which is worse for a screen-reader user than
 * a plain list of buttons that all work. This is a list of buttons that all
 * work. Full tree semantics are a deliberate follow-up, not an oversight.
 */
export function TreeNode({
  projectId,
  entry,
  parentPath,
  depth,
  refreshToken,
  onOpenFile,
}: TreeNodeProps) {
  const relPath = childPath(parentPath, entry.name);
  const expanded = useExplorerExpanded(projectId, relPath);
  const toggle = useToggleExplorerDir();
  const activeKey = useActiveFileKey();

  const isDir = entry.kind === 'dir';
  const isActive = !isDir && activeKey === fileKey(projectId, relPath);

  const children = useDirectory(projectId, relPath, isDir && expanded, refreshToken);
  /**
   * Per node, so two folders opening at once do not read as a chorus. It holds
   * for the life of the row, which outlives the read it labels.
   */
  const readingPhrase = useSwarmPhrase('loading.directory');

  return (
    <>
      <button
        type="button"
        onClick={() => (isDir ? toggle(projectId, relPath) : onOpenFile(relPath))}
        {...(isDir ? { 'aria-expanded': expanded } : {})}
        {...(isActive ? { 'aria-current': 'true' as const } : {})}
        title={relPath}
        style={{ paddingLeft: `${8 + depth * 12}px` }}
        className={cn(
          'flex w-full items-center gap-1.5 rounded-md py-[3px] pr-2 text-left hover:bg-hover',
          isActive && 'bg-active',
        )}
      >
        {/*
          The caret slot is present on files too, as an empty box of the same
          width. Without it every file name sits 11px left of its sibling
          directories and the tree loses its vertical rhythm at each level.
        */}
        {isDir ? (
          <Icon
            name={expanded ? 'ph-caret-down' : 'ph-caret-right'}
            size={11}
            className="shrink-0 text-subtle"
          />
        ) : (
          <span className="w-[11px] shrink-0" />
        )}

        <Icon
          name={isDir ? folderIconName(expanded) : fileIconName(entry.name)}
          size={14}
          className={cn('shrink-0', isActive ? 'text-brand' : 'text-subtle')}
        />

        <span
          className={cn(
            'truncate font-mono text-[12px]',
            isActive ? 'text-ink' : 'text-muted',
          )}
        >
          {entry.name}
        </span>
      </button>

      {isDir && expanded ? (
        <>
          {children.entries?.map((child) => (
            <TreeNode
              key={child.name}
              projectId={projectId}
              entry={child}
              parentPath={relPath}
              depth={depth + 1}
              refreshToken={refreshToken}
              onOpenFile={onOpenFile}
            />
          ))}

          {/*
            Three distinct quiet states, at the child indent so they read as
            belonging to the directory that produced them.

            "Empty folder" and "could not be read" are deliberately different
            sentences: one is a fact about the repository and the other is a
            fact about permissions, and a shared message would send the user
            looking for the wrong thing. The loading line only appears on a
            *first* read — a refresh keeps the previous listing on screen, so
            this is not a flicker on every watcher event.
          */}
          {children.error ? (
            <p
              style={{ paddingLeft: `${8 + (depth + 1) * 12 + 17}px` }}
              className="py-[3px] text-[11.5px] text-amber"
            >
              {children.error}
            </p>
          ) : null}

          {!children.error && children.entries?.length === 0 ? (
            <p
              style={{ paddingLeft: `${8 + (depth + 1) * 12 + 17}px` }}
              className="py-[3px] text-[11.5px] text-subtle"
            >
              Empty folder.
            </p>
          ) : null}

          {children.loading && children.entries === null ? (
            <p
              style={{ paddingLeft: `${8 + (depth + 1) * 12 + 17}px` }}
              className="py-[3px] text-[11.5px] text-subtle"
            >
              {readingPhrase}
            </p>
          ) : null}
        </>
      ) : null}
    </>
  );
}
