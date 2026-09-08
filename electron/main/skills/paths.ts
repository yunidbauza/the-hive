import { lstat, readlink, realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join } from 'node:path';

import { configPath } from '../config/paths';
import { contains } from '../fs/contains';

/**
 * Where the user's skills and the generated plugin live (HIVE-96).
 *
 * Two roots, and they are deliberately not the same place. `~/.hive/skills` is
 * the **user's** — hand-editable, backed up with their dotfiles, and the thing
 * Settings writes. `<userData>/hive/plugin` is the **app's** — regenerated from
 * the first, never edited by hand, and disposable. `hooks/settings.ts` draws the
 * same line for the same reason.
 */

/**
 * The skills tree, derived from the config file rather than from `homedir()`.
 *
 * `configPath()` honours `HIVE_CONFIG_PATH`, which story 085's Playwright
 * fixture sets per test. Deriving this from it means a test that relocates the
 * config relocates the skills with it; reaching for `homedir()` here would have
 * every e2e run write into the developer's own `~/.hive` — and the e2e step
 * this story adds creates a skill, so that would not stay theoretical.
 *
 * Read per call rather than captured, for the reason `configPath` itself gives:
 * a value frozen at import time lets the first spec to load this module decide
 * the path for all of them.
 */
export const skillsRoot = (): string => join(dirname(configPath()), 'skills');

/**
 * Where the generated plugin lives inside userData, beside the hook settings.
 *
 * A path *segment* rather than an absolute path, like `HOOK_SETTINGS_DIR` and
 * `METRICS_SCRIPT_FILE` next door: the absolute form needs `app.getPath`, which
 * only the process that has Electron can call, and keeping the constant
 * relative is what lets this module's tests run under plain Node.
 */
export const PLUGIN_DIR = join('hive', 'plugin');

/**
 * Claude Code's own configuration directory — **not** The Hive's.
 *
 * A third root, and the first one here that belongs to another application.
 * It is read, never written: an agent is a `claude -p` process, so the skills
 * and plugins the user installed for themselves are skills that process can
 * already reach, and `available.ts` needs to know their names to stop refusing
 * them.
 *
 * `CLAUDE_CONFIG_DIR` is Claude Code's own override and is honoured for the
 * reason `configPath()` honours `HIVE_CONFIG_PATH`: a spec that does not set it
 * reads the developer's real `~/.claude`, and its expectations then depend on
 * which plugins happened to be installed that week.
 *
 * `agents-settings.spec.ts` sets it per launch rather than the shared fixture
 * doing so for everyone: other specs in that project spawn a **real** `claude`,
 * and relocating that binary's own configuration directory is not something to
 * do to them in passing.
 */
export const claudeRoot = (): string =>
  process.env['CLAUDE_CONFIG_DIR'] ?? join(homedir(), '.claude');

/** The user's own skills, which The Hive lists but does not manage. */
export const userSkillsRoot = (): string => join(claudeRoot(), 'skills');

/**
 * Which plugins are installed, and where each one's active version lives.
 *
 * The registry rather than a glob over the cache: several versions of one
 * plugin can sit on disk at once, and only this file says which is current.
 */
export const installedPluginsFile = (): string =>
  join(claudeRoot(), 'plugins', 'installed_plugins.json');

/** Thrown by {@link resolveInSkill} for any path that resolves outside its root. */
export class OutsideSkillError extends Error {
  constructor() {
    super('That path is outside the skill folder.');
    this.name = 'OutsideSkillError';
  }
}

/**
 * Resolve a skill-relative path against the skill's own folder, or refuse.
 *
 * The second half of the check `assertSkillPath` explicitly is not. That guard
 * inspects a string, and a symlink is a fact about the disk: a bundle
 * containing `escape -> /etc` passes every string rule and still leaves the
 * root. `fs/paths.ts` draws exactly this line, and this is the skills copy of
 * it rather than a call into it, because that module resolves against a
 * *project* the config knows and this one resolves against a directory main
 * owns outright.
 *
 * The root is `realpath`'d too, so a symlinked `~/.hive` — the dotfiles case,
 * which `read.ts` deliberately supports — does not make every path look
 * outside.
 *
 * The nearest existing ancestor is resolved rather than the target, because
 * `writeFile` and `mkdir` are told about paths that do not exist yet.
 *
 * ## What this check does *not* close, and why that is a documented choice
 *
 * This is a point-in-time assertion, checked once when the function returns
 * — it is not `O_NOFOLLOW` and there is no dirfd-relative re-check at the
 * moment the caller actually reads or writes. Between the return and the
 * following syscall, a symlink could in principle be planted at the resolved
 * path and followed straight through it.
 *
 * That gap is deliberately left open rather than closed. Closing it properly
 * needs `O_NOFOLLOW` plus a dirfd-relative write path through every verb in
 * this module, which is a substantial rewrite — and the only actor who could
 * win that race already has write access to the user's own `~/.hive/skills`
 * between two syscalls of *this* process, at which point planting a symlink
 * buys them nothing they could not already do by writing the file directly.
 * Main is the only writer to this tree; the check holds for every path that
 * does not require a second, adversarial writer racing this process on its
 * own machine.
 *
 * ## Why `realpath` failing is not the same as "nothing is there"
 *
 * `realpath` throws `ENOENT` for a path that genuinely does not exist yet —
 * the ordinary case `writeFile` and `mkdir` are built for — but it throws the
 * *same* `ENOENT` for a **dangling symlink**, whose target is absent but which
 * is very much sitting on disk. Climbing past that on the strength of the
 * error alone approves a path the check never actually saw through: `escape ->
 * /tmp/nonexistent` climbs straight to a resolvable ancestor, and `writeFile`
 * then follows the link and lands outside the root with no error at all.
 *
 * `lstat`, which does not follow the final link, is what tells "present but
 * unresolvable" from "actually absent" apart — and only the second is safe to
 * climb past. `ELOOP` (a link cycle) is closed by the same test: `lstat` sees
 * the cycling link itself even though `realpath` cannot follow through it.
 *
 * `EACCES` on some ancestor is the one case this does **not** distinguish —
 * `lstat` fails there exactly as `realpath` did, so the loop still climbs past
 * it and returns a target this function never actually validated. Left as-is
 * rather than closed, because it is not exploitable: the same permission that
 * defeated `lstat` defeats the write or read that would follow, so nothing
 * escapes — this is a gap in what the check *proves*, not in what it
 * *protects*.
 *
 * ## Present, unresolvable, and legitimate: a dangling link inside the bundle
 *
 * A dangling link is not automatically hostile. `index.ts`'s `exists()`
 * already names the population most likely to have one: dotfiles-managed
 * skill folders, where a stale symlink pointing at a file the user since
 * moved or deleted is an ordinary accident, not an attack. Refusing to
 * *climb past* an unresolvable link is right — that is what stops the write
 * escape above — but refusing to *address* it at all would leave that stale
 * link permanently stuck: undeletable, unmovable, with the pane's own Delete
 * button always failing and no way back except a text editor.
 *
 * So a present-but-unresolvable entry that is a symlink gets one more look:
 * `readlink` gives its raw, unfollowed target, resolved against the
 * directory that contains it — the same relative-target semantics the
 * kernel itself uses. If that resolves inside the root, the link is treated
 * as a legitimate (if broken) member of the bundle and this returns
 * normally, so `removeFile` and `moveFile` can still reach it — `rm` and
 * `rename` act on the link entry itself and never need to follow it. Only a
 * link that *claims* to point outside the root is refused.
 */
export async function resolveInSkill(
  name: string,
  path: string,
): Promise<string> {
  const root = await realpath(join(skillsRoot(), name));
  const target = join(root, path);

  let probe = target;
  for (;;) {
    let real;
    try {
      real = await realpath(probe);
    } catch {
      /*
        `realpath` failed, for one of several reasons — and a class rather
        than a message match is what tells them apart safely: reading
        English here would be one reworded string away from treating an
        escape as a missing file and walking on up the tree.

        `lstat` does not follow the final link, so it sees an entry sitting
        at `probe` even when `realpath` could not resolve all the way
        through it. Nothing there at all is the only case safe to climb past.
      */
      let entry;
      try {
        entry = await lstat(probe);
      } catch {
        entry = null;
      }

      if (entry !== null) {
        /*
          Something is here. A plain file or directory that `lstat` can see
          but `realpath` cannot resolve is refused outright — that
          combination is not the dangling-link case this function is built
          to repair, and refusing is the safe default when the reason is
          unclear (see the `EACCES` paragraph above).

          A symlink gets the one-hop check the docblock describes: where does
          it *claim* to point, resolved relative to the directory holding it?
          Inside the root, it stays addressable. Outside, or unreadable, it
          is refused exactly as before.
        */
        if (!entry.isSymbolicLink()) throw new OutsideSkillError();

        let linkTarget: string;
        try {
          linkTarget = await readlink(probe);
        } catch {
          throw new OutsideSkillError();
        }

        const candidate = isAbsolute(linkTarget)
          ? linkTarget
          : join(dirname(probe), linkTarget);

        if (!contains(root, candidate)) throw new OutsideSkillError();
        return target;
      }

      const parent = dirname(probe);
      // `dirname('/')` is `'/'`. Unreachable, because the root itself resolved
      // a moment ago — but a loop that cannot terminate is worse than a
      // redundant guard.
      if (parent === probe) throw new OutsideSkillError();
      probe = parent;
      continue;
    }

    if (!contains(root, real)) throw new OutsideSkillError();
    return target;
  }
}
