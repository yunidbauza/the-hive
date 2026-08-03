import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname } from 'node:path';

import {
  DEFAULT_CLAUDE_COMMAND,
  DEFAULT_PROJECT_ICON,
  DEFAULT_SHELL,
  emptySnapshot,
  type AddProjectRequest,
  type ConfigSnapshot,
  type RemoveProjectRequest,
} from '@shared/config-contract';

import { deriveProjectId } from './identity';
import { parseConfig } from './parse';
import { configPath, describe } from './paths';
import { resolveProject, resolveProjects } from './resolve';
import { CONFIG_TEMPLATE } from './template';
import {
  WriteRefused,
  writeConfig,
  type ConfigDocument,
  type WriteResult,
} from './write';

/**
 * The workspace config (story 090).
 *
 * Read once at startup and on an explicit reload. **Not watched** — a file
 * watcher is out of scope, and a config that changes under a live session
 * would raise questions about what happens to the PTY already running in the
 * old directory that this story is not the place to answer.
 *
 * Nothing here throws. A failing entry disables that project and is reported;
 * a malformed file disables all of them and is reported. One mistyped path
 * must not stop the app from launching — but it must be *visible*, because a
 * silently dropped project looks like a bug in the app rather than a typo in a
 * file.
 */

const LABEL = 'config';

// Re-exported so every existing importer of `configPath` is untouched by the
// move to `paths.ts`.
export { configPath };

/**
 * First run: create the directory, write the template, carry on.
 *
 * `wx` rather than `w` — if something created the file between the failed read
 * and this write, that file is the user's and must not be clobbered by a
 * template. The resulting `EEXIST` is reported like any other write failure and
 * the next load reads what is actually there.
 */
function writeTemplate(path: string, shell: string): ConfigSnapshot {
  const snapshot = emptySnapshot(path, shell);
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, CONFIG_TEMPLATE, { encoding: 'utf8', flag: 'wx' });
    snapshot.templateWritten = true;
    // Logged once, because a file the user has never seen is a file they
    // cannot edit. This is the only line that tells them where it is.
    console.info(`[hive] no workspace config found — wrote a template to ${path}`);
  } catch (cause) {
    snapshot.errors.push(
      `${LABEL}: could not create ${path} (${describe(cause)}) — no project is spawnable`,
    );
  }
  return snapshot;
}

/** Read, parse, and resolve the config file. Always returns a snapshot. */
export function loadConfig(): ConfigSnapshot {
  const path = configPath();
  const shell = process.env.SHELL ?? DEFAULT_SHELL;

  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === 'ENOENT') {
      return writeTemplate(path, shell);
    }
    const snapshot = emptySnapshot(path, shell);
    snapshot.errors.push(
      `${LABEL}: could not read ${path} (${describe(cause)}) — no project is spawnable`,
    );
    return snapshot;
  }

  const parsed = parseConfig(text, LABEL);
  const projects = resolveProjects(parsed.projects, parsed.errors);

  return {
    configPath: path,
    templateWritten: false,
    shell: parsed.shell ?? shell,
    claudeCommand: parsed.claudeCommand ?? DEFAULT_CLAUDE_COMMAND,
    projects,
    errors: parsed.errors,
  };
}

let cached: ConfigSnapshot | null = null;

/** The snapshot every consumer reads. Loads on first use. */
export function getConfig(): ConfigSnapshot {
  cached ??= loadConfig();
  return cached;
}

/** Re-read the file. This is what `window.hive.config.reload()` reaches. */
export function reloadConfig(): ConfigSnapshot {
  cached = loadConfig();
  return cached;
}

/**
 * Read the `projects` array off a raw document, tolerating a missing one.
 *
 * The document has already been parsed and found non-fatal by `writeConfig`, so
 * a `projects` key that is not an array was reported there and is treated as
 * absent here rather than throwing on the user's data.
 */
function projectsOf(document: ConfigDocument): unknown[] {
  return Array.isArray(document.projects) ? document.projects : [];
}

/** A snapshot of the current config carrying one reason it could not change. */
function refused(reason: string): ConfigSnapshot {
  return { ...getConfig(), errors: [reason] };
}

/**
 * Read one entry's declared id off a raw draft entry.
 *
 * The draft is the file as JSON parsed it, so entries are unknown shapes — this
 * is the same untrusted data `parse.ts` guards, reached one step earlier.
 */
function idOf(entry: unknown): string | null {
  if (typeof entry !== 'object' || entry === null) return null;
  const id = (entry as Record<string, unknown>).id;
  return typeof id === 'string' ? id : null;
}

/** Read one entry's declared path off a raw draft entry. */
function pathOf(entry: unknown): string | null {
  if (typeof entry !== 'object' || entry === null) return null;
  const declared = (entry as Record<string, unknown>).path;
  return typeof declared === 'string' ? declared : null;
}

/**
 * Install a write's result as the new cache, or report why nothing changed.
 *
 * `writeConfig` says explicitly whether it wrote. Inferring that from the
 * snapshot would be wrong in both directions, which is why {@link WriteResult}
 * exists — see its doc comment.
 */
function commit(result: WriteResult): ConfigSnapshot {
  if (!result.ok) return refused(result.reason);
  cached = result.snapshot;
  return cached;
}

/**
 * Add a local directory (story 101).
 *
 * The incoming path re-runs the **entire** story 090 resolution — expand `~`,
 * require absolute, `realpath`, require a directory. The native dialog is a UX
 * step, not a capability grant: a renderer that skipped the dialog and posted a
 * path directly gets exactly the same treatment, because main's validation is
 * the actual gate either way.
 *
 * The path is stored **as the user wrote it**, tilde and all. Storing the
 * resolved path instead would bake this machine's home directory into a file
 * people keep in dotfile repos; `realpath` is used for identity and duplicate
 * detection, which is what it is good for.
 */
export function addProject(request: AddProjectRequest): ConfigSnapshot {
  const probe = resolveProject({ id: 'probe', path: request.path });
  if (probe.status !== 'ok' || probe.path === null) {
    return refused(`${LABEL}: cannot add ${request.path} (${probe.status})`);
  }
  const real = probe.path;

  /**
   * Identity and duplicate detection run against the **draft**, not the cache.
   *
   * The config is deliberately not watched, so the cached snapshot can be older
   * than the file — a user who hand-edited it since launch (the workflow this
   * story is replacing, not forbidding) would otherwise get a colliding id
   * written to disk, which `resolveProjects` then disables on the next read.
   * `writeConfig` re-reads from disk precisely so this check can be correct.
   */
  return commit(
    writeConfig((draft) => {
      const entries = projectsOf(draft);

      for (const entry of entries) {
        const declared = pathOf(entry);
        if (declared === null) continue;
        const resolved = resolveProject({ id: 'probe', path: declared });
        if (resolved.path === real) {
          throw new WriteRefused(
            `${real} is already added as "${idOf(entry) ?? 'an existing entry'}"`,
          );
        }
      }

      const taken = new Set(
        entries.map(idOf).filter((id): id is string => id !== null),
      );

      return {
        ...draft,
        projects: [
          ...entries,
          {
            id: deriveProjectId(basename(real), taken),
            name: request.name ?? basename(real),
            path: request.path,
            icon: DEFAULT_PROJECT_ICON,
            origin: 'local',
          },
        ],
      };
    }),
  );
}

/**
 * Remove one entry by id (story 101).
 *
 * Whether removal is *allowed* — a project that owns live sessions — is the
 * renderer's gate for this story: the button is disabled with a tooltip. Story
 * 103 owns the confirmation flow that lifts it.
 */
export function removeProject(request: RemoveProjectRequest): ConfigSnapshot {
  return commit(
    writeConfig((draft) => {
      const entries = projectsOf(draft);
      // Checked against the draft for the same reason `addProject` is: the
      // cache can be older than the file.
      if (!entries.some((entry) => idOf(entry) === request.id)) {
        throw new WriteRefused(`no project with id "${request.id}"`);
      }

      return {
        ...draft,
        projects: entries.filter((entry) => idOf(entry) !== request.id),
      };
    }),
  );
}
