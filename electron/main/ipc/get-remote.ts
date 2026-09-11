import type { LocalRemoteState } from '@shared/ipc-contract';

import { getConfig } from '../config';

/**
 * What `config:get-remote` answers (HIVE-149) — this process's own `remote`
 * block, whichever mode it is bound in, and whether a device credential is
 * stored beside it (HIVE-140 audit, gap 6).
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
 * `paired` is handed in rather than read here: the credential store is spelled
 * in `ipc/index.ts` (`remoteCredentialStore`), which imports this module, so
 * reading it here would close an import cycle. Both callers pass the same
 * `remoteCredentialStore().read() !== null`.
 */
export function readLocalRemote(paired: boolean): LocalRemoteState {
  return { ...getConfig().remote, paired };
}
