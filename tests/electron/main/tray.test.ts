// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { ServerDevice } from '../../../electron/shared/config-contract';

/**
 * The server-mode tray's content and wiring (HIVE-142).
 *
 * `buildTrayTemplate` is asserted as a pure value — the same way
 * `menu.test.ts` treats `buildMenuTemplate` — so the menu's shape is provable
 * with no real `Tray`. `createServerTray` gets a thin smoke test over the
 * `electron` mock below, for the one thing a pure template cannot prove:
 * that it is actually wired to a `Tray` instance.
 */

class FakeTray {
  static instances: FakeTray[] = [];
  icon: unknown;
  toolTip: string | undefined;
  title: string | undefined;
  destroyed = false;
  handlers = new Map<string, () => void>();
  constructor(icon: unknown) {
    this.icon = icon;
    FakeTray.instances.push(this);
  }
  setToolTip(tip: string): void {
    this.toolTip = tip;
  }
  setTitle(title: string): void {
    this.title = title;
  }
  on(event: string, handler: () => void): void {
    this.handlers.set(event, handler);
  }
  popUpContextMenu = vi.fn();
  destroy(): void {
    this.destroyed = true;
  }
}

const showMessageBox = vi.fn(() => Promise.resolve({ response: 1 }));
const writeText = vi.fn();
// Mutable so a test can simulate "dev" (an icon resolves) versus "packaged"
// (it does not) — `devIconPath` branches on `app.isPackaged`.
const appMock = { isPackaged: true };
const setTemplateImage = vi.fn();

vi.mock('electron', () => ({
  app: appMock,
  Tray: FakeTray,
  Menu: { buildFromTemplate: vi.fn((template: unknown) => template) },
  dialog: { showMessageBox },
  clipboard: { writeText },
  nativeImage: {
    createEmpty: vi.fn(() => ({ isEmpty: () => true })),
    createFromPath: vi.fn(() => ({
      isEmpty: () => false,
      setTemplateImage,
      resize: vi.fn(() => ({ isEmpty: () => false, setTemplateImage })),
    })),
  },
}));

const { buildTrayTemplate, createServerTray } = await import(
  '../../../electron/main/tray'
);

type MenuItem = {
  label?: string;
  enabled?: boolean;
  role?: string;
  submenu?: MenuItem[];
  click?: () => void;
};

function makeDevices(): ServerDevice[] {
  return [
    {
      id: 'd_1',
      name: 'MacBook',
      paired: '2026-09-07',
      revoked: false,
      credential: { kind: 'sha256', digest: 'abc' },
    },
    {
      id: 'd_2',
      name: 'Old Phone',
      paired: '2026-01-01',
      revoked: true,
      credential: { kind: 'sha256', digest: 'def' },
    },
  ];
}

type PairAttempt = { token: string; deviceId: string } | { error: string };
type RevokeAttempt = { revoked: true } | { error: string };

function makeDeps(overrides: {
  devices?: () => ServerDevice[];
  boundAddress?: () => string | null;
  bindError?: () => string | null;
  onPair?: (name: string) => PairAttempt;
  onRevoke?: (name: string) => RevokeAttempt;
} = {}) {
  return {
    devices: overrides.devices ?? (() => makeDevices()),
    onPair: vi.fn(
      overrides.onPair ??
        ((_name: string): PairAttempt => ({
          token: 'K7QM-4XR2-9WFD-A3LP',
          deviceId: 'd_new1',
        })),
    ),
    onRevoke: vi.fn(overrides.onRevoke ?? ((_name: string): RevokeAttempt => ({ revoked: true }))),
    onOpenConsole: vi.fn(),
    boundAddress: overrides.boundAddress ?? (() => '100.101.102.103:7433'),
    bindError: overrides.bindError ?? (() => null),
  };
}

beforeEach(() => {
  FakeTray.instances.length = 0;
  appMock.isPackaged = true; // the default: no icon resolves, per `devIconPath`.
  vi.clearAllMocks();
  showMessageBox.mockResolvedValue({ response: 1 });
});

describe('buildTrayTemplate', () => {
  it('offers Pair a device…, which mints and shows the token in the dialog detail', async () => {
    const deps = makeDeps();
    const template = buildTrayTemplate(deps) as MenuItem[];

    const pair = template.find((item) => item.label === 'Pair a device…');
    expect(pair).toBeDefined();

    pair?.click?.();
    await Promise.resolve(); // let the `.then` on `showMessageBox` settle

    expect(deps.onPair).toHaveBeenCalledTimes(1);
    expect(typeof deps.onPair.mock.calls[0]?.[0]).toBe('string');
    // The device id alongside the token (HIVE-142 review, I5) — the attach
    // handshake needs both, and "Copy" only ever copies the token.
    expect(showMessageBox).toHaveBeenCalledWith(
      expect.objectContaining({
        detail: 'K7QM-4XR2-9WFD-A3LP\nDevice id: d_new1',
        buttons: ['Copy', 'Done'],
      }),
    );
  });

  it('copies the token to the clipboard when Copy is chosen', async () => {
    showMessageBox.mockResolvedValue({ response: 0 });
    const deps = makeDeps();
    const template = buildTrayTemplate(deps) as MenuItem[];

    template.find((item) => item.label === 'Pair a device…')?.click?.();
    await Promise.resolve();
    await Promise.resolve();

    expect(writeText).toHaveBeenCalledWith('K7QM-4XR2-9WFD-A3LP');
  });

  it('does not touch the clipboard when Done is chosen', async () => {
    showMessageBox.mockResolvedValue({ response: 1 });
    const deps = makeDeps();
    const template = buildTrayTemplate(deps) as MenuItem[];

    template.find((item) => item.label === 'Pair a device…')?.click?.();
    await Promise.resolve();
    await Promise.resolve();

    expect(writeText).not.toHaveBeenCalled();
  });

  it('refuses rather than silently pairing when onPair reports an error, and shows the accurate reason', () => {
    // `onPair` answers `{ error }` rather than `{ token }` on refusal
    // (HIVE-142 review, I4/N4) — nothing was stored, and the dialog must
    // show *that* reason, not a token that does not exist or a generic
    // message papering over whatever the real cause was.
    const deps = makeDeps({
      onPair: () => ({ error: 'A device named "Device 1" already exists. Revoke it first, or choose another name.' }),
    });
    const template = buildTrayTemplate(deps) as MenuItem[];

    template.find((item) => item.label === 'Pair a device…')?.click?.();

    expect(deps.onPair).toHaveBeenCalledTimes(1);
    expect(showMessageBox).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'error',
        message: 'A device named "Device 1" already exists. Revoke it first, or choose another name.',
      }),
    );
    expect(showMessageBox).not.toHaveBeenCalledWith(
      expect.objectContaining({ buttons: ['Copy', 'Done'] }),
    );
    expect(writeText).not.toHaveBeenCalled();
  });

  it('lists one Paired devices entry per device, with the count in the label', () => {
    const deps = makeDeps();
    const template = buildTrayTemplate(deps) as MenuItem[];

    const paired = template.find((item) => item.label === 'Paired devices (2)');
    expect(paired?.submenu).toHaveLength(2);
    expect(paired?.submenu?.map((entry) => entry.label)).toEqual([
      'Revoke "MacBook"…',
      '"Old Phone" (revoked)',
    ]);
  });

  it("clicking an active device's entry asks for confirmation before revoking it (HIVE-142 I4)", async () => {
    // A mis-click on the sole console of an unattended machine must not
    // silently cut a device's access — see the click handler's own comment.
    showMessageBox.mockResolvedValue({ response: 1 }); // "Revoke"
    const deps = makeDeps();
    const template = buildTrayTemplate(deps) as MenuItem[];

    const paired = template.find((item) => item.label === 'Paired devices (2)');
    const macBook = paired?.submenu?.find((entry) => entry.label === 'Revoke "MacBook"…');
    expect(macBook?.enabled).toBe(true);

    macBook?.click?.();
    expect(deps.onRevoke).not.toHaveBeenCalled(); // not yet — confirmation is still pending
    expect(showMessageBox).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'warning', buttons: ['Cancel', 'Revoke'] }),
    );

    await Promise.resolve();
    await Promise.resolve();

    expect(deps.onRevoke).toHaveBeenCalledWith('MacBook');
    // Reported after, the same way pairing reports success.
    expect(showMessageBox).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'info', title: 'Device revoked' }),
    );
  });

  /**
   * HIVE-142 review, C1/I4: a revoke that did not actually land — no such
   * device any more, or the config write failed — must be shown, not
   * papered over with the same "Device revoked" every successful click
   * gets. Fail closed and loudly.
   */
  it('shows an error dialog rather than "Device revoked" when the revoke did not land', async () => {
    showMessageBox.mockResolvedValue({ response: 1 }); // "Revoke"
    const deps = makeDeps({
      onRevoke: () => ({ error: '"MacBook" was not revoked — the config file could not be written.' }),
    });
    const template = buildTrayTemplate(deps) as MenuItem[];

    const paired = template.find((item) => item.label === 'Paired devices (2)');
    paired?.submenu?.find((entry) => entry.label === 'Revoke "MacBook"…')?.click?.();
    await Promise.resolve();
    await Promise.resolve();

    expect(showMessageBox).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'error',
        title: 'Could not revoke this device',
        message: '"MacBook" was not revoked — the config file could not be written.',
      }),
    );
    expect(showMessageBox).not.toHaveBeenCalledWith(
      expect.objectContaining({ title: 'Device revoked' }),
    );
  });

  it('does not revoke when the confirmation is cancelled', async () => {
    showMessageBox.mockResolvedValue({ response: 0 }); // "Cancel"
    const deps = makeDeps();
    const template = buildTrayTemplate(deps) as MenuItem[];

    const paired = template.find((item) => item.label === 'Paired devices (2)');
    paired?.submenu?.find((entry) => entry.label === 'Revoke "MacBook"…')?.click?.();
    await Promise.resolve();
    await Promise.resolve();

    expect(deps.onRevoke).not.toHaveBeenCalled();
  });

  it('disables an already-revoked device entry', () => {
    const deps = makeDeps();
    const template = buildTrayTemplate(deps) as MenuItem[];

    const paired = template.find((item) => item.label === 'Paired devices (2)');
    const oldPhone = paired?.submenu?.find((entry) => entry.label === '"Old Phone" (revoked)');

    expect(oldPhone?.enabled).toBe(false);
  });

  it('names the bound address as a disabled, informational item', () => {
    const deps = makeDeps({ boundAddress: () => '100.101.102.103:7433' });
    const template = buildTrayTemplate(deps) as MenuItem[];

    const address = template.find((item) => item.label === 'Serving 100.101.102.103:7433');
    expect(address?.enabled).toBe(false);
  });

  it('says so when nothing is bound yet', () => {
    const deps = makeDeps({ boundAddress: () => null });
    const template = buildTrayTemplate(deps) as MenuItem[];

    const address = template.find((item) => item.label === 'Not yet listening');
    expect(address?.enabled).toBe(false);
  });

  /**
   * HIVE-142 review, I3: a port conflict or a `bind.host` that does not yet
   * resolve to a local interface (Tailscale not up) used to render the exact
   * same "Not yet listening" a socket still starting shows — indistinguishable
   * on an unattended machine with nobody to notice the difference.
   */
  it('shows the bind failure reason instead of "Not yet listening" when one occurred', () => {
    const deps = makeDeps({
      boundAddress: () => null,
      bindError: () => 'listen EADDRINUSE: address already in use 127.0.0.1:7433',
    });
    const template = buildTrayTemplate(deps) as MenuItem[];

    const address = template.find(
      (item) => item.label === 'Not serving — listen EADDRINUSE: address already in use 127.0.0.1:7433',
    );
    expect(address?.enabled).toBe(false);
    expect(template.find((item) => item.label === 'Not yet listening')).toBeUndefined();
  });

  it('prefers a bound address over a stale bind error', () => {
    const deps = makeDeps({
      boundAddress: () => '100.101.102.103:7433',
      bindError: () => 'listen EADDRINUSE: address already in use 127.0.0.1:7433',
    });
    const template = buildTrayTemplate(deps) as MenuItem[];

    expect(
      template.find((item) => item.label === 'Serving 100.101.102.103:7433'),
    ).toBeDefined();
  });

  it('Open The Hive calls onOpenConsole', () => {
    const deps = makeDeps();
    const template = buildTrayTemplate(deps) as MenuItem[];

    template.find((item) => item.label === 'Open The Hive')?.click?.();

    expect(deps.onOpenConsole).toHaveBeenCalledTimes(1);
  });

  it('offers Quit with the platform role, not a hand-rolled handler', () => {
    const deps = makeDeps();
    const template = buildTrayTemplate(deps) as MenuItem[];

    const quit = template.find((item) => item.label === 'Quit');
    expect(quit?.role).toBe('quit');
  });

  it('reads devices() fresh on every call, so a --pair elsewhere shows up unrestarted', () => {
    let count = 1;
    const deps = makeDeps({
      devices: () =>
        Array.from({ length: count }, (_, index) => ({
          id: `d_${String(index)}`,
          name: `Device ${String(index)}`,
          paired: '2026-09-07',
          revoked: false,
          credential: { kind: 'sha256', digest: 'x' } as const,
        })),
    });
    // By label, not by array position — a reordering of the template's other
    // entries must not break this on its own.
    const pairedLabel = (deps_: typeof deps) =>
      (buildTrayTemplate(deps_) as MenuItem[]).find((item) =>
        item.label?.startsWith('Paired devices'),
      )?.label;

    expect(pairedLabel(deps)).toBe('Paired devices (1)');

    count = 2;
    expect(pairedLabel(deps)).toBe('Paired devices (2)');
  });

  it('shows every dialog with no parent window (server mode runs no renderer)', async () => {
    const deps = makeDeps();
    const template = buildTrayTemplate(deps) as MenuItem[];

    template.find((item) => item.label === 'Pair a device…')?.click?.();
    await Promise.resolve();
    await Promise.resolve();

    // `showMessageBox(options)` — never `showMessageBox(window, options)`.
    for (const call of showMessageBox.mock.calls) {
      expect(call).toHaveLength(1);
    }
  });
});

describe('createServerTray', () => {
  it('constructs a Tray, sets a tooltip, and wires click and right-click to a rebuilt menu', () => {
    const deps = makeDeps();
    createServerTray(deps);

    expect(FakeTray.instances).toHaveLength(1);
    const tray = FakeTray.instances[0]!;
    expect(tray.toolTip).toBe('The Hive · serving');

    tray.handlers.get('click')?.();
    expect(tray.popUpContextMenu).toHaveBeenCalledTimes(1);

    tray.handlers.get('right-click')?.();
    expect(tray.popUpContextMenu).toHaveBeenCalledTimes(2);
  });

  it('falls back to a text title when no icon could be resolved (packaged)', () => {
    appMock.isPackaged = true; // `devIconPath` answers `undefined` once packaged.
    createServerTray(makeDeps());

    const tray = FakeTray.instances[0]!;
    expect(tray.title).toBe('Hive');
  });

  it('uses a template image and sets no fallback title when an icon resolves (dev)', () => {
    appMock.isPackaged = false; // `devIconPath` resolves the real `resources/icon.png`.
    createServerTray(makeDeps());

    expect(setTemplateImage).toHaveBeenCalledWith(true);
    const tray = FakeTray.instances[0]!;
    expect(tray.title).toBeUndefined();
  });

  it('destroy() destroys the underlying Tray', () => {
    const { destroy } = createServerTray(makeDeps());
    const tray = FakeTray.instances[0]!;

    destroy();

    expect(tray.destroyed).toBe(true);
  });
});
