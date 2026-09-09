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
    render(<ServerModeGroup enabled={false} bind={DEFAULT_BIND} devices={[]} remote={DEFAULT_REMOTE}
      attachedServer={null}
      attachedServerName={null}
      serving={false}
    />);

    expect(screen.getByRole('switch', { name: 'Serve this machine' })).not.toBeChecked();
    expect(screen.queryByLabelText(/bind address/i)).not.toBeInTheDocument();
  });

  it('says plainly what a paired device can do', () => {
    render(<ServerModeGroup enabled={false} bind={DEFAULT_BIND} devices={[]} remote={DEFAULT_REMOTE}
      attachedServer={null}
      attachedServerName={null}
      serving={false}
    />);

    expect(
      screen.getByText(/a paired device can open, watch and type into every session on this mac/i),
    ).toBeInTheDocument();
  });

  it('says the change takes effect at next launch', () => {
    render(<ServerModeGroup enabled={false} bind={DEFAULT_BIND} devices={[]} remote={DEFAULT_REMOTE}
      attachedServer={null}
      attachedServerName={null}
      serving={false}
    />);

    expect(screen.getByText(/takes effect at next launch/i)).toBeInTheDocument();
  });

  it('reveals the bind fields when turned on, and does not write them until committed', async () => {
    render(<ServerModeGroup enabled={false} bind={DEFAULT_BIND} devices={[]} remote={DEFAULT_REMOTE}
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
    render(<ServerModeGroup enabled bind={DEFAULT_BIND} devices={[]} remote={DEFAULT_REMOTE}
      attachedServer={null}
      attachedServerName={null}
      serving={false}
    />);

    await userEvent.click(screen.getByRole('switch', { name: 'Serve this machine' }));

    expect(setServerConfig).toHaveBeenCalledWith({ enabled: false });
  });

  it('shows the address once server mode is on', () => {
    render(<ServerModeGroup enabled bind={WIDE_BIND} devices={[]} remote={DEFAULT_REMOTE}
      attachedServer={null}
      attachedServerName={null}
      serving={false}
    />);

    expect(screen.getByRole('switch', { name: 'Serve this machine' })).toBeChecked();
    expect(screen.getByLabelText(/bind address/i)).toHaveValue('100.64.1.2');
  });

  describe('the bind fields', () => {
    it('commits a valid address on blur', async () => {
      render(<ServerModeGroup enabled bind={DEFAULT_BIND} devices={[]} remote={DEFAULT_REMOTE}
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
      render(<ServerModeGroup enabled bind={DEFAULT_BIND} devices={[]} remote={DEFAULT_REMOTE}
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
      render(<ServerModeGroup enabled bind={DEFAULT_BIND} devices={[]} remote={DEFAULT_REMOTE}
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
      render(<ServerModeGroup enabled bind={DEFAULT_BIND} devices={[]} remote={DEFAULT_REMOTE}
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
      render(<ServerModeGroup enabled bind={DEFAULT_BIND} devices={[]} remote={DEFAULT_REMOTE}
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
      render(<ServerModeGroup enabled bind={DEFAULT_BIND} devices={[]} remote={DEFAULT_REMOTE}
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
      render(<ServerModeGroup enabled bind={DEFAULT_BIND} devices={[]} remote={DEFAULT_REMOTE}
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
  });

  describe('the device roster', () => {
    it('says nothing is paired on an empty roster', () => {
      render(<ServerModeGroup enabled={false} bind={DEFAULT_BIND} devices={[]} remote={DEFAULT_REMOTE}
      attachedServer={null}
      attachedServerName={null}
      serving={false}
    />);

      expect(screen.getByText(/no devices are paired/i)).toBeInTheDocument();
    });

    it('lists a paired device with its date', () => {
      render(
        <ServerModeGroup enabled={false} bind={DEFAULT_BIND} devices={[ACTIVE_DEVICE]} remote={DEFAULT_REMOTE}
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
        <ServerModeGroup enabled={false} bind={DEFAULT_BIND} devices={[REVOKED_DEVICE]} remote={DEFAULT_REMOTE}
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
        <ServerModeGroup enabled={false} bind={DEFAULT_BIND} devices={[ACTIVE_DEVICE]} remote={DEFAULT_REMOTE}
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
        <ServerModeGroup enabled={false} bind={DEFAULT_BIND} devices={[ACTIVE_DEVICE]} remote={DEFAULT_REMOTE}
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
        <ServerModeGroup enabled={false} bind={DEFAULT_BIND} devices={[ACTIVE_DEVICE]} remote={DEFAULT_REMOTE}
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
        <ServerModeGroup enabled={false} bind={DEFAULT_BIND} devices={[]} remote={DEFAULT_REMOTE}
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
      rerender(<ServerModeGroup enabled={false} bind={DEFAULT_BIND} devices={[]} remote={DEFAULT_REMOTE}
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
        <ServerModeGroup enabled={false} bind={DEFAULT_BIND} devices={[paired]} remote={DEFAULT_REMOTE}
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

      render(<ServerModeGroup enabled={false} bind={DEFAULT_BIND} devices={[]} remote={DEFAULT_REMOTE}
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

      render(<ServerModeGroup enabled={false} bind={DEFAULT_BIND} devices={[]} remote={DEFAULT_REMOTE}
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
      render(<ServerModeGroup enabled={false} bind={DEFAULT_BIND} devices={[]} remote={DEFAULT_REMOTE}
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
        <ServerModeGroup enabled={false} bind={DEFAULT_BIND} devices={[]} remote={DEFAULT_REMOTE}
      attachedServer={null}
      attachedServerName={null}
      serving={false}
    />,
      );
      expect(screen.getByRole('switch', { name: 'Serve this machine' })).not.toBeChecked();

      rerender(<ServerModeGroup enabled bind={DEFAULT_BIND} devices={[]} remote={DEFAULT_REMOTE}
      attachedServer={null}
      attachedServerName={null}
      serving={false}
    />);

      expect(screen.getByRole('switch', { name: 'Serve this machine' })).toBeChecked();
    });

    it('does not write a stale bind draft back after a reset', () => {
      const { rerender } = render(
        <ServerModeGroup enabled bind={WIDE_BIND} devices={[]} remote={DEFAULT_REMOTE}
      attachedServer={null}
      attachedServerName={null}
      serving={false}
    />,
      );

      rerender(<ServerModeGroup enabled bind={DEFAULT_BIND} devices={[]} remote={DEFAULT_REMOTE}
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
          attachedServer={null}
          attachedServerName={null}
          serving={false}
        />,
      );

      await userEvent.click(screen.getByRole('switch', { name: 'Attach to a server' }));

      expect(setRemoteConfig).toHaveBeenCalledWith({ mode: 'local' });
    });

    /*
      The address, the port and the pairing controls describe `remote.host`
      and `remote.port` — the *server's*, while attached. Hidden rather than
      disabled: disabling leaves the wrong values on screen with an
      explanation beside them, and `config:set-remote` writes locally
      (Ruling 28), so a commit would not even write what the field showed.
      Forget is hidden for a sharper reason still — `remote:forget` is not on
      `PROCESS_LOCAL`, so while attached it would clear the *server's*
      credential.
    */
    it('hides the address, port and pairing controls while attached', () => {
      render(
        <ServerModeGroup
          enabled={false}
          bind={DEFAULT_BIND}
          devices={[]}
          remote={SERVER_ANSWERED_REMOTE}
          attachedServer={null}
          attachedServerName="mini"
          serving={false}
        />,
      );

      expect(screen.queryByLabelText(/server address/i)).not.toBeInTheDocument();
      expect(screen.queryByLabelText(/^port$/i)).not.toBeInTheDocument();
      expect(screen.queryByLabelText(/pairing token/i)).not.toBeInTheDocument();
      expect(screen.queryByRole('button', { name: /^forget$/i })).not.toBeInTheDocument();
      expect(screen.queryByRole('button', { name: /^attach$/i })).not.toBeInTheDocument();
      // And it says why, rather than silently offering less.
      expect(screen.getByText(/hidden while attached/i)).toBeInTheDocument();
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
});
