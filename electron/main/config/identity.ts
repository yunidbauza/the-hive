/**
 * Deriving a project's stable id (story 101) and its typing key (HIVE-94).
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

/*
 * The typing key (HIVE-94).
 *
 * The id is machinery and reads like it — `incorpx-server`, up to forty
 * characters. The key is the thing a user types into the console, so it is
 * bounded hard at four letters and generated to be *guessable from the name*
 * rather than merely unique.
 *
 * The rules, in the order they are tried:
 *
 * - A leading article is dropped. `The Hive` is `hive`, not `th` — the article
 *   is not part of what anyone calls the project, and initials that begin with
 *   one produce a key nobody would guess. Never dropped when it is the only
 *   word, so a project genuinely called "The" still gets a key.
 * - **Several words → their initials.** `incorpx-server` → `is`, `ai-sdk` → `as`.
 * - **One word → the word, if it fits.** `hive` → `hive`. A longer one is cut
 *   to three rather than four (`incorpx` → `inc`): a four-letter slice of a long
 *   word reads like a truncation, where three reads like an abbreviation.
 *
 * Everything is lowercase `[a-z]`, and digits are dropped rather than mapped,
 * because {@link PROJECT_KEY_PATTERN} has no room for them — which is also why
 * the collision fallbacks below extend with *letters* instead of taking the
 * `-2` suffix `deriveProjectId` uses.
 */

const KEY_MIN = 2;
const KEY_MAX = 4;

/** Dropped from the front of a name before initials are taken. */
const ARTICLES = new Set(['the', 'a', 'an']);

/** The source a name that sanitises to nothing falls back to. */
const FALLBACK_KEY_SOURCE = 'project';

const ALPHABET = 'abcdefghijklmnopqrstuvwxyz';

/**
 * Split a name into lowercase letter-only words.
 *
 * Digits are separators rather than characters: `incorpx2-server` is two words,
 * not one word containing a `2` that the key could never carry anyway.
 */
function keyWords(name: string): string[] {
  const words = name
    .toLowerCase()
    .replace(/[^a-z]+/g, ' ')
    .trim()
    .split(/\s+/)
    .filter((word) => word !== '');

  if (words.length === 0) return [FALLBACK_KEY_SOURCE];
  // Never strip the only word — a project called "The" still needs a key.
  if (words.length > 1 && ARTICLES.has(words[0])) return words.slice(1);
  return words;
}

/** The key a name wants, before anything is known about what is taken. */
function preferredKey(words: string[]): string {
  if (words.length > 1) {
    return words
      .map((word) => word[0])
      .join('')
      .slice(0, KEY_MAX);
  }

  const only = words[0];
  return only.length <= KEY_MAX ? only : only.slice(0, 3);
}

/**
 * Candidates in the order they should be offered, best first.
 *
 * Four tiers, narrowing from "still says what the project is" to "merely
 * unique". The last one is exhaustive, which is what makes this total: with
 * 476,000 keys in `[a-z]{2,4}` and a config holding a few dozen projects, the
 * sweep cannot run out, so the caller never has to handle a failure case that
 * could not happen.
 */
function* keyCandidates(words: string[]): Generator<string> {
  const base = preferredKey(words);
  if (base.length >= KEY_MIN) yield base;

  /*
    Tier two: keep growing the *last* word. `incorpx-server` and `incorpx-sdk`
    both want `is`; the loser becomes `ise` and `isd` — still initials, with
    enough of the tail to tell them apart. This is the tier that makes a
    collision readable rather than arbitrary.
  */
  const tail = words[words.length - 1];
  if (words.length > 1) {
    for (let take = 1; base.length + take <= KEY_MAX && take < tail.length; take += 1) {
      yield base + tail.slice(1, 1 + take);
    }
  } else {
    for (let length = base.length + 1; length <= Math.min(KEY_MAX, tail.length); length += 1) {
      yield tail.slice(0, length);
    }
  }

  /*
    Tier three: keep as much of the base as a key of each length allows and vary
    the final letter. Longest first, so `hive` yields `hiva`…`hivz` before it
    ever considers a two-letter key that has lost most of the name.
  */
  for (let length = KEY_MAX; length >= KEY_MIN; length -= 1) {
    const stem = base.slice(0, length - 1);
    if (stem.length !== length - 1) continue;
    for (const letter of ALPHABET) yield stem + letter;
  }

  // Tier four: every key there is, shortest first. Unreachable in practice.
  for (let length = KEY_MIN; length <= KEY_MAX; length += 1) {
    yield* sweep(length, '');
  }
}

function* sweep(length: number, prefix: string): Generator<string> {
  if (prefix.length === length) {
    yield prefix;
    return;
  }
  for (const letter of ALPHABET) yield* sweep(length, prefix + letter);
}

/**
 * A unique key for a project name.
 *
 * `taken` is every key already spoken for — the other entries in the file, and
 * on a backfill the ones this same pass has already handed out. The caller owns
 * that set because uniqueness is a property of the config, not of a name.
 */
export function deriveProjectKey(
  name: string,
  taken: ReadonlySet<string>,
): string {
  const words = keyWords(name);
  for (const candidate of keyCandidates(words)) {
    if (!taken.has(candidate)) return candidate;
  }
  /*
    Unreachable: tier four enumerates the entire key space, so exhausting it
    would mean `taken` holds all 475,254 of them. Returning the preferred key
    rather than throwing keeps this function total — a config that somehow got
    there has a duplicate key, which `resolveProjects` already reports, and that
    is a better outcome than an unloadable app.
  */
  return preferredKey(words);
}
