/**
 * The title block a settings pane opens with — the level *above*
 * {@link SettingsGroup}.
 *
 * ## Why it exists
 *
 * Nine copies of this markup were spread across eight section files, and the
 * pane title was styled `text-[13px] text-ink` — byte-identical to the `h3`
 * inside every `SettingsGroup` below it. So "Appearance" and "Theme" rendered
 * at the same size, in the same colour, at the same weight, and the only thing
 * saying one contained the other was the vertical order. The reader has to
 * infer the hierarchy from the layout because the type refuses to state it.
 *
 * The copies had already started to disagree — two of the nine were
 * `text-[14px]` — which is exactly the drift `settings-group.tsx` documents
 * getting ahead of once already.
 *
 * ## The scale
 *
 * ```
 * 15px semibold ink     ← this, the pane
 * 13px regular  ink     ← SettingsGroup, a group inside the pane
 * 11.5px        subtle  ← either one's description
 * ```
 *
 * Two steps and a weight change, on a base of 13px. Bigger would fight the
 * dialog's own 13px "Settings" title one row up — a pane heading may outrank
 * the window chrome around it, but it should not shout over it — and anything
 * smaller than 15px on a monospace face at this size is a difference you have
 * to measure rather than see.
 *
 * The description keeps the same 11.5px subtle it has always had. It is the
 * *title* that was under-weighted; making the sentence beneath it smaller too
 * would push it below the group descriptions it is supposed to introduce.
 */
export function SettingsSectionHeader({
  title,
  description,
}: {
  title: React.ReactNode;
  description: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-0.5">
      <h2 className="text-[15px] font-semibold text-ink">{title}</h2>
      <p className="text-[11.5px] text-subtle">{description}</p>
    </div>
  );
}
