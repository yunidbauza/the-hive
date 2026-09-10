/**
 * The theme byte cap (HIVE-80, trimmed by HIVE-146).
 *
 * Types and constants only, like everything in `electron/shared/`.
 * `src/lib/theme/contract.ts` re-exports {@link MAX_THEME_BYTES} so the cap has
 * exactly one definition rather than a renderer-side copy that could drift.
 *
 * ## Why a shared module still holds a renderer-only number
 *
 * It used to carry `PickedTheme` and `SaveThemeRequest` too, the payloads of
 * `theme:pick` and `theme:save`. HIVE-146 deleted both channels: a theme file
 * lives on the machine the user is sitting at, which main is not while attached
 * to a server, so the renderer reads and writes it directly.
 *
 * The cap stays here rather than moving to `src/lib/theme/` because it is
 * enforced in two places on the renderer side — `files.ts` sizes the chosen
 * file before reading it, `validate.ts` bounds the contents afterwards — and a
 * module both of them import is what keeps those two the same number. That it
 * no longer crosses a process boundary makes it a candidate to move, not an
 * obligation; moving it would mean editing the `@shared` import in
 * `src/lib/theme/contract.ts` for no behaviour change.
 */

/** Bytes. localStorage has no quota error worth showing a person. */
export const MAX_THEME_BYTES = 256 * 1024;
