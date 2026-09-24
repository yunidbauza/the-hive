import { useMemo, useSyncExternalStore } from 'react';

import { shippedSnapshot, subscribeShipped } from '@/lib/shipped';

import {
  isCustomised,
  type ShippedKind,
  type ShippedStatus,
} from '@shared/shipped-contract';

/**
 * The shipped agents or skills the user changed, by name.
 *
 * Only the changed ones: a name missing from the map is as shipped, and the
 * pane draws nothing for it.
 */
export function useShipped(kind: ShippedKind): ReadonlyMap<string, ShippedStatus> {
  const list = useSyncExternalStore(subscribeShipped, shippedSnapshot, shippedSnapshot);

  return useMemo(
    () =>
      new Map(
        (list ?? [])
          .filter((status) => status.kind === kind && isCustomised(status))
          .map((status) => [status.name, status]),
      ),
    [list, kind],
  );
}
