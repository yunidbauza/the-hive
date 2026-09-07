import { WarningCircle } from '@phosphor-icons/react';

import { Chip } from '@components/ui/chip';
import { useReceiverExposure } from '@hooks/use-project-config';


/**
 * "This app is listening somewhere other than loopback" (HIVE-134).
 *
 * HIVE-131 specified this chip and then dropped it, for a reason worth keeping:
 * on the alias path nothing becomes exposed, and claiming exposure when there is
 * none is worse than silence. This is the story where it earns its place, and
 * the same reasoning is why it renders **nothing** when nothing is listening —
 * not a muted "loopback" chip, not an off state. There is no `bind.enabled`
 * flag it could read to say "off" while a socket was actually open; `isLoopbackHost`
 * is the one place that question gets answered, for main's guards and for this
 * chip alike, and a user whose receiver never bound off loopback should see no
 * new furniture in their header at all.
 *
 * **Sourced from the receiver's running bind, not the config snapshot**
 * (HIVE-134). `receiver.bind.host` says what will be bound at the *next*
 * launch — a listening socket cannot be moved, which is what "takes effect at
 * next launch" in Settings already says — while `AppInfo.receiverBoundHost`
 * says what is bound *now*. The two can disagree for a whole running session:
 * toggle the settings switch off and the config snapshot updates instantly,
 * but the socket bound wide at boot stays open until relaunch. A security
 * indicator has to report the latter, or a user who just toggled off reads a
 * vanished chip as "safe now" while the old socket is still reachable. So this
 * says the receiver is exposed for exactly as long as it actually is — see
 * `useReceiverExposure`, which does the reading, and `container-alias-group.tsx`'s
 * settings switch, which stays config-derived on purpose: it is a control over
 * the file, not a status readout.
 *
 * Amber, the token the app already spends on "needs attention", which is the
 * right register here: a bind the user chose deliberately is not an error, but
 * it is not nothing either — the machine is now reachable from outside itself.
 *
 * It carries the **address** rather than the word "exposed", because the
 * address is the fact that matters. "exposed" only prompts the question the
 * chip could have answered outright, and a user reading this chip is usually
 * mid-way through debugging a container that cannot reach the host on
 * loopback — the address is exactly what they came here to confirm. The
 * `title` carries the rest, including where to turn it off, since a chip in a
 * 56px row has no room to spell out a sentence.
 *
 * Sits in the centre cluster beside {@link ModelChip} rather than in the left
 * zone with {@link DemoChip}: `DemoChip` describes the **build** — a fact
 * about the binary that never changes at runtime — which is why it lives with
 * the product identity. This chip describes a fact about the **running
 * process** instead, resolved at launch rather than baked into the binary, so
 * it belongs with the other chip that reads process state rather than the one
 * that reads a build flag. That the value, once main's own bind has resolved,
 * cannot change again before the next launch (see `AppInfo.receiverBoundHost`
 * for exactly what "resolved" means here) is why one read is enough — it does
 * not need to belong to a live subscription to earn this position.
 */
export function ExposureChip() {
  const address = useReceiverExposure();
  if (address === null) return null;

  return (
    <Chip
      tone="amber"
      title={`The receiver accepts connections on ${address}, not only loopback. Turn it off in Settings › Advanced › Containers.`}
      className="shrink-0"
    >
      <WarningCircle size={12} />
      {address}
    </Chip>
  );
}
