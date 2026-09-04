import { HighlightStyle, syntaxHighlighting } from '@codemirror/language';
import type { Extension } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { tags } from '@lezer/highlight';

/**
 * The editor's colour, expressed entirely in `--cc-*` tokens.
 *
 * **This is the thing xterm cannot do**, and it is worth being explicit about
 * because `AGENTS.md` records the opposite conclusion for the terminal. xterm
 * resolves colour from a JS `theme` object and paints into markup it owns, so a
 * custom property has no path to a terminal cell — hence `ansi.ts`. CodeMirror
 * themes are CSS-in-JS that emit real stylesheet rules, so `var(--cc-…)` is
 * resolved by the browser at paint time like any other declaration.
 *
 * The consequence is the point: **there is no dark theme and no light theme
 * here.** There is one theme, and `body[data-theme="light"]` re-points the
 * variables underneath it. Switching themes repaints the editor without
 * reconstructing it, without a re-render, and without this module knowing that
 * more than one theme exists.
 *
 * No hex literal appears in this file, and none should — a colour that is
 * missing is a token to add in `tokens.css`, not a value to inline.
 */

/**
 * Font family and size are **not** here.
 *
 * They come from the appearance store and change independently of colour, so
 * they are applied as their own extension in `editor-surface.tsx`. Folding them
 * in would mean rebuilding the colour theme every time the user nudged the size.
 */
export const editorTheme: Extension = EditorView.theme({
  '&': {
    color: 'var(--cc-ink)',
    backgroundColor: 'var(--cc-panel-2)',
    height: '100%',
  },
  '.cm-content': {
    caretColor: 'var(--cc-brand)',
    padding: '10px 0',
  },
  '.cm-scroller': {
    // The line height is unitless so it scales with whatever size the user set.
    lineHeight: '1.55',
  },
  '&.cm-focused': {
    // The stage already frames the editor; a second focus ring inside it reads
    // as a nested control rather than as the document surface.
    outline: 'none',
  },
  '.cm-cursor, .cm-dropCursor': {
    borderLeftColor: 'var(--cc-brand)',
  },
  /**
   * `::selection` and `.cm-selectionBackground` both, and both need the
   * `&.cm-focused` variants.
   *
   * CodeMirror draws its own selection layer when it can and falls back to the
   * native one otherwise; styling only one leaves the selection invisible in
   * whichever mode the browser chose. This is the single most common way a
   * CodeMirror theme ends up looking broken.
   *
   * ## Why the focused rule is spelled out the long way
   *
   * Because the short way loses. The base theme styles the focused selection at
   *
   * ```
   * &light.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground
   * ```
   *
   * which is five classes, and this asked with two (`&.cm-focused
   * .cm-selectionBackground`). Specificity settles it before load order ever
   * gets a say, so every selection in this app painted in CodeMirror's stock
   * lavender `#d7d4f0` — a colour chosen for a light editor, sitting under dark
   * syntax colours, on a theme that had carefully defined its own and never got
   * to use it. Matching the base theme's own selector shape is what makes the
   * token reach the screen.
   *
   * Do not "simplify" these back to `&.cm-focused .cm-selectionBackground`.
   * `tests/e2e/electron/project-explorer.spec.ts` reads the painted colour back
   * off a real selection and fails if it is not this token's.
   */
  '.cm-selectionLayer .cm-selectionBackground, .cm-content ::selection': {
    backgroundColor: 'var(--cc-code-selection)',
  },
  '&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground': {
    backgroundColor: 'var(--cc-code-selection)',
  },
  '&.cm-focused .cm-content ::selection': {
    backgroundColor: 'var(--cc-code-selection)',
  },
  /**
   * The active line is **mixed down to 35%**, and that is load-bearing.
   *
   * `drawSelection` paints the selection into a layer at `z-index: -2`, behind
   * the content, while this is a background on `.cm-line`, which is *in* the
   * content. `highlightActiveLine` marks the line holding each range's `head`
   * whether or not the range is empty — read `activeLineHighlighter` in
   * `@codemirror/view`, which never asks — so the caret's line is the active
   * line **during** a selection.
   *
   * Opaque, this therefore painted over the selection on the one line that
   * matters: the line a double-clicked word is on, and the line a drag that
   * stays within one line is on. The selection was there the whole time and
   * nothing showed it, which reads as an editor that ignores the mouse.
   * CodeMirror's own defaults are `#cceeff44` and `#99eeff33` for this reason.
   *
   * Mixed here rather than baked into the token because a **user theme**
   * supplies this colour too (`syntax.activeLine`, written into the variable
   * by `lib/theme/apply.ts`). An alpha in `tokens.css` would protect the
   * built-in themes and leave every custom one with the bug.
   */
  '.cm-activeLine': {
    backgroundColor: 'color-mix(in srgb, var(--cc-code-active-line) 35%, transparent)',
  },
  '.cm-gutters': {
    backgroundColor: 'var(--cc-panel-2)',
    color: 'var(--cc-subtle)',
    border: 'none',
    borderRight: '1px solid var(--cc-border-soft)',
  },
  /*
    The same mix as the line it sits beside, so the band reads as one strip
    across the gutter and the document rather than two shades meeting at the
    gutter border. Nothing is drawn under the gutter, so the transparency buys
    nothing here — matching the line is the whole reason for it.
  */
  '.cm-activeLineGutter': {
    backgroundColor: 'color-mix(in srgb, var(--cc-code-active-line) 35%, transparent)',
    color: 'var(--cc-muted)',
  },
  '.cm-foldPlaceholder': {
    backgroundColor: 'var(--cc-chip)',
    color: 'var(--cc-muted)',
    border: 'none',
  },
  /**
   * The panel host stops being a bar and becomes an overlay.
   *
   * CodeMirror's own rule is `position: sticky; left: 0; right: 0`, which makes
   * the panel a **row in the editor's flex column** — so opening ⌘F pushed the
   * document down and closing it pushed it back, and the line you were reading
   * moved twice for a search you had not run yet. Going absolute takes it out
   * of flow entirely; `.cm-editor` already carries `position: relative
   * !important`, so there is nothing to add on the host to anchor it.
   *
   * Everything visible — the card, its border, its shadow — belongs to
   * `search-panel.tsx`. This host is deliberately left transparent and
   * borderless so it contributes nothing but a coordinate space, and
   * `width: auto` is what stops a full-width strip from swallowing clicks
   * across the whole top of the document.
   */
  '.cm-panels': {
    position: 'absolute',
    left: 'auto',
    width: 'auto',
    maxWidth: '100%',
    backgroundColor: 'transparent',
    color: 'var(--cc-ink)',
    border: 'none',
  },
  '.cm-panels.cm-panels-top': {
    top: 0,
    right: 0,
    borderBottom: 'none',
  },
  '.cm-panels.cm-panels-bottom': {
    bottom: 0,
    right: 0,
    borderTop: 'none',
  },
  '.cm-searchMatch': {
    backgroundColor: 'var(--cc-active)',
    outline: '1px solid var(--cc-border)',
  },
  '.cm-searchMatch.cm-searchMatch-selected': {
    backgroundColor: 'var(--cc-brand-fill)',
    color: 'var(--cc-on-brand)',
  },
  /**
   * `highlightSelectionMatches()` ships `#99ff7780` — a bright green — and it
   * is **not** behind a `&light`/`&dark` variant, so no amount of telling
   * CodeMirror which mode it is in would have reached it. It is the one search
   * colour that had to be named here explicitly.
   *
   * Quieter than `.cm-searchMatch` on purpose: these are matches of whatever
   * the caret happens to be sitting on, which the user did not ask for, and
   * they must not compete with the matches of a query the user typed.
   */
  '.cm-selectionMatch': {
    backgroundColor: 'var(--cc-code-selection)',
  },
  '.cm-selectionMatch.cm-selectionMatch-main': {
    backgroundColor: 'transparent',
  },
});

/**
 * Lezer tags → the nine roles in `tokens.css`.
 *
 * Grouped rather than enumerated: `tags.keyword` covers `if`, `class` and
 * `import` across every grammar, which is why nine roles are enough for
 * seventeen languages. A per-language style would be seventeen files to keep
 * consistent and would still look like one editor only by coincidence.
 */
export const editorHighlight = syntaxHighlighting(
  HighlightStyle.define([
    { tag: [tags.keyword, tags.moduleKeyword], color: 'var(--cc-code-keyword)' },
    {
      tag: [tags.controlKeyword, tags.operatorKeyword],
      color: 'var(--cc-code-keyword)',
    },
    {
      tag: [tags.string, tags.special(tags.string), tags.regexp],
      color: 'var(--cc-code-string)',
    },
    { tag: [tags.number, tags.bool, tags.null], color: 'var(--cc-code-number)' },
    {
      tag: [tags.comment, tags.lineComment, tags.blockComment, tags.docComment],
      color: 'var(--cc-code-comment)',
      fontStyle: 'italic',
    },
    {
      tag: [tags.function(tags.variableName), tags.function(tags.propertyName)],
      color: 'var(--cc-code-name)',
    },
    {
      tag: [tags.typeName, tags.className, tags.namespace, tags.tagName],
      color: 'var(--cc-code-type)',
    },
    {
      tag: [tags.operator, tags.punctuation, tags.separator, tags.bracket],
      color: 'var(--cc-code-operator)',
    },
    {
      tag: [tags.constant(tags.variableName), tags.standard(tags.variableName)],
      color: 'var(--cc-code-constant)',
    },
    { tag: [tags.attributeName, tags.propertyName], color: 'var(--cc-code-name)' },
    { tag: tags.invalid, color: 'var(--cc-code-invalid)' },
    /**
     * Markdown's structural tags, which otherwise render as plain text.
     *
     * Included because `AGENTS.md`, `README.md` and the spec files are among
     * the most-opened documents in this repository, and a markdown file with no
     * visible heading structure is the one case where "unhighlighted is fine"
     * stops being true.
     */
    { tag: tags.heading, color: 'var(--cc-code-name)', fontWeight: '600' },
    { tag: tags.link, color: 'var(--cc-code-type)', textDecoration: 'underline' },
    { tag: tags.emphasis, fontStyle: 'italic' },
    { tag: tags.strong, fontWeight: '600' },
  ]),
);
