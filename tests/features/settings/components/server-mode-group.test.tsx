import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ServerModeGroup } from '@features/settings/components/server-mode-group';
import { pairDevice, revokeDevice, setServerConfig } from '@lib/project-config';
import type { ServerBindConfig, ServerDevice } from '@shared/config-contract';

vi.mock('@lib/project-config', () => ({
  setServerConfig: vi.fn(() => Promise.resolve()),
  pairDevice: vi.fn(),
  revokeDevice: vi.fn(() => Promise.resolve()),
}));

/**
 * The Server mode group (HIVE-142): turning server mode on, naming the bind,
 * and pairing/revoking devices.
 *
 * Follows `container-alias-group.test.tsx`'s config-mock pattern.
 */

const DEFAULT_BIND: ServerBindConfig = {
  host: '127.0.0.1',
  port: 7433,
  allowedOrigins: [],
};

const WIDE_BIND: ServerBindConfig = {
  host: '100.64.1.2',
  port: 7433,
  allowedOrigins: [],
};

const ACTIVE_DEVICE: ServerDevice = {
  id: 'd_ab12',
  name: "Yunid's MacBook",
  paired: '2026-09-01',
  revoked: false,
  credential: { kind: 'sha256', digest: 'deadbeef' },
};

const REVOKED_DEVICE: ServerDevice = {
  id: 'd_cd34',
  name: 'Old laptop',
  paired: '2026-08-01',
  revoked: true,
  credential: { kind: 'sha256', digest: 'cafebabe' },
};

describe('ServerModeGroup', () => {
  beforeEach(() => {
    vi.mocked(setServerConfig).mockClear();
    vi.mocked(pairDevice).mockReset();
    vi.mocked(revokeDevice).mockClear();
  });

  it('is off, and its fields hidden, on a default config', () => {
    render(<ServerModeGroup enabled={false} bind={DEFAULT_BIND} devices={[]} />);

    expect(screen.getByRole('switch', { name: 'Server mode' })).not.toBeChecked();
    expect(screen.queryByLabelText(/bind address/i)).not.toBeInTheDocument();
  });

  it('says plainly what a paired device can do', () => {
    render(<ServerModeGroup enabled={false} bind={DEFAULT_BIND} devices={[]} />);

    expect(
      screen.getByText(/a paired device can open, watch and type into every session on this mac/i),
    ).toBeInTheDocument();
  });

  it('says the change takes effect at next launch', () => {
    render(<ServerModeGroup enabled={false} bind={DEFAULT_BIND} devices={[]} />);

    expect(screen.getByText(/takes effect at next launch/i)).toBeInTheDocument();
  });

  it('reveals the bind fields when turned on, and does not write them until committed', async () => {
    render(<ServerModeGroup enabled={false} bind={DEFAULT_BIND} devices={[]} />);

    await userEvent.click(screen.getByRole('switch', { name: 'Server mode' }));

    expect(screen.getByLabelText(/bind address/i)).toBeInTheDocument();
    // Flipping the switch itself commits `enabled` — the same direct write
    // `SetSlackRequest.socketMode`'s switch makes — but touches no bind field.
    expect(setServerConfig).toHaveBeenCalledTimes(1);
    expect(setServerConfig).toHaveBeenCalledWith({ enabled: true });
  });

  it('writes enabled: false when turned off', async () => {
    render(<ServerModeGroup enabled bind={DEFAULT_BIND} devices={[]} />);

    await userEvent.click(screen.getByRole('switch', { name: 'Server mode' }));

    expect(setServerConfig).toHaveBeenCalledWith({ enabled: false });
  });

  it('shows the address once server mode is on', () => {
    render(<ServerModeGroup enabled bind={WIDE_BIND} devices={[]} />);

    expect(screen.getByRole('switch', { name: 'Server mode' })).toBeChecked();
    expect(screen.getByLabelText(/bind address/i)).toHaveValue('100.64.1.2');
  });

  describe('the bind fields', () => {
    it('commits a valid address on blur', async () => {
      render(<ServerModeGroup enabled bind={DEFAULT_BIND} devices={[]} />);

      const field = screen.getByLabelText(/bind address/i);
      await userEvent.clear(field);
      await userEvent.type(field, '100.64.1.2');
      await userEvent.tab();

      expect(setServerConfig).toHaveBeenCalledWith({ bind: { host: '100.64.1.2' } });
    });

    it('refuses an address the guard would reject, and shows why', async () => {
      render(<ServerModeGroup enabled bind={DEFAULT_BIND} devices={[]} />);

      const field = screen.getByLabelText(/bind address/i);
      await userEvent.clear(field);
      await userEvent.type(field, '10.0.0.5?');
      await userEvent.tab();

      expect(setServerConfig).not.toHaveBeenCalled();
      expect(
        screen.getByText(/hostname or an ipv4 address/i),
      ).toBeInTheDocument();
    });

    /**
     * `0.0.0.0` is a legal hostname by `isHostAlias`'s own rule, so it needs
     * its own hint distinct from a merely malformed address — the reader must
     * learn *why* this one specific value is refused.
     */
    it('refuses 0.0.0.0, naming why', async () => {
      render(<ServerModeGroup enabled bind={DEFAULT_BIND} devices={[]} />);

      const field = screen.getByLabelText(/bind address/i);
      await userEvent.clear(field);
      await userEvent.type(field, '0.0.0.0');
      await userEvent.tab();

      expect(setServerConfig).not.toHaveBeenCalled();
      expect(screen.getByText(/binds every interface/i)).toBeInTheDocument();
    });

    it('commits a port on blur', async () => {
      render(<ServerModeGroup enabled bind={DEFAULT_BIND} devices={[]} />);

      const field = screen.getByLabelText(/^port$/i);
      await userEvent.clear(field);
      await userEvent.type(field, '9000');
      await userEvent.tab();

      expect(setServerConfig).toHaveBeenCalledWith({ bind: { port: 9000 } });
    });

    it('refuses a port out of range', async () => {
      render(<ServerModeGroup enabled bind={DEFAULT_BIND} devices={[]} />);

      const field = screen.getByLabelText(/^port$/i);
      await userEvent.clear(field);
      await userEvent.type(field, '99999');
      await userEvent.tab();

      expect(setServerConfig).not.toHaveBeenCalled();
      expect(screen.getByText(/port from 0 to 65535/i)).toBeInTheDocument();
    });

    it('commits allowed origins split on commas', async () => {
      render(<ServerModeGroup enabled bind={DEFAULT_BIND} devices={[]} />);

      const field = screen.getByLabelText(/allowed origins/i);
      await userEvent.type(field, 'https://a.test, , https://b.test');
      await userEvent.tab();

      expect(setServerConfig).toHaveBeenCalledWith({
        bind: { allowedOrigins: ['https://a.test', 'https://b.test'] },
      });
    });
  });

  describe('the device roster', () => {
    it('says nothing is paired on an empty roster', () => {
      render(<ServerModeGroup enabled={false} bind={DEFAULT_BIND} devices={[]} />);

      expect(screen.getByText(/no devices are paired/i)).toBeInTheDocument();
    });

    it('lists a paired device with its date', () => {
      render(
        <ServerModeGroup enabled={false} bind={DEFAULT_BIND} devices={[ACTIVE_DEVICE]} />,
      );

      expect(screen.getByText("Yunid's MacBook")).toBeInTheDocument();
      expect(screen.getByText(/paired 2026-09-01/i)).toBeInTheDocument();
    });

    it('reads a revoked device as revoked, and offers no Revoke button for it', () => {
      render(
        <ServerModeGroup enabled={false} bind={DEFAULT_BIND} devices={[REVOKED_DEVICE]} />,
      );

      expect(screen.getByText(/paired 2026-08-01 · revoked/i)).toBeInTheDocument();
      expect(
        screen.queryByRole('button', { name: /revoke/i }),
      ).not.toBeInTheDocument();
    });

    /**
     * The digest is not a secret to the server, but this pane has no reason
     * to show it — a device row names and dates a device, nothing else, and
     * a screen behind the user's shoulder should not read anything that
     * could help forge a request.
     */
    it('never shows a device’s credential digest', () => {
      const { container } = render(
        <ServerModeGroup
          enabled={false}
          bind={DEFAULT_BIND}
          devices={[ACTIVE_DEVICE, REVOKED_DEVICE]}
        />,
      );

      expect(container.textContent).not.toContain(ACTIVE_DEVICE.credential.digest);
      expect(container.textContent).not.toContain(REVOKED_DEVICE.credential.digest);
    });

    it('lists devices regardless of whether server mode is on', () => {
      render(
        <ServerModeGroup enabled={false} bind={DEFAULT_BIND} devices={[ACTIVE_DEVICE]} />,
      );

      expect(screen.getByText("Yunid's MacBook")).toBeInTheDocument();
      expect(
        screen.getByRole('button', { name: /revoke/i }),
      ).toBeInTheDocument();
    });

    it('calls revokeDevice with the device’s name when Revoke is clicked', async () => {
      render(
        <ServerModeGroup enabled={false} bind={DEFAULT_BIND} devices={[ACTIVE_DEVICE]} />,
      );

      await userEvent.click(screen.getByRole('button', { name: /revoke/i }));

      expect(revokeDevice).toHaveBeenCalledWith("Yunid's MacBook");
    });
  });

  describe('pairing', () => {
    it('shows the token once, and clears it once the roster reflects the pair', async () => {
      vi.mocked(pairDevice).mockResolvedValue({
        token: 'ABCD-EFGH-JKMN-PQRS',
      });

      const { rerender } = render(
        <ServerModeGroup enabled={false} bind={DEFAULT_BIND} devices={[]} />,
      );

      await userEvent.type(screen.getByLabelText(/device name/i), 'New laptop');
      await userEvent.click(screen.getByRole('button', { name: /^pair$/i }));

      expect(await screen.findByText(/ABCD-EFGH-JKMN-PQRS/)).toBeInTheDocument();
      expect(pairDevice).toHaveBeenCalledWith('New laptop');

      const paired: ServerDevice = {
        id: 'd_ef56',
        name: 'New laptop',
        paired: '2026-09-08',
        revoked: false,
        credential: { kind: 'sha256', digest: 'facefeed' },
      };
      rerender(
        <ServerModeGroup enabled={false} bind={DEFAULT_BIND} devices={[paired]} />,
      );

      expect(screen.queryByText(/ABCD-EFGH-JKMN-PQRS/)).not.toBeInTheDocument();
    });

    it('shows the refusal reason and no token on a duplicate name', async () => {
      vi.mocked(pairDevice).mockResolvedValue({
        error: 'A device named "New laptop" already exists.',
      });

      render(<ServerModeGroup enabled={false} bind={DEFAULT_BIND} devices={[]} />);

      await userEvent.type(screen.getByLabelText(/device name/i), 'New laptop');
      await userEvent.click(screen.getByRole('button', { name: /^pair$/i }));

      expect(
        await screen.findByText(/already exists/i),
      ).toBeInTheDocument();
    });

    it('does not pair on an empty name', async () => {
      render(<ServerModeGroup enabled={false} bind={DEFAULT_BIND} devices={[]} />);

      await userEvent.click(screen.getByRole('button', { name: /^pair$/i }));

      expect(pairDevice).not.toHaveBeenCalled();
    });
  });

  /**
   * The pane is never remounted (`advanced-section.tsx`'s `!snapshot` early
   * return only fires before the first load), so the switch and the bind
   * drafts have to follow the snapshot the same way `ContainerAliasGroup`'s
   * do.
   */
  describe('when the snapshot changes underneath it', () => {
    it('follows enabled turning on elsewhere (e.g. another session)', () => {
      const { rerender } = render(
        <ServerModeGroup enabled={false} bind={DEFAULT_BIND} devices={[]} />,
      );
      expect(screen.getByRole('switch', { name: 'Server mode' })).not.toBeChecked();

      rerender(<ServerModeGroup enabled bind={DEFAULT_BIND} devices={[]} />);

      expect(screen.getByRole('switch', { name: 'Server mode' })).toBeChecked();
    });

    it('does not write a stale bind draft back after a reset', () => {
      const { rerender } = render(
        <ServerModeGroup enabled bind={WIDE_BIND} devices={[]} />,
      );

      rerender(<ServerModeGroup enabled bind={DEFAULT_BIND} devices={[]} />);
      fireEvent.blur(screen.getByLabelText(/bind address/i));

      expect(setServerConfig).not.toHaveBeenCalled();
    });
  });
});
