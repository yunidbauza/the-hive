import { InlineConfirm } from '@features/settings/components/inline-confirm';

interface ProjectRemoveConfirmProps {
  projectName: string;
  /** How many of this project's sessions are not done. Zero is valid. */
  liveSessionCount: number;
  onConfirm: () => void;
  onCancel: () => void;
}

/**
 * Confirm removing a project, in the row's own place (story 103).
 *
 * ## Why inline
 *
 * Story 101 disabled this remove and left a tooltip; the epic's first binding
 * decision is that settings is a full-stage overlay and explicitly *not* a
 * modal, because "a modal floating over thirteen live terminals fights the
 * attention model". Expanding the row keeps that instinct: the row is already
 * the subject of the question, so nothing has to float to ask it, the list does
 * not move under an accidental Cancel, and no new primitive is needed. The
 * alternatives — a centred `ui/dialog.tsx` card, and a 102-style focused
 * sub-view — were both rejected on browser-rendered mockups.
 *
 * ## What it says is the design
 *
 * Removing a project deletes its config entry. It does **not** kill anything:
 * the PTYs keep running and the tabs stay open, and the sessions simply stop
 * resolving to a mapped project, exactly like a session whose folder was never
 * mapped. Wording this as data loss would be false, and killing a user's live
 * terminals as a side-effect of a settings edit would be a far larger action
 * than this story is authorised to take.
 */
export function ProjectRemoveConfirm({
  projectName,
  liveSessionCount,
  onConfirm,
  onCancel,
}: ProjectRemoveConfirmProps) {
  const sessions =
    liveSessionCount === 1
      ? '1 live session will keep running'
      : `${liveSessionCount} live sessions will keep running`;

  return (
    <InlineConfirm
      label={`Remove ${projectName}?`}
      title={
        <>
          Remove <span className="font-medium">{projectName}</span> from your
          projects?
        </>
      }
      confirmLabel="Remove"
      className="border-b border-border-soft last:border-b-0"
      onConfirm={onConfirm}
      onCancel={onCancel}
    >
      {sessions} — they just stop resolving to a folder. The directory on disk
      is untouched.
    </InlineConfirm>
  );
}
