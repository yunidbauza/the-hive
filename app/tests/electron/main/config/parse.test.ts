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
