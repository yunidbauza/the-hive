import { session } from 'electron';

/**
 * Content Security Policy (story 082).
 *
 * Applied via `onHeadersReceived` on the session, **not only** as a `<meta>`
 * tag — a meta tag does not cover every load path, and the one it misses is the
 * one that matters.
 */

/**
 * `style-src 'unsafe-inline'` is required and is the one concession: xterm
 * writes inline styles for cell colours, and Tailwind v4 injects a style
 * element. Every other directive is closed.
 *
 * `connect-src 'self'` matters more than it looks — it is what stops rendered
 * terminal content from becoming an exfiltration path. Terminal output is
 * untrusted, it renders in this document, and without this directive a crafted
 * escape sequence or link has somewhere to send what it can read.
 */
export const PRODUCTION_CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  /**
   * The splash's sprite, and the only reason this directive exists.
   *
   * `data:` is not a convenience here. The splash keys the video's white ground
   * away on a canvas, and `getImageData` throws `SecurityError` once a canvas
   * has drawn a `file://` resource — which is how the packaged app loads its
   * renderer. So the mp4 is inlined as a `data:` URI, which is same-origin and
   * never taints, and this directive is what admits it. Without the line the
   * fallback GIF would carry every launch and nobody would know why.
   *
   * Narrow on purpose: `data:` media is a local literal in our own bundle, it
   * cannot be a network fetch, and `connect-src` — the directive that actually
   * governs exfiltration — is untouched.
   */
  "media-src 'self' data:",
  "font-src 'self' data:",
  "connect-src 'self'",
  "object-src 'none'",
  "frame-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
].join('; ');

/**
 * The dev relaxation, and only what dev actually needs.
 *
 * Vite serves the renderer over http and pushes HMR updates over a websocket,
 * so `connect-src` has to admit the dev origin and `ws:`. `script-src` gains
 * `'unsafe-inline'` for the injected HMR client.
 *
 * Deliberately still no `'unsafe-eval'` and no wildcard host: a dev policy that
 * is simply "everything" trains you to develop against rules the shipped app
 * does not have, and the divergence surfaces as a bug in production only.
 */
export const DEVELOPMENT_CSP = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  /** Same as production — the splash is identical in both. */
  "media-src 'self' data:",
  "font-src 'self' data:",
  "connect-src 'self' ws: http://localhost:* http://127.0.0.1:*",
  "object-src 'none'",
  "frame-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
].join('; ');

/** Dev is defined by electron-vite having set a renderer URL — nothing else. */
export const isDevRenderer = (env: NodeJS.ProcessEnv = process.env): boolean =>
  Boolean(env.ELECTRON_RENDERER_URL);

export const cspFor = (dev: boolean): string =>
  dev ? DEVELOPMENT_CSP : PRODUCTION_CSP;

/**
 * Attach the policy to every response on the default session.
 *
 * Existing CSP headers are *replaced*, not appended to: two CSP headers
 * intersect, so a stray permissive one cannot loosen this, but a stray
 * restrictive one could break the app in ways that look random.
 */
export function installContentSecurityPolicy(dev = isDevRenderer()): void {
  const policy = cspFor(dev);
  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    const headers = { ...details.responseHeaders };
    for (const key of Object.keys(headers)) {
      if (key.toLowerCase() === 'content-security-policy') delete headers[key];
    }
    callback({
      responseHeaders: { ...headers, 'Content-Security-Policy': [policy] },
    });
  });
}
