import { useState } from 'react';

import { Button } from '@components/ui/button';
import { Switch } from '@components/ui/switch';
import { TextField } from '@components/ui/text-field';
import { SettingsGroup } from '@features/settings/components/settings-group';
import { pairDevice, revokeDevice, setServerConfig } from '@lib/project-config';
import {
  DEFAULT_SERVER,
  isOrigin,
  isServerBindHost,
  type ServerBindConfig,
  type ServerDevice,
} from '@shared/config-contract';

/**
 * Turning server mode on, naming the bind, and pairing/revoking devices
 * (HIVE-142).
 *
 * Follows `ContainerAliasGroup` deliberately, field for field: a `Switch`
 * whose disclosure is local UI state seeded from the resolved config and kept
 * in step with it, `TextField`s that commit on blur or Enter, and "Takes
 * effect at next launch" as literal copy — a socket already listening cannot
 * be moved, exactly as the receiver's own bind cannot.
 *
 * ## The switch is config-derived, not runtime-derived
 *
 * `checked` reflects `enabled` — a real, persisted field, unlike the
 * receiver's bind switch, which has no such field and only ever infers
 * "widened" from the bind itself. The header's exposure chip is the opposite
 * kind of fact: it reads `AppInfo.serverBoundHost`, the *running* socket, so
 * it never claims safety while a socket opened before a restart is still
 * listening. This switch must not be "fixed" to read that value — a person
 * flipping it needs to see their own intent stick immediately, not wait for
 * a relaunch that has not happened yet.
 *
 * Both directions write directly (`setServerConfig({ enabled })`), the same
 * shape `SetServerRequest.enabled`'s own doc comment ties to
 * `SetSlackRequest.socketMode`: off is a value, not a lower level to fall
 * back to. Turning it on is safe to write immediately because the bind stays
 * whatever it already was — usually loopback — until a bind field below is
 * itself committed.
 *
 * ## Devices are listed inline, never behind a caret
 *
 * Revoking a stolen laptop is the urgent path on this pane. The roster and
 * its Revoke buttons render unconditionally, whether or not server mode is
 * currently on, because a device paired earlier can still hold a credential
 * worth destroying right now.
 *
 * ## The token is shown once
 *
 * `pairDevice` (`@lib/project-config`) hands back the plaintext exactly once,
 * as its resolved value — never written into a store, a log, or the config.
 * `justPaired` holds it in local state only until the device roster this
 * component was handed actually changes, which is the proof the pairing
 * round-tripped; nothing here persists it past that.
 */

const GRANT =
  "A paired device can open, watch and type into every session on this Mac.";

const SWITCH_DESCRIPTION = `${GRANT} Takes effect at next launch.`;

const BIND_HINT =
  'Where this Hive listens for a paired device — a hostname or an IPv4 address reachable from the other side, such as a Tailscale address.';
const BIND_INVALID = 'A hostname or an IPv4 address only — no scheme, port or path.';
const BIND_WILDCARD =
  '0.0.0.0 binds every interface on this machine. Name the address a device actually reaches instead — your Tailscale address is usually right.';
const PORT_HINT = `Leave empty for the default (${DEFAULT_SERVER.bind.port}).`;
const PORT_INVALID = 'A port from 0 to 65535, or empty for the default.';
const ORIGINS_HINT =
  'Comma separated, as in https://example.test. Empty refuses every request from a browser — most paired devices need none.';
const ORIGINS_INVALID = 'Each entry is a scheme and a host, as in https://example.test.';

/** One `ServerDevice`'s roster row. */
function DeviceRow({
  device,
  onRevoke,
}: {
  device: ServerDevice;
  onRevoke: (name: string) => void;
}) {
  return (
    <div className="flex items-center justify-between gap-2 py-1">
      <div className="flex min-w-0 flex-col">
        <span className="truncate text-[12.5px] text-ink">{device.name}</span>
        <span className="text-[11px] text-subtle">
          Paired {device.paired}
          {device.revoked ? ' · revoked' : ''}
        </span>
      </div>
      {device.revoked ? null : (
        <Button
          variant="danger"
          size="sm"
          onClick={() => onRevoke(device.name)}
        >
          Revoke
        </Button>
      )}
    </div>
  );
}

interface ServerModeGroupProps {
  /** The resolved `enabled` from the snapshot. */
  enabled: boolean;
  /** The resolved bind from the snapshot. Never partial — the block is defaulted. */
  bind: ServerBindConfig;
  /** The resolved device roster from the snapshot. */
  devices: readonly ServerDevice[];
}

/** A stable signature for {@link ServerModeGroupProps.devices} — see `justPaired`'s doc comment. */
function deviceSignature(devices: readonly ServerDevice[]): string {
  return devices.map((device) => `${device.id}:${device.revoked}`).join(',');
}

export function ServerModeGroup({ enabled, bind, devices }: ServerModeGroupProps) {
  /*
    Local disclosure state, seeded from `enabled` and kept in step with it —
    the same "follow the snapshot" idiom `ContainerAliasGroup` uses for its
    own switch, applied to a real field rather than a derived one.
  */
  const [open, setOpen] = useState(enabled);
  const [seenEnabled, setSeenEnabled] = useState(enabled);
  if (seenEnabled !== enabled) {
    setSeenEnabled(enabled);
    setOpen(enabled);
  }

  const [hostDraft, setHostDraft] = useState(bind.host);
  const [hostInvalid, setHostInvalid] = useState<'invalid' | 'wildcard' | null>(null);
  const [portDraft, setPortDraft] = useState(bind.port === 0 ? '' : String(bind.port));
  const [portInvalid, setPortInvalid] = useState(false);
  const [originsDraft, setOriginsDraft] = useState(bind.allowedOrigins.join(', '));
  const [originsInvalid, setOriginsInvalid] = useState(false);

  /*
    Same follow-the-snapshot reasoning `ContainerAliasGroup` states for its
    own bind fields: Reload and Reset change `bind` underneath this
    component, and a stale draft would write the pre-reset value straight
    back into the file the user just reset.
  */
  const [seenBind, setSeenBind] = useState(bind);
  const bindChanged =
    seenBind.host !== bind.host ||
    seenBind.port !== bind.port ||
    seenBind.allowedOrigins.length !== bind.allowedOrigins.length ||
    seenBind.allowedOrigins.some((origin, index) => origin !== bind.allowedOrigins[index]);
  if (bindChanged) {
    setSeenBind(bind);
    setHostDraft(bind.host);
    setHostInvalid(null);
    setPortDraft(bind.port === 0 ? '' : String(bind.port));
    setPortInvalid(false);
    setOriginsDraft(bind.allowedOrigins.join(', '));
    setOriginsInvalid(false);
  }

  const commitBindHost = () => {
    const next = hostDraft.trim();
    if (next === '0.0.0.0') {
      setHostInvalid('wildcard');
      return;
    }
    if (next === '' || !isServerBindHost(next)) {
      setHostInvalid('invalid');
      return;
    }
    setHostInvalid(null);
    setHostDraft(next);
    if (next === bind.host) return;
    void setServerConfig({ bind: { host: next } });
  };

  const commitPort = () => {
    const raw = portDraft.trim();
    if (raw !== '' && !/^\d+$/.test(raw)) {
      setPortInvalid(true);
      return;
    }
    const next = raw === '' ? DEFAULT_SERVER.bind.port : Number(raw);
    if (!Number.isInteger(next) || next < 0 || next > 65_535) {
      setPortInvalid(true);
      return;
    }
    setPortInvalid(false);
    setPortDraft(next === 0 ? '' : String(next));
    if (next === bind.port) return;
    void setServerConfig({ bind: { port: next } });
  };

  const commitOrigins = () => {
    const entries = originsDraft
      .split(',')
      .map((entry) => entry.trim())
      .filter((entry) => entry !== '');
    if (!entries.every((entry) => isOrigin(entry))) {
      setOriginsInvalid(true);
      return;
    }
    setOriginsInvalid(false);
    setOriginsDraft(entries.join(', '));
    const unchanged =
      entries.length === bind.allowedOrigins.length &&
      entries.every((entry, index) => entry === bind.allowedOrigins[index]);
    if (unchanged) return;
    void setServerConfig({ bind: { allowedOrigins: entries } });
  };

  const [pairName, setPairName] = useState('');
  const [pairError, setPairError] = useState<string | null>(null);
  const [pairing, setPairing] = useState(false);
  const [justPaired, setJustPaired] = useState<{ name: string; token: string } | null>(
    null,
  );

  /*
    Clears the shown token once the roster this component was handed actually
    changes — the proof pairing (or a revoke) round-tripped, not merely that
    something else caused a re-render. A signature rather than reference
    equality, so an unrelated snapshot update elsewhere in the app — which
    hands this component a structurally identical but freshly-allocated array
    — does not erase a token the user has not copied yet.
  */
  const [seenDevices, setSeenDevices] = useState(() => deviceSignature(devices));
  const currentDevices = deviceSignature(devices);
  if (currentDevices !== seenDevices) {
    setSeenDevices(currentDevices);
    setJustPaired(null);
  }

  const handlePair = () => {
    const name = pairName.trim();
    if (name === '') return;
    setPairError(null);
    setPairing(true);
    void pairDevice(name).then((outcome) => {
      setPairing(false);
      if ('token' in outcome) {
        setJustPaired({ name, token: outcome.token });
        setPairName('');
      } else {
        setPairError(outcome.error);
      }
    });
  };

  return (
    <SettingsGroup
      title="Server mode"
      description="Reach this Hive's sessions from another machine you own."
    >
      <Switch
        label="Server mode"
        description={SWITCH_DESCRIPTION}
        checked={open}
        onCheckedChange={(next) => {
          setOpen(next);
          void setServerConfig({ enabled: next });
        }}
      />

      {open ? (
        <>
          <TextField
            label="Bind address"
            value={hostDraft}
            onChange={(value) => {
              setHostDraft(value);
              if (hostInvalid) setHostInvalid(null);
            }}
            onCommit={commitBindHost}
            hint={
              hostInvalid === 'wildcard'
                ? BIND_WILDCARD
                : hostInvalid === 'invalid'
                  ? BIND_INVALID
                  : BIND_HINT
            }
          />

          <TextField
            label="Port"
            value={portDraft}
            onChange={(value) => {
              setPortDraft(value);
              if (portInvalid) setPortInvalid(false);
            }}
            onCommit={commitPort}
            placeholder={String(DEFAULT_SERVER.bind.port)}
            hint={portInvalid ? PORT_INVALID : PORT_HINT}
          />

          <TextField
            label="Allowed origins"
            value={originsDraft}
            onChange={(value) => {
              setOriginsDraft(value);
              if (originsInvalid) setOriginsInvalid(false);
            }}
            onCommit={commitOrigins}
            placeholder="None"
            hint={originsInvalid ? ORIGINS_INVALID : ORIGINS_HINT}
          />
        </>
      ) : null}

      <div className="flex flex-col gap-2 pt-1">
        <h4 className="text-[11px] font-semibold uppercase tracking-wide text-subtle">
          Paired devices
        </h4>

        {devices.length === 0 ? (
          <p className="text-[11.5px] text-subtle">No devices are paired.</p>
        ) : (
          <div className="flex flex-col divide-y divide-border-soft">
            {devices.map((device) => (
              <DeviceRow key={device.id} device={device} onRevoke={revokeDevice} />
            ))}
          </div>
        )}

        <div className="flex items-end gap-2">
          <TextField
            label="Device name"
            value={pairName}
            onChange={setPairName}
            placeholder="e.g. Yunid's MacBook"
            className="flex-1"
          />
          <Button
            variant="secondary"
            size="sm"
            disabled={pairing || pairName.trim() === ''}
            onClick={handlePair}
          >
            Pair
          </Button>
        </div>

        {pairError ? (
          <p className="text-[11.5px] text-red">{pairError}</p>
        ) : null}

        {justPaired ? (
          <div className="flex flex-col gap-1 rounded-[6px] border border-border bg-panel-2 p-2.5">
            <p className="text-[11.5px] text-ink">
              Token for &quot;{justPaired.name}&quot; — copy it now. It will not be
              shown again.
            </p>
            <code className="break-all font-mono text-[12px] text-ink">
              {justPaired.token}
            </code>
          </div>
        ) : null}
      </div>
    </SettingsGroup>
  );
}
