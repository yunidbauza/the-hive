import type {
  HiveNotification,
  NotificationKind,
} from '@shared/notification-contract';

/**
 * A notification, with everything a test does not care about already filled in.
 *
 * Ids are **explicit by default and unique by counter**, because identity is now
 * load-bearing: the store dedups on it and `markRead` addresses by it. A helper
 * that reused one id would make "two notifications" silently mean "one", which
 * is exactly the bug the dedup is there to cause on purpose.
 */
let seq = 0;

export function notif(
  overrides: Partial<HiveNotification> = {},
): HiveNotification {
  seq += 1;
  return {
    id: `n${seq}`,
    kind: 'session.waiting' as NotificationKind,
    title: 'lead-form needs approval',
    body: 'prisma migrate dev — lead_phone_idx',
    // Fixed rather than `Date.now()`: a relative label computed against a
    // moving clock is a test that fails at a minute boundary.
    createdAt: 1_700_000_000_000,
    unread: true,
    action: { type: 'session', entityId: 'lead-form' },
    ...overrides,
  };
}

/** Reset the counter so ids are predictable within a file. */
export function resetNotifIds(): void {
  seq = 0;
}
