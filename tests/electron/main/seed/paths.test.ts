// @vitest-environment node
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { SEED_MANIFEST_FILE, shippedRoot } from '../../../../electron/main/seed/paths';

describe('shippedRoot', () => {
  it('reads the repository copy in development, two levels above out/main', () => {
    expect(shippedRoot(false, '/Applications/The Hive.app/Contents/Resources', '/repo/out/main')).toBe(
      join('/repo/out/main', '../../resources'),
    );
  });

  it('reads Contents/Resources when packaged, where electron-builder put the extra resources', () => {
    expect(shippedRoot(true, '/Applications/The Hive.app/Contents/Resources', '/ignored')).toBe(
      '/Applications/The Hive.app/Contents/Resources',
    );
  });

  it('keeps the manifest a dotfile beside config.json', () => {
    expect(SEED_MANIFEST_FILE).toBe('.seed.json');
  });
});
