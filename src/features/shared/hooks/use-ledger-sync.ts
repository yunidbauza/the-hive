import { useEffect } from 'react';

import { useHydrateLedger, useLedgerAppend } from '@stores/hive-store';

/**
 * Keep the renderer's mirror of the ledger current (HIVE-111).
 *
 * Mounted once, at the composition root, for the reason `useSessionStatus` is:
 * `ledger:changed` is a broadcast, and a per-consumer subscription would mean
 * one listener per card for one channel.
 *
 * On the browser target there is no bridge and this does nothing — the same
 * shape every desktop-only subscription in the app takes.
 */
export function useLedgerSync(): void {
  const hydrate = useHydrateLedger();
  const append = useLedgerAppend();

  useEffect(() => {
    const ledger = window.hive?.ledger;
    if (ledger === undefined) return;

    /*
      Subscribe first, then hydrate, and let the two overlap: an entry
      appended after main took its snapshot arrives on the channel, and an
      entry from before it arrives in the snapshot. `hydrateLedger` merges by
      `id` rather than replacing, so neither order loses one and the overlap
      costs nothing — which matters because this hook mounts once and never
      remounts, so a dropped entry would never be re-fetched.
    */
    const stop = ledger.onChanged(append);
    void ledger.list().then((snapshot) => hydrate(snapshot.entries));

    return stop;
  }, [hydrate, append]);
}
