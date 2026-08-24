// @vitest-environment node
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { beforeEach, describe, expect, it } from 'vitest';

import { readUserSkills } from '../../../../electron/main/skills/read';

let root: string;

beforeEach(async () => {
  root = join(await mkdtemp(join(tmpdir(), 'hive-skills-')), 'skills');
});

const write = async (name: string, contents: string): Promise<void> => {
  await mkdir(join(root, name), { recursive: true });
  await writeFile(join(root, name, 'SKILL.md'), contents, 'utf8');
};

const valid = (name: string): string =>
  `---\nname: ${name}\ndescription: does a thing\n---\nDo the thing.\n`;

describe('readUserSkills', () => {
  it('reads a valid skill, carrying its body verbatim', async () => {
    await write('standup', valid('standup'));

    const read = await readUserSkills(root);

    expect(read.invalid).toEqual([]);
    expect(read.skills).toHaveLength(1);
    expect(read.skills[0]?.name).toBe('standup');
    expect(read.skills[0]?.description).toBe('does a thing');
    expect(read.skills[0]?.body).toBe(valid('standup'));
  });

  it('carries an empty description when the file declares none', async () => {
    /*
      Not an error. `description` is Claude Code's business, and a skill without
      one still loads — so the pane renders the blank rather than refusing a
      file the binary would have accepted.
    */
    await write('terse', '---\nname: terse\n---\nDo it.\n');

    const read = await readUserSkills(root);

    expect(read.invalid).toEqual([]);
    expect(read.skills[0]?.description).toBe('');
  });

  it('treats a missing root as a user who has written none', async () => {
    // The directory is created the first time a skill is saved, so its absence
    // is the ordinary first-run state rather than something to report.
    const read = await readUserSkills(join(root, 'nope'));

    expect(read).toEqual({ skills: [], invalid: [] });
  });

  it('refuses a file with no frontmatter, and says why', async () => {
    await write('bare', 'Just prose, no frontmatter.\n');

    const read = await readUserSkills(root);

    expect(read.skills).toEqual([]);
    expect(read.invalid[0]?.name).toBe('bare');
    expect(read.invalid[0]?.reason).toMatch(/frontmatter/i);
  });

  it('refuses a header that never closes', async () => {
    // An opening fence alone is the half-typed state, and Claude Code reads the
    // whole file as prose — which loses the skill silently.
    await write('half', '---\nname: half\ndescription: d\nDo it.\n');

    const read = await readUserSkills(root);

    expect(read.skills).toEqual([]);
    expect(read.invalid[0]?.reason).toMatch(/frontmatter/i);
  });

  it('refuses frontmatter whose name disagrees with the folder', async () => {
    await write('standup', valid('stand-up'));

    const read = await readUserSkills(root);

    expect(read.skills).toEqual([]);
    expect(read.invalid[0]?.reason).toMatch(/folder/i);
  });

  it('refuses frontmatter that declares no name at all', async () => {
    await write('nameless', '---\ndescription: d\n---\nDo it.\n');

    const read = await readUserSkills(root);

    expect(read.skills).toEqual([]);
    expect(read.invalid[0]?.reason).toMatch(/no name/i);
  });

  it('refuses the reserved name, because the app owns it', async () => {
    await write('done', valid('done'));

    const read = await readUserSkills(root);

    expect(read.skills).toEqual([]);
    expect(read.invalid[0]?.reason).toMatch(/reserved/i);
  });

  it('refuses a folder name the pattern does not admit', async () => {
    await write('Bad Name', valid('Bad Name'));

    const read = await readUserSkills(root);

    expect(read.skills).toEqual([]);
    expect(read.invalid[0]?.reason).toMatch(/lowercase/i);
  });

  it('refuses a folder with no SKILL.md in it', async () => {
    await mkdir(join(root, 'empty'), { recursive: true });

    const read = await readUserSkills(root);

    expect(read.skills).toEqual([]);
    expect(read.invalid[0]?.reason).toMatch(/no skill\.md/i);
  });

  it('ignores a loose file beside the skill folders', async () => {
    // `~/.hive/skills/README.md` is a thing a person writes. It is not a
    // skill, and it is not a problem either.
    await mkdir(root, { recursive: true });
    await writeFile(join(root, 'README.md'), 'notes', 'utf8');

    const read = await readUserSkills(root);

    expect(read).toEqual({ skills: [], invalid: [] });
  });

  it('lets one bad skill sit beside a good one', async () => {
    await write('standup', valid('standup'));
    await write('Bad Name', valid('Bad Name'));

    const read = await readUserSkills(root);

    expect(read.skills.map((s) => s.name)).toEqual(['standup']);
    expect(read.invalid).toHaveLength(1);
  });

  it('sorts by name, so the pane does not reorder between reads', async () => {
    await write('triage', valid('triage'));
    await write('standup', valid('standup'));

    const read = await readUserSkills(root);

    expect(read.skills.map((s) => s.name)).toEqual(['standup', 'triage']);
  });
});
