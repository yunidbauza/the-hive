// @vitest-environment node
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { isSkillManifest, resolveInSkill } from '../../../../electron/main/skills/paths';

/**
 * `resolveInSkill` and `isSkillManifest`, tested directly (HIVE-148 review).
 *
 * Both used to be covered only indirectly, through `index.test.ts`'s runtime
 * verbs — `writeFile`, `removeFile`, `moveFile` — which meant the containment
 * guard behind every one of them had no test of its own to look for where the
 * repo's own mirror rule says to look. `resolveInSkill` is what stands between
 * a hand-editable, symlink-friendly `~/.hive/skills` and every write main
 * performs, and the escape table below is duplicated rather than moved out of
 * `index.test.ts`: that file keeps proving the *runtime verbs* refuse an
 * escape end to end, and this file proves the *guard itself* does, with
 * nothing else in the way.
 */

let hiveDir: string;
const skillsDir = (): string => join(hiveDir, 'skills');

beforeEach(async () => {
  const base = await mkdtemp(join(tmpdir(), 'hive-paths-'));
  hiveDir = join(base, 'hive-home');
  await mkdir(hiveDir, { recursive: true });
  /*
    `skillsRoot()` is `dirname(configPath())/skills`, and `configPath()` reads
    this variable on every call — the property that lets a test relocate the
    skills tree instead of writing into the developer's own.
  */
  process.env.HIVE_CONFIG_PATH = join(hiveDir, 'config.json');
});

afterEach(() => {
  delete process.env.HIVE_CONFIG_PATH;
});

/** A minimal skill folder, with nothing beyond what `resolveInSkill` needs. */
async function skill(name: string): Promise<void> {
  await mkdir(join(skillsDir(), name), { recursive: true });
  await writeFile(
    join(skillsDir(), name, 'SKILL.md'),
    `---\nname: ${name}\n---\nBody.\n`,
    'utf8',
  );
}

/**
 * The bundle root as `resolveInSkill` itself would report it.
 *
 * `resolveInSkill` `realpath`s the root before joining anything onto it — on
 * macOS, `$TMPDIR` sits under a `/var` that is itself a symlink to
 * `/private/var`, so the raw `skillsDir()` string and what this module
 * actually returns disagree by that prefix. Tests that assert an *exact*
 * resolved path build the expectation through this, not through `join`
 * directly on `skillsDir()`.
 */
const resolvedRoot = (name: string): Promise<string> =>
  realpath(join(skillsDir(), name));

describe('resolveInSkill', () => {
  it('resolves an ordinary relative path against the bundle root', async () => {
    await skill('graphify');

    const resolved = await resolveInSkill('graphify', 'scripts/build.py');

    expect(resolved).toBe(
      join(await resolvedRoot('graphify'), 'scripts', 'build.py'),
    );
  });

  it('admits a path that does not exist yet, for writeFile and mkdir', async () => {
    await skill('graphify');

    await expect(resolveInSkill('graphify', 'never/created/yet.txt')).resolves.toBe(
      join(await resolvedRoot('graphify'), 'never', 'created', 'yet.txt'),
    );
  });

  it('refuses a path that escapes the skill root through a symlink', async () => {
    await skill('graphify');
    const outside = await mkdtemp(join(tmpdir(), 'hive-outside-'));
    try {
      await writeFile(join(outside, 'secret.txt'), 'no', 'utf8');
      await symlink(outside, join(skillsDir(), 'graphify', 'escape'));

      /*
        Fails *because it escapes*, not because the target is missing:
        `secret.txt` exists before the link does, so a resolver that only
        checked `ENOENT` would find it and resolve straight through.
      */
      await expect(
        resolveInSkill('graphify', 'escape/secret.txt'),
      ).rejects.toThrow(/outside the skill folder/i);
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });

  it('refuses a dangling symlink whose target would resolve outside the bundle', async () => {
    // `realpath` throws `ENOENT` for a path that genuinely does not exist yet
    // *and* for a dangling symlink. Only `lstat` tells the two apart.
    await skill('graphify');
    const outside = await mkdtemp(join(tmpdir(), 'hive-outside-'));
    try {
      await symlink(
        join(outside, 'not-yet.txt'),
        join(skillsDir(), 'graphify', 'escape'),
      );

      await expect(
        resolveInSkill('graphify', 'escape'),
      ).rejects.toThrow(/outside the skill folder/i);
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });

  it('refuses a link whose declared target transits another symlink out of the bundle', async () => {
    /*
      `esc -> <outside>` is a real, resolvable link; `hop`'s own declared
      target reads `./esc/leaf.txt`, which looks contained as a *string* —
      only resolving `esc` for real reveals where it actually goes. A lexical
      `path.join` check reopens exactly this escape.
    */
    await skill('graphify');
    const outside = await mkdtemp(join(tmpdir(), 'hive-outside-'));
    try {
      await symlink(outside, join(skillsDir(), 'graphify', 'esc'));
      await symlink('./esc/leaf.txt', join(skillsDir(), 'graphify', 'hop'));

      await expect(resolveInSkill('graphify', 'hop')).rejects.toThrow(
        /outside the skill folder/i,
      );
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });

  it('refuses a chain of dangling symlinks that ends outside the bundle', async () => {
    // Each hop is validated on its own account: three hops deep, none of them
    // resolvable, the last one declaring a target outside the root.
    await skill('graphify');
    const outside = await mkdtemp(join(tmpdir(), 'hive-outside-'));
    try {
      await symlink('./chainB', join(skillsDir(), 'graphify', 'chainA'));
      await symlink('./chainC', join(skillsDir(), 'graphify', 'chainB'));
      await symlink(
        join(outside, 'chain.txt'),
        join(skillsDir(), 'graphify', 'chainC'),
      );

      await expect(resolveInSkill('graphify', 'chainA')).rejects.toThrow(
        /outside the skill folder/i,
      );
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });

  /*
    The `..`-after-a-symlinked-component escape, as a class rather than the
    one or two spellings that happened to get reported — `index.test.ts`'s own
    table, kept in full because this is the bug this module has been fixed for
    four times, one spelling at a time. Every `hop` here is IPC-legal — no dot
    segment, depth 1 or 2 — so `assertSkillPath` admits it and `resolveInSkill`
    is the only thing standing in the way.
  */
  const escapes: {
    what: string;
    target: string;
    plant?: (bundle: string, live: string) => Promise<void>;
    lands: 'outside' | 'skills-tree';
  }[] = [
    { what: 'the reported spelling', target: './esc/../PWNED.txt', lands: 'outside' },
    { what: 'no leading dot', target: 'esc/../PWNED.txt', lands: 'outside' },
    { what: 'a dot mid-path', target: './esc/./../PWNED.txt', lands: 'outside' },
    { what: 'a doubled separator', target: './esc//../PWNED.txt', lands: 'outside' },
    {
      what: 'repeated dot segments',
      target: './esc/./././../PWNED.txt',
      lands: 'outside',
    },
    {
      what: 'a .. that is not adjacent to the link',
      target: './esc/sub/../../PWNED.txt',
      plant: async (_bundle, live) => {
        await mkdir(join(live, 'sub'), { recursive: true });
      },
      lands: 'outside',
    },
    {
      what: 'the symlinked component a level down',
      target: './sub/esc/../PWNED.txt',
      plant: async (bundle, live) => {
        await mkdir(join(bundle, 'sub'), { recursive: true });
        await symlink(live, join(bundle, 'sub', 'esc'));
      },
      lands: 'outside',
    },
    {
      what: 'a link to . landing in the skills tree',
      target: './here/../PWNED.txt',
      plant: async (bundle) => {
        await symlink('.', join(bundle, 'here'));
      },
      lands: 'skills-tree',
    },
  ];

  it.each(escapes)(
    'refuses an escape that puts .. after a symlink — $what',
    async ({ target, plant, lands }) => {
      await skill('graphify');
      const bundle = join(skillsDir(), 'graphify');
      const outside = await mkdtemp(join(tmpdir(), 'hive-outside-'));
      try {
        const live = join(outside, 'live');
        await mkdir(live, { recursive: true });
        await symlink(live, join(bundle, 'esc'));
        await plant?.(bundle, live);
        await symlink(target, join(bundle, 'hop'));

        const landing =
          lands === 'outside'
            ? join(outside, 'PWNED.txt')
            : join(skillsDir(), 'PWNED.txt');

        await expect(resolveInSkill('graphify', 'hop')).rejects.toThrow(
          /outside the skill folder/i,
        );
        // Nothing must have landed at the far end — the resolver never
        // handed `hop` back to a caller that would have written through it.
        await expect(readFile(landing, 'utf8')).rejects.toThrow();
      } finally {
        await rm(outside, { recursive: true, force: true });
      }
    },
  );

  it('refuses the same escape through a legitimately symlinked skill root', async () => {
    // `resolveInSkill` `realpath`s the root before anything else — the
    // dotfiles case `read.ts` supports — so the class above must keep working
    // against a bundle that is itself a link.
    const elsewhere = await mkdtemp(join(tmpdir(), 'hive-bundle-'));
    const outside = await mkdtemp(join(tmpdir(), 'hive-outside-'));
    try {
      await writeFile(
        join(elsewhere, 'SKILL.md'),
        '---\nname: linked\n---\nB.\n',
        'utf8',
      );
      await mkdir(skillsDir(), { recursive: true });
      await symlink(elsewhere, join(skillsDir(), 'linked'));
      const live = join(outside, 'live');
      await mkdir(live, { recursive: true });
      await symlink(live, join(elsewhere, 'esc'));
      await symlink('./esc/../PWNED.txt', join(elsewhere, 'hop'));

      await expect(resolveInSkill('linked', 'hop')).rejects.toThrow(
        /outside the skill folder/i,
      );
      await expect(
        readFile(join(outside, 'PWNED.txt'), 'utf8'),
      ).rejects.toThrow();
    } finally {
      await rm(elsewhere, { recursive: true, force: true });
      await rm(outside, { recursive: true, force: true });
    }
  });

  it('refuses a cycle whose every hop crosses the bundle boundary', async () => {
    /*
      `cyc1 -> ./esc/../cyc2` and back again. Neither ever resolves, so this is
      the shape where a hop budget could quietly stand in for the containment
      check — refused on containment, at the first hop, not on exhaustion.
    */
    await skill('graphify');
    const outside = await mkdtemp(join(tmpdir(), 'hive-outside-'));
    try {
      const live = join(outside, 'live');
      await mkdir(live, { recursive: true });
      await symlink(live, join(skillsDir(), 'graphify', 'esc'));
      await symlink('./esc/../cyc2', join(skillsDir(), 'graphify', 'cyc1'));
      await symlink('./esc/../cyc1', join(skillsDir(), 'graphify', 'cyc2'));

      await expect(resolveInSkill('graphify', 'cyc1')).rejects.toThrow(
        /outside the skill folder/i,
      );
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });

  it('refuses a link whose .. climbs out of a symlinked directory', async () => {
    // The `..` sits inside a link nested under another link, not beside the
    // request itself: `d -> ./inner`, and `inner/xout`'s own target climbs
    // two levels from there, landing in the skills tree.
    await skill('graphify');
    await mkdir(join(skillsDir(), 'graphify', 'inner'), { recursive: true });
    await symlink('./inner', join(skillsDir(), 'graphify', 'd'));
    await symlink(
      '../../PWNED.txt',
      join(skillsDir(), 'graphify', 'inner', 'xout'),
    );

    await expect(resolveInSkill('graphify', 'd/xout')).rejects.toThrow(
      /outside the skill folder/i,
    );
    await expect(
      readFile(join(skillsDir(), 'PWNED.txt'), 'utf8'),
    ).rejects.toThrow();
  });

  it('refuses rather than falls through when the link-hop budget runs out, and admits one hop short of it', async () => {
    /*
      Eleven dangling links ending at a name that was never created — the
      eleventh hop is the one past `MAX_LINK_HOPS`. The same chain one link
      shorter is admitted, pinning the boundary from both sides rather than a
      blanket refusal an over-strict implementation would also satisfy.
    */
    await skill('graphify');
    for (let i = 1; i <= 11; i += 1) {
      await symlink(
        `./l${String(i + 1)}`,
        join(skillsDir(), 'graphify', `l${String(i)}`),
      );
    }

    await expect(resolveInSkill('graphify', 'l1')).rejects.toThrow(
      /outside the skill folder/i,
    );
    await expect(resolveInSkill('graphify', 'l2')).resolves.toContain('l2');
  });

  it('allows a link that climbs out of the bundle and straight back in', async () => {
    // The over-refusal side of the same check: `back -> ../graphify/ok.txt`
    // leaves the bundle lexically and returns. The rule is where a path
    // *lands*, not whether it stayed on the way, and this holds whether the
    // target exists or dangles.
    await skill('graphify');
    await writeFile(join(skillsDir(), 'graphify', 'ok.txt'), 'fine', 'utf8');
    await symlink('../graphify/ok.txt', join(skillsDir(), 'graphify', 'back'));

    await expect(resolveInSkill('graphify', 'back')).resolves.toBe(
      join(await resolvedRoot('graphify'), 'back'),
    );

    await rm(join(skillsDir(), 'graphify', 'ok.txt'));
    // Still admitted while dangling — this is the writable-target case
    // `writeFile` relies on to reach through the link at all.
    await expect(resolveInSkill('graphify', 'back')).resolves.toBe(
      join(await resolvedRoot('graphify'), 'back'),
    );
  });
});

describe('isSkillManifest', () => {
  it('matches the literal SKILL.md path', async () => {
    await skill('graphify');
    const path = await resolveInSkill('graphify', 'SKILL.md');

    expect(await isSkillManifest('graphify', path)).toBe(true);
  });

  it('does not match an ordinary file in the same bundle', async () => {
    await skill('graphify');
    await writeFile(join(skillsDir(), 'graphify', 'notes.md'), 'x', 'utf8');
    const path = await resolveInSkill('graphify', 'notes.md');

    expect(await isSkillManifest('graphify', path)).toBe(false);
  });

  /*
    `self -> .` makes `self/SKILL.md` a second, symlinked name for the exact
    same file — clears `assertSkillPath` (no dot segment, depth 2) and
    resolves to the same canonical path a string comparison would miss.
  */
  it('matches a symlinked alias that resolves to the same file', async () => {
    await skill('graphify');
    await symlink('.', join(skillsDir(), 'graphify', 'self'));
    const path = await resolveInSkill('graphify', 'self/SKILL.md');

    expect(await isSkillManifest('graphify', path)).toBe(true);
    // And it is genuinely a different string from the canonical path — the
    // property a request-string comparison would have missed.
    expect(path).not.toBe(
      await realpath(join(skillsDir(), 'graphify', 'SKILL.md')),
    );
  });

  it('answers false for a path nothing is sitting on', async () => {
    await skill('graphify');
    const path = join(skillsDir(), 'graphify', 'never-created.txt');

    expect(await isSkillManifest('graphify', path)).toBe(false);
  });

  it('answers false when the bundle itself has no SKILL.md to protect', async () => {
    // Reachable via a hand-edited skill folder with the manifest deleted out
    // from under it — `readUserSkills` would report it invalid, but
    // `isSkillManifest` is asked before that distinction is made.
    await mkdir(join(skillsDir(), 'ghost'), { recursive: true });
    const path = join(skillsDir(), 'ghost', 'anything.txt');

    expect(await isSkillManifest('ghost', path)).toBe(false);
  });
});
