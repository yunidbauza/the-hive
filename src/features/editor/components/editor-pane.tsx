import { useCallback, useEffect, useMemo } from 'react';

import { useSwarmPhrase } from '@/hooks/use-swarm-phrase';

import { EditorSurface } from '@components/editor/editor-surface';
import { Icon } from '@components/ui/icon';
import { SwarmCreature } from '@components/ui/swarm-creature';
import {
  EditorNotice,
  NoticeAction,
} from '@features/editor/components/editor-notice';
import { languageFor } from '@lib/explorer/language';
import { useEditorAppearance, useEditorLayout } from '@stores/appearance-store';
import { useActiveFile, useEditorActions } from '@stores/editor-store';
import { usePickerState, useSettingsOpen } from '@stores/ui-store';

/**
 * The document half of the stage: notices, then the editor.
 *
 * Everything that decides *what* is on screen is here; everything that decides
 * *where* is in `center-stage.tsx`. That split is why this component works
 * identically in full-stage and split placement and knows about neither.
 *
 * `MAX_BYTES` is not repeated here — the refusal arrives from main already
 * decided, and re-deriving "is this too large" in the renderer would be a
 * second threshold to keep in step with the first.
 */

/**
 * Decimal, not binary.
 *
 * `MAX_FILE_BYTES` is 1,000,000 — a round decimal number — so a 1024-based
 * formatter would render the cap itself as "977 KB" and make the refusal read
 * as though the limit were somewhere else entirely.
 */
const BYTES_PER_KB = 1000;

/** A size a person can read. Not `Intl` — this is two digits and a suffix. */
function humanSize(bytes: number): string {
  if (bytes < BYTES_PER_KB) return `${bytes} B`;
  if (bytes < BYTES_PER_KB * BYTES_PER_KB) {
    return `${Math.round(bytes / BYTES_PER_KB)} KB`;
  }
  return `${(bytes / BYTES_PER_KB / BYTES_PER_KB).toFixed(1)} MB`;
}

/** A quiet full-pane message — the refusals, the errors, the empty case. */
function PaneMessage({ icon, children }: { icon: string; children: string }) {
  return (
    <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-2 px-6 text-center">
      <Icon name={icon} size={20} className="text-subtle" />
      <p className="text-[12px] text-subtle">{children}</p>
    </div>
  );
}

export function EditorPane() {
  const file = useActiveFile();
  const appearance = useEditorAppearance();
  const { nav } = useEditorLayout();
  const { edit, save, reload, closeFile } = useEditorActions();
  const emptyPhrase = useSwarmPhrase('empty.editor');
  const readingPhrase = useSwarmPhrase('loading.file');
  /** Escape belongs to whichever overlay is up, not to this pane. */
  const settingsOpen = useSettingsOpen();
  const { picker } = usePickerState();
  const overlayOpen = settingsOpen || picker;

  const fileName = file?.name;

  /**
   * The loader is memoised on the *filename*, not on the file key.
   *
   * `EditorSurface` re-runs its language effect whenever this identity changes,
   * so a new function per render would re-import the grammar on every
   * keystroke. Two files with the same name in different directories share a
   * loader, which is correct — they are the same language.
   */
  const languageLoad = useMemo(() => {
    if (fileName === undefined) return null;
    return languageFor(fileName)?.load ?? null;
  }, [fileName]);

  const key = file?.key ?? null;

  const onChange = useCallback(
    (text: string) => {
      if (key) edit(key, text);
    },
    [key, edit],
  );

  const onSave = useCallback(() => {
    if (key && appearance.editable) void save(key);
  }, [key, appearance.editable, save]);

  /**
   * Escape closes the file in single-file mode.
   *
   * Only in `single`: with a tab strip there is a visible × per tab and a
   * Terminal entry, and a global Escape that closed the focused tab would fire
   * while the user was dismissing something else entirely. In single-file mode
   * Escape is the *only* keyboard way out, which is what earns it a window
   * listener.
   *
   * `keydown` on `window` rather than on the pane, because CodeMirror owns
   * focus inside its own DOM and a React `onKeyDown` on the wrapper never sees
   * the event once the document has it.
   */
  useEffect(() => {
    if (nav !== 'single' || !key) return;

    /**
     * Two things this must not steal Escape from, both found in review:
     *
     * - **An open overlay.** The pane stays mounted inside the merely-`hidden`
     *   stage while the picker or settings is up, and Radix listens for Escape
     *   on the document in the capture phase — so one press would dismiss the
     *   dialog *and* close the file, discarding unsaved edits.
     * - **A text field.** Escape in the message row or the console is a
     *   gesture about that input, not a request to close a file the user may
     *   not even be looking at in `split`.
     */
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      if (overlayOpen) return;

      const target = event.target;
      if (
        target instanceof HTMLElement &&
        (target.isContentEditable ||
          target instanceof HTMLInputElement ||
          target instanceof HTMLTextAreaElement)
      ) {
        return;
      }

      closeFile(key);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [nav, key, overlayOpen, closeFile]);

  /**
   * The pane is mounted but has no file to show.
   *
   * Reachable only while `activeKey` names a file that is no longer in
   * `openFiles` — `center-stage` unmounts this whole subtree the moment
   * `activeKey` goes null, deliberately, so the terminal gets every pixel back.
   * So this is the inconsistent-for-one-frame case, not "the user closed
   * everything", and it renders a held creature instead of the blank pane it
   * used to.
   *
   * Making this state routinely visible would mean keeping the editor mounted
   * with nothing in it, which is exactly the trade `center-stage` argues
   * against. That is a product decision, not a copy one, and it is not this
   * change's to make.
   */
  if (!file) {
    return (
      <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-2 bg-panel-2 px-6 text-center">
        <SwarmCreature creature="spire" size={96} />
        <p className="text-[12px] text-muted">{emptyPhrase}</p>
        <p className="text-[12px] text-subtle">
          Open a file from the explorer to edit it here.
        </p>
      </div>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col bg-panel-2">
      {/*
        Single-file mode has no tab strip, so the filename and the way out live
        here instead. In `tabs` mode both are in the strip and this row would be
        a second copy of them.
      */}
      {nav === 'single' ? (
        <div className="flex shrink-0 items-center gap-2 border-b border-border-soft bg-panel px-3 py-1.5">
          <span className="flex-1 truncate font-mono text-[11.5px] text-muted">
            {file.relPath}
          </span>
          {file.dirty ? (
            <span className="size-1.5 shrink-0 rounded-full bg-amber">
              <span className="sr-only">unsaved changes</span>
            </span>
          ) : null}
          <button
            type="button"
            onClick={() => closeFile(file.key)}
            className="rounded p-0.5 text-subtle hover:bg-active hover:text-ink"
          >
            <Icon name="ph-x" size={12} />
            <span className="sr-only">Close {file.name}</span>
          </button>
        </div>
      ) : null}

      {file.missing ? (
        <EditorNotice tone="amber" icon="ph-warning">
          This file no longer exists on disk.
        </EditorNotice>
      ) : null}

      {/*
        Conflict and stale are separate notices because they arrive from
        opposite directions and offer opposite defaults. Stale is "the disk
        moved, you have not saved yet" — Reload is the safe answer. Conflict is
        "you tried to save and were refused" — the user has already expressed an
        intent to write, so Overwrite is a legitimate second choice rather than
        a trap.
      */}
      {file.conflict ? (
        <EditorNotice
          tone="amber"
          icon="ph-warning"
          actions={
            <>
              <NoticeAction onClick={() => void reload(file.key)}>
                Reload
              </NoticeAction>
              <NoticeAction
                onClick={() => void save(file.key, { overwrite: true })}
              >
                Overwrite
              </NoticeAction>
            </>
          }
        >
          Changed on disk since you opened it — nothing was written.
        </EditorNotice>
      ) : null}

      {file.staleOnDisk && !file.conflict ? (
        <EditorNotice
          tone="amber"
          icon="ph-arrows-clockwise"
          actions={
            <NoticeAction onClick={() => void reload(file.key)}>
              Reload
            </NoticeAction>
          }
        >
          Changed on disk. Your unsaved edits are still here.
        </EditorNotice>
      ) : null}

      {file.error && !file.missing ? (
        <EditorNotice tone="amber" icon="ph-warning">
          {file.error}
        </EditorNotice>
      ) : null}

      {file.refusal === 'too-large' ? (
        <PaneMessage icon="ph-file">
          {`Preview not available — ${humanSize(file.size)}, larger than the editor will open.`}
        </PaneMessage>
      ) : null}

      {file.refusal === 'binary' ? (
        <PaneMessage icon="ph-file">
          Preview not available — this file is binary.
        </PaneMessage>
      ) : null}

      {file.refusal === null && file.text === null && file.loading ? (
        <PaneMessage icon="ph-file">{readingPhrase}</PaneMessage>
      ) : null}

      {file.refusal === null && file.text !== null ? (
        <EditorSurface
          fileKey={file.key}
          value={file.text}
          languageLoad={languageLoad}
          readOnly={!appearance.editable}
          fontFamily={appearance.fontFamily}
          fontSize={appearance.fontSize}
          wordWrap={appearance.wordWrap}
          lineNumbers={appearance.lineNumbers}
          tabWidth={appearance.tabWidth}
          onChange={onChange}
          onSave={onSave}
        />
      ) : null}
    </div>
  );
}
