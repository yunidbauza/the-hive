import { afterEach, describe, expect, it } from 'vitest';

import { can, isDesktop } from '@config/runtime';

/**
 * Install a fake bridge. Shape does not matter — `isDesktop` is a *presence*
 * check, deliberately: the bridge is the capability.
 */
function withBridge() {
  (window as { hive?: unknown }).hive = { appInfo: () => Promise.resolve({}) };
}

afterEach(() => {
  delete (window as { hive?: unknown }).hive;
});

describe('isDesktop', () => {
  it('is false in a browser, where there is no bridge', () => {
    expect(isDesktop()).toBe(false);
  });

  it('is true once the preload bridge is present', () => {
    withBridge();
    expect(isDesktop()).toBe(true);
  });

  it('re-reads on every call rather than caching at module load', () => {
    // The bridge is injected by preload before the renderer's first paint, but
    // a cached value would also make every test here order-dependent.
    expect(isDesktop()).toBe(false);
    withBridge();
    expect(isDesktop()).toBe(true);
    delete (window as { hive?: unknown }).hive;
    expect(isDesktop()).toBe(false);
  });
});

describe('can', () => {
  it('gates every desktop-only capability off the same signal', () => {
    expect(can.spawnSession()).toBe(false);
    expect(can.killSession()).toBe(false);
    expect(can.typeIntoTerminal()).toBe(false);

    withBridge();

    expect(can.spawnSession()).toBe(true);
    expect(can.killSession()).toBe(true);
    expect(can.typeIntoTerminal()).toBe(true);
  });
});
