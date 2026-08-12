/**
 * Deriving a project's stable id (story 101).
 *
 * The id is machinery, not a label. Sessions reference projects through
 * `entity.project`, so an id that drifted when a folder was renamed would
 * strand every session that named it. It is derived **once**, when the project
 * is added, and never recomputed. The display `name` is the one the user edits
 * (story 103).
 *
 * The output must satisfy `assertId` in `electron/shared/guards.ts`, because
 * `parse.ts` runs every id in the file through it — a derived id the reader
 * would reject is a write that refuses itself.
 */

const MAX_LENGTH = 40;

/** Used when sanitising leaves nothing — an unnamed id is worse than a dull one. */
const FALLBACK = 'project';

/** Trim a trailing separator left behind by slicing mid-word. */
const trimDash = (value: string): string => value.replace(/-+$/, '');

function kebab(input: string): string {
  const cleaned = trimDash(
    input
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+/, ''),
  );

  return cleaned === '' ? FALLBACK : trimDash(cleaned.slice(0, MAX_LENGTH));
}

/**
 * A unique id for a directory basename.
 *
 * A collision takes a `-2`, `-3` suffix. The base is trimmed *first* when
 * needed so the suffixed id still fits `MAX_LENGTH` — an id that silently
 * exceeded its own bound would be a bug the first time someone added two
 * long paths that happened to share a prefix.
 */
export function deriveProjectId(
  directoryName: string,
  taken: ReadonlySet<string>,
): string {
  const base = kebab(directoryName);
  if (!taken.has(base)) return base;

  for (let n = 2; ; n += 1) {
    const suffix = `-${n}`;
    const trimmed = trimDash(base.slice(0, MAX_LENGTH - suffix.length));
    const candidate = `${trimmed === '' ? FALLBACK : trimmed}${suffix}`;
    if (!taken.has(candidate)) return candidate;
  }
}
