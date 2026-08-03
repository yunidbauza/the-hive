import {
  BrowserWindow,
  app,
  ipcMain,
  type IpcMainEvent,
  type IpcMainInvokeEvent,
} from 'electron';

import type { ConfigSnapshot } from '@shared/config-contract';
import {
  parseAckRequest,
  parseSpawnRequest,
  parseKillRequest,
  parseResizeRequest,
  parseWriteRequest,
} from '@shared/guards';
import { CH, type AppInfo } from '@shared/ipc-contract';

import { getConfig, reloadConfig } from '../config';
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

/** The live sessions layer, or `null` before registration. Test-only reach-in. */
export function sessionsLayer(): Sessions | null {
  return sessions;
}

export function registerIpcHandlers(): void {
  const supervisor = registerPtyHost();
  sessions = createSessions({
    supervisor,
    config: getConfig,
    /**
     * One window by design (story 000), so a broadcast reaches exactly the
     * renderer that owns every session. Resolved per send rather than captured:
     * the window is created after this runs, and on macOS it can be closed and
     * re-created while the app keeps running.
     */
    send: (channel, payload) => {
      for (const window of BrowserWindow.getAllWindows()) {
        if (window.isDestroyed()) continue;
        window.webContents.send(channel, payload);
      }
    },
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
}

export { assertSender, isTrustedSender, IpcSenderError } from './sender';
