import { cn } from '@/lib/utils';

import { Icon } from '@components/ui/icon';
import { useActiveFileKey, useEditorActions, useEditorTabs } from '@stores/editor-store';

interface EditorTabStripProps {
  /**
   * Whether to offer a Terminal entry.
   *
   * True exactly when the terminal is hidden — `full` placement — and false in
   * `split`, where it is already on screen beside the editor. That single rule
   * is what makes placement and nav model independent settings: the strip does
   * not need to know which combination it is in, only whether there is a way
   * back that the user cannot already see.
   */
  showTerminalTab: boolean;
}

/**
 * The open files, and — when the terminal is hidden — the way back to it.
 *
 * **Stage chrome, not editor chrome.** It renders above both the terminal
 * region and the editor pane, so selecting Terminal does not take the strip
 * away with it and strand the user's open files behind a control that no
 * longer exists.
 *
 * Only rendered when something is open. An empty strip is a permanent 28px tax
 * on the terminal for a feature nobody is currently using.
 */
export function EditorTabStrip({ showTerminalTab }: EditorTabStripProps) {
  const tabs = useEditorTabs();
  const activeKey = useActiveFileKey();
  const { setActive, closeFile, showTerminal } = useEditorActions();

  if (tabs.length === 0) return null;

  return (
    <div
      role="tablist"
      aria-label="Open files"
      className="flex shrink-0 items-stretch gap-px overflow-x-auto border-b border-border-soft bg-panel"
    >
      {showTerminalTab ? (
        <button
          type="button"
          role="tab"
          aria-selected={activeKey === null}
          onClick={showTerminal}
          className={cn(
            'flex shrink-0 items-center gap-1.5 px-3 py-1.5 font-mono text-[11.5px] whitespace-nowrap',
            activeKey === null
              ? 'bg-panel-2 text-ink'
              : 'text-subtle hover:bg-hover hover:text-muted',
          )}
        >
          <Icon name="ph-terminal" size={13} />
          Terminal
        </button>
      ) : null}

      {tabs.map((tab) => {
        const active = tab.key === activeKey;
        return (
          /*
            A div wrapping two buttons, not a button containing a button —
            which is invalid HTML and gives the close control no reliable
            activation. The row is a tab; the × is its own control with its own
            label.
          */
          <div
            key={tab.key}
            className={cn(
              'group flex shrink-0 items-center',
              active ? 'bg-panel-2' : 'hover:bg-hover',
            )}
          >
            <button
              type="button"
              role="tab"
              aria-selected={active}
              onClick={() => setActive(tab.key)}
              title={tab.relPath}
              className={cn(
                'flex items-center gap-1.5 py-1.5 pr-1 pl-3 font-mono text-[11.5px] whitespace-nowrap',
                active ? 'text-ink' : 'text-subtle group-hover:text-muted',
              )}
            >
              {tab.name}
              {/*
                The dirty dot is inside the label button rather than replacing
                the ×, as some editors do. Swapping the close control for a dot
                means the one moment you most want to close a tab deliberately
                — when it has unsaved changes — is the one moment the control
                moves.
              */}
              {tab.dirty ? (
                <span
                  aria-hidden="true"
                  className="size-1.5 shrink-0 rounded-full bg-amber"
                />
              ) : null}
              {tab.dirty ? <span className="sr-only">unsaved changes</span> : null}
            </button>

            <button
              type="button"
              onClick={() => closeFile(tab.key)}
              className="mr-1.5 rounded p-0.5 text-subtle hover:bg-active hover:text-ink"
            >
              <Icon name="ph-x" size={11} />
              <span className="sr-only">Close {tab.name}</span>
            </button>
          </div>
        );
      })}
    </div>
  );
}
