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
   * The machine the stored config *names* as the attach target (HIVE-144) —
   * `ConfigSnapshot.attachedServer`.
   *
   * **Only meaningful while this window is not attached (Ruling 29.)** It is
   * config-derived, and while attached `config:get` is answered by the far
   * end, so it describes the *server's* file rather than this machine's: on a
   * real attached client it reads `null`, because the server is not itself
   * attached to anything. That is not a bug in the field, it is the field
   * answering honestly about the only config it can see. What it is good for
   * is the not-attached case, where it is genuinely this machine's own file
   * and can say "configured to attach to X, which may or may not be open
   * right now" — a sentence {@link ServerModeGroupProps.attachedServerName}
   * cannot make, because a runtime field knows nothing about intent.
   */
  attachedServer: { name: string; host: string } | null;
  /**
   * The machine a socket is **actually open to** right now, or `null`
   * (HIVE-144, Ruling 29) — `AppInfo.attachedServerName`, the runtime half.
   *
   * This is the field the attach half keys its whole attached-state on, and
   * the reason is a defect two real apps found: everything here used to key on
   * `remote.mode`, which while attached is read off the **server's** snapshot
   * and says `'local'`. So the switch rendered unchecked on an attached
   * window, the panel stayed collapsed, and `handleDetach`'s guard
   * (`remote.mode === 'remote'`) could not be reached by any click — a client
   * could attach and had no way back short of hand-editing `config.json`,
   * which `config:reveal` being `WINDOW_BOUND` also denied it.
   *
   * `AppInfo.attachedServerName` has none of that problem: it is
   * `PROCESS_LOCAL` (Ruling 24), so it is answered by *this* process in both
   * modes, and it is exactly the question "is a socket open, and to what" —
   * which is what the header chip has always used it for. The config-derived
   * source stays right where it is right, which is the not-attached case; see
   * {@link ServerModeGroupProps.attachedServer}.
   */
  attachedServerName: string | null;
}

export function ServerModeGroup({
  enabled,
  bind,
  devices,
  remote,
  attachedServer,
  attachedServerName,
}: ServerModeGroupProps) {
  /**
   * Whether a socket is open right now — the one question the attach half
   * branches on (Ruling 29).
   *
   * Named once rather than repeated as `attachedServerName !== null` at four
   * sites, because the four have to agree: a switch that renders checked while
   * a detach handler thinks there is nothing to detach is the shape of the
   * defect this ruling closes.
   */
  const attached = attachedServerName !== null;
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

    **The seed is `attached || remote.mode === 'remote'`, and both halves are
    load-bearing (Ruling 29).** `attached` is the runtime truth and is the half
    that was missing: while a socket is open, `remote.mode` is read off the
    *server's* config and says `'local'`, so a config-only seed collapsed the
    panel on exactly the window that needed the detach inside it.
    `remote.mode` still earns its place for the opposite state — a boot attach
    that failed, or a laptop off its tailnet, leaves this machine's own file
    saying `'remote'` with no socket open, and that user needs the address
    fields visible to retry. Neither half alone covers both.
  */
  const [attachOpen, setAttachOpen] = useState(attached || remote.mode === 'remote');
  /*
    Re-seeded on a change to *either* source, for the reason the seed reads
    both. `attachedServerName` arrives asynchronously (`useAttachedServer`
    reads `app:info` after the snapshot lands), so on an attached window the
    first render genuinely has `null` here and the correction arrives a tick
    later — which is precisely what this re-seed is for, and why it cannot be
    left as a `remote.mode`-only edge.
  */
  const [seenMode, setSeenMode] = useState(remote.mode);
  const [seenAttached, setSeenAttached] = useState(attached);
  if (seenMode !== remote.mode || seenAttached !== attached) {
    setSeenMode(remote.mode);
    setSeenAttached(attached);
    setAttachOpen(attached || remote.mode === 'remote');
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

  /**
   * The write path a "turn the switch off" click takes while attached (Fix
   * round 1, item 1). `attachOpen` does **not** flip to `false` until the
   * write actually succeeds — fix-round review, Important: the previous
   * version set it optimistically in `onCheckedChange` before this promise
   * settled, which unmounted the very panel a `connect-failed` outcome needed
   * to render into, and left the switch reading unchecked over a detach that
   * had not happened. `remote → local` is still never *refused* by
   * `switchIpcMode` itself, but `setRemoteConfig` can still answer
   * `connect-failed` for a reason that has nothing to do with that guarantee
   * — a broken bridge, a rejected `invoke` — and that failure has to be
   * visible and the switch has to keep telling the truth about it.
   */
  const [detaching, setDetaching] = useState(false);

  const handleDetach = () => {
    setSwitchResult(null);
    setDetaching(true);
    void setRemoteConfig({ mode: 'local' }).then((outcome) => {
      setDetaching(false);
      setSwitchResult(outcome);
      if (outcome.ok) setAttachOpen(false);
    });
  };

  const [remotePairDeviceId, setRemotePairDeviceId] = useState('');
  const [remotePairToken, setRemotePairToken] = useState('');
  const [remotePairing, setRemotePairing] = useState(false);
  const [remotePairError, setRemotePairError] = useState<string | null>(null);
  /**
   * Whether *this session* watched a pairing succeed (HIVE-144, fix round 1,
   * item 3). There is no name here any more — `RemotePairRequest` carries
   * none, `server:pair` on the far end already minted one when the device was
   * named there, and this machine's own credential store
   * (`electron/remote-client/token-store.ts`) keeps only `deviceId` and
   * `token`. A local-only "Device label" field used to paper over that by
   * asking the person to retype a name nothing downstream ever read — the
   * fix-round review's own words: "the only field on this pane that pretended
   * to store something and did not." Dropped rather than documented.
   *
   * This flag is cosmetic acknowledgement only, and **does not gate Forget**
   * — see `handleForget` below for why that distinction is the actual fix for
   * the review's Important-3.
   */
  const [paired, setPaired] = useState(false);

  const handleRemotePair = () => {
    const deviceId = remotePairDeviceId.trim();
    const token = remotePairToken.trim();
    if (deviceId === '' || token === '') return;
    setRemotePairError(null);
    setRemotePairing(true);
    void pairRemoteDevice({ deviceId, token }).then((outcome) => {
      setRemotePairing(false);
      if ('paired' in outcome) {
        setPaired(true);
        setRemotePairDeviceId('');
        setRemotePairToken('');
      } else {
        setRemotePairError(outcome.error);
      }
    });
  };

  /**
   * Fix round 1, item 3 (IMPORTANT). `Forget` used to render only inside the
   * `paired`-gated branch — session-local state, gone the instant this pane
   * is remounted (closing and reopening Settings, a config reload). A
   * credential paired in an earlier session left the *only* control that
   * calls `remote:forget` unreachable, with no way back short of hand-editing
   * `safeStorage`. `remote:forget` is idempotent and takes no argument (there
   * is exactly one credential on this machine to forget, never a name to
   * disambiguate by — see `HiveBridge.remote.forget`'s own doc comment), so
   * there is no reason it needs a known-paired state to call safely. It is
   * rendered unconditionally below, beside the pairing fields rather than
   * behind them, which is what makes it reachable regardless of what this
   * session happens to remember.
   */
  const handleForget = () => {
    void forgetRemoteDevice().then(() => setPaired(false));
  };

  return (
    <SettingsGroup
      title="Server mode"
      description="Reach this Hive's sessions from another machine you own."
    >
      <Switch
        label="Serve this machine"
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
        disabled={detaching}
        onCheckedChange={(next) => {
          // Turning it off while attached detaches immediately — the one
          // direction `switchIpcMode` never refuses. `attachOpen` is left
          // alone here; `handleDetach` closes the panel itself, and only once
          // the write actually lands (see its own doc comment for why this
          // is not `setAttachOpen(next)` up front).
          //
          // `attached`, not `remote.mode === 'remote'` (Ruling 29). This guard
          // is the whole exit from remote mode, and keyed on the proxied
          // snapshot it read `'local'` on every attached window — so the one
          // click that could have detached fell through to `setAttachOpen`
          // and merely collapsed a panel.
          if (!next && attached) {
            handleDetach();
            return;
          }
          // Turning it on only reveals the fields below; see `handleAttach`'s
          // own doc comment for why the switch itself never dials.
          setAttachOpen(next);
        }}
      />

      {attachOpen ? (
        <div className="flex flex-col gap-3 rounded-[7px] border border-border-soft bg-panel-2 p-3">
          {/*
            Fix round 1, item 2 (IMPORTANT). Naming the machine from
            `attachedServer` is correct and stays — that field genuinely is
            this control's own config-derived readout, per its own doc
            comment above. What must not appear beside it is any claim about
            what is happening *right now* on a live socket: `attachedServer`
            is computed purely from `remote.mode === 'remote'` on disk, and
            Ruling 19 explicitly leaves that value saying `'remote'` after a
            failed re-dial rebinds this window local — so a sentence here
            asserting `config:get` "is answered by the far end" can be false
            at the exact moment it renders. That claim belongs to
            `AppInfo.attachedServerName`, the runtime-derived sibling this
            control deliberately does not read (see `ServerModeGroupProps`).
          */}
          {attached ? (
            /*
              Ruling 29. The runtime field, so this sentence names the machine
              a socket is genuinely open to — `RemoteClient.serverName()`, the
              hostname the far end gave itself in the handshake, not an address
              some config happened to mention. The config-derived line below is
              the not-attached case and says something different on purpose.
            */
            <p className="text-[11.5px] text-subtle">
              Attached to{' '}
              <span className="font-medium text-ink">{attachedServerName}</span>.
              Everything this window shows comes from that machine. Turn the
              switch off to come back to this one.
            </p>
          ) : attachedServer ? (
            <p className="text-[11.5px] text-subtle">
              Configured to attach to{' '}
              <span className="font-medium text-ink">{attachedServer.name}</span>.
              This is what <code>config.json</code> says right now — not
              necessarily whether a socket to it is actually open this instant.
            </p>
          ) : null}

          {/*
            **Hidden while attached, not disabled (Ruling 29.)**

            These fields read `remote.host`/`remote.port`, and while attached
            that block comes off the *server's* snapshot — on a real attached
            client, its defaults: an empty address and 7433. Rendering them at
            all is the pane stating a target that is not this machine's and
            that is not what a commit here would write, since `config:set-remote`
            is `PROCESS_LOCAL` and writes locally (Ruling 28). Disabling them
            would leave those wrong values on screen with an explanation
            beside them; hiding them says the true thing, which is that
            re-targeting is not available from here.

            It is a real fidelity gap and it is the smaller one: you cannot
            re-target without detaching first anyway, so nothing is lost but
            the ability to *read* the stored address while attached. Restoring
            that needs a `PROCESS_LOCAL` read verb for this machine's own
            `remote` block — the follow-up ticket, deliberately not this fix
            round, because a new channel moves the binding count three tasks
            pin.

            The pairing fields go with them, for a sharper reason than
            tidiness: `remote:pair` and `remote:forget` are **not** on
            `PROCESS_LOCAL`, so while attached they are proxied — a click on
            Forget here would clear the *server's* stored credential, not this
            machine's. That is the same family as the defect Ruling 28 closed
            and it wants the same remedy; until it gets one, the honest thing
            is not to offer the button. Noted in the follow-up ticket.
          */}
          {attached ? (
            <p className="text-[11.5px] text-subtle">
              The address and pairing fields are hidden while attached — they
              would describe the server&rsquo;s config, not this
              machine&rsquo;s. Detach to change where this window attaches.
            </p>
          ) : (
          <>
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
              // `plaintext-refused` no longer forks this hint (Fix round 1,
              // item 5) — it gets its own bordered banner below, at the same
              // weight `live-sessions` renders at, rather than hiding inside
              // the ordinary field hint every ordinary validation failure
              // here uses.
              hint={remoteHostInvalid ? ATTACH_HOST_INVALID : ATTACH_HOST_HINT}
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

          {/*
            Fix round 1, item 3 (IMPORTANT). The pairing fields and Forget
            render side by side, unconditionally — never as an either/or
            swap gated on session-local state. That is both what fixes
            Forget's reachability (see `handleForget`'s own doc comment) and
            what the mockup actually shows: "Paired as" and the token field
            together, not one replacing the other.
          */}
          {paired ? (
            <div className="flex items-center gap-2 rounded-[6px] border border-border bg-panel px-2.5 py-2 text-[11.5px]">
              <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-brand" />
              <span>Paired</span>
            </div>
          ) : null}

          <div className="flex flex-col gap-2">
            <TextField
              label="Device id"
              value={remotePairDeviceId}
              onChange={setRemotePairDeviceId}
            />
            <TextField
              label="Pairing token"
              value={remotePairToken}
              onChange={setRemotePairToken}
              hint="Printed by `the-hive --pair <name>` on the server. Stored in this machine's keychain, never in config.json."
            />
            {remotePairError ? (
              <p className="text-[11.5px] text-red">{remotePairError}</p>
            ) : null}
            <div className="flex items-center gap-2">
              <Button
                variant="secondary"
                size="sm"
                className="w-fit"
                disabled={
                  remotePairing ||
                  remotePairDeviceId.trim() === '' ||
                  remotePairToken.trim() === ''
                }
                onClick={handleRemotePair}
              >
                {remotePairing ? 'Pairing…' : 'Pair device'}
              </Button>
              <Button variant="ghost" size="sm" onClick={handleForget}>
                Forget
              </Button>
            </div>
          </div>

          <Button
            variant="primary"
            size="sm"
            className="w-fit"
            disabled={attaching}
            onClick={handleAttach}
          >
            {attaching ? 'Attaching…' : 'Attach'}
          </Button>
          </>
          )}

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

          {/*
            Fix round 1, item 5 (Minor, M2). `plaintext-refused` used to land
            only as a hint-text swap beneath the address field, still showing
            a client-side-valid address — the weakest-rendered of the four
            arms, on the exact mistake (a public address) this whole fence
            exists to catch. It now gets the same red bordered treatment
            `live-sessions` does, not merely the ordinary field hint every
            other validation failure in this file uses.
          */}
          {switchResult && !switchResult.ok && switchResult.reason === 'plaintext-refused' ? (
            <div className="flex items-start gap-2 rounded-[6px] border border-red bg-red/8 px-3 py-2.5">
              <WarningCircle size={14} className="mt-px shrink-0 text-red" />
              <p className="text-[11.5px] text-ink">{ATTACH_HOST_INVALID}</p>
            </div>
          ) : null}

          {/*
            Fix round 1, item 1: "attach" and "detach" share one `SwitchOutcome`
            arm (`connect-failed` — see `outcomeFor` in `router.ts`), so the
            copy has to tell them apart itself. No new state needed to know
            which one this was: a refused switch changes nothing (Ruling 19),
            so a socket is still open exactly when the failure came from
            `handleDetach`.

            **`attached`, not `remote.mode` (Ruling 29.)** The original read
            `remote.mode === 'remote'`, which is true of that sentence only
            while the snapshot is this machine's own — and while attached it
            is the server's and says `'local'`, so a failed *detach* announced
            itself as "Could not attach". Same source, same defect, one line.
          */}
          {switchResult && !switchResult.ok && switchResult.reason === 'connect-failed' ? (
            <p className="text-[11.5px] text-red">
              {attached ? 'Could not detach' : 'Could not attach'}:{' '}
              {switchResult.message}
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
