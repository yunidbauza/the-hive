import type { ReactNode } from 'react';

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
 * No icon and no centred hero block. These sit in a 268px rail beside a
 * terminal the user is trying to read, and a decorative empty state would take
 * more of their attention than the thing it is apologising for.
 */
export function EmptyState({
  children,
  action,
}: {
  /** What is missing. One sentence. */
  children: ReactNode;
  /** How to fix it. One sentence, or a control. */
  action?: ReactNode;
}) {
  return (
    <p className="px-1 py-1 text-[11.5px] leading-[1.45] text-subtle">
      {children}
      {action === undefined ? null : <> {action}</>}
    </p>
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
