// @vitest-environment node
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';

import { beforeAll, describe, expect, it } from 'vitest';

import { writePluginDir } from '../../electron/main/skills/plugin';
import type { SkillsRead } from '../../electron/main/skills/read';

/**
 * Custom-skills conformance: a real `claude`, actually run (HIVE-96).
 *
 * ## Why this is not covered by the unit tests next door
 *
 * `plugin.test.ts` asserts the *shape* of the generated directory — that the
 * manifest names the plugin `hive`, that `skills/<name>/SKILL.md` exists, that a
 * deleted skill is pruned. Every one of those assertions was written against the
 * same belief about what `claude --plugin-dir` does with that directory. A
 * manifest field the binary ignores, a layout it does not recognise, or a skill
 * that loads under a namespaced name would pass all of them and still ship a
 * feature where none of the commands exist.
 *
 * So this runs the binary: a real `claude`, a real generated plugin, and the
 * three claims the whole story rests on.
 *
 * 1. **A skill the app generated is available**, by its bare name.
 * 2. **`/done` is available**, which is what HIVE-93 builds on.
 * 3. **The same binary, in the same directory, without the flag, has neither** —
 *    the app-only half, and the entire reason `--plugin-dir` was chosen over
 *    writing to `~/.claude`.
 * 4. **The user's own configuration is untouched.**
 *
 * ## What "untouched" is asserted over, and why against the real home
 *
 * Remapping `HOME` to a temp directory was tried first and abandoned, which is
 * worth recording so it is not tried again. `claude` then has no login —
 * "Not logged in · Please run /login" — and every assertion below passes
 * *vacuously*, which is worse than no test. Copying `.credentials.json` across
 * does not rescue it either: the file on disk is stale, and the live token is
 * refreshed somewhere this test cannot reach. `hook-conformance.test.ts` runs
 * against the real environment for the same reason.
 *
 * So the fingerprint is taken over the developer's own `~/.claude`, and it is
 * deliberately narrow: `settings.json`, the plugin registry, and the `skills/`
 * and `plugins/` listings. **Not** the whole tree — `claude` always writes a
 * conversation transcript under `projects/` and appends to `history.jsonl`, so
 * a whole-tree diff would fail on every run for a reason that has nothing to do
 * with this feature, and a test that fails for the wrong reason gets deleted
 * rather than read.
 *
 * Those four are exactly the things installing a plugin *would* move, which is
 * what makes this the honest version of the claim rather than a weakened one.
 *
 * ## Why it is opt-in
 *
 * It spawns a real `claude`, which costs real tokens and takes tens of seconds.
 * That is a different risk profile from the rest of the suite, which is exactly
 * the line `tests/live/` exists to draw. Run it with:
 *
 * ```
 * pnpm test:skills
 * ```
 */
const enabled = process.env.HIVE_LIVE_SKILLS_PROOF === '1';

/** The marker a loaded skill is asked to print, and nothing else. */
const MARKER = 'HIVE_SKILL_MARKER_OK';

/** A fixture skill whose whole job is to be unmistakably present. */
const FIXTURE: SkillsRead = {
  skills: [
    {
      name: 'hive-marker',
      description: 'Print a fixed marker so a test can prove this skill loaded',
      body: `---
name: hive-marker
description: Print a fixed marker so a test can prove this skill loaded
disable-model-invocation: true
---

Reply with exactly this text and nothing else: ${MARKER}
`,
      path: '/fixture/hive-marker/SKILL.md',
    },
  ],
  invalid: [],
};

/**
 * The parts of a Claude Code home this feature must not touch.
 *
 * A directory is folded to its sorted entry names rather than its contents:
 * what matters is that `--plugin-dir` did not *install* anything, and a
 * cache file changing size inside `plugins/` is not that.
 */
const fingerprint = (home: string): string => {
  const parts: string[] = [];

  for (const file of [
    'settings.json',
    join('plugins', 'installed_plugins.json'),
    join('plugins', 'config.json'),
  ]) {
    try {
      parts.push(`${file}:${readFileSync(join(home, '.claude', file), 'utf8')}`);
    } catch {
      // Absent is a state worth pinning too: the feature must not create these.
      parts.push(`${file}:<absent>`);
    }
  }

  for (const dir of ['skills', 'plugins']) {
    try {
      parts.push(`${dir}/:${readdirSync(join(home, '.claude', dir)).sort().join(',')}`);
    } catch {
      parts.push(`${dir}/:<absent>`);
    }
  }

  return createHash('sha256').update(parts.join('\n')).digest('hex');
};

/** Run `claude` in a throwaway directory, and hand back whatever it printed. */
const claude = (
  cwd: string,
  args: readonly string[],
): Promise<{ stdout: string; stderr: string }> =>
  new Promise((resolve) => {
    execFile(
      'claude',
      [...args, '--model', 'haiku', '-p'],
      { cwd, timeout: 180_000, maxBuffer: 10 * 1024 * 1024 },
      (_error, stdout, stderr) => resolve({ stdout, stderr }),
    );
  });

describe.skipIf(!enabled)('custom skills conformance', () => {
  let home: string;
  let cwd: string;
  let pluginRoot: string;

  beforeAll(async () => {
    /*
      The real home, for the login — see the note at the top of this file for
      why the temp-home version of this test could not work. `cwd` is still a
      throwaway directory, so the transcript this leaves behind is filed under a
      path that belongs to nothing.
    */
    home = homedir();
    cwd = mkdtempSync(join(tmpdir(), 'hive-skills-cwd-'));
    pluginRoot = join(mkdtempSync(join(tmpdir(), 'hive-skills-plugin-')), 'plugin');

    await writePluginDir(pluginRoot, '0.0.0-test', FIXTURE);
  });

  it(
    'makes a generated skill available by its bare name',
    { timeout: 300_000 },
    async () => {
      /*
        The bare name is the assertion, not an incidental detail. A plugin skill
        surfacing as `/hive:hive-marker` would still "work" and would still
        make every piece of copy in the Settings pane wrong.
      */
      const { stdout } = await claude(cwd, [
        '--plugin-dir',
        pluginRoot,
        '/hive-marker',
      ]);

      expect(stdout).toContain(MARKER);
    },
  );

  it('makes the built-in /done available', { timeout: 300_000 }, async () => {
    // HIVE-93 builds its session teardown on this command existing. What it
    // *does* is that story's; that it resolves at all is this one's.
    const { stdout } = await claude(cwd, ['--plugin-dir', pluginRoot, '/done']);

    expect(stdout).not.toMatch(/unknown command/i);
  });

  it(
    'leaves the same binary without the flag knowing neither',
    { timeout: 300_000 },
    async () => {
      /*
        The whole point of the story. If this ever passes by accident — because
        something wrote to the user's config — the feature has become the thing
        it was designed not to be.
      */
      const marker = await claude(cwd, ['/hive-marker']);
      const done = await claude(cwd, ['/done']);

      expect(marker.stdout + marker.stderr).toMatch(/unknown command/i);
      expect(done.stdout + done.stderr).toMatch(/unknown command/i);
    },
  );

  it(
    'writes nothing into the user’s own configuration',
    { timeout: 300_000 },
    async () => {
      const before = fingerprint(home);

      await claude(cwd, ['--plugin-dir', pluginRoot, '/hive-marker']);

      expect(fingerprint(home)).toBe(before);
    },
  );
});
