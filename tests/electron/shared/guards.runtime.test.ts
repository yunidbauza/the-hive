import { describe, expect, it } from 'vitest';

import {
  parseDiagnoseCommandRequest,
  parseDiagnoseEnvRequest,
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

  it('accepts importLoginEnv on its own, in both positions', () => {
    expect(parseSetRuntimeRequest({ importLoginEnv: true })).toEqual({
      importLoginEnv: true,
    });
    // `false` is a value, not an absence — a guard that treated it as one
    // would make the switch impossible to turn off (HIVE-84).
    expect(parseSetRuntimeRequest({ importLoginEnv: false })).toEqual({
      importLoginEnv: false,
    });
  });

  it('refuses a coerced boolean rather than guessing what was meant', () => {
    // `Boolean('false')` is `true`. For a switch that governs whether this app
    // runs the user's rc file, silently inverting is the wrong leniency.
    expect(() => parseSetRuntimeRequest({ importLoginEnv: 'false' })).toThrow(
      /expected a boolean/,
    );
    expect(() => parseSetRuntimeRequest({ importLoginEnv: 0 })).toThrow(
      /expected a boolean/,
    );
    expect(() => parseSetRuntimeRequest({ importLoginEnv: null })).toThrow(
      /expected a boolean/,
    );
  });
});

describe('parseSetRuntimeRequest env', () => {
  it('accepts a valid map', () => {
    expect(parseSetRuntimeRequest({ env: { AWS_PROFILE: 'incorp' } })).toEqual({
      env: { AWS_PROFILE: 'incorp' },
    });
  });

  it('accepts an empty map — that is how the last variable is removed', () => {
    expect(parseSetRuntimeRequest({ env: {} })).toEqual({ env: {} });
  });

  /*
    Split by refusal *category*, not lumped under a bare `.toThrow()`. This is
    the same rule as the project-layer tests below (`refuses the dynamic-loader
    variables`, `refuses the interpreter hooks`, `refuses the variables the
    terminal sets for itself`): `assertEnv` calls the *same* `unsafeEnvReason`
    those tests pin, and a bare `.toThrow()` here cannot tell "refused for the
    right reason" apart from "refused because of an unrelated bug" — e.g. a
    typo that failed `ENV_NAME` instead of the dynamic-loader check. On a
    security boundary the category is the actual contract, not just "it threw".
  */
  it('refuses the dynamic-loader variables', () => {
    for (const key of ['LD_PRELOAD', 'DYLD_INSERT_LIBRARIES']) {
      expect(() => parseSetRuntimeRequest({ env: { [key]: 'x' } })).toThrow(
        /dynamic loader/,
      );
    }
  });

  it('refuses the interpreter hooks', () => {
    for (const key of ['NODE_OPTIONS', 'BASH_ENV']) {
      expect(() => parseSetRuntimeRequest({ env: { [key]: 'x' } })).toThrow(
        /run code/,
      );
    }
  });

  it('refuses the variables the terminal sets for itself', () => {
    for (const key of ['TERM', 'COLORTERM', 'PWD']) {
      expect(() => parseSetRuntimeRequest({ env: { [key]: 'x' } })).toThrow(
        /set by the terminal/,
      );
    }
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

  /**
   * The same rule, applied to the names HIVE-64 added to the pty-host deny-list.
   *
   * `buildEnv` filters `injected` as well as the ambient copy, so without this
   * guard a `CLAUDE_*` entry would save, render as set in the runtime pane, and
   * then be dropped on every spawn — the user watching `claude` ignore a setting
   * the UI insists is applied. Stripped there, refused here, one list shared.
   */
  it('refuses the variables that identify a Claude session (HIVE-64)', () => {
    for (const identity of [
      'CLAUDECODE',
      'CLAUDE_CODE_SESSION_ID',
      'CLAUDE_CODE_CHILD_SESSION',
      'CLAUDE_CONFIG_DIR',
    ]) {
      expect(() =>
        parseSetProjectRuntimeRequest({ id: 'a', env: { [identity]: 'x' } }),
      ).toThrow(/identifies a Claude session/);
    }
  });

  it('leaves a name that merely starts with CLAUDE alone', () => {
    // `CLAUDE_` is a prefix, not a substring match, and `CLAUDECODE` is exact.
    // A user variable like `CLAUDEISH` is neither and must still be settable.
    expect(
      parseSetProjectRuntimeRequest({ id: 'a', env: { CLAUDEISH: 'x' } }).env,
    ).toEqual({ CLAUDEISH: 'x' });
  });

  /**
   * The finding that mattered most in review.
   *
   * Per-project env is the first user-reachable path into `buildEnv`'s
   * `injected` argument — before story 104 it was always `{}`. These variables
   * make the OS load arbitrary shared libraries into every process the spawned
   * shell forks, which is native code execution. Story 082's posture is that
   * the renderer is untrusted, so a compromised renderer that can write the
   * config must not thereby be able to run native code.
   */
  it('refuses the dynamic-loader variables', () => {
    for (const key of [
      'LD_PRELOAD',
      'LD_LIBRARY_PATH',
      'LD_AUDIT',
      'DYLD_INSERT_LIBRARIES',
      'DYLD_LIBRARY_PATH',
      'DYLD_FRAMEWORK_PATH',
    ]) {
      expect(() =>
        parseSetProjectRuntimeRequest({ id: 'a', env: { [key]: '/tmp/evil.so' } }),
      ).toThrow(/dynamic loader/);
    }
  });

  it('refuses the interpreter hooks', () => {
    for (const key of [
      'NODE_OPTIONS',
      'NODE_PATH',
      'BASH_ENV',
      'ELECTRON_RUN_AS_NODE',
    ]) {
      expect(() =>
        parseSetProjectRuntimeRequest({ id: 'a', env: { [key]: 'x' } }),
      ).toThrow(/run code/);
    }
  });

  it('still allows ordinary variables that merely start with a letter pair', () => {
    // The rule is a prefix match on LD_/DYLD_, not a substring one — refusing
    // `LDAP_URL` or `OLD_PATH` would be a bug in the other direction.
    expect(
      parseSetProjectRuntimeRequest({
        id: 'a',
        env: { LDAP_URL: 'ldap://x', OLD_PATH: '/tmp' },
      }).env,
    ).toEqual({ LDAP_URL: 'ldap://x', OLD_PATH: '/tmp' });
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

describe('parseDiagnoseEnvRequest', () => {
  it('accepts an empty request — that means the top-level env', () => {
    expect(parseDiagnoseEnvRequest({})).toEqual({});
  });

  it('accepts an id', () => {
    expect(parseDiagnoseEnvRequest({ id: 'apfm-web' })).toEqual({
      id: 'apfm-web',
    });
  });

  it('rejects a malformed id and unknown keys', () => {
    expect(() => parseDiagnoseEnvRequest({ id: '../etc' })).toThrow();
    expect(() => parseDiagnoseEnvRequest({ nope: 1 })).toThrow(/unexpected key/);
  });
});
