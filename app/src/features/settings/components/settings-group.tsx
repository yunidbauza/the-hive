/**
 * A titled group with an explanation — the layout unit every section uses.
 *
 * Story 104 and story 105 each defined this locally, byte-identical. Story 106
 * would have been the third copy, so it moved here instead: three copies of a
 * layout primitive is how two settings panes quietly start looking different
 * from each other.
 */
export function SettingsGroup({
  title,
  description,
  children,
}: {
  title: string;
  description: string;
  children: React.ReactNode;
}) {
  return (
    <section className="flex flex-col gap-2 border-b border-border-soft pb-4 last:border-b-0 last:pb-0">
      <div className="flex flex-col gap-0.5">
        <h3 className="text-[13px] text-ink">{title}</h3>
        <p className="text-[11.5px] text-subtle">{description}</p>
      </div>
      {children}
    </section>
  );
}
