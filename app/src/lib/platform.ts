/**
 * Which OS the renderer is painting on.
 *
 * Extracted from `lib/terminal/keymap.ts`, where it originally lived because
 * the only question that needed it was which modifier the back chord takes. It
 * has a second caller now — `components/layout/title-bar.tsx`, which exists
 * only on macOS — and a layout component reaching into a *terminal keymap* to
 * ask what platform it is on would be a dependency that says nothing true
 * about either module.
 */

/**
 * macOS, by the only signal available in a sandboxed renderer.
 *
 * Not `window.hive.appInfo()`, which knows `process.platform` exactly but is
 * asynchronous and desktop-only. Two callers rule it out: a key handler cannot
 * await, and a title bar that learned its own height one tick late would paint
 * a visible layout shift on every cold start. The browser target needs an
 * answer too, and has no bridge to ask.
 *
 * `navigator.platform` is deprecated and still universally implemented;
 * `userAgentData` is Chromium-only, which is fine for Electron and not for the
 * demo surface, so it is tried first and fallen back from.
 */
export function isMacPlatform(): boolean {
  if (typeof navigator === 'undefined') return false;
  const data = (navigator as { userAgentData?: { platform?: string } }).userAgentData;
  if (data?.platform) return data.platform.toLowerCase().startsWith('mac');
  return /mac/i.test(navigator.platform || navigator.userAgent);
}
