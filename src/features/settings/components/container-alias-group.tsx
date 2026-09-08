import { WarningCircle } from '@phosphor-icons/react';
import { useState } from 'react';

import { Switch } from '@components/ui/switch';
import { TextField } from '@components/ui/text-field';
import { SettingsGroup } from '@features/settings/components/settings-group';
import { setReceiverConfig } from '@lib/project-config';
import {
  DEFAULT_BIND,
  DEFAULT_RECEIVER,
  isHostAlias,
  isLoopbackHost,
  isOrigin,
  type ReceiverBindConfig,
} from '@shared/config-contract';

/**
 * How a containerised session addresses this app (HIVE-131), and where the
 * receiver itself listens (HIVE-134).
 *
 * A container cannot reach `127.0.0.1` — inside one that is the container's own
 * loopback. Every mainstream runtime proxies the connection from the host side,
 * so the socket is already reachable and only the *name* has to change; this
 * field is that name.
 *
 * Placed in the Advanced pane's top half, beside `Config file`, because
 * everything from `About` onward answers questions rather than setting
 * anything — an editable field down there would be the only one of its kind.
 *
 * Committed on blur or Enter, like every other settings field
 * (`text-field.tsx:24`) — these write to a file, so a commit per keystroke would
 * be a whole-file atomic write per character.
 */

const HINT =
  'The name a container resolves to reach the host. Docker Desktop, OrbStack and Rancher use host.docker.internal; podman uses host.containers.internal.';

const INVALID =
  'A hostname only — no scheme, port, path or credentials. Try host.docker.internal.';

const BIND_HINT =
  'Prefer the bridge address your runtime names over 0.0.0.0. Binding every interface is a wider surface than the problem needs, and a container reaching this machine by its real LAN or bridge address is still refused unless that address is also set as the alias.';
const BIND_INVALID = 'A hostname or an IPv4 address only — no scheme, port or path.';
const PORT_HINT = 'Leave empty for any free port, which is the default.';
const PORT_INVALID = 'A port from 0 to 65535, or empty for any free port.';
const ORIGINS_HINT =
  'Comma separated, as in http://localhost:5173. Empty refuses every request from a browser.';
const ORIGINS_INVALID = 'Each entry is a scheme and a host, as in http://localhost:5173.';
const EXPOSED =
  'Anything that can reach this address may attempt to talk to the receiver. A per-session token is still required.';

interface ContainerAliasGroupProps {
  /** The resolved alias from the snapshot. Never empty — the block is defaulted. */
  hostAlias: string;
  /**
   * The resolved bind from the snapshot. Never partial — the block is
   * defaulted.
   *
   * Required, deliberately. This component renders a security-relevant
   * switch — whether the receiver accepts connections off loopback — and a
   * default here would fail in the wrong direction: a caller that forgot to
   * pass it would render the switch **off**, i.e. "not exposed", even if the
   * resolved config says otherwise. Making the prop required turns that
   * mistake into a compile error instead of a silently wrong security
   * display.
   */
  bind: ReceiverBindConfig;
}

export function ContainerAliasGroup({ hostAlias, bind }: ContainerAliasGroupProps) {
  const [draft, setDraft] = useState(hostAlias);
  const [invalid, setInvalid] = useState(false);

  /**
   * Follow the snapshot when it changes underneath us.
   *
   * This pane is never remounted — `AdvancedSection`'s `!snapshot` early return
   * only fires before the first load — so without this the field keeps whatever
   * it was first given. **Reload** and **Reset** both change the alias in the
   * store, and a stale draft is not merely cosmetic: focusing and blurring the
   * field would write the pre-reset value straight back into the file the user
   * just reset.
   *
   * Adjusting state during render rather than in an effect is React's own
   * recommendation for this: the re-render happens before the browser paints, so
   * the stale value is never shown.
   */
  const [seen, setSeen] = useState(hostAlias);
  if (seen !== hostAlias) {
    setSeen(hostAlias);
    setDraft(hostAlias);
    setInvalid(false);
  }

  /**
   * An emptied field restores the default rather than committing `""`.
   *
   * Unlike the Jira fields, there is no "unset" state to fall back to: the
   * substitution always needs a name, and `""` would produce `http://:63999`.
   *
   * A value the guard would refuse is **caught here instead of being sent**.
   * `mutate` swallows an IPC rejection into `console.error`
   * (`project-config.ts:117-119`), so a refused write is otherwise completely
   * silent — the field would go on showing a value that was never saved. The
   * draft is deliberately left alone in that case, so the user can correct what
   * they typed rather than watch it disappear.
   */
  const commit = () => {
    const next =
      draft.trim() === '' ? DEFAULT_RECEIVER.hostAlias : draft.trim();

    if (!isHostAlias(next)) {
      setInvalid(true);
      return;
    }

    setInvalid(false);
    setDraft(next);
    if (next === hostAlias) return;
    /*
      `seen` is deliberately NOT advanced here. It tracks the prop, and the prop
      is what the file actually holds — moving it optimistically would make the
      field revert to the old value for the render between this commit and the
      snapshot arriving, then jump forward again once it did.
    */
    void setReceiverConfig({ hostAlias: next });
  };

  /*
    Whether the resolved bind is off-loopback at all — the one definition of
    "exposed" (`isLoopbackHost`, HIVE-134), reused rather than re-derived so the
    header chip and this pane never disagree about what counts as widened.
  */
  const exposed = !isLoopbackHost(bind.host);

  /*
    The switch is local UI state seeded from the config, not a stored boolean —
    there is deliberately no `bind.enabled` field anywhere in this story.

    Turning it ON only *reveals* the fields. It writes NOTHING, because the
    address is the user's to choose: committing a bind they never typed would
    expose the socket on a single click, with no undo before the next launch
    (the bind is read once, at listen time, and cannot be moved once a session
    is relying on it). So flipping the switch changes only what is shown, and
    a value is written only once the user actually commits one of the three
    fields below.

    Turning it OFF writes loopback immediately (`{ bind: { host: '127.0.0.1' } }`),
    because that direction is always safe — retreating to loopback never needs a
    second confirming step the way widening does.

    The re-open lives inside the `bindChanged` block below, alongside the
    three draft fields it resets — the same "follow the snapshot" idea as
    `seen` above, applied to visibility rather than to a draft: if Reload or
    Reset (or another session) leaves the resolved config genuinely widened,
    the fields must be showing regardless of what this control last did
    locally — there is no such thing as a hidden exposed bind. It never forces
    the switch closed, symmetrically: a user who has opened the fields to type
    an address should not have them yanked shut out from under them just
    because the file, at this instant, still reads loopback.

    It is gated on `bindChanged` — the resolved `bind` prop having actually
    moved since it was last seen — and deliberately **not** on a bare
    `if (exposed && !open) setOpen(true)` recomputed fresh every render, which
    is what this used to be (HIVE-134 review, finding 2). That version
    reopened the switch on the very next render after `onCheckedChange` closed
    it locally: `setOpen(false)` re-renders before the `setReceiverConfig`
    write it triggers has round-tripped back through the snapshot, so `bind`
    (and therefore `exposed`) still read the old, widened config on that next
    render — and the bare check flipped `open` straight back to `true`. Worse,
    on a write that never lands at all (a read-only config file, `EPERM`) the
    prop never changes, so that bare check held the switch "on" forever with
    only the generic config-error surface to explain why. Gating on
    `bindChanged` fixes both: the switch reflects what the user just did until
    the store actually disagrees with it.
  */
  const [open, setOpen] = useState(exposed);

  const [hostDraft, setHostDraft] = useState(bind.host);
  const [hostInvalid, setHostInvalid] = useState(false);
  const [portDraft, setPortDraft] = useState(
    bind.port === 0 ? '' : String(bind.port),
  );
  const [portInvalid, setPortInvalid] = useState(false);
  const [originsDraft, setOriginsDraft] = useState(bind.allowedOrigins.join(', '));
  const [originsInvalid, setOriginsInvalid] = useState(false);

  /*
    Same follow-the-snapshot reasoning as `seen` above, repeated for the three
    bind fields: Reload and Reset change `bind` underneath this component, and
    a stale draft would write the pre-reset value straight back into the file
    the user just reset. Compared field-by-field rather than by object
    identity, because the snapshot hands back a fresh object (and a fresh
    array) on every read even when nothing actually changed.
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
    setHostInvalid(false);
    setPortDraft(bind.port === 0 ? '' : String(bind.port));
    setPortInvalid(false);
    setOriginsDraft(bind.allowedOrigins.join(', '));
    setOriginsInvalid(false);
    // See the long comment above `open`: re-open only on a genuine change to
    // the resolved bind, and only toward exposed — never toward closed, which
    // would yank an in-progress edit shut under the user.
    if (exposed) setOpen(true);
  }

  const commitBindHost = () => {
    const next = hostDraft.trim();
    // Unlike the alias, there is no default to fall back to on empty — a bind
    // address always needs a value, and there is no meaningful "unset" host.
    if (next === '' || !isHostAlias(next)) {
      setHostInvalid(true);
      return;
    }
    setHostInvalid(false);
    setHostDraft(next);
    if (next === bind.host) return;
    void setReceiverConfig({ bind: { host: next } });
  };

  const commitPort = () => {
    const raw = portDraft.trim();
    /*
      `Number(raw)` alone accepts more than a field labelled "Port" should:
      `Number('0x1f')` is 31 and `Number('1e3')` is 1000, and both are
      `Number.isInteger` and in range, so hex and exponent notation used to
      pass through untouched. Not a security issue — the result is still a
      valid port — but a text field for decimal digits should read decimal
      digits. This gate runs first and admits only `\d+`, which is ASCII
      decimal digits and nothing else — no sign, no fraction, no exponent, no
      hex prefix.
    */
    if (raw !== '' && !/^\d+$/.test(raw)) {
      setPortInvalid(true);
      return;
    }
    // Empty is 0, which is what "any free port" is spelled as on the wire.
    const next = raw === '' ? 0 : Number(raw);
    if (!Number.isInteger(next) || next < 0 || next > 65_535) {
      setPortInvalid(true);
      return;
    }
    setPortInvalid(false);
    setPortDraft(next === 0 ? '' : String(next));
    if (next === bind.port) return;
    void setReceiverConfig({ bind: { port: next } });
  };

  const commitOrigins = () => {
    const entries = originsDraft
      .split(',')
      .map((entry) => entry.trim())
      .filter((entry) => entry !== '');
    // A single bad entry refuses the whole write — a partial allowlist is a
    // worse failure than a rejected edit, because it fails silently later,
    // at request time, for whichever origin got dropped.
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
    void setReceiverConfig({ bind: { allowedOrigins: entries } });
  };

  return (
    <SettingsGroup
      title="Containers"
      description="How a session running inside a container addresses this app."
    >
      <TextField
        label="Host alias"
        value={draft}
        onChange={(value) => {
          setDraft(value);
          if (invalid) setInvalid(false);
        }}
        onCommit={commit}
        placeholder={DEFAULT_RECEIVER.hostAlias}
        hint={invalid ? INVALID : HINT}
      />

      <Switch
        label="Accept connections off loopback"
        description="Only for a runtime with no alias that reaches the host, such as Docker on native Linux. Takes effect at next launch."
        checked={open}
        onCheckedChange={(next) => {
          setOpen(next);
          // See the long comment above `open`: this is the one write this
          // whole sub-group makes on its own, and it only ever narrows.
          if (!next && exposed) void setReceiverConfig({ bind: { host: DEFAULT_BIND.host } });
        }}
      />

      {open ? (
        <>
          {exposed ? (
            <p className="flex items-start gap-2 text-[12.5px]">
              <WarningCircle size={14} className="mt-px shrink-0 text-amber" />
              <span className="text-amber">{EXPOSED}</span>
            </p>
          ) : null}

          <TextField
            label="Bind address"
            value={hostDraft}
            onChange={(value) => {
              setHostDraft(value);
              if (hostInvalid) setHostInvalid(false);
            }}
            onCommit={commitBindHost}
            hint={hostInvalid ? BIND_INVALID : BIND_HINT}
          />

          <TextField
            label="Port"
            value={portDraft}
            onChange={(value) => {
              setPortDraft(value);
              if (portInvalid) setPortInvalid(false);
            }}
            onCommit={commitPort}
            placeholder="Any free port"
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
    </SettingsGroup>
  );
}
