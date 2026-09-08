/**
 * A byte count a person can read.
 *
 * ## Why decimal and not binary
 *
 * Every cap this formats is a round decimal number — `MAX_FILE_BYTES` is
 * 1,000,000 and `MAX_BUNDLE_FILE_BYTES` is 5,000,000 — so a 1024-based
 * formatter renders the cap itself as "977 KB" or "4.8 MB" and makes the
 * refusal read as though the limit were somewhere else entirely. The number on
 * screen has to be the number in the rule.
 *
 * ## Why it lives here rather than beside either caller
 *
 * It began private to `features/editor`'s pane. Settings' skill editor needs
 * the same sentence for the same refusals — `fs-contract.ts`'s `FsRefusal` is
 * shared by both surfaces — and a feature slice may not import another's
 * internals. Copying eight lines would have been two formatters to keep
 * agreeing about what a megabyte is.
 *
 * Not `Intl.NumberFormat`: this is two significant digits and a suffix, and
 * `Intl`'s unit formatting brings a locale-dependent space and abbreviation
 * that the surrounding copy is not written for.
 */
const BYTES_PER_KB = 1000;

export function humanSize(bytes: number): string {
  if (bytes < BYTES_PER_KB) return `${String(bytes)} B`;
  if (bytes < BYTES_PER_KB * BYTES_PER_KB) {
    return `${String(Math.round(bytes / BYTES_PER_KB))} KB`;
  }
  return `${(bytes / BYTES_PER_KB / BYTES_PER_KB).toFixed(1)} MB`;
}
