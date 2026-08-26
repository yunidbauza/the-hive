/**
 * Opening a link that appeared in terminal output.
 *
 * ## The bug this module exists to fix
 *
 * xterm finds the URL perfectly well — the web-links addon registers the range
 * and the click reaches a handler. The handler it *ships with* is what fails,
 * and its first line is the whole story:
 *
 * ```js
 * function handleLink(event, uri) {
 *   const win = window.open();          // ← no url, ever
 *   if (win) { win.opener = null; win.location.href = uri; }
 *   else console.warn('Opening link blocked as opener could not be cleared');
 * }
 * ```
 *
 * It opens a blank window first so it can null the `opener` before navigating —
 * a defence against reverse tabnabbing that predates `noopener`. In a browser
 * that works. In this app it cannot: `applyWebContentsPolicy` in
 * `electron/main/window.ts` denies **every** `window.open` and re-routes the URL
 * to the OS browser instead, and the URL it is handed here is `about:blank`.
 * `isSafeExternalUrl` rejects that, the window is denied, `window.open()`
 * returns `null`, and the click dies in a `console.warn` nobody will ever see.
 *
 * xterm's own OSC 8 handler (`OscLinkProvider`) has the same shape with a
 * `confirm()` in front of it, so an explicit hyperlink — the `⧉ artifact` chip
 * Claude Code emits — asks the user to accept a scary warning and *then* fails
 * the same way.
 *
 * ## The fix
 *
 * Pass the URL to `window.open`, which is what every other outbound link in the
 * app already does (`pr-card.tsx`, and every `<a target="_blank">`). Main
 * intercepts it, checks the scheme against its allowlist, and hands it to the
 * OS. `noopener,noreferrer` covers what the blank-window dance was for.
 *
 * ## Why this is a module and not two lines inline
 *
 * `src/components/terminal/**` may not import from `features/`, `data/` or
 * `stores/` — the seam that lets the transport become IPC without touching the
 * component tree. `lib/` is on the allowed side of that fence, so the handler
 * can be unit-tested against a stubbed `window.open` without rendering a
 * terminal, which is the one assertion that actually distinguishes the fix from
 * the bug: **the first argument is the URL**.
 *
 * No scheme check happens here. Main is the security boundary
 * (`electron/main/external-links.ts`), it is the only side that can be trusted
 * to be one, and a second copy of the allowlist in the renderer would be a
 * second definition of "safe" — which is how the two come to disagree.
 *
 * ## What replacing the confirm dialog costs, stated plainly
 *
 * xterm's OSC 8 default put a `confirm()` in front of every hyperlink, and that
 * dialog was the only place the **actual target** appeared. OSC 8 lets a program
 * render arbitrary display text over an arbitrary URL, and terminal output is
 * untrusted input, so removing the dialog removes the user's one chance to see
 * that `⧉ the docs` points somewhere else.
 *
 * Kept anyway, deliberately. The dialog did not work — `window.open()` failed
 * immediately after it, so its whole contribution was a scary warning followed
 * by nothing — and a security control that never completes teaches users to
 * click through warnings. What bounds the residual risk is main's allowlist:
 * only `http:` and `https:` ever reach `shell.openExternal`, so the worst case
 * is a link to an unexpected web page, not a custom scheme handing a string to
 * some other installed application. That is phishing-shaped rather than
 * RCE-shaped, and it is the same exposure every `<a target="_blank">` in this
 * app already carries.
 *
 * The thing that would genuinely recover it is a hover affordance showing the
 * real URL before the click. That is a rendering concern rather than a handler
 * one — xterm's `linkHandler` takes `hover`/`leave` callbacks and the surface
 * would have to own a tooltip — and it is recorded here as the next step rather
 * than half-built.
 */

/** Open `uri` in the user's browser. Main decides whether it may be opened. */
export function openTerminalLink(uri: string): void {
  window.open(uri, '_blank', 'noopener,noreferrer');
}

/**
 * The handler shape the web-links addon takes: `(event, uri)`.
 *
 * The event is ignored. xterm only invokes this for a click that did not drag,
 * so a text selection that happens to cross a URL never opens anything, and
 * there is no modifier to check — HIVE decided on a plain click, matching the
 * OSC 8 chip that already behaves that way and iTerm2's default.
 */
export function handleWebLink(_event: MouseEvent, uri: string): void {
  openTerminalLink(uri);
}

/**
 * The same behaviour as xterm's `linkHandler` option, which is what **OSC 8**
 * hyperlinks resolve through — a different code path from the addon above, and
 * one that would otherwise keep xterm's built-in `confirm()`.
 *
 * Shaped as an object literal rather than typed against `ILinkHandler` so this
 * module stays free of an xterm import; the surface passes it straight into the
 * `Terminal` options, where the real type is checked.
 */
export const terminalLinkHandler = {
  activate: (_event: MouseEvent, text: string): void => {
    openTerminalLink(text);
  },
};
