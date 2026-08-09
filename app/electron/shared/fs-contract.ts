/**
 * The project-filesystem contract — the project explorer and the editor.
 *
 * This is the first surface in the app that reads the user's source tree, and
 * the shape of these types is most of its security design. Two properties carry
 * it, and both are structural rather than procedural:
 *
 * 1. **No verb takes a path.** Every request names a `projectId` and a
 *    *project-relative* path. Main looks the project up in the config it wrote
 *    and validated itself, joins, resolves, and confirms containment. A renderer
 *    that wants `/etc/passwd` has nothing to put it in.
 * 2. **Nothing here is a capability grant.** `fs:write-file` exists whether or
 *    not the editor is in editable mode, because the mode lives in
 *    `localStorage` — which is writable by exactly the thing being defended
 *    against. The preference gates the UI; containment gates the disk.
 *
 * Lives in `electron/shared/` for the reason `ipc-contract.ts` does: main
 * enforces it, the renderer renders its verdicts, and both must agree at
 * compile time. Types and constants only — no Node APIs, no DOM APIs.
 */

/** What a directory entry is. Symlinks report the kind of their **target**. */
export type FsEntryKind = 'dir' | 'file';

/**
 * One entry in a directory listing.
 *
 * **Carries no path.** The renderer composes paths from the tree it already
 * holds, so a path in the reply would be a second answer to a question that
 * already had one — and the two can disagree. `size` is bytes for a file and
 * `0` for a directory; it exists so the editor can refuse a 40 MB file with a
 * number in the message rather than a shrug.
 */
export interface DirEntry {
  name: string;
  kind: FsEntryKind;
  size: number;
}

/** A file the editor is willing to open. */
export interface FileContent {
  text: string;
  /**
   * The mtime this read saw, in epoch milliseconds.
   *
   * The editor sends it back on save as `baseMtimeMs`, and main refuses the
   * write if the file has moved on. Optimistic concurrency rather than a lock,
   * because the other writer is an agent in a subprocess that will never take
   * one.
   */
  mtimeMs: number;
  size: number;
}

/**
 * Why the editor declined to show a file it could perfectly well have read.
 *
 * A refusal is **not** an error, and the distinction is user-visible: an error
 * means something went wrong, a refusal means the app looked and decided there
 * was nothing worth rendering. Showing 40 MB of minified bundle, or the bytes of
 * a PNG as replacement characters, is worse than saying so.
 */
export type FsRefusalReason = 'binary' | 'too-large';

export interface FsRefusal {
  refused: FsRefusalReason;
  size: number;
}

/**
 * Something actually failed.
 *
 * `code` is the platform's (`ENOENT`, `EACCES`, `EISDIR`, …) when there is one,
 * and a name of this contract's own otherwise — `EPROJECT` for an id the config
 * does not know, `EOUTSIDE` for a path that resolved out of its root. Those two
 * are the interesting ones: they are what a traversal attempt looks like from
 * the renderer's side, and they are deliberately indistinguishable from a
 * typo, because the renderer has no business learning which it was.
 */
export interface FsFailure {
  code: string;
  message: string;
}

/**
 * Every fs verb answers with this rather than throwing across IPC.
 *
 * Same rule the Jira verbs follow: the panel must render either way. A tree
 * that throws because one directory is unreadable tells the user the app is
 * broken, when the truth is that one directory is unreadable.
 */
export type FsResult<T> = { ok: true; value: T } | { ok: false; error: FsFailure };

/** `fs:read-dir`. `relPath` is `''` for the project root. */
export interface ReadDirRequest {
  projectId: string;
  relPath: string;
}

/** `fs:read-file`. */
export interface ReadFileRequest {
  projectId: string;
  relPath: string;
}

/** `fs:write-file`. */
export interface WriteFileRequest {
  projectId: string;
  relPath: string;
  text: string;
  /**
   * The mtime the buffer was last read or written at.
   *
   * Not optional, and not defaultable to "whatever is there now": a write with
   * no base is a write that cannot detect a conflict, and the one case this
   * check exists for is an agent rewriting the file underneath the editor.
   */
  baseMtimeMs: number;
}

/** What `fs:write-file` answers with. */
export type WriteFileResult =
  | { ok: true; mtimeMs: number }
  /**
   * The file changed since `baseMtimeMs`. **Nothing was written.** The renderer
   * offers Reload or Overwrite; Overwrite is a second call carrying the fresh
   * mtime, so "overwrite" is still an explicit act rather than a retry.
   */
  | { ok: false; conflict: true; mtimeMs: number }
  | { ok: false; conflict?: false; error: FsFailure };

/** `fs:watch`. One watcher exists at a time; this replaces it. */
export interface WatchRequest {
  projectId: string;
}

/**
 * `fs:changed` — main → renderer.
 *
 * Paths are project-relative and already filtered against {@link HIDDEN_ENTRIES}
 * **in main**, before they cross the bridge. A `pnpm install` would otherwise
 * push tens of thousands of `node_modules` paths across IPC to be discarded on
 * the other side.
 */
export interface FsChangedEvent {
  projectId: string;
  paths: string[];
}

/**
 * The largest file the editor will open, in bytes.
 *
 * 1 MB is well past any hand-written source file and well short of a lockfile
 * or a bundle. The number is here rather than in the renderer because main is
 * what enforces it — a cap the renderer applied after reading would have
 * already paid for the read.
 */
export const MAX_FILE_BYTES = 1_000_000;

/**
 * How much of a file is sniffed for a NUL byte before calling it binary.
 *
 * A heuristic, and a deliberately cheap one. It is the same test `git` uses and
 * it is wrong in the same places (UTF-16 source, which nobody writes). The cost
 * of being wrong is a "Preview not available" on a file that would have
 * rendered, which is recoverable; the cost of the alternative is painting a
 * megabyte of replacement characters.
 */
export const BINARY_SNIFF_BYTES = 8192;

/**
 * Directory and file names the explorer never shows.
 *
 * **`.git` is not in this list by accident** — it is separated below, because
 * hiding it is not the same decision as hiding build output. `.git` is hidden
 * because opening its contents in a text editor is meaningless and expanding it
 * is actively hostile; the rest are hidden because they are generated, large,
 * and not what anyone opened the panel to find.
 *
 * Other dotfiles are deliberately **shown**. `.claude`, `.github`,
 * `.env.example`, `.gitignore` and `AGENTS.md` are all things you open in this
 * app, and a rule that hid every name starting with a dot would hide all of
 * them to save the user from four directories.
 *
 * A `.gitignore` parser was considered and declined. It needs a matcher
 * dependency, it has to compose nested ignore files correctly to be worth
 * having, and it hides `.env.local` — which is one of the files you most want
 * to look at when a session will not start.
 *
 * Shared because both processes need the same answer: the renderer to build the
 * tree, and main to filter watcher events before they cost anything.
 */
export const ALWAYS_HIDDEN = '.git';

export const NOISE_ENTRIES = [
  'node_modules',
  'dist',
  'out',
  '.next',
  'coverage',
  '.turbo',
  'target',
  '__pycache__',
  '.venv',
] as const;

export const HIDDEN_ENTRIES: readonly string[] = [
  ALWAYS_HIDDEN,
  ...NOISE_ENTRIES,
];
