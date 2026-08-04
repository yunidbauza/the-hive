import { describe, expect, it } from 'vitest';

import {
  parseDiagnoseCommandRequest,
  parseSetProjectRuntimeRequest,
  parseSetRuntimeRequest,
} from '../../../electron/shared/guards';

/**
 * Story 104's payload guards.
 *
 * These matter more than most: an env map goes **verbatim into a spawned
 * process's environment**, which is as close to process control as this bridge
 * gets. Story 082's rules apply unchanged — an exact key allowlist, no casts,
 * `__proto__` rejected — and the tests below are written to fail if any of them
 * is relaxed.
 */

describe('parseSetRuntimeRequest', () => {
  it('accepts either field on its own', () => {
    expect(parseSetRuntimeRequest({ shell: '/bin/zsh' })).toEqual({
      shell: '/bin/zsh',
    });
    expect(parseSetRuntimeRequest({ claudeCommand: 'claude' })).toEqual({
      claudeCommand: 'claude',
    });
  });

  it('refuses an empty request', () => {
    // A no-op write is a bug at the call site, not something worth rewriting
    // the whole file for.
    expect(() => parseSetRuntimeRequest({})).toThrow(/nothing to change/);
  });

  it('refuses a blank value — there is no lower level to inherit from', () => {
    expect(() => parseSetRuntimeRequest({ shell: '' })).toThrow(/must not be empty/);
    expect(() => parseSetRuntimeRequest({ shell: null })).toThrow();
  });

  it('refuses control characters and unknown keys', () => {
    expect(() => parseSetRuntimeRequest({ shell: '/bin/z\nsh' })).toThrow(
      /control characters/,
    );
    expect(() => parseSetRuntimeRequest({ shell: '/bin/zsh', nope: 1 })).toThrow(
      /unexpected key/,
    );
  });

  it('refuses __proto__', () => {
    const payload = JSON.parse('{"shell":"/bin/zsh","__proto__":{"x":1}}') as unknown;
    expect(() => parseSetRuntimeRequest(payload)).toThrow(/forbidden key/);
  });
});

describe('parseSetProjectRuntimeRequest', () => {
  it('keeps absent, null and a value distinct', () => {
    // The three-state contract: absent leaves it alone, null removes it, a
    // value sets it. Collapsing any two would make an override unremovable or
    // store "" — which spawns a shell named "".
    expect(parseSetProjectRuntimeRequest({ id: 'a' })).toEqual({ id: 'a' });
    expect(parseSetProjectRuntimeRequest({ id: 'a', shell: null })).toEqual({
      id: 'a',
      shell: null,
    });
    expect(parseSetProjectRuntimeRequest({ id: 'a', shell: '/bin/bash' })).toEqual({
      id: 'a',
      shell: '/bin/bash',
    });
  });

  it('accepts a valid env map', () => {
    const parsed = parseSetProjectRuntimeRequest({
      id: 'a',
      env: { API_URL: 'https://example.test', _FLAG: '', N1: '2' },
    });

    // An empty *value* is legitimate — `FOO=` is a real thing to set.
    expect(parsed.env).toEqual({
      API_URL: 'https://example.test',
      _FLAG: '',
      N1: '2',
    });
  });

  it('accepts null to clear the whole env map', () => {
    expect(parseSetProjectRuntimeRequest({ id: 'a', env: null }).env).toBeNull();
  });

  it('refuses a variable name that is not POSIX-portable', () => {
    for (const bad of ['1FOO', 'FOO-BAR', 'FOO BAR', 'foo.bar', '']) {
      expect(() =>
        parseSetProjectRuntimeRequest({ id: 'a', env: { [bad]: 'x' } }),
      ).toThrow(/not a valid variable name/);
    }
  });

  it('refuses the variables the terminal sets for itself', () => {
    for (const reserved of ['TERM', 'COLORTERM', 'PWD']) {
      // Accepting these would store a setting that `buildEnv` then silently
      // overwrites — worse than refusing it.
      expect(() =>
        parseSetProjectRuntimeRequest({ id: 'a', env: { [reserved]: 'x' } }),
      ).toThrow(/set by the terminal/);
    }
  });

  it('refuses a non-string env value', () => {
    expect(() =>
      parseSetProjectRuntimeRequest({ id: 'a', env: { FOO: 1 } }),
    ).toThrow(/expected a string/);
  });

  it('refuses control characters in an env value', () => {
    expect(() =>
      parseSetProjectRuntimeRequest({ id: 'a', env: { FOO: 'a\nb' } }),
    ).toThrow(/control characters/);
  });

  it('refuses __proto__ as a variable name', () => {
    const payload = JSON.parse(
      '{"id":"a","env":{"__proto__":"x"}}',
    ) as unknown;
    expect(() => parseSetProjectRuntimeRequest(payload)).toThrow(/forbidden key/);
  });

  it('refuses an env that is not an object', () => {
    expect(() => parseSetProjectRuntimeRequest({ id: 'a', env: [] })).toThrow(
      /expected an object/,
    );
  });

  it('caps how many variables one project may declare', () => {
    const env = Object.fromEntries(
      Array.from({ length: 201 }, (_, index) => [`V${index}`, 'x']),
    );
    expect(() => parseSetProjectRuntimeRequest({ id: 'a', env })).toThrow(
      /too many variables/,
    );
  });

  it('requires an id and rejects unknown keys', () => {
    expect(() => parseSetProjectRuntimeRequest({ shell: '/bin/sh' })).toThrow(
      /missing key "id"/,
    );
    expect(() => parseSetProjectRuntimeRequest({ id: 'a', nope: 1 })).toThrow(
      /unexpected key/,
    );
  });
});

describe('parseDiagnoseCommandRequest', () => {
  it('accepts an empty request — that means the top-level command', () => {
    expect(parseDiagnoseCommandRequest({})).toEqual({});
  });

  it('accepts an id', () => {
    expect(parseDiagnoseCommandRequest({ id: 'apfm-web' })).toEqual({
      id: 'apfm-web',
    });
  });

  it('rejects a malformed id and unknown keys', () => {
    expect(() => parseDiagnoseCommandRequest({ id: '../etc' })).toThrow();
    expect(() => parseDiagnoseCommandRequest({ nope: 1 })).toThrow(
      /unexpected key/,
    );
  });
});
