import { SettingsNestingContext } from '@features/settings/components/settings-nesting';

/**
 * A band of settings groups that all belong to one outside service.
 *
 * The level *above* `SettingsGroup`, and below `SettingsSectionHeader`:
 *
 * ```
 * 15px semibold ink        ← SettingsSectionHeader, the pane
 * 11px semibold brand      ← this, the provider — an eyebrow, not a title
 * 13px semibold ink        ← SettingsGroup, a group inside the band
 * 11.5px        subtle     ← either one's description
 * ```
 *
 * ## Why an eyebrow rather than a fourth heading size
 *
 * Integrations was six equal groups in a flat column — three about GitHub,
 * three about Jira — and nothing but the reading order said so. The word
 * "Jira" appeared in three titles because the layout could not say it once.
 *
 * The obvious fix is a heading above the group heading, and the type scale has
 * no room for one: `settings-section-header.tsx` records why the pane sits at
 * 15px and the group at 13px, and why 15px is already as large as anything in
 * this dialog may go without fighting the window's own 13px "Settings" title.
 * A size *between* them would be a difference you measure rather than see.
 *
 * So the level is added by colour and rule instead of by size, under the app's
 * hierarchy rule: **brand names a container, ink names a thing inside it.** The
 * projects rail says the same thing about a project and its sessions with the
 * same token, which is what makes this read as one system rather than as a
 * decorated pane.
 *
 * The device is not new here either — the explorer already labels the file tree
 * with an uppercase mono eyebrow above it. This is that, promoted to `brand`
 * because it names a container of *settings* rather than the panel it sits in.
 *
 * ## Why the rule is the band's only line
 *
 * The hairline runs from the name to the pane's right edge, so the eyebrow
 * reads as a lid on everything under it. The groups inside then draw no rules
 * of their own (`nested` on `SettingsGroup`): four lines where one is needed is
 * how a settings pane starts looking like a spreadsheet. Space separates the
 * groups; the line separates the providers.
 *
 * `aria-label` on the `<section>` rather than `aria-labelledby`: the eyebrow's
 * text is the label, and naming the region directly saves an id that would have
 * to be unique across a pane that renders this twice.
 *
 * ## Why the band tells its groups, rather than each group being told
 *
 * Everything above is only true if the groups inside actually behave as
 * contained — no rules of their own, and a heading level below this one. That
 * started as a `nested` prop on each `SettingsGroup`, which made a structural
 * fact into something every call site had to remember, and something three
 * components hard-coded on the assumption they would never be rendered
 * anywhere else. The band publishes it instead, so a group is nested exactly
 * when it is inside one — see `settings-nesting.ts`.
 */
export function SettingsProviderGroup({
  name,
  children,
}: {
  /** The service. Shown verbatim, upper-cased by CSS so the string stays readable. */
  name: string;
  children: React.ReactNode;
}) {
  return (
    <SettingsNestingContext value={true}>
      <section aria-label={name} className="flex flex-col gap-5">
        <h3 className="flex items-center gap-3 font-mono text-[11px] font-semibold tracking-[0.1em] text-brand uppercase">
          {name}
          <span aria-hidden="true" className="h-px flex-1 bg-brand/25" />
        </h3>
        {children}
      </section>
    </SettingsNestingContext>
  );
}
