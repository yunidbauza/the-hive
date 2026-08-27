import { MagnifyingGlass, X } from '@phosphor-icons/react';

import type { FsSearchMode } from '@shared/fs-contract';
import {
  useClearExplorerSearch,
  useExplorerSearchMode,
  useExplorerSearchTerm,
  useSetExplorerSearchMode,
  useSetExplorerSearchTerm,
} from '@stores/ui-store';

/**
 * The Explorer's search box.
 *
 * ## Why one box with a mode, and not two fields
 *
 * "Find a file called X" and "find the text X" are different questions, and the
 * obvious shape is a field for each. In a 316px rail that doubles a header
 * which already carries a project name, a branch chip and two buttons. A
 * segmented control costs one row and makes the two mutually exclusive, which
 * they are: nobody wants both answers at once, they want one and then the
 * other.
 *
 * The control only appears once something is typed — an empty box has no mode
 * worth choosing, and the same reasoning keeps the PRs panel's "All repos"
 * checkbox hidden until it can matter.
 *
 * ## Why the term lives in the store
 *
 * `ui-store`, beside `prSearchTerm`, for the reason stated there: the term is
 * view state and the files that come back are data. It also survives a tab
 * switch, so leaving the Explorer to look at a PR and coming back does not
 * silently discard a search.
 */

const MODES: readonly { value: FsSearchMode; label: string; hint: string }[] = [
  { value: 'name', label: 'Name', hint: 'Match file names' },
  { value: 'text', label: 'Text', hint: 'Match file contents' },
];

interface ExplorerSearchRowProps {
  /** Rendered on the right of the mode row. Empty until a search has answered. */
  status?: string;
}

export function ExplorerSearchRow({ status }: ExplorerSearchRowProps) {
  const term = useExplorerSearchTerm();
  const mode = useExplorerSearchMode();
  const setTerm = useSetExplorerSearchTerm();
  const setMode = useSetExplorerSearchMode();
  const clear = useClearExplorerSearch();

  return (
    <div className="flex shrink-0 flex-col gap-1.5 pb-1">
      <div className="flex items-center gap-2 rounded-lg border border-border bg-panel-2 px-2 py-1.5 focus-within:border-brand">
        <MagnifyingGlass size={12} className="shrink-0 text-subtle" />
        <input
          type="search"
          value={term}
          onChange={(event) => {
            setTerm(event.target.value);
          }}
          onKeyDown={(event) => {
            // Escape empties the box rather than closing anything: the panel is
            // a rail tab, not an overlay, and there is nothing to dismiss.
            if (event.key !== 'Escape' || term === '') return;
            event.preventDefault();
            clear();
          }}
          placeholder="Search files"
          aria-label="Search files"
          spellCheck={false}
          className="min-w-0 flex-1 bg-transparent text-[11.5px] text-ink outline-none placeholder:text-subtle"
        />
        {term === '' ? null : (
          <button
            type="button"
            onClick={clear}
            className="shrink-0 rounded-[4px] text-subtle hover:text-ink"
          >
            <X size={11} />
            <span className="sr-only">Clear the search</span>
          </button>
        )}
      </div>

      {term === '' ? null : (
        <div className="flex items-center gap-2 px-0.5">
          <div
            role="radiogroup"
            aria-label="What to search"
            className="inline-flex overflow-hidden rounded-[6px] border border-border"
          >
            {MODES.map((option) => (
              <button
                key={option.value}
                type="button"
                role="radio"
                aria-checked={mode === option.value}
                title={option.hint}
                onClick={() => {
                  setMode(option.value);
                }}
                className={[
                  'px-2 py-0.5 text-[10px]',
                  mode === option.value
                    ? 'bg-active text-brand'
                    : 'text-muted hover:bg-hover hover:text-ink',
                ].join(' ')}
              >
                {option.label}
              </button>
            ))}
          </div>

          {status === undefined || status === '' ? null : (
            <span className="ml-auto truncate text-[10px] text-subtle tabular-nums">
              {status}
            </span>
          )}
        </div>
      )}
    </div>
  );
}
