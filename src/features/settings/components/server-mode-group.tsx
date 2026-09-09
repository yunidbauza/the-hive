import { WarningCircle } from '@phosphor-icons/react';
import { useState } from 'react';

import { Button } from '@components/ui/button';
import { Switch } from '@components/ui/switch';
import { TextField } from '@components/ui/text-field';
import { SettingsGroup } from '@features/settings/components/settings-group';
import {
  forgetRemoteDevice,
  pairDevice,
  pairRemoteDevice,
  revokeDevice,
  setRemoteConfig,
  setServerConfig,
} from '@lib/project-config';
import {
  DEFAULT_REMOTE,
  DEFAULT_SERVER,
  WILDCARD_BIND,
  isOrigin,
  isRemoteTarget,
  isServerBindHost,
  type RemoteConfig,
  type ServerBindConfig,
  type ServerDevice,
  type SwitchOutcome,
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

/**
 * The attach half (HIVE-144) — the opposite direction from everything above.
 * Serving turns this machine into the one being driven; attaching turns it
 * into the one doing the driving, from another machine's sessions.
 *
 * "Applies immediately" rather than "takes effect at next launch"
 * (`SWITCH_DESCRIPTION` above): a listening socket cannot be moved without a
 * relaunch, but attaching is only ever a client dialling out, so there is no
 * socket here to relocate. Stating both asymmetrically, in the same group, is
 * deliberate — see this component's own doc comment for why one group and not
 * two.
 */
const ATTACH_GRANT = "Drive another machine's sessions from this one.";
const ATTACH_SWITCH_DESCRIPTION = `${ATTACH_GRANT} Applies immediately.`;
const ATTACH_HOST_HINT =
  'A loopback address, or a Tailscale address on this tailnet — a MagicDNS name or a 100.64.0.0/10 address.';
/**
 * Shared by two refusals with the identical remedy (matching
 * `isRemoteTarget`'s own "one class, two messages" reasoning): a shape this
 * client can reject on sight, and `plaintext-refused` — the server's own
 * refusal for a `.ts.net` name that resolved to something that is not, which
 * this predicate cannot see without a DNS lookup this renderer never makes.
 */
const ATTACH_HOST_INVALID =
  'Must be a loopback or tailnet address. A plaintext socket to anything else is refused.';
const ATTACH_PORT_HINT = `The port the server is listening on (default ${DEFAULT_REMOTE.port}).`;
const ATTACH_PORT_INVALID = 'A port from 1 to 65535.';

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
  /**
   * The resolved client-attach config from the snapshot (HIVE-144). Never
   * partial — {@link RemoteConfig} is always fully defaulted, exactly as
   * `bind` above is.
   */
  remote: RemoteConfig;
  /**
   * The machine whose config file this window is editing, while attached
   * (HIVE-144) — `ConfigSnapshot.attachedServer`, **not**
   * `AppInfo.attachedServerName`. That field is this control's own readout:
   * while attached, `config:get` is answered by the far end, which is what
   * this pane needs to say. The header's chip answers a different question —
   * whether a socket is actually open right now — from
   * `AppInfo.attachedServerName` instead; see that field's own doc comment,
   * and `ConfigSnapshot.attachedServer`'s, for the full config-versus-runtime
   * split. `null` in `'local'` mode.
   */
  attachedServer: { name: string; host: string } | null;
}

export function ServerModeGroup({
  enabled,
  bind,
  devices,
  remote,
  attachedServer,
}: ServerModeGroupProps) {
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

  /*
    ## The attach half (HIVE-144)

    `attachOpen` is disclosure state seeded from `remote.mode`, the same
    "seed from a persisted field, then re-seed on an external change" idiom
    `open`/`seenEnabled` use above — but it is **not** wired back to
    `setRemoteConfig` the way that switch is. Flipping this one on only
    reveals the fields: attaching needs an address, and a switch that dialled
    out on every accidental click, using whatever `remote.host` last happened
    to be, would be a live connection attempt hiding behind a toggle. Ruling
    27 puts that responsibility on the Attach button instead, which is the
    only control that ever asks to switch to `'remote'`.

    Flipping it off, when currently attached, is the one direction that *is*
    safe to fire immediately: `remote → local` is never refused (this
    component's own copy says so, and `switchIpcMode`'s doc comment states
    why — the far end keeps its sessions regardless), so there is nothing a
    blind click here could strand.
  */
  const [attachOpen, setAttachOpen] = useState(remote.mode === 'remote');
  const [seenMode, setSeenMode] = useState(remote.mode);
  if (seenMode !== remote.mode) {
    setSeenMode(remote.mode);
    setAttachOpen(remote.mode === 'remote');
  }

  const [remoteHostDraft, setRemoteHostDraft] = useState(remote.host);
  const [remoteHostInvalid, setRemoteHostInvalid] = useState(false);
  const [remotePortDraft, setRemotePortDraft] = useState(String(remote.port));
  const [remotePortInvalid, setRemotePortInvalid] = useState(false);
  /** The last attach attempt's outcome, or `null` before one has been made. */
  const [switchResult, setSwitchResult] = useState<SwitchOutcome | null>(null);
  const [attaching, setAttaching] = useState(false);

  /*
    Follow-the-snapshot, the same reasoning `seenBind` states above: a Reload
    or Reset changes `remote` underneath this component, and a stale draft
    would otherwise show a value that no longer matches the file.
  */
  const [seenRemote, setSeenRemote] = useState(remote);
  const remoteChanged = seenRemote.host !== remote.host || seenRemote.port !== remote.port;
  if (remoteChanged) {
    setSeenRemote(remote);
    setRemoteHostDraft(remote.host);
    setRemoteHostInvalid(false);
    setRemotePortDraft(String(remote.port));
    setRemotePortInvalid(false);
  }

  /**
   * Whether `value` is worth sending to `config:set-remote` at all — a shape
   * check only, the same boundary {@link isRemoteTarget} draws. It cannot see
   * a `.ts.net` name that resolves off-tailnet (that needs the DNS lookup
   * `connectRemote` does on the real attach attempt, which is what
   * `plaintext-refused` from {@link switchResult} reports instead), but it
   * does stop the address field from ever writing something that is
   * obviously not loopback or tailnet — a bare hostname, an IPv4 literal
   * outside both ranges, anything with a scheme or a port baked in.
   */
  const commitRemoteHost = () => {
    const next = remoteHostDraft.trim();
    if (next === '' || !isRemoteTarget(next)) {
      setRemoteHostInvalid(true);
      return;
    }
    setRemoteHostInvalid(false);
    setRemoteHostDraft(next);
    if (next === remote.host) return;
    // Same-mode commits are inert on the far side (`switchIpcMode`'s own
    // "already local" guard) — this only ever writes the address, never
    // dials, while `remote.mode` stays `'local'`.
    void setRemoteConfig({ host: next });
  };

  const commitRemotePort = () => {
    const raw = remotePortDraft.trim();
    if (raw !== '' && !/^\d+$/.test(raw)) {
      setRemotePortInvalid(true);
      return;
    }
    const next = raw === '' ? DEFAULT_REMOTE.port : Number(raw);
    if (!Number.isInteger(next) || next < 1 || next > 65_535) {
      setRemotePortInvalid(true);
      return;
    }
    setRemotePortInvalid(false);
    setRemotePortDraft(String(next));
    if (next === remote.port) return;
    void setRemoteConfig({ port: next });
  };

  /**
   * The one control that ever asks `config:set-remote` to switch to
   * `'remote'` (Ruling 27 — there is no separate "Test connection", this
   * button is the test).
   *
   * Re-validates the drafts one more time before sending, rather than
   * trusting the fields' own `onCommit`: a click straight from the port field
   * to this button fires this handler with whatever the fields last held,
   * commit or not, and a bad shape must never reach the wire.
   *
   * **Ruling 19, made concrete.** `config:set-remote` writes nothing at all
   * when the switch is refused — not `mode`, not `host`, not `port` from
   * this same call (`electron/main/ipc/index.ts`'s handler returns
   * `getConfig()` untouched on any `!switched.ok`). So a refusal here resets
   * both drafts back to the *prop* values — which, because nothing was
   * written, are still exactly what `config.json` holds — rather than
   * leaving the fields showing the address that was just tried and refused.
   * Leaving the optimistic draft in place is the defect this guards: a user
   * would read their own rejected input as the saved one.
   */
  const handleAttach = () => {
    const host = remoteHostDraft.trim();
    if (host === '' || !isRemoteTarget(host)) {
      setRemoteHostInvalid(true);
      return;
    }
    const rawPort = remotePortDraft.trim();
    if (!/^\d+$/.test(rawPort)) {
      setRemotePortInvalid(true);
      return;
    }
    const port = Number(rawPort);
    if (!Number.isInteger(port) || port < 1 || port > 65_535) {
      setRemotePortInvalid(true);
      return;
    }

    setRemoteHostInvalid(false);
    setRemotePortInvalid(false);
    setSwitchResult(null);
    setAttaching(true);
    void setRemoteConfig({ mode: 'remote', host, port }).then((outcome) => {
      setAttaching(false);
      setSwitchResult(outcome);
      if (!outcome.ok) {
        setRemoteHostDraft(remote.host);
        setRemotePortDraft(String(remote.port));
      }
    });
  };

  const handleDetach = () => {
    setSwitchResult(null);
    void setRemoteConfig({ mode: 'local' }).then(setSwitchResult);
  };

  const [remotePairName, setRemotePairName] = useState('');
  const [remotePairDeviceId, setRemotePairDeviceId] = useState('');
  const [remotePairToken, setRemotePairToken] = useState('');
  const [remotePairing, setRemotePairing] = useState(false);
  const [remotePairError, setRemotePairError] = useState<string | null>(null);
  /**
   * The name typed alongside the id and token, held only in this component's
   * own state (HIVE-144). There is nowhere else it could live: `RemotePairRequest`
   * carries no name — `server:pair` on the far end already minted one when the
   * device was named there, and this machine's own credential store
   * (`electron/remote-client/token-store.ts`) keeps only `deviceId` and
   * `token`, deliberately, because that pair is all the socket handshake
   * needs. So this label does not survive a reload of this pane; it survives
   * exactly as long as the pairing does within this session, which is enough
   * to answer "did that just work" and to name the Forget button's target.
   */
  const [pairedAs, setPairedAs] = useState<string | null>(null);

  const handleRemotePair = () => {
    const name = remotePairName.trim();
    const deviceId = remotePairDeviceId.trim();
    const token = remotePairToken.trim();
    if (name === '' || deviceId === '' || token === '') return;
    setRemotePairError(null);
    setRemotePairing(true);
    void pairRemoteDevice({ deviceId, token }).then((outcome) => {
      setRemotePairing(false);
      if ('paired' in outcome) {
        setPairedAs(name);
        setRemotePairName('');
        setRemotePairDeviceId('');
        setRemotePairToken('');
      } else {
        setRemotePairError(outcome.error);
      }
    });
  };

  const handleForget = () => {
    void forgetRemoteDevice().then(() => setPairedAs(null));
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

      <Switch
        label="Attach to a server"
        description={ATTACH_SWITCH_DESCRIPTION}
        checked={attachOpen}
        onCheckedChange={(next) => {
          setAttachOpen(next);
          // Turning it off while attached detaches immediately — the one
          // direction `switchIpcMode` never refuses. Turning it on only
          // reveals the fields below; see `handleAttach`'s own doc comment
          // for why the switch itself never dials.
          if (!next && remote.mode === 'remote') handleDetach();
        }}
      />

      {attachOpen ? (
        <div className="flex flex-col gap-3 rounded-[7px] border border-border-soft bg-panel-2 p-3">
          {attachedServer ? (
            <p className="text-[11.5px] text-subtle">
              Attached to{' '}
              <span className="font-medium text-ink">{attachedServer.name}</span>.
              Settings here edit <em>its</em> config file — <code>config:get</code>{' '}
              is answered by the far end while attached, not by this machine.
            </p>
          ) : null}

          <div className="grid grid-cols-[1fr_96px] gap-2">
            <TextField
              label="Server address"
              value={remoteHostDraft}
              onChange={(value) => {
                setRemoteHostDraft(value);
                if (remoteHostInvalid) setRemoteHostInvalid(false);
                if (switchResult) setSwitchResult(null);
              }}
              onCommit={commitRemoteHost}
              hint={
                remoteHostInvalid ||
                (switchResult !== null &&
                  !switchResult.ok &&
                  switchResult.reason === 'plaintext-refused')
                  ? ATTACH_HOST_INVALID
                  : ATTACH_HOST_HINT
              }
            />

            <TextField
              label="Port"
              value={remotePortDraft}
              onChange={(value) => {
                setRemotePortDraft(value);
                if (remotePortInvalid) setRemotePortInvalid(false);
                if (switchResult) setSwitchResult(null);
              }}
              onCommit={commitRemotePort}
              placeholder={String(DEFAULT_REMOTE.port)}
              hint={remotePortInvalid ? ATTACH_PORT_INVALID : ATTACH_PORT_HINT}
            />
          </div>

          {pairedAs ? (
            <div className="flex items-center gap-2 rounded-[6px] border border-border bg-panel px-2.5 py-2 text-[11.5px]">
              <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-brand" />
              <span>
                Paired as <span className="font-medium text-ink">{pairedAs}</span>
              </span>
              <Button
                variant="ghost"
                size="sm"
                className="ml-auto"
                onClick={handleForget}
              >
                Forget
              </Button>
            </div>
          ) : (
            <div className="flex flex-col gap-2">
              <div className="grid grid-cols-2 gap-2">
                <TextField
                  label="Device label"
                  value={remotePairName}
                  onChange={setRemotePairName}
                  placeholder="e.g. laptop"
                />
                <TextField
                  label="Device id"
                  value={remotePairDeviceId}
                  onChange={setRemotePairDeviceId}
                />
              </div>
              <TextField
                label="Pairing token"
                value={remotePairToken}
                onChange={setRemotePairToken}
                hint="Printed by `the-hive --pair <name>` on the server. Stored in this machine's keychain, never in config.json."
              />
              {remotePairError ? (
                <p className="text-[11.5px] text-red">{remotePairError}</p>
              ) : null}
              <Button
                variant="secondary"
                size="sm"
                className="w-fit"
                disabled={
                  remotePairing ||
                  remotePairName.trim() === '' ||
                  remotePairDeviceId.trim() === '' ||
                  remotePairToken.trim() === ''
                }
                onClick={handleRemotePair}
              >
                {remotePairing ? 'Pairing…' : 'Pair device'}
              </Button>
            </div>
          )}

          <Button
            variant="primary"
            size="sm"
            className="w-fit"
            disabled={attaching}
            onClick={handleAttach}
          >
            {attaching ? 'Attaching…' : 'Attach'}
          </Button>

          {switchResult && !switchResult.ok && switchResult.reason === 'live-sessions' ? (
            <div className="flex items-start gap-2 rounded-[6px] border border-red bg-red/8 px-3 py-2.5">
              <WarningCircle size={14} className="mt-px shrink-0 text-red" />
              <div className="flex flex-col gap-1 text-[11.5px]">
                <p className="text-ink">Can&rsquo;t attach while sessions are running here.</p>
                <p className="text-subtle">
                  Attaching would hide terminals still running in this app. Close
                  them first.
                </p>
                <ul className="flex flex-col gap-0.5 pl-4 text-subtle">
                  {switchResult.sessions.map((name) => (
                    <li key={name}>
                      <code className="font-mono text-[11px] text-ink">{name}</code>
                    </li>
                  ))}
                </ul>
              </div>
            </div>
          ) : null}

          {switchResult && !switchResult.ok && switchResult.reason === 'connect-failed' ? (
            <p className="text-[11.5px] text-red">
              Could not attach: {switchResult.message}
            </p>
          ) : null}
        </div>
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
