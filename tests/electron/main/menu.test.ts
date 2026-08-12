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

  it('keeps zoom and fullscreen available', () => {
    expect(roles(buildMenuTemplate(mac))).toEqual(
      expect.arrayContaining(['resetZoom', 'zoomIn', 'zoomOut', 'togglefullscreen']),
    );
  });
});
