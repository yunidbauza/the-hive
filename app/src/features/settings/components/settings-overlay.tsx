import { X } from '@phosphor-icons/react';
import { Dialog as DialogPrimitive } from 'radix-ui';
import { useState, type ComponentType } from 'react';

import { cn } from '@/lib/utils';

import { AdvancedSection } from '@features/settings/components/advanced-section';
import { AppearanceSection } from '@features/settings/components/appearance-section';
import { EditorSection } from '@features/settings/components/editor-section';
import { IntegrationsSection } from '@features/settings/components/integrations-section';
import { NotificationsSection } from '@features/settings/components/notifications-section';
import { ProjectsSection } from '@features/settings/components/projects-section';
import { RuntimeSection } from '@features/settings/components/runtime-section';
import { useSettingsActions } from '@stores/ui-store';


/**
 * The settings overlay (story 101).
 *
 * ## Why the Radix primitive rather than `components/ui/dialog`
 *
 * The same reason the new-session picker gives (story 044): the vendored
 * `DialogContent` always portals to `document.body` and centres a fixed card.
 * Settings fills the **center stage** — the rails and header stay visible — so
 * it is composed from the primitive directly and rendered in place. The parts
 * that matter are kept: the focus trap, Escape, and the `aria-modal` semantics
 * that hide the rest of the tree from assistive tech.
 *
 * Not kept: scroll locking, and no `Dialog.Overlay`. A scrim across the whole
 * app would destroy the full-stage look, and the shell is a fixed-height,
 * non-scrolling layout, so there is no page scroll to lock.
 *
 * Not a modal for a second reason too: a dialog floating over thirteen live
 * terminals fights the attention model the app is built around, and this
 * surface needs room for a section list.
 */

/**
 * The section list.
 *
 * Story 101 shipped Projects alone; story 105 adds Appearance and, with it, the
 * switching this nav only ever described. Stories 104 and 106 cost exactly what
 * that promised — a row here and an entry in `PANES`, nothing else — and 107
 * filled the last slot the same way: five rows, five entries, and no control
 * flow anywhere in this file.
 *
 * Sections stay **absent rather than disabled** until they exist: a nav full of
 * dead items teaches the user that settings are broken. Every section the epic
 * named now exists, so the rule is currently unexercised — it applies to
 * whatever comes next.
 *
 * Advanced sits last deliberately. It is the only section that answers
 * questions about the app rather than setting anything in it, and the
 * destructive verb in the product lives there.
 */
const SECTIONS = [
  { id: 'projects', label: 'Projects' },
  { id: 'runtime', label: 'Runtime' },
  { id: 'appearance', label: 'Appearance' },
  { id: 'editor', label: 'Editor' },
  { id: 'integrations', label: 'Integrations' },
  { id: 'notifications', label: 'Notifications' },
  { id: 'advanced', label: 'Advanced' },
] as const;

type SectionId = (typeof SECTIONS)[number]['id'];

/**
 * Section id → pane, the same shape `left-rail.tsx` uses for its panels.
 *
 * A map rather than a chain of ternaries: adding story 104's section should be
 * two lines and no control flow.
 */
const PANES: Record<SectionId, ComponentType> = {
  projects: ProjectsSection,
  runtime: RuntimeSection,
  appearance: AppearanceSection,
  editor: EditorSection,
  integrations: IntegrationsSection,
  notifications: NotificationsSection,
  advanced: AdvancedSection,
};

export function SettingsOverlay() {
  const { closeSettings } = useSettingsActions();

  /**
   * Component-local, deliberately not `ui-store`.
   *
   * Settings should always open on Projects. The realistic route in is the
   * picker discovering it has no projects to offer (story 101), and reopening
   * onto whichever pane was last visited would strand exactly that user in
   * Appearance with no idea where the thing they came for went.
   */
  const [section, setSection] = useState<SectionId>('projects');
  const Pane = PANES[section];

  return (
    <DialogPrimitive.Root
      open
      onOpenChange={(open) => {
        if (!open) closeSettings();
      }}
    >
      <DialogPrimitive.Content
        aria-describedby={undefined}
        /**
         * An Escape a nested control has claimed is not this dialog's (103).
         *
         * Radix listens for Escape on the **document, in the capture phase**,
         * so it decides before the keystroke reaches whatever is focused — a
         * `stopPropagation` inside the rename editor can never win that race,
         * and the whole overlay closed when the user only meant to abandon an
         * edit. Anything that owns Escape for itself marks its subtree with
         * `data-escape-scope`, and this declines those.
         *
         * A data attribute rather than shared state: the overlay does not need
         * to know *which* control is open, only that one has claimed the key,
         * and a future section gets the behaviour by opting in rather than by
         * wiring something through here.
         */
        onEscapeKeyDown={(event) => {
          const target = event.target as HTMLElement | null;
          if (target?.closest?.('[data-escape-scope]')) event.preventDefault();
        }}
        className="flex min-h-0 flex-1 flex-col bg-panel-2 outline-none"
      >
        <div className="flex items-center justify-between border-b border-border-soft px-4 py-2.5">
          <DialogPrimitive.Title className="text-[13px] text-ink">
            Settings
          </DialogPrimitive.Title>
          <DialogPrimitive.Close
            aria-label="Close settings"
            className="rounded p-1 text-subtle hover:bg-hover hover:text-ink"
          >
            <X size={13} weight="bold" />
          </DialogPrimitive.Close>
        </div>

        <div className="grid min-h-0 flex-1 grid-cols-[148px_1fr]">
          <nav
            aria-label="Settings sections"
            className="flex flex-col gap-0.5 border-r border-border-soft p-3"
          >
            {SECTIONS.map((entry) => {
              const active = entry.id === section;

              return (
                <button
                  key={entry.id}
                  type="button"
                  // `page` rather than `true`: this nav selects which page of
                  // settings is showing, which is what the token means.
                  aria-current={active ? 'page' : undefined}
                  onClick={() => setSection(entry.id)}
                  className={cn(
                    'rounded-[5px] px-2.5 py-1 text-left text-[13px] outline-none',
                    'focus-visible:ring-1 focus-visible:ring-brand',
                    active
                      ? 'bg-active text-ink'
                      : 'text-muted hover:bg-hover hover:text-ink',
                  )}
                >
                  {entry.label}
                </button>
              );
            })}
          </nav>

          <Pane />
        </div>
      </DialogPrimitive.Content>
    </DialogPrimitive.Root>
  );
}
