import { app, ipcMain, type IpcMainInvokeEvent } from 'electron';

import type { ConfigSnapshot } from '@shared/config-contract';
import { CH, type AppInfo } from '@shared/ipc-contract';

import { getConfig, reloadConfig } from '../config';

import { assertSender } from './sender';

/**
 * Channel handlers (story 082).
 *
 * Every handler validates before acting: `assertSender` first, then the payload
 * guard. The renderer is untrusted input because terminal output is untrusted
 * input and it renders there.
 *
 * `app:info` is the only channel implemented in this story — the one that
 * proves the whole path. The PTY channels are declared in the contract and
 * handled in story 093, which owns their flow control.
 */

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

export function registerIpcHandlers(): void {
  handle(CH.appInfo, (): AppInfo => {
    const { electron, chrome, node } = process.versions;
    return {
      version: app.getVersion(),
      electron: electron ?? 'unknown',
      chrome: chrome ?? 'unknown',
      node: node ?? 'unknown',
      platform: process.platform,
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
}

export { assertSender, isTrustedSender, IpcSenderError } from './sender';
