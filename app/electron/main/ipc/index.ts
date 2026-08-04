import {
  BrowserWindow,
  app,
  dialog,
  ipcMain,
  type IpcMainEvent,
  type IpcMainInvokeEvent,
} from 'electron';

import type {
  CloneStartResult,
  CommandDiagnostic,
  ConfigSnapshot,
} from '@shared/config-contract';
import {
  parseAckRequest,
  parseAddProjectRequest,
  parseCloneRequest,
  parseDiagnoseCommandRequest,
  parseSpawnRequest,
  parseKillRequest,
  parseRemoveProjectRequest,
  parseRenameProjectRequest,
  parseReorderProjectsRequest,
  parseRepointProjectRequest,
  parseResizeRequest,
  parseSetProjectRuntimeRequest,
  parseSetRuntimeRequest,
  parseWriteRequest,
} from '@shared/guards';
import { CH, type AppInfo } from '@shared/ipc-contract';

import { createCloneFlow, type CloneFlow } from '../clone';
import {
  addProject,
  getConfig,
  reloadConfig,
  removeProject,
  renameProject,
  reorderProjects,
  repointProject,
  setProjectRuntime,
  setRuntime,
} from '../config';
import { diagnoseCommand, effectiveRuntime } from '../config/runtime';
import { registerPtyHost } from '../pty-host';
import { createSessions, type Sessions } from '../sessions';
import { onShutdown } from '../shutdown';

import { assertSender } from './sender';

/**
 * Channel handlers (story 082).
 *
 * Every handler validates before acting: `assertSender` first, then the payload
 * guard. The renderer is untrusted input because terminal output is untrusted
 * input and it renders there.
 *
 * `app:info` proved the path in story 082; `config:*` landed in 090; the PTY
 * channels and their flow control are story 093's.
 */

/**
 * Fire-and-forget channels (story 093).
 *
 * `send`, not `invoke`, for keystrokes, resizes and acks: awaiting a round trip
 * per character would put the main process in the typing-latency path, and
 * ordering is already guaranteed on a single channel — which is what actually
 * matters.
 */
function on(
  channel: string,
  handler: (event: IpcMainEvent, payload: unknown) => void,
): void {
  ipcMain.on(channel, (event, payload: unknown) => {
    assertSender(event);
    try {
      handler(event, payload);
    } catch (cause) {
      // A `send` channel has no reply, so a throw here would be an unhandled
      // rejection in main rather than an error the renderer sees. Rejected
      // input is logged and dropped — never acted on.
      console.error(`[hive] rejected ${channel}:`, cause);
    }
  });
}

/** Wrap a handler so sender validation cannot be forgotten on a new channel. */
function handle<T>(
  channel: string,
  handler: (event: IpcMainInvokeEvent, payload: unknown) => T,
): void {
  ipcMain.handle(channel, (event, payload: unknown) => {
    assertSender(event);
    return handler(event, payload);
  });
}

let sessions: Sessions | null = null;
/** The clone flow (story 102), or `null` before registration. */
let cloneFlow: CloneFlow | null = null;

/** The live sessions layer, or `null` before registration. Test-only reach-in. */
export function sessionsLayer(): Sessions | null {
  return sessions;
}

export function registerIpcHandlers(): void {
  const supervisor = registerPtyHost();

  /**
   * One window by design (story 000), so a broadcast reaches exactly the
   * renderer that owns every session. Resolved per send rather than captured:
   * the window is created after this runs, and on macOS it can be closed and
   * re-created while the app keeps running.
   */
  const send = (channel: string, payload: unknown): void => {
    for (const window of BrowserWindow.getAllWindows()) {
      if (window.isDestroyed()) continue;
      window.webContents.send(channel, payload);
    }
  };

  sessions = createSessions({ supervisor, config: getConfig, send });

  cloneFlow = createCloneFlow({
    sessions,
    emit: (event) => send(CH.configCloneDone, event),
  });

  /**
   * Drop this layer's timers on quit.
   *
   * The *processes* are not killed here, and that is deliberate rather than an
   * omission: `pty-host/index.ts` already registers a hook that asks the host to
   * SIGTERM every session's process group, waits, and force-kills what is left
   * (story 091). Signalling them twice from two hooks would race, and the second
   * kill would target pids that no longer exist. This hook exists so that the
   * batching and debounce timers cannot outlive the app and hold `before-quit`
   * open after the processes are already gone.
   */
  onShutdown(() => {
    sessions?.dispose();
    /**
     * A clone in flight when the app quits is the likeliest way to strand a
     * half-clone: `git` cleans up after its own failures, but not after the
     * process tree is torn down underneath it.
     */
    cloneFlow?.dispose();
  });

  handle(CH.appInfo, (): AppInfo => {
    const { electron, chrome, node } = process.versions;
    const diagnostics = sessions?.diagnostics() ?? [];
    return {
      version: app.getVersion(),
      electron: electron ?? 'unknown',
      chrome: chrome ?? 'unknown',
      node: node ?? 'unknown',
      platform: process.platform,
      // Omitted rather than empty when nothing has run, so the field's presence
      // means something.
      ...(diagnostics.length > 0 ? { pty: diagnostics } : {}),
    };
  });

  /**
   * The workspace config (story 090).
   *
   * Both channels take no payload, so there is no guard to run — the sender
   * check `handle` applies is the whole validation. The snapshot they return
   * is already validated: every path in it was resolved and checked in the
   * main process, and the renderer is trusted with the *verdict* precisely
   * because it was never trusted with the input.
   */
  handle(CH.configGet, (): ConfigSnapshot => getConfig());
  handle(CH.configReload, (): ConfigSnapshot => reloadConfig());

  /**
   * Config mutation (story 101).
   *
   * `chooseDirectory` takes no payload, so — like `get` and `reload` — the
   * sender check `handle` applies is its whole validation. The other two carry
   * a payload, are guarded here, and are then re-validated inside `addProject`
   * from scratch: the guard proves the *shape*, main proves the *path*.
   */
  handle(CH.configChooseDirectory, async (event): Promise<string | null> => {
    /**
     * The parent window is resolved from the event rather than captured.
     *
     * There is no `mainWindow` singleton in this process, deliberately: on
     * macOS the window can be closed and re-created while the app keeps
     * running, so a held reference goes stale. `send` above resolves windows
     * per call for the same reason. `assertSender` has already proven this
     * sender is the main frame, so its window is the one that asked.
     */
    const window = BrowserWindow.fromWebContents(event.sender);
    // Destroyed between the invoke and here. Nothing to attach a sheet to, and
    // treating it as a cancelled dialog is what the caller already handles.
    if (!window) return null;

    const result = await dialog.showOpenDialog(window, {
      properties: ['openDirectory'],
    });
    if (result.canceled || result.filePaths.length === 0) return null;
    return result.filePaths[0] ?? null;
  });

  handle(
    CH.configAddProject,
    (_event, payload): ConfigSnapshot => addProject(parseAddProjectRequest(payload)),
  );

  handle(
    CH.configRemoveProject,
    (_event, payload): ConfigSnapshot =>
      removeProject(parseRemoveProjectRequest(payload)),
  );

  /**
   * Managing projects (story 103).
   *
   * Same contract as story 101's mutating verbs: the guard proves the *shape*,
   * and main proves the *value*. `repointProject` re-runs the full path
   * resolution, and `reorderProjects` re-reads the file before deciding whether
   * the ordering it was handed still describes it.
   */
  handle(
    CH.configRenameProject,
    (_event, payload): ConfigSnapshot =>
      renameProject(parseRenameProjectRequest(payload)),
  );

  handle(
    CH.configRepointProject,
    (_event, payload): ConfigSnapshot =>
      repointProject(parseRepointProjectRequest(payload)),
  );

  handle(
    CH.configReorderProjects,
    (_event, payload): ConfigSnapshot =>
      reorderProjects(parseReorderProjectsRequest(payload)),
  );

  /**
   * Runtime settings (story 104).
   *
   * The two mutating verbs follow every other config channel exactly — guard
   * first, verb second, fresh `ConfigSnapshot` back.
   */
  handle(
    CH.configSetRuntime,
    (_event, payload): ConfigSnapshot => setRuntime(parseSetRuntimeRequest(payload)),
  );

  handle(
    CH.configSetProjectRuntime,
    (_event, payload): ConfigSnapshot =>
      setProjectRuntime(parseSetProjectRuntimeRequest(payload)),
  );

  /**
   * The PATH diagnostic (story 104) — read-only, so no write path.
   *
   * Resolved through the *same* `effectiveRuntime` the spawn path uses, which
   * is the whole point: a diagnostic that computed its own answer would
   * eventually describe an environment no session runs in.
   *
   * An unknown id is not an error. The renderer can ask about a project that a
   * concurrent hand-edit has since removed, and answering for the top-level
   * command is more useful than throwing at a user who only pressed a button.
   */
  handle(CH.configDiagnoseCommand, (_event, payload): CommandDiagnostic => {
    const request = parseDiagnoseCommandRequest(payload);
    const snapshot = getConfig();
    const project =
      request.id === undefined
        ? null
        : (snapshot.projects.find((entry) => entry.id === request.id) ?? null);

    return diagnoseCommand(
      effectiveRuntime(snapshot, project),
      project?.id ?? null,
    );
  });

  /**
   * Cloning a repository (story 102).
   *
   * `startClone` returns a **refusal**, it does not throw: a mistyped URL or a
   * folder that already exists is something the user fixes in a text field, not
   * an exception the renderer has to catch. Guard failures still throw — those
   * are malformed payloads, which are a bug or an attack, not a user mistake.
   */
  handle(CH.configCloneStart, (_event, payload): CloneStartResult => {
    const request = parseCloneRequest(payload);
    return (
      cloneFlow?.start(request) ?? {
        ok: false,
        reason: 'the clone service is not available',
      }
    );
  });

  handle(CH.configCloneCancel, (): void => {
    cloneFlow?.cancel();
  });

  /**
   * The PTY channels (story 093).
   *
   * `spawn` and `kill` use `invoke` — both need a result. `write`, `resize`
   * and `ack` use `send`, and every one of them is validated before it reaches
   * process control.
   */
  /**
   * `sessionId` on the wire is an **entity** id.
   *
   * The renderer has always addressed terminals by entity id (story 094) and
   * never sees a pty handle. Story 096 makes the two genuinely different: main
   * mints a session id per generation, and the sessions layer translates in both
   * directions. Project resolution and every refusal message moved there with
   * it, so this handler is now only validation and delegation.
   */
  handle(CH.ptySpawn, (_event, payload) => {
    const request = parseSpawnRequest(payload);
    sessions?.open({
      entityId: request.sessionId,
      projectId: request.projectId,
      cols: request.cols,
      rows: request.rows,
      task: request.task,
    });
  });

  handle(CH.ptyRestart, async (_event, payload) => {
    const request = parseSpawnRequest(payload);
    /**
     * The task is deliberately **not** forwarded (story 097).
     *
     * A restart discards a running agent's context and starts a fresh process.
     * Re-delivering an instruction the previous generation may already have
     * acted on — edited files, opened a PR — is worse than delivering nothing:
     * the user asked for a clean slate, not for the work to be redone.
     */
    await sessions?.restart({
      entityId: request.sessionId,
      projectId: request.projectId,
      cols: request.cols,
      rows: request.rows,
    });
  });

  handle(CH.ptyKill, (_event, payload) => {
    sessions?.kill(parseKillRequest(payload));
  });

  on(CH.ptyWrite, (_event, payload) => {
    const request = parseWriteRequest(payload);
    sessions?.write(request.sessionId, request.data);
  });

  on(CH.ptyResize, (_event, payload) => {
    const request = parseResizeRequest(payload);
    sessions?.resize(request.sessionId, request.cols, request.rows);
  });

  on(CH.ptyAck, (_event, payload) => {
    const request = parseAckRequest(payload);
    sessions?.ack(request.sessionId, request.seq);
  });
}

/** Test-only: drop the sessions layer and its timers. */
export function resetIpcHandlers(): void {
  sessions?.dispose();
  sessions = null;
  cloneFlow?.dispose();
  cloneFlow = null;
}

export { assertSender, isTrustedSender, IpcSenderError } from './sender';
