/**
 * The project filesystem layer — the explorer and the editor.
 *
 * A thin composition point: the three verbs are in `read.ts` and `write.ts`,
 * the containment guard is in `paths.ts`, and the watcher is in `watcher.ts`.
 * This file exists so `ipc/index.ts` imports one thing and so the watcher has
 * a lifetime that `resetIpcHandlers` can end.
 */
export { readDirectory, readFileContent } from './read';
export { writeFileContent } from './write';
export { createFsWatchLayer, type FsWatchLayer } from './watcher';
export {
  FsGuardError,
  asFailure,
  contains,
  projectRoot,
  resolveExisting,
  resolveForWrite,
} from './paths';
