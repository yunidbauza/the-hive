import { PlugsConnected, Plugs } from '@phosphor-icons/react';

import type { Tone } from '@/types/notification';

import { Chip } from '@components/ui/chip';
import { useRemoteLink } from '@stores/hive-store';

/**
 * "This window is attached to another Hive's sessions over a socket"
 * (HIVE-144, Task 13) — and, since HIVE-150, what that attachment is doing.
 *
 * The other end of {@link ServingChip}'s socket — read that component's own
 * doc comment first; this one repeats the same rules for the opposite
 * direction rather than re-deriving them.
 *
 * **Sourced from the running attachment, not the config snapshot.** This is
 * the one place the pair's shared rule has *two* live sides to get right
 * rather than one: `ConfigSnapshot.attachedServer` (Task 12) names the
 * machine whose config file `config:get` is answering right now, which while
 * attached is genuinely the far end — a *control's* readout, correct for
 * Settings. This chip claims a **live** attachment instead, which that field
 * would answer wrongly in both directions: Ruling 19 deliberately leaves
 * `config.json` saying `remote` after an already-remote re-switch fails and
 * rebinds local, so a config-derived chip would keep claiming an attachment
 * that is no longer there; and, symmetrically, would deny one on the next
 * launch before the boot attach has even been attempted.
 *
 * **Renders nothing while not attached**, for the same reason `ServingChip`
 * renders nothing while unbound: there is no config flag this chip could read
 * to show an "off" state (`remote.mode` is a control for Settings, not a
 * status for this chip, per the split above), because the only question that
 * matters is whether a socket is actually open right now, and a Hive that
 * has never attached to anything should see no new furniture in its header.
 *
 * **Brand while it holds; amber while it is being rebuilt; red once it is
 * given up (HIVE-150).** This overrules an earlier rule here, and the
 * overruling is the point rather than an oversight. That rule said brand, not
 * amber, because "attaching is exactly as deliberate as serving" and painting
 * it amber would spend the signal `ExposureChip` (HIVE-134) earns on "wider
 * than you may have meant". That argument is about a *healthy* attachment and
 * it still holds for one — the `attached` state below is brand, beside
 * `ServingChip`, exactly as it was. A link that has dropped is not that: it is
 * the design system's "waiting", which is what amber means, and the two never
 * compete for attention because a machine that serves does not attach.
 *
 * Red is reserved for the state after the loop has stopped — a refusal no
 * retry can fix. That distinction is the one thing the user actually needs from
 * this chip before deciding whether to wait or to work locally, and two shades
 * of amber could not carry it.
 *
 * It carries the server's **name** — `RemoteClient.serverName()` (Task 7),
 * the far end's own `hostname()` handed over in the attach handshake — rather
 * than its address, because the name is what the user who just attached
 * actually recognizes ("mini", not an IP). The name rides on every status,
 * including the terminal one, because a chip that has lost a link still has to
 * say which machine it lost and the client that could answer is gone by then.
 */
export function AttachedChip() {
  const link = useRemoteLink();
  if (link === null) return null;

  const { state, serverName, lost } = link;

  const tone: Tone =
    state === 'attached' ? 'brand' : state === 'reconnecting' ? 'amber' : 'red';

  const label =
    state === 'attached'
      ? 'attached'
      : state === 'reconnecting'
        ? 'reconnecting'
        : 'disconnected';

  const title =
    state === 'attached'
      ? `This window is attached to ${serverName} over a socket — its sessions are what you are driving right now.`
      : state === 'reconnecting'
        ? `The connection to ${serverName} dropped and is being re-established. Your sessions are still running there.`
        : `The connection to ${serverName} ended and is not being retried${
            link.reason === null ? '' : `: ${link.reason}`
          }`;

  /*
    What the dropped link swallowed (HIVE-140 audit, gap 1): a click or a
    keystroke sent while it was down reached nothing, and nothing else on
    screen says so. Named in the chip, not only the tooltip, because the user
    has to know to redo them.
  */
  const lostNote =
    lost === 0
      ? ''
      : ` ${String(lost)} ${lost === 1 ? 'action' : 'actions'} (clicks or keystrokes) did not reach ${serverName}; redo ${lost === 1 ? 'it' : 'them'} once it is back.`;

  return (
    <Chip tone={tone} title={`${title}${lostNote}`} className="shrink-0">
      {state === 'attached' ? <PlugsConnected size={12} /> : <Plugs size={12} />}
      {label} · {serverName}
      {lost > 0 && ` · ${String(lost)} lost`}
    </Chip>
  );
}
