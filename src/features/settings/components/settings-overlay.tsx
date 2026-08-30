import { X } from '@phosphor-icons/react';
import { Dialog as DialogPrimitive } from 'radix-ui';
import { useEffect, useState, type ComponentType } from 'react';

import { cn } from '@/lib/utils';
import type { SettingsSection } from '@/types/settings';

import { AdvancedSection } from '@features/settings/components/advanced-section';
import { AgentsSection } from '@features/settings/components/agents-section';
import { AppearanceSection } from '@features/settings/components/appearance-section';
import { EditorSection } from '@features/settings/components/editor-section';
import { IntegrationsSection } from '@features/settings/components/integrations-section';
import { NotificationsSection } from '@features/settings/components/notifications-section';
import { ProjectsSection } from '@features/settings/components/projects-section';
import { RuntimeSection } from '@features/settings/components/runtime-section';
import { SkillsSection } from '@features/settings/components/skills-section';
import { useSettingsActions, useSettingsSection } from '@stores/ui-store';


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
 * HIVE-96's Skills is the first section to arrive from **outside** the epic, and
 * it cost the same two lines — which is the claim above finally being tested by
 * something it did not anticipate rather than merely restated.
 *
 * Sections stay **absent rather than disabled** until they exist: a nav full of
 * dead items teaches the user that settings are broken.
 *
 * Skills sits directly after Runtime because both answer "what does a session I
 * start actually run?" — Runtime decides the binary and its environment, Skills
 * decides the commands it comes with. Appearance onwards is about the app.
 *
 * Advanced sits last deliberately. It is the only section that answers
 * questions about the app rather than setting anything in it, and the
 * destructive verb in the product lives there.
 */
const SECTIONS: readonly { id: SettingsSection; label: string }[] = [
  { id: 'projects', label: 'Projects' },
  { id: 'runtime', label: 'Runtime' },
  { id: 'skills', label: 'Skills' },
  { id: 'agents', label: 'Agents' },
  { id: 'appearance', label: 'Appearance' },
  { id: 'editor', label: 'Editor' },
  { id: 'integrations', label: 'Integrations' },
  { id: 'notifications', label: 'Notifications' },
  { id: 'advanced', label: 'Advanced' },
] as const;

/*
  Derived from the shared union rather than declared here: `ui-store` has to
  name a pane to honour `openSettings('agents')` and may not import a feature
  slice, so the vocabulary lives in `@/types/settings` and this list is checked
  against it. A pane added below without a member there does not compile.
*/
type SectionId = SettingsSection;

/**
 * Section id → pane, the same shape `left-rail.tsx` uses for its panels.
 *
 * A map rather than a chain of ternaries: adding story 104's section should be
 * two lines and no control flow.
 */
const PANES: Record<SectionId, ComponentType> = {
  projects: ProjectsSection,
  runtime: RuntimeSection,
  skills: SkillsSection,
  agents: AgentsSection,
  appearance: AppearanceSection,
  editor: EditorSection,
  integrations: IntegrationsSection,
  notifications: NotificationsSection,
  advanced: AdvancedSection,
};

/**
 * Has some control inside this overlay claimed Escape for itself?
 *
 * ## Presence, not focus
 *
 * This used to ask only whether the *event target* sat inside an escape scope,
 * which was correct only because the focus trap guaranteed focus was still
 * inside the overlay. The overlay is not modal any more — it leaves the header
 * and rails live — so a keyboard user can Tab out to the header with a rename
 * editor still open. Escape pressed there has a target outside every scope, the
 * guard would decline to fire, and the overlay would close and discard the
 * edit: exactly the loss `data-escape-scope` was added to prevent.
 *
 * The marker lives on the claiming control itself and unmounts with it, so its
 * presence anywhere is the signal. That keeps the property the attribute was
 * chosen for — the overlay learns that Escape is spoken for without learning
 * who spoke for it.
 *
 * Exported for its test: this is a document query inside a Radix callback, and
 * the branch that matters is the one where focus has already left.
 */
export function escapeIsClaimed(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;

  if (el?.closest?.('[data-escape-scope]')) return true;

  return document.querySelector('[data-escape-scope]') !== null;
}

export function SettingsOverlay() {
  const { closeSettings, clearSettingsSection } = useSettingsActions();

  /**
   * Component-local, deliberately not `ui-store`.
   *
   * Settings open on Projects unless the caller *named* a pane. The realistic
   * route in is the picker discovering it has no projects to offer (story
   * 101), and reopening onto whichever pane was last visited would strand
   * exactly that user in Appearance with no idea where the thing they came for
   * went. A caller that asked for a pane — the rail's `+ New agent…`
   * (HIVE-116) — is a different case: it is answering a question the user just
   * asked, and landing them on Projects would lose it.
   *
   * The request is honoured on arrival, not only at mount. This overlay is
   * `modal={false}` precisely so the rails stay live underneath it, so
   * `openSettings('agents')` can fire while it is already open — and reading
   * the request once made that click do visibly nothing. The effect below
   * consumes each request exactly once, which is what keeps a stale value from
   * yanking the pane back after the user has navigated on.
   */
  const requested = useSettingsSection();
  const [section, setSection] = useState<SectionId>(requested ?? 'projects');

  useEffect(() => {
    if (requested === null) return;

    setSection(requested);
    clearSettingsSection();
  }, [requested, clearSettingsSection]);
  const Pane = PANES[section];

  return (
    <DialogPrimitive.Root
      open
      /**
       * Not modal, and not for a11y-purity reasons — because it was breaking
       * the header.
       *
       * This overlay fills the **center stage** and deliberately leaves the
       * header and both rails on screen. Radix's default modality then marked
       * that visible chrome `aria-hidden` and gave it `pointer-events: none`,
       * so the theme toggle, the notification bell, New session and every rail
       * tab looked live and did nothing. Clicking one dismissed the overlay
       * instead of acting, which is why toggling the theme from here needed two
       * clicks — the first was spent closing settings.
       *
       * Visible chrome that ignores the pointer is the worst of both designs. A
       * real modal would have to dim the surroundings to earn that; this is a
       * stage *view*, closer to a route than a dialog, so it stops claiming to
       * be modal. Escape and the close button still close it — see
       * `onInteractOutside` below for the third route that used to.
       *
       * The cost, stated plainly: no focus trap. For a view whose surrounding
       * chrome is legitimately interactive that is the correct behaviour, and
       * it hands the header back to screen readers, which modality had removed.
       */
      modal={false}
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
          if (escapeIsClaimed(event.target)) event.preventDefault();
        }}
        /**
         * A click on the header is a click on the header, not a dismissal.
         *
         * Without this, `modal={false}` would restore the pointer but Radix
         * would still treat the same click as an outside-interaction and close
         * the overlay — so the theme would toggle *and* settings would vanish,
         * which is half the reported bug still standing. Settings is left by
         * its close button or Escape.
         */
        onInteractOutside={(event) => {
          event.preventDefault();
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
