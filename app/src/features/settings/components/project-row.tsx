import { X } from '@phosphor-icons/react';

import type { ProjectRow as Row } from '@/types/entity';

import { Icon } from '@components/ui/icon';
import { Tag } from '@components/ui/tag';

interface ProjectRowProps {
  project: Row;
  /** The resolved path, or the reason it is unusable. */
  detail: string;
  /** False when the directory is not a git repository. */
  isRepo: boolean;
  /** Why removal is unavailable, or null when it is allowed. */
  removeBlockedBy: string | null;
  onRemove: (id: string) => void;
}

/**
 * One row in the settings projects list (story 101).
 *
 * Icon, name over path, then any tags, then remove. The row is the only place
 * the `demo` and `no git` distinctions surface, and both are `Tag`s rather than
 * prose: they are states, and the list is scanned rather than read.
 */
export function ProjectRow({
  project,
  detail,
  isRepo,
  removeBlockedBy,
  onRemove,
}: ProjectRowProps) {
  const removable = removeBlockedBy === null;
  const hintId = removable ? undefined : `remove-${project.id}-why`;

  return (
    <div className="flex items-center gap-2.5 border-b border-border-soft px-3 py-2.5 last:border-b-0">
      <Icon name={project.icon} className="shrink-0 text-muted" />

      <div className="flex min-w-0 flex-1 flex-col">
        <span className="truncate text-[13px] text-ink">{project.name}</span>
        <span className="truncate text-[11.5px] text-subtle">{detail}</span>
      </div>

      {project.source === 'demo' ? <Tag tone="brand">demo</Tag> : null}
      {project.source === 'config' && !isRepo ? (
        /*
          Muted, not a warning. A PTY needs a cwd, not a repo — refusing to add
          a plain directory would be the app inventing a rule the shell does not
          have, so this reports rather than scolds.
        */
        <Tag tone="subtle" title="not a git repository — sessions still open here">
          no git
        </Tag>
      ) : null}

      <button
        type="button"
        onClick={() => onRemove(project.id)}
        disabled={!removable}
        aria-label={`Remove ${project.name}`}
        aria-describedby={hintId}
        title={removeBlockedBy ?? undefined}
        className="shrink-0 rounded p-1 text-subtle hover:bg-hover hover:text-ink disabled:cursor-not-allowed disabled:opacity-30 disabled:hover:bg-transparent disabled:hover:text-subtle"
      >
        <X size={13} weight="bold" />
      </button>

      {hintId ? (
        <span id={hintId} className="sr-only">
          {removeBlockedBy}
        </span>
      ) : null}
    </div>
  );
}
