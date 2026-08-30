import { access, readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { isSkillFolder } from './read';

/**
 * Every skill name an agent definition may name.
 *
 * ## Why this is wider than `~/.hive/skills`
 *
 * `parseAgent` used to validate `skills:` against the Hive's own folder alone,
 * and that was wrong in both directions. Too narrow, because an agent runs as a
 * `claude -p` process on this machine: it loads the user's `~/.claude/skills`
 * and their installed plugins whether or not the definition names them, so
 * refusing `superpowers:brainstorming` refused a skill the agent could reach
 * regardless. And wrong in practice, because `~/.hive/skills` is empty on a
 * fresh install — which made the field refuse *every* name a person could type.
 *
 * So the field is not a sandbox and this is not a permission list. It is the
 * set of names that exist, and what it buys is a typo caught in the editor
 * rather than a skill that silently is not there at run time. A true sandbox
 * would mean `--restricted`, which would cut off exactly the external skills
 * this widening exists to allow; `docs/agents-and-ledger.md` records that trade
 * rather than making it silently.
 *
 * ## Why the roots are arguments
 *
 * Two of the three are inside the developer's own `~/.claude`, and a unit test
 * that read them would assert on whatever happened to be installed that week —
 * green here, red on CI, and untestable for the case that matters most (a
 * machine with nothing installed). `createAgentsRuntime` is the only caller
 * that knows the real paths, exactly as it is already the only caller that
 * knows `agentsRoot()`.
 */

export interface SkillRoots {
  /** `~/.hive/skills` — the folder Settings › Skills writes. */
  hive: string;
  /** `~/.claude/skills` — the user's own, which The Hive does not manage. */
  user: string;
  /** `~/.claude/plugins/installed_plugins.json`. */
  installedPlugins: string;
}

/**
 * Folders directly under `root` that hold a `SKILL.md`.
 *
 * A missing or unreadable root is an empty list, not a throw. All three roots
 * are optional in practice — no Hive skills, no personal skills, no plugins —
 * and an agent must stay editable on a machine that has none of them. Failing
 * closed here would make the editor refuse every skill name on precisely the
 * machines where the user has the fewest ways to work out why.
 *
 * Two details that look incidental and are not:
 *
 * `isSkillFolder` rather than `entry.isDirectory()`. `readdir` reports `lstat`
 * semantics, so a **symlinked** skill folder answers `false` — and three of the
 * five entries under this machine's own `~/.claude/skills` are symlinks into a
 * dotfile repo, which is where personal skills usually live. Reading them as
 * "not a skill" would refuse `pretty-mermaid` with "no skill called
 * pretty-mermaid", the exact false refusal this module exists to end.
 *
 * `access` rather than `readFile`. This runs once per `list()`, which re-runs
 * on every watcher event, and it now walks every installed plugin as well as
 * two skill folders — a hundred-odd files on this machine. Reading each one
 * into memory to prove it exists and then discarding it is a cost paid on every
 * keystroke-triggered save for information `access` already gives.
 */
async function skillsUnder(root: string): Promise<string[]> {
  let entries;

  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    return [];
  }

  const names: string[] = [];

  for (const entry of entries) {
    if (!(await isSkillFolder(root, entry))) continue;

    try {
      // The literal, as `read.ts`, `index.ts` and `plugin.ts` all spell it.
      await access(join(root, entry.name, 'SKILL.md'));
      names.push(entry.name);
    } catch {
      // A directory with no SKILL.md is not a skill — it is somebody's notes,
      // the same judgement `registry.ts` makes about a folder with no AGENT.md.
    }
  }

  return names;
}

/**
 * One installed plugin's `installPath`, keyed by the plugin's own name.
 *
 * The file is Claude Code's, so this reads it defensively and shape-checks
 * every hop: an unexpected layout must cost the user the *plugin* names, not
 * the ability to save an agent. The key is `<plugin>@<marketplace>` and the
 * value an array of installs — several cached versions of one plugin can sit on
 * disk at once (this machine has three of `workstream`), and this file is what
 * says which one is actually installed, which is why the versioned directories
 * are not globbed directly.
 *
 * A **user**-scoped install wins over the rest rather than the array's first
 * entry winning. That array is not ordered by relevance: `plugin-dev` on this
 * machine lists a `project`-scoped install belonging to an unrelated repository
 * *before* the user-scoped one, and it is the user-scoped root an agent's
 * process would actually load. Falling back to the first usable entry keeps a
 * plugin that is only ever project-scoped from disappearing.
 */
function installPaths(json: string): Map<string, string> {
  const paths = new Map<string, string>();
  let parsed: unknown;

  try {
    parsed = JSON.parse(json);
  } catch {
    return paths;
  }

  const plugins = (parsed as { plugins?: unknown } | null)?.plugins;

  if (typeof plugins !== 'object' || plugins === null) return paths;

  for (const [key, installs] of Object.entries(plugins)) {
    if (!Array.isArray(installs)) continue;

    const usable = installs.filter(
      (install: unknown): install is { installPath: string; scope?: unknown } =>
        typeof install === 'object' &&
        install !== null &&
        typeof (install as { installPath?: unknown }).installPath === 'string',
    );
    const first =
      usable.find((install) => install.scope === 'user') ?? usable[0];

    if (first === undefined) continue;

    // `superpowers@claude-plugins-official` → `superpowers`. The marketplace
    // is not part of how a skill is addressed.
    const name = key.split('@')[0] ?? '';

    if (name !== '') paths.set(name, first.installPath);
  }

  return paths;
}

/**
 * Skill names from installed plugins, namespaced `plugin:skill`.
 *
 * The namespace is Claude Code's own addressing, not an invention here: two
 * plugins may each ship a `review` skill, and the qualified form is how the
 * binary tells them apart — so it is also the form a definition has to spell.
 */
async function pluginSkills(file: string): Promise<string[]> {
  let json: string;

  try {
    json = await readFile(file, 'utf8');
  } catch {
    return [];
  }

  const names: string[] = [];

  for (const [plugin, root] of installPaths(json)) {
    for (const skill of await skillsUnder(join(root, 'skills'))) {
      names.push(`${plugin}:${skill}`);
    }
  }

  return names;
}

/**
 * The names an agent may reference, and the subset The Hive itself owns.
 *
 * Two sets rather than one, because `parseAgent` asks two different questions
 * of them. `all` answers *may this definition name this skill*, and has to be
 * as wide as the machine. `hive` answers *may an agent take this name*, and
 * must not be — that rule exists because an agent and a skill The Hive manages
 * share one namespace, and widening it silently reserved every name in the
 * user's personal skills folder: with `~/.claude/skills/graphify` present, no
 * agent could be called `graphify`, refused on account of a folder The Hive
 * neither manages nor mentions.
 */
export interface AvailableSkills {
  all: string[];
  hive: string[];
}

/** Every name, deduplicated and sorted so the set has one representation. */
export async function readAvailableSkillNames(
  roots: SkillRoots,
): Promise<AvailableSkills> {
  const [hive, user, plugins] = await Promise.all([
    skillsUnder(roots.hive),
    skillsUnder(roots.user),
    pluginSkills(roots.installedPlugins),
  ]);

  return {
    all: [...new Set([...hive, ...user, ...plugins])].sort(),
    hive: [...hive].sort(),
  };
}
