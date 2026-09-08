import {
  chmod,
  lstat,
  mkdir,
  readFile as readFileRaw,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { dirname, join } from 'node:path';

import {
  MAX_BUNDLE_FILE_BYTES,
  type SkillFile,
  type SkillFileRead,
  type SkillsSnapshot,
} from '@shared/skills-contract';

import { copyInto } from './import';
import { PLUGIN_DIR, isSkillManifest, resolveInSkill, skillsRoot } from './paths';
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
   * One file inside a skill's bundle, for the editor (HIVE-148).
   *
   * `readOne` above is `SKILL.md` by another name — a fixed file, no path. This
   * is its bundle sibling: any file `resolveInSkill` admits, refused rather
   * than failed when it is too large or looks binary, the same two reasons and
   * the same order `fs/read.ts` uses for the project explorer.
   */
  readFile(name: string, path: string): Promise<SkillFileRead>;
  /**
   * Write one file inside a bundle, creating its parent directories and
   * regenerating the plugin (HIVE-148).
   *
   * Does **not** regenerate the skill's `SKILL.md` mirror logic or touch
   * anything but the one file named — `write` above stays the only verb that
   * can change a skill's declared name and body.
   */
  writeFile(name: string, path: string, body: string): Promise<SkillsSnapshot>;
  /** Create a folder inside a bundle, regenerate, and answer with the fresh snapshot. */
  makeDir(name: string, path: string): Promise<SkillsSnapshot>;
  /**
   * Remove a file or folder inside a bundle, regenerate, and answer with the
   * fresh snapshot.
   *
   * Refuses `SKILL.md` itself — see the implementation for why deleting the
   * skill is a different verb.
   */
  removeFile(name: string, path: string): Promise<SkillsSnapshot>;
  /**
   * Move or rename a file or folder inside a bundle, regenerate, and answer
   * with the fresh snapshot.
   *
   * The bundle sibling of {@link SkillsRuntime.rename}: same refuse-rather-than-
   * replace rule for a taken destination, scoped to one entry inside a folder
   * instead of the folder itself.
   */
  moveFile(name: string, from: string, to: string): Promise<SkillsSnapshot>;
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
  /**
   * Copy whatever a native picker returns into a bundle, regenerate, and
   * answer with the fresh snapshot (HIVE-148).
   *
   * `pick` is injected rather than called here for the reason `doneUrl` is a
   * getter and `version` is passed in rather than read from `app`: this
   * module's tests run under plain Node, and importing `electron` for a
   * dialog would give them a runtime they do not have. `ipc/index.ts` owns
   * the actual `dialog.showOpenDialog` call.
   */
  importFiles(name: string, dir: string, pick: () => Promise<string[]>): Promise<SkillsSnapshot>;
  /**
   * Copy `sources` — absolute paths only preload can produce — into a bundle,
   * regenerate, and answer with the fresh snapshot (HIVE-148).
   *
   * The bundle sibling of {@link SkillsRuntime.importFiles}: same `copyInto`
   * underneath, different origin for the paths. See `skills-contract.ts` for
   * why the renderer cannot forge one of its own.
   */
  dropFiles(name: string, dir: string, sources: string[]): Promise<SkillsSnapshot>;
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
    every list would put the whole skills tree on the wire for a sidebar. The
    `manifest` carried below is the deliberate exception — it is metadata
    (paths, sizes, exclusions), not content, and the pane needs it on every
    row to dim an oversized file or grey out a symlink without a second round
    trip. What still never crosses this boundary is a file's *body*.
  */
  const snapshot = (read: SkillsRead): SkillsSnapshot => ({
    skills: read.skills.map(({ name, description, manifest }) => ({
      name,
      description,
      valid: true,
      manifest,
    })),
    invalid: read.invalid.map(({ name, reason }) => ({
      name,
      reason,
      valid: false,
    })),
    skillsRoot: skillsRoot(),
  });

  /**
   * Whether `absPath` — already resolved by `resolveInSkill` — names the
   * bundle root itself, however it got there.
   *
   * `''` is not the property that matters, and checking the request string
   * for it was the bug: `assertSkillPath` refuses `''`, but it admits at
   * least one spelling that still resolves to the very same place —
   * `up/graphify` through a `symlink('..', ...)` planted inside the bundle.
   * That clears the boundary's dot-segment rule the same way `self/SKILL.md`
   * does for {@link isSkillManifest}, and for the same reason: comparing what
   * a path *resolves to* is the only check that covers every spelling a
   * symlink can produce, where comparing the string that named it covers
   * exactly one.
   */
  const isSkillRoot = async (
    name: string,
    absPath: string,
  ): Promise<boolean> => {
    let real: string;
    try {
      real = await realpath(absPath);
    } catch {
      return false; // Nothing there to be the root.
    }

    let root: string;
    try {
      root = await realpath(join(skillsRoot(), name));
    } catch {
      return false; // No bundle to protect.
    }

    return real === root;
  };

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
      return { name, body: await readFileRaw(path, 'utf8'), path };
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

    async readFile(name: string, path: string): Promise<SkillFileRead> {
      const absPath = await resolveInSkill(name, path);
      const info = await stat(absPath);

      /*
        The same two refusals `fs/read.ts` makes, in the same order and for the
        same reason: a 40 MB binary reads better as "too large" than as
        "binary". Reusing `FsRefusalReason` rather than minting a second
        vocabulary keeps one rendering in the editor for one distinction.
      */
      if (info.size > MAX_BUNDLE_FILE_BYTES) {
        return { name, path, absPath, size: info.size, body: null, refused: 'too-large' };
      }

      const buffer = await readFileRaw(absPath);
      if (buffer.includes(0)) {
        return { name, path, absPath, size: info.size, body: null, refused: 'binary' };
      }

      return {
        name,
        path,
        absPath,
        size: info.size,
        body: buffer.toString('utf8'),
        refused: null,
      };
    },

    async writeFile(name: string, path: string, body: string): Promise<SkillsSnapshot> {
      const absPath = await resolveInSkill(name, path);

      /*
        SKILL.md is what makes the folder a skill, and this verb has no
        rename logic behind it — `write` above is what mirrors a changed
        `name:` into the folder that holds it. Writing here with an empty
        body, or any body at all, would blank or replace the manifest with
        nothing to catch the mismatch: `readUserSkills` reports it invalid on
        the next sync, silently, the same recovery trap `removeFile` and
        `moveFile` already guard against for delete and rename.

        Checked against the *resolved* path, not the request string, for the
        reason {@link isSkillManifest} documents: a bundle holding
        `self -> .` makes `self/SKILL.md` a second, symlinked name for the
        exact same file, and `assertSkillPath` admits it (no dot segment,
        depth 2). String equality on the request would miss it.
      */
      if (await isSkillManifest(name, absPath)) {
        throw new Error(
          'SKILL.md is edited through the skill itself, not the file tree.',
        );
      }

      await mkdir(dirname(absPath), { recursive: true });
      await writeFile(absPath, body, 'utf8');
      /*
        The content decides, and nothing else does (HIVE-148).

        A blanket `+x` would show up in `~/.hive/skills` as a page of
        `100644 -> 100755` with nothing behind it, and that directory is a
        dotfiles directory for the people most likely to write skills. A
        toggle would be a second thing to get wrong. `#!` is what the kernel
        reads, so it is what this reads.
      */
      await chmod(absPath, body.startsWith('#!') ? 0o755 : 0o644);
      return snapshot(await sync());
    },

    async makeDir(name: string, path: string): Promise<SkillsSnapshot> {
      await mkdir(await resolveInSkill(name, path), { recursive: true });
      return snapshot(await sync());
    },

    async removeFile(name: string, path: string): Promise<SkillsSnapshot> {
      const absPath = await resolveInSkill(name, path);

      /*
        The bundle root itself. `assertSkillPath` already refuses the literal
        `''` at the IPC boundary, but that string is not the property that
        matters — `up/graphify` through a symlinked `up -> ..` also clears
        the boundary's dot-segment rule and resolves to the same root.
        Checked against the *resolved* path for the same reason the
        `SKILL.md` guard below is: every other trap in this file is defended
        a second time here, and an `rm -rf` of the whole skill is exactly the
        kind of mistake one unguarded caller away should not survive.
      */
      if (await isSkillRoot(name, absPath)) {
        throw new Error('Cannot remove the bundle root — remove the skill instead.');
      }

      /*
        SKILL.md is what makes the folder a skill. Deleting it through the file
        tree would leave a folder that `readUserSkills` reports as invalid, a
        row the pane cannot open, and no way back except a text editor — the
        recovery trap HIVE-99's self review found and fixed. Deleting the
        *skill* is `skills:remove`, which asks first and says what it removes.

        Checked against the *resolved* path, not the request string: a bundle
        holding `self -> .` makes `self/SKILL.md` a second, symlinked name for
        the same file, and `assertSkillPath` admits it (no dot segment, depth
        2). String equality on the request would miss it entirely.
      */
      if (await isSkillManifest(name, absPath)) {
        throw new Error('SKILL.md cannot be deleted — delete the skill instead.');
      }
      /*
        `recursive`, not `force`. `force` swallows `ENOENT`, so a path that
        was never there — `removeFile('graphify', 'never/was/here.txt')` —
        resolved and reported a successful delete, which is worse than the
        failure itself: the pane's Delete confirm claims a removal that never
        happened and the user stops looking for the file. `recursive` alone
        still removes a real directory and everything under it; nothing here
        depended on `force` doing more than hiding that one case.
      */
      await rm(absPath, { recursive: true });
      return snapshot(await sync());
    },

    async moveFile(name: string, from: string, to: string): Promise<SkillsSnapshot> {
      const source = await resolveInSkill(name, from);

      /*
        The bundle root itself, for the same reason `removeFile` checks it —
        and `moveFile('graphify', 'up/graphify', 'archive')` was reachable
        here too until this landed. It happened to fail already, but only
        because `rename(2)` refuses to move a directory into its own
        subtree (`EINVAL`) — a syscall accident, not a defended trap, and the
        one deliberate exception to this file's rule that every trap is
        guarded on purpose rather than by what the OS happens to refuse.
      */
      if (await isSkillRoot(name, source)) {
        throw new Error('Cannot move the bundle root — remove or rename the skill instead.');
      }

      /*
        The same protection `removeFile` gives SKILL.md, because a move is a
        second route to the same recovery trap: `moveFile(name, 'SKILL.md',
        'archive.md')` leaves a folder with no `SKILL.md` just as surely as
        deleting it would, and it must not be reachable by renaming around
        the guard above.
      */
      if (await isSkillManifest(name, source)) {
        throw new Error('SKILL.md cannot be moved — it must stay at the bundle root.');
      }

      const target = await resolveInSkill(name, to);

      // Refused rather than left to `rename(2)`, for the reason the skill
      // rename gives: the syscall replaces an empty directory silently and
      // fails ENOTEMPTY on a full one, which is two outcomes and no refusal.
      if (await exists(target)) {
        throw new Error(`"${to}" already exists in this skill.`);
      }

      await mkdir(dirname(target), { recursive: true });
      await rename(source, target);
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

    async importFiles(
      name: string,
      dir: string,
      pick: () => Promise<string[]>,
    ): Promise<SkillsSnapshot> {
      const sources = await pick();
      // A cancelled dialog is not a failure, and re-reading the tree for it
      // would flash the pane for a user who changed their mind.
      if (sources.length === 0) return snapshot(await sync());

      await copyInto(name, dir, sources);
      return snapshot(await sync());
    },

    async dropFiles(name: string, dir: string, sources: string[]): Promise<SkillsSnapshot> {
      await copyInto(name, dir, sources);
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
