/**
 * The inbox's types, which are now the contract's (HIVE-75).
 *
 * This file used to *declare* the notification, as a presentation record with
 * an icon, a tone, a `sub` line and a pre-formatted `time` string. That shape
 * was right for a fixture and wrong for an event: nothing in it could be
 * sorted, deduped, aged or subscribed to, and `time` was a clock that stopped
 * the moment the fixture was written.
 *
 * The declaration moved to `electron/shared/notification-contract.ts`, because
 * the producer is now the **main process** and a type only one side knows is
 * not a contract. This module stays as the renderer's door onto it, so feature
 * code keeps importing `@/types/notification` and never reaches across the
 * process boundary for a shape by hand.
 *
 * `Tone` is re-exported rather than redeclared for the same reason: a
 * notification's tone is decided by its kind, in the registry, and a second
 * definition here would be a second place for the two to drift apart.
 */
export type {
  HiveNotification,
  NotificationAction,
  NotificationDelivery,
  NotificationKind,
  NotificationSource,
  Tone,
} from '@shared/notification-contract';

export {
  NOTIFICATION_KIND_SPECS,
  NOTIFICATION_KINDS,
  NOTIFICATION_SOURCE_LABELS,
  NOTIFICATION_SOURCE_ORDER,
  kindsForSource,
} from '@shared/notification-contract';
