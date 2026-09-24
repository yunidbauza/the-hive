import type { ShippedStatus } from '../../electron/shared/shipped-contract';

/** A shipped agent or skill status, as shipped unless `over` says otherwise. */
export const shippedStatus = (over: Partial<ShippedStatus> = {}): ShippedStatus => ({
  kind: 'agents',
  name: 'builder',
  customised: [],
  moved: [],
  files: [],
  bodyEdited: false,
  held: false,
  shippedBody: 'Shipped prompt.\n',
  ...over,
});
