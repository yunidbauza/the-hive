import { cn } from '@/lib/utils';

/**
 * A titled group with an explanation — the layout unit every section uses.
 *
 * Story 104 and story 105 each defined this locally, byte-identical. Story 106
 * would have been the third copy, so it moved here instead: three copies of a
 * layout primitive is how two settings panes quietly start looking different
 * from each other.
 *
 * ## The rhythm
 *
 * `pb-5` above the rule, against the pane container's `gap-6` below it. The two
 * used to be `pb-4` and `gap-4`, which put the rule exactly halfway between the
 * group it ends and the group it starts — equidistant reads as belonging to
 * neither, so a rule that was meant to be a floor rendered as a divider between
 * equals. The shorter gap ties it to the block above; the longer one is the
 * actual break.
 *
 * Both numbers live apart (one here, one in each pane), so they are changed
 * together or the asymmetry inverts.
 */
export function SettingsGroup({
  title,
  description,
  nested = false,
  children,
}: {
  title: string;
  description: string;
  /**
   * This group sits inside a {@link SettingsProviderGroup} band.
   *
   * One prop rather than two, because the two consequences are one fact. A
   * nested group draws **no rule** — the band already carries the provider's
   * own hairline, and a rule under every group inside it would put four lines
   * where the eye needs one — and its heading drops to `h4`, because a
   * document that says `h2 → h3 → h3` is telling a screen reader the provider
   * and the groups it contains are peers.
   *
   * Separation inside a band comes from the band's own `gap`, which is why the
   * bottom padding goes with the rule rather than surviving it.
   */
  nested?: boolean;
  children: React.ReactNode;
}) {
  const Heading = nested ? 'h4' : 'h3';

  return (
    <section
      className={cn(
        'flex flex-col gap-2',
        !nested && 'border-b border-border-soft pb-5 last:border-b-0 last:pb-0',
      )}
    >
      <div className="flex flex-col gap-0.5">
        <Heading className="text-[13px] font-semibold text-ink">{title}</Heading>
        <p className="text-[11.5px] text-subtle">{description}</p>
      </div>
      {children}
    </section>
  );
}
