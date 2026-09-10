import type { RemoteConfig } from '@shared/config-contract';

import { getConfig } from '../config';

/**
 * What `config:get-remote` answers (HIVE-149) — this process's own `remote`
 * block, whichever mode it is bound in.
 *
 * Its own module rather than an inline `getConfig().remote` at each of the two
 * call sites, for the reason {@link applySetRemote} has one (`set-remote.ts`):
 * the local handler in `ipc/index.ts` and the `PROCESS_LOCAL` arm in
 * `remote-proxy.ts` must answer this channel *identically*, and one exported
 * symbol is how that is guaranteed rather than asserted. It is one expression
 * today; what the module buys is that it stays one expression in both modes.
 *
 * Read fresh on every call, never memoised. A mode switch rewrites this block
 * while the process runs, so a cached answer would report the mode this process
 * booted in — the same staleness as the proxied read this channel replaces,
 * arriving through the other door.
 *
 * Imported directly by both call sites rather than handed down the way
 * `localAppInfo` is, on the test `remote-proxy.ts`'s own doc comment sets:
 * nothing here is per-registration state, and `electron/main/config/index.ts`
 * reaches nothing under `ipc/`, so the import closes no cycle.
 */
export function readLocalRemote(): RemoteConfig {
  return getConfig().remote;
}
