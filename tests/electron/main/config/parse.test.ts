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

  /**
   * The key HIVE-94 adds (`[a-z]{2,4}`).
   *
   * Rejected the way `origin` is — the whole entry is dropped and the reason
   * reported — rather than silently regenerated. A key is a thing the user
   * typed into the file expecting to be able to type it into the console, and
   * quietly substituting a different one would leave them with a config that
   * does not do what it says.
   */
  it('accepts a well-formed key', () => {
    const parsed = parseConfig(
      JSON.stringify({
        version: 2,
        projects: [{ id: 'a', path: '~/a', key: 'ix' }],
      }),
      'config',
    );

    expect(parsed.errors).toEqual([]);
    expect(parsed.projects[0].key).toBe('ix');
  });

  it.each([
    ['too short', 'i'],
    ['too long', 'abcde'],
    ['uppercase', 'IX'],
    ['digits', 'ix2'],
    ['a separator', 'i-x'],
    ['not a string', 7],
  ])('rejects a key that is %s, with a readable error', (_label, key) => {
    const parsed = parseConfig(
      JSON.stringify({ version: 2, projects: [{ id: 'a', path: '~/a', key }] }),
      'config',
    );

    expect(parsed.projects).toEqual([]);
    expect(parsed.errors[0]).toMatch(/key: expected 2–4 lowercase letters/);
    // Advisory, exactly as a bad `origin` is: one unusable entry must not stop
    // the app reading the rest of the file.
    expect(parsed.fatal).toBe(false);
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
 * names `session.ended` would silently lose every other preference.
 * (`session.idle` used to be the example; HIVE-89 made it a live key again.)
 */
describe('parseConfig — notifications naming a retired kind (HIVE-83)', () => {
  it('keeps a notifications block that names a retired kind', () => {
    const parsed = parseConfig(
      JSON.stringify({
        version: 2,
        projects: [],
        notifications: { 'session.ended': 'off', 'session.blocked': 'inbox' },
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

/**
 * HIVE-131's receiver block.
 *
 * Structurally the same contract `jira` has: a malformed block is reported and
 * dropped, and the rest of the file still applies. The alias rule is
 * deliberately *not* `assertJiraSite`'s — a single-label host and a literal IP
 * are both legitimate here, and a `:` must be refused because the port belongs
 * to the receiver, not to the name.
 */
describe('parseConfig — the receiver block (HIVE-131)', () => {
  it('reads a hostAlias', () => {
    const parsed = parseConfig(
      doc({ receiver: { hostAlias: 'host.containers.internal' } }),
      'config',
    );

    expect(parsed.receiver).toEqual({ hostAlias: 'host.containers.internal' });
    expect(parsed.fatal).toBe(false);
    expect(parsed.errors).toEqual([]);
  });

  it('leaves receiver undefined when the file has no block', () => {
    const parsed = parseConfig(doc({}), 'config');

    expect(parsed.receiver).toBeUndefined();
    expect(parsed.errors).toEqual([]);
  });

  it('reports a non-object block and ignores it, without rejecting the file', () => {
    const parsed = parseConfig(doc({ receiver: 'nope' }), 'config');

    expect(parsed.receiver).toBeUndefined();
    expect(parsed.fatal).toBe(false);
    expect(parsed.errors).toEqual([
      'config.receiver: expected an object — ignored',
    ]);
  });

  it('reports an unknown key inside the block and keeps the rest', () => {
    const parsed = parseConfig(
      doc({ receiver: { hostAlias: 'a.b', bind: {} } }),
      'config',
    );

    expect(parsed.receiver).toEqual({ hostAlias: 'a.b' });
    expect(parsed.errors).toEqual([
      'config.receiver: unknown key "bind" — ignored',
    ]);
  });

  it('rejects a forbidden key by dropping the whole block', () => {
    const parsed = parseConfig(
      '{"version":2,"projects":[],"receiver":{"__proto__":"x"}}',
      'config',
    );

    expect(parsed.receiver).toBeUndefined();
    expect(parsed.fatal).toBe(false);
    expect(parsed.errors).toEqual([
      'config.receiver: forbidden key "__proto__" — receiver ignored',
    ]);
  });

  /**
   * The delimiter cases are the reason this rule is an allowlist.
   *
   * Each of `?`, `#`, `@` and `\` **ends the URL authority**, so an alias
   * carrying one redirects the address rather than naming a host:
   * `10.0.0.5?` turns `http://127.0.0.1:63999/hook` into
   * `http://10.0.0.5?:63999/hook` — port 80 of `10.0.0.5`, with the real port
   * and path demoted into a query string.
   */
  it.each([
    ['an empty string', ''],
    ['whitespace inside', 'a b'],
    ['surrounding whitespace', ' a '],
    ['a path', 'a/b'],
    ['a port', 'a:1234'],
    ['a scheme', 'http://a'],
    ['a query delimiter', '10.0.0.5?'],
    ['a fragment delimiter', 'evil.com#'],
    ['credentials', 'user@evil.com'],
    ['a backslash', 'evil.com\\x'],
    ['an empty label', 'a..b'],
    ['a leading dot', '.a'],
    ['a trailing dot', 'a.'],
    ['a leading hyphen', '-a'],
    ['a trailing hyphen', 'a-'],
    ['over 253 characters', `${'a'.repeat(254)}`],
  ])('rejects %s advisorily and leaves the field unset', (_label, value) => {
    const parsed = parseConfig(
      doc({ receiver: { hostAlias: value } }),
      'config',
    );

    expect(parsed.receiver).toEqual({});
    expect(parsed.fatal).toBe(false);
    expect(parsed.errors).toEqual([
      'config.receiver.hostAlias: expected a hostname — no scheme, path or port',
    ]);
  });

  it('rejects a non-string advisorily', () => {
    const parsed = parseConfig(doc({ receiver: { hostAlias: 7 } }), 'config');

    expect(parsed.receiver).toEqual({});
    expect(parsed.errors).toEqual([
      'config.receiver.hostAlias: expected a hostname — no scheme, path or port',
    ]);
  });

  it('accepts a bare single-label host, a literal IP and an inner hyphen', () => {
    for (const hostAlias of [
      'gateway',
      '192.168.4.125',
      'host-1.internal',
      'host.containers.internal',
    ]) {
      const parsed = parseConfig(doc({ receiver: { hostAlias } }), 'config');
      expect(parsed.receiver).toEqual({ hostAlias });
      expect(parsed.errors).toEqual([]);
    }
  });

  it('does not report receiver as an unknown top-level key', () => {
    const parsed = parseConfig(
      doc({ receiver: { hostAlias: 'a.b' } }),
      'config',
    );

    expect(parsed.errors).toEqual([]);
  });
});

const parse = (container: unknown) =>
  parseConfig(
    JSON.stringify({
      version: 2,
      projects: [{ id: 'the-hive', path: '~/the-hive', container }],
    }),
    'config',
  );

describe('parseConfig — per-project container block (HIVE-133)', () => {
  it('reads a minimal block and defaults nothing', () => {
    // Validation lives here; defaulting is `effectiveRuntime`'s, which is the
    // only layer that can see `receiver.hostAlias`.
    const parsed = parse({ workspace: '/workspace', hiveDir: '/hive' });

    expect(parsed.fatal).toBe(false);
    expect(parsed.projects[0]?.container).toEqual({
      workspace: '/workspace',
      hiveDir: '/hive',
    });
  });

  it('keeps every field the file sets', () => {
    const container = {
      workspace: '/w',
      hiveDir: '/h',
      envArg: '--env {name}={value}',
      probe: 'docker exec devbox true',
      freshness: 'rewrite',
      hostAlias: 'gateway',
    };

    expect(parse(container).projects[0]?.container).toEqual(container);
  });

  it('is absent when the project has no block', () => {
    const parsed = parseConfig(
      JSON.stringify({ version: 2, projects: [{ id: 'a', path: '~/a' }] }),
      'config',
    );
    expect(parsed.projects[0]?.container).toBeUndefined();
  });

  it.each([
    [{ hiveDir: '/hive' }, 'workspace'],
    [{ workspace: '/workspace' }, 'hiveDir'],
    [{ workspace: 'relative', hiveDir: '/hive' }, 'workspace'],
    [{ workspace: '/w', hiveDir: 'relative' }, 'hiveDir'],
    [{ workspace: '/w', hiveDir: '/h', envArg: '-e {name}' }, 'envArg'],
    [{ workspace: '/w', hiveDir: '/h', freshness: 'stale' }, 'freshness'],
    [{ workspace: '/w', hiveDir: '/h', hostAlias: 'bad host' }, 'hostAlias'],
    [{ workspace: '/w', hiveDir: '/h', hostAlias: '10.0.0.5?' }, 'hostAlias'],
    [{ workspace: '/w', hiveDir: '/h', probe: '' }, 'probe'],
    [{ workspace: '/w', hiveDir: '/h', probe: 42 }, 'probe'],
  ])('rejects %j, naming the field', (container, field) => {
    const parsed = parse(container);

    // The whole block is dropped and the project stays usable as a host project.
    expect(parsed.projects[0]?.container).toBeUndefined();
    expect(parsed.projects[0]?.id).toBe('the-hive');
    // Advisory, never fatal: one bad block must not make the file unloadable.
    expect(parsed.fatal).toBe(false);
    expect(parsed.errors.join('\n')).toContain(field);
  });

  // `container: null` gets its own case rather than folding into the table
  // above: `typeof null === 'object'`, so it is exactly the input a naive
  // object check would let through.
  it('rejects container: null', () => {
    const parsed = parse(null);

    expect(parsed.projects[0]?.container).toBeUndefined();
    expect(parsed.projects[0]?.id).toBe('the-hive');
    expect(parsed.fatal).toBe(false);
    expect(parsed.errors.join('\n')).toContain('expected an object');
  });

  it('rejects a non-object container', () => {
    const parsed = parse('x');

    expect(parsed.projects[0]?.container).toBeUndefined();
    expect(parsed.projects[0]?.id).toBe('the-hive');
    expect(parsed.fatal).toBe(false);
    expect(parsed.errors.join('\n')).toContain('expected an object');
  });

  it('does not report container as an unknown key', () => {
    const parsed = parse({ workspace: '/w', hiveDir: '/h' });
    expect(parsed.errors.join('\n')).not.toContain('unknown key');
  });

  /**
   * `optionalContainer` used to be the one level of this file that never ran
   * `checkKeys` over its own block, unlike every sibling — `optionalJira` and
   * the top-level document both do — so a hand-written `hostalias` (lowercase
   * `a`) fell through every field check below as simply absent and was
   * silently ignored (final-review fix, Minor 12). `assertContainer` in
   * `guards.ts` already rejects that exact typo via `assertShape`, so the
   * reader was strictly looser than the guard on this one axis.
   */
  it('reports an unknown key inside the container block, matching every other block in this file', () => {
    const parsed = parse({ workspace: '/w', hiveDir: '/h', hostalias: 'gateway' });

    expect(parsed.errors.join('\n')).toContain('unknown key "hostalias"');
    // Still parses on the fields it does recognise — an unknown key is
    // reported and skipped, not fatal to the whole block.
    expect(parsed.projects[0]?.container).toEqual({ workspace: '/w', hiveDir: '/h' });
    expect(parsed.fatal).toBe(false);
  });
});
