import {
  defaultKeymap,
  history,
  historyKeymap,
  indentWithTab,
} from '@codemirror/commands';
import {
  bracketMatching,
  foldGutter,
  indentUnit,
  type LanguageSupport,
} from '@codemirror/language';
import {
  highlightSelectionMatches,
  search,
  searchKeymap,
} from '@codemirror/search';
import { Compartment, EditorState, type Extension } from '@codemirror/state';
import {
  EditorView,
  drawSelection,
  highlightActiveLine,
  highlightActiveLineGutter,
  keymap,
  lineNumbers as lineNumbersExt,
  rectangularSelection,
} from '@codemirror/view';
import { useEffect, useRef } from 'react';

import { editorHighlight, editorTheme } from '@components/editor/editor-theme';
import { createSearchPanel } from '@components/editor/search-panel';

/**
 * The CodeMirror surface — **the editor seam**.
 *
 * The same discipline `components/terminal/` follows, and enforced the same
 * way: an ESLint zone forbids `features/`, `data/` and `stores/`, so this
 * component knows its props and nothing about the app around it. The
 * composition root reads the stores and passes values down, exactly as it
 * already does for terminal appearance.
 *
 * ## One view, one state per file
 *
 * Cursor position, scroll offset and undo history all live in an `EditorState`.
 * Keeping one per open file and calling `view.setState` on a tab switch
 * restores all three; rebuilding the view per file would throw them away and
 * remount the DOM on every click.
 *
 * ## Why configuration changes clear the cache
 *
 * Extensions are baked into an `EditorState` at construction. Compartments
 * could reconfigure the *live* state in place, but the cached states for the
 * other open files would keep the old configuration and adopt it the moment
 * they were switched to — a font size that changes when you click between tabs.
 *
 * So a configuration change drops every cached state and rebuilds the active
 * one. The cost is the undo history of files that are open but not on screen,
 * on an action that happens in a settings pane. That is the right trade in the
 * direction that keeps the editor consistent.
 */

export interface EditorSurfaceProps {
  /** Which file this content belongs to. Changing it swaps states. */
  fileKey: string;
  value: string;
  /**
   * The language to load, or `null` for plain text.
   *
   * A loader rather than a resolved `LanguageSupport`, so every CodeMirror
   * import stays inside this directory — including the seventeen dynamic ones.
   * The parent decides *which* language; it never has to hold one.
   */
  languageLoad: (() => Promise<LanguageSupport>) | null;
  readOnly: boolean;
  fontFamily: string;
  fontSize: number;
  wordWrap: boolean;
  lineNumbers: boolean;
  tabWidth: number;
  onChange: (text: string) => void;
  /** ⌘S / Ctrl+S. Bound here so it fires even while the editor holds focus. */
  onSave: () => void;
}

/** The compartment the lazily-loaded grammar lands in. */
const languageCompartment = new Compartment();

/**
 * How many files' states and grammars to keep.
 *
 * The caches are keyed by file and this component never learns that a tab was
 * closed — it only ever sees the file it is currently showing. Without a bound,
 * a long session that opened a hundred files would hold a hundred documents and
 * their undo histories forever. Twelve is well past any realistic set of tabs,
 * so the eviction never fires in normal use; it exists so the growth is bounded
 * rather than unbounded.
 */
const CACHE_LIMIT = 12;

/** Evict oldest-first until the map fits, never dropping the active entry. */
function trim<T>(cache: Map<string, T>, keep: string | null): void {
  for (const key of cache.keys()) {
    if (cache.size <= CACHE_LIMIT) return;
    if (key === keep) continue;
    cache.delete(key);
  }
}

export function EditorSurface({
  fileKey,
  value,
  languageLoad,
  readOnly,
  fontFamily,
  fontSize,
  wordWrap,
  lineNumbers,
  tabWidth,
  onChange,
  onSave,
}: EditorSurfaceProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const statesRef = useRef(new Map<string, EditorState>());
  const activeKeyRef = useRef<string | null>(null);

  /**
   * Grammars that have already resolved, by file key.
   *
   * **Load-bearing, not a cache for speed.** A new `EditorState` is built with
   * whatever the compartment is given at construction, and the language arrives
   * asynchronously *after* that — so without somewhere to remember it, every
   * rebuild would drop the grammar back to plain text. Rebuilds are not rare:
   * the watcher's silent reload changes `value`, which is the feature's headline
   * case. Highlighting used to disappear the first time an agent touched the
   * open file.
   */
  const grammarsRef = useRef(new Map<string, LanguageSupport>());

  /**
   * Callbacks through refs, read at dispatch time.
   *
   * An extension holds whatever closure it was built with, so a changed
   * `onChange` would otherwise need the state rebuilt — and rebuilding on a
   * prop that changes every render is a remount loop. The ref is read inside
   * the listener, so the extension is built once and always calls the current
   * function.
   */
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  const onSaveRef = useRef(onSave);
  onSaveRef.current = onSave;

  /**
   * Everything that must be baked into a state, as one string.
   *
   * When it changes, the cache is dropped and states are rebuilt. `fileKey` is
   * deliberately absent: switching files must reuse a cached state, not
   * invalidate every other one.
   */
  const configKey = [
    readOnly,
    fontFamily,
    fontSize,
    wordWrap,
    lineNumbers,
    tabWidth,
  ].join('|');

  /**
   * The configuration the cached states were built with.
   *
   * Compared inside the effect rather than handled by a second effect with
   * `[configKey]` as its dependency. A separate effect runs *after* this one,
   * so the active state would already have been restored from the stale cache
   * by the time the cache was cleared — and a font or read-only change would
   * apply to every file except the one on screen.
   */
  const configRef = useRef(configKey);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    const view = new EditorView({ parent: host });
    viewRef.current = view;

    // Captured now rather than read in the cleanup: the ref's identity is
    // stable, but the lint rule cannot know that and the copy costs nothing.
    const states = statesRef.current;
    const grammars = grammarsRef.current;

    return () => {
      view.destroy();
      viewRef.current = null;
      activeKeyRef.current = null;
      states.clear();
      grammars.clear();
    };
  }, []);

  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;

    const extensions: Extension[] = [
      history(),
      drawSelection(),
      rectangularSelection(),
      highlightActiveLine(),
      highlightSelectionMatches(),
      /*
        Called explicitly, which it never was before. `searchKeymap`
        alone appends the extension on first ⌘F, so the panel used to arrive
        with stock DOM at the bottom of the editor and no way to configure it.
        Naming it here is what makes `createPanel` reachable at all.
      */
      search({ createPanel: createSearchPanel }),
      bracketMatching(),
      editorTheme,
      editorHighlight,
      /*
        Seeded from what has already resolved for this file, not empty. A
        rebuild that dropped to `[]` would un-highlight the document until the
        loader happened to run again — and on a silent reload it never would,
        because `languageLoad` and `fileKey` are both unchanged.
      */
      languageCompartment.of(grammarsRef.current.get(fileKey) ?? []),
      EditorState.readOnly.of(readOnly),
      /**
       * `readOnly` alone leaves a blinking cursor in a document that swallows
       * every keystroke, which reads as a hung editor rather than a read-only
       * one. `editable` is what removes `contenteditable` and the caret with
       * it. The terminal seam had to learn this same lesson — see the
       * `readOnly` note in `center-stage.tsx`.
       */
      EditorView.editable.of(!readOnly),
      EditorView.theme({
        '&': { fontSize: `${fontSize}px` },
        '.cm-content, .cm-gutters': { fontFamily },
      }),
      indentUnit.of(' '.repeat(tabWidth)),
      EditorState.tabSize.of(tabWidth),
      keymap.of([
        {
          key: 'Mod-s',
          run: () => {
            onSaveRef.current();
            // Handled: returning false would let the browser's Save dialog open
            // on top of an Electron window, which is never what ⌘S means here.
            return true;
          },
        },
        ...defaultKeymap,
        ...historyKeymap,
        ...searchKeymap,
        indentWithTab,
      ]),
      EditorView.updateListener.of((update) => {
        if (activeKeyRef.current) {
          // Cache the live state so a tab switch and back restores the caret.
          statesRef.current.set(activeKeyRef.current, update.state);
        }
        if (update.docChanged) {
          onChangeRef.current(update.state.doc.toString());
        }
      }),
    ];

    if (lineNumbers) {
      extensions.push(lineNumbersExt(), highlightActiveLineGutter(), foldGutter());
    }
    if (wordWrap) {
      extensions.push(EditorView.lineWrapping);
    }

    /**
     * A configuration change invalidates **every** cached state, the active one
     * included. Extensions are baked in at construction, so a state built with
     * the old font would keep it — and be adopted the moment it was switched to.
     */
    const configChanged = configRef.current !== configKey;
    if (configChanged) {
      statesRef.current.clear();
      configRef.current = configKey;
    }

    const cached = configChanged ? undefined : statesRef.current.get(fileKey);

    /**
     * Reuse the cached state only when its document still matches what the
     * store holds.
     *
     * A mismatch means the file was reloaded underneath the buffer — the
     * watcher's silent-reload path — and the cached state is describing text
     * that no longer exists. Rebuilding loses the caret, which is the correct
     * outcome: the line it was on may not be there any more.
     */
    if (cached && cached.doc.toString() === value) {
      if (view.state !== cached) view.setState(cached);
      activeKeyRef.current = fileKey;
      return;
    }

    /**
     * Nothing to do when the live view already holds this exact text for this
     * exact file. Without this guard, every keystroke would rebuild the state
     * from the value it just produced and put the caret back at the start.
     */
    if (
      !configChanged &&
      activeKeyRef.current === fileKey &&
      view.state.doc.toString() === value
    ) {
      return;
    }

    const state = EditorState.create({ doc: value, extensions });
    statesRef.current.set(fileKey, state);
    trim(statesRef.current, fileKey);
    activeKeyRef.current = fileKey;
    view.setState(state);
  }, [fileKey, value, configKey, readOnly, fontFamily, fontSize, wordWrap, lineNumbers, tabWidth]);

  /**
   * The grammar, once its chunk arrives.
   *
   * Reconfigured into the live view rather than baked into the state, because
   * it resolves a tick *after* the document is already on screen — which is the
   * whole point of loading it lazily. `cancelled` guards the ordinary race:
   * click a `.ts` file, click a `.py` file before the first import settles, and
   * without it the TypeScript grammar lands in the Python document.
   */
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;

    if (!languageLoad) {
      grammarsRef.current.delete(fileKey);
      view.dispatch({ effects: languageCompartment.reconfigure([]) });
      return;
    }

    // Already resolved for this file — the state was built with it, so there is
    // nothing to dispatch and nothing to await.
    if (grammarsRef.current.has(fileKey)) return;

    let cancelled = false;
    void languageLoad().then((support) => {
      if (cancelled || !viewRef.current) return;
      grammarsRef.current.set(fileKey, support);
      trim(grammarsRef.current, fileKey);
      viewRef.current.dispatch({
        effects: languageCompartment.reconfigure(support),
      });
    });

    return () => {
      cancelled = true;
    };
  }, [languageLoad, fileKey]);

  return <div ref={hostRef} className="min-h-0 flex-1 overflow-hidden" />;
}
