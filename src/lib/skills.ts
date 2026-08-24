import {
  RESERVED_SKILL_NAME,
  SKILL_NAME_PATTERN,
  type SkillFile,
  type SkillsSnapshot,
} from '@shared/skills-contract';

/**
 * The custom skills, as the renderer sees them (HIVE-96).
 *
 * A module with a subscription rather than a Zustand store, for the reason
 * `project-config.ts` gives about the workspace config: the four stores are
 * split along "what the user is looking at" versus "what the system knows", and
 * this is neither. It is a fact about the **disk**, read from main, consumed by
 * exactly one surface, and never derived from anything else on screen.
 *
 * It lives in `src/lib/` so the ESLint zones keep it out of reach of
 * `src/components/terminal/`, and its hook lives in `src/hooks/use-skills.ts`
 * so components never import this module directly — the same split, and the
 * same rule from `AGENTS.md`, that `use-project-config.ts` documents.
 */

let snapshot: SkillsSnapshot | null = null;
const listeners = new Set<() => void>();

function emit(): void {
  // Copied before iterating: a listener that unsubscribes during the emit is
  // the ordinary React teardown case, not an edge case.
  for (const listener of [...listeners]) listener();
}

/** `useSyncExternalStore`'s subscribe. Returns its own disposer. */
export function subscribeSkills(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * The current snapshot, or `null` when there is none.
 *
 * `null` means one of two things and deliberately does not distinguish them:
 * the browser demo has no bridge to ask, and the desktop app has not finished
 * asking yet. The pane renders a loading-shaped nothing for both, which is the
 * honest rendering of each.
 */
export function skillsSnapshot(): SkillsSnapshot | null {
  return snapshot;
}

/**
 * Run a reading verb.
 *
 * A failure here means the channel itself broke — main answers a snapshot even
 * for an unreadable directory — so there is nothing the user can fix by editing
 * a file, and the snapshot is cleared rather than left stale.
 */
async function read(
  fetch: (bridge: NonNullable<Window['hive']>) => Promise<SkillsSnapshot>,
): Promise<void> {
  const bridge = window.hive;
  // No bridge is the browser demo, not a failure. Story 083's rule: feature-
  // detect the bridge, never the user agent.
  if (!bridge) return;

  try {
    snapshot = await fetch(bridge);
  } catch (cause) {
    console.error('[hive] could not read the skills:', cause);
    snapshot = null;
  }
  emit();
}

/**
 * Run a mutating verb, keeping the last good snapshot if it is refused.
 *
 * Separate from {@link read} because the two failures mean opposite things, and
 * `project-config.ts` paid for the difference: a rejected mutation there
 * cleared the snapshot, the settings list emptied, and a surface that is
 * permissive with no snapshot reopened a gate it had been holding shut.
 *
 * A refused **write** says only that the write did not happen. Nothing on disk
 * changed, so the snapshot the pane already holds is still exactly true.
 *
 * ## Why this reports the refusal rather than only logging it
 *
 * Keeping the snapshot is right; *resolving as though the write happened* is
 * not, and the two were conflated here. The caller then ran its success path
 * unconditionally — the editor flipped to "saved" over a file that was never
 * written, and Delete emptied the editor while the row it claimed to have
 * removed stayed in the list. The user is told one thing and shown its
 * opposite.
 *
 * `project-config.ts` can log-and-continue because its callers have no success
 * path to run: they re-render from the snapshot and nothing else. This pane
 * does, so the outcome has to be a value.
 */
async function mutate(
  call: (bridge: NonNullable<Window['hive']>) => Promise<SkillsSnapshot>,
): Promise<string | null> {
  const bridge = window.hive;
  // No bridge is the browser demo. Nothing was written and nothing failed —
  // the pane is header-only there and never calls this.
  if (!bridge) return 'Custom skills are only available in the desktop app.';

  try {
    snapshot = await call(bridge);
    emit();
    return null;
  } catch (cause) {
    console.error('[hive] the skill was not written:', cause);
    emit();
    return cause instanceof Error ? cause.message : String(cause);
  }
}

/** Ask main for the skills. Called when the pane mounts. */
export const loadSkills = (): Promise<void> =>
  read((bridge) => bridge.skills.list());

/**
 * Write one skill, creating it if new.
 *
 * Resolves to `null` on success, or the reason it failed — see {@link mutate}
 * for why the outcome is a value rather than a log line.
 *
 * No reload follows a success: both mutating verbs answer with the fresh
 * snapshot, so the list and the disk can never disagree about what a save
 * produced.
 */
export const saveSkill = (
  name: string,
  body: string,
): Promise<string | null> =>
  mutate((bridge) => bridge.skills.write({ name, body }));

/** Remove one skill. `null` on success, otherwise the reason. */
export const deleteSkill = (name: string): Promise<string | null> =>
  mutate((bridge) => bridge.skills.remove({ name }));

/** Test-only: drop the snapshot and every subscriber. */
export function resetSkills(): void {
  snapshot = null;
  listeners.clear();
}

/** Test-only: install a snapshot without going through the bridge. */
export function setSkillsForTest(next: SkillsSnapshot | null): void {
  snapshot = next;
  emit();
}

/**
 * The `name:` a buffer declares, or `''` when it declares none.
 *
 * The folder name is not typed separately — it is **mirrored** from the
 * frontmatter, so a skill has exactly one name and the two cannot drift into
 * the mismatch main would then refuse. This is the renderer's half of the same
 * rule `skills/read.ts` enforces on disk.
 *
 * Same deliberately small reader as main's: the only key that decides anything
 * is `name`, and a YAML parser here would be this app holding an opinion about
 * a format it does not own.
 */
export function frontmatterName(body: string): string {
  const lines = body.split('\n');
  if (lines[0]?.trim() !== '---') return '';

  let name = '';

  for (const line of lines.slice(1)) {
    /*
      The closing fence is a line that **is** `---`, not one that merely starts
      with it — a `-----` rule in the body would otherwise end the header early.

      And the name only counts once that fence is found. An unterminated header
      is a file `skills/read.ts` refuses outright, so returning a name from one
      would enable Save for something main is guaranteed to reject. The two
      readers have to agree about where a header ends, or the pane promises a
      command that never appears.
    */
    if (line.trim() === '---') return name;

    const match = /^name:\s*(.*)$/.exec(line.trim());
    if (match && name === '') name = (match[1] ?? '').trim();
  }

  // Ran off the end without a closing fence.
  return '';
}

/**
 * Why this name cannot be saved, or `null` when it can.
 *
 * A sentence rather than a boolean, because the footer shows it: "must be
 * lowercase…" tells the user what to type next, and a disabled button with no
 * reason does not.
 *
 * `taken` excludes the skill being edited, so re-saving an existing skill under
 * its own name is not a collision with itself.
 */
export function skillNameProblem(
  name: string,
  taken: readonly string[],
): string | null {
  if (name === '') return 'Give the skill a name in its frontmatter.';
  if (name === RESERVED_SKILL_NAME) {
    return `"${RESERVED_SKILL_NAME}" is reserved by The Hive.`;
  }
  if (!SKILL_NAME_PATTERN.test(name)) {
    return 'Lowercase letters, digits and dashes only.';
  }
  if (taken.includes(name)) return `You already have a skill called ${name}.`;
  return null;
}

/**
 * One file, for the editor.
 *
 * Outside the snapshot on purpose. A skill's body is only needed while it is
 * open, and putting every file's full text in the subscribed value would mean
 * the whole tree re-rendering the list on every keystroke elsewhere.
 *
 * `null` for the browser demo — the same "no bridge to ask" the snapshot uses,
 * rather than a throw the caller would have to guard.
 */
export async function readSkill(name: string): Promise<SkillFile | null> {
  const bridge = window.hive;
  if (!bridge) return null;

  try {
    return await bridge.skills.read({ name });
  } catch (cause) {
    console.error('[hive] could not read the skill:', cause);
    return null;
  }
}
