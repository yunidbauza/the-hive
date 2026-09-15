import { SearchBox } from '@components/ui/search-box';
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
      <SearchBox label="Search files" value={term} onChange={setTerm} onClear={clear} />

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
