import { afterEach, describe, expect, it } from 'vitest';

import { can, canFor, isDesktop } from '@config/runtime';
import { resetProjectConfig, setProjectConfigForTest } from '@lib/project-config';
import { emptySnapshot } from '@shared/config-contract';
import { WINDOW_BOUND } from '@shared/remote-contract';

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
      expect(can.spawnSessionIn('nova-web')).toBe(true);

      withBridge();

      expect(can.spawnSessionIn('nova-web')).toBe(true);
    });

    it('refuses a project the config cannot resolve', () => {
      setProjectConfigForTest({
        ...emptySnapshot('/home/dev/.hive/config.json', '/bin/zsh'),
        projects: [
          {
            id: 'nova-web',
            name: 'nova-web',
            path: '/repos/nova-web',
            icon: 'ph-folder',
            origin: 'local',
            status: 'ok',
            key: 'nw',
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
      });

      expect(can.spawnSessionIn('nova-web')).toBe(true);
      expect(can.spawnSessionIn('referral-api')).toBe(false);
      expect(can.spawnSessionIn('advisor-portal')).toBe(false);
    });
  });

  /**
   * The four `WINDOW_BOUND` predicates (HIVE-144).
   *
   * Each of the four is asserted on its own field, in both directions across
   * the two tests below — never as one `toEqual` against a canned object,
   * which a hard-coded implementation could satisfy just as well as a real
   * one. `canFor` is exercised directly, with no bridge and no snapshot, so
   * these are pure-function tests before they are anything else.
   */
  describe('canFor', () => {
    it('permits all four capabilities in local mode', () => {
      const c = canFor({ mode: 'local' });
      expect(c.chooseDirectory).toBe(true);
      expect(c.pickTheme).toBe(true);
      expect(c.saveTheme).toBe(true);
      expect(c.importSkillFiles).toBe(true);
    });

    it('withholds exactly the WINDOW_BOUND four while attached', () => {
      const c = canFor({ mode: 'remote' });
      expect(c.chooseDirectory).toBe(false);
      expect(c.pickTheme).toBe(false);
      expect(c.saveTheme).toBe(false);
      expect(c.importSkillFiles).toBe(false);
    });

    /**
     * The guard rail. Ties `RemoteCapabilities`'s own key count to
     * `WINDOW_BOUND`'s rather than to a bare literal `4`, so this fails in
     * *both* directions a hand-picked number could only catch one of: a
     * fifth channel added to the table with no matching predicate here, and
     * a predicate quietly dropped from here while the table still names
     * four.
     */
    it('has one predicate per WINDOW_BOUND entry, so a fifth cannot be forgotten and one cannot be silently dropped', () => {
      const capabilities = canFor({ mode: 'remote' });
      expect(Object.keys(capabilities)).toHaveLength(
        Object.keys(WINDOW_BOUND).length,
      );
    });
  });

  /**
   * The four capabilities as `can` actually exposes them: functions read off
   * the config subscription, not `canFor` called directly. `withBridge()`
   * plays no part here — these four are about remote-attach, not about the
   * desktop/browser split `isDesktop()` gates, so they must answer the same
   * way with or without a bridge.
   */
  describe('can — the four WINDOW_BOUND predicates', () => {
    afterEach(() => {
      resetProjectConfig();
    });

    it('permits every capability with no snapshot read yet', () => {
      expect(can.chooseDirectory()).toBe(true);
      expect(can.pickTheme()).toBe(true);
      expect(can.saveTheme()).toBe(true);
      expect(can.importSkillFiles()).toBe(true);
    });

    it('permits every capability once the snapshot reads local mode', () => {
      setProjectConfigForTest({
        ...emptySnapshot('/home/dev/.hive/config.json', '/bin/zsh'),
      });

      expect(can.chooseDirectory()).toBe(true);
      expect(can.pickTheme()).toBe(true);
      expect(can.saveTheme()).toBe(true);
      expect(can.importSkillFiles()).toBe(true);
    });

    it('withholds every capability once the snapshot reads remote mode', () => {
      setProjectConfigForTest({
        ...emptySnapshot('/home/dev/.hive/config.json', '/bin/zsh'),
        remote: { mode: 'remote', host: 'mini.tail1234.ts.net', port: 7433 },
        // A snapshot claiming `mode: 'remote'` with no attached server
        // describes a state the app cannot be in (HIVE-139's own lesson) —
        // this is the server the file says this window is attached to.
        attachedServer: { name: 'mini.tail1234.ts.net', host: 'mini.tail1234.ts.net' },
      });

      expect(can.chooseDirectory()).toBe(false);
      expect(can.pickTheme()).toBe(false);
      expect(can.saveTheme()).toBe(false);
      expect(can.importSkillFiles()).toBe(false);
    });
  });
});
