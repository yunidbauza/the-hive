import type { IpcMainEvent, IpcMainInvokeEvent } from 'electron';

/**
 * Sender validation (story 082).
 *
 * Without this, *any* frame that ends up in the process can invoke a channel —
 * an iframe, a subframe created by a page the renderer navigated to, a devtools
 * extension context. The handlers behind these channels reach process control
 * (story 092), so "who is asking" is not a detail.
 *
 * The rule: only the **main frame** of one of the app's own windows may speak.
 */

export class IpcSenderError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'IpcSenderError';
  }
}

type AnyIpcEvent = IpcMainEvent | IpcMainInvokeEvent;

/**
 * True when the event came from the top-level frame of the sending
 * `webContents`.
 *
 * `senderFrame` is the frame that actually sent the message; comparing it to
 * `webContents.mainFrame` is what distinguishes the app's own document from a
 * subframe inside it. A null `senderFrame` means the frame was destroyed
 * between send and handle — treated as untrusted, since there is nothing left
 * to verify against.
 */
export function isTrustedSender(event: AnyIpcEvent): boolean {
  const frame = event.senderFrame;
  if (!frame) return false;
  return frame === event.sender.mainFrame;
}

/** Throws unless the event came from the app's own main frame. */
export function assertSender(event: AnyIpcEvent): void {
  if (!isTrustedSender(event)) {
    throw new IpcSenderError('rejected IPC from a non-main frame');
  }
}
