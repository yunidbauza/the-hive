import { Chip } from '@components/ui/chip';
import { isDesktop } from '@config/runtime';


/**
 * "This build has no real terminals" (story 083).
 *
 * The browser target survives as a demo surface on one condition: it must
 * degrade **visibly**. This chip is the most load-bearing part of that — a
 * build that looks identical to the desktop app while its terminals are
 * recordings is a trap, first for the user and then for us the moment someone
 * files a bug against a transcript.
 *
 * Amber, reusing the `--cc-amber` token the app already spends on "needs
 * attention", which is the right register: not an error, but not nothing.
 *
 * It sits in the header's **left** zone, beside the wordmark, rather than in
 * the centre track next to the model chip. Three reasons:
 *
 * - The centre track is what `header.tsx` centres. Adding a second chip there
 *   means the model chip is no longer at the midpoint the grid exists to find.
 * - Both side tracks size to the wider side, so the header needs
 *   `2 × max(side) + chip`. The right cluster is already the wider one and
 *   already forces the counts to ellipsise; the left has room to spare.
 * - It describes the **build**, not the session — so it belongs with the
 *   product identity. The centre track holds `ModelChip`, which renders
 *   nothing on the orchestrator and agent tabs, and the orchestrator is exactly
 *   where demo mode matters most: it is where `spawn` refuses.
 */
export function DemoChip() {
  if (isDesktop()) return null;

  return (
    <Chip
      tone="amber"
      title="Demo build — terminals are recorded transcripts. Real sessions need the desktop app."
      className="shrink-0"
    >
      demo
    </Chip>
  );
}
