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
      Hydrate first, then subscribe — and accept that an entry landing between
      the two is delivered twice rather than not at all. `id` is unique and the
      store appends, so a duplicate is visible and fixable; a dropped entry is
      neither.
    */
    void ledger.list().then((snapshot) => hydrate(snapshot.entries));

    return ledger.onChanged(append);
  }, [hydrate, append]);
}
