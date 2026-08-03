// @vitest-environment node
import { describe, expect, it } from 'vitest';

import { deriveProjectId } from '../../../../electron/main/config/identity';

/**
 * Project id derivation (story 101).
 *
 * The id is machinery, not a label: sessions reference projects through
 * `entity.project`, so these rules exist to make an id that never has to
 * change once it is written.
 */

const none = new Set<string>();

describe('deriveProjectId', () => {
  it('kebab-cases the directory name', () => {
    expect(deriveProjectId('My Project', none)).toBe('my-project');
    expect(deriveProjectId('The_Hive', none)).toBe('the-hive');
    expect(deriveProjectId('apfm.web', none)).toBe('apfm-web');
  });

  it('strips characters outside [a-z0-9-] and collapses runs', () => {
    expect(deriveProjectId('a  b//c', none)).toBe('a-b-c');
    expect(deriveProjectId('--lead--', none)).toBe('lead');
    expect(deriveProjectId('Ünïcødé', none)).toBe('n-c-d');
  });

  it('truncates to 40 characters', () => {
    expect(deriveProjectId('x'.repeat(60), none)).toHaveLength(40);
  });

  it('never ends on a dash after truncating', () => {
    // 39 x's then a separator: the naive slice would leave a trailing dash.
    expect(deriveProjectId(`${'x'.repeat(39)} tail`, none)).toBe('x'.repeat(39));
  });

  it('suffixes a collision with -2, then -3', () => {
    expect(deriveProjectId('repo', new Set(['repo']))).toBe('repo-2');
    expect(deriveProjectId('repo', new Set(['repo', 'repo-2']))).toBe('repo-3');
  });

  it('falls back when nothing survives sanitising', () => {
    expect(deriveProjectId('///', none)).toBe('project');
    expect(deriveProjectId('///', new Set(['project']))).toBe('project-2');
  });

  it('keeps a truncated id within 40 characters after suffixing', () => {
    const id = deriveProjectId('y'.repeat(60), new Set(['y'.repeat(40)]));

    expect(id.length).toBeLessThanOrEqual(40);
    expect(id.endsWith('-2')).toBe(true);
  });

  it('produces an id the config parser accepts', () => {
    // `parse.ts` runs every id through `assertId`, so a derived id that the
    // reader would reject is a write that refuses itself.
    expect(deriveProjectId('My Project', none)).toMatch(
      /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/,
    );
    expect(deriveProjectId('///', none)).toMatch(
      /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/,
    );
  });
});
