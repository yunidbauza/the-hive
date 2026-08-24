import { afterEach, describe, expect, it } from 'vitest';

import { can, isDesktop } from '@config/runtime';
import { resetProjectConfig, setProjectConfigForTest } from '@lib/project-config';
import { DEFAULT_JIRA, DEFAULT_NOTIFICATIONS } from '@shared/config-contract';

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

  /**
   * `spawnSessionIn` deliberately does NOT follow the same signal (story 090).
   *
   * It answers from the workspace config, not from the target, and with no
   * config it answers `true` — which is what keeps the browser demo's main
   * flow working and the six Playwright web specs passing. Story 083 already
   * names breaking those specs as the signal that a gate is wrong.
   */
  describe('spawnSessionIn', () => {
    afterEach(() => {
      resetProjectConfig();
    });

    it('permits every project when no config has been read', () => {
      expect(can.spawnSessionIn('apfm-web')).toBe(true);

      withBridge();

      expect(can.spawnSessionIn('apfm-web')).toBe(true);
    });

    it('refuses a project the config cannot resolve', () => {
      setProjectConfigForTest({
        configPath: '/home/dev/.hive/config.json',
        templateWritten: false,
        shell: '/bin/zsh',
        claudeCommand: 'claude',
        env: {},
        projects: [
          {
            id: 'apfm-web',
            name: 'apfm-web',
            path: '/repos/apfm-web',
            icon: 'ph-folder',
            origin: 'local',
            status: 'ok',
            key: 'aw',
            isRepo: true,
          },
          {
            id: 'referral-api',
            name: 'referral-api',
            path: null,
            icon: 'ph-folder',
            origin: 'local',
            status: 'missing',
            key: 'ra',
            isRepo: false,
          },
        ],
        notifications: { ...DEFAULT_NOTIFICATIONS },
        jira: { ...DEFAULT_JIRA },
        subscriptionAuth: true,
  sessionMetrics: true,
  importLoginEnv: true,
        errors: [],
      });

      expect(can.spawnSessionIn('apfm-web')).toBe(true);
      expect(can.spawnSessionIn('referral-api')).toBe(false);
      expect(can.spawnSessionIn('advisor-portal')).toBe(false);
    });
  });
});
