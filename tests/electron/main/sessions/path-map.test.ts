import { describe, expect, it } from 'vitest';

import { createPathMap } from '../../../../electron/main/sessions/path-map';

const map = createPathMap({
  projectPath: '/Users/dev/Projects/the-hive',
  userDataPath: '/Users/dev/Library/Application Support/The Hive',
  workspace: '/workspace',
  hiveDir: '/hive',
});

describe('toContainer', () => {
  it('maps the project root itself', () => {
    expect(map.toContainer('/Users/dev/Projects/the-hive')).toBe('/workspace');
  });

  it('maps a file under the project root', () => {
    expect(map.toContainer('/Users/dev/Projects/the-hive/src/main.tsx')).toBe(
      '/workspace/src/main.tsx',
    );
  });

  it('maps the generated hive directory, which is not under the project', () => {
    expect(
      map.toContainer(
        '/Users/dev/Library/Application Support/The Hive/hive/container/hive.mcp.json',
      ),
    ).toBe('/hive/container/hive.mcp.json');
  });

  it('respects segment boundaries, so a sibling directory is not a match', () => {
    expect(map.toContainer('/Users/dev/Projects/the-hive-notes/x.md')).toBe(null);
  });

  it('returns null for a path under neither root', () => {
    expect(map.toContainer('/etc/hosts')).toBe(null);
  });

  it('does not map userData outside the hive directory', () => {
    expect(
      map.toContainer('/Users/dev/Library/Application Support/The Hive/config.json'),
    ).toBe(null);
  });
});

describe('toHost', () => {
  it('maps back from the workspace', () => {
    expect(map.toHost('/workspace/src/main.tsx')).toBe(
      '/Users/dev/Projects/the-hive/src/main.tsx',
    );
  });

  it('maps back from the hive directory', () => {
    expect(map.toHost('/hive/plugin')).toBe(
      '/Users/dev/Library/Application Support/The Hive/hive/plugin',
    );
  });

  it('returns null for a container path under neither root', () => {
    expect(map.toHost('/usr/local/bin/claude')).toBe(null);
  });
});

describe('overlapping roots', () => {
  it('prefers the longest matching root', () => {
    const nested = createPathMap({
      projectPath: '/srv',
      userDataPath: '/srv/data',
      workspace: '/workspace',
      hiveDir: '/hive',
    });
    // `/srv/data/hive` is under both `/srv` and the hive root; the longer wins.
    expect(nested.toContainer('/srv/data/hive/plugin')).toBe('/hive/plugin');
    expect(nested.toContainer('/srv/README.md')).toBe('/workspace/README.md');
  });
});
