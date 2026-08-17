/**
 * What may be written into a terminal the user is reading.
 *
 * Its own module, and imported rather than duplicated, for a structural reason:
 * `session-input.ts` already imports `pty-transport.ts`, so the transport cannot
 * import it back to share this logic. A leaf module both can depend on is the
 * only shape that works. It imports nothing itself, which is what keeps it one.
 *
 * The rule these encode is the same one main's `assertText` enforces at the IPC
 * boundary (`electron/shared/guards.ts`): C0, DEL and C1 have no business in
 * text a person meant to type. A pasted `ESC` could address the cursor, set the
 * window title, or switch to the alternate screen.
 *
 * Where they differ is what happens to a **line break**, and that difference is
 * the whole reason there are two functions rather than one — see each.
 */

/** Every line-ending form, longest first so `\r\n` is one break and not two. */
const LINE_ENDING = /\r\n|\r|\n/gu;

/** C0 (excluding the line breaks callers handle first), DEL, and C1. */
const isControl = (char: string): boolean => {
  const code = char.codePointAt(0) ?? 0;
  return code < 0x20 || (code >= 0x7f && code <= 0x9f);
};

/**
 * Drop every control character, expressed by code point.
 *
 * By code point rather than a regex literal, so this file stays free of control
 * bytes — a regex containing a raw `ESC` is invisible in review and mangled by
 * half the tools that touch it.
 */
const stripControls = (text: string): string =>
  [...text].filter((char) => !isControl(char)).join('');

/**
 * Keep the line structure, lose everything else.
 *
 * For text on its way to a **live session's prompt**, where line breaks are now
 * meaningful: the terminal half of this story gives the pty a sequence that
 * inserts a line without submitting, so a multi-line message can arrive as the
 * multi-line message the user typed.
 *
 * Line endings are normalised to `\n` here and translated at the point of
 * writing, so exactly one place in the codebase knows the byte.
 */
export function normalizeLines(text: string): string {
  return text
    .replace(LINE_ENDING, '\n')
    .split('\n')
    .map(stripControls)
    .join('\n')
    .trim();
}

/**
 * Fold everything onto one line.
 *
 * For text on its way **through the IPC boundary as a value** rather than to a
 * prompt — a spawn's task, today. Main's `assertText` rejects any control
 * character, `\n` included, and refuses the whole spawn if it finds one; that
 * guard is worth keeping exactly as strict as it is, so the flattening happens
 * on this side instead.
 *
 * Without it, a task typed with `Shift+Enter` is rejected in main *after* the
 * store has already added the session row, leaving a session on screen whose
 * process never started.
 */
export function flattenLines(text: string): string {
  return stripControls(text.replace(LINE_ENDING, ' ')).trim();
}
