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
import type { RemoteLinkStatus } from '@shared/ipc-contract';
import { useApplyModeChange } from '@stores/hive-store';

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
/**
 * What the address fields mean while attached (HIVE-149).
 *
 * Two facts, because the rest of this pane is showing the *server's* config
 * while attached and nothing else on screen would tell the user that these two
 * fields are the exception: whose config they are, and when a change to them
 * applies. "The next time it attaches" rather than "immediately", because
 * `config:set-remote` writes the address without moving a live socket —
 * re-targeting still needs a detach, which is also why Attach stays hidden.
 */
const ATTACH_TARGET_HINT =
  "Where this window dials, read from this machine's own config — not the server's. A change applies the next time it attaches.";

/**
 * The interlock's two sentences (HIVE-144 review, I3).
 *
 * One rule, stated from whichever side the user is standing on. Both are
 * rendered as the disabled control's `title`, the same way
 * `REMOTE_DISABLED_REASON` carries `WINDOW_BOUND`'s refusals — a disabled
 * control that does not say why is the failure this branch keeps closing.
 *
 * "Relaunch" is in the serving one and not the attached one because the
 * asymmetry is real and already stated on this pane: a listening socket
 * cannot be moved, so turning server mode off takes effect at next launch,
 * while detaching is only a client hanging up and applies immediately.
 */
const NO_ATTACH_WHILE_SERVING =
  'This Hive is serving its own sessions. An install is the server or the client, never both — turn Serve this machine off and relaunch first.';
const NO_SERVE_WHILE_ATTACHED =
  'This window is driving another machine. An install is the server or the client, never both — detach first.';

/**
 * How long until the next reconnect attempt, in words (HIVE-150).
 *
 * Rounded up and floored at one second, so the line never reads "in 0 seconds"
 * for the whole tick before the dial actually happens, and never reads a
 * negative number for an attempt that is already in flight.
 *
 * Computed at render rather than ticked down. The status is pushed on every
 * transition, so this text is replaced by the next one within the interval it
 * describes; a second timer here would re-render the whole settings pane once a
 * second to animate a number nobody is watching.
 */
function nextTryIn(at: number): string {
  const seconds = Math.max(1, Math.ceil((at - Date.now()) / 1_000));
  return `next try in ${String(seconds)} second${seconds === 1 ? '' : 's'}`;
}

/**
 * The exit from a link that is not working (HIVE-150).
 *
 * It calls the same `handleDetach` the switch does, which is
 * `config:set-remote` — `PROCESS_LOCAL`, so it is answered by *this* process
 * and still works with the socket dead. That is the whole reason a button here
 * is worth anything: every other control on this pane is proxied and would
 * simply hang.
 */
function WorkLocallyButton({ onClick, busy }: { onClick: () => void; busy: boolean }) {
  return (
    <Button variant="secondary" size="sm" onClick={onClick} disabled={busy} className="self-start">
      {busy ? 'Switching…' : 'Work locally'}
    </Button>
  );
}

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
   * This machine's **own** `remote` block, read over `config:get-remote`, or
   * `null` before that read lands (HIVE-149).
   *
   * The counterpart to {@link ServerModeGroupProps.remote} above, and the two
   * disagree precisely where it matters: while attached, `remote` comes from
   * `config:get` and therefore describes the *server*, whose own `mode` reads
   * `local` because a server is not attached to anyone. This one is answered by
   * this process in either mode.
   *
   * Only the address and the port read it. The serve half and the device roster
   * deliberately keep reading the proxied snapshot, because while attached those
   * genuinely are the far end's to show — that is the pane's whole doctrine, and
   * this field is the one exception to it, for the two controls whose subject is
   * this window rather than the fleet.
   */
  localRemote: RemoteConfig | null;
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
  /**
   * Whether **this** process was launched to serve (HIVE-144 review, I3) —
   * `AppInfo.serving`, the third runtime-derived field on this pane.
   *
   * Deliberately not the `enabled` prop above, which is the config's
   * `server.enabled`, and which while attached is the *server's* file and
   * therefore reads `true` on a client attached to a real server. The
   * interlock this gates must never be keyed on that: it would disable the
   * detach control on precisely the window that needs it.
   *
   * What it gates: an install is the server or a client and never both
   * (`RemoteConfig`'s own doc comment). The two switches sat side by side
   * with nothing between them, and a serving machine that attached tore its
   * own listener down permanently — see `electron/main/server-mode.ts`.
   * `switchIpcMode` refuses the combination; this is what makes the refusal
   * visible on the control instead of after a click.
   */
  serving: boolean;
  /**
   * What the attachment is doing, when there is one (HIVE-150).
   *
   * {@link ServerModeGroupProps.attachedServerName} answers *whether* this
   * window is driving another machine; this answers whether that machine is
   * currently reachable. The two are deliberately separate props rather than
   * one: every other control on this pane branches on the first question, and
   * only this pane's status line asks the second.
   *
   * Optional, defaulting to none — a pane rendered for a window that has never
   * attached has no link to describe, which is also every local-mode test.
   */
  link?: RemoteLinkStatus | null;
}

export function ServerModeGroup({
  enabled,
  bind,
  devices,
  remote,
  localRemote,
  attachedServer,
  attachedServerName,
  serving,
  link = null,
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
    The store side of a mode switch (HIVE-144 review, I1). Held here rather
    than reached for inside the two handlers because a component may not call
    `getState()` — the named selector hook beside the store is the only way in.
  */
  const applyModeChange = useApplyModeChange();
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

  /*
    Which block the address fields describe (HIVE-149).

    `localRemote` whenever it has landed, and the proxied `remote` until then.
    Falling back rather than rendering empty fields is deliberate: in local mode
    the two are the same file read twice, so the fallback is exact; while
    attached it is briefly the server's, which is what this pane showed on its
    first render before this story too, because `attachedServerName` also
    arrives a tick late and `attached` is false until it does. The correction
    lands with the read, and the re-seed below applies it to the drafts.
  */
  const target = localRemote ?? remote;

  const [remoteHostDraft, setRemoteHostDraft] = useState(target.host);
  const [remoteHostInvalid, setRemoteHostInvalid] = useState(false);
  const [remotePortDraft, setRemotePortDraft] = useState(String(target.port));
  const [remotePortInvalid, setRemotePortInvalid] = useState(false);
  /** The last attach attempt's outcome, or `null` before one has been made. */
  const [switchResult, setSwitchResult] = useState<SwitchOutcome | null>(null);
  const [attaching, setAttaching] = useState(false);

  /*
    Follow-the-snapshot, the same reasoning `seenBind` states above: a Reload
    or Reset changes `remote` underneath this component, and a stale draft
    would otherwise show a value that no longer matches the file.

    Watches `target` rather than `remote` since HIVE-149, which gives it a
    second job: `localRemote` arrives asynchronously, so the first render of an
    attached window seeds from the proxied block and this is what replaces it
    with this machine's own once the read lands. Same mechanism, one more
    source.
  */
  const [seenTarget, setSeenTarget] = useState(target);
  const targetChanged = seenTarget.host !== target.host || seenTarget.port !== target.port;
  if (targetChanged) {
    setSeenTarget(target);
    setRemoteHostDraft(target.host);
    setRemoteHostInvalid(false);
    setRemotePortDraft(String(target.port));
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
    /*
      Write only, and now actually so (HIVE-144 review, I6).

      The claim here used to be that a same-mode commit is inert on the far
      side, "while `remote.mode` stays `'local'`" — false in the one state
      this panel is rendered for. Ruling 19 leaves this machine's `remote.mode`
      at `'remote'` after a failed boot attach so the next launch retries,
      which is exactly when someone is in these fields fixing the address; and
      `applySetRemote` read `request.mode ?? current.mode`, so a blur dialled.
      A payload naming no mode now switches nothing, in `applySetRemote`
      itself rather than by this call site being careful — see that function.

      The outcome is still discarded, and that is now honest: with no switch
      there is no `SwitchOutcome` worth rendering, only a config write, which
      arrives as the fresh snapshot this component's props follow.
    */
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
    void setRemoteConfig({ mode: 'remote', host, port }).then(({ switched, changed }) => {
      setAttaching(false);
      setSwitchResult(switched);
      /*
        The fleet on screen belongs to the machine this window just left, and
        the ids collide across machines (HIVE-144 review, I1) — see
        `applyModeChange`'s own doc comment. `changed` is `null` on every
        refusal, which is exactly right: a refused switch changed nothing.
      */
      if (changed) applyModeChange(changed);
      if (!switched.ok) {
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
    void setRemoteConfig({ mode: 'local' }).then(({ switched, changed }) => {
      setDetaching(false);
      setSwitchResult(switched);
      // The detach half of the same rule (HIVE-144 review, I1). Coming back to
      // this machine has to clear too, or the server's fleet lingers on a
      // window that is no longer showing that machine.
      if (changed) applyModeChange(changed);
      if (switched.ok) setAttachOpen(false);
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
        /*
          The interlock's own sentence replaces the ordinary one while it
          bites (HIVE-144 review, I3) — a disabled switch with its usual
          description beside it says nothing about why it will not move. This
          slot rather than a `title`: it is already on screen, and it is
          `aria-describedby` on the control itself.
        */
        description={attached ? NO_SERVE_WHILE_ATTACHED : SWITCH_DESCRIPTION}
        checked={open}
        /*
          `attached`, the runtime field — never `enabled`, which while attached
          is the server's own `server.enabled` and would disable this on every
          client of a real server for the wrong reason.
        */
        disabled={attached}
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
        // The other side of the same rule — see the serve switch above.
        description={serving ? NO_ATTACH_WHILE_SERVING : ATTACH_SWITCH_DESCRIPTION}
        checked={attachOpen}
        disabled={detaching || serving}
        onCheckedChange={(next) => {
          // Turning it off while attached detaches immediately — the one
          // direction `switchIpcMode` never refuses. `attachOpen` is left
          // alone here; `handleDetach` closes the panel itself, and only once
          // the write actually lands (see its own doc comment for why this
          // is not `setAttachOpen(next)` up front).
          //
          // **Either half, not one of them** (Ruling 29, and its own review).
          //
          // `attached` had to be added: keyed on the proxied snapshot alone,
          // `remote.mode` read `'local'` on every attached window — that is
          // the far machine's config, which knows nothing of this one's
          // socket — so the one click that could have detached fell through
          // to `setAttachOpen` and merely collapsed a panel.
          //
          // `remote.mode` had to stay: the two are not the same state, and
          // the case only the file knows about is a **configured but
          // unattached** window. Ruling 19 deliberately leaves this machine's
          // `remote.mode` at `'remote'` when a boot attach fails, precisely so
          // the next launch retries — so a user who wants it to stop retrying
          // has this switch and nothing else. Keyed on `attached` alone, their
          // click writes nothing, the panel collapses, and the next launch
          // dials again; the only way out is a text editor. Trading one trap
          // for another is not a fix, and the seed at `:396` already reads
          // both halves for the same reason.
          if (!next && (attached || remote.mode === 'remote')) {
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
          {attached && link?.state === 'reconnecting' ? (
            /*
              The link dropped and is being rebuilt (HIVE-150).

              It says which attempt and when the next one is, because the one
              question a person has while watching this is "is anything
              actually happening" — a spinner answers no better than a blank
              pane. And it says the sessions are still running, because the
              fear this state produces is that they are gone.
            */
            <div className="flex gap-2 rounded-md border border-amber/45 bg-amber/8 px-3 py-2.5">
              <WarningCircle size={13} className="mt-0.5 shrink-0 text-amber" />
              <div className="flex flex-col gap-2 text-[11.5px] text-subtle">
                <span>
                  Reconnecting to{' '}
                  <span className="font-medium text-ink">{attachedServerName}</span>.
                  The connection dropped. Attempt {link.attempt}
                  {link.nextAttemptAt === null ? '' : `, ${nextTryIn(link.nextAttemptAt)}`}.
                  Your sessions are still running on that machine.
                </span>
                <WorkLocallyButton onClick={handleDetach} busy={detaching} />
              </div>
            </div>
          ) : attached && link?.state === 'disconnected' ? (
            /*
              Given up, for a reason another dial would reproduce. Red rather
              than amber for the reason the header chip splits the two: the
              user's next move is different, and "stopped trying" is the thing
              they need to know to make it.
            */
            <div className="flex gap-2 rounded-md border border-red/45 bg-red/8 px-3 py-2.5">
              <WarningCircle size={13} className="mt-0.5 shrink-0 text-red" />
              <div className="flex flex-col gap-2 text-[11.5px] text-subtle">
                <span>
                  Disconnected from{' '}
                  <span className="font-medium text-ink">{attachedServerName}</span>.
                  {link.reason === null ? '' : ` ${link.reason}`} Reconnecting
                  will not fix this on its own.
                </span>
                <WorkLocallyButton onClick={handleDetach} busy={detaching} />
              </div>
            </div>
          ) : attached ? (
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
            **Shown in both modes since HIVE-149, and that is new.**

            These fields used to be hidden while attached, and hiding was the
            honest thing to do at the time: they read `remote.host`/`remote.port`,
            and while attached that block comes off the *server's* snapshot — on
            a real attached client, its defaults, an empty address and 7433. So
            the pane would have stated a target that is not this machine's and is
            not what a commit here would write either, since `config:set-remote`
            is `PROCESS_LOCAL` and writes locally (Ruling 28). Disabling them
            would have left those wrong values on screen with an explanation
            beside them, which is worse than saying nothing.

            What changed is that there is now something true to show:
            `config:get-remote` is the `PROCESS_LOCAL` read half of that writer,
            and `target` above is which block won — this machine's whenever the
            read has landed. Both halves of the old objection are answered at
            once, because the field now shows exactly what a commit would write.

            Committing while attached is allowed and lands locally, which is
            what `ATTACH_TARGET_HINT` tells the user. What is still refused is
            re-targeting a *live* socket, which is why Attach below keeps its
            own `attached` gate rather than rejoining this block.

            **The pairing fields no longer go with them (HIVE-153).** They used
            to, for a sharper reason than tidiness: `remote:pair` and
            `remote:forget` were not on `PROCESS_LOCAL`, so while attached they
            were proxied and a click on Forget cleared the *server's* stored
            credential rather than this machine's. Hiding the button was a UI
            mitigation for an IPC defect, and it held only while this file was
            `remote:forget`'s single caller anywhere. Both channels are now
            answered by this process in either mode, so the controls render
            unconditionally — which is what the hide was standing in for.
          */}
          {attached ? <p className="text-[11.5px] text-muted">{ATTACH_TARGET_HINT}</p> : null}

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

            **And unconditionally now means in either mode, too (HIVE-153).**
            This block used to sit inside the `attached ?` conditional above,
            hidden along with the address fields but for an unrelated reason —
            `remote:forget` was proxied, so the click landed on the server's
            credential. Both channels are `PROCESS_LOCAL` now, answered by this
            process whichever mode it is bound in, so the controls describe
            this machine in both and there is nothing left to hide them from.
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
              hint="Printed by `the-hive --pair <name>` on the server. Stored in this machine's keychain, never in config.json. Forget clears it here without ending a live attachment — the next dial is what needs a new one."
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

          {/*
            Disabled here too, not only on the switch above (HIVE-144 review,
            I3). The panel is seeded open by `remote.mode === 'remote'`, and a
            machine that both serves and is configured to attach is exactly the
            config this interlock exists for — so the button is reachable in
            the one state it must refuse.

            Its own `attached` gate rather than the block's (HIVE-153). Lifting
            the pairing controls out from between the address fields and this
            button is what split one conditional into two, and keeping this one
            preserves both the reading order and the fact that Attach is
            meaningless on a window already attached — there is nothing to dial.
            HIVE-149 retired the first of the two; this one outlived it, as that
            story's own note said it would.
          */}
          {attached ? null : (
          <Button
            variant="primary"
            size="sm"
            className="w-fit"
            disabled={attaching || serving}
            title={serving ? NO_ATTACH_WHILE_SERVING : undefined}
            onClick={handleAttach}
          >
            {attaching ? 'Attaching…' : 'Attach'}
          </Button>
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
