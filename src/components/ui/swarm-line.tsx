import { useSwarmPhrase } from '@hooks/use-swarm-phrase';
import type { PhraseKey } from '@lib/swarm/phrases';

/**
 * The flavour line — one sentence of swarm, above copy that says the real thing.
 *
 * ## Why it is a separate element and not part of the sentence
 *
 * `empty-state.tsx` fixes the convention: what is missing, then the way out.
 * Both of those are load-bearing and neither may be replaced by a joke. So the
 * flavour is a *third* line, and the two that matter are untouched — which is
 * also why adding this broke none of the panel tests.
 *
 * ## Why `text-muted` and not a colour
 *
 * It leads, so it is one step brighter than the `text-subtle` body. It is not
 * coloured, because the app's colours are spoken for: amber means "needs input",
 * red means "something failed", and brand means "you can act on this". A
 * flavour line is none of those — it is the quietest possible kind of
 * important, and a hue would promote a joke above the sentence explaining what
 * happened.
 *
 * ## Why a component wraps the hook
 *
 * So the caller can render it conditionally. `useSwarmPhrase` cannot sit behind
 * an `if` inside a component that sometimes has no phrase; mounting a component
 * that always calls it is the same thing without breaking the rules of hooks.
 */
export function SwarmLine({ phraseKey }: { phraseKey: PhraseKey }) {
  const phrase = useSwarmPhrase(phraseKey);

  return (
    <p data-swarm-line className="px-1 text-[11.5px] leading-[1.45] text-muted">
      {phrase}
    </p>
  );
}
