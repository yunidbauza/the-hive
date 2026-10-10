import type { InlineTag } from '@lib/markdown/model';

/**
 * Raw HTML inside markdown, decided tag by tag.
 *
 * A security predicate. The preview never hands a string to the DOM as markup;
 * this scanner only splits HTML into pieces so the converters can map a short
 * allowlist (`details`, `summary`, `br`, `kbd`, `sub`, `sup`, and `img` as a
 * placeholder) to model nodes, and show everything else — `<script>`, `on*=`
 * attributes, `<a href="javascript:…">` — as its own literal text. No
 * attribute survives except `open` on `details`, read by the block converter.
 */
export type HtmlPiece =
  | { kind: 'open'; tag: string; attrs: string; raw: string; selfClosing: boolean }
  | { kind: 'close'; tag: string; raw: string }
  | { kind: 'comment' }
  | { kind: 'text'; text: string };

/**
 * One piece: a comment (`<!-->` and `<!--->` included, as marked reads them), a
 * close tag, an open tag, a run of text, or a stray `<`.
 *
 * The open tag's attribute run is quote-aware, so `alt=">"` does not end the
 * tag, and no two parts of it can share more than the one optional `/` — the version
 * that let the attribute run and a trailing `\s*` share whitespace backtracked
 * quadratically, and this runs on an untrusted file on the renderer's thread.
 */
const PIECE =
  /<!--(?:-?>|[\s\S]*?-->)|<\/([a-zA-Z][\w-]*)\s*>|<([a-zA-Z][\w-]*)((?:\s(?:[^<>"']|"[^"]*"|'[^']*')*)?)(\/?)>|[^<]+|</g;

export function scanHtml(html: string): HtmlPiece[] {
  const pieces: HtmlPiece[] = [];
  for (const match of html.matchAll(PIECE)) {
    const [raw, closeTag, openTag, attrs = '', slash] = match;
    if (raw.startsWith('<!--')) pieces.push({ kind: 'comment' });
    else if (closeTag) pieces.push({ kind: 'close', tag: closeTag.toLowerCase(), raw });
    else if (openTag) {
      // `<br/>` and `<br />`: the slash is the last thing in the attribute run.
      const selfClosing = slash === '/' || /\/\s*$/.test(attrs);
      pieces.push({ kind: 'open', tag: openTag.toLowerCase(), attrs, raw, selfClosing });
    } else pieces.push({ kind: 'text', text: raw });
  }
  return pieces;
}

/**
 * How deep raw-HTML tags may nest in the model — `<kbd>` inside `<kbd>`,
 * `<details>` inside `<details>`. The preview renders the model recursively,
 * and 5000 nested `<kbd>` in a README overflowed React's stack; with no error
 * boundary that blanks the whole app. Past the cap an opening tag is kept as
 * its own literal text. Thirty-two is far past anything a document means.
 */
export const MAX_HTML_NESTING = 32;

export const isInlineTag = (tag: string): tag is InlineTag =>
  tag === 'kbd' || tag === 'sub' || tag === 'sup';

/** One attribute: a name, then optionally a double-, single- or un-quoted value. */
const ATTRIBUTE = /([^\s"'=<>/]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;

/**
 * An `<img>`'s `src` and `alt`, for the placeholder chip. Nothing is fetched.
 *
 * Attributes are read one by one, so `data-src=` and a `src=` inside another
 * attribute's value are never mistaken for the real one. The first wins.
 */
export function imgAttributes(attrs: string): { src: string; alt: string } {
  const found: Record<string, string> = {};
  for (const [, name = '', double, single, bare] of attrs.matchAll(ATTRIBUTE)) {
    const key = name.toLowerCase();
    if ((key === 'src' || key === 'alt') && !(key in found)) {
      found[key] = double ?? single ?? bare ?? '';
    }
  }
  return { src: found.src ?? '', alt: found.alt ?? '' };
}

/** Whether a tag carries attribute `name` itself — not `data-name`, not inside a value. */
export function hasAttribute(attrs: string, name: string): boolean {
  for (const [, attribute = ''] of attrs.matchAll(ATTRIBUTE)) {
    if (attribute.toLowerCase() === name) return true;
  }
  return false;
}
