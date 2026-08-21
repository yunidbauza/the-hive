// @vitest-environment node
import { describe, expect, it } from 'vitest';

import { parseConfig } from '../../../../electron/main/config/parse';

/**
 * Shape validation for `~/.hive/config.json` (stories 090, 101).
 *
 * `parseConfig` is pure — a string in, a verdict out — so these tests need no
 * filesystem at all. That split is the reason the one module that touches `fs`
 * stays small enough to read.
 *
 * Story 101 adds two things worth testing directly: the reader now accepts
 * **two** schema versions, and it distinguishes a file it rejected *wholesale*
 * from one it merely complained about. The write path depends on that
 * distinction — see the `fatal` cases below.
 */

describe('parseConfig — schema versions', () => {
  it('accepts version 1 and reports it', () => {
    const parsed = parseConfig(
      JSON.stringify({ version: 1, projects: [{ id: 'a', path: '~/a' }] }),
      'config',
    );

    expect(parsed.version).toBe(1);
    expect(parsed.fatal).toBe(false);
    expect(parsed.projects).toEqual([{ id: 'a', path: '~/a' }]);
  });

  it('accepts version 2 with the new entry fields', () => {
    const parsed = parseConfig(
      JSON.stringify({
        version: 2,
        projects: [
          {
            id: 'a',
            name: 'Alpha',
            path: '~/a',
            icon: 'ph-folder',
            origin: 'local',
          },
        ],
      }),
      'config',
    );

    expect(parsed.version).toBe(2);
    expect(parsed.fatal).toBe(false);
    expect(parsed.projects[0]).toEqual({
      id: 'a',
      name: 'Alpha',
      path: '~/a',
      icon: 'ph-folder',
      origin: 'local',
    });
  });

  it('refuses an unsupported version and marks it fatal', () => {
    const parsed = parseConfig(JSON.stringify({ version: 3 }), 'config');

    expect(parsed.fatal).toBe(true);
    expect(parsed.errors[0]).toMatch(/unsupported version 3/);
  });

  it('refuses a non-numeric version', () => {
    const parsed = parseConfig(JSON.stringify({ version: '2' }), 'config');

    expect(parsed.fatal).toBe(true);
    expect(parsed.errors[0]).toMatch(/unsupported version/);
  });
});

describe('parseConfig — importLoginEnv (HIVE-84)', () => {
  it('reads the key, and distinguishes an explicit false from silence', () => {
    const off = parseConfig(
      JSON.stringify({ version: 2, importLoginEnv: false }),
      'config',
    );
    expect(off.importLoginEnv).toBe(false);
    // Listed as a known key, so a hand-written one is read rather than
    // reported — the courtesy every other top-level key gets.
    expect(off.errors).toEqual([]);

    const on = parseConfig(
      JSON.stringify({ version: 2, importLoginEnv: true }),
      'config',
    );
    expect(on.importLoginEnv).toBe(true);

    // `null` means "the file did not say", which `loadConfig` resolves to the
    // default. Distinct from `false`, which is a user's decision.
    expect(parseConfig(JSON.stringify({ version: 2 }), 'config').importLoginEnv).toBeNull();
  });

  it('reports a non-boolean rather than coercing it', () => {
    const parsed = parseConfig(
      JSON.stringify({ version: 2, importLoginEnv: 'yes' }),
      'config',
    );
    expect(parsed.errors.join('\n')).toMatch(/importLoginEnv/);
    expect(parsed.importLoginEnv).toBeNull();
  });
});

describe('parseConfig — fatal versus advisory', () => {
  it('marks malformed JSON fatal', () => {
    expect(parseConfig('{oops', 'config').fatal).toBe(true);
  });

  it('marks a non-object top level fatal', () => {
    expect(parseConfig('[]', 'config').fatal).toBe(true);
  });

  it('marks a forbidden key fatal', () => {
    expect(parseConfig('{"__proto__":{}}', 'config').fatal).toBe(true);
  });

  /**
   * The distinction the write path is built on.
   *
   * An unknown top-level key is reported and the rest of the file still
   * applies. If this were fatal, a config carrying one — exactly the key story
   * 101 promises to preserve across a write — could never be written again.
   */
  it('tolerates an unknown top-level key without being fatal', () => {
    const parsed = parseConfig(
      JSON.stringify({ version: 2, future: 'x', projects: [] }),
      'config',
    );

    expect(parsed.fatal).toBe(false);
    expect(parsed.errors[0]).toMatch(/unknown key "future"/);
  });

  it('tolerates a rejected entry without being fatal', () => {
    const parsed = parseConfig(
      JSON.stringify({
        version: 2,
        projects: [{ id: 'good', path: '~/a' }, { id: 'bad' }],
      }),
      'config',
    );

    expect(parsed.fatal).toBe(false);
    expect(parsed.projects).toHaveLength(1);
    expect(parsed.projects[0].id).toBe('good');
  });
});

describe('parseConfig — the new entry fields', () => {
  it('leaves name, icon and origin absent when the file omits them', () => {
    const parsed = parseConfig(
      JSON.stringify({ version: 2, projects: [{ id: 'a', path: '~/a' }] }),
      'config',
    );

    // Absent, not `undefined`-valued: an own key the user never wrote would be
    // reported as unknown on the next round trip.
    expect(Object.keys(parsed.projects[0])).toEqual(['id', 'path']);
  });

  it('rejects an entry whose origin is not a known value', () => {
    const parsed = parseConfig(
      JSON.stringify({
        version: 2,
        projects: [{ id: 'a', path: '~/a', origin: 'nope' }],
      }),
      'config',
    );

    expect(parsed.projects).toEqual([]);
    expect(parsed.errors.some((error) => /origin/.test(error))).toBe(true);
  });

  it('rejects an empty name and an empty icon', () => {
    const name = parseConfig(
      JSON.stringify({ version: 2, projects: [{ id: 'a', path: '~/a', name: '  ' }] }),
      'config',
    );
    expect(name.projects).toEqual([]);
    expect(name.errors.some((error) => /name/.test(error))).toBe(true);

    const icon = parseConfig(
      JSON.stringify({ version: 2, projects: [{ id: 'a', path: '~/a', icon: '' }] }),
      'config',
    );
    expect(icon.projects).toEqual([]);
    expect(icon.errors.some((error) => /icon/.test(error))).toBe(true);
  });
});

describe('per-project runtime overrides (story 104)', () => {
  it('reads shell, claudeCommand and env off an entry', () => {
    const result = parseConfig(
      JSON.stringify({
        version: 2,
        projects: [
          {
            id: 'a',
            path: '/tmp/a',
            shell: '/bin/bash',
            claudeCommand: '/opt/claude',
            env: { API_URL: 'https://x.test', EMPTY: '' },
          },
        ],
      }),
      'config',
    );

    expect(result.errors).toEqual([]);
    expect(result.projects[0]).toMatchObject({
      shell: '/bin/bash',
      claudeCommand: '/opt/claude',
      env: { API_URL: 'https://x.test', EMPTY: '' },
    });
  });

  it('leaves the keys absent when the entry omits them', () => {
    const result = parseConfig(
      JSON.stringify({ version: 2, projects: [{ id: 'a', path: '/tmp/a' }] }),
      'config',
    );

    // Absence is the meaningful state: it is what "inherit" looks like.
    expect('shell' in (result.projects[0] ?? {})).toBe(false);
    expect('env' in (result.projects[0] ?? {})).toBe(false);
  });

  it('no longer reports them as unknown keys', () => {
    const result = parseConfig(
      JSON.stringify({
        version: 2,
        projects: [{ id: 'a', path: '/tmp/a', shell: '/bin/bash' }],
      }),
      'config',
    );

    expect(result.errors).toEqual([]);
  });

  it('drops a blank override rather than storing an empty command', () => {
    const result = parseConfig(
      JSON.stringify({
        version: 2,
        projects: [{ id: 'a', path: '/tmp/a', shell: '   ' }],
      }),
      'config',
    );

    // An empty override is not a command; inheriting beats spawning "".
    expect(result.errors[0]).toMatch(/shell: expected a non-empty string/);
    expect('shell' in (result.projects[0] ?? {})).toBe(false);
  });

  it('rejects the whole env map on any bad member', () => {
    const bad = [
      { env: { '1FOO': 'x' }, match: /not a valid variable name/ },
      { env: { TERM: 'x' }, match: /set by the terminal/ },
      { env: { FOO: 1 }, match: /expected a string/ },
    ];

    for (const { env, match } of bad) {
      const result = parseConfig(
        JSON.stringify({ version: 2, projects: [{ id: 'a', path: '/tmp/a', env }] }),
        'config',
      );

      // All-or-nothing: an env map is a set of assumptions a command runs
      // under, and running with half of them is stranger than running with none.
      expect(result.errors.some((error) => match.test(error))).toBe(true);
      expect('env' in (result.projects[0] ?? {})).toBe(false);
    }
  });

  it('ignores an env that is not an object', () => {
    const result = parseConfig(
      JSON.stringify({
        version: 2,
        projects: [{ id: 'a', path: '/tmp/a', env: ['NOPE'] }],
      }),
      'config',
    );

    expect(result.errors.some((error) => /env: expected an object/.test(error))).toBe(
      true,
    );
    expect('env' in (result.projects[0] ?? {})).toBe(false);
  });

  it('refuses the file when an env key is __proto__', () => {
    const result = parseConfig(
      '{"version":2,"projects":[{"id":"a","path":"/tmp/a","env":{"__proto__":"x"}}]}',
      'config',
    );

    expect(result.errors.some((error) => /forbidden key/.test(error))).toBe(true);
    expect('env' in (result.projects[0] ?? {})).toBe(false);
  });
});

describe('env safety at the file boundary (story 104)', () => {
  const withEnv = (env: Record<string, unknown>) =>
    parseConfig(
      JSON.stringify({
        version: 2,
        projects: [{ id: 'a', path: '/tmp/a', env }],
      }),
      'config',
    );

  /**
   * The same refusals the IPC guard applies.
   *
   * Hand-editing the config file is an explicitly supported workflow, so this
   * reader is a real entry point — a rule enforced on only one of the two paths
   * is a rule with a documented bypass, and the file is the path someone would
   * reach for precisely because it looks like the unguarded one.
   */
  it('refuses the dynamic-loader variables', () => {
    for (const key of ['LD_PRELOAD', 'DYLD_INSERT_LIBRARIES', 'DYLD_LIBRARY_PATH']) {
      const result = withEnv({ [key]: '/tmp/evil.so' });
      expect(result.errors.some((error) => /dynamic loader/.test(error))).toBe(true);
      expect('env' in (result.projects[0] ?? {})).toBe(false);
    }
  });

  it('refuses the interpreter hooks', () => {
    for (const key of ['NODE_OPTIONS', 'BASH_ENV', 'ELECTRON_RUN_AS_NODE']) {
      const result = withEnv({ [key]: 'x' });
      expect(result.errors.some((error) => /run code/.test(error))).toBe(true);
      expect('env' in (result.projects[0] ?? {})).toBe(false);
    }
  });

  it('applies the same caps as the IPC guard', () => {
    const tooMany = Object.fromEntries(
      Array.from({ length: 201 }, (_, index) => [`V${index}`, 'x']),
    );
    expect(withEnv(tooMany).errors.some((e) => /too many variables/.test(e))).toBe(
      true,
    );

    expect(
      withEnv({ FOO: 'x'.repeat(4097) }).errors.some((e) => /too long/.test(e)),
    ).toBe(true);

    expect(
      withEnv({ FOO: 'a\nb' }).errors.some((e) => /control characters/.test(e)),
    ).toBe(true);
  });

  it('still accepts an ordinary variable', () => {
    const result = withEnv({ API_URL: 'https://x.test', LDAP_URL: 'ldap://y' });
    expect(result.errors).toEqual([]);
    expect(result.projects[0]?.env).toEqual({
      API_URL: 'https://x.test',
      LDAP_URL: 'ldap://y',
    });
  });
});

/**
 * Story 108's workspace-level `env` block — read at the document's top level,
 * one per file rather than one per project, but reusing the same
 * `optionalEnv` the per-project overrides above go through: the same
 * `FORBIDDEN_KEYS`, `ENV_NAME`, `unsafeEnvReason`, size caps and all-or-nothing
 * rejection, because a hand-edited `LD_PRELOAD` is exactly as dangerous here as
 * it is on a project entry.
 */
const doc = (extra: object) => JSON.stringify({ version: 2, projects: [], ...extra });

/**
 * HIVE-83: a config naming a retired notification kind must keep meaning what
 * it can — `checkKeys` discards the **whole** notifications block on an
 * unrecognised key, so without `LEGACY_NOTIFICATION_KEYS` a file that still
 * names `session.idle` would silently lose every other preference.
 */
describe('parseConfig — notifications naming a retired kind (HIVE-83)', () => {
  it('keeps a notifications block that names a retired kind', () => {
    const parsed = parseConfig(
      JSON.stringify({
        version: 2,
        projects: [],
        notifications: { 'session.idle': 'off', 'session.blocked': 'inbox' },
      }),
      'config',
    );

    expect(parsed.errors).toEqual([]);
    expect(parsed.notifications?.['session.blocked']).toBe('inbox');
  });
});

describe('top-level env', () => {
  it('reads a well-formed block', () => {
    const parsed = parseConfig(doc({ env: { AWS_PROFILE: 'incorp' } }), 'cfg');
    expect(parsed.env).toEqual({ AWS_PROFILE: 'incorp' });
    expect(parsed.errors).toEqual([]);
  });

  it('is undefined when the file has no block', () => {
    expect(parseConfig(doc({}), 'cfg').env).toBeUndefined();
  });

  it('is no longer reported as an unknown key', () => {
    const parsed = parseConfig(doc({ env: {} }), 'cfg');
    expect(parsed.errors.join(' ')).not.toMatch(/unknown/i);
  });

  it('rejects the whole map on an unsafe key, with the shared message', () => {
    const parsed = parseConfig(
      doc({ env: { PATH: '/x', DYLD_INSERT_LIBRARIES: '/evil' } }),
      'cfg',
    );
    expect(parsed.env).toBeUndefined();
    expect(parsed.errors.join(' ')).toMatch(/dynamic loader/);
  });

  it('rejects a reserved key', () => {
    const parsed = parseConfig(doc({ env: { TERM: 'dumb' } }), 'cfg');
    expect(parsed.env).toBeUndefined();
    expect(parsed.errors.join(' ')).toMatch(/set by the terminal/);
  });
});
