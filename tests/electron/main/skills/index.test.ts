// @vitest-environment node
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { MAX_BUNDLE_FILE_BYTES, type BundleManifest } from '@shared/skills-contract';

import { createSkillsRuntime } from '../../../../electron/main/skills';

let userDataPath: string;
let hiveDir: string;

const runtime = () =>
  createSkillsRuntime({ userDataPath, version: '1.0.0' });

const pluginSkills = (): Promise<string[]> =>
  readdir(join(userDataPath, 'hive', 'plugin', 'skills')).then((names) =>
    names.sort(),
  );

const writeSkill = async (name: string, body: string): Promise<void> => {
  await mkdir(join(hiveDir, 'skills', name), { recursive: true });
  await writeFile(join(hiveDir, 'skills', name, 'SKILL.md'), body, 'utf8');
};

const skill = (name: string): string =>
  `---\nname: ${name}\ndescription: does ${name}\n---\nBody.\n`;

/**
 * What `readBundle` reports for a folder holding nothing but the SKILL.md
 * `skill()` wrote — a single admitted file, nothing skipped or capped.
 */
const oneFileManifest = (body: string): BundleManifest => ({
  entries: [
    {
      path: 'SKILL.md',
      kind: 'file',
      size: Buffer.byteLength(body, 'utf8'),
      executable: false,
      excluded: null,
    },
  ],
  capped: null,
});

beforeEach(async () => {
  const base = await mkdtemp(join(tmpdir(), 'hive-runtime-'));
  userDataPath = join(base, 'userData');
  hiveDir = join(base, 'hive-home');
  await mkdir(hiveDir, { recursive: true });
  /*
    `skillsRoot()` is `dirname(configPath())/skills`, and `configPath()` reads
    this variable on every call — which is exactly the property that lets a test
    relocate the skills tree instead of writing into the developer's own.
  */
  process.env.HIVE_CONFIG_PATH = join(hiveDir, 'config.json');
});

afterEach(() => {
  delete process.env.HIVE_CONFIG_PATH;
  vi.restoreAllMocks();
});

describe('createSkillsRuntime', () => {
  it('has no path to offer before the first sync', () => {
    // `bootstrap.ts` omits the flag for null, so a session starts without extra
    // skills rather than pointed at a directory that is not there.
    expect(runtime().pluginDirPath()).toBeNull();
  });

  it('offers the generated dir once it has written it', async () => {
    const skills = runtime();

    await skills.sync();

    expect(skills.pluginDirPath()).toBe(join(userDataPath, 'hive', 'plugin'));
  });

  it('picks up a skill added after the first sync', async () => {
    // The whole reason sync runs per spawn: a skill saved from Settings thirty
    // seconds ago has to be on the next command line, with nothing to notify.
    const skills = runtime();
    await skills.sync();

    await writeSkill('standup', skill('standup'));
    const read = await skills.sync();

    expect(read.skills.map((s) => s.name)).toEqual(['standup']);
    expect(await pluginSkills()).toEqual(['done', 'standup']);
  });

  it('drops a skill the user deleted on the next sync', async () => {
    const skills = runtime();
    await writeSkill('standup', skill('standup'));
    await skills.sync();

    await skills.remove('standup');

    expect(await pluginSkills()).toEqual(['done']);
  });

  it('starts a session anyway when the plugin cannot be written', async () => {
    /*
      A *file* where the plugin root needs to be a directory, so `mkdir` throws
      ENOTDIR. A session that starts without its custom skills works; one that
      does not start because a directory could not be written does not, and the
      user has no way to connect the two.
    */
    vi.spyOn(console, 'info').mockImplementation(() => undefined);
    await mkdir(join(userDataPath, 'hive'), { recursive: true });
    await writeFile(join(userDataPath, 'hive', 'plugin'), 'not a dir', 'utf8');
    const skills = runtime();

    await expect(skills.sync()).resolves.toEqual({ skills: [], invalid: [] });
    expect(skills.pluginDirPath()).toBeNull();
  });

  it('stops offering a path once a regeneration fails', async () => {
    /*
      `written` used to latch true on the first success, so a directory removed
      or broken later still produced `--plugin-dir <missing path>` — the
      opposite of what `pluginDirPath`'s contract promises.
    */
    vi.spyOn(console, 'info').mockImplementation(() => undefined);
    const skills = runtime();
    await skills.sync();
    expect(skills.pluginDirPath()).not.toBeNull();

    // A file where the plugin root needs to be a directory.
    await rm(join(userDataPath, 'hive', 'plugin'), { recursive: true, force: true });
    await writeFile(join(userDataPath, 'hive', 'plugin'), 'not a dir', 'utf8');
    await skills.sync();

    expect(skills.pluginDirPath()).toBeNull();
  });

  it('serialises concurrent syncs, so a prune cannot eat a fresh write', async () => {
    /*
      `writePluginDir` ends by diffing the directory against the set it wrote.
      Two runs in flight make that diff lie: A snapshots {}, B writes standup,
      A's prune then finds standup absent from *its* expected set and removes
      it — losing a skill that exists on disk.
    */
    const skills = runtime();
    const first = skills.sync();
    await writeSkill('standup', skill('standup'));
    const second = skills.sync();

    await Promise.all([first, second]);

    expect(await pluginSkills()).toEqual(['done', 'standup']);
  });

  it('lists what the pane renders, invalid skills included', async () => {
    await writeSkill('standup', skill('standup'));
    await writeSkill('Bad Name', skill('Bad Name'));

    const snapshot = await runtime().list();

    expect(snapshot.skills).toEqual([
      {
        name: 'standup',
        description: 'does standup',
        valid: true,
        manifest: oneFileManifest(skill('standup')),
      },
    ]);
    expect(snapshot.invalid[0]?.name).toBe('Bad Name');
    expect(snapshot.invalid[0]?.valid).toBe(false);
    expect(snapshot.skillsRoot).toBe(join(hiveDir, 'skills'));
  });

  it('never lists the built-in, which the pane must not offer to edit', async () => {
    const snapshot = await runtime().list();

    expect(snapshot.skills.map((s) => s.name)).not.toContain('done');
  });

  it('reads one file back for the editor', async () => {
    await writeSkill('standup', skill('standup'));

    const file = await runtime().readOne('standup');

    expect(file).toEqual({
      name: 'standup',
      body: skill('standup'),
      path: join(hiveDir, 'skills', 'standup', 'SKILL.md'),
    });
  });

  it('writes a new skill and answers with the fresh snapshot', async () => {
    const snapshot = await runtime().write('standup', skill('standup'));

    expect(snapshot.skills).toEqual([
      {
        name: 'standup',
        description: 'does standup',
        valid: true,
        manifest: oneFileManifest(skill('standup')),
      },
    ]);
    expect(await pluginSkills()).toEqual(['done', 'standup']);
  });

  it('creates the skills tree on the first save', async () => {
    // The directory does not exist until there is something to put in it.
    await runtime().write('standup', skill('standup'));

    expect(await readdir(join(hiveDir, 'skills'))).toEqual(['standup']);
  });

  it('removes a skill, and the plugin dir loses it too', async () => {
    const skills = runtime();
    await skills.write('standup', skill('standup'));

    const snapshot = await skills.remove('standup');

    expect(snapshot.skills).toEqual([]);
    expect(await pluginSkills()).toEqual(['done']);
  });
});

/**
 * Moving a skill's folder (HIVE-99).
 *
 * The verb exists because the renderer's version of a rename was a duplicate:
 * the folder is named from the frontmatter, so editing `name:` and saving wrote
 * the new folder and left the old one — valid, listed, and still injected. The
 * first test here is the one the story is about: **one** folder afterwards.
 */
describe('createSkillsRuntime.rename', () => {
  const userSkills = (): Promise<string[]> =>
    readdir(join(hiveDir, 'skills')).then((names) => names.sort());

  it('moves the folder, leaving exactly one behind', async () => {
    const skills = runtime();
    await skills.write('standup', skill('standup'));

    await skills.rename('standup', 'stand-up');

    expect(await userSkills()).toEqual(['stand-up']);
  });

  it('takes the file with it', async () => {
    // A move, not a re-create: the body is whatever was in the old folder.
    const skills = runtime();
    await skills.write('standup', `${skill('standup')}Extra line.\n`);

    await skills.rename('standup', 'stand-up');

    expect((await skills.readOne('stand-up')).body).toContain('Extra line.');
  });

  it('leaves the plugin dir with the new command and not the old one', async () => {
    /*
      The acceptance criterion the user actually feels: the next session has
      `/stand-up` and does **not** have `/standup`. Between the move and the
      body write the folder and its frontmatter disagree, so main reports the
      skill invalid and drops it from the plugin — which is why the caller
      follows with the write, asserted in the next test.
    */
    const skills = runtime();
    await skills.write('standup', skill('standup'));

    await skills.rename('standup', 'stand-up');
    await skills.write('stand-up', skill('stand-up'));

    expect(await pluginSkills()).toEqual(['done', 'stand-up']);
  });

  it('answers with a snapshot in which the moved skill is invalid until rewritten', async () => {
    /*
      Not a wart to be hidden — it is the true state of the disk, and the pane
      relies on it: if the follow-up write fails, this is the snapshot that puts
      an actionable reason on the row rather than silently losing the skill.
    */
    const skills = runtime();
    await skills.write('standup', skill('standup'));

    const snapshot = await skills.rename('standup', 'stand-up');

    expect(snapshot.skills).toEqual([]);
    expect(snapshot.invalid[0]?.name).toBe('stand-up');
    expect(snapshot.invalid[0]?.reason).toMatch(/does not match the folder/i);
  });

  it('refuses a destination that already exists, rather than replacing it', async () => {
    const skills = runtime();
    await skills.write('standup', skill('standup'));
    await skills.write('ship-it', skill('ship-it'));

    await expect(skills.rename('standup', 'ship-it')).rejects.toThrow(
      /already exists/i,
    );
    expect(await userSkills()).toEqual(['ship-it', 'standup']);
  });

  it('refuses an existing destination even when it is empty', async () => {
    /*
      The case `rename(2)` gets silently wrong. An empty target directory is
      *replaced* by the syscall with no error at all, so a user who had emptied
      a skill folder by hand would lose the name without a word. A full one
      fails ENOTEMPTY — two outcomes for one mistake, and neither is a refusal,
      which is why the check is ours.
    */
    const skills = runtime();
    await skills.write('standup', skill('standup'));
    await mkdir(join(hiveDir, 'skills', 'ship-it'), { recursive: true });

    await expect(skills.rename('standup', 'ship-it')).rejects.toThrow(
      /already exists/i,
    );
    expect(await userSkills()).toEqual(['ship-it', 'standup']);
  });

  it('refuses a destination taken by a folder main reports as invalid', async () => {
    // An invalid skill is still a folder with a SKILL.md in it, and the most
    // likely invalid skill is one whose name and folder already disagree —
    // exactly the name a user renaming things is likely to type.
    const skills = runtime();
    await skills.write('standup', skill('standup'));
    await writeSkill('stand-up', skill('something-else'));

    await expect(skills.rename('standup', 'stand-up')).rejects.toThrow(
      /already exists/i,
    );
  });

  it('refuses a destination taken by a dangling symlink', async () => {
    /*
      `lstat`, not `stat`. `read.ts` counts a symlink-to-directory as a skill
      folder, so a link is a name that is taken — and a link left pointing at
      nothing would read as free under `stat` and then be silently replaced.
    */
    const skills = runtime();
    await skills.write('standup', skill('standup'));
    await symlink(
      join(hiveDir, 'skills', 'nowhere'),
      join(hiveDir, 'skills', 'stand-up'),
    );

    await expect(skills.rename('standup', 'stand-up')).rejects.toThrow(
      /already exists/i,
    );
  });

  it('rejects when the source is not there', async () => {
    // Straight from `rename(2)`. Nothing to translate: the pane only ever names
    // a skill it has listed, so this is a bug or a hand-edit mid-save.
    await expect(runtime().rename('ghost', 'stand-up')).rejects.toThrow();
  });
});

/**
 * The five file verbs inside a bundle (HIVE-148): read, write, mkdir, remove
 * and move, all scoped under one skill's folder rather than the folder itself.
 */
describe('createSkillsRuntime file verbs', () => {
  const skillsDir = (): string => join(hiveDir, 'skills');

  it('reads a file from inside the bundle', async () => {
    const skills = runtime();
    await skills.write('graphify', '---\nname: graphify\n---\n');
    await mkdir(join(skillsDir(), 'graphify', 'scripts'), { recursive: true });
    await writeFile(
      join(skillsDir(), 'graphify', 'scripts', 'b.py'),
      'print(1)\n',
      'utf8',
    );

    const file = await skills.readFile('graphify', 'scripts/b.py');

    expect(file.body).toBe('print(1)\n');
    expect(file.refused).toBeNull();
  });

  it('refuses a binary file rather than failing on it', async () => {
    const skills = runtime();
    await skills.write('graphify', '---\nname: graphify\n---\n');
    await writeFile(
      join(skillsDir(), 'graphify', 'logo.png'),
      Buffer.from([0, 1, 2, 0]),
    );

    const file = await skills.readFile('graphify', 'logo.png');

    expect(file.refused).toBe('binary');
    expect(file.body).toBeNull();
  });

  it('writes a file with a shebang as 755 and everything else as 644', async () => {
    const skills = runtime();
    await skills.write('graphify', '---\nname: graphify\n---\n');

    await skills.writeFile('graphify', 'scripts/run.sh', '#!/bin/sh\necho hi\n');
    await skills.writeFile('graphify', 'notes.md', 'plain\n');

    const script = await stat(join(skillsDir(), 'graphify', 'scripts', 'run.sh'));
    const notes = await stat(join(skillsDir(), 'graphify', 'notes.md'));

    expect(script.mode & 0o777).toBe(0o755);
    expect(notes.mode & 0o777).toBe(0o644);
  });

  it('creates parent directories on write', async () => {
    const skills = runtime();
    await skills.write('graphify', '---\nname: graphify\n---\n');

    await skills.writeFile('graphify', 'a/b/c/deep.txt', 'x');

    expect(
      await readFile(join(skillsDir(), 'graphify', 'a/b/c/deep.txt'), 'utf8'),
    ).toBe('x');
  });

  it('makes an empty folder that survives a re-read', async () => {
    const skills = runtime();
    await skills.write('graphify', '---\nname: graphify\n---\n');

    await skills.makeDir('graphify', 'references');
    const snapshot = await skills.list();

    const skill = snapshot.skills.find((s) => s.name === 'graphify');
    expect(skill?.manifest.entries.map((e) => e.path)).toContain('references');
  });

  it('removes a folder with what is under it', async () => {
    const skills = runtime();
    await skills.write('graphify', '---\nname: graphify\n---\n');
    await skills.writeFile('graphify', 'scripts/a.py', 'x');

    await skills.removeFile('graphify', 'scripts');

    await expect(
      stat(join(skillsDir(), 'graphify', 'scripts')),
    ).rejects.toThrow();
  });

  it('refuses to remove SKILL.md, which would break the skill silently', async () => {
    /*
      Pinned to the specific message and to the file surviving, not merely
      that the call threw: an implementation that deleted the file and then
      threw for an unrelated reason would pass a bare `.rejects.toThrow()`,
      and so would one where `resolveInSkill` happened to throw for
      everything. Neither is the guarantee this verb makes.
    */
    const skills = runtime();
    await skills.write('graphify', '---\nname: graphify\n---\n');

    await expect(
      skills.removeFile('graphify', 'SKILL.md'),
    ).rejects.toThrow(/SKILL\.md cannot be deleted/i);
    expect(
      await readFile(join(skillsDir(), 'graphify', 'SKILL.md'), 'utf8'),
    ).toContain('name: graphify');
  });

  it('moves a file inside the bundle', async () => {
    const skills = runtime();
    await skills.write('graphify', '---\nname: graphify\n---\n');
    await skills.writeFile('graphify', 'a.py', 'x');

    await skills.moveFile('graphify', 'a.py', 'scripts/b.py');

    expect(
      await readFile(join(skillsDir(), 'graphify', 'scripts/b.py'), 'utf8'),
    ).toBe('x');
    await expect(stat(join(skillsDir(), 'graphify', 'a.py'))).rejects.toThrow();
  });

  it('refuses a move onto a name that is taken', async () => {
    const skills = runtime();
    await skills.write('graphify', '---\nname: graphify\n---\n');
    await skills.writeFile('graphify', 'a.py', 'a');
    await skills.writeFile('graphify', 'b.py', 'b');

    await expect(skills.moveFile('graphify', 'a.py', 'b.py')).rejects.toThrow();
    expect(await readFile(join(skillsDir(), 'graphify', 'b.py'), 'utf8')).toBe(
      'b',
    );
  });

  it('refuses a path that escapes the skill root through a symlink', async () => {
    const skills = runtime();
    await skills.write('graphify', '---\nname: graphify\n---\n');
    const outside = await mkdtemp(join(tmpdir(), 'hive-outside-'));
    try {
      await writeFile(join(outside, 'secret.txt'), 'no', 'utf8');
      await symlink(outside, join(skillsDir(), 'graphify', 'escape'));

      /*
        The escape must fail *because it escapes*, not because the target is
        missing: `secret.txt` is written before the symlink exists, so a
        resolveInSkill that only checked ENOENT would find the file and read
        it straight through the link. The message assertion is what pins this
        down to `OutsideSkillError` rather than any other rejection — a bare
        `.rejects.toThrow()` would pass just as well on ENOENT and prove
        nothing.
      */
      await expect(
        skills.readFile('graphify', 'escape/secret.txt'),
      ).rejects.toThrow(/outside the skill folder/i);
    } finally {
      // In a `finally`, not inline: a failed assertion above must not leak
      // the temp directory into the next run.
      await rm(outside, { recursive: true, force: true });
    }
  });

  it('refuses a write through a dangling symlink rather than following it out', async () => {
    /*
      The gap the sabotage experiment for the escape test above could not
      reach: `realpath` throws `ENOENT` for a path that genuinely does not
      exist yet *and* for a dangling symlink, whose target is absent but
      which is very much sitting on disk. A resolver that treated every
      `ENOENT` as "climb, it's not there yet" would climb straight past the
      link to a resolvable ancestor and hand `writeFile` a path it never
      actually validated — which then follows the link and writes outside the
      root with no error at all.
    */
    const skills = runtime();
    await skills.write('graphify', '---\nname: graphify\n---\n');
    const outside = await mkdtemp(join(tmpdir(), 'hive-outside-'));
    const outsideTarget = join(outside, 'not-yet.txt');
    try {
      // The target does not exist — this is what makes it dangling, and what
      // makes `realpath` fail exactly the way a merely-not-created-yet path
      // fails.
      await symlink(outsideTarget, join(skillsDir(), 'graphify', 'escape'));

      await expect(
        skills.writeFile('graphify', 'escape', 'PWNED'),
      ).rejects.toThrow(/outside the skill folder/i);

      // Not merely that it threw: nothing must have landed at the far end of
      // the link. A refusal that still wrote through the link before
      // throwing would pass a bare `.rejects.toThrow()` and still be a
      // security hole.
      await expect(readFile(outsideTarget, 'utf8')).rejects.toThrow();
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });

  it('refuses a write through a symlink whose declared target transits another symlink out of the bundle', async () => {
    /*
      The round-2 repair's own mistake, reopening the write escape by a
      different route: it read a link's declared target with `readlink`,
      joined it *lexically* onto the directory holding the link, and checked
      `contains()` on that joined **string** — never asking what an
      intermediate component actually resolves to on disk. `esc -> <outside>`
      is a real, existing symlink; `hop -> ./esc/leaf.txt` looks contained as
      a *string* (`root/esc/leaf.txt`), but `esc` itself resolves for real to
      somewhere outside `root`. `writeFile` then followed `hop` through
      `esc` and landed outside with an attacker-chosen body — a `#!` body
      would even land executable, since `writeFile`'s `chmod` follows the
      same link. The fix runs a link's declared target back through the same
      resolution rather than trusting the string it read.
    */
    const skills = runtime();
    await skills.write('graphify', '---\nname: graphify\n---\n');
    const outside = await mkdtemp(join(tmpdir(), 'hive-outside-'));
    try {
      // `esc` is a genuinely resolvable link to a real directory outside the
      // bundle — the piece a lexical check never looked at.
      await symlink(outside, join(skillsDir(), 'graphify', 'esc'));
      // `hop`'s own declared target never leaves the bundle as a *string* —
      // it reads `./esc/hop.txt`, and only resolving `esc` for real reveals
      // where it actually goes.
      await symlink('./esc/hop.txt', join(skillsDir(), 'graphify', 'hop'));

      await expect(
        skills.writeFile('graphify', 'hop', '#!/bin/sh\necho PWNED\n'),
      ).rejects.toThrow(/outside the skill folder/i);

      await expect(
        readFile(join(outside, 'hop.txt'), 'utf8'),
      ).rejects.toThrow();
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });

  it('refuses a write through a chain of dangling symlinks that ends outside the bundle', async () => {
    // Each hop is validated on its own account rather than assumed safe
    // because the *previous* hop's declared target string looked local —
    // three hops deep, matching what the reviewer drove.
    const skills = runtime();
    await skills.write('graphify', '---\nname: graphify\n---\n');
    const outside = await mkdtemp(join(tmpdir(), 'hive-outside-'));
    const outsideTarget = join(outside, 'chain.txt');
    try {
      await symlink('./chainB', join(skillsDir(), 'graphify', 'chainA'));
      await symlink('./chainC', join(skillsDir(), 'graphify', 'chainB'));
      await symlink(outsideTarget, join(skillsDir(), 'graphify', 'chainC'));

      await expect(
        skills.writeFile('graphify', 'chainA', 'PWNED'),
      ).rejects.toThrow(/outside the skill folder/i);

      await expect(readFile(outsideTarget, 'utf8')).rejects.toThrow();
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });

  it('refuses to remove SKILL.md through a symlink that resolves back to it', async () => {
    /*
      `assertSkillPath` admits `self/SKILL.md` — no dot segment, depth 2 — so
      a bundle holding `self -> .` reaches `removeFile` with a path that is
      not the literal string `'SKILL.md'` but resolves to the exact same
      file. A guard checking the request string misses this entirely.
    */
    const skills = runtime();
    await skills.write('graphify', '---\nname: graphify\n---\n');
    await symlink('.', join(skillsDir(), 'graphify', 'self'));

    await expect(
      skills.removeFile('graphify', 'self/SKILL.md'),
    ).rejects.toThrow(/SKILL\.md cannot be deleted/i);
    expect(
      await readFile(join(skillsDir(), 'graphify', 'SKILL.md'), 'utf8'),
    ).toContain('name: graphify');
  });

  it('refuses to remove the bundle root itself', async () => {
    // `assertSkillPath` already refuses `''` at the IPC boundary, so this
    // exercises the runtime's own second line of defense directly.
    const skills = runtime();
    await skills.write('graphify', '---\nname: graphify\n---\n');

    await expect(skills.removeFile('graphify', '')).rejects.toThrow(
      /cannot remove the bundle root/i,
    );
    expect(await readdir(join(skillsDir(), 'graphify'))).toContain('SKILL.md');
  });

  it('refuses to remove the bundle root by a spelling other than the empty string', async () => {
    /*
      `''` was never the property that mattered — resolving to the root was.
      `symlink('..', up)` plus `up/graphify` clears `assertSkillPath` (no dot
      segment, no `..` segment in the *request* — the traversal happens on
      disk, not in the string) and resolves to the exact same root a string
      check on `''` alone would have missed entirely.
    */
    const skills = runtime();
    await skills.write('graphify', '---\nname: graphify\n---\n');
    await symlink('..', join(skillsDir(), 'graphify', 'up'));

    await expect(
      skills.removeFile('graphify', 'up/graphify'),
    ).rejects.toThrow(/cannot remove the bundle root/i);
    expect(await readdir(join(skillsDir(), 'graphify'))).toContain('SKILL.md');
  });

  it('lets a stale symlink pointing inside the bundle be deleted', async () => {
    /*
      Refusing to *climb past* an unresolvable link is right — that is the
      write-escape fix above. Refusing to *address* it at all is not: a
      dangling link is the ordinary accident of a dotfiles-managed skill
      folder (`index.ts`'s `exists()` names exactly this population), and one
      that declares a target still inside the bundle must stay deletable, or
      the pane's own Delete button fails forever with no recovery but a text
      editor.
    */
    const skills = runtime();
    await skills.write('graphify', '---\nname: graphify\n---\n');
    // Points at a sibling that was never created — dangling, and its
    // declared target resolves inside the root.
    await symlink('nonexistent.txt', join(skillsDir(), 'graphify', 'stale'));

    await expect(skills.removeFile('graphify', 'stale')).resolves.toBeDefined();
    expect(await readdir(join(skillsDir(), 'graphify'))).not.toContain('stale');
  });

  it('still refuses a stale symlink whose declared target is outside the bundle', async () => {
    // The fix above must not swing the other way: a dangling link is only
    // legitimate when what it *claims* to point to is inside the root.
    const skills = runtime();
    await skills.write('graphify', '---\nname: graphify\n---\n');
    const outside = await mkdtemp(join(tmpdir(), 'hive-outside-'));
    const outsideTarget = join(outside, 'not-yet.txt');
    try {
      await symlink(outsideTarget, join(skillsDir(), 'graphify', 'stale-outside'));

      await expect(
        skills.removeFile('graphify', 'stale-outside'),
      ).rejects.toThrow(/outside the skill folder/i);
      expect(await readdir(join(skillsDir(), 'graphify'))).toContain(
        'stale-outside',
      );
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });

  it('refuses to move SKILL.md out from under the skill', async () => {
    // The same recovery trap `removeFile` guards against, one verb over: a
    // successful move leaves a folder with no SKILL.md just as surely as a
    // delete would.
    const skills = runtime();
    await skills.write('graphify', '---\nname: graphify\n---\n');

    await expect(
      skills.moveFile('graphify', 'SKILL.md', 'archive.md'),
    ).rejects.toThrow(/SKILL\.md cannot be moved/i);
    expect(
      await readFile(join(skillsDir(), 'graphify', 'SKILL.md'), 'utf8'),
    ).toContain('name: graphify');
  });

  it('refuses to move the bundle root by a symlinked spelling', async () => {
    /*
      `removeFile` got this guard; `moveFile` did not, and
      `moveFile('graphify', 'up/graphify', 'archive')` was reachable the same
      way `removeFile`'s was. It happened to already fail — `rename(2)`
      refuses to move a directory into its own subtree with `EINVAL` — but
      that is a syscall accident standing in for a guard, not a defended
      trap, and this file's own rule is that every trap here is deliberate.
    */
    const skills = runtime();
    await skills.write('graphify', '---\nname: graphify\n---\n');
    await symlink('..', join(skillsDir(), 'graphify', 'up'));

    await expect(
      skills.moveFile('graphify', 'up/graphify', 'archive'),
    ).rejects.toThrow(/cannot move the bundle root/i);
    expect(await readdir(join(skillsDir(), 'graphify'))).toContain('SKILL.md');
  });
});

/**
 * The two `readFile` refusals — too-large and (covered above) binary — and
 * the shebang boundary that decides a written file's mode. Both numbers and
 * both edges are worth pinning down explicitly: they are the two places this
 * module's behaviour is a threshold rather than a rule, and a threshold with
 * no test drifts silently.
 */
describe('createSkillsRuntime file verbs — boundaries', () => {
  const skillsDir = (): string => join(hiveDir, 'skills');

  it('admits a file exactly at the size cap and refuses one byte over', async () => {
    const skills = runtime();
    await skills.write('graphify', '---\nname: graphify\n---\n');

    await writeFile(
      join(skillsDir(), 'graphify', 'at-cap.bin'),
      Buffer.alloc(MAX_BUNDLE_FILE_BYTES, 'a'),
    );
    await writeFile(
      join(skillsDir(), 'graphify', 'over-cap.bin'),
      Buffer.alloc(MAX_BUNDLE_FILE_BYTES + 1, 'a'),
    );

    const atCap = await skills.readFile('graphify', 'at-cap.bin');
    const overCap = await skills.readFile('graphify', 'over-cap.bin');

    expect(atCap.refused).toBeNull();
    expect(overCap.refused).toBe('too-large');
    expect(overCap.size).toBe(MAX_BUNDLE_FILE_BYTES + 1);
  });

  it('writes exactly "#!" as 755', async () => {
    const skills = runtime();
    await skills.write('graphify', '---\nname: graphify\n---\n');

    await skills.writeFile('graphify', 'run', '#!');

    const info = await stat(join(skillsDir(), 'graphify', 'run'));
    expect(info.mode & 0o777).toBe(0o755);
  });

  it('writes an empty file as 644', async () => {
    const skills = runtime();
    await skills.write('graphify', '---\nname: graphify\n---\n');

    await skills.writeFile('graphify', 'empty.txt', '');

    const info = await stat(join(skillsDir(), 'graphify', 'empty.txt'));
    expect(info.mode & 0o777).toBe(0o644);
  });

  it('writes a leading-space shebang as 644, not 755', async () => {
    // `#!` must be the first two bytes. The kernel would not execute this
    // either, so 644 is the correct answer, not a near-miss.
    const skills = runtime();
    await skills.write('graphify', '---\nname: graphify\n---\n');

    await skills.writeFile('graphify', 'run.sh', ' #!/bin/sh\necho hi\n');

    const info = await stat(join(skillsDir(), 'graphify', 'run.sh'));
    expect(info.mode & 0o777).toBe(0o644);
  });

  it('writes a leading-newline shebang as 644, not 755', async () => {
    const skills = runtime();
    await skills.write('graphify', '---\nname: graphify\n---\n');

    await skills.writeFile('graphify', 'run.sh', '\n#!/bin/sh\necho hi\n');

    const info = await stat(join(skillsDir(), 'graphify', 'run.sh'));
    expect(info.mode & 0o777).toBe(0o644);
  });

  it('writes a BOM-prefixed shebang as 644, not 755', async () => {
    const skills = runtime();
    await skills.write('graphify', '---\nname: graphify\n---\n');

    await skills.writeFile('graphify', 'run.sh', '﻿#!/bin/sh\necho hi\n');

    const info = await stat(join(skillsDir(), 'graphify', 'run.sh'));
    expect(info.mode & 0o777).toBe(0o644);
  });

  it('drops back to 644 when a shebang file is rewritten as plain text', async () => {
    const skills = runtime();
    await skills.write('graphify', '---\nname: graphify\n---\n');
    await skills.writeFile('graphify', 'run.sh', '#!/bin/sh\necho hi\n');

    await skills.writeFile('graphify', 'run.sh', 'no longer a script\n');

    const info = await stat(join(skillsDir(), 'graphify', 'run.sh'));
    expect(info.mode & 0o777).toBe(0o644);
  });
});
