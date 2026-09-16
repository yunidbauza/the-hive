/**
 * OSC 52, the clipboard escape (#288).
 *
 * A program in a pty has two ways to reach the system clipboard: run a helper
 * (`pbcopy`), or emit `ESC ] 52 ; <targets> ; <base64> BEL` and ask the
 * terminal to do it. Claude Code does both, and inside a container there is no
 * `pbcopy` — so OSC 52 is the only route out, and xterm implements none.
 *
 * Only the **write** form is honoured. `52;c;?` asks the terminal to type the
 * clipboard back onto stdin, which hands whatever the user last copied to any
 * program, or to hostile output a program merely prints. Real terminals keep it
 * off by default; this one does not have it at all.
 */

/**
 * Base64 characters accepted, about 768 KiB of text.
 *
 * ponytail: a fixed cap, a setting if someone copies more than that.
 */
export const OSC52_PAYLOAD_LIMIT = 1024 * 1024;

const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/u;

/**
 * The text an OSC 52 write carries, or `null` for anything that is not one.
 *
 * `data` is what xterm hands a handler: everything after `52;`. The selection
 * targets are ignored — the system has one clipboard.
 */
export function decodeOsc52Write(data: string): string | null {
  const separator = data.indexOf(';');
  if (separator < 0) return null;
  const payload = data.slice(separator + 1);
  if (
    payload === '' ||
    payload.length > OSC52_PAYLOAD_LIMIT ||
    payload.length % 4 !== 0 ||
    !BASE64.test(payload)
  ) {
    return null;
  }
  const bytes = Uint8Array.from(atob(payload), (char) => char.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}
