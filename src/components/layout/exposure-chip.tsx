import { WarningCircle } from '@phosphor-icons/react';

import { Chip } from '@components/ui/chip';
import { useReceiverExposure } from '@hooks/use-project-config';


/**
 * "This app is listening somewhere other than loopback" (HIVE-134).
 *
 * HIVE-131 specified this chip and then dropped it, for a reason worth keeping:
 * on the alias path nothing becomes exposed, and claiming exposure when there is
 * none is worse than silence. This is the story where it earns its place, and
 * the same reasoning is why it renders **nothing** on the default bind — not a
 * muted "loopback" chip, not an off state. There is no `bind.enabled` flag it
 * could read to say "off" while the socket was actually open; `isLoopbackHost`
 * is the one place that question gets answered, for main and for this chip
 * alike, and a user who never opted into a wider bind should see no new
 * furniture in their header at all.
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
 * the product identity. This chip describes the **running app's
 * configuration**, a fact that can flip while the app is open, so it belongs
 * with the other chip that reads live state rather than the one that reads a
 * build flag.
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
