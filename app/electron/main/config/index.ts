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
import { writeConfig, type ConfigDocument } from './write';

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

  const existing = getConfig().projects.find((entry) => entry.path === real);
  if (existing) {
    return refused(`${LABEL}: ${real} is already added as "${existing.id}"`);
  }

  const taken = new Set(getConfig().projects.map((entry) => entry.id));
  const id = deriveProjectId(basename(real), taken);

  cached = writeConfig((draft) => ({
    ...draft,
    projects: [
      ...projectsOf(draft),
      {
        id,
        name: request.name ?? basename(real),
        path: request.path,
        icon: DEFAULT_PROJECT_ICON,
        origin: 'local',
      },
    ],
  }));

  return cached;
}

/**
 * Remove one entry by id (story 101).
 *
 * Whether removal is *allowed* — a project that owns live sessions — is the
 * renderer's gate for this story: the button is disabled with a tooltip. Story
 * 103 owns the confirmation flow that lifts it.
 */
export function removeProject(request: RemoveProjectRequest): ConfigSnapshot {
  const present = getConfig().projects.some((entry) => entry.id === request.id);
  if (!present) {
    return refused(`${LABEL}: no project with id "${request.id}"`);
  }

  cached = writeConfig((draft) => ({
    ...draft,
    projects: projectsOf(draft).filter(
      (entry) =>
        !(
          typeof entry === 'object' &&
          entry !== null &&
          (entry as Record<string, unknown>).id === request.id
        ),
    ),
  }));

  return cached;
}
