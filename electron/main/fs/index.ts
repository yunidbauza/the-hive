/**
 * The project filesystem layer — the explorer and the editor.
 *
 * A thin composition point: the read verbs are in `read.ts` and `search.ts`,
 * the write in `write.ts`, the one that turns printed text into a `relPath` in
 * `resolve.ts`, the containment guard is in `paths.ts`, and the watcher is in
 * `watcher.ts`.
 * This file exists so `ipc/index.ts` imports one thing and so the watcher has
 * a lifetime that `resetIpcHandlers` can end.
 */
export { readDirectory, readFileContent, readRoot } from './read';
export { resolvePaths } from './resolve';
export { browseHomeDirectory } from './home-browse';
export { searchProject } from './search';
export { writeFileContent } from './write';
export { createFsWatchLayer, type FsWatchLayer } from './watcher';
export {
  FsGuardError,
  asFailure,
  contains,
  projectRoot,
  resolveExisting,
  resolveForWrite,
  rootFor,
} from './paths';
export {
  forgetProbedRoots,
  observedSessionCwd,
  sessionRoot,
  setSessionCwdLookup,
  type SessionCwdLookup,
} from './session-roots';
