import { InlineConfirm } from '@features/settings/components/inline-confirm';

interface ConfigResetConfirmProps {
  /** Projects in the current snapshot. Zero is valid — the file may be empty. */
  projectCount: number;
  onConfirm: () => void;
  onCancel: () => void;
}

/**
 * Confirm resetting the config file (story 107).
 *
 * ## Why inline
 *
 * `project-remove-confirm.tsx` exactly, rather than a second dialect of
 * "confirm a destructive thing". The epic's first binding decision is that
 * settings is a full-stage overlay and explicitly not a modal, because "a modal
 * floating over thirteen live terminals fights the attention model" — and that
 * reasoning does not stop applying because this particular action is the larger
 * one. Expanding in place keeps the group that asked the question as the thing
 * being answered.
 *
 * ## What it says is the design
 *
 * Reset is the **only** write in the app that discards what it did not write.
 * Every other verb spreads the document it read, so unknown top-level keys and
 * the user's own `"//"` comments survive; this one replaces them. Naming the
 * comments specifically is the point rather than a flourish: the template is
 * deliberately comment-heavy, the product encourages hand-editing, and a user
 * who has annotated their config is exactly the user this confirmation exists
 * for.
 *
 * It does **not** claim anything happens to their repositories. Resetting
 * forgets where they are; the directories on disk are untouched and the PTYs
 * already running keep running, exactly as with a removed project. Wording this
 * as data loss would be false, and false is worse than frightening.
 */
export function ConfigResetConfirm({
  projectCount,
  onConfirm,
  onCancel,
}: ConfigResetConfirmProps) {
  const projects = projectCount === 1 ? '1 project' : `${projectCount} projects`;

  return (
    <InlineConfirm
      label="Reset the config file?"
      title="Reset the config file to the first-run template?"
      confirmLabel="Reset config"
      className="rounded-[7px] border border-red"
      onConfirm={onConfirm}
      onCancel={onCancel}
    >
      {projects}, every per-project shell, command and environment override,
      and your notification preferences are forgotten. Any comments you added
      to the file go too — this is the one write that does not preserve them.
      Nothing on disk is deleted: the repositories stay where they are, and
      sessions already running keep running.
    </InlineConfirm>
  );
}
