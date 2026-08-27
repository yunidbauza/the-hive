import {
  SearchQuery,
  closeSearchPanel,
  findNext,
  findPrevious,
  getSearchQuery,
  replaceAll,
  replaceNext,
  setSearchQuery,
} from '@codemirror/search';
import { type EditorView, type Panel } from '@codemirror/view';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { KeyboardEvent, ReactNode, RefObject } from 'react';
import { createRoot, type Root } from 'react-dom/client';

import { Icon } from '@components/ui/icon';

/**
 * ⌘F, rebuilt.
 *
 * ## Why the stock panel had to go rather than be restyled
 *
 * CodeMirror's own panel is a form of six word-buttons and three checkboxes,
 * and two of its problems are structural rather than cosmetic:
 *
 * 1. **It has nowhere to put a match count.** "2 of 7" is the single most
 *    useful thing a find bar can say and the stock DOM has no slot for it, so
 *    no amount of theming produces one.
 * 2. **It is part of the layout.** `.cm-panels` is `position: sticky` and
 *    occupies a row in the editor's flex column, so opening it pushes the
 *    document down and closing it pushes it back — the line you were reading
 *    moves twice for a search you have not run yet.
 *
 * Restyling was still the right first move for *colour*, and it happened: the
 * reason the old panel rendered white boxes on navy is that `editor-theme.ts`
 * never told CodeMirror which mode it was in, so every `&light` base rule
 * applied. That fix stands on its own and is what this panel is drawn on top
 * of. See `editor-theme.ts`.
 *
 * ## Why plain React inside a CodeMirror panel
 *
 * The panel is a `Panel`, which is an imperative `{ dom, mount, update,
 * destroy }` contract, but everything inside it is ordinary React with ordinary
 * tokens — so the glyphs come from the one icon library the app ships and the
 * colours come from `--cc-*` like every other surface. The bridge between the
 * two is {@link createSearchPanel}: CodeMirror owns the element, React owns its
 * contents, and `update()` is forwarded as a subscription rather than a re-render
 * of the whole editor.
 *
 * ## The search state is CodeMirror's, never mirrored
 *
 * Every field here is read from `getSearchQuery(view.state)` on demand and
 * written back with the `setSearchQuery` effect. Nothing about the query lives
 * in React state, which is what keeps this panel correct when the query is
 * changed from outside it — `selectNextOccurrence`, or a second panel on
 * another tab. The one piece of genuinely local state is whether the replace
 * row is open, because that is a property of this panel and of nothing else.
 */

/**
 * How many matches are counted before the number becomes "999+".
 *
 * A cap rather than a full walk, because the count runs on every document
 * change and every keystroke in the field. On a minified bundle an uncapped
 * scan is a scan of the whole file per character typed; the difference between
 * "1,284 matches" and "999+" is worth nothing and costs a frame.
 */
const MATCH_CAP = 999;

interface MatchCount {
  total: number;
  /** 1-based position of the selection within the matches, or 0 for none. */
  current: number;
  /** Whether {@link MATCH_CAP} stopped the walk early. */
  capped: boolean;
}

/**
 * Where the selection sits among the matches.
 *
 * Compared by range rather than by index because the selection is the only
 * thing that knows which match is "current", and after `findNext` wraps past
 * the end that is not the index anything else was holding.
 */
function countMatches(view: EditorView, query: SearchQuery): MatchCount {
  if (!query.valid) return { total: 0, current: 0, capped: false };

  const cursor = query.getCursor(view.state);
  const selection = view.state.selection.main;
  let total = 0;
  let current = 0;

  for (let step = cursor.next(); !step.done; step = cursor.next()) {
    total += 1;
    if (step.value.from === selection.from && step.value.to === selection.to) {
      current = total;
    }
    if (total >= MATCH_CAP) return { total, current, capped: true };
  }

  return { total, current, capped: false };
}

/** The three switches, as VS Code spells them. Text, not glyphs — they read at 10px. */
type ToggleKey = 'caseSensitive' | 'wholeWord' | 'regexp';

interface Toggle {
  key: ToggleKey;
  label: string;
  title: string;
  /** `ab` carries a rule, the way VS Code draws whole-word. */
  underline?: boolean;
}

const TOGGLES: readonly Toggle[] = [
  { key: 'caseSensitive', label: 'Aa', title: 'Match case' },
  { key: 'wholeWord', label: 'ab', title: 'Match whole word', underline: true },
  { key: 'regexp', label: '.*', title: 'Use regular expression' },
];

/**
 * The query as plain fields, so a patch stays type-checked per key.
 *
 * `SearchQuery` is immutable and its constructor takes the whole shape, so
 * every edit is a fresh one built from the current values plus the change.
 */
interface QueryFields {
  search: string;
  replace: string;
  caseSensitive: boolean;
  regexp: boolean;
  wholeWord: boolean;
  literal: boolean;
}

interface SearchPanelProps {
  view: EditorView;
  /** Fires whenever CodeMirror hands the panel a view update. */
  subscribe: (listener: () => void) => () => void;
}

function SearchPanel({ view, subscribe }: SearchPanelProps) {
  const [, forceRender] = useState(0);
  const [showReplace, setShowReplace] = useState(false);
  const findRef = useRef<HTMLInputElement>(null);

  // CodeMirror is the source of truth; a view update is the only thing that
  // can have changed it, so that is the only thing that re-renders this.
  useEffect(
    () => subscribe(() => forceRender((tick) => tick + 1)),
    [subscribe],
  );

  const query = getSearchQuery(view.state);
  const matches = countMatches(view, query);

  const amend = useCallback(
    (patch: Partial<QueryFields>) => {
      const next = new SearchQuery({
        search: query.search,
        replace: query.replace,
        caseSensitive: query.caseSensitive,
        regexp: query.regexp,
        wholeWord: query.wholeWord,
        literal: query.literal,
        ...patch,
      });
      view.dispatch({ effects: setSearchQuery.of(next) });
    },
    [query, view],
  );

  const dismiss = useCallback(() => {
    closeSearchPanel(view);
    view.focus();
  }, [view]);

  /**
   * Enter and Escape, on the fields rather than on the panel.
   *
   * Escape has to be handled here *and* reach nothing else: `editor-pane.tsx`
   * installs a window-level Escape listener that closes the open file in
   * `single` nav mode. It bails for `HTMLInputElement`, which is exactly why
   * both fields below are real inputs rather than a styled contenteditable —
   * a div with `role="textbox"` would close the document instead of the panel.
   */
  const onFieldKey = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      dismiss();
      return;
    }
    if (event.key !== 'Enter') return;
    event.preventDefault();
    if (event.currentTarget.dataset.field === 'replace') {
      replaceNext(view);
      return;
    }
    if (event.shiftKey) findPrevious(view);
    else findNext(view);
  };

  const disabled = !query.valid;
  const counter = matches.capped
    ? `${MATCH_CAP}+`
    : matches.total === 0
      ? query.search === ''
        ? ''
        : 'No results'
      : `${matches.current || '?'} of ${matches.total}`;

  return (
    <form
      role="search"
      aria-label="Find in file"
      onSubmit={(event) => event.preventDefault()}
      className="relative flex flex-col gap-[3px] rounded-[7px] border border-border bg-panel p-1 pl-5 shadow-lg"
    >
      {/*
        The chevron is the replace row's only affordance, sitting in the gutter
        the panel's left padding reserves for it — the same place VS Code puts
        it, and the reason `find` alone is one compact row rather than two.
      */}
      <button
        type="button"
        onClick={() => setShowReplace((open) => !open)}
        aria-expanded={showReplace}
        aria-label={showReplace ? 'Hide replace' : 'Show replace'}
        className="absolute top-1/2 left-0 flex h-7 w-5 -translate-y-1/2 items-center justify-center rounded-[4px] text-subtle hover:bg-hover hover:text-muted"
      >
        <Icon name={showReplace ? 'ph-caret-down' : 'ph-caret-right'} size={10} />
      </button>

      <div className="flex items-center gap-1">
        <Field
          inputRef={findRef}
          value={query.search}
          onChange={(search) => amend({ search })}
          onKeyDown={onFieldKey}
          placeholder="Find"
          label="Find"
          field="find"
          invalid={query.search !== '' && !query.valid}
          /* CodeMirror focuses whatever carries this when the panel opens. */
          mainField
          trailing={TOGGLES.map((toggle) => (
            <button
              key={toggle.key}
              type="button"
              title={toggle.title}
              aria-label={toggle.title}
              aria-pressed={query[toggle.key]}
              onClick={() => amend({ [toggle.key]: !query[toggle.key] })}
              className={[
                'grid h-[18px] w-[18px] shrink-0 place-items-center rounded-[4px] text-[9.5px] font-semibold',
                query[toggle.key]
                  ? 'bg-active text-brand'
                  : 'text-subtle hover:bg-hover hover:text-muted',
              ].join(' ')}
            >
              <span className={toggle.underline ? 'underline' : undefined}>
                {toggle.label}
              </span>
            </button>
          ))}
        />

        <span
          aria-live="polite"
          className="shrink-0 tabular-nums whitespace-nowrap text-[11.5px] text-muted"
        >
          {counter}
        </span>

        <IconButton
          name="ph-arrow-up"
          label="Previous match"
          disabled={disabled}
          onClick={() => findPrevious(view)}
        />
        <IconButton
          name="ph-arrow-down"
          label="Next match"
          disabled={disabled}
          onClick={() => findNext(view)}
        />
        <IconButton name="ph-x" label="Close" onClick={dismiss} />
      </div>

      {showReplace ? (
        <div className="flex items-center gap-1">
          <Field
            value={query.replace}
            onChange={(replace) => amend({ replace })}
            onKeyDown={onFieldKey}
            placeholder="Replace"
            label="Replace"
            field="replace"
          />
          {/*
            "Replace next", not "Replace" — the field beside it is already
            named "Replace", and two controls in one row answering to the same
            accessible name is a row a screen reader cannot describe.
          */}
          <IconButton
            name="ph-repeat-once"
            label="Replace next"
            disabled={disabled}
            onClick={() => replaceNext(view)}
          />
          <IconButton
            name="ph-repeat"
            label="Replace all"
            disabled={disabled}
            onClick={() => replaceAll(view)}
          />
        </div>
      ) : null}
    </form>
  );
}

interface FieldProps {
  value: string;
  onChange: (value: string) => void;
  onKeyDown: (event: KeyboardEvent<HTMLInputElement>) => void;
  placeholder: string;
  label: string;
  field: 'find' | 'replace';
  inputRef?: RefObject<HTMLInputElement | null>;
  mainField?: boolean;
  invalid?: boolean;
  trailing?: ReactNode;
}

/**
 * The input and whatever rides inside it.
 *
 * Not `ui/text-field.tsx`: that atom always renders a `<label>` block above the
 * input and a hint below it, which is a settings-form layout. What is shared is
 * the thing worth sharing — the input's own class string, kept in step with it
 * by eye rather than by import, because the two have different jobs and a prop
 * to switch between them would make the atom about this panel.
 */
function Field({
  value,
  onChange,
  onKeyDown,
  placeholder,
  label,
  field,
  inputRef,
  mainField,
  invalid,
  trailing,
}: FieldProps) {
  return (
    <div
      className={[
        'flex h-[25px] min-w-0 flex-1 items-center gap-[2px] rounded-[6px] border bg-panel-2 pr-[3px] pl-2',
        'focus-within:ring-1',
        invalid
          ? 'border-red focus-within:ring-red'
          : 'border-border focus-within:border-brand focus-within:ring-brand',
      ].join(' ')}
    >
      <input
        ref={inputRef}
        data-field={field}
        aria-label={label}
        aria-invalid={invalid || undefined}
        {...(mainField ? { 'main-field': 'true' } : {})}
        value={value}
        placeholder={placeholder}
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={onKeyDown}
        className="min-w-0 flex-1 bg-transparent text-[12.5px] text-ink outline-none placeholder:text-subtle"
      />
      {trailing}
    </div>
  );
}

function IconButton({
  name,
  label,
  onClick,
  disabled,
}: {
  name: string;
  label: string;
  onClick: () => void;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      onClick={onClick}
      disabled={disabled}
      className="grid h-[21px] w-[21px] shrink-0 place-items-center rounded-[4px] text-muted hover:bg-hover hover:text-ink disabled:opacity-40 disabled:hover:bg-transparent disabled:hover:text-muted"
    >
      <Icon name={name} size={12} />
    </button>
  );
}

/**
 * The `createPanel` CodeMirror asks for.
 *
 * `top: true` is set here rather than in `search({ top })` so the panel and its
 * placement are declared in one place — the config option only sets a default
 * that this field then overrides anyway.
 *
 * The React root is torn down in a microtask. `destroy()` can be called from
 * inside CodeMirror's own update cycle, and `root.unmount()` during a React
 * render throws a warning and can drop the unmount entirely; deferring puts it
 * after the current task, which is soon enough for a panel being removed.
 */
export function createSearchPanel(view: EditorView): Panel {
  const dom = document.createElement('div');
  const listeners = new Set<() => void>();
  let root: Root | null = null;

  const subscribe = (listener: () => void): (() => void) => {
    listeners.add(listener);
    return () => listeners.delete(listener);
  };

  return {
    dom,
    top: true,
    mount() {
      root = createRoot(dom);
      root.render(<SearchPanel view={view} subscribe={subscribe} />);
    },
    update() {
      for (const listener of listeners) listener();
    },
    destroy() {
      const going = root;
      root = null;
      listeners.clear();
      queueMicrotask(() => going?.unmount());
    },
  };
}
