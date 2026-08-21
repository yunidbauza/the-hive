// @vitest-environment node
import { describe, expect, it } from 'vitest';

import {
  IpcValidationError,
  parseMarkReadRequest,
  parseNotificationAction,
  parseSetNotificationsRequest,
} from '../../../electron/shared/guards';

/**
 * Story 106's payload guard, widened by HIVE-75.
 *
 * The payload grew from three booleans to a per-kind delivery, and story 082's
 * rules did not relax to meet it: an exact key allowlist, no coercion,
 * `__proto__` rejected. The reasoning behind the no-coercion rule is *stronger*
 * now — a delivery has three values, so a coerced one can land on the wrong
 * setting rather than merely the opposite one.
 */

describe('parseMarkReadRequest', () => {
  it('accepts an id, and null for all of them', () => {
    expect(parseMarkReadRequest('n1')).toBe('n1');
    expect(parseMarkReadRequest(null)).toBeNull();
  });

  /**
   * Coercing rather than rejecting turns a single dismissal into clearing the
   * whole inbox — the loudest possible outcome from the quietest possible bug.
   */
  it('refuses anything else rather than coercing it to "all"', () => {
    expect(() => parseMarkReadRequest(undefined)).toThrow(/expected a notification id/);
    expect(() => parseMarkReadRequest(0)).toThrow(/expected a notification id/);
    expect(() => parseMarkReadRequest('')).toThrow(/expected a notification id/);
    expect(() => parseMarkReadRequest({})).toThrow(/expected a notification id/);
  });
});

describe('parseSetNotificationsRequest', () => {
  it('accepts a single kind', () => {
    expect(parseSetNotificationsRequest({ 'session.blocked': 'off' })).toEqual({
      'session.blocked': 'off',
    });
    expect(parseSetNotificationsRequest({ 'clone.done': 'inbox' })).toEqual({
      'clone.done': 'inbox',
    });
  });

  it('accepts several at once', () => {
    expect(
      parseSetNotificationsRequest({
        'session.blocked': 'both',
        'session.input_needed': 'off',
      }),
    ).toEqual({ 'session.blocked': 'both', 'session.input_needed': 'off' });
  });

  it('refuses an empty request', () => {
    expect(() => parseSetNotificationsRequest({})).toThrow(/nothing to change/);
  });

  it('refuses a value outside the delivery set rather than coercing it', () => {
    expect(() =>
      parseSetNotificationsRequest({ 'session.blocked': 'loud' }),
    ).toThrow(/expected one of/);
    // A boolean is what this payload used to carry, which makes it the most
    // likely wrong value to arrive — and truthiness would make it "on".
    expect(() =>
      parseSetNotificationsRequest({ 'session.blocked': true }),
    ).toThrow(/expected one of/);
    expect(() =>
      parseSetNotificationsRequest({ 'session.blocked': null }),
    ).toThrow(/expected one of/);
  });

  /** The legacy names are not writable — only readable, by the migration. */
  it('refuses an unknown key, including the booleans this shape replaced', () => {
    expect(() => parseSetNotificationsRequest({ sessionDone: 'off' })).toThrow(
      /unexpected key/,
    );
    expect(() => parseSetNotificationsRequest({ 'slack.mention': 'both' })).toThrow(
      /unexpected key/,
    );
  });

  /**
   * HIVE-83: the four kinds it merged or removed are readable off an old file
   * — `parse.ts`'s `LEGACY_NOTIFICATION_KEYS` sees to that — but they are not
   * writable. There is no live switch left for the running app to set.
   */
  it('refuses the four kinds HIVE-83 merged or removed', () => {
    for (const key of [
      'session.waiting',
      'session.asked',
      'session.ended',
      'session.idle',
    ]) {
      expect(() => parseSetNotificationsRequest({ [key]: 'off' })).toThrow(
        /unexpected key/,
      );
    }
  });

  it('refuses __proto__', () => {
    const payload = JSON.parse(
      '{"session.blocked":"off","__proto__":{"x":1}}',
    ) as unknown;

    expect(() => parseSetNotificationsRequest(payload)).toThrow(/forbidden key/);
  });

  it('refuses a payload that is not an object', () => {
    expect(() => parseSetNotificationsRequest(null)).toThrow(IpcValidationError);
    expect(() => parseSetNotificationsRequest([])).toThrow(IpcValidationError);
    expect(() => parseSetNotificationsRequest('session.blocked')).toThrow(
      IpcValidationError,
    );
  });
});

/**
 * The `notifications:act` payload.
 *
 * The one guard here that answers `null` instead of throwing, because its
 * caller is a *click*: the worst honest outcome of an action main cannot read
 * is that nothing happens, and rejecting the promise would only give the
 * renderer something to log.
 */
describe('parseNotificationAction', () => {
  it('accepts the data-free actions verbatim', () => {
    expect(parseNotificationAction({ type: 'none' })).toEqual({ type: 'none' });
    expect(parseNotificationAction({ type: 'update.download' })).toEqual({
      type: 'update.download',
    });
    expect(parseNotificationAction({ type: 'update.install' })).toEqual({
      type: 'update.install',
    });
  });

  it('requires a non-empty entity id on a session action', () => {
    expect(parseNotificationAction({ type: 'session', entityId: 't1' })).toEqual({
      type: 'session',
      entityId: 't1',
    });
    expect(parseNotificationAction({ type: 'session', entityId: '' })).toBeNull();
    expect(parseNotificationAction({ type: 'session' })).toBeNull();
    expect(parseNotificationAction({ type: 'session', entityId: 7 })).toBeNull();
  });

  it('checks a url for shape only — whether it is safe to open is decided at the point of opening', () => {
    // Deliberately not a second allowlist. `isSafeExternalUrl` owns that
    // policy, and two copies of it would be two policies that can disagree.
    expect(
      parseNotificationAction({ type: 'url', url: 'file:///etc/passwd' }),
    ).toEqual({ type: 'url', url: 'file:///etc/passwd' });
    expect(parseNotificationAction({ type: 'url', url: '' })).toBeNull();
  });

  it('drops anything it does not recognise, including a stray extra field', () => {
    expect(parseNotificationAction(null)).toBeNull();
    expect(parseNotificationAction('update.install')).toBeNull();
    expect(parseNotificationAction([{ type: 'none' }])).toBeNull();
    expect(parseNotificationAction({ type: 'shell', cmd: 'rm -rf /' })).toBeNull();
    // A recognised type keeps only what the union declares — the extra field
    // is not copied through.
    expect(
      parseNotificationAction({ type: 'update.install', cmd: 'rm -rf /' }),
    ).toEqual({ type: 'update.install' });
  });
});
