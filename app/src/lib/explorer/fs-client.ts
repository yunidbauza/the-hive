import type {
  DirEntry,
  FileContent,
  FsChangedEvent,
  FsRefusal,
  FsResult,
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

export async function readDir(
  projectId: string,
  relPath: string,
): Promise<FsResult<DirEntry[]>> {
  const bridge = window.hive?.fs;
  if (!bridge) return NO_BRIDGE;
  return bridge.readDir({ projectId, relPath });
}

export async function readFile(
  projectId: string,
  relPath: string,
): Promise<FsResult<FileContent | FsRefusal>> {
  const bridge = window.hive?.fs;
  if (!bridge) return NO_BRIDGE;
  return bridge.readFile({ projectId, relPath });
}

export async function writeFile(
  projectId: string,
  relPath: string,
  text: string,
  baseMtimeMs: number,
): Promise<WriteFileResult> {
  const bridge = window.hive?.fs;
  if (!bridge) return { ...NO_BRIDGE, conflict: false };
  return bridge.writeFile({ projectId, relPath, text, baseMtimeMs });
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
export async function watchProject(projectId: string): Promise<boolean> {
  const bridge = window.hive?.fs;
  if (!bridge) return false;
  try {
    await bridge.watch({ projectId });
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
