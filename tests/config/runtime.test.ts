import { afterEach, describe, expect, it } from 'vitest';

import { can, canFor, isDesktop } from '@config/runtime';
import {
  loadProjectConfig,
  projectConfigSnapshot,
  resetProjectConfig,
  setProjectConfigForTest,
  subscribeProjectConfig,
} from '@lib/project-config';
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
   * The three `WINDOW_BOUND` predicates (HIVE-144, narrowed by HIVE-146).
   *
   * Each of the three is asserted on its own field, in both directions across
   * the two tests below — never as one `toEqual` against a canned object,
   * which a hard-coded implementation could satisfy just as well as a real
   * one. `canFor` is exercised directly, with no bridge and no snapshot, so
   * these are pure-function tests before they are anything else.
   */
  describe('canFor', () => {
    it('permits all three capabilities in local mode', () => {
      const c = canFor({ mode: 'local' });
      expect(c.chooseDirectory).toBe(true);
      expect(c.importSkillFiles).toBe(true);
      expect(c.revealConfig).toBe(true);
    });

    it('withholds exactly the WINDOW_BOUND three while attached', () => {
      const c = canFor({ mode: 'remote' });
      expect(c.chooseDirectory).toBe(false);
      expect(c.importSkillFiles).toBe(false);
      expect(c.revealConfig).toBe(false);
    });

    /**
     * The guard rail. Ties `RemoteCapabilities`'s own key count to
     * `WINDOW_BOUND`'s rather than to a bare literal, so this fails in *both*
     * directions a hand-picked number could only catch one of: a new channel
     * added to the table with no matching predicate here, and a predicate
     * quietly dropped from here while the table still names it.
     *
     * Deriving it is what made HIVE-146 cheap. That story deleted two entries
     * and two predicates, and this assertion needed no edit — which is the
     * whole argument for not writing the number down.
     */
    it('has one predicate per WINDOW_BOUND entry, so a new one cannot be forgotten and one cannot be silently dropped', () => {
      const capabilities = canFor({ mode: 'remote' });
      expect(Object.keys(capabilities)).toHaveLength(
        Object.keys(WINDOW_BOUND).length,
      );
    });
  });

  /**
   * The three capabilities as `can` actually exposes them — **the wiring, not
   * the pure rule beside it** (HIVE-144 review, C1).
   *
   * The block this replaces drove them by installing a snapshot whose
   * `remote.mode` was `'remote'`, and that is a snapshot an attached window
   * can never hold: `config:get` is proxied while attached, so the renderer's
   * snapshot is the *server's*, and a server is attached to nobody. The
   * assertions passed against a `currentRemote` that answered the wrong
   * question, because they never went near the source it reads. Replacing
   * `currentRemote`'s body with a constant left that suite green.
   *
   * So these drive the real path end to end instead: a bridge whose
   * `app:info` names an attached server, `loadProjectConfig()` as the
   * renderer's own boot calls it, and the predicates read afterwards. Nothing
   * here hands `can` a mode — it has to go and find one.
   */
  describe('can — the three WINDOW_BOUND predicates', () => {
    afterEach(() => {
      resetProjectConfig();
    });

    /**
     * The whole bridge these three consult: `config.get` for the snapshot that
     * triggers the read, and `appInfo` for the answer itself.
     *
     * `attachedServer` and `remote` on the snapshot are set to the values a
     * **real attached client** sees — the server's own file, which says
     * `'local'` and names no attached server — so a gate that went back to
     * reading the snapshot fails these rather than passing them.
     */
    function withAttachedBridge(attachedServerName: string | null) {
      (window as { hive?: unknown }).hive = {
        appInfo: () => Promise.resolve({ attachedServerName }),
        config: {
          get: () =>
            Promise.resolve({
              ...emptySnapshot('/home/dev/.hive/config.json', '/bin/zsh'),
            }),
        },
      };
    }

    it('permits every capability with nothing read yet', () => {
      expect(can.chooseDirectory()).toBe(true);
      expect(can.importSkillFiles()).toBe(true);
      expect(can.revealConfig()).toBe(true);
    });

    it('permits every capability once the config read finds no socket open', async () => {
      withAttachedBridge(null);

      await loadProjectConfig();

      expect(can.chooseDirectory()).toBe(true);
      expect(can.importSkillFiles()).toBe(true);
      expect(can.revealConfig()).toBe(true);
    });

    it('withholds every capability while a socket is open, though the proxied snapshot reads local', async () => {
      withAttachedBridge('mini.tail1234.ts.net');

      await loadProjectConfig();

      // The state the gates exist for, and the one the old test could not
      // reach: the snapshot in hand says `'local'` because it is the
      // server's, and all three must still refuse.
      expect(projectConfigSnapshot()?.remote.mode).toBe('local');
      expect(can.chooseDirectory()).toBe(false);
      expect(can.importSkillFiles()).toBe(false);
      expect(can.revealConfig()).toBe(false);
    });

    /**
     * Ruling 19 leaves this machine's own `remote.mode` at `'remote'` after a
     * failed boot attach, so the next launch retries — and that window is
     * bound **local**, with every one of these three working. A config-keyed
     * gate refuses them all; the runtime-keyed one does not.
     */
    it('permits every capability when the file says remote but no socket is open', async () => {
      (window as { hive?: unknown }).hive = {
        appInfo: () => Promise.resolve({ attachedServerName: null }),
        config: {
          get: () =>
            Promise.resolve({
              ...emptySnapshot('/home/dev/.hive/config.json', '/bin/zsh'),
              remote: { mode: 'remote', host: 'mini.tail1234.ts.net', port: 7433 },
              attachedServer: {
                name: 'mini.tail1234.ts.net',
                host: 'mini.tail1234.ts.net',
              },
            }),
        },
      };

      await loadProjectConfig();

      expect(can.chooseDirectory()).toBe(true);
      expect(can.importSkillFiles()).toBe(true);
      expect(can.revealConfig()).toBe(true);
    });

    /**
     * The re-render half. `useRemoteCapabilities` subscribes to this module
     * and reads `can.*` fresh, so an attachment that moves has to notify the
     * same subscribers a snapshot change does — otherwise the three gates are
     * correct and the buttons on screen are not.
     */
    it('notifies subscribers when the attachment moves', async () => {
      withAttachedBridge('mini.tail1234.ts.net');
      let notified = 0;
      const stop = subscribeProjectConfig(() => {
        notified += 1;
      });

      await loadProjectConfig();
      stop();

      // Twice: once for the snapshot, once for the attachment behind it.
      expect(notified).toBe(2);
    });
  });
});
