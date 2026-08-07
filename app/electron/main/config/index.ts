import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname } from 'node:path';

import {
  DEFAULT_CLAUDE_COMMAND,
  DEFAULT_JIRA,
  DEFAULT_NOTIFICATIONS,
  DEFAULT_PROJECT_ICON,
  DEFAULT_SHELL,
  emptySnapshot,
  type AddProjectRequest,
  type ConfigSnapshot,
  type ProjectOrigin,
  type RemoveProjectRequest,
  type RenameProjectRequest,
  type ReorderProjectsRequest,
  type RepointProjectRequest,
  type SetJiraRequest,
  type SetNotificationsRequest,
  type SetProjectRuntimeRequest,
  type SetRuntimeRequest,
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
    // Defaults *under* whatever the file named, so a file declaring one switch
    // still answers for all three (story 106).
    notifications: { ...DEFAULT_NOTIFICATIONS, ...parsed.notifications },
    // Defaults *under* whatever the file named, so a file declaring only a site
    // still answers for both fields (HIVE-67).
    jira: { ...DEFAULT_JIRA, ...parsed.jira },
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
export function addProject(
  request: AddProjectRequest,
  /**
   * Where this entry came from (story 102).
   *
   * **Main-internal, never from the payload.** `parseAddProjectRequest` does
   * not accept an `origin`, so a renderer cannot claim a hand-picked folder was
   * cloned. The only caller that passes anything but the default is the clone
   * flow, which knows because it ran the clone.
   */
  origin: ProjectOrigin = 'local',
): ConfigSnapshot {
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
            origin,
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

/**
 * Change one project's display name (story 103).
 *
 * `name` only — the `id` is machinery and is never rewritten, because sessions
 * reference projects by `entity.project` and an id that drifted when a folder
 * was renamed would strand them.
 *
 * The entry is **spread, not rebuilt**. `addProject` and `removeProject` copy
 * raw entries wholesale, which is the only reason per-entry keys this build
 * does not know about survive a write; a rename that reconstructed an entry
 * from `ProjectConfig` would quietly eat them, and the epic's preservation rule
 * would hold for the top level while failing one level down.
 */
export function renameProject(request: RenameProjectRequest): ConfigSnapshot {
  return commit(
    writeConfig((draft) => {
      const entries = projectsOf(draft);
      // Checked against the draft rather than the cache, for the same reason
      // `addProject` is: the file on disk can be newer than the snapshot.
      if (!entries.some((entry) => idOf(entry) === request.id)) {
        throw new WriteRefused(`no project with id "${request.id}"`);
      }

      return {
        ...draft,
        projects: entries.map((entry) =>
          idOf(entry) === request.id
            ? { ...(entry as Record<string, unknown>), name: request.name }
            : entry,
        ),
      };
    }),
  );
}

/**
 * Point a project at a folder that moved (story 103).
 *
 * The incoming path re-runs the **entire** story 090 resolution, exactly as
 * `addProject` does — expand `~`, require absolute, `realpath`, require a
 * directory. The native dialog is a UX step, not a capability grant: a renderer
 * that skipped it and posted a path directly gets identical treatment.
 *
 * The path is stored **as the user wrote it**, tilde and all, for the same
 * reason `addProject` stores it that way — `realpath` is used for identity and
 * duplicate detection, which is what it is good for, and baking a resolved home
 * directory into a file people keep in dotfile repos is what it is not.
 *
 * `origin` survives because the entry is spread and only `path` is overwritten.
 * Re-pointing changes where a project *is*, never where it came from, so a
 * cloned project stays `origin: "cloned"` — a property of the mutation's shape
 * rather than a rule this function has to remember.
 */
export function repointProject(request: RepointProjectRequest): ConfigSnapshot {
  const probe = resolveProject({ id: 'probe', path: request.path });
  if (probe.status !== 'ok' || probe.path === null) {
    return refused(
      `${LABEL}: cannot re-point to ${request.path} (${probe.status})`,
    );
  }
  const real = probe.path;

  return commit(
    writeConfig((draft) => {
      const entries = projectsOf(draft);
      if (!entries.some((entry) => idOf(entry) === request.id)) {
        throw new WriteRefused(`no project with id "${request.id}"`);
      }

      for (const entry of entries) {
        /*
          Skip the project being moved. Re-pointing it at the folder it already
          has is a no-op the user is allowed to perform — treating it as a
          collision would make the verb refuse to confirm the status quo.
        */
        if (idOf(entry) === request.id) continue;
        const declared = pathOf(entry);
        if (declared === null) continue;
        if (resolveProject({ id: 'probe', path: declared }).path === real) {
          throw new WriteRefused(
            `${real} is already added as "${idOf(entry) ?? 'an existing entry'}"`,
          );
        }
      }

      return {
        ...draft,
        projects: entries.map((entry) =>
          idOf(entry) === request.id
            ? { ...(entry as Record<string, unknown>), path: request.path }
            : entry,
        ),
      };
    }),
  );
}

/**
 * Rewrite the order of the `projects` array (story 103).
 *
 * The payload is the **whole** ordering, and it must be a permutation of the
 * ids on disk *at write time*. That check is the reason the verb takes a full
 * list rather than a delta: the config is deliberately not watched (story 107
 * owns reload), so the renderer's list can be older than the file, and applying
 * a stale ordering would silently drop the project a hand edit had just added
 * — or resurrect one it had removed. Refusing and asking for a reload is honest
 * and costs the user one click.
 *
 * The left rail reads this order positionally and the merged list is explicitly
 * never sorted, so the array *is* the ordering — there is nowhere else it could
 * be stored.
 */
export function reorderProjects(
  request: ReorderProjectsRequest,
): ConfigSnapshot {
  return commit(
    writeConfig((draft) => {
      const entries = projectsOf(draft);
      const byId = new Map<string, unknown>();
      for (const entry of entries) {
        const id = idOf(entry);
        if (id !== null) byId.set(id, entry);
      }

      /*
        Every entry must be addressable by a unique id before an ordering can
        be applied at all.

        This is the check that stops the verb destroying data. The rebuild
        below is `request.ids.map(...)`, so any entry missing from `byId` is
        simply not written — and entries go missing for two ordinary reasons,
        neither of which the renderer can see: an entry with no `id` (or a
        non-string one), which `parse.ts` reports and skips while leaving it in
        the file, and two entries sharing an id, where the map keeps only the
        last. In both cases the renderer posts exactly the ids it knows about,
        a size comparison against `byId` alone would agree, and the write would
        report success while deleting the entry the user could not see.

        Comparing against `entries.length` instead is what makes the promise
        below — that entries are carried across whole — actually true.
      */
      if (byId.size !== entries.length) {
        throw new WriteRefused(
          'some entries in the config have no id, or share one with another entry — give every project a unique id before reordering',
        );
      }

      const matches =
        byId.size === request.ids.length &&
        request.ids.every((id) => byId.has(id));
      if (!matches) {
        throw new WriteRefused(
          // Not just "reload": the file can also hold an entry whose id this
          // build refuses, which no amount of reloading will change.
          'the requested order does not match the projects on disk — reload, and check the file for an entry whose id could not be read',
        );
      }

      return {
        ...draft,
        // Entries are carried across by reference, never rebuilt, so anything
        // this build does not understand rides along untouched.
        projects: request.ids.map((id) => byId.get(id)),
      };
    }),
  );
}

/**
 * Change the top-level runtime settings (story 104).
 *
 * Only the fields the request names are touched, so saving the shell cannot
 * silently restate — or clear — the agent command. There is no way to *unset*
 * either: they have no lower level to fall back to, and a session with no shell
 * cannot start, so the guard requires a real value whenever the key is present.
 */
export function setRuntime(request: SetRuntimeRequest): ConfigSnapshot {
  return commit(
    writeConfig((draft) => ({
      ...draft,
      ...(request.shell !== undefined ? { shell: request.shell } : {}),
      ...(request.claudeCommand !== undefined
        ? { claudeCommand: request.claudeCommand }
        : {}),
    })),
  );
}

/**
 * Change one project's runtime overrides (story 104).
 *
 * Three states per field, and all three are needed:
 *
 * - **absent** — leave it alone. The UI saves one field at a time, and a shell
 *   edit must not wipe an env map that row does not show.
 * - **`null`** — remove the override, so the project inherits the top level
 *   again. This is what an emptied input means; storing `""` instead would
 *   spawn a shell named `""` and fail with a message nobody could act on.
 * - **a value** — set the override.
 *
 * The entry is **spread, never rebuilt**, so per-entry keys this build does not
 * understand survive the write — the same promise story 103's verbs make, and
 * the one a conformance test that reconstructed an entry would pass while the
 * real code path regressed.
 */
export function setProjectRuntime(
  request: SetProjectRuntimeRequest,
): ConfigSnapshot {
  return commit(
    writeConfig((draft) => {
      const entries = projectsOf(draft);
      // Checked against the draft, never the cache: the file on disk can be
      // newer than the snapshot the renderer built this request from.
      if (!entries.some((entry) => idOf(entry) === request.id)) {
        throw new WriteRefused(`no project with id "${request.id}"`);
      }

      return {
        ...draft,
        projects: entries.map((entry) => {
          if (idOf(entry) !== request.id) return entry;

          const next = { ...(entry as Record<string, unknown>) };
          applyOverride(next, 'shell', request.shell);
          applyOverride(next, 'claudeCommand', request.claudeCommand);
          applyOverride(next, 'env', request.env);
          return next;
        }),
      };
    }),
  );
}

/**
 * Change notification preferences (story 106).
 *
 * The block is **spread, never rebuilt**, for the same reason every other verb
 * spreads its target: a key this build has not heard of — a class a later story
 * adds, edited by hand in the meantime — must survive a save made by this one.
 *
 * Only the classes the request names are written. The two that are merely
 * *defaulted* stay out of the file, so a later change to
 * `DEFAULT_NOTIFICATIONS` still reaches a user who once toggled one switch;
 * materialising all three here would quietly freeze today's defaults into their
 * config forever.
 */
export function setNotifications(
  request: SetNotificationsRequest,
): ConfigSnapshot {
  return commit(
    writeConfig((draft) => {
      // A non-object block is replaced rather than merged into. The reader has
      // already reported it, and merging onto a string would produce something
      // neither the user nor the parser meant.
      const current =
        typeof draft.notifications === 'object' &&
        draft.notifications !== null &&
        !Array.isArray(draft.notifications)
          ? (draft.notifications as Record<string, unknown>)
          : {};

      return { ...draft, notifications: { ...current, ...request } };
    }),
  );
}

/**
 * Change the Jira connection (HIVE-67).
 *
 * What this writes is the site and the account email. **The API token is not
 * here and never will be** — it is a secret, and it goes to `safeStorage`
 * through `jira:set-token`. That separation is the whole reason this verb exists
 * rather than a single "save Jira settings" call: a credential must not have a
 * path into a file the product invites the user to hand-edit.
 *
 * The block is spread, never rebuilt, for the same reason every other verb
 * spreads its target: a key this build has not heard of — `jql`, which HIVE-69
 * adds, hand-written in the meantime — must survive a save made by this one.
 *
 * `null` removes a field rather than storing `""`, which would be a site named
 * "" and a request to `https:///rest/api/3/myself`.
 */
export function setJira(request: SetJiraRequest): ConfigSnapshot {
  return commit(
    writeConfig((draft) => {
      // A non-object block is replaced rather than merged into. The reader has
      // already reported it, and merging onto a string would produce something
      // neither the user nor the parser meant.
      const current =
        typeof draft.jira === 'object' &&
        draft.jira !== null &&
        !Array.isArray(draft.jira)
          ? { ...(draft.jira as Record<string, unknown>) }
          : {};

      applyOverride(current, 'site', request.site);
      applyOverride(current, 'email', request.email);
      applyOverride(current, 'jql', request.jql);

      return { ...draft, jira: current };
    }),
  );
}

/**
 * Put the config file back to the first-run template (story 107).
 *
 * The one mutation that deliberately **discards** user data, and so the one
 * exception to the epic's preservation promise: unknown top-level keys and
 * hand-written `"//"` comments ride across every other write and are replaced
 * here. That is what "reset" means, and the confirmation in the UI says so in
 * those words rather than asking a generic "are you sure?".
 *
 * Still routed through `writeConfig` like everything else, which is the point.
 * It inherits the whole discipline for free — the file is re-read first, the
 * result is validated by the *reader's* own parser before anything touches
 * disk, the swap is a temp file plus `rename`, and the file's mode and any
 * symlink into a dotfiles repo are preserved. A reset that wrote the template
 * string straight to the path would be the one write in the app that could
 * leave a torn file, which is exactly the failure `write.ts` exists to make
 * impossible.
 *
 * `JSON.parse` of the template rather than the string verbatim, for two
 * reasons. The mutation keeps the same shape as every other — a
 * `ConfigDocument` in, one out — and the template goes through the reader's
 * validator, so a template this build could not read back fails in CI rather
 * than on a user's machine. The `"//"` comment keys survive `JSON.parse`, so
 * what lands on disk is still the commented file.
 *
 * `writeConfig` refuses when there is no file to read, so a reset with the
 * config deleted underneath reports that rather than recreating it. Recreating
 * it is `reload`'s job — `loadConfig` writes the template when the file is
 * gone — and exactly one path that creates the file is worth the extra click.
 */
export function resetConfig(): ConfigSnapshot {
  return commit(writeConfig(() => JSON.parse(CONFIG_TEMPLATE) as ConfigDocument));
}

/**
 * Apply one three-state override onto a draft object, in place.
 *
 * `delete` rather than writing `undefined`: a key whose value is `undefined`
 * disappears from `JSON.stringify` anyway, but leaving it on the object means
 * every later reader has to know that. Removing it keeps the draft honest about
 * what is going to be written.
 *
 * Shared by story 104's per-project runtime overrides and HIVE-67's Jira block,
 * which want identical semantics: absent leaves the key alone, `null` removes
 * it, and a value replaces it.
 */
function applyOverride(
  entry: Record<string, unknown>,
  key: 'shell' | 'claudeCommand' | 'env' | 'site' | 'email' | 'jql',
  value: string | Record<string, string> | null | undefined,
): void {
  if (value === undefined) return;
  if (value === null) {
    delete entry[key];
    return;
  }
  entry[key] = value;
}
