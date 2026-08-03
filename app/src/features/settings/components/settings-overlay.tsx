import { X } from '@phosphor-icons/react';
import { Dialog as DialogPrimitive } from 'radix-ui';

import { ProjectsSection } from '@features/settings/components/projects-section';
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
 * One entry, in a nav built for six. Story 101 ships Projects alone and stories
 * 104–107 fill the rest; a settings page that starts as a single pane and grows
 * a nav later is a settings page that gets redesigned twice. The other sections
 * are deliberately **absent rather than disabled** — a nav full of dead items
 * teaches the user that settings are broken.
 */
const SECTIONS = [{ id: 'projects', label: 'Projects' }] as const;

export function SettingsOverlay() {
  const { closeSettings } = useSettingsActions();

  return (
    <DialogPrimitive.Root
      open
      onOpenChange={(open) => {
        if (!open) closeSettings();
      }}
    >
      <DialogPrimitive.Content
        aria-describedby={undefined}
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
            {SECTIONS.map((section) => (
              <span
                key={section.id}
                aria-current="page"
                className="rounded-[5px] bg-active px-2.5 py-1 text-[13px] text-ink"
              >
                {section.label}
              </span>
            ))}
          </nav>

          <ProjectsSection />
        </div>
      </DialogPrimitive.Content>
    </DialogPrimitive.Root>
  );
}
