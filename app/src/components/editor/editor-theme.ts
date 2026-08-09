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
   */
  '.cm-selectionBackground, .cm-content ::selection': {
    backgroundColor: 'var(--cc-code-selection)',
  },
  '&.cm-focused .cm-selectionBackground, &.cm-focused .cm-content ::selection': {
    backgroundColor: 'var(--cc-code-selection)',
  },
  '.cm-activeLine': {
    backgroundColor: 'var(--cc-code-active-line)',
  },
  '.cm-gutters': {
    backgroundColor: 'var(--cc-panel-2)',
    color: 'var(--cc-subtle)',
    border: 'none',
    borderRight: '1px solid var(--cc-border-soft)',
  },
  '.cm-activeLineGutter': {
    backgroundColor: 'var(--cc-code-active-line)',
    color: 'var(--cc-muted)',
  },
  '.cm-foldPlaceholder': {
    backgroundColor: 'var(--cc-chip)',
    color: 'var(--cc-muted)',
    border: 'none',
  },
  '.cm-panels': {
    backgroundColor: 'var(--cc-panel)',
    color: 'var(--cc-ink)',
  },
  '.cm-searchMatch': {
    backgroundColor: 'var(--cc-active)',
    outline: '1px solid var(--cc-border)',
  },
  '.cm-searchMatch.cm-searchMatch-selected': {
    backgroundColor: 'var(--cc-brand-fill)',
    color: 'var(--cc-on-brand)',
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
