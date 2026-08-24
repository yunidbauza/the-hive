import { existsSync, realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, isAbsolute, join } from 'node:path';

import {
  DEFAULT_PROJECT_ICON,
  projectAliases,
  type ProjectConfig,
} from '@shared/config-contract';

import { deriveProjectKey } from './identity';
import type { RawProject } from './parse';

/**
 * Turning declared paths into paths a PTY can be given a `cwd` of (story 090).
 *
 * Each step exists because skipping it produces a specific, quiet failure:
 *
 * - **Expand `~` in-process.** Shelling out for this would run the user's
 *   shell to answer a question `os.homedir()` already knows, and would make
 *   the answer depend on their dotfiles.
 * - **Require absolute after expansion.** A relative path resolves against the
 *   *app's* cwd — wherever Electron happened to be launched from — which is
 *   meaningless to the user and different in dev and in a packaged build.
 * - **`realpath` once, up front.** The path handed to `node-pty` must be the
 *   one that was validated. Validating a symlink and spawning through it
 *   leaves a window where the link is repointed between the two.
 * - **Require a directory.** `pty.spawn` with a `cwd` that is a file fails
 *   inside the child, where the error is a spawn failure with no context.
 */

/** Shared by the single-entry fallback below; never mutated. */
const EMPTY: ReadonlySet<string> = new Set<string>();

/**
 * Expand a leading `~`.
 *
 * `~user` is deliberately not supported — resolving another user's home
 * requires reading the password database, and a session that opens in someone
 * else's directory is not a feature anyone asked for. It falls through
 * unexpanded and is caught by the absolute-path check.
 */
function expandHome(path: string): string {
  if (path === '~') return homedir();
  if (path.startsWith('~/')) return join(homedir(), path.slice(2));
  return path;
}

/**
 * Whether a resolved directory is a git repository (story 101).
 *
 * `existsSync`, deliberately not `statSync(...).isDirectory()`: inside a git
 * **worktree** or a submodule, `.git` is a *file* holding a `gitdir:` pointer,
 * and a directory-only check would report a perfectly real repository — the one
 * this project is developed in among them — as not one.
 *
 * A directory that is not a repository is still added, with a muted tag. A PTY
 * needs a `cwd`, not a repo; refusing here would be the app inventing a rule
 * the shell does not have.
 */
function looksLikeRepo(real: string): boolean {
  return existsSync(join(real, '.git'));
}

/**
 * The fields every verdict carries, resolved or not (story 101).
 *
 * `name` falls back to the id rather than the raw path when resolution failed:
 * the path is already shown beneath the name in the settings row, and repeating
 * an unusable one as the title says nothing the row does not already say.
 */
function decorate(
  raw: RawProject,
  real: string | null,
): Pick<
  ProjectConfig,
  'id' | 'key' | 'name' | 'icon' | 'origin' | 'shell' | 'claudeCommand' | 'env'
> {
  return {
    id: raw.id,
    /**
     * Defaulted here only for the single-entry path (HIVE-94).
     *
     * {@link resolveProjects} assigns keys **before** calling through, because
     * uniqueness is a fact about the whole list and this function can see one
     * entry. What reaches this fallback is therefore only `resolveProject`
     * called directly — the `{ id: 'probe' }` throwaways `addProject` and
     * `repointProject` use to validate a path, whose key nothing ever reads.
     * Deriving one anyway keeps the return type honest without a cast.
     */
    key: raw.key ?? deriveProjectKey(raw.name ?? raw.id, EMPTY),
    name: raw.name ?? (real === null ? raw.id : basename(real)),
    icon: raw.icon ?? DEFAULT_PROJECT_ICON,
    origin: raw.origin ?? 'local',
    /**
     * Story 104's overrides are carried through **undefaulted**, unlike `name`
     * and `icon` above. The absence of an override is the meaningful state —
     * it is what "inherit the top-level value" looks like — so filling it in
     * here would erase the only thing the snapshot needs to say, and the
     * settings UI could never tell an override from an inherited value.
     */
    ...(raw.shell !== undefined ? { shell: raw.shell } : {}),
    ...(raw.claudeCommand !== undefined
      ? { claudeCommand: raw.claudeCommand }
      : {}),
    ...(raw.env !== undefined ? { env: raw.env } : {}),
  };
}

/** Resolve one declared entry to its verdict. Never throws. */
export function resolveProject(raw: RawProject): ProjectConfig {
  const expanded = expandHome(raw.path);

  if (!isAbsolute(expanded)) {
    return {
      ...decorate(raw, null),
      path: null,
      status: 'not-absolute',
      isRepo: false,
    };
  }

  let real: string;
  try {
    real = realpathSync(expanded);
  } catch {
    // ENOENT is the overwhelmingly common case; EACCES on a parent directory
    // lands here too, and "the app cannot reach it" is the same answer to the
    // user either way.
    return { ...decorate(raw, null), path: null, status: 'missing', isRepo: false };
  }

  // `realpathSync` already followed every link, so this cannot be a dangling
  // symlink. It can still fail if the path is removed between the two calls —
  // rare, but this function's contract is that it never throws, and a throw
  // here would abort the whole load and take every *other* project's verdict
  // with it.
  try {
    if (!statSync(real).isDirectory()) {
      return {
        ...decorate(raw, null),
        path: null,
        status: 'not-a-directory',
        isRepo: false,
      };
    }
  } catch {
    return { ...decorate(raw, null), path: null, status: 'missing', isRepo: false };
  }

  return {
    ...decorate(raw, real),
    path: real,
    status: 'ok',
    isRepo: looksLikeRepo(real),
  };
}

/**
 * Give every entry a key, keeping the ones the file already declared (HIVE-94).
 *
 * Two passes, and the order is the whole point: every declared key is claimed
 * *before* a single one is generated, so a generated key can never take a
 * literal one out from under an entry further down the file — which would make
 * the keys depend on where in the list a project happened to sit.
 *
 * A duplicate declared key is reported and the later entry is regenerated,
 * mirroring how a duplicate *id* is reported. Unlike a duplicate id it does not
 * disable the project: two entries claiming `ix` is a typo in an alias, not two
 * projects claiming to be the same project, so the honest repair is to give the
 * second one a key that works and say so.
 */
function withKeys(
  raws: readonly RawProject[],
  errors: string[],
): RawProject[] {
  const claimed = new Set<string>();
  const declared = raws.map((raw) => {
    if (raw.key === undefined) return raw;
    if (claimed.has(raw.key)) {
      errors.push(
        `projects: duplicate key "${raw.key}" on "${raw.id}" — generating a new one`,
      );
      // Fall through to the generating pass by forgetting what it declared.
      return { ...raw, key: undefined };
    }
    claimed.add(raw.key);
    return raw;
  });

  /**
   * Everything the resolver would already match, minus this entry's own handles.
   *
   * A generated key has to avoid the **whole address space**, not just the other
   * keys — see {@link projectAliases} for the silent-redirect this prevents. Its
   * own id and name are excluded because a project answering to itself under two
   * fields is not a collision.
   *
   * A key the file *declares* is left alone even if it shadows something: it is
   * the user's explicit choice in their own file, and quietly regenerating it
   * would be the one thing `parse.ts` refuses to do with a key.
   */
  const addressesOf = (index: number): string[] =>
    declared.flatMap((other, at) =>
      at === index ? [] : projectAliases({ id: other.id, name: other.name }),
    );

  return declared.map((raw, index) => {
    if (raw.key !== undefined) return raw;
    const taken = new Set([...claimed, ...addressesOf(index)]);
    const key = deriveProjectKey(raw.name ?? raw.id, taken);
    claimed.add(key);
    return { ...raw, key };
  });
}

/**
 * Resolve every entry, rejecting ids claimed more than once.
 *
 * First wins. The alternative — last wins — makes the effective config depend
 * on where in the file a line sits, which is not a rule anyone would guess
 * while editing it.
 */
export function resolveProjects(
  raws: readonly RawProject[],
  errors: string[],
): ProjectConfig[] {
  const claimed = new Set<string>();

  return withKeys(raws, errors).map((raw) => {
    if (claimed.has(raw.id)) {
      errors.push(
        `projects: duplicate id "${raw.id}" — keeping the first entry, ignoring this one`,
      );
      return {
        ...decorate(raw, null),
        path: null,
        status: 'duplicate-id' as const,
        isRepo: false,
      };
    }
    claimed.add(raw.id);

    const resolved = resolveProject(raw);
    if (resolved.status !== 'ok') {
      errors.push(
        `projects: "${raw.id}" is unusable (${resolved.status}): ${raw.path}`,
      );
    }
    return resolved;
  });
}
