// @vitest-environment node
import { describe, expect, it } from 'vitest';

import {
  IpcValidationError,
  parseMarkReadRequest,
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
    expect(parseSetNotificationsRequest({ 'session.waiting': 'off' })).toEqual({
      'session.waiting': 'off',
    });
    expect(parseSetNotificationsRequest({ 'clone.done': 'inbox' })).toEqual({
      'clone.done': 'inbox',
    });
  });

  it('accepts several at once', () => {
    expect(
      parseSetNotificationsRequest({
        'session.ended': 'both',
        'session.idle': 'off',
      }),
    ).toEqual({ 'session.ended': 'both', 'session.idle': 'off' });
  });

  it('refuses an empty request', () => {
    expect(() => parseSetNotificationsRequest({})).toThrow(/nothing to change/);
  });

  it('refuses a value outside the delivery set rather than coercing it', () => {
    expect(() =>
      parseSetNotificationsRequest({ 'session.waiting': 'loud' }),
    ).toThrow(/expected one of/);
    // A boolean is what this payload used to carry, which makes it the most
    // likely wrong value to arrive — and truthiness would make it "on".
    expect(() =>
      parseSetNotificationsRequest({ 'session.waiting': true }),
    ).toThrow(/expected one of/);
    expect(() =>
      parseSetNotificationsRequest({ 'session.waiting': null }),
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

  it('refuses __proto__', () => {
    const payload = JSON.parse(
      '{"session.waiting":"off","__proto__":{"x":1}}',
    ) as unknown;

    expect(() => parseSetNotificationsRequest(payload)).toThrow(/forbidden key/);
  });

  it('refuses a payload that is not an object', () => {
    expect(() => parseSetNotificationsRequest(null)).toThrow(IpcValidationError);
    expect(() => parseSetNotificationsRequest([])).toThrow(IpcValidationError);
    expect(() => parseSetNotificationsRequest('session.waiting')).toThrow(
      IpcValidationError,
    );
  });
});
