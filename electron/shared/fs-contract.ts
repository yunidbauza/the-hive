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

/** `fs:read-dir`. `relPath` is `''` for the root — see {@link ReadDirRequest.sessionId}. */
export interface ReadDirRequest {
  projectId: string;
  relPath: string;
  /**
   * Which session's working directory to root at, when it is not the project's.
   *
   * ## Why a session id and not a path
   *
   * Property 1 at the top of this file — *no verb takes a path* — is the reason
   * this is an opaque id rather than the directory itself. Main holds the cwd it
   * observed from that session's own hook payloads and looks it up here; a
   * renderer that wants to read somewhere else has nothing to put in the request.
   * Handing a path across would have inverted the whole design.
   *
   * ## What main does with it
   *
   * It widens the root **only** for a session whose cwd is a linked git worktree
   * of the mapped project — the case the explorer exists to show honestly, where
   * an agent has moved into a worktree kept outside the repository. Anything
   * else, including a session that wandered into `/tmp`, falls back to the
   * project root. See `electron/main/fs/session-roots.ts`.
   *
   * Optional everywhere: without it, every verb behaves exactly as it did.
   */
  sessionId?: string;
}

/** `fs:read-file`. */
export interface ReadFileRequest {
  projectId: string;
  relPath: string;
  /** See {@link ReadDirRequest.sessionId}. */
  sessionId?: string;
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
  /** See {@link ReadDirRequest.sessionId}. */
  sessionId?: string;
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

/**
 * `fs:root` — which root a read for this project and session resolves under.
 *
 * A **read**, and the only verb here that answers with a path. That is a
 * deliberate exception to property 1 at the top of this file, and worth stating
 * plainly: property 1 is that no verb *takes* a path, so that a renderer cannot
 * name a directory. Answering with one grants nothing — the renderer already
 * holds the project's path from the config and the session's cwd from the
 * session stream, so this discloses nothing new. What it adds is main's
 * **verdict**, which the renderer cannot compute and was previously guessing.
 *
 * Three things needed that verdict and each was wrong without it:
 *
 * - **The editor's buffer key.** `projectId + relPath` identified a file only
 *   while every root was the project root. With an external worktree as a root,
 *   two different files share a key and the second `openFile` focuses the
 *   first — so the user edits and saves into the wrong tree.
 * - **The watcher's reconciliation.** The single watcher is rooted wherever main
 *   resolved, and its paths are relative to *that*, so a change in a worktree
 *   was marking a project-root buffer stale and vice versa.
 * - **The explorer's header.** It named a worktree whenever the session's cwd
 *   differed from the project, including when main had **refused** that cwd and
 *   served the project root — the right label over the wrong files, which is the
 *   exact untruth the header exists to prevent.
 */
export interface RootRequest {
  projectId: string;
  /** See {@link ReadDirRequest.sessionId}. */
  sessionId?: string;
}

/** What `fs:root` answers with. */
export interface RootInfo {
  /** The absolute directory every `relPath` in this pairing resolves under. */
  root: string;
  /**
   * Whether that is the session's own worktree rather than the project root.
   *
   * `false` covers both "no session" and "main refused this session's cwd", and
   * the renderer must not tell them apart: in both cases the tree is the
   * project's, and that is the only fact any caller acts on.
   */
  widened: boolean;
}

/**
 * `fs:watch`. One watcher exists at a time; this replaces it.
 *
 * Carries the session for the same reason the reads do: a watcher rooted at the
 * project while the tree shows a worktree outside it would report changes to
 * files nobody is looking at, and stay silent about the ones they are.
 */
export interface WatchRequest {
  projectId: string;
  /** See {@link ReadDirRequest.sessionId}. */
  sessionId?: string;
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

/**
 * `fs:search` — finding a file, or something inside one.
 *
 * ## Why this is a verb at all, rather than a filter in the renderer
 *
 * The obvious implementation is a filter over the entries already on screen,
 * and it cannot work: `use-directory.ts` reads a directory only when it is
 * *expanded*, so a collapsed node's children are simply not in the renderer.
 * A filter would answer "no matches" for a file sitting one unopened folder
 * away — confidently, and wrongly. Even a filename-only search therefore needs
 * a walk, and a walk belongs on the side that already owns containment.
 *
 * ## What it does not do
 *
 * It does not read `.gitignore`, for the reason {@link HIDDEN_ENTRIES} gives:
 * the parser is a dependency, nested ignore files have to compose correctly to
 * be worth having, and it hides `.env.local`. {@link HIDDEN_ENTRIES} already
 * prunes the directories that actually cost — `node_modules`, `dist`,
 * `coverage` and the rest — before anything is read.
 */
export type FsSearchMode = 'name' | 'text';

export interface SearchRequest {
  projectId: string;
  /** What to look for. Matched case-insensitively as a literal, never a regex. */
  query: string;
  mode: FsSearchMode;
  /** See {@link ReadDirRequest.sessionId}. */
  sessionId?: string;
}

/** One matching line inside a file. Absent entirely in `name` mode. */
export interface SearchLine {
  /** 1-based, as an editor counts. */
  line: number;
  /** The line, trimmed of leading whitespace and clipped to {@link MAX_LINE_CHARS}. */
  text: string;
  /** Where the match starts in {@link SearchLine.text}, after trimming and clipping. */
  column: number;
}

/**
 * One file that matched, with its hits.
 *
 * `relPath` is project-relative and composed the same way the tree composes
 * one, so the editor's buffer key is the key it would have had if the file had
 * been reached by clicking through — see `docs/explorer-and-editor.md`.
 */
export interface SearchHit {
  relPath: string;
  name: string;
  /** Empty in `name` mode: the file's *name* matched, nothing inside it did. */
  lines: SearchLine[];
  /** Total hits in this file, which may exceed `lines.length` once capped. */
  total: number;
}

/**
 * What a search answers.
 *
 * `capped` is the field that keeps this honest. Every bound below stops the
 * walk early, and a truncated set rendered as a total is the same class of
 * untruth as a tree that shows the wrong files without saying so — the rule the
 * PR search already states for its own `200+`.
 */
export interface SearchResults {
  hits: SearchHit[];
  /** Files that matched, which may exceed `hits.length` once capped. */
  files: number;
  /** Matches across every file, capped at {@link MAX_SEARCH_MATCHES}. */
  matches: number;
  capped: boolean;
}

/**
 * The bounds, none of which existed before this verb.
 *
 * Nothing in the fs layer recursed until now, so there was never a depth to
 * limit or a result set to cap. Each of these is a floor on how bad the worst
 * case can get, not a target: a search that hits one has already found more
 * than a 316px rail can show.
 */
export const MAX_SEARCH_DEPTH = 12;
export const MAX_SEARCH_FILES = 200;
export const MAX_SEARCH_MATCHES = 500;
/** Per file, so one generated line cannot fill the whole result set. */
export const MAX_SEARCH_LINES_PER_FILE = 20;
/** A whole-search budget, so a huge tree degrades to partial rather than hangs. */
export const SEARCH_BUDGET_MS = 4_000;
/** Longest line returned. A minified bundle has one line and it is megabytes. */
export const MAX_LINE_CHARS = 200;
/** Shortest query worth walking a tree for. */
export const MIN_QUERY_CHARS = 2;
