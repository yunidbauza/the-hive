import { Broadcast } from '@phosphor-icons/react';

import { Chip } from '@components/ui/chip';
import { useServerExposure, useServingDeviceCount } from '@hooks/use-project-config';


/**
 * "This machine is serving its sessions to paired devices" (HIVE-142).
 *
 * Mirrors {@link ExposureChip} almost exactly — same source shape, same
 * silence rule, same reason for both — and the one place it deliberately
 * departs from that model is the tone, which is the whole reason this is its
 * own component rather than a second call site for `ExposureChip`.
 *
 * **Brand, not amber.** Amber is the token this app spends on "wider than
 * you may have meant" — a bind a user opened for one container, debugged,
 * and should probably close again. A machine running in server mode is
 * exposed **on purpose and permanently**: nothing sets `server.enabled` by
 * accident, and there is no "forgot to turn it off" story to warn against.
 * Painting a deliberate, permanent, opted-into state the same colour as an
 * accidental one would train a user to read amber as "background noise" —
 * exactly the signal `ExposureChip` (HIVE-134) spent a whole story earning.
 * So this chip reads **brand**, the app's own colour, because serving is a
 * fact about what this Hive *is* right now, not a warning about it.
 * {@link AttachedChip} (HIVE-144, Task 13) takes the same colour for the same
 * reason from the other end of the socket — see its own doc comment.
 *
 * **Sourced from the running bind, not the config snapshot.** Same reasoning
 * as `ExposureChip`, restated for the field this one reads:
 * `AppInfo.serverBoundHost` says what `remoteListener.start()` actually
 * bound; `snapshot.server.bind.host` says what will be bound at the *next*
 * launch. The two can disagree for a whole running session — see
 * `AppInfo.serverBoundHost`'s own doc comment — and a chip that told a user
 * "not serving" while a socket from this boot was still open and answering
 * paired devices would be actively wrong, not merely stale. `useServerExposure`
 * does the reading, and gates this chip's visibility exactly as it always has.
 *
 * **Renders nothing when nothing is bound**, for the same reason
 * `ExposureChip` does: there is no `server.enabled` flag this chip could read
 * to show an "off" state, because the only question that matters is whether a
 * socket is actually open right now, and a Hive that never turned server mode
 * on should see no new furniture in its header at all.
 *
 * **The count replaces the address (HIVE-144, Task 13).** This chip used to
 * carry the bound address, because a user checking on a headless Mac mini
 * from its own screen came here to confirm *where*. Now that a second chip
 * exists for the other end of the same socket — {@link AttachedChip}, "attached
 * · mini" — the pair reads as one vocabulary only if this one answers the
 * question *that* chip's user actually has: not where this machine is
 * reachable, but how many devices are already reaching it. `useServingDeviceCount`
 * reads `AppInfo.servingDeviceCount`, a **paired-device** count off
 * `server.devices` on disk — independent of whether the socket happens to be
 * bound this instant, which is why this component still gates on
 * `useServerExposure` rather than on the count being non-zero: a server that
 * is up with nobody paired yet is still serving, and should still say so.
 * The `title` keeps the address for the one audience who still wants it —
 * see below.
 */
export function ServingChip() {
  const address = useServerExposure();
  const deviceCount = useServingDeviceCount();
  if (address === null) return null;

  const devices = deviceCount === 1 ? '1 device' : `${String(deviceCount)} devices`;

  return (
    <Chip
      tone="brand"
      title={`This Hive is serving its sessions to paired devices on ${address}. Turn it off in Settings › Advanced › Server mode.`}
      className="shrink-0"
    >
      <Broadcast size={12} />
      serving · {devices}
    </Chip>
  );
}
