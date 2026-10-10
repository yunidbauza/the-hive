/**
 * What a link in a previewed markdown file may do.
 *
 * A security predicate: the file is written by whoever can push to the repo,
 * and the preview renders in the app's own document. Only `http` and `https`
 * become navigable anchors — exactly the schemes main's `isSafeExternalUrl`
 * opens, so no anchor here is one main would then silently refuse. A relative
 * path is a request to main, which decides through `fs:resolve` whether it
 * names a file in the project. Every other scheme, protocol-relative `//host`
 * (and the `\\host` and `/\host` a browser reads the same way) included,
 * renders as plain text.
 *
 * A control character anywhere refuses the link: a browser strips tabs,
 * newlines and leading C0 controls from a URL, so `java\tscript:` is
 * `javascript:` to it while failing the scheme check here.
 */
export type HrefKind =
  | { kind: 'anchor'; id: string }
  | { kind: 'relative'; path: string; fromRoot: boolean }
  | { kind: 'external'; url: string }
  | { kind: 'refused' };

export type RelativeHref = Extract<HrefKind, { kind: 'relative' }>;

const REFUSED: HrefKind = { kind: 'refused' };
const SCHEME = /^([a-zA-Z][a-zA-Z0-9+.-]*):/;
const EXTERNAL_SCHEMES = new Set(['http', 'https']);

/** C0 and C1 controls, DEL included. */
const hasControl = (text: string): boolean => {
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    if (code <= 0x1f || (code >= 0x7f && code <= 0x9f)) return true;
  }
  return false;
};

/** `//host`, `\\host`, `/\host`: all protocol-relative to a browser. */
const PROTOCOL_RELATIVE = /^[/\\]{2}/;

const decode = (text: string): string | null => {
  try {
    return decodeURIComponent(text);
  } catch {
    return null;
  }
};

export function classifyHref(href: string): HrefKind {
  const value = href.trim();
  if (value === '' || PROTOCOL_RELATIVE.test(value) || hasControl(value)) return REFUSED;

  if (value.startsWith('#')) {
    const id = decode(value.slice(1));
    return id && !hasControl(id) ? { kind: 'anchor', id } : REFUSED;
  }

  const scheme = SCHEME.exec(value)?.[1]?.toLowerCase();
  if (scheme !== undefined) {
    if (!EXTERNAL_SCHEMES.has(scheme)) return REFUSED;
    try {
      return { kind: 'external', url: new URL(value).href };
    } catch {
      return REFUSED;
    }
  }

  const path = decode(value.split(/[?#]/, 1)[0] ?? '');
  if (!path || hasControl(path)) return REFUSED;
  return path.startsWith('/')
    ? { kind: 'relative', path: path.replace(/^\/+/, ''), fromRoot: true }
    : { kind: 'relative', path, fromRoot: false };
}
