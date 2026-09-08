import type { Channel } from '@shared/ipc-contract';

/**
 * A surface whose death should reset per-surface state (HIVE-143).
 *
 * Duck-typed rather than `WebContents`, because `watchReporter` in
 * `./index.ts` was already duck-typed — it checks for a `.on` function and its
 * own comment notes that the unit suites hand it a bare object. A socket is a
 * second kind of surface with a lifetime, and this is the shape both satisfy.
 */
export interface RemoteReporter {
  on(event: string, listener: () => void): unknown;
}

/** A `call` handler with the Electron event already bound away. */
export type CallHandler = (payload: unknown) => unknown;

/**
 * A `notify` handler, still needing a surface identity.
 *
 * Only `pty:prompt` uses it — `watchReporter(event.sender)` — but the argument
 * is on the type rather than special-cased, so a second notify channel that
 * grows a surface dependency does not need this signature widened under it.
 */
export type NotifyHandler = (payload: unknown, reporter: RemoteReporter) => void;

/**
 * Which handler answers which channel, recorded as they are registered
 * (HIVE-143).
 *
 * `ipcMain.handle` is write-only: there is no supported way to ask Electron
 * for the function behind a channel, and no way to invoke one from main. So a
 * socket that wants the same answer a renderer would get needs its own way in,
 * and the cheapest honest one is to record the handler at the single place
 * every channel already passes through.
 *
 * **This stores and nothing else.** No authorization, no validation, no
 * logging. `./remote-dispatch.ts` holds the policy, and it holds it alone so
 * that the local path — which `ipc/router.ts` is explicit must keep exactly one
 * gate — does not acquire a second one that always passes.
 */
export interface IpcRegistry {
  recordCall(channel: Channel, handler: CallHandler): void;
  recordNotify(channel: Channel, handler: NotifyHandler): void;
  /** The handler, or `null` — which a dispatcher must treat as a refusal. */
  call(channel: string): CallHandler | null;
  notify(channel: string): NotifyHandler | null;
  /** How many handlers are recorded. The composition-order assertion reads it. */
  size(): number;
  /** Drop everything. `resetIpcHandlers` calls this. */
  clear(): void;
}

export function createIpcRegistry(): IpcRegistry {
  const calls = new Map<string, CallHandler>();
  const notifies = new Map<string, NotifyHandler>();

  return {
    recordCall(channel, handler) {
      calls.set(channel, handler);
    },
    recordNotify(channel, handler) {
      notifies.set(channel, handler);
    },
    call: (channel) => calls.get(channel) ?? null,
    notify: (channel) => notifies.get(channel) ?? null,
    size: () => calls.size + notifies.size,
    clear() {
      calls.clear();
      notifies.clear();
    },
  };
}
