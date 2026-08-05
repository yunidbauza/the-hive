import { existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';

import {
  CLONE_ENTITY_ID,
  type AddProjectRequest,
  type CloneDoneEvent,
  type CloneRequest,
  type CloneStartResult,
  type ConfigSnapshot,
  type ProjectOrigin,
} from '@shared/config-contract';

import { addProject as writeProject, getConfig as readConfig } from '../config';
import { resolveProject } from '../config/resolve';
import type { Sessions } from '../sessions';

import { parseCloneUrl } from './parse-url';

/**
 * Cloning a remote repository (story 102).
 *
 * Main owns the whole flow — the renderer starts one and renders what comes
 * back. It does not decide when the clone succeeded, does not write the config,
 * and never supplies the destination. Putting the success criterion in the
 * renderer would make a config write depend on a process that may have been
 * closed, and letting it name a directory would hand it the one capability the
 * epic's "no verb takes a destination path" rule exists to withhold
 * (the settings epic, HIVE-51).
 *
 * What main derives, and the renderer never sends:
 *
 * - the folder name, from the URL (`parse-url.ts`);
 * - the target, by joining that onto a `realpath`'d parent;
 * - whether it succeeded, from `git`'s exit code.
 */

/** Whether a parent directory is one we may clone into. */
export type ParentVerdict =
  | { ok: true; path: string }
  | { ok: false; reason: string };

export interface CloneFlowOptions {
  sessions: Pick<Sessions, 'openCommand' | 'kill'>;
  /** Push the outcome to the renderer. */
  emit: (event: CloneDoneEvent) => void;
  /**
   * Injected so the unit suite never touches a real filesystem — the same
   * discipline `node-pty` gets, and for the same reason.
   */
  fs?: {
    existsSync(path: string): boolean;
    rmSync(path: string, options: { recursive: true; force: true }): void;
  };
  resolveParent?: (path: string) => ParentVerdict;
  addProject?: (
    request: AddProjectRequest,
    origin: ProjectOrigin,
  ) => ConfigSnapshot;
  getConfig?: () => ConfigSnapshot;
}

export interface CloneFlow {
  start(request: CloneRequest): CloneStartResult;
  /** Kill a running clone. Cleanup happens when its process actually exits. */
  cancel(): void;
  /** Kill and clean up synchronously. Called on app quit. */
  dispose(): void;
}

/**
 * The parent re-runs the **entire** story 090 resolution — expand `~`, require
 * absolute, `realpath`, require a directory — for the same reason `addProject`
 * does: the native dialog is a UX step, not a capability grant, and a renderer
 * that skipped it and posted a path directly gets identical treatment.
 */
function resolveParentDirectory(path: string): ParentVerdict {
  const probe = resolveProject({ id: 'probe', path });
  if (probe.status !== 'ok' || probe.path === null) {
    return { ok: false, reason: `cannot clone into ${path} (${probe.status})` };
  }
  return { ok: true, path: probe.path };
}

export function createCloneFlow(options: CloneFlowOptions): CloneFlow {
  const {
    sessions,
    emit,
    fs = { existsSync, rmSync },
    resolveParent = resolveParentDirectory,
    addProject = writeProject,
    getConfig = readConfig,
  } = options;

  /** The target of the clone in flight, or `null` when none is running. */
  let inFlight: string | null = null;

  const refuse = (reason: string): CloneStartResult => ({ ok: false, reason });

  /**
   * Remove the directory this flow created.
   *
   * `git` cleans up after its own ordinary failures, but not after `SIGKILL`
   * and not when the app quits underneath it — which are exactly the two cases
   * that would otherwise leave a half-clone for the user to find and delete by
   * hand. `force` so a clone that failed before creating anything does not turn
   * its own cleanup into a second error.
   */
  function cleanup(targetPath: string): void {
    fs.rmSync(targetPath, { recursive: true, force: true });
  }

  function finish(targetPath: string, reason: string | null): void {
    inFlight = null;

    if (reason !== null) {
      cleanup(targetPath);
      emit({ ok: false, targetPath: null, reason, snapshot: getConfig() });
      return;
    }

    emit({
      ok: true,
      targetPath,
      reason: null,
      snapshot: addProject({ path: targetPath }, 'cloned'),
    });
  }

  return {
    start(request) {
      if (inFlight !== null) {
        return refuse('a clone is already running — wait for it to finish');
      }

      const verdict = parseCloneUrl(request.url);
      if (!verdict.ok) return refuse(verdict.reason);

      const parent = resolveParent(request.parentPath);
      if (!parent.ok) return refuse(parent.reason);

      const targetPath = join(parent.path, verdict.repoName);

      /**
       * Refused rather than merged into. `git clone` into a non-empty directory
       * fails anyway, and into an empty one it would succeed — leaving the user
       * with a directory they had already made, now holding a repository they
       * may not have meant to put there.
       */
      if (fs.existsSync(targetPath)) {
        return refuse(`${targetPath} already exists — choose another folder`);
      }

      inFlight = targetPath;

      try {
        sessions.openCommand({
          entityId: CLONE_ENTITY_ID,
          cwd: parent.path,
          file: 'git',
          /**
           * An argv array, and `--` before the URL.
           *
           * argv is what makes quoting irrelevant; `--` is what stops a URL
           * being read as a flag even if `parse-url` were ever loosened.
           * `--progress` because `git` only draws progress when it believes
           * stdout is a terminal — and the whole point of the PTY is that it
           * is one.
           */
          args: ['clone', '--progress', '--', verdict.url, verdict.repoName],
          cols: request.cols,
          rows: request.rows,
          onExit: ({ exitCode, signal, lost, message }) => {
            /**
             * `signal === 0` is as load-bearing as the exit code.
             *
             * A `git clone` killed with SIGTERM exits **0 with signal 15**, so a
             * success check that read only the code would treat every cancelled
             * clone as a finished one — registering a half-clone as a project,
             * or, once `git` has removed its own partial checkout, registering a
             * directory that is no longer there.
             */
            if (exitCode === 0 && signal === 0 && !lost) {
              finish(targetPath, null);
              return;
            }
            /**
             * `message` wins when the host supplied one — that is the
             * `could not start git in <cwd>` case, already phrased in words the
             * user can act on. Rewriting it as "git exited with code -1" would
             * lose the only detail that makes it fixable.
             */
            finish(
              targetPath,
              message ??
                (lost
                  ? 'the terminal host stopped before the clone finished'
                  : signal !== 0
                    ? 'the clone was stopped before it finished'
                    : `git exited with code ${exitCode}`),
            );
          },
        });
      } catch (cause) {
        // Nothing started, so nothing was created — release the slot rather
        // than stranding the flow on a clone that never began.
        inFlight = null;
        return refuse(cause instanceof Error ? cause.message : String(cause));
      }

      return { ok: true, targetPath };
    },

    cancel() {
      if (inFlight === null) return;
      /**
       * Cleanup runs in `onExit`, not here: the process still holds the
       * directory, and removing it underneath a live `git` gives a
       * partially-deleted tree instead of no tree.
       */
      sessions.kill(CLONE_ENTITY_ID);
    },

    dispose() {
      const targetPath = inFlight;
      if (targetPath === null) return;
      inFlight = null;
      sessions.kill(CLONE_ENTITY_ID);
      // Synchronous, unlike `cancel`: the app is going away, and there will be
      // no `onExit` left to run cleanup in.
      cleanup(targetPath);
    },
  };
}
