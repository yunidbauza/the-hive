import type { ReactNode } from 'react';

import { cn } from '@/lib/utils';

import { Icon } from '@components/ui/icon';

interface EditorNoticeProps {
  tone: 'amber' | 'subtle';
  icon: string;
  children: ReactNode;
  actions?: ReactNode;
}

/**
 * A strip above the document saying something the document cannot.
 *
 * Three things use it and they are deliberately the same shape: the file
 * changed on disk under a dirty buffer, a save was refused as a conflict, and
 * the file was deleted. All three are "the disk and this buffer disagree", all
 * three offer the same two ways out, and giving them three different visual
 * treatments would make one feature look like three bugs.
 *
 * Amber, never red. The app reserves red for things that failed; none of these
 * did — an agent rewrote a file, which is the entire point of the app.
 */
export function EditorNotice({ tone, icon, children, actions }: EditorNoticeProps) {
  return (
    <div
      className={cn(
        'flex shrink-0 items-center gap-2 border-b px-3 py-1.5 text-[11.5px]',
        tone === 'amber'
          ? 'border-border-soft bg-panel text-amber'
          : 'border-border-soft bg-panel text-subtle',
      )}
    >
      <Icon name={icon} size={13} className="shrink-0" />
      <span className="flex-1">{children}</span>
      {actions}
    </div>
  );
}

/** One of the notice's ways out. Text, not a filled button: this is a strip. */
export function NoticeAction({
  onClick,
  children,
}: {
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="shrink-0 rounded px-1.5 py-0.5 font-mono text-[11.5px] text-muted underline underline-offset-2 hover:bg-hover hover:text-ink"
    >
      {children}
    </button>
  );
}
