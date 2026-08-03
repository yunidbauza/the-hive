import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * Guards on `package.json` itself (story 084).
 *
 * Each of these encodes a fact whose violation produces a confusing failure
 * far from the edit that caused it — the exact shape of bug a tidy-up commit
 * introduces and nobody connects to the tidy-up.
 */
// Read via cwd, not `import.meta.url`: the test environment is happy-dom, where
// `import.meta.url` is not a `file:` URL and `fileURLToPath` throws.
const manifest = JSON.parse(
  readFileSync(join(process.cwd(), 'package.json'), 'utf8'),
);

describe('package.json', () => {
  it('allowlists every dependency that needs an install script', () => {
    // pnpm 10 blocks dependency lifecycle scripts unless named here. Without
    // `electron` the runtime binary is never downloaded; without `node-pty`
    // the native addon never lands. Both fail long after `pnpm install`
    // reports success.
    expect(manifest.pnpm.onlyBuiltDependencies).toContain('electron');
    expect(manifest.pnpm.onlyBuiltDependencies).toContain('node-pty');
  });

  it('keeps the allowlist minimal — every entry grants install-time code execution', () => {
    expect(manifest.pnpm.onlyBuiltDependencies).toHaveLength(2);
  });

  it('keeps electron a devDependency', () => {
    // It ships as the runtime via the packager, not via node_modules. Listing
    // it as a dependency bloats every future build.
    expect(manifest.devDependencies).toHaveProperty('electron');
    expect(manifest.dependencies).not.toHaveProperty('electron');
  });

  it('pins electron exactly, because electron-rebuild reads it to pick headers', () => {
    // A floating range means a silent ABI change on an unrelated install.
    expect(manifest.devDependencies.electron).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it('keeps node-pty a runtime dependency, unbundled by externalizeDepsPlugin', () => {
    // A bundler cannot inline a .node file; it must resolve from node_modules.
    expect(manifest.dependencies).toHaveProperty('node-pty');
  });

  it('checks the native toolchain before desktop:dev and after install', () => {
    expect(manifest.scripts.postinstall).toContain('check-native-abi.mjs');
    expect(manifest.scripts['predesktop:dev']).toContain('check-native-abi.mjs');
  });

  it('points main at the built main process', () => {
    expect(manifest.main).toBe('out/main/index.js');
  });
});
