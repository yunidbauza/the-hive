import type { ReactNode } from 'react';

import { SwarmCreature, type Creature } from '@components/ui/swarm-creature';
import { SwarmLine } from '@components/ui/swarm-line';
import type { PhraseKey } from '@lib/swarm/phrases';

/**
 * The rail size, named once.
 *
 * It is the number the whole "a rail may have a sprite" argument rests on, so
 * it is a constant rather than six call sites that could drift apart — and one
 * that drifts upward stops being a mark and becomes the illustration this
 * component's doc rules out.
 */
export const RAIL_CREATURE_SIZE = 44;

/**
 * A creature — or a control — without a phrase is a compile error, not a silent
 * no-op.
 *
 * Both are rendered inside the flavoured branch, so either one alone would
 * type-check, lint, and draw nothing — with no error to explain why. Twenty-odd
 * call sites still pass neither, and they keep working; what the union removes
 * is the combinations that look correct and aren't.
 *
 * `children` is required in the un-flavoured arm and optional in the flavoured
 * one, because the flavour line is itself a sentence: a panel whose emptiness
 * the line already reports, and whose way out is a control, has nothing left
 * for the body to say that would not be the same fact twice.
 */
type EmptyStateProps = {
  /** How to fix it. One sentence. */
  action?: ReactNode;
} & (
  | {
      /** Which pool to draw a flavour line from. */
      phrase: PhraseKey;
      /** The sprite above the flavour line. 44px — see the note above. */
      creature?: Creature;
      /**
       * The way out this panel can take *itself* — a control, not a sentence.
       *
       * `action` names a destination the panel cannot route to, so it stays
       * prose. This is a button, and it re-centres the block: a control the eye
       * has to find is worth more than the left edge the copy is aligned to.
       */
      control?: ReactNode;
      /** What is missing. One sentence — or nothing; see the note above. */
      children?: ReactNode;
    }
  | {
      phrase?: undefined;
      creature?: never;
      control?: never;
      /** What is missing. One sentence. */
      children: ReactNode;
    }
);

/**
 * What a left-rail panel says when it has nothing to list.
 *
 * ## Why this exists at all
 *
 * Every one of these panels used to boot pre-populated from a seeded dataset —
 * five projects, three agents, ten sessions — so "empty" was a state that only
 * happened in tests. With the seed gone it is the *first* thing a new user sees,
 * and a blank column is indistinguishable from a panel that failed to render.
 *
 * ## The shape of the copy
 *
 * One sentence naming what is missing, then one naming the way to fix it. Never
 * a bare "No projects" — that reports a state without offering an exit, which is
 * the difference between an empty state and a dead end.
 *
 * Deliberately quiet: `text-subtle` at the same 11.5px the work panel's source
 * notices use. An empty list is not an error and should not be dressed as one;
 * the amber register in this app is reserved for things that actually went
 * wrong.
 *
 * No centred hero block, and nothing that fills the column. These sit in a
 * 320px rail beside a terminal the user is trying to read, and an empty state
 * that took more of their attention than the thing it is apologising for would
 * be worse than the blank column it replaced.
 *
 * ## The flavour line and the creature
 *
 * `phrase` opts a panel into a line of swarm above the copy — and *above* is
 * the whole design. The paragraph below it is untouched: what is missing, then
 * the way out, exactly as before. Nothing became decorative instead of useful,
 * which is the only reading under which the paragraph above stays true.
 *
 * `creature` adds the sprite that goes with it, at **44px** — a size chosen so
 * the paragraph above stays true rather than in spite of it. It is shorter than
 * the two lines of copy beneath it and reads as a mark, not an illustration.
 * The centred 96–120px block the full-stage surfaces use is exactly what a rail
 * must not have, and `SwarmCreature` documents the same split from its side.
 *
 * ## Why a control centres the block
 *
 * `control` is the one prop that changes the layout, and only because a button
 * is not copy. Left-aligned it would sit in the column the sentences hang off
 * and read as another line of them; centred under the flavour line it reads as
 * the thing to press. The sentence that survives it goes *underneath*, because
 * it names the way out this panel cannot take — and a footnote to a control is
 * the shape that says so.
 *
 * Still quiet, still not a hero: the block gains 10px of air and a border, not
 * a fill. The register above this one belongs to Settings.
 */
export function EmptyState({
  children,
  action,
  phrase,
  creature,
  control,
}: EmptyStateProps) {
  /**
   * The separator is the tell that an absent half rendered anyway, in both
   * directions: no leading space when the body is only an action, and no
   * trailing one when it is only children.
   */
  const sentence =
    children === undefined ? (
      action
    ) : (
      <>
        {children}
        {action === undefined ? null : <> {action}</>}
      </>
    );

  const body =
    sentence === undefined ? null : (
      <p className="px-1 py-1 text-[11.5px] leading-[1.45] text-subtle">
        {sentence}
      </p>
    );

  /**
   * The un-flavoured case returns the bare paragraph rather than a wrapper
   * around it. Twenty-odd call sites predate this prop and their layout was
   * tuned against that exact element; introducing a flex container for all of
   * them to add nothing would be a silent re-spacing of panels this change has
   * no business touching.
   */
  if (phrase === undefined) return body;

  const centred = control !== undefined;

  return (
    <div
      className={
        centred
          ? 'flex flex-col items-center gap-[3px] text-center'
          : 'flex flex-col gap-[3px]'
      }
    >
      {creature === undefined ? null : (
        <div className="px-1 pb-0.5">
          <SwarmCreature creature={creature} size={RAIL_CREATURE_SIZE} />
        </div>
      )}
      <SwarmLine phraseKey={phrase} />
      {centred ? (
        <div className="mt-2.5 flex max-w-[24ch] flex-col items-center gap-[7px]">
          {control}
          {body}
        </div>
      ) : (
        body
      )}
    </div>
  );
}

/**
 * The half of the sentence that names a destination.
 *
 * A span rather than a button: none of these panels can open Settings from
 * where they sit — the rail has no route to it — so this names the path the way
 * the work panel already names `Settings → Integrations`, and does not pretend
 * to be clickable.
 */
export function EmptyStatePath({ children }: { children: ReactNode }) {
  return <span className="text-muted">{children}</span>;
}
