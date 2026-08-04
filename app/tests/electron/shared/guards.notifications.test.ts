// @vitest-environment node
import { describe, expect, it } from 'vitest';

import {
  IpcValidationError,
  parseSetNotificationsRequest,
} from '../../../electron/shared/guards';

/**
 * Story 106's payload guard.
 *
 * Three booleans is the smallest payload on the bridge, which is exactly why
 * it is worth a guard of its own rather than a cast: story 082's rules do not
 * get relaxed because a payload looks harmless. An exact key allowlist, no
 * coercion, `__proto__` rejected.
 */

describe('parseSetNotificationsRequest', () => {
  it('accepts each field on its own', () => {
    expect(parseSetNotificationsRequest({ sessionDone: false })).toEqual({
      sessionDone: false,
    });
    expect(parseSetNotificationsRequest({ sessionIdle: true })).toEqual({
      sessionIdle: true,
    });
    expect(parseSetNotificationsRequest({ cloneDone: false })).toEqual({
      cloneDone: false,
    });
  });

  it('accepts all three at once', () => {
    expect(
      parseSetNotificationsRequest({
        sessionDone: false,
        sessionIdle: true,
        cloneDone: false,
      }),
    ).toEqual({ sessionDone: false, sessionIdle: true, cloneDone: false });
  });

  it('refuses an empty request', () => {
    expect(() => parseSetNotificationsRequest({})).toThrow(/nothing to change/);
  });

  it('refuses a non-boolean rather than coercing it', () => {
    // `'false'` is truthy, so a coercing guard would turn the user switching a
    // class off into switching it on.
    expect(() => parseSetNotificationsRequest({ sessionDone: 'false' })).toThrow(
      /expected a boolean/,
    );
    expect(() => parseSetNotificationsRequest({ sessionDone: 1 })).toThrow(
      /expected a boolean/,
    );
    expect(() => parseSetNotificationsRequest({ sessionDone: null })).toThrow(
      /expected a boolean/,
    );
  });

  it('refuses an unknown key — including the class that does not exist yet', () => {
    expect(() => parseSetNotificationsRequest({ waiting: true })).toThrow(
      /unexpected key/,
    );
  });

  it('refuses __proto__', () => {
    const payload = JSON.parse(
      '{"sessionDone":true,"__proto__":{"x":1}}',
    ) as unknown;

    expect(() => parseSetNotificationsRequest(payload)).toThrow(/forbidden key/);
  });

  it('refuses a payload that is not an object', () => {
    expect(() => parseSetNotificationsRequest(null)).toThrow(IpcValidationError);
    expect(() => parseSetNotificationsRequest([])).toThrow(IpcValidationError);
    expect(() => parseSetNotificationsRequest('sessionDone')).toThrow(
      IpcValidationError,
    );
  });
});
