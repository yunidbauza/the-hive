/**
 * What this process has bound to `ipcMain`, so it can be un-bound (HIVE-144).
 *
 * `ipcMain.handle` throws on a second handler for one channel and `ipcMain.on`
 * silently adds a duplicate listener, so a live mode switch — which re-registers
 * every channel against a different set of layers — is impossible until
 * registration is reversible. `resetIpcHandlers` used to drop the layers and
 * leave the bindings, which was survivable only because nothing ever registered
 * twice in one process.
 *
 * A `Set`, not a list: `handle` and `on` are each called once per channel today,
 * but recording the same channel twice and unbinding it twice would make the
 * second `removeAllListeners` a silent no-op that looked like it worked.
 */
export interface BindingTarget {
  removeHandler(channel: string): void;
  removeAllListeners(channel: string): void;
}

export interface Bindings {
  /** Record that `channel` now has an ipcMain registration. */
  record(channel: string): void;
  /** Remove every recorded registration. Idempotent. */
  unbindAll(): void;
  /** How many channels are currently recorded. For tests and diagnostics. */
  size(): number;
}

export function createBindings(ipc: BindingTarget): Bindings {
  const bound = new Set<string>();

  return {
    record(channel) {
      bound.add(channel);
    },

    /*
      Both verbs for every channel rather than tracking which wrapper bound it.
      `removeHandler` on a channel that only ever had listeners is a no-op, and
      so is the reverse — and a record of *which kind* each channel was is a
      second thing to keep in step with the wrappers.
    */
    unbindAll() {
      for (const channel of bound) {
        ipc.removeHandler(channel);
        ipc.removeAllListeners(channel);
      }
      bound.clear();
    },

    size: () => bound.size,
  };
}
