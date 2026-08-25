import { lstat, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import type {
  SkillFile,
  SkillsSnapshot,
} from '@shared/skills-contract';

import { PLUGIN_DIR, skillsRoot } from './paths';
import { writePluginDir } from './plugin';
import { readUserSkills, type SkillsRead } from './read';

/**
 * The skills runtime (HIVE-96).
 *
 * A sibling of `createHookRuntime`, not a member of it. The two share a parent
 * directory in userData and nothing else: hooks own a socket whose failure
 * takes the receiver down with it, and this owns a directory whose failure
 * costs a session some slash commands. Folding the second into the first would
 * put a fatal error path and a cosmetic one behind one name.
 */

export interface SkillsRuntime {
  /**
   * Re-read `~/.hive/skills` and regenerate the plugin directory.
   *
   * Called at launch and again before **every** spawn. A readdir per spawn is
   * cheap, and paying it is what makes "save a skill, start a session, it is
   * there" true with no invalidation protocol between the pane and main — and
   * what makes a skill added by hand in a text editor behave identically to one
   * added in Settings.
   */
  sync(): Promise<SkillsRead>;
  /**
   * The `--plugin-dir` argument, or `null` when the directory has never been
   * written successfully.
   *
   * `null` is the honest answer rather than an optimistic path: `bootstrap.ts`
   * omits the flag for it, and a session with no extra skills is strictly
   * better than a session pointed at a directory that is not there.
   */
  pluginDirPath(): string | null;
  /** The snapshot the Settings pane renders. */
  list(): Promise<SkillsSnapshot>;
  /** One file, for the editor. */
  readOne(name: string): Promise<SkillFile>;
  /** Write, regenerate, and answer with the fresh snapshot. */
  write(name: string, body: string): Promise<SkillsSnapshot>;
  /** Remove the folder, regenerate, and answer with the fresh snapshot. */
  remove(name: string): Promise<SkillsSnapshot>;
  /**
   * Move a skill's folder, regenerate, and answer with the fresh snapshot
   * (HIVE-99).
   *
   * The one verb here the renderer could not have assembled from the others —
   * see `skills-contract.ts` for why write-then-remove has a window that this
   * does not. Rejects when `to` is taken, and when `from` is not there.
   *
   * The **body is not touched**. A rename leaves `to/SKILL.md` still declaring
   * `from`, which `readUserSkills` reports as a mismatch — so a caller renaming
   * because the frontmatter changed must follow with the {@link write} that
   * carries the new name. `src/lib/skills.ts` does exactly that, in one call,
   * and this stays a move rather than becoming a move-and-edit.
   */
  rename(from: string, to: string): Promise<SkillsSnapshot>;
}

export interface SkillsRuntimeOptions {
  userDataPath: string;
  /**
   * The app's version, for the generated manifest.
   *
   * Passed in rather than read from `app.getVersion()` here: this module's
   * tests run under plain Node, and importing `electron` would make them need a
   * runtime they do not have. `ipc/index.ts` already owns every other `app.*`
   * call for the same reason.
   */
  version: string;
  /**
   * Where the generated `/done` reports to (HIVE-93).
   *
   * A getter, not a value, and that is the whole of this runtime's relationship
   * with the hook runtime. The two are siblings that share a parent directory in
   * userData and nothing else — folding one into the other would put a fatal
   * error path and a cosmetic one behind one name — but `/done` needs a port the
   * *other* one chose at bind time. A function read at regeneration keeps the
   * dependency to a single value flowing one way, with no import between them.
   *
   * Optional, and absent means `null`: this module's own tests construct a
   * runtime with no hooks at all, and a skills directory without a working
   * `/done` is still a skills directory.
   */
  doneUrl?: () => string | null;
}

export function createSkillsRuntime({
  userDataPath,
  version,
  doneUrl,
}: SkillsRuntimeOptions): SkillsRuntime {
  const pluginRoot = join(userDataPath, PLUGIN_DIR);
  let written = false;

  /**
   * Every path this module touches is built here, from a name.
   *
   * The name has already been through `assertSkillName` at the IPC boundary, so
   * it matches `SKILL_NAME_PATTERN` and cannot contain a separator or a dot
   * segment — which is what makes this `join` total rather than something that
   * needs a containment check afterwards. See `skills-contract.ts` for why the
   * contract is shaped to make that true rather than to verify it.
   */
  const fileFor = (name: string): string =>
    join(skillsRoot(), name, 'SKILL.md');

  /**
   * The regeneration in flight, so two never interleave.
   *
   * `writePluginDir` ends by diffing the directory against the set it just
   * wrote and removing everything else. Two concurrent runs make that diff
   * lie: run A snapshots `{x}`, the user saves `y` and run B writes it, then
   * A's prune finds `y` absent from *its* expected set and deletes it. The
   * session A was regenerating for starts without a skill that exists on disk,
   * and the plugin stays wrong until something else happens to re-sync.
   *
   * A promise chain rather than a lock: every caller still gets a settled
   * answer, they simply queue. The work is a readdir and a handful of small
   * writes, so the wait is not worth a more elaborate mechanism — and a spawn
   * that overlaps a save is precisely the case this exists for.
   */
  let inFlight: Promise<SkillsRead> = Promise.resolve({
    skills: [],
    invalid: [],
  });

  const regenerate = async (): Promise<SkillsRead> => {
    const read = await readUserSkills(skillsRoot());

    try {
      await writePluginDir(pluginRoot, version, read, doneUrl?.() ?? null);
      written = true;
    } catch (cause) {
      /**
       * Non-fatal, and this is the one place that decision is made.
       *
       * A session that starts without its custom skills is a session that
       * works. A session that does not start because a directory could not be
       * written is not, and nothing on screen would connect the two. The hook
       * runtime reports its own failures the same way, and for the same reason.
       *
       * `written` goes back to `false`, so this stays true to
       * {@link SkillsRuntime.pluginDirPath}'s contract. Latching it on the
       * first success meant a directory removed or broken later still produced
       * a `--plugin-dir` pointing at nothing.
       */
      written = false;
      console.info(
        `[hive] the skills plugin could not be written — sessions start without custom skills (${String(cause)})`,
      );
    }

    return read;
  };

  const sync = (): Promise<SkillsRead> => {
    // Chained off the previous run whether it resolved or rejected — and
    // `regenerate` never rejects, so this queue cannot wedge.
    inFlight = inFlight.then(regenerate, regenerate);
    return inFlight;
  };

  /*
    `SkillsRead` is main's shape and `SkillsSnapshot` is the renderer's. They
    are kept separate rather than reused: the renderer has no business with a
    skill's `body` until it opens one, and shipping every file's full text on
    every list would put the whole skills tree on the wire for a sidebar.
  */
  const snapshot = (read: SkillsRead): SkillsSnapshot => ({
    skills: read.skills.map(({ name, description }) => ({
      name,
      description,
      valid: true,
    })),
    invalid: read.invalid.map(({ name, reason }) => ({
      name,
      reason,
      valid: false,
    })),
    skillsRoot: skillsRoot(),
  });

  return {
    sync,

    pluginDirPath(): string | null {
      return written ? pluginRoot : null;
    },

    async list(): Promise<SkillsSnapshot> {
      return snapshot(await sync());
    },

    async readOne(name: string): Promise<SkillFile> {
      const path = fileFor(name);
      return { name, body: await readFile(path, 'utf8'), path };
    },

    async write(name: string, body: string): Promise<SkillsSnapshot> {
      // The tree does not exist until there is something to put in it, so the
      // first save is also what creates `~/.hive/skills`.
      await mkdir(join(skillsRoot(), name), { recursive: true });
      await writeFile(fileFor(name), body, 'utf8');
      return snapshot(await sync());
    },

    async remove(name: string): Promise<SkillsSnapshot> {
      await rm(join(skillsRoot(), name), { recursive: true, force: true });
      return snapshot(await sync());
    },

    async rename(from: string, to: string): Promise<SkillsSnapshot> {
      const target = join(skillsRoot(), to);

      /*
        Refuse a taken name rather than letting `rename(2)` decide.

        The syscall's answer to an existing target is not one answer: it
        silently *replaces* an empty directory and fails ENOTEMPTY on a full
        one. So a user renaming onto a skill they had emptied by hand would
        lose it without a word, and renaming onto a real one would fail with an
        errno that means nothing to them. The pane refuses this collision too
        (`skillNameProblem`'s `taken`), and that is exactly why it is also
        refused here: a boundary that is correct only while the UI in front of
        it is correct is not a boundary.

        Not atomic with the rename below, and it does not need to be. The only
        writer to this tree is this process, and a folder appearing between the
        two lines is a person with a text editor — for whom losing the race
        means the rename fails, not that their file is replaced.
      */
      if (await exists(target)) {
        throw new Error(`A skill called "${to}" already exists.`);
      }

      // One syscall, so there is no moment in which the skill exists twice or
      // not at all — the whole reason this verb is in main.
      await rename(join(skillsRoot(), from), target);
      return snapshot(await sync());
    },
  };
}

/**
 * Is anything at all sitting on this name — directory, file, or dangling link?
 *
 * `lstat`, not `stat`, and the difference is not academic: `read.ts` counts a
 * **symlink to a directory** as a skill folder, so a link is a name that is
 * taken. `stat` would follow it, and a link left pointing at nothing — the
 * dotfiles case, since the population most likely to symlink these in is the
 * one most likely to have a stale one — would read as free.
 */
async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch {
    /*
      Anything that cannot be stat'ed counts as absent, which is the safe
      direction: the caller's next move is `rename(2)`, which fails loudly on a
      path it cannot use. Reporting "taken" for an EACCES would refuse a rename
      the OS would have allowed, on the strength of a guess.
    */
    return false;
  }
}
