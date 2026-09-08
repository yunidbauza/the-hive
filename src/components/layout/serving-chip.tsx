import { Broadcast } from '@phosphor-icons/react';

import { Chip } from '@components/ui/chip';
import { useServerExposure } from '@hooks/use-project-config';


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
 *
 * **Sourced from the running bind, not the config snapshot.** Same reasoning
 * as `ExposureChip`, restated for the field this one reads:
 * `AppInfo.serverBoundHost` says what `remoteListener.start()` actually
 * bound; `snapshot.server.bind.host` says what will be bound at the *next*
 * launch. The two can disagree for a whole running session — see
 * `AppInfo.serverBoundHost`'s own doc comment — and a chip that told a user
 * "not serving" while a socket from this boot was still open and answering
 * paired devices would be actively wrong, not merely stale. `useServerExposure`
 * does the reading.
 *
 * **Renders nothing when nothing is bound**, for the same reason
 * `ExposureChip` does: there is no `server.enabled` flag this chip could read
 * to show an "off" state, because the only question that matters is whether a
 * socket is actually open right now, and a Hive that never turned server mode
 * on should see no new furniture in its header at all.
 *
 * It carries the address rather than the word "serving" alone, because the
 * address is what a user checking on a headless Mac mini from its own screen
 * (the one way in, via the tray's "Open The Hive") actually came here to
 * confirm. The `title` names where to turn it off, since a chip in a 56px
 * row has no room to spell out a sentence.
 */
export function ServingChip() {
  const address = useServerExposure();
  if (address === null) return null;

  return (
    <Chip
      tone="brand"
      title={`This Hive is serving its sessions to paired devices on ${address}. Turn it off in Settings › Advanced › Server mode.`}
      className="shrink-0"
    >
      <Broadcast size={12} />
      Serving {address}
    </Chip>
  );
}
