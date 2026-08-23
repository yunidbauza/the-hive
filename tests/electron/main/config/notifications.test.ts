// @vitest-environment node
import { describe, expect, it } from 'vitest';

import { parseConfig } from '../../../../electron/main/config/parse';
import { DEFAULT_NOTIFICATIONS } from '../../../../electron/shared/config-contract';
import {
  NOTIFICATION_KINDS,
  NOTIFICATION_KIND_SPECS,
} from '../../../../electron/shared/notification-contract';

/**
 * Reading notification preferences (story 106, widened by HIVE-75).
 *
 * The block is optional on every existing file, so the load-bearing case is
 * still the one where it is absent. HIVE-75 adds a second: a file written
 * *before* it, holding the three booleans, which must keep meaning what it
 * meant.
 */

const LABEL = 'config';

describe('DEFAULT_NOTIFICATIONS', () => {
  it('answers for every registered kind, at its registry default', () => {
    expect(Object.keys(DEFAULT_NOTIFICATIONS).sort()).toEqual(
      [...NOTIFICATION_KINDS].sort(),
    );

    for (const kind of NOTIFICATION_KINDS) {
      expect(DEFAULT_NOTIFICATIONS[kind], kind).toBe(
        NOTIFICATION_KIND_SPECS[kind].defaultDelivery,
      );
    }
  });
});

describe('parseConfig — notifications', () => {
  it('is absent on a file that has never had one', () => {
    const parsed = parseConfig('{"version":2}', LABEL);

    expect(parsed.notifications).toBeUndefined();
    expect(parsed.errors).toEqual([]);
  });

  it('is absent on a v1 file, which cannot have had one', () => {
    const parsed = parseConfig('{"version":1,"projects":[]}', LABEL);

    expect(parsed.notifications).toBeUndefined();
    expect(parsed.errors).toEqual([]);
  });

  it('reads a partial block without inventing the keys it omits', () => {
    const parsed = parseConfig(
      '{"version":2,"notifications":{"session.blocked":"off"}}',
      LABEL,
    );

    expect(parsed.notifications).toEqual({ 'session.blocked': 'off' });
    expect(parsed.errors).toEqual([]);
  });

  it('reads several kinds when the file names several', () => {
    const parsed = parseConfig(
      '{"version":2,"notifications":{"session.blocked":"off","clone.done":"inbox"}}',
      LABEL,
    );

    expect(parsed.notifications).toEqual({
      'session.blocked': 'off',
      'clone.done': 'inbox',
    });
    expect(parsed.errors).toEqual([]);
  });

  /**
   * HIVE-83: the kinds it merged or removed are still *accepted*, via
   * `LEGACY_NOTIFICATION_KEYS`, so a config naming one does not lose every
   * other preference — but nothing reads their value back out. There is
   * nowhere left for it to go.
   */
  it('accepts a retired kind name without erroring, and drops its value', () => {
    const parsed = parseConfig(
      '{"version":2,"notifications":{"session.ended":"off","clone.done":"inbox"}}',
      LABEL,
    );

    expect(parsed.errors).toEqual([]);
    expect(parsed.notifications).toEqual({ 'clone.done': 'inbox' });
  });

  /**
   * HIVE-89: `session.idle` is a live kind again, so a HIVE-75-era delivery
   * for it is read as the user's choice rather than dropped.
   */
  it('reads an old session.idle delivery as a live preference', () => {
    const parsed = parseConfig(
      '{"version":2,"notifications":{"session.idle":"off","clone.done":"inbox"}}',
      LABEL,
    );

    expect(parsed.errors).toEqual([]);
    expect(parsed.notifications).toEqual({
      'session.idle': 'off',
      'clone.done': 'inbox',
    });
  });

  /**
   * The regression this file exists to prevent.
   *
   * The migration lives in `resolveNotificationPrefs`, and this parser is what
   * stands between the file and it. Filtering the legacy keys out here — which
   * the first cut of HIVE-75 did — left the migration correct and starved: a
   * user who had switched session notifications off got them back on.
   */
  it('carries the legacy booleans through for the migration to read', () => {
    const parsed = parseConfig(
      '{"version":2,"notifications":{"sessionDone":false,"cloneDone":true}}',
      LABEL,
    );

    expect(parsed.notifications).toEqual({
      sessionDone: false,
      cloneDone: true,
    });
    expect(parsed.errors).toEqual([]);
  });

  /**
   * Review Fix 8. `session.waiting` and `session.asked` are the two retired
   * keys that still have somewhere to go — HIVE-83 merged them into
   * `session.blocked` — so unlike `session.ended`/`session.idle` their
   * `NotificationDelivery` value must survive the parser, not just their
   * presence.
   */
  it('carries a retired session.waiting/session.asked delivery through for the migration to read', () => {
    const parsed = parseConfig(
      '{"version":2,"notifications":{"session.waiting":"off","session.asked":"both"}}',
      LABEL,
    );

    expect(parsed.notifications).toEqual({
      'session.waiting': 'off',
      'session.asked': 'both',
    });
    expect(parsed.errors).toEqual([]);
  });

  it('does not report the legacy names as unknown keys', () => {
    const parsed = parseConfig(
      '{"version":2,"notifications":{"sessionIdle":true}}',
      LABEL,
    );

    expect(parsed.errors).toEqual([]);
  });

  it('no longer reports notifications as an unknown top-level key', () => {
    const parsed = parseConfig(
      '{"version":2,"notifications":{"clone.done":"off"}}',
      LABEL,
    );

    expect(parsed.errors).toEqual([]);
  });

  it('reports a value outside the delivery set rather than coercing it', () => {
    const parsed = parseConfig(
      '{"version":2,"notifications":{"session.blocked":"yes"}}',
      LABEL,
    );

    expect(parsed.errors).toContain(
      'config.notifications.session.blocked: expected one of off, inbox, both — using the default',
    );
    expect(parsed.notifications).toEqual({});
  });

  it('keeps the good keys when one is bad — a typo is not a reason to lose the rest', () => {
    const parsed = parseConfig(
      '{"version":2,"notifications":{"session.blocked":"yes","clone.done":"off"}}',
      LABEL,
    );

    expect(parsed.notifications).toEqual({ 'clone.done': 'off' });
    expect(parsed.errors).toHaveLength(1);
  });

  /**
   * A malformed value on a *retired* key is not worth an error either — the
   * legacy loop only ever reads a boolean off it, and a string like `"yes"`
   * is simply not one.
   */
  it('reports nothing for a malformed value on a retired key', () => {
    const parsed = parseConfig(
      '{"version":2,"notifications":{"session.ended":"yes"}}',
      LABEL,
    );

    expect(parsed.errors).toEqual([]);
    expect(parsed.notifications).toEqual({});
  });

  it('reports an unknown key inside the block', () => {
    const parsed = parseConfig(
      '{"version":2,"notifications":{"slack.mention":"both"}}',
      LABEL,
    );

    expect(parsed.errors.join(' ')).toMatch(/slack\.mention/);
  });
});
