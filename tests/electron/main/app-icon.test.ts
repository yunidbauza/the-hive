// @vitest-environment node
import { mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The dev-only icon wiring, with `electron` mocked.
 *
 * What matters here is the *boundary*: a packaged app must not try to point at
 * a repo path that will not exist inside a bundle, and a dev run must not throw
 * when the asset is missing. Whether the dock actually changes is Electron's
 * business, not this module's.
 */

const dock = { setIcon: vi.fn() };
const appMock = {
  isPackaged: false,
  dock: dock as { setIcon: (image: unknown) => void } | undefined,
};
const createFromPath = vi.fn((path: string) => ({
  isEmpty: () => path.endsWith('empty.png'),
}));

vi.mock('electron', () => ({
  app: appMock,
  nativeImage: { createFromPath: (path: string) => createFromPath(path) },
}));

const { applyDevDockIcon, devIconPath } = await import(
  '../../../electron/main/app-icon'
);

/** A fake `out/main/` with the icon two levels up, as the real tree has it. */
function treeWithIcon(name = 'icon.png'): string {
  const root = join(tmpdir(), `hive-icon-${Math.random().toString(36).slice(2)}`);
  mkdirSync(join(root, 'out', 'main'), { recursive: true });
  mkdirSync(join(root, 'resources'), { recursive: true });
  writeFileSync(join(root, 'resources', name), 'png');
  return root;
}

beforeEach(() => {
  appMock.isPackaged = false;
  appMock.dock = dock;
  vi.clearAllMocks();
});

afterEach(() => {
  appMock.dock = dock;
});

describe('devIconPath', () => {
  it('resolves the master beside the build output', () => {
    const root = treeWithIcon();
    expect(devIconPath('icon.png', join(root, 'out', 'main'))).toBe(
      join(root, 'resources', 'icon.png'),
    );
  });

  it('resolves the macOS master, which is a different file and not a variant', () => {
    const root = treeWithIcon('icon-macos.png');
    expect(devIconPath('icon-macos.png', join(root, 'out', 'main'))).toBe(
      join(root, 'resources', 'icon-macos.png'),
    );
  });

  it('is undefined when packaged, whatever is on disk', () => {
    const root = treeWithIcon();
    appMock.isPackaged = true;
    expect(devIconPath('icon.png', join(root, 'out', 'main'))).toBeUndefined();
  });

  it('is undefined when the asset is missing rather than returning a dead path', () => {
    const root = treeWithIcon('elsewhere.png');
    expect(devIconPath('icon.png', join(root, 'out', 'main'))).toBeUndefined();
  });
});

describe('applyDevDockIcon', () => {
  it('does nothing off macOS, where there is no dock', () => {
    appMock.dock = undefined;
    applyDevDockIcon();
    expect(createFromPath).not.toHaveBeenCalled();
  });

  it('does nothing when packaged — the bundle owns the icon', () => {
    appMock.isPackaged = true;
    applyDevDockIcon();
    expect(dock.setIcon).not.toHaveBeenCalled();
  });

  /*
   * Resolved from the module's own location, so this also proves the committed
   * asset is where the path expects it — the failure this test exists to catch
   * is someone moving `resources/icon.png`.
   */
  it('sets the dock icon from the macOS master, not the full-bleed one', () => {
    applyDevDockIcon();
    expect(createFromPath).toHaveBeenCalledWith(
      expect.stringContaining(join('resources', 'icon-macos.png')),
    );
    expect(dock.setIcon).toHaveBeenCalledTimes(1);
  });
});
