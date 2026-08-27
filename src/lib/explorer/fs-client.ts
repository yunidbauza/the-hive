import type {
  DirEntry,
  FileContent,
  FsChangedEvent,
  FsRefusal,
  FsResult,
  FsSearchMode,
  RootInfo,
  SearchResults,
  WriteFileResult,
} from '@shared/fs-contract';

/**
 * The filesystem bridge, as the renderer sees it.
 *
 * A module of functions rather than a store, for the reason `project-config.ts`
 * gives: this is a fact about the *machine*, asked for on demand, and it holds
 * no state worth subscribing to. What state there is — open buffers, expanded
 * directories — belongs to the stores that own those concepts.
 *
 * Nothing in `features/` or `components/` touches `window.hive.fs` directly.
 * That is the same rule the config and Jira clients follow, and it earns the
 * same thing: the browser target's "there is no bridge" case is handled once,
 * here, instead of at every call site.
 */

/**
 * The refusal every verb answers with when there is no bridge at all.
 *
 * `ENOBRIDGE` is this contract's code for the browser target, and the explorer
 * renders it as a sentence about the desktop app rather than as an error. It is
 * deliberately not `EPROJECT`: "you are running the demo" and "that project is
 * not usable" are different situations with different things to say.
 */
const NO_BRIDGE = {
  ok: false as const,
  error: { code: 'ENOBRIDGE', message: 'the desktop bridge is not available' },
};

/** Whether the filesystem verbs can work at all. */
export function hasFsBridge(): boolean {
  return Boolean(window.hive?.fs);
}

/**
 * `sessionId` is threaded through every verb from here down.
 *
 * It names the session whose working directory the request is *about*, and main
 * uses it to decide which root to resolve under — the project's, or a linked
 * worktree of it that the session moved into. It is optional throughout, so the
 * browser target and every caller that has no session behave exactly as before.
 *
 * The renderer never sends a path for this. It sends an id, and main answers
 * from the cwd it observed itself; see `electron/main/fs/session-roots.ts`.
 */
/**
 * Which root a read for this project and session resolves under.
 *
 * The one verb here that answers with a path, and the reason it exists is that
 * three renderer decisions — the buffer key, the watcher's reconciliation, and
 * the explorer header — were *inferring* main's verdict and getting it wrong
 * whenever main refused a session's working directory. See `RootInfo`.
 */
export async function readRoot(
  projectId: string,
  sessionId?: string,
): Promise<FsResult<RootInfo>> {
  const bridge = window.hive?.fs;
  if (!bridge) return NO_BRIDGE;
  return bridge.root({ projectId, sessionId });
}

export async function readDir(
  projectId: string,
  relPath: string,
  sessionId?: string,
): Promise<FsResult<DirEntry[]>> {
  const bridge = window.hive?.fs;
  if (!bridge) return NO_BRIDGE;
  return bridge.readDir({ projectId, relPath, sessionId });
}

export async function readFile(
  projectId: string,
  relPath: string,
  sessionId?: string,
): Promise<FsResult<FileContent | FsRefusal>> {
  const bridge = window.hive?.fs;
  if (!bridge) return NO_BRIDGE;
  return bridge.readFile({ projectId, relPath, sessionId });
}

export async function writeFile(
  projectId: string,
  relPath: string,
  text: string,
  baseMtimeMs: number,
  sessionId?: string,
): Promise<WriteFileResult> {
  const bridge = window.hive?.fs;
  if (!bridge) return { ...NO_BRIDGE, conflict: false };
  return bridge.writeFile({ projectId, relPath, text, baseMtimeMs, sessionId });
}

/**
 * Point the single watcher at a project.
 *
 * Swallows a rejection rather than propagating it, and returns whether it
 * worked. A project that cannot be watched is not a broken app — it is an
 * explorer without live updates, which still has its manual refresh. Letting
 * this reject would turn a degraded feature into an unhandled rejection in an
 * effect.
 */
/**
 * Walk the project for a name or a string.
 *
 * The one read here that is not about a place the caller already knows. It
 * still names no path — a project, a query and a mode — and every bound it
 * obeys is main's, declared in `fs-contract.ts`.
 */
export async function searchProject(
  projectId: string,
  query: string,
  mode: FsSearchMode,
  sessionId?: string,
): Promise<FsResult<SearchResults>> {
  const bridge = window.hive?.fs;
  if (!bridge) return NO_BRIDGE;
  return bridge.search({ projectId, query, mode, sessionId });
}

export async function watchProject(
  projectId: string,
  sessionId?: string,
): Promise<boolean> {
  const bridge = window.hive?.fs;
  if (!bridge) return false;
  try {
    await bridge.watch({ projectId, sessionId });
    return true;
  } catch {
    return false;
  }
}

export async function unwatchProject(): Promise<void> {
  const bridge = window.hive?.fs;
  if (!bridge) return;
  try {
    await bridge.unwatch();
  } catch {
    // Nothing to recover: the watcher is either already gone or main is.
  }
}

/**
 * Subscribe to filesystem changes. Returns its own unsubscribe.
 *
 * Returns a no-op disposer when there is no bridge, so callers never have to
 * branch — an effect that conditionally returns a cleanup is an effect that
 * eventually forgets to.
 */
export function onFsChanged(
  callback: (event: FsChangedEvent) => void,
): () => void {
  const bridge = window.hive?.fs;
  if (!bridge) return () => {};
  return bridge.onChanged(callback);
}

/**
 * Join a directory's relative path with a child name.
 *
 * Trivial, and here rather than inline because the root is `''` and
 * `'' + '/' + name` produces a leading slash — which the guard in main rejects
 * as an absolute path. Getting that wrong makes the root's children unreadable
 * and every nested directory fine, which is a confusing shape of bug.
 */
export function childPath(relPath: string, name: string): string {
  return relPath === '' ? name : `${relPath}/${name}`;
}

/** The last segment of a relative path — what a tab strip shows. */
export function baseName(relPath: string): string {
  const slash = relPath.lastIndexOf('/');
  return slash === -1 ? relPath : relPath.slice(slash + 1);
}

/** The directory part of a relative path, `''` at the root. */
export function parentPath(relPath: string): string {
  const slash = relPath.lastIndexOf('/');
  return slash === -1 ? '' : relPath.slice(0, slash);
}
