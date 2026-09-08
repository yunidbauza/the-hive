import { lstat, readlink, realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, sep } from 'node:path';

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
 * How many symlink hops {@link assertWithinRoot} will follow while chasing a
 * dangling chain before it gives up and refuses.
 *
 * Small and explicit on purpose, not a stand-in for the kernel's own `ELOOP`
 * limit (Linux's is 40). Nothing legitimate a skill bundle would contain
 * chains this deep; the budget exists to bound a hostile or accidental cycle
 * (`a -> b -> a`) to a fixed number of `readlink` calls rather than to model
 * how many hops are "reasonable".
 */
const MAX_LINK_HOPS = 10;

/**
 * Where the kernel will go next when it follows the link at `probe`, spelled
 * exactly as the kernel spells it — **not** normalised.
 *
 * ## Why this is not `path.join`, and why that distinction is the whole bug
 *
 * POSIX resolves a relative symlink target against the directory holding the
 * link, one component at a time, resolving each component *before* applying
 * the next. `path.join` collapses `..` against the preceding component
 * **lexically, before anything touches the disk**, which is a different
 * operation on exactly the paths that matter here.
 *
 * With `esc -> <outside>` live inside the bundle and `hop -> ./esc/../X`
 * dangling beside it, `join(root, './esc/../X')` is `root/X`: `join` cancels
 * `esc` against `..` and the escaping component is never visited, so the
 * containment check sees a path that never existed and approves it. The
 * kernel does the opposite — it resolves `esc` to `<outside>` first, *then*
 * applies `..` from there — and lands at `<outside>/../X`. Handing `join`'s
 * answer to the check while the caller's next syscall gets the kernel's is
 * how `writeFile('graphify', 'hop')` put an attacker-chosen body, mode 755
 * for a `#!` one, outside the skill folder.
 *
 * So this concatenates and stops. The string it returns still contains
 * `esc/..`, which is the point — but note *where* the refusal then comes
 * from, because it is one step further along than it looks: `realpath` on
 * that whole string fails `ENOENT` (the leaf was never created, which is why
 * the link dangled in the first place), and it is the climb in
 * {@link assertWithinRoot} that then resolves `<root>/./esc/..` for real,
 * finds `<outside>`'s parent, and refuses. Preserving `esc/..` is what makes
 * that climb possible; `join` would have left nothing to climb to.
 *
 * The one concession is not appending a separator when `dir` already ends in
 * one — the filesystem root, or a doubled separator carried in from a link
 * target, since `dirname('/a/b//c')` is `'/a/b/'` and a target may well
 * contain `//`. Either way it adds no component and cancels none.
 *
 * The invariant, stated once for the whole module: **containment is asserted
 * only on a path the kernel resolved, never on one this code assembled.**
 * Every assembled string in this file — this one, the `dirname` climb below,
 * `resolveInSkill`'s `join(root, path)` — is either handed straight to
 * `realpath`/`lstat` for the authoritative answer or is the path — or a
 * prefix of it, as `writeFile`'s `mkdir(dirname(absPath))` uses — that the
 * caller will pass to `fs`. The moment an assembled string is treated as a
 * *proxy* for what the kernel would traverse, the check is checking fiction.
 */
function linkTargetPath(probe: string, linkTarget: string): string {
  if (isAbsolute(linkTarget)) return linkTarget;
  const dir = dirname(probe);
  return dir.endsWith(sep) ? `${dir}${linkTarget}` : `${dir}${sep}${linkTarget}`;
}

/**
 * Follow `candidate` to wherever it actually resolves — including through a
 * chain of symlinks that never bottoms out in a real file — and throw
 * {@link OutsideSkillError} unless it lands inside `root`.
 *
 * Read that as "lands", not "stays": a path is free to leave and come back,
 * because the kernel's answer is the only one this asks for. `back ->
 * ../graphify/ok.txt` climbs out of the bundle and straight back in, and is
 * allowed — `realpath` returns `root/ok.txt` and that is inside. What is
 * refused is a *resolution* that ends outside, and — for the links
 * `realpath` cannot follow because they dangle — a declared target whose own
 * resolution ends outside.
 *
 * ## The bug this exists to fix, and why a lexical check could not
 *
 * An earlier version of the dangling-link repair below read a link's raw
 * target with `readlink`, joined it *lexically* onto the directory holding
 * it, and checked `contains()` on that joined **string**. That is exactly
 * the mistake `assertSkillPath` is documented as not making one layer up: a
 * symlink is a fact about the disk, not about the string. A bundle holding
 * `esc -> <outside>` (a real, existing directory) and `hop -> ./esc/leaf`
 * produces a lexically-joined candidate `root/esc/leaf` that reads as
 * contained — because the check never asked what `esc` itself resolves to.
 * `writeFile` then follows `hop` through `esc` and lands outside the root
 * with an attacker-chosen body and, if that body starts `#!`, an executable
 * bit — the same primitive as the escape this module's first version closed,
 * reopened by a different route.
 *
 * So a link's declared target is never *interpreted* here. It is composed
 * with the link's own directory exactly as the kernel composes it — see
 * {@link linkTargetPath}, and note that composing it with `join` instead is
 * the same defect one round later — and handed straight back into this
 * function, which resolves it rather than reading it. A transiting link
 * (`hop` through `esc`) is caught when that recursive call reaches `esc` and
 * `realpath` says it is outside `root`. A multi-link chain — `chainA ->
 * chainB -> <outside>` — is caught the same way, one recursive hop per link,
 * because each hop is validated on its own account rather than assumed safe
 * because the *previous* hop's target string looked local.
 *
 * `hopsRemaining` bounds the recursion so a cycle (`a -> b -> a`) cannot spin
 * forever; running out **refuses**, it does not fall through to allow. See
 * {@link MAX_LINK_HOPS}.
 */
async function assertWithinRoot(
  root: string,
  candidate: string,
  hopsRemaining: number,
): Promise<void> {
  let probe = candidate;
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
          unclear (see the `EACCES` paragraph on {@link resolveInSkill}).

          A symlink gets followed rather than trusted: `readlink` gives its
          raw, unfollowed target, composed with the link's own directory the
          way the kernel composes one — {@link linkTargetPath}, and *not*
          `path.join`, whose normalisation is what reopened this escape once
          already. That composed string is never the answer by itself. It is
          handed straight back into this same function, one hop lighter, so
          whatever *that* link claims gets the identical scrutiny this one
          just did — resolved by `realpath`, not read. A transiting link is
          caught when the recursive call reaches it and finds its real target
          outside `root`; a dangling chain that never leaves `root` climbs,
          at its end, to a real ancestor that does resolve, exactly like the
          ordinary not-created-yet case below.
        */
        if (!entry.isSymbolicLink()) throw new OutsideSkillError();
        if (hopsRemaining <= 0) throw new OutsideSkillError();

        let linkTarget: string;
        try {
          linkTarget = await readlink(probe);
        } catch {
          throw new OutsideSkillError();
        }

        await assertWithinRoot(
          root,
          linkTargetPath(probe, linkTarget),
          hopsRemaining - 1,
        );
        return;
      }

      /*
        Nothing here at all, so climb. `dirname` is the right tool and `join`
        would be the wrong one for the same reason it is wrong above: this
        drops the last component and normalises nothing, so a `..` a link
        target put into `probe` is still there for `realpath` to resolve on
        the next turn rather than cancelled behind its back.

        `dirname('/')` is `'/'`. Unreachable, because the root itself resolved
        a moment ago — but a loop that cannot terminate is worse than a
        redundant guard.
      */
      const parent = dirname(probe);
      if (parent === probe) throw new OutsideSkillError();
      probe = parent;
      continue;
    }

    if (!contains(root, real)) throw new OutsideSkillError();
    return;
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
 * `writeFile` and `mkdir` are told about paths that do not exist yet. The
 * actual walk, including what happens when that ancestor turns out to be a
 * symlink, lives in {@link assertWithinRoot} — see its docblock for the
 * write-escape this repaired and why a lexical check on a link's target
 * could not.
 *
 * `join(root, path)` is safe here where the same call is not safe inside that
 * walk, and the difference is worth naming because it is subtle: this string
 * is not a *prediction* of what the kernel will traverse, it is the string
 * every caller then hands to `fs` — or, for `writeFile` and `moveFile`'s
 * `mkdir`, a prefix of it, which the same resolution already covered.
 * Whatever `join` normalises away is
 * normalised away for the syscall too, so the check and the operation cannot
 * disagree. A link's declared target is the opposite — the kernel traverses
 * the link, not the string this module built from it — which is why
 * {@link linkTargetPath} refuses to normalise.
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
 * this module, which is a substantial rewrite for a race that requires a
 * second, adversarial process winning a timing window against this one
 * between two syscalls — a materially different threat from the one this
 * module otherwise defends against, which is a bundle's own on-disk shape.
 * `~/.hive/skills` is hand-editable and backed up with the user's dotfiles
 * (see the top of this file), so main is emphatically *not* the tree's only
 * writer.
 *
 * What is left unclosed is therefore a race, and only a race, against an
 * **unconfined** same-user process: one that can already write anywhere the
 * user can, for which planting a link here and winning the window buys
 * nothing over writing the target file directly. It is deliberately *not*
 * dismissed for a confined writer — an agent given the skills tree and
 * nothing else — because for that writer the gap is real: this function is
 * the fence, and stepping through it reaches past the tree. Everything the
 * check *does* cover, above, is exactly what keeps that fence standing at
 * the moment it is asked; the race is the one place it does not, and closing
 * it means `O_NOFOLLOW`.
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
 * button always failing and no way back except a text editor. So a
 * present-but-unresolvable symlink is followed, not refused outright — see
 * {@link assertWithinRoot} for how far that following goes and why a single
 * lexical hop was not enough. A link whose real resolution — direct, or at
 * the end of a chain — lands inside the root stays addressable, so
 * `removeFile` and `moveFile` can still reach it: `rm` and `rename` act on
 * the link entry itself and never need to follow it.
 */
export async function resolveInSkill(
  name: string,
  path: string,
): Promise<string> {
  const root = await realpath(join(skillsRoot(), name));
  const target = join(root, path);

  await assertWithinRoot(root, target, MAX_LINK_HOPS);
  return target;
}
