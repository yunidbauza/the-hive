import { contextBridge, ipcRenderer } from 'electron';

import { CH, type AppInfo } from '@shared/ipc-contract';

/**
 * The bridge (story 080 scaffold; story 082 hardens and tests it).
 *
 * `ipcRenderer` is never exposed, in whole or in part — not bound to a channel
 * argument, not behind a wrapper that takes a channel name. The renderer gets
 * *verbs*, and the set of verbs is the allowlist. Widening it is a deliberate
 * edit to the contract, which is the property the whole design exists for.
 *
 * `sandbox: true` constrains this file too: it may require only `electron` and
 * a small polyfill set — no `fs`, no `child_process`, no `process.env`. Any
 * temptation to do real work here is a signal the work belongs in main behind
 * a channel.
 */
contextBridge.exposeInMainWorld('hive', {
  appInfo: (): Promise<AppInfo> => ipcRenderer.invoke(CH.appInfo),
});
