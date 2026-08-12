/**
 * Outbound-link policy (story 081).
 *
 * Terminal output is untrusted input, and xterm's web-links addon turns
 * anything that looks like a URL in that output into a clickable link. So the
 * set of schemes this app will hand to the OS is an allowlist, checked here.
 *
 * An unchecked `shell.openExternal` will happily launch a `file:` URL, or a
 * custom scheme registered by some other installed application — from a string
 * that arrived as terminal output. That is a remote-code-execution shaped hole
 * behind a link that looks ordinary.
 */

/** The only schemes that may reach `shell.openExternal`. */
const ALLOWED_PROTOCOLS = new Set(['http:', 'https:']);

/**
 * True only for a well-formed `http:`/`https:` URL.
 *
 * Anything that fails to parse is rejected rather than passed through — an
 * unparseable string is not a URL this app has any business opening.
 */
export function isSafeExternalUrl(candidate: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(candidate);
  } catch {
    return false;
  }
  return ALLOWED_PROTOCOLS.has(parsed.protocol);
}
