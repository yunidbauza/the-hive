import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ServerModeGroup } from '@features/settings/components/server-mode-group';
import {
  forgetRemoteDevice,
  pairDevice,
  pairRemoteDevice,
  revokeDevice,
  setRemoteConfig,
  setServerConfig,
  type RemoteSwitch,
} from '@lib/project-config';
import type { RemoteLinkStatus } from '@shared/ipc-contract';
import { useHiveStore } from '@stores/hive-store';
import {
  DEFAULT_REMOTE,
  type RemoteConfig,
  type ServerBindConfig,
  type ServerDevice,
} from '@shared/config-contract';

vi.mock('@lib/project-config', () => ({
  setServerConfig: vi.fn(() => Promise.resolve()),
  pairDevice: vi.fn(),
  revokeDevice: vi.fn(() => Promise.resolve({ ok: true })),
  setRemoteConfig: vi.fn(
    () => Promise.resolve({ switched: { ok: true }, changed: null }) as Promise<RemoteSwitch>,
  ),
  pairRemoteDevice: vi.fn(),
  forgetRemoteDevice: vi.fn(() => Promise.resolve()),
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

/** A committed, valid attach target — a Tailscale MagicDNS name. */
const REMOTE_TARGET: RemoteConfig = { mode: 'local', host: 'mini.tail1234.ts.net', port: 7433 };

const ATTACHED_REMOTE: RemoteConfig = { mode: 'remote', host: 'mini.tail1234.ts.net', port: 7433 };

describe('ServerModeGroup', () => {
  beforeEach(() => {
    vi.mocked(setServerConfig).mockClear();
    vi.mocked(pairDevice).mockReset();
    vi.mocked(revokeDevice).mockReset().mockResolvedValue({ ok: true });
    vi.mocked(setRemoteConfig).mockReset().mockResolvedValue({ switched: { ok: true }, changed: null });
    vi.mocked(pairRemoteDevice).mockReset();
    vi.mocked(forgetRemoteDevice).mockReset().mockResolvedValue(undefined);
  });

  it('is off, and its fields hidden, on a default config', () => {
    render(<ServerModeGroup enabled={false} bind={DEFAULT_BIND} devices={[]} remote={DEFAULT_REMOTE} localRemote={null}
      attachedServer={null}
      attachedServerName={null}
      serving={false}
    />);

    expect(screen.getByRole('switch', { name: 'Serve this machine' })).not.toBeChecked();
    expect(screen.queryByLabelText(/bind address/i)).not.toBeInTheDocument();
  });

  it('says plainly what a paired device can do', () => {
    render(<ServerModeGroup enabled={false} bind={DEFAULT_BIND} devices={[]} remote={DEFAULT_REMOTE} localRemote={null}
      attachedServer={null}
      attachedServerName={null}
      serving={false}
    />);

    expect(
      screen.getByText(/a paired device can open, watch and type into every session on this mac/i),
    ).toBeInTheDocument();
  });

  it('says the change takes effect at next launch', () => {
    render(<ServerModeGroup enabled={false} bind={DEFAULT_BIND} devices={[]} remote={DEFAULT_REMOTE} localRemote={null}
      attachedServer={null}
      attachedServerName={null}
      serving={false}
    />);

    expect(screen.getByText(/takes effect at next launch/i)).toBeInTheDocument();
  });

  it('reveals the bind fields when turned on, and does not write them until committed', async () => {
    render(<ServerModeGroup enabled={false} bind={DEFAULT_BIND} devices={[]} remote={DEFAULT_REMOTE} localRemote={null}
      attachedServer={null}
      attachedServerName={null}
      serving={false}
    />);

    await userEvent.click(screen.getByRole('switch', { name: 'Serve this machine' }));

    expect(screen.getByLabelText(/bind address/i)).toBeInTheDocument();
    // Flipping the switch itself commits `enabled` — the same direct write
    // `SetSlackRequest.socketMode`'s switch makes — but touches no bind field.
    expect(setServerConfig).toHaveBeenCalledTimes(1);
    expect(setServerConfig).toHaveBeenCalledWith({ enabled: true });
  });

  it('writes enabled: false when turned off', async () => {
    render(<ServerModeGroup enabled bind={DEFAULT_BIND} devices={[]} remote={DEFAULT_REMOTE} localRemote={null}
      attachedServer={null}
      attachedServerName={null}
      serving={false}
    />);

    await userEvent.click(screen.getByRole('switch', { name: 'Serve this machine' }));

    expect(setServerConfig).toHaveBeenCalledWith({ enabled: false });
  });

  it('shows the address once server mode is on', () => {
    render(<ServerModeGroup enabled bind={WIDE_BIND} devices={[]} remote={DEFAULT_REMOTE} localRemote={null}
      attachedServer={null}
      attachedServerName={null}
      serving={false}
    />);

    expect(screen.getByRole('switch', { name: 'Serve this machine' })).toBeChecked();
    expect(screen.getByLabelText(/bind address/i)).toHaveValue('100.64.1.2');
  });

  describe('the bind fields', () => {
    it('commits a valid address on blur', async () => {
      render(<ServerModeGroup enabled bind={DEFAULT_BIND} devices={[]} remote={DEFAULT_REMOTE} localRemote={null}
      attachedServer={null}
      attachedServerName={null}
      serving={false}
    />);

      const field = screen.getByLabelText(/bind address/i);
      await userEvent.clear(field);
      await userEvent.type(field, '100.64.1.2');
      await userEvent.tab();

      expect(setServerConfig).toHaveBeenCalledWith({ bind: { host: '100.64.1.2' } });
    });

    it('refuses an address the guard would reject, and shows why', async () => {
      render(<ServerModeGroup enabled bind={DEFAULT_BIND} devices={[]} remote={DEFAULT_REMOTE} localRemote={null}
      attachedServer={null}
      attachedServerName={null}
      serving={false}
    />);

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
      render(<ServerModeGroup enabled bind={DEFAULT_BIND} devices={[]} remote={DEFAULT_REMOTE} localRemote={null}
      attachedServer={null}
      attachedServerName={null}
      serving={false}
    />);

      const field = screen.getByLabelText(/bind address/i);
      await userEvent.clear(field);
      await userEvent.type(field, '0.0.0.0');
      await userEvent.tab();

      expect(setServerConfig).not.toHaveBeenCalled();
      expect(screen.getByText(/binds every interface/i)).toBeInTheDocument();
    });

    it('commits a port on blur', async () => {
      render(<ServerModeGroup enabled bind={DEFAULT_BIND} devices={[]} remote={DEFAULT_REMOTE} localRemote={null}
      attachedServer={null}
      attachedServerName={null}
      serving={false}
    />);

      const field = screen.getByLabelText(/^port$/i);
      await userEvent.clear(field);
      await userEvent.type(field, '9000');
      await userEvent.tab();

      expect(setServerConfig).toHaveBeenCalledWith({ bind: { port: 9000 } });
    });

    it('refuses a port out of range', async () => {
      render(<ServerModeGroup enabled bind={DEFAULT_BIND} devices={[]} remote={DEFAULT_REMOTE} localRemote={null}
      attachedServer={null}
      attachedServerName={null}
      serving={false}
    />);

      const field = screen.getByLabelText(/^port$/i);
      await userEvent.clear(field);
      await userEvent.type(field, '99999');
      await userEvent.tab();

      expect(setServerConfig).not.toHaveBeenCalled();
      expect(screen.getByText(/port from 1 to 65535/i)).toBeInTheDocument();
    });

    /**
     * Unlike the receiver's own bind, `server.bind.port` cannot be 0 — a
     * client's config and a LaunchAgent both have to be told this number
     * ahead of time (HIVE-142 review, I3). The field refuses it client-side
     * rather than sending a request `config:set-server` would refuse anyway.
     */
    it('refuses port 0, unlike the receiver bind', async () => {
      render(<ServerModeGroup enabled bind={DEFAULT_BIND} devices={[]} remote={DEFAULT_REMOTE} localRemote={null}
      attachedServer={null}
      attachedServerName={null}
      serving={false}
    />);

      const field = screen.getByLabelText(/^port$/i);
      await userEvent.clear(field);
      await userEvent.type(field, '0');
      await userEvent.tab();

      expect(setServerConfig).not.toHaveBeenCalled();
      expect(screen.getByText(/port from 1 to 65535/i)).toBeInTheDocument();
    });

    it('commits allowed origins split on commas', async () => {
      render(<ServerModeGroup enabled bind={DEFAULT_BIND} devices={[]} remote={DEFAULT_REMOTE} localRemote={null}
      attachedServer={null}
      attachedServerName={null}
      serving={false}
    />);

      const field = screen.getByLabelText(/allowed origins/i);
      await userEvent.type(field, 'https://a.test, , https://b.test');
      await userEvent.tab();

      expect(setServerConfig).toHaveBeenCalledWith({
        bind: { allowedOrigins: ['https://a.test', 'https://b.test'] },
      });
    });

    it('names the server, not this window, while attached', () => {
      render(
        <ServerModeGroup
          enabled
          bind={WIDE_BIND}
          devices={[]}
          remote={DEFAULT_REMOTE}
          localRemote={null}
          attachedServer={null}
          attachedServerName="mini"
          serving={false}
        />,
      );

      expect(screen.getByLabelText(/bind address/i)).toBeInTheDocument();
      expect(
        screen.getByText(/these are the server's bind settings, not this window's own/i),
      ).toBeInTheDocument();
    });
  });

  describe('the device roster', () => {
    it('says nothing is paired on an empty roster', () => {
      render(<ServerModeGroup enabled={false} bind={DEFAULT_BIND} devices={[]} remote={DEFAULT_REMOTE} localRemote={null}
      attachedServer={null}
      attachedServerName={null}
      serving={false}
    />);

      expect(screen.getByText(/no devices are paired/i)).toBeInTheDocument();
    });

    it('lists a paired device with its date', () => {
      render(
        <ServerModeGroup enabled={false} bind={DEFAULT_BIND} devices={[ACTIVE_DEVICE]} remote={DEFAULT_REMOTE} localRemote={null}
      attachedServer={null}
      attachedServerName={null}
      serving={false}
    />,
      );

      expect(screen.getByText("Yunid's MacBook")).toBeInTheDocument();
      expect(screen.getByText(/paired 2026-09-01/i)).toBeInTheDocument();
    });

    it('reads a revoked device as revoked, and offers no Revoke button for it', () => {
      render(
        <ServerModeGroup enabled={false} bind={DEFAULT_BIND} devices={[REVOKED_DEVICE]} remote={DEFAULT_REMOTE} localRemote={null}
      attachedServer={null}
      attachedServerName={null}
      serving={false}
    />,
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
        remote={DEFAULT_REMOTE}
        localRemote={null}
      attachedServer={null}
      attachedServerName={null}
      serving={false}
    />,
      );

      expect(container.textContent).not.toContain(ACTIVE_DEVICE.credential.digest);
      expect(container.textContent).not.toContain(REVOKED_DEVICE.credential.digest);
    });

    it('lists devices regardless of whether server mode is on', () => {
      render(
        <ServerModeGroup enabled={false} bind={DEFAULT_BIND} devices={[ACTIVE_DEVICE]} remote={DEFAULT_REMOTE} localRemote={null}
      attachedServer={null}
      attachedServerName={null}
      serving={false}
    />,
      );

      expect(screen.getByText("Yunid's MacBook")).toBeInTheDocument();
      expect(
        screen.getByRole('button', { name: /revoke/i }),
      ).toBeInTheDocument();
    });

    it('calls revokeDevice with the device’s name when Revoke is clicked', async () => {
      render(
        <ServerModeGroup enabled={false} bind={DEFAULT_BIND} devices={[ACTIVE_DEVICE]} remote={DEFAULT_REMOTE} localRemote={null}
      attachedServer={null}
      attachedServerName={null}
      serving={false}
    />,
      );

      await userEvent.click(screen.getByRole('button', { name: /revoke/i }));

      expect(revokeDevice).toHaveBeenCalledWith("Yunid's MacBook");
    });

    /**
     * Review finding, Important: a failed revoke used to be silent — the row
     * did not change and nothing said why. Reachable without malice: a name
     * hand-edited into the config, or paired from the CLI, can carry a
     * control character `assertText` (`parseRevokeDeviceRequest`) refuses,
     * so the invoke rejects permanently for a button the user can see and
     * click.
     */
    it('shows why, beside the roster, when a revoke is refused', async () => {
      vi.mocked(revokeDevice).mockResolvedValue({
        ok: false,
        error: 'Could not revoke the device. Try again.',
      });

      render(
        <ServerModeGroup enabled={false} bind={DEFAULT_BIND} devices={[ACTIVE_DEVICE]} remote={DEFAULT_REMOTE} localRemote={null}
      attachedServer={null}
      attachedServerName={null}
      serving={false}
    />,
      );

      await userEvent.click(screen.getByRole('button', { name: /revoke/i }));

      expect(
        await screen.findByText(/could not revoke "yunid's macbook"/i),
      ).toBeInTheDocument();
    });

    it('names the server, not this window, when Revoke would act while attached', () => {
      render(
        <ServerModeGroup
          enabled={false}
          bind={DEFAULT_BIND}
          devices={[ACTIVE_DEVICE]}
          remote={DEFAULT_REMOTE}
          localRemote={null}
          attachedServer={null}
          attachedServerName="mini"
          serving={false}
        />,
      );

      expect(
        screen.getByText(/this is the server's device roster/i),
      ).toBeInTheDocument();
    });
  });

  describe('pairing', () => {
    /**
     * Review finding ("the comment describes a mechanism the code does not
     * have"): the token used to be cleared by watching `devices` change,
     * which raced `pairDevice`'s own snapshot re-read and either cleared it
     * late or, on a different flush order, in the same commit that first
     * showed it. The token's lifetime must not depend on any of that — it is
     * proven here by *not* changing `devices` at all and asserting the token
     * still shows, then dismissing it explicitly.
     */
    it('shows the token, and it survives an unrelated re-render, until dismissed', async () => {
      vi.mocked(pairDevice).mockResolvedValue({
        token: 'ABCD-EFGH-JKMN-PQRS',
        deviceId: 'd_ef56',
      });

      const { rerender } = render(
        <ServerModeGroup enabled={false} bind={DEFAULT_BIND} devices={[]} remote={DEFAULT_REMOTE} localRemote={null}
      attachedServer={null}
      attachedServerName={null}
      serving={false}
    />,
      );

      await userEvent.type(screen.getByLabelText(/device name/i), 'New laptop');
      await userEvent.click(screen.getByRole('button', { name: /^pair$/i }));

      expect(await screen.findByText(/ABCD-EFGH-JKMN-PQRS/)).toBeInTheDocument();
      // The device id alongside the token (HIVE-142 review, I5) — the attach
      // handshake needs both, and it used to be readable only inside
      // config.json.
      expect(screen.getByText(/d_ef56/)).toBeInTheDocument();
      expect(pairDevice).toHaveBeenCalledWith('New laptop');

      // An unrelated re-render — same props, a fresh `devices` reference,
      // exactly the shape a snapshot update elsewhere in the app takes.
      rerender(<ServerModeGroup enabled={false} bind={DEFAULT_BIND} devices={[]} remote={DEFAULT_REMOTE} localRemote={null}
      attachedServer={null}
      attachedServerName={null}
      serving={false}
    />);
      expect(screen.getByText(/ABCD-EFGH-JKMN-PQRS/)).toBeInTheDocument();

      // Even a re-render where the roster genuinely did change does not
      // clear it — only the explicit "Done" action does.
      const paired: ServerDevice = {
        id: 'd_ef56',
        name: 'New laptop',
        paired: '2026-09-08',
        revoked: false,
        credential: { kind: 'sha256', digest: 'facefeed' },
      };
      rerender(
        <ServerModeGroup enabled={false} bind={DEFAULT_BIND} devices={[paired]} remote={DEFAULT_REMOTE} localRemote={null}
      attachedServer={null}
      attachedServerName={null}
      serving={false}
    />,
      );
      expect(screen.getByText(/ABCD-EFGH-JKMN-PQRS/)).toBeInTheDocument();

      await userEvent.click(screen.getByRole('button', { name: /^done$/i }));

      expect(screen.queryByText(/ABCD-EFGH-JKMN-PQRS/)).not.toBeInTheDocument();
    });

    it('shows the refusal reason and no token on a duplicate name', async () => {
      vi.mocked(pairDevice).mockResolvedValue({
        error: 'A device named "New laptop" already exists.',
      });

      render(<ServerModeGroup enabled={false} bind={DEFAULT_BIND} devices={[]} remote={DEFAULT_REMOTE} localRemote={null}
      attachedServer={null}
      attachedServerName={null}
      serving={false}
    />);

      await userEvent.type(screen.getByLabelText(/device name/i), 'New laptop');
      await userEvent.click(screen.getByRole('button', { name: /^pair$/i }));

      expect(
        await screen.findByText(/already exists/i),
      ).toBeInTheDocument();
    });

    /**
     * Review finding, Minor 2: a failed pair used to leave an earlier
     * success's token rendered beneath the new error.
     */
    it('clears a previously shown token once a new pairing attempt fails', async () => {
      vi.mocked(pairDevice).mockResolvedValueOnce({
        token: 'ABCD-EFGH-JKMN-PQRS',
        deviceId: 'd_ef56',
      });

      render(<ServerModeGroup enabled={false} bind={DEFAULT_BIND} devices={[]} remote={DEFAULT_REMOTE} localRemote={null}
      attachedServer={null}
      attachedServerName={null}
      serving={false}
    />);

      await userEvent.type(screen.getByLabelText(/device name/i), 'First device');
      await userEvent.click(screen.getByRole('button', { name: /^pair$/i }));
      expect(await screen.findByText(/ABCD-EFGH-JKMN-PQRS/)).toBeInTheDocument();

      vi.mocked(pairDevice).mockResolvedValueOnce({
        error: 'A device named "First device" already exists.',
      });
      await userEvent.type(screen.getByLabelText(/device name/i), 'First device');
      await userEvent.click(screen.getByRole('button', { name: /^pair$/i }));

      expect(await screen.findByText(/already exists/i)).toBeInTheDocument();
      expect(screen.queryByText(/ABCD-EFGH-JKMN-PQRS/)).not.toBeInTheDocument();
    });

    it('does not pair on an empty name', async () => {
      render(<ServerModeGroup enabled={false} bind={DEFAULT_BIND} devices={[]} remote={DEFAULT_REMOTE} localRemote={null}
      attachedServer={null}
      attachedServerName={null}
      serving={false}
    />);

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
        <ServerModeGroup enabled={false} bind={DEFAULT_BIND} devices={[]} remote={DEFAULT_REMOTE} localRemote={null}
      attachedServer={null}
      attachedServerName={null}
      serving={false}
    />,
      );
      expect(screen.getByRole('switch', { name: 'Serve this machine' })).not.toBeChecked();

      rerender(<ServerModeGroup enabled bind={DEFAULT_BIND} devices={[]} remote={DEFAULT_REMOTE} localRemote={null}
      attachedServer={null}
      attachedServerName={null}
      serving={false}
    />);

      expect(screen.getByRole('switch', { name: 'Serve this machine' })).toBeChecked();
    });

    it('does not write a stale bind draft back after a reset', () => {
      const { rerender } = render(
        <ServerModeGroup enabled bind={WIDE_BIND} devices={[]} remote={DEFAULT_REMOTE} localRemote={null}
      attachedServer={null}
      attachedServerName={null}
      serving={false}
    />,
      );

      rerender(<ServerModeGroup enabled bind={DEFAULT_BIND} devices={[]} remote={DEFAULT_REMOTE} localRemote={null}
      attachedServer={null}
      attachedServerName={null}
      serving={false}
    />);
      fireEvent.blur(screen.getByLabelText(/bind address/i));

      expect(setServerConfig).not.toHaveBeenCalled();
    });
  });

  /**
   * The attach half (HIVE-144): "Attach to a server", the opposite direction
   * from everything above. `config:set-remote` answers a `SetRemoteResult` —
   * `{ switched, config }` — because attaching, unlike serving, applies
   * immediately and can be refused right now (Ruling 19). This pane must
   * render every `SwitchOutcome` arm and must never present a refused
   * address as saved.
   */
  describe('attaching to a server', () => {
    it('is off by default and discloses nothing', () => {
      render(
        <ServerModeGroup
          enabled={false}
          bind={DEFAULT_BIND}
          devices={[]}
          remote={DEFAULT_REMOTE}
          localRemote={null}
          attachedServer={null}
          attachedServerName={null}
          serving={false}
        />,
      );

      expect(
        screen.getByRole('switch', { name: 'Attach to a server' }),
      ).not.toBeChecked();
      expect(screen.queryByLabelText(/server address/i)).not.toBeInTheDocument();
      expect(screen.queryByRole('button', { name: /^attach$/i })).not.toBeInTheDocument();
    });

    /**
     * The positive control this test's own absence proves nothing without:
     * turned on, the same fields the test above asserted absent must appear.
     */
    it('reveals the address fields when turned on', async () => {
      render(
        <ServerModeGroup
          enabled={false}
          bind={DEFAULT_BIND}
          devices={[]}
          remote={DEFAULT_REMOTE}
          localRemote={null}
          attachedServer={null}
          attachedServerName={null}
          serving={false}
        />,
      );

      await userEvent.click(screen.getByRole('switch', { name: 'Attach to a server' }));

      expect(screen.getByLabelText(/server address/i)).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /^attach$/i })).toBeInTheDocument();
      // Opening the panel is not itself an attach attempt.
      expect(setRemoteConfig).not.toHaveBeenCalled();
    });

    it('says attaching applies immediately', async () => {
      render(
        <ServerModeGroup
          enabled={false}
          bind={DEFAULT_BIND}
          devices={[]}
          remote={DEFAULT_REMOTE}
          localRemote={null}
          attachedServer={null}
          attachedServerName={null}
          serving={false}
        />,
      );

      expect(screen.getByText(/applies immediately/i)).toBeInTheDocument();
    });

    it('refuses an address that is neither loopback nor tailnet, with a hint', async () => {
      render(
        <ServerModeGroup
          enabled={false}
          bind={DEFAULT_BIND}
          devices={[]}
          remote={DEFAULT_REMOTE}
          localRemote={null}
          attachedServer={null}
          attachedServerName={null}
          serving={false}
        />,
      );

      await userEvent.click(screen.getByRole('switch', { name: 'Attach to a server' }));
      const field = screen.getByLabelText(/server address/i);
      await userEvent.clear(field);
      await userEvent.type(field, '8.8.8.8');
      await userEvent.tab();

      expect(setRemoteConfig).not.toHaveBeenCalled();
      expect(
        screen.getByText(/must be a loopback or tailnet address/i),
      ).toBeInTheDocument();
    });

    it('commits a valid address on blur, without switching mode', async () => {
      render(
        <ServerModeGroup
          enabled={false}
          bind={DEFAULT_BIND}
          devices={[]}
          remote={DEFAULT_REMOTE}
          localRemote={null}
          attachedServer={null}
          attachedServerName={null}
          serving={false}
        />,
      );

      await userEvent.click(screen.getByRole('switch', { name: 'Attach to a server' }));
      const field = screen.getByLabelText(/server address/i);
      await userEvent.clear(field);
      await userEvent.type(field, 'mini.tail1234.ts.net');
      await userEvent.tab();

      expect(setRemoteConfig).toHaveBeenCalledWith({ host: 'mini.tail1234.ts.net' });
    });

    /**
     * The same blur, from the state it actually happens in (HIVE-144 review,
     * I6). Ruling 19 leaves this machine's `remote.mode` at `'remote'` after a
     * failed boot attach so the next launch retries — which is exactly when
     * someone is in this field fixing the address. The payload must still name
     * no mode: `applySetRemote` no longer merges one, so an omitted `mode` is
     * what makes this a write rather than a dial. See
     * `tests/electron/main/ipc/set-remote.test.ts` for the other half.
     */
    it('sends no mode from a blur even when the config already says remote', async () => {
      render(
        <ServerModeGroup
          enabled={false}
          bind={DEFAULT_BIND}
          devices={[]}
          remote={ATTACHED_REMOTE}
          localRemote={null}
          attachedServer={{ name: 'mini.tail1234.ts.net', host: 'mini.tail1234.ts.net' }}
          attachedServerName={null}
          serving={false}
        />,
      );

      const field = screen.getByLabelText(/server address/i);
      await userEvent.clear(field);
      await userEvent.type(field, '100.64.1.9');
      await userEvent.tab();

      expect(setRemoteConfig).toHaveBeenCalledExactlyOnceWith({ host: '100.64.1.9' });
    });

    it('sends no mode from a port blur either', async () => {
      render(
        <ServerModeGroup
          enabled={false}
          bind={DEFAULT_BIND}
          devices={[]}
          remote={ATTACHED_REMOTE}
          localRemote={null}
          attachedServer={{ name: 'mini.tail1234.ts.net', host: 'mini.tail1234.ts.net' }}
          attachedServerName={null}
          serving={false}
        />,
      );

      const field = screen.getAllByLabelText(/^port$/i).at(-1);
      if (field === undefined) throw new Error('the attach port field is not rendered');
      await userEvent.clear(field);
      await userEvent.type(field, '9001');
      await userEvent.tab();

      expect(setRemoteConfig).toHaveBeenCalledExactlyOnceWith({ port: 9001 });
    });

    it('names the live sessions when the switch is refused', async () => {
      vi.mocked(setRemoteConfig).mockResolvedValue({
        switched: {
          ok: false,
          reason: 'live-sessions',
          sessions: ['hero-refresh', 'api-migration'],
        },
        changed: null,
      });

      render(
        <ServerModeGroup
          enabled={false}
          bind={DEFAULT_BIND}
          devices={[]}
          remote={REMOTE_TARGET}
          localRemote={null}
          attachedServer={null}
          attachedServerName={null}
          serving={false}
        />,
      );

      await userEvent.click(screen.getByRole('switch', { name: 'Attach to a server' }));
      await userEvent.click(screen.getByRole('button', { name: /^attach$/i }));

      expect(
        await screen.findByText(/can.t attach while sessions are running here/i),
      ).toBeInTheDocument();
      // Both names, not just the first — a component that only renders
      // `sessions[0]` passes a naive assertion but fails this one.
      expect(screen.getByText('hero-refresh')).toBeInTheDocument();
      expect(screen.getByText('api-migration')).toBeInTheDocument();
    });

    it('shows the message from a connect-failed refusal', async () => {
      vi.mocked(setRemoteConfig).mockResolvedValue({
        switched: {
          ok: false,
          reason: 'connect-failed',
          message: 'ECONNREFUSED 100.64.1.2:7433',
        },
        changed: null,
      });

      render(
        <ServerModeGroup
          enabled={false}
          bind={DEFAULT_BIND}
          devices={[]}
          remote={REMOTE_TARGET}
          localRemote={null}
          attachedServer={null}
          attachedServerName={null}
          serving={false}
        />,
      );

      await userEvent.click(screen.getByRole('switch', { name: 'Attach to a server' }));
      await userEvent.click(screen.getByRole('button', { name: /^attach$/i }));

      expect(
        await screen.findByText(/could not attach: ECONNREFUSED 100.64.1.2:7433/i),
      ).toBeInTheDocument();
    });

    /**
     * Fix round 1, item 1 (IMPORTANT). Pre-fix, the switch's `onCheckedChange`
     * set `attachOpen` to `false` *before* `handleDetach`'s promise settled —
     * so the panel carrying the `connect-failed` message was already
     * unmounted by the time it had something to say, and the switch had
     * already flipped to unchecked over a detach that had not happened yet.
     * This test is written and run against the pre-fix code first, confirmed
     * failing, then the fix applied — see the task report for the verbatim
     * failure.
     */
    it('keeps the failure visible and the switch on when a detach attempt fails', async () => {
      vi.mocked(setRemoteConfig).mockResolvedValue({
        switched: {
          ok: false,
          reason: 'connect-failed',
          message: 'ECONNREFUSED',
        },
        changed: null,
      });

      render(
        <ServerModeGroup
          enabled={false}
          bind={DEFAULT_BIND}
          devices={[]}
          remote={ATTACHED_REMOTE}
          localRemote={null}
          attachedServer={{ name: 'mini', host: 'mini.tail1234.ts.net' }}
          attachedServerName="mini"
          serving={false}
        />,
      );

      const toggle = screen.getByRole('switch', { name: 'Attach to a server' });
      expect(toggle).toBeChecked();

      await userEvent.click(toggle);

      expect(await screen.findByText(/could not detach: ECONNREFUSED/i)).toBeInTheDocument();
      // The switch must not claim a state the app is not in: the write never
      // landed, so this window is still attached.
      expect(toggle).toBeChecked();
    });

    /**
     * Fix round 1, item 2 (IMPORTANT). Pre-fix, the "Attached to…" sentence
     * asserted "`config:get` is answered by the far end" unconditionally from
     * `attachedServer` — a config-derived field. `ConfigSnapshot.attachedServer`'s
     * own doc comment says that can be false: Ruling 19 leaves `remote.mode`
     * saying `'remote'` on disk after a failed re-dial rebinds local, so this
     * field can claim an attachment that is not actually live. Written and run
     * against the pre-fix code first — see the task report for the verbatim
     * failure.
     */
    it('does not claim a live socket from the config-derived attachedServer field', async () => {
      vi.mocked(setRemoteConfig).mockResolvedValue({
        switched: {
          ok: false,
          reason: 'connect-failed',
          message: 'ECONNREFUSED',
        },
        changed: null,
      });

      render(
        <ServerModeGroup
          enabled={false}
          bind={DEFAULT_BIND}
          devices={[]}
          remote={ATTACHED_REMOTE}
          localRemote={null}
          attachedServer={{ name: 'mini', host: 'mini.tail1234.ts.net' }}
          attachedServerName={null}
          serving={false}
        />,
      );

      await userEvent.click(screen.getByRole('button', { name: /^attach$/i }));

      expect(
        await screen.findByText(/could not (attach|detach): ECONNREFUSED/i),
      ).toBeInTheDocument();
      // The config-derived sentence must never claim a socket is actually
      // open right now — that claim belongs to `AppInfo.attachedServerName`,
      // deliberately not available here.
      expect(screen.queryByText(/answered by the far end/i)).not.toBeInTheDocument();
    });

    /**
     * Fix round 1, item 5 (Minor, M2). Pre-fix this was only a hint-text
     * swap beneath the address field — the same weight an ordinary,
     * client-side validation failure gets. It now gets the same red
     * bordered box `live-sessions` does, and the field's own hint goes back
     * to its ordinary copy rather than hiding the refusal inside it.
     */
    it('gives plaintext-refused the same visual weight as the other refusals', async () => {
      vi.mocked(setRemoteConfig).mockResolvedValue({
        switched: { ok: false, reason: 'plaintext-refused' },
        changed: null,
      });

      render(
        <ServerModeGroup
          enabled={false}
          bind={DEFAULT_BIND}
          devices={[]}
          remote={REMOTE_TARGET}
          localRemote={null}
          attachedServer={null}
          attachedServerName={null}
          serving={false}
        />,
      );

      await userEvent.click(screen.getByRole('switch', { name: 'Attach to a server' }));
      await userEvent.click(screen.getByRole('button', { name: /^attach$/i }));

      const banner = await screen.findByText(/must be a loopback or tailnet address/i);
      // Not merely the field's hint: a dedicated, bordered box, the same
      // shape `live-sessions` renders at.
      expect(banner.closest('div')).toHaveClass('border-red');

      // And the field's own hint is no longer where the refusal hides.
      expect(
        screen.getByLabelText(/server address/i),
      ).toHaveAccessibleDescription(/100\.64\.0\.0\/10/);
    });

    /**
     * Ruling 19, made concrete: a refused switch leaves `config.json`
     * untouched, so the field must show what is actually stored — the
     * machine's previous, still-valid address — never the one that was just
     * tried and refused.
     */
    it('shows the stored address again after a refused switch, not the one just tried', async () => {
      vi.mocked(setRemoteConfig).mockResolvedValue({
        switched: {
          ok: false,
          reason: 'connect-failed',
          message: 'timed out',
        },
        changed: null,
      });

      render(
        <ServerModeGroup
          enabled={false}
          bind={DEFAULT_BIND}
          devices={[]}
          remote={REMOTE_TARGET}
          localRemote={null}
          attachedServer={null}
          attachedServerName={null}
          serving={false}
        />,
      );

      await userEvent.click(screen.getByRole('switch', { name: 'Attach to a server' }));
      const field = screen.getByLabelText(/server address/i);
      await userEvent.clear(field);
      await userEvent.type(field, 'other-box.tail1234.ts.net');
      await userEvent.click(screen.getByRole('button', { name: /^attach$/i }));

      await screen.findByText(/could not attach: timed out/i);

      expect(field).toHaveValue(REMOTE_TARGET.host);
    });

    it('detaches immediately when turned off while attached — never refused', async () => {
      render(
        <ServerModeGroup
          enabled={false}
          bind={DEFAULT_BIND}
          devices={[]}
          remote={ATTACHED_REMOTE}
          localRemote={null}
          attachedServer={{ name: 'mini', host: 'mini.tail1234.ts.net' }}
          attachedServerName="mini"
          serving={false}
        />,
      );

      expect(
        screen.getByRole('switch', { name: 'Attach to a server' }),
      ).toBeChecked();

      await userEvent.click(screen.getByRole('switch', { name: 'Attach to a server' }));

      expect(setRemoteConfig).toHaveBeenCalledWith({ mode: 'local' });
      // A successful detach — the mock's default `{ ok: true }` — actually
      // closes the panel, unlike a failed one (see the test above item 1
      // fixes).
      expect(
        await screen.findByRole('switch', { name: 'Attach to a server' }),
      ).not.toBeChecked();
      expect(screen.queryByLabelText(/server address/i)).not.toBeInTheDocument();
    });

    /*
      ## Ruling 29: the attach half keys on the runtime field, not the snapshot
      ## it is rendered beside

      These four cases all describe **the shape a real attached client is
      actually in**, which is the shape none of the tests above could reach:
      `config:get` is proxied, so the `remote` block a live attached window
      renders from is the *server's*, and a server is not itself attached to
      anything — its block is `DEFAULT_REMOTE`, `mode: 'local'`. Measured on
      two built apps before any of this was written; the pane rendered its
      switch `aria-checked="false"` on an attached window and the whole panel
      stayed collapsed, so the click that sends `config:set-remote` with
      `{ mode: 'local' }` could not be made at all.

      `SERVER_ANSWERED_REMOTE` is that block. Every case below pairs it with a
      non-null `attachedServerName`, which is the only thing that tells this
      component a socket is open.
    */
    const SERVER_ANSWERED_REMOTE: RemoteConfig = { mode: 'local', host: '', port: 7433 };

    it('opens the panel on an attached client whose snapshot comes from the server', () => {
      render(
        <ServerModeGroup
          enabled={false}
          bind={DEFAULT_BIND}
          devices={[]}
          remote={SERVER_ANSWERED_REMOTE}
          localRemote={null}
          attachedServer={null}
          attachedServerName="mini"
          serving={false}
        />,
      );

      // The switch, and therefore the panel, follows the socket rather than
      // the far machine's idea of its own mode.
      expect(screen.getByRole('switch', { name: 'Attach to a server' })).toBeChecked();
    });

    it('names the machine the socket is open to, not one the far config mentions', () => {
      render(
        <ServerModeGroup
          enabled={false}
          bind={DEFAULT_BIND}
          devices={[]}
          remote={SERVER_ANSWERED_REMOTE}
          localRemote={null}
          attachedServer={null}
          attachedServerName="mini"
          serving={false}
        />,
      );

      // `attachedServer` is `null` here — exactly what a real attached client
      // gets — so this sentence can only have come from the runtime field.
      expect(screen.getByText(/attached to/i)).toBeInTheDocument();
      expect(screen.getByText('mini')).toBeInTheDocument();
    });

    /*
      The blocking half. Before Ruling 29 this click fell through to
      `setAttachOpen(false)` and merely collapsed a panel: the guard read
      `remote.mode === 'remote'`, and `remote.mode` here is `'local'` because
      the server answered it. There was no other route out of remote mode —
      `config:reveal` is `WINDOW_BOUND`, so even hand-editing was refused from
      inside the app.
    */
    it('detaches from an attached client even though the snapshot says local', async () => {
      render(
        <ServerModeGroup
          enabled={false}
          bind={DEFAULT_BIND}
          devices={[]}
          remote={SERVER_ANSWERED_REMOTE}
          localRemote={null}
          attachedServer={null}
          attachedServerName="mini"
          serving={false}
        />,
      );

      await userEvent.click(screen.getByRole('switch', { name: 'Attach to a server' }));

      expect(setRemoteConfig).toHaveBeenCalledWith({ mode: 'local' });
    });

    /*
      The other half of the same guard, and the trap Ruling 29 briefly swapped
      the first one for: **configured but not attached**.

      Ruling 19 deliberately leaves this machine's `remote.mode` at `'remote'`
      when a boot attach fails, so the next launch retries. That is the state a
      user is in after a server goes away, and this switch is the only thing
      that stops it dialling at every launch. Keyed on `attachedServerName`
      alone the click writes nothing — the panel collapses, the file still says
      `'remote'`, and the next launch dials again.

      Note what distinguishes this from the case above: there, the file said
      `'local'` and the socket was live; here the file says `'remote'` and there
      is no socket. Both are "turn it off", and a guard reading either half
      alone answers one of them by collapsing a panel.
    */
    it('stops a failed boot attach from retrying, with no socket to detach from', async () => {
      render(
        <ServerModeGroup
          enabled={false}
          bind={DEFAULT_BIND}
          devices={[]}
          remote={ATTACHED_REMOTE}
          localRemote={null}
          attachedServer={null}
          attachedServerName={null}
          serving={false}
        />,
      );

      await userEvent.click(screen.getByRole('switch', { name: 'Attach to a server' }));

      expect(setRemoteConfig).toHaveBeenCalledWith({ mode: 'local' });
    });

    /*
      HIVE-149 retired the hide this block used to assert.

      The address and the port used to read `remote.host`/`remote.port` — the
      *server's*, while attached — so they were hidden rather than disabled:
      disabling leaves the wrong values on screen with an explanation beside
      them, and `config:set-remote` writes locally (Ruling 28), so a commit
      would not even have written what the field showed.

      Both halves of that objection are answered by reading `localRemote`
      instead, which is this machine's own block over `config:get-remote`. The
      field now shows exactly what a commit would write.

      Attach did *not* come back with them: there is still nothing to dial from
      a window that already has a socket open.
    */
    it("shows this machine's own address and port while attached", () => {
      render(
        <ServerModeGroup
          enabled={false}
          bind={DEFAULT_BIND}
          devices={[]}
          remote={SERVER_ANSWERED_REMOTE}
          localRemote={{ mode: 'remote', host: 'mini.tail1234.ts.net', port: 7433 }}
          attachedServer={null}
          attachedServerName="mini"
          serving={false}
        />,
      );

      expect(screen.getByLabelText(/server address/i)).toHaveValue('mini.tail1234.ts.net');
      expect(screen.getByLabelText(/^port$/i)).toHaveValue('7433');
      expect(screen.queryByRole('button', { name: /^attach$/i })).not.toBeInTheDocument();
      // And it says whose config those two fields are, since the rest of the
      // pane is showing the server's.
      expect(screen.getByText(/read from this machine/i)).toBeInTheDocument();
    });

    /*
      The assertion that actually discriminates a local read from a proxied one:
      the two blocks are made to disagree. `SERVER_ANSWERED_REMOTE` is the far
      end's, with an empty host — rendering *that* while attached is the defect
      this story closes, and a pane still reading `remote` would show it.
    */
    it('prefers the local block over the proxied one for the address fields', () => {
      render(
        <ServerModeGroup
          enabled={false}
          bind={DEFAULT_BIND}
          devices={[]}
          remote={SERVER_ANSWERED_REMOTE}
          localRemote={{ mode: 'remote', host: '100.101.102.103', port: 7500 }}
          attachedServer={null}
          attachedServerName="mini"
          serving={false}
        />,
      );

      expect(screen.getByLabelText(/server address/i)).toHaveValue('100.101.102.103');
      expect(screen.getByLabelText(/^port$/i)).toHaveValue('7500');
    });

    /*
      `localRemote` is null until the read lands. Falling back to the proxied
      block is what this pane already did on its first render before HIVE-149 —
      `attachedServerName` arrives a tick late too, so `attached` is false until
      it does — and the correction arrives with the read.
    */
    /*
      **Absent, not fallen back, before the read lands.**

      This case asserted the opposite for one review round, on the belief that an
      attached window's first render has `attached === false` anyway because
      `attachedServerName` arrived a tick late. That was true of the `app:info`
      read it used to be, and false since HIVE-150 made `useAttachedServer` a
      synchronous store read — so `attached` is true on the first render while
      `localRemote` is still `null`, and a fallback painted the server's `''`
      host and default port directly under copy claiming they came from this
      machine. Settings unmounts, so that was every open, not once per launch.
    */
    it('shows no address fields, and says so, before the local read lands', () => {
      render(
        <ServerModeGroup
          enabled={false}
          bind={DEFAULT_BIND}
          devices={[]}
          remote={{ mode: 'local', host: 'server-side.ts.net', port: 7433 }}
          localRemote={null}
          attachedServer={null}
          attachedServerName="mini"
          serving={false}
        />,
      );

      expect(screen.queryByLabelText(/server address/i)).not.toBeInTheDocument();
      expect(screen.queryByLabelText(/^port$/i)).not.toBeInTheDocument();
      expect(screen.getByText(/reading this machine/i)).toBeInTheDocument();
      // And never the server's value, which is the whole point of the absence.
      expect(screen.queryByDisplayValue('server-side.ts.net')).not.toBeInTheDocument();
    });

    /*
      Committing while attached — the behaviour this story newly enables, and
      which nothing exercised until the whole-branch review pointed out that
      both of its defects lived here.

      The two blocks are made to disagree on the port in the way that actually
      happens: this window dials 9000, the server's own `remote.port` is the
      default 7433, and the user types 7433. Guarded against `remote` that
      returned early and dropped the write, while the draft kept showing the
      value the file did not hold.
    */
    it('commits a port that matches the server’s but not this machine’s', async () => {
      render(
        <ServerModeGroup
          enabled={false}
          bind={DEFAULT_BIND}
          devices={[]}
          remote={{ mode: 'local', host: 'studio.tail1234.ts.net', port: 7433 }}
          localRemote={{ mode: 'remote', host: 'mini.tail1234.ts.net', port: 9000 }}
          attachedServer={null}
          attachedServerName="mini"
          serving={false}
        />,
      );

      const port = screen.getByLabelText(/^port$/i);
      await userEvent.clear(port);
      await userEvent.type(port, '7433');
      await userEvent.tab();

      expect(setRemoteConfig).toHaveBeenCalledWith({ port: 7433 });
    });

    it('commits an address that matches the server’s but not this machine’s', async () => {
      render(
        <ServerModeGroup
          enabled={false}
          bind={DEFAULT_BIND}
          devices={[]}
          remote={{ mode: 'local', host: 'studio.tail1234.ts.net', port: 7433 }}
          localRemote={{ mode: 'remote', host: 'mini.tail1234.ts.net', port: 9000 }}
          attachedServer={null}
          attachedServerName="mini"
          serving={false}
        />,
      );

      const address = screen.getByLabelText(/server address/i);
      await userEvent.clear(address);
      await userEvent.type(address, 'studio.tail1234.ts.net');
      await userEvent.tab();

      expect(setRemoteConfig).toHaveBeenCalledWith({ host: 'studio.tail1234.ts.net' });
    });

    /* Unchanged against this machine's own block is still inert, as before. */
    it('writes nothing when the value already matches this machine’s block', async () => {
      render(
        <ServerModeGroup
          enabled={false}
          bind={DEFAULT_BIND}
          devices={[]}
          remote={{ mode: 'local', host: 'studio.tail1234.ts.net', port: 7433 }}
          localRemote={{ mode: 'remote', host: 'mini.tail1234.ts.net', port: 9000 }}
          attachedServer={null}
          attachedServerName="mini"
          serving={false}
        />,
      );

      const port = screen.getByLabelText(/^port$/i);
      await userEvent.clear(port);
      await userEvent.type(port, '9000');
      await userEvent.tab();

      expect(setRemoteConfig).not.toHaveBeenCalled();
    });

    /**
     * HIVE-153, and the case that fails on the code this story replaces.
     *
     * The pairing controls used to be hidden alongside the address fields,
     * for an unrelated reason: `remote:pair` and `remote:forget` were proxied,
     * so a Forget click on an attached client cleared the *server's*
     * credential rather than this machine's. Hiding the button was a UI
     * mitigation for an IPC defect, and it held only for as long as this file
     * stayed `remote:forget`'s single caller anywhere.
     *
     * Both channels are on `PROCESS_LOCAL` now, answered by whichever process
     * the user is sitting at, so the controls describe this machine in either
     * mode and there is nothing left to hide them from. What this asserts is
     * that end state; `remote-proxy.test.ts` owns the routing that earns it.
     */
    it('offers the pairing controls and Forget while attached', () => {
      render(
        <ServerModeGroup
          enabled={false}
          bind={DEFAULT_BIND}
          devices={[]}
          remote={SERVER_ANSWERED_REMOTE}
          localRemote={null}
          attachedServer={null}
          attachedServerName="mini"
          serving={false}
        />,
      );

      expect(screen.getByLabelText(/pairing token/i)).toBeInTheDocument();
      expect(screen.getByLabelText(/device id/i)).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /^forget$/i })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /pair device/i })).toBeInTheDocument();
    });

    /*
      The consequence stated rather than guarded against (HIVE-153). A server
      authenticates a client at the handshake and never again, so forgetting
      while attached leaves the current attachment live and costs the *next*
      dial. Refusing the verb would put back the unreachability HIVE-144
      settled for; detaching on the user's behalf would make Forget mean two
      things. So the pane says what it does.
    */
    it('says that Forget does not end a live attachment', () => {
      render(
        <ServerModeGroup
          enabled={false}
          bind={DEFAULT_BIND}
          devices={[]}
          remote={SERVER_ANSWERED_REMOTE}
          localRemote={null}
          attachedServer={null}
          attachedServerName="mini"
          serving={false}
        />,
      );

      expect(screen.getByText(/without ending a live attachment/i)).toBeInTheDocument();
    });

    /*
      The other side of the same seed, and the reason it is not simply
      `attached`: a boot attach that failed leaves *this machine's* file
      saying `'remote'` with no socket open, and that user needs the fields
      in order to retry.
    */
    it('still opens the panel for a configured-but-unattached window', () => {
      render(
        <ServerModeGroup
          enabled={false}
          bind={DEFAULT_BIND}
          devices={[]}
          remote={ATTACHED_REMOTE}
          localRemote={null}
          attachedServer={{ name: 'mini', host: 'mini.tail1234.ts.net' }}
          attachedServerName={null}
          serving={false}
        />,
      );

      expect(screen.getByRole('switch', { name: 'Attach to a server' })).toBeChecked();
      expect(screen.getByLabelText(/server address/i)).toBeInTheDocument();
      // The config-derived sentence, which is the right one here: it is about
      // intent, and only this machine's own file can express that.
      expect(screen.getByText(/configured to attach to/i)).toBeInTheDocument();
    });

    /**
     * Fix round 1, item 3 (IMPORTANT), the sharper edge: pre-fix, `Forget`
     * rendered only inside the `pairedAs`-gated branch, which is
     * session-local state. A pane freshly mounted — a remount of Settings, a
     * new session against an already-paired machine — had never seen a
     * pairing succeed in *this* render, so `Forget` was not in the document
     * at all: the only control that calls `remote:forget` was unreachable.
     * Written and run against the pre-fix code first — see the task report
     * for the verbatim failure.
     */
    it('offers Forget even when this session never saw a pairing succeed', async () => {
      render(
        <ServerModeGroup
          enabled={false}
          bind={DEFAULT_BIND}
          devices={[]}
          remote={DEFAULT_REMOTE}
          localRemote={null}
          attachedServer={null}
          attachedServerName={null}
          serving={false}
        />,
      );

      // Never touched the Pair form at all — this is what remounting the
      // pane after an earlier, real pairing looks like: no local memory of
      // it in this render whatsoever.
      await userEvent.click(screen.getByRole('switch', { name: 'Attach to a server' }));

      expect(screen.getByRole('button', { name: /^forget$/i })).toBeInTheDocument();
    });

    it('pairs, shows Paired, and Forget remains reachable throughout', async () => {
      vi.mocked(pairRemoteDevice).mockResolvedValue({ paired: true });

      render(
        <ServerModeGroup
          enabled={false}
          bind={DEFAULT_BIND}
          devices={[]}
          remote={DEFAULT_REMOTE}
          localRemote={null}
          attachedServer={null}
          attachedServerName={null}
          serving={false}
        />,
      );

      await userEvent.click(screen.getByRole('switch', { name: 'Attach to a server' }));

      // Forget is already there, before any pairing in this session.
      const forget = screen.getByRole('button', { name: /^forget$/i });

      await userEvent.type(screen.getByLabelText(/device id/i), 'd_ab12');
      await userEvent.type(screen.getByLabelText(/pairing token/i), 'K7QM-3XTV-9WHZ-2BNP');
      await userEvent.click(screen.getByRole('button', { name: /^pair device$/i }));

      expect(pairRemoteDevice).toHaveBeenCalledWith({
        deviceId: 'd_ab12',
        token: 'K7QM-3XTV-9WHZ-2BNP',
      });
      // No name — `RemotePairRequest` carries none.
      expect(await screen.findByText(/^paired$/i)).toBeInTheDocument();

      await userEvent.click(forget);

      expect(forgetRemoteDevice).toHaveBeenCalled();
      // Forget is still there afterwards — it was never gated on `paired`.
      expect(screen.getByRole('button', { name: /^forget$/i })).toBeInTheDocument();
      expect(screen.queryByText(/^paired$/i)).not.toBeInTheDocument();
    });

    it('shows the refusal reason when pairing fails', async () => {
      vi.mocked(pairRemoteDevice).mockResolvedValue({
        error: 'This system has no keyring available.',
      });

      render(
        <ServerModeGroup
          enabled={false}
          bind={DEFAULT_BIND}
          devices={[]}
          remote={DEFAULT_REMOTE}
          localRemote={null}
          attachedServer={null}
          attachedServerName={null}
          serving={false}
        />,
      );

      await userEvent.click(screen.getByRole('switch', { name: 'Attach to a server' }));
      await userEvent.type(screen.getByLabelText(/device id/i), 'd_ab12');
      await userEvent.type(screen.getByLabelText(/pairing token/i), 'K7QM-3XTV-9WHZ-2BNP');
      await userEvent.click(screen.getByRole('button', { name: /^pair device$/i }));

      expect(
        await screen.findByText(/no keyring available/i),
      ).toBeInTheDocument();
    });

    it('names the machine whose config is being edited while attached', () => {
      render(
        <ServerModeGroup
          enabled={false}
          bind={DEFAULT_BIND}
          devices={[]}
          remote={ATTACHED_REMOTE}
          localRemote={null}
          attachedServer={{ name: 'mini.tail1234.ts.net', host: 'mini.tail1234.ts.net' }}
          attachedServerName={null}
          serving={false}
        />,
      );

      expect(screen.getByText(/mini\.tail1234\.ts\.net/)).toBeInTheDocument();
    });

    it('says nothing about which machine’s config this is when not attached', () => {
      render(
        <ServerModeGroup
          enabled={false}
          bind={DEFAULT_BIND}
          devices={[]}
          remote={DEFAULT_REMOTE}
          localRemote={null}
          attachedServer={null}
          attachedServerName={null}
          serving={false}
        />,
      );

      expect(screen.queryByText(/config:get/i)).not.toBeInTheDocument();
    });
  });

  /**
   * The interlock, from the pane's side (HIVE-144 review, I3).
   *
   * `RemoteConfig` says an install is the server or the client and never a
   * hybrid; `switchIpcMode` refuses the combination, and these are what keep
   * the user from finding that out by clicking. Both directions, because the
   * two switches sit side by side and either one can be flipped first.
   */
  describe('the serve/attach interlock', () => {
    it('disables the attach switch on a serving machine, and says why', () => {
      render(
        <ServerModeGroup
          enabled
          bind={DEFAULT_BIND}
          devices={[]}
          remote={DEFAULT_REMOTE}
          localRemote={null}
          attachedServer={null}
          attachedServerName={null}
          serving
        />,
      );

      expect(screen.getByRole('switch', { name: 'Attach to a server' })).toBeDisabled();
      expect(screen.getByText(/turn serve this machine off and relaunch first/i)).toBeInTheDocument();
    });

    /**
     * The panel is seeded open by `remote.mode === 'remote'`, so a machine
     * that both serves and is configured to attach — the exact config this
     * interlock exists for — reaches the button underneath the switch.
     */
    it('disables the Attach button too, where the panel is already open', () => {
      render(
        <ServerModeGroup
          enabled
          bind={DEFAULT_BIND}
          devices={[]}
          remote={ATTACHED_REMOTE}
          localRemote={null}
          attachedServer={{ name: 'mini.tail1234.ts.net', host: 'mini.tail1234.ts.net' }}
          attachedServerName={null}
          serving
        />,
      );

      const attach = screen.getByRole('button', { name: /^attach$/i });
      expect(attach).toBeDisabled();
      expect(attach).toHaveAttribute('title', expect.stringContaining('server or the client'));
    });

    it('disables the serve switch on an attached window, and says why', () => {
      render(
        <ServerModeGroup
          enabled={false}
          bind={DEFAULT_BIND}
          devices={[]}
          remote={DEFAULT_REMOTE}
          localRemote={null}
          attachedServer={null}
          attachedServerName="mini.tail1234.ts.net"
          serving={false}
        />,
      );

      expect(screen.getByRole('switch', { name: 'Serve this machine' })).toBeDisabled();
      expect(screen.getByText(/this window is driving another machine/i)).toBeInTheDocument();
    });

    /**
     * `attached`, never `enabled`. While attached, `enabled` is read off the
     * **server's** snapshot and is `true` on every client of a real server —
     * keyed on it, the serve switch would disable itself on a machine that is
     * serving nothing, and the reason on screen would be a lie.
     */
    it('leaves both switches alone on an ordinary local window', () => {
      render(
        <ServerModeGroup
          enabled={false}
          bind={DEFAULT_BIND}
          devices={[]}
          remote={DEFAULT_REMOTE}
          localRemote={null}
          attachedServer={null}
          attachedServerName={null}
          serving={false}
        />,
      );

      expect(screen.getByRole('switch', { name: 'Serve this machine' })).not.toBeDisabled();
      expect(screen.getByRole('switch', { name: 'Attach to a server' })).not.toBeDisabled();
    });
  });

  /**
   * The store side of a switch (HIVE-144 review, I1).
   *
   * `applyAttachSnapshot` and `clearModeEntities` had no production caller —
   * the attach snapshot was built by the server on every accept and dropped by
   * the client, and nothing cleared entities when the window changed machines.
   * These drive the real click through the real store, so a `changed` that
   * stopped being applied fails here rather than only in a live app.
   */
  describe('the fleet across a mode switch', () => {
    const fleetIds = () => Object.keys(useHiveStore.getState().entities);

    beforeEach(() => {
      useHiveStore.getState().reset();
    });

    it('clears the departed fleet and seeds the server’s on a successful attach', async () => {
      useHiveStore.getState().hydrateSessions([
        { id: 'sess-01', project: 'departed', task: '', status: 'working', createdAt: 1 },
      ]);
      vi.mocked(setRemoteConfig).mockResolvedValue({
        switched: { ok: true },
        changed: {
          to: 'remote',
          snapshot: {
            'session:history': [
              { id: 'sess-09', project: 'attached', task: '', status: 'working', createdAt: 2 },
            ],
          },
        },
      });

      render(
        <ServerModeGroup
          enabled={false}
          bind={DEFAULT_BIND}
          devices={[]}
          remote={REMOTE_TARGET}
          localRemote={null}
          attachedServer={null}
          attachedServerName={null}
          serving={false}
        />,
      );

      await userEvent.click(screen.getByRole('switch', { name: 'Attach to a server' }));
      await userEvent.click(screen.getByRole('button', { name: /^attach$/i }));

      // The departed row is gone and the server's is in its place — not both,
      // which is what a seed with no clear in front of it would leave.
      expect(fleetIds()).toEqual(['sess-09']);
    });

    it('clears on a detach, where there is nothing to seed', async () => {
      useHiveStore.getState().hydrateSessions([
        { id: 'sess-01', project: 'the-server', task: '', status: 'working', createdAt: 1 },
      ]);
      vi.mocked(setRemoteConfig).mockResolvedValue({
        switched: { ok: true },
        changed: { to: 'local' },
      });

      render(
        <ServerModeGroup
          enabled={false}
          bind={DEFAULT_BIND}
          devices={[]}
          remote={ATTACHED_REMOTE}
          localRemote={null}
          attachedServer={{ name: 'mini.tail1234.ts.net', host: 'mini.tail1234.ts.net' }}
          attachedServerName="mini.tail1234.ts.net"
          serving={false}
        />,
      );

      await userEvent.click(screen.getByRole('switch', { name: 'Attach to a server' }));

      expect(fleetIds()).toEqual([]);
    });

    /**
     * A refused switch changes nothing, so it must not clear anything either
     * — `changed` is `null` on every refusal and the fleet on screen is still
     * the right one.
     */
    it('leaves the fleet alone when the switch was refused', async () => {
      useHiveStore.getState().hydrateSessions([
        { id: 'sess-01', project: 'nova-web', task: '', status: 'working', createdAt: 1 },
      ]);
      vi.mocked(setRemoteConfig).mockResolvedValue({
        switched: { ok: false, reason: 'connect-failed', message: 'ECONNREFUSED' },
        changed: null,
      });

      render(
        <ServerModeGroup
          enabled={false}
          bind={DEFAULT_BIND}
          devices={[]}
          remote={REMOTE_TARGET}
          localRemote={null}
          attachedServer={null}
          attachedServerName={null}
          serving={false}
        />,
      );

      await userEvent.click(screen.getByRole('switch', { name: 'Attach to a server' }));
      await userEvent.click(screen.getByRole('button', { name: /^attach$/i }));

      expect(fleetIds()).toEqual(['sess-01']);
    });
  });

  /**
   * What the pane says while the link is not working (HIVE-150).
   *
   * Before this, a dropped socket left the pane reading "Attached to mini.
   * Everything this window shows comes from that machine" while every call
   * behind it rejected. The status line is the honest signal, and the button is
   * the exit — `config:set-remote` is `PROCESS_LOCAL`, so it is the one control
   * here that still answers with the socket dead.
   */
  describe('a link that is not working', () => {
    const link = (over: Partial<RemoteLinkStatus> = {}): RemoteLinkStatus => ({
      state: 'attached',
      serverName: 'mini',
      attempt: 0,
      nextAttemptAt: null,
      reason: null,
      epoch: 0,
      ...over,
    });

    const renderAttached = (
      status: RemoteLinkStatus | null,
      localRemote: RemoteConfig | null = null,
    ) =>
      render(
        <ServerModeGroup
          enabled={false}
          bind={DEFAULT_BIND}
          devices={[]}
          remote={ATTACHED_REMOTE}
          localRemote={localRemote}
          attachedServer={null}
          attachedServerName="mini"
          serving={false}
          link={status}
        />,
      );

    it('names the machine, the attempt and the wait while reconnecting', async () => {
      renderAttached(
        link({ state: 'reconnecting', attempt: 4, nextAttemptAt: Date.now() + 8_000 }),
      );

      expect(screen.getByText(/Reconnecting to/)).toBeInTheDocument();
      /*
        The attempt and the countdown together, because the question someone
        watching this has is "is anything actually happening" — and a bare
        "reconnecting…" answers that no better than a blank pane does.
      */
      expect(screen.getByText(/Attempt 4/)).toBeInTheDocument();
      expect(screen.getByText(/next try in 8 seconds/)).toBeInTheDocument();
      // The fear this state produces is that the work is gone.
      expect(screen.getByText(/sessions are still running on that machine/)).toBeInTheDocument();
    });

    it('names the reason once it has given up', async () => {
      renderAttached(
        link({ state: 'disconnected', reason: 'That device was revoked.' }),
      );

      expect(screen.getByText(/Disconnected from/)).toBeInTheDocument();
      expect(screen.getByText(/That device was revoked\./)).toBeInTheDocument();
      /*
        And that waiting will not help, which is the difference between this
        state and the one above — the whole reason they are two states.
      */
      expect(screen.getByText(/will not fix this on its own/)).toBeInTheDocument();
    });

    it('offers the local exit in both, and it detaches', async () => {
      for (const state of ['reconnecting', 'disconnected'] as const) {
        vi.mocked(setRemoteConfig).mockClear();
        const { unmount } = renderAttached(link({ state }));
  
        await userEvent.click(screen.getByRole('button', { name: /work locally/i }));

        /*
          The same call the switch makes. It is worth a button of its own here
          because it is the only control on this pane that still works with the
          socket dead — everything else is proxied and would simply hang.
        */
        expect(setRemoteConfig).toHaveBeenCalledWith({ mode: 'local' });
        unmount();
      }
    });

    it('keeps the ordinary sentence while the link is healthy', async () => {
      renderAttached(link());

      expect(screen.getByText(/Everything this window shows comes from that machine/))
        .toBeInTheDocument();
      expect(screen.queryByText(/Reconnecting to/)).not.toBeInTheDocument();
      expect(screen.queryByRole('button', { name: /work locally/i })).not.toBeInTheDocument();
    });

    /*
      HIVE-150 asserted the opposite of this, and HIVE-149 is what changed the
      answer rather than merely the assertion. Worth recording, because the
      reasoning it retires was sound on the code it was written against.

      That case kept the address fields hidden in every remote state, because
      they read `remote.host`/`remote.port` — the *server's* block while
      attached, and during a reconnect a block nothing is refreshing. Stale
      values on screen at the moment the user most wants to trust them.

      They read `localRemote` now: this machine's own config, over
      `config:get-remote`, which is `PROCESS_LOCAL` and therefore answered by
      this process whatever the socket is doing. So the objection is not
      overridden, it is answered — a dead link cannot make this value stale,
      because the link was never what produced it. In the degraded states these
      two fields are the only thing on the pane that is still certainly true.

      Attach stays hidden in all three, which is the part HIVE-150 and HIVE-149
      agree on for the same reason: there is nothing to dial from a window that
      already holds a socket, live or reconnecting.
    */
    it('shows this machine’s own address in every remote state, and never Attach', async () => {
      for (const state of ['attached', 'reconnecting', 'disconnected'] as const) {
        const { unmount } = renderAttached(link({ state }), {
          mode: 'remote',
          host: 'mini.tail1234.ts.net',
          port: 7433,
        });

        expect(screen.getByLabelText(/server address/i)).toHaveValue('mini.tail1234.ts.net');
        expect(screen.getByText(/read from this machine/i)).toBeInTheDocument();
        expect(screen.queryByRole('button', { name: /^attach$/i })).not.toBeInTheDocument();
        unmount();
      }
    });
  });
});
