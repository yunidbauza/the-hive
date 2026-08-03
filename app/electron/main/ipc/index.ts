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

import { createPtyIpc, type PtyIpc } from './pty';
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

let ptyIpc: PtyIpc | null = null;

/** The live PTY IPC layer, or `null` before registration. Test-only reach-in. */
export function ptyIpcLayer(): PtyIpc | null {
  return ptyIpc;
}

export function registerIpcHandlers(): void {
  const supervisor = registerPtyHost();
  ptyIpc = createPtyIpc({
    supervisor,
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

  handle(CH.appInfo, (): AppInfo => {
    const { electron, chrome, node } = process.versions;
    const diagnostics = ptyIpc?.diagnostics() ?? [];
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
  handle(CH.ptySpawn, (_event, payload) => {
    const request = parseSpawnRequest(payload);
    const config = getConfig();
    const project = config.projects.find(
      (entry) => entry.id === request.projectId,
    );

    /**
     * Resolved here, in main, and never in the host — which does not know what
     * a project is (story 091). A project with no usable path cannot host a
     * session, and saying so beats spawning a shell in an arbitrary directory.
     */
    if (!project || project.status !== 'ok' || project.path === null) {
      throw new Error(
        `cannot start a session in "${request.projectId}": it is not mapped to a usable directory in ${config.configPath}`,
      );
    }

    ptyIpc?.spawn({
      sessionId: request.sessionId,
      shell: config.shell,
      args: [],
      cwd: project.path,
      env: {},
      cols: request.cols,
      rows: request.rows,
    });
  });

  handle(CH.ptyKill, (_event, payload) => {
    ptyIpc?.kill(parseKillRequest(payload));
  });

  on(CH.ptyWrite, (_event, payload) => {
    const request = parseWriteRequest(payload);
    ptyIpc?.write(request.sessionId, request.data);
  });

  on(CH.ptyResize, (_event, payload) => {
    const request = parseResizeRequest(payload);
    ptyIpc?.resize(request.sessionId, request.cols, request.rows);
  });

  on(CH.ptyAck, (_event, payload) => {
    const request = parseAckRequest(payload);
    ptyIpc?.ack(request.sessionId, request.seq);
  });
}

/** Test-only: drop the PTY layer and its timers. */
export function resetIpcHandlers(): void {
  ptyIpc?.dispose();
  ptyIpc = null;
}

export { assertSender, isTrustedSender, IpcSenderError } from './sender';
