import { useState } from 'react';

import { Button } from '@components/ui/button';
import { Switch } from '@components/ui/switch';
import { TextField } from '@components/ui/text-field';
import { SettingsGroup } from '@features/settings/components/settings-group';
import { pairDevice, revokeDevice, setServerConfig } from '@lib/project-config';
import {
  DEFAULT_SERVER,
  WILDCARD_BIND,
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
 * `justPaired` holds it in local state until something in *this component*
 * explicitly clears it: the "Done" button beside it, or the next pairing
 * attempt starting. It is deliberately **not** cleared by watching `devices`
 * change (review finding, "the comment describes a mechanism the code does
 * not have"): `pairDevice` re-reads and installs the fresh snapshot itself,
 * before its promise resolves back to this component's `.then` — so the
 * render that would prove *this* pairing's roster change already happened
 * by the time `justPaired` is set, and a clear gated on that prop diffing
 * either fires late (on some later, unrelated roster change) or, if the
 * render ordering ever differed, could wipe the token in the same commit
 * that first showed it. Clearing explicitly makes the guarantee independent
 * of any of that.
 */

const GRANT =
  "A paired device can open, watch and type into every session on this Mac.";

const SWITCH_DESCRIPTION = `${GRANT} Takes effect at next launch.`;

const BIND_HINT =
  'Where this Hive listens for a paired device — a hostname or an IPv4 address reachable from the other side, such as a Tailscale address.';
const BIND_INVALID = 'A hostname or an IPv4 address only — no scheme, port or path.';
const BIND_WILDCARD = `${WILDCARD_BIND} binds every interface on this machine. Name the address a device actually reaches instead — your Tailscale address is usually right.`;
const PORT_HINT = `Leave empty for the default (${DEFAULT_SERVER.bind.port}). Fixed, not OS-assigned — a paired device has to be told this number ahead of time.`;
const PORT_INVALID = 'A port from 1 to 65535, or empty for the default. 0 asks the OS for a free port, which a paired device could never be told in advance.';
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
  // Unlike the receiver's own bind group, `bind.port` here is never 0 — the
  // config reader and `config:set-server` both refuse it (HIVE-142 review,
  // I3) — so, unlike that sibling field, there is no "0 means empty" case to
  // special-case on the way in.
  const [portDraft, setPortDraft] = useState(String(bind.port));
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
    setPortDraft(String(bind.port));
    setPortInvalid(false);
    setOriginsDraft(bind.allowedOrigins.join(', '));
    setOriginsInvalid(false);
  }

  const commitBindHost = () => {
    const next = hostDraft.trim();
    if (next === WILDCARD_BIND) {
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
    // 0 is a legal port number in general but not here — see PORT_INVALID
    // and `assertServerBindPort` (`electron/shared/guards.ts`) for why.
    if (!Number.isInteger(next) || next < 1 || next > 65_535) {
      setPortInvalid(true);
      return;
    }
    setPortInvalid(false);
    setPortDraft(String(next));
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
  const [justPaired, setJustPaired] = useState<
    { name: string; token: string; deviceId: string } | null
  >(null);

  const handlePair = () => {
    const name = pairName.trim();
    if (name === '') return;
    setPairError(null);
    // A new attempt starting clears whatever the previous one left behind —
    // a stale token under a fresh error, or a stale token under a fresh
    // token — rather than leaving either to linger under the other.
    setJustPaired(null);
    setPairing(true);
    void pairDevice(name).then((outcome) => {
      setPairing(false);
      if ('token' in outcome) {
        setJustPaired({ name, token: outcome.token, deviceId: outcome.deviceId });
        setPairName('');
      } else {
        setPairError(outcome.error);
      }
    });
  };

  const [revokeError, setRevokeError] = useState<{ name: string; message: string } | null>(
    null,
  );

  /**
   * The most urgent path on this pane must not fail silently (review
   * finding, Important): `revokeDevice` answers `{ ok } | { error }`, and a
   * refusal is shown right beside the roster it failed to change, rather
   * than only reaching `console.error`.
   */
  const handleRevoke = (name: string) => {
    setRevokeError(null);
    void revokeDevice(name).then((outcome) => {
      if (!outcome.ok) setRevokeError({ name, message: outcome.error });
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
              <DeviceRow key={device.id} device={device} onRevoke={handleRevoke} />
            ))}
          </div>
        )}

        {revokeError ? (
          <p className="text-[11.5px] text-red">
            Could not revoke &quot;{revokeError.name}&quot;: {revokeError.message}
          </p>
        ) : null}

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
            {/*
              The attach handshake needs the id alongside the token (HIVE-142
              review, I5) — before this, it was readable only by opening
              config.json, so a person holding the token had no way to
              actually use it.
            */}
            <p className="text-[11px] text-subtle">Device id: {justPaired.deviceId}</p>
            <Button
              variant="ghost"
              size="sm"
              className="w-fit"
              onClick={() => setJustPaired(null)}
            >
              Done
            </Button>
          </div>
        ) : null}
      </div>
    </SettingsGroup>
  );
}
