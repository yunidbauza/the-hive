import { MagnifyingGlass, X } from '@phosphor-icons/react';

interface SearchBoxProps {
  /** The placeholder and the accessible name, e.g. "Search files". */
  label: string;
  value: string;
  onChange: (value: string) => void;
  onClear: () => void;
}

/**
 * The rail tabs' search box: explorer, PRs and Work.
 *
 * Escape empties it rather than closing anything, because a rail tab is not
 * an overlay and there is nothing to dismiss. `type="search"` keeps the
 * searchbox role; the one clear button drawn is this one
 * (`tests/e2e/web/search-clear-button.spec.ts`).
 */
export function SearchBox({ label, value, onChange, onClear }: SearchBoxProps) {
  return (
    <div className="flex items-center gap-2 rounded-lg border border-border bg-panel-2 px-2 py-1.5 focus-within:border-brand">
      <MagnifyingGlass size={12} className="shrink-0 text-subtle" />
      <input
        type="search"
        value={value}
        onChange={(event) => {
          onChange(event.target.value);
        }}
        onKeyDown={(event) => {
          if (event.key !== 'Escape' || value === '') return;
          event.preventDefault();
          onClear();
        }}
        placeholder={label}
        aria-label={label}
        spellCheck={false}
        className="min-w-0 flex-1 bg-transparent text-[11.5px] text-ink outline-none placeholder:text-subtle"
      />
      {value === '' ? null : (
        <button
          type="button"
          onClick={onClear}
          className="shrink-0 rounded-[4px] text-subtle hover:text-ink"
        >
          <X size={11} />
          <span className="sr-only">Clear the search</span>
        </button>
      )}
    </div>
  );
}
