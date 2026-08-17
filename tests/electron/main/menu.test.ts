// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';

import type { MenuItemConstructorOptions } from 'electron';

vi.mock('electron', () => ({
  Menu: { setApplicationMenu: vi.fn(), buildFromTemplate: vi.fn() },
}));

const { buildMenuTemplate } = await import('../../../electron/main/menu');

const mac = { isMac: true, isDev: false, appName: 'The Hive' };

/** Collect every `role` in a template, at any depth. */
function roles(template: MenuItemConstructorOptions[]): string[] {
  return template.flatMap((item) => [
    ...(item.role ? [item.role] : []),
    ...(Array.isArray(item.submenu) ? roles(item.submenu) : []),
  ]);
}

describe('buildMenuTemplate', () => {
  it('provides the clipboard roles — without them Cmd+C silently does nothing', () => {
    // The whole reason the menu is not optional: these are menu accelerators,
    // not browser behaviour, in an app you copy terminal output out of.
    expect(roles(buildMenuTemplate(mac))).toEqual(
      expect.arrayContaining(['cut', 'copy', 'paste', 'selectAll', 'undo', 'redo']),
    );
  });

  it('provides quit on macOS', () => {
    expect(roles(buildMenuTemplate(mac))).toContain('quit');
  });

  it('offers DevTools in dev', () => {
    expect(roles(buildMenuTemplate({ ...mac, isDev: true }))).toContain(
      'toggleDevTools',
    );
  });

  it('does NOT offer DevTools in a production build', () => {
    expect(roles(buildMenuTemplate(mac))).not.toContain('toggleDevTools');
  });

  it('titles the app menu with the app name on macOS', () => {
    expect(buildMenuTemplate(mac)[0]?.label).toBe('The Hive');
  });

  it('omits the macOS app menu elsewhere, but keeps Edit and its clipboard roles', () => {
    const template = buildMenuTemplate({ ...mac, isMac: false });

    expect(template[0]?.label).toBe('Edit');
    expect(roles(template)).toEqual(expect.arrayContaining(['copy', 'paste']));
  });

  it('offers "Check for Updates…" under About, and wires it to the handler', () => {
    const onCheckForUpdates = vi.fn();
    const submenu = buildMenuTemplate({ ...mac, onCheckForUpdates })[0]
      ?.submenu as MenuItemConstructorOptions[];
    const item = submenu.find((entry) => entry.label === 'Check for Updates…');

    expect(item).toBeDefined();
    // Directly after About, where macOS users look for it.
    expect(submenu.indexOf(item as MenuItemConstructorOptions)).toBe(2);

    item?.click?.(
      undefined as never,
      undefined as never,
      undefined as never,
    );
    expect(onCheckForUpdates).toHaveBeenCalledTimes(1);
  });

  it('omits the update item entirely when nothing can handle it', () => {
    // Absent rather than inert: a menu item that does nothing is worse than no
    // menu item, because it looks like a fault.
    const submenu = buildMenuTemplate(mac)[0]
      ?.submenu as MenuItemConstructorOptions[];

    expect(submenu.map((entry) => entry.label)).not.toContain(
      'Check for Updates…',
    );
  });

  describe('About', () => {
    const appSubmenu = (context: Parameters<typeof buildMenuTemplate>[0]) =>
      buildMenuTemplate(context)[0]?.submenu as MenuItemConstructorOptions[];

    it('opens the app’s own panel rather than Electron’s', () => {
      /**
       * `{ role: 'about' }` opens the stock panel: the framework's atom logo,
       * the name "Electron", and its version. All true of the runtime, and
       * none of it what anybody opens About to find out — the app's own name
       * does not even appear.
       */
      const onShowAbout = vi.fn();
      const item = appSubmenu({ ...mac, onShowAbout })[0];

      expect(item?.role).toBeUndefined();
      expect(item?.label).toBe('About The Hive');

      item?.click?.(undefined as never, undefined as never, undefined as never);
      expect(onShowAbout).toHaveBeenCalledTimes(1);
    });

    it('falls back to the stock panel when nothing can open ours', () => {
      /**
       * Falls back rather than dropping the item, unlike the update entry.
       * About is the one row macOS users expect to find in an app menu, and a
       * menu missing it is stranger than one naming the framework.
       */
      expect(appSubmenu(mac)[0]?.role).toBe('about');
    });

    it('stays the first item, above Check for Updates…', () => {
      // The platform convention, and the reason the update item was put where
      // it is: users look directly under About for it.
      const labels = appSubmenu({
        ...mac,
        onShowAbout: vi.fn(),
        onCheckForUpdates: vi.fn(),
      }).map((entry) => entry.label);

      expect(labels[0]).toBe('About The Hive');
      expect(labels.indexOf('Check for Updates…')).toBeGreaterThan(0);
    });
  });

  it('keeps zoom and fullscreen available', () => {
    expect(roles(buildMenuTemplate(mac))).toEqual(
      expect.arrayContaining(['resetZoom', 'zoomIn', 'zoomOut', 'togglefullscreen']),
    );
  });
});
