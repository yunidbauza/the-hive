import { useMemo } from 'react';
import { create } from 'zustand';
import { useShallow } from 'zustand/react/shallow';

import { baseName, readFile, writeFile } from '@lib/explorer/fs-client';

/**
 * Open file buffers — the fourth store.
 *
 * ## Why a fourth store, and not a slice of one of the three
 *
 * `AGENTS.md` names three, so this is a deviation and it is a decision rather
 * than a drift. A buffer is none of the three things they hold:
 *
 * - **Not domain state.** `hive-store` holds what the system knows about
 *   sessions, tickets and PRs — things with lifetimes measured in days. A
 *   buffer is scratch, and folding it in would grow the largest module in the
 *   app to carry data nothing else in it reads.
 * - **Not view state.** `ui-store` is deliberately never persisted and
 *   deliberately cheap. The text of a 900KB file is neither.
 * - **Not a preference.** `appearance-store` persists everything it holds, and
 *   persisting file contents to `localStorage` would be a bug rather than a
 *   feature.
 *
 * The rule that keeps the boundary legible is unchanged: everything in
 * `appearance-store` is persisted, nothing anywhere else is. This store joins
 * `hive-store` and `ui-store` on the un-persisted side — open files do not
 * survive a launch, which is deliberate: restoring a buffer whose file has
 * since been rewritten by an agent would show the user something that is no
 * longer true.
 *
 * ## What is *not* here
 *
 * Which file is open is here; **where it renders is not** — that is
 * `appearance-store`'s `editorPlacement`. And the tree's expansion state is
 * `ui-store`'s, because it is a fact about a panel rather than about a file.
 */

/**
 * Why a file is not showing its contents.
 *
 * `refusal` is main's verdict — too large, or binary — and reads as a decline
 * rather than a failure. `missing` is the file having been deleted underneath
 * an open buffer, which is a state a tab stays in rather than an error that
 * dismisses it: the user opened that file and should be told it went away, not
 * have the tab vanish.
 */
export type BufferRefusal = 'binary' | 'too-large';

export interface OpenFile {
  /** `${projectId}:${relPath}` — unique across projects, stable across renames of neither. */
  key: string;
  projectId: string;
  relPath: string;
  /** The last segment, for the tab strip. Derived once rather than on every render. */
  name: string;

  /** `null` until the first read resolves. */
  text: string | null;
  /** What the last read or write saw. `0` before the first read lands. */
  mtimeMs: number;
  /**
   * Bytes on disk, as of the last read.
   *
   * Carried even when the read was **refused**, which is the case it exists
   * for: "Preview not available" without a number is a shrug, and the size is
   * the one fact that tells the user whether they hit the cap by a little or by
   * a lot.
   */
  size: number;

  loading: boolean;
  dirty: boolean;
  /** Changed on disk underneath a **dirty** buffer. A clean one is reloaded instead. */
  staleOnDisk: boolean;
  missing: boolean;
  refusal: BufferRefusal | null;
  /** A real failure — `EACCES`, and anything else the filesystem said no to. */
  error: string | null;
  /** Set by a refused save. Cleared by reloading or by overwriting. */
  conflict: boolean;
  saving: boolean;
  /**
   * The mtime this app's own last write produced, or `null`.
   *
   * Consumed by the first watcher event that names this file, so the app does
   * not report its own save back to the user as somebody else's change. See
   * `reconcile`.
   */
  selfWriteMtimeMs: number | null;
}

interface EditorState {
  openFiles: OpenFile[];
  /** The file on screen, or `null` when the terminal is. */
  activeKey: string | null;

  openFile: (projectId: string, relPath: string) => void;
  closeFile: (key: string) => void;
  closeAll: () => void;
  /** Show the terminal without closing anything. */
  showTerminal: () => void;
  setActive: (key: string) => void;
  edit: (key: string, text: string) => void;
  /** Re-read from disk, discarding local edits. */
  reload: (key: string) => Promise<void>;
  save: (key: string, options?: { overwrite?: boolean }) => Promise<void>;
  /** A watcher event named these paths in this project. */
  reconcile: (projectId: string, paths: readonly string[]) => void;
  reset: () => void;
}

export const fileKey = (projectId: string, relPath: string): string =>
  `${projectId}:${relPath}`;

const blank = (projectId: string, relPath: string): OpenFile => ({
  key: fileKey(projectId, relPath),
  projectId,
  relPath,
  name: baseName(relPath),
  text: null,
  mtimeMs: 0,
  size: 0,
  loading: true,
  dirty: false,
  staleOnDisk: false,
  missing: false,
  refusal: null,
  error: null,
  conflict: false,
  saving: false,
  selfWriteMtimeMs: null,
});

const initialEditorState = {
  openFiles: [] as OpenFile[],
  activeKey: null as string | null,
};

export const useEditorStore = create<EditorState>()((set, get) => {
  /**
   * Patch one file in place, or do nothing if it has since been closed.
   *
   * Every async continuation goes through this. A read that resolves after its
   * tab was closed is the ordinary case — the user clicked twice — and it must
   * not resurrect the entry, which is exactly what a naive `[...openFiles,
   * updated]` would do.
   */
  const patch = (key: string, changes: Partial<OpenFile>): void => {
    set((state) => ({
      openFiles: state.openFiles.map((file) =>
        file.key === key ? { ...file, ...changes } : file,
      ),
    }));
  };

  const load = async (projectId: string, relPath: string): Promise<void> => {
    const key = fileKey(projectId, relPath);
    const result = await readFile(projectId, relPath);

    if (!get().openFiles.some((file) => file.key === key)) return;

    if (!result.ok) {
      patch(key, {
        loading: false,
        error: result.error.message,
        missing: result.error.code === 'ENOENT',
      });
      return;
    }

    if ('refused' in result.value) {
      patch(key, {
        loading: false,
        refusal: result.value.refused,
        size: result.value.size,
      });
      return;
    }

    patch(key, {
      loading: false,
      text: result.value.text,
      mtimeMs: result.value.mtimeMs,
      size: result.value.size,
      dirty: false,
      staleOnDisk: false,
      missing: false,
      refusal: null,
      error: null,
      conflict: false,
      // A fresh read supersedes any pending self-write suppression: whatever is
      // on screen now came from the disk, so the next event is genuinely new.
      selfWriteMtimeMs: null,
    });
  };

  return {
    ...initialEditorState,

    /**
     * Open a file, or focus it if it is already open.
     *
     * Re-opening never re-reads. The watcher keeps open buffers current, so a
     * second click on a tab that is already there would throw away the user's
     * scroll position to fetch bytes it already has — and, if the buffer were
     * dirty, their edits.
     */
    openFile: (projectId, relPath) => {
      const key = fileKey(projectId, relPath);
      const existing = get().openFiles.find((file) => file.key === key);

      if (existing) {
        set({ activeKey: key });
        return;
      }

      set((state) => ({
        /**
         * `single` nav is not consulted here.
         *
         * This store does not read `appearance-store` — no store subscribes to
         * another (`AGENTS.md`). The single-file behaviour is the *caller's*:
         * the explorer closes the previous file before opening the next when
         * the setting says so, which keeps the policy where the setting is read
         * and this store a plain list.
         */
        openFiles: [...state.openFiles, blank(projectId, relPath)],
        activeKey: key,
      }));

      void load(projectId, relPath);
    },

    closeFile: (key) => {
      set((state) => {
        const index = state.openFiles.findIndex((file) => file.key === key);
        if (index === -1) return state;

        const openFiles = state.openFiles.filter((file) => file.key !== key);

        /**
         * Closing the active tab lands on its neighbour, not on the terminal.
         *
         * The one to the right, falling back to the one to the left — the
         * behaviour of every editor, and the reason is the same: the user was
         * working in this region and closing one file is not a request to leave
         * it. Closing the *last* file does return to the terminal, because
         * there is nowhere else to be.
         */
        if (state.activeKey !== key) return { ...state, openFiles };

        const next = openFiles[index] ?? openFiles[index - 1] ?? null;
        return { ...state, openFiles, activeKey: next?.key ?? null };
      });
    },

    closeAll: () => set({ openFiles: [], activeKey: null }),

    showTerminal: () => set({ activeKey: null }),

    setActive: (key) => set({ activeKey: key }),

    /**
     * A keystroke in the editor.
     *
     * Marks dirty only when the text actually differs from what is held.
     * CodeMirror fires an update for a great many things that are not edits —
     * a selection change, a reconfiguration — and treating any of them as a
     * modification would put a dirty dot on a file nobody typed into.
     */
    edit: (key, text) => {
      const file = get().openFiles.find((entry) => entry.key === key);
      if (!file || file.text === text) return;
      patch(key, { text, dirty: true });
    },

    reload: async (key) => {
      const file = get().openFiles.find((entry) => entry.key === key);
      if (!file) return;
      patch(key, { loading: true, conflict: false, staleOnDisk: false });
      await load(file.projectId, file.relPath);
    },

    /**
     * Write the buffer, unless the file moved on.
     *
     * `overwrite` re-reads the current mtime and writes against *that*, which
     * is what makes overwriting an explicit second act rather than a retry of
     * the first. Without the re-read the second attempt would carry the same
     * stale base and be refused again, and the button would look broken.
     */
    save: async (key, options) => {
      const file = get().openFiles.find((entry) => entry.key === key);
      if (!file || file.text === null || file.saving) return;

      patch(key, { saving: true });

      let base = file.mtimeMs;
      if (options?.overwrite) {
        const current = await readFile(file.projectId, file.relPath);
        if (current.ok && !('refused' in current.value)) {
          base = current.value.mtimeMs;
        }
      }

      /**
       * What was actually sent, captured before the await.
       *
       * `file` is a snapshot taken at entry, and a save is a round trip through
       * IPC — the user can type during it. Marking the buffer clean on success
       * regardless would claim the disk holds text it does not, and the
       * watcher's echo would then find a "clean" buffer and reload over those
       * keystrokes. Silently.
       */
      const sentText = file.text;

      const result = await writeFile(
        file.projectId,
        file.relPath,
        sentText,
        base,
      );

      const settled = get().openFiles.find((entry) => entry.key === key);
      if (!settled) return;

      if (result.ok) {
        patch(key, {
          saving: false,
          // Clean only if nothing was typed while the write was in flight.
          dirty: settled.text !== sentText,
          conflict: false,
          staleOnDisk: false,
          mtimeMs: result.mtimeMs,
          /**
           * The mtime this app just produced.
           *
           * The watcher reports our own write ~300ms later — it is a *trailing*
           * debounce, so `saving` has always gone false again by then and
           * cannot suppress it. Recording the mtime lets `reconcile` recognise
           * the echo as ours and ignore it once, rather than telling the user
           * an agent changed a file that only they wrote.
           */
          selfWriteMtimeMs: result.mtimeMs,
          error: null,
        });
        return;
      }

      if (result.conflict) {
        patch(key, { saving: false, conflict: true, mtimeMs: file.mtimeMs });
        return;
      }

      patch(key, { saving: false, error: result.error.message });
    },

    /**
     * A watcher event. The freshness rule, in one place.
     *
     * | Buffer | Behaviour |
     * | --- | --- |
     * | clean | **silently reloaded** |
     * | dirty | marked `staleOnDisk`; the banner offers Reload or Keep mine |
     *
     * Silent reload of a clean buffer is the point of the feature: you open a
     * file to watch what a session does to it, and a confirmation prompt
     * between you and that is friction carrying no information. A dirty buffer
     * is the one case where the app holds something the disk does not, and that
     * is the only case worth interrupting for.
     *
     * ## The app's own writes
     *
     * A save writes the file, which the watcher then reports. `saving` cannot
     * suppress that echo — the watcher is a **trailing** 300ms debounce, so the
     * event always arrives after the write has settled and the flag has gone
     * false. `selfWriteMtimeMs` is what actually does it: a save records the
     * mtime it produced, and the first event afterwards consumes it.
     *
     * The suppression is **one-shot and deliberately narrow**. If an agent
     * happens to write inside that same debounce window, its change is folded
     * into the same event and swallowed with ours — a real, bounded cost. What
     * catches it: the next event reconciles normally, and the mtime check on
     * the following save refuses rather than overwriting. Skipping the
     * suppression instead would put a "changed on disk" banner in front of the
     * user after every single save they make, which is wrong far more often.
     */
    reconcile: (projectId, paths) => {
      const touched = new Set(paths);

      for (const file of get().openFiles) {
        if (file.projectId !== projectId) continue;
        if (!touched.has(file.relPath)) continue;
        if (file.loading || file.saving) continue;

        if (file.selfWriteMtimeMs !== null) {
          patch(file.key, { selfWriteMtimeMs: null });
          continue;
        }

        if (file.dirty) {
          patch(file.key, { staleOnDisk: true });
          continue;
        }

        void get().reload(file.key);
      }
    },

    reset: () => set(initialEditorState),
  };
});

/**
 * Selector hooks — the same rule as the other three stores.
 *
 * Components never read the store object directly and never call `getState()`.
 */
const editorActionsSelector = (state: EditorState) => ({
  openFile: state.openFile,
  closeFile: state.closeFile,
  closeAll: state.closeAll,
  showTerminal: state.showTerminal,
  setActive: state.setActive,
  edit: state.edit,
  reload: state.reload,
  save: state.save,
});

/**
 * The tab strip's data — key, name and dirty, and nothing else.
 *
 * Deliberately not the whole `OpenFile`: the strip re-renders on every
 * keystroke otherwise, because `text` changes on every keystroke.
 */
export interface EditorTab {
  key: string;
  name: string;
  relPath: string;
  dirty: boolean;
}

/**
 * Encoded as strings, then parsed back — not selected as objects.
 *
 * `useShallow` compares the selected value one level deep. A selector returning
 * an array of freshly-built objects therefore compares *unequal every time*,
 * because each element is a new reference: the hook re-renders, re-selects,
 * builds new objects again, and React tears the component down with "Maximum
 * update depth exceeded". Selecting an array of strings gives `useShallow`
 * something it can actually compare, so the strip re-renders when a tab is
 * opened, closed, renamed or dirtied — and not on every keystroke inside one.
 *
 * NUL as the separator, because a filename may legitimately contain anything
 * else — spaces very much included. `assertRelPath` rejects control characters,
 * which makes this the one byte guaranteed absent from every field joined here.
 */
const TAB_FIELD_SEPARATOR = '\u0000';

const tabFieldsSelector = (state: EditorState): string[] =>
  state.openFiles.map((file) =>
    [file.key, file.name, file.relPath, file.dirty ? '1' : '0'].join(
      TAB_FIELD_SEPARATOR,
    ),
  );

export const useEditorTabs = (): EditorTab[] => {
  const encoded = useEditorStore(useShallow(tabFieldsSelector));

  return useMemo(
    () =>
      encoded.map((entry) => {
        const [key, name, relPath, dirty] = entry.split(TAB_FIELD_SEPARATOR);
        return { key, name, relPath, dirty: dirty === '1' };
      }),
    [encoded],
  );
};

/** Which file is on screen, or `null` for the terminal. */
export const useActiveFileKey = () => useEditorStore((state) => state.activeKey);

/** The active file itself, or `null`. The editor pane's one subscription. */
export const useActiveFile = (): OpenFile | null =>
  useEditorStore(
    (state) =>
      state.openFiles.find((file) => file.key === state.activeKey) ?? null,
  );

/** Whether anything is open — the stage asks this to decide on the tab strip. */
export const useHasOpenFiles = () =>
  useEditorStore((state) => state.openFiles.length > 0);

export const useEditorActions = () =>
  useEditorStore(useShallow(editorActionsSelector));

/**
 * The watcher's entry point into this store.
 *
 * A plain action hook, never `getState()`: the subscription lives in a
 * component effect (`useProjectWatcher`) like every other subscription in this
 * app, and selecting a stable action does not re-render on buffer changes.
 */
export const useReconcileFiles = () => useEditorStore((state) => state.reconcile);
