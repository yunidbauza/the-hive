/**
 * The folder of agent definitions, watched (HIVE-114).
 *
 * ## Why this pushes where skills pull
 *
 * `skills/index.ts` re-reads on demand and has no change channel, and
 * `ipc-contract.ts` says why: the Settings pane is a skill's only writer, so
 * there is nobody else to hear from. An agents folder is different in kind —
 * the user is invited to write `AGENT.md` by hand, and this story's acceptance
 * criteria require a deleted folder to leave the list *without a restart*. The
 * ledger's change channel is the precedent here, not skills'.
 *
 * ## Why a broken definition is listed
 *
 * An unparseable file is returned **with its reason**, never dropped. Hiding it
 * would leave the user with a folder on disk, no agent on screen, and no way to
 * connect the two — the same argument `readUserSkills` makes for returning its
 * rejects instead of logging them.
 */
import { watch } from 'node:fs';
import {
  mkdir,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { join } from 'node:path';

import {
  AGENT_FILE,
  AGENT_NAME_PATTERN,
  KNOWN_AGENT_MCP,
  RESERVED_AGENT_NAMES,
  type AgentsSnapshot,
  type AgentSummary,
  type AgentWriteResult,
} from '@shared/agent-contract';

import { parseAgent } from './definition';
import { patchFrontmatter } from './patch';


/**
 * Long enough to collapse the several events one save emits, short enough that
 * the pane feels live. The ledger's mirror uses the same order of magnitude.
 */
const DEBOUNCE_MS = 120;

/**
 * How the registry learns the folder changed.
 *
 * Injectable for the same reason `node-pty` is mocked rather than spawned: a
 * unit test that leans on a real `fs.watch` is at the mercy of OS event
 * delivery, which fake timers cannot advance — so the debounce, the part with
 * actual logic in it, becomes untestable without real waits. Production passes
 * {@link watchFolder}; tests pass something they can fire by hand.
 */
export type WatchFactory = (
  root: string,
  onEvent: () => void,
) => { close: () => void } | null;

export const watchFolder: WatchFactory = (root, onEvent) => {
  try {
    return watch(root, { recursive: true }, onEvent);
  } catch {
    // No folder yet, or a platform without recursive watch. The pane still
    // works — it just will not live-update until something creates the root,
    // which the next `list()` picks up.
    return null;
  }
};

export interface RegistryOptions {
  root: string;
  /**
   * The skill names an agent may reference, and the subset The Hive owns.
   *
   * A function rather than a snapshot: skills can be written while the app
   * runs, and an agent naming one added a minute ago must validate against the
   * folders as they are now.
   */
  skillNames: () => Promise<{ all: readonly string[]; hive: readonly string[] }>;
  watch?: WatchFactory;
}

export interface AgentRegistry {
  list(): Promise<AgentsSnapshot>;
  read(name: string): Promise<string | null>;
  write(name: string, source: string): Promise<AgentWriteResult>;
  remove(name: string): Promise<void>;
  /**
   * Move a folder, and write `source` into it when given.
   *
   * `source` is the buffer the caller is saving. Without it the verb falls
   * back to the file on disk, which is correct only for a plain move.
   */
  rename(from: string, to: string, source?: string): Promise<AgentWriteResult>;
  onChange(fn: () => void): () => void;
  close(): void;
}

/**
 * Can the IPC layer address this folder at all?
 *
 * Mirrors `assertAgentName`: same pattern, same reserved names. A folder that
 * fails this is listed with its reason rather than hidden, but nothing in the
 * pane can open or delete it, because the guard that refuses it is the same
 * one that makes a path unrepresentable.
 */
function addressable(name: string): boolean {
  return (
    AGENT_NAME_PATTERN.test(name) &&
    !(RESERVED_AGENT_NAMES as readonly string[]).includes(name)
  );
}

/** A name may only ever address one folder directly under the root. */
function safe(name: string): boolean {
  return (
    name !== '' &&
    name !== '.' &&
    name !== '..' &&
    !name.includes('/') &&
    !name.includes('\\')
  );
}

export function createAgentRegistry({
  root,
  skillNames,
  watch: makeWatcher = watchFolder,
}: RegistryOptions): AgentRegistry {
  const listeners = new Set<() => void>();
  let watcher: { close: () => void } | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const fileOf = (name: string) => join(root, name, AGENT_FILE);

  const announce = () => {
    if (timer !== null) clearTimeout(timer);

    timer = setTimeout(() => {
      timer = null;

      for (const fn of [...listeners]) fn();
    }, DEBOUNCE_MS);
  };

  /**
   * Bind the watcher, rebinding when the folder it was watching is gone.
   *
   * `fs.watch` holds an inode, not a path: delete `~/.hive/agents` in Finder
   * and the handle stops delivering while staying non-null. A plain
   * `if (watcher !== null) return` therefore turned live updates off for the
   * rest of the session the first time the folder was removed — the same class
   * of silent failure as never binding at all.
   */
  const ensureWatcher = (rebind = false) => {
    if (watcher !== null && !rebind) return;

    watcher?.close();
    watcher = makeWatcher(root, announce);
  };

  /*
    Resolved once per call and passed down, never fetched per folder.

    `skillNames()` now walks `~/.hive/skills`, `~/.claude/skills` and every
    installed plugin. `list()` calls `parse` once per agent folder and re-runs
    on every debounced watcher event — and a single save fires the watcher
    twice, for the temp write and the rename. Fetching inside `parse` therefore
    multiplied a whole-machine scan by the size of the fleet, on every
    keystroke-triggered save. It was invisible before this widening only
    because the one folder it scanned is usually empty.
  */
  const parse = (
    folder: string,
    source: string,
    skills: { all: readonly string[]; hive: readonly string[] },
  ) =>
    parseAgent(source, {
      folder,
      skillNames: skills.all,
      hiveSkillNames: skills.hive,
      integrations: KNOWN_AGENT_MCP,
    });

  const read = async (name: string): Promise<string | null> => {
    if (!safe(name)) return null;

    try {
      return await readFile(fileOf(name), 'utf8');
    } catch {
      return null;
    }
  };

  const write = async (
    name: string,
    source: string,
  ): Promise<AgentWriteResult> => {
    if (!safe(name)) {
      return { ok: false, problems: [{ field: 'name', reason: 'Bad name.' }] };
    }

    const result = parse(name, source, await skillNames());

    if ('problems' in result) return { ok: false, problems: result.problems };

    const dir = join(root, name);

    await mkdir(dir, { recursive: true });

    // Temp-then-rename, so a reader never sees half a file and a crash
    // mid-write cannot truncate a valid definition into an invalid one. Same
    // directory, so the rename stays on one filesystem and is atomic.
    const temp = join(dir, `.${AGENT_FILE}.tmp`);

    await writeFile(temp, source, 'utf8');
    await rename(temp, fileOf(name));

    return { ok: true };
  };

  const remove = async (name: string): Promise<void> => {
    if (!safe(name)) return;

    await rm(join(root, name), { recursive: true, force: true });
  };

  return {
    async list(): Promise<AgentsSnapshot> {
      /*
        Create the folder before watching it.

        `fs.watch` cannot attach to a path that does not exist, and it does not
        retry — so on a fresh install the watcher silently never bound, and an
        AGENT.md written by hand did not appear until the app was restarted.
        That is precisely the behaviour this registry watches for, so the
        failure was invisible to every test that seeded a folder first.

        Creating it is not merely a fix of convenience: the pane *tells* the
        user "Agents folder: ~/.hive/agents", and a path the app names is one
        it should be willing to make.
      */
      let recreated = false;

      try {
        // `mkdir` reports whether it made anything: a defined return means the
        // root did not exist, so any watcher we hold is bound to a dead inode.
        recreated = (await mkdir(root, { recursive: true })) !== undefined;
      } catch {
        // A read-only home, or a file where the folder should be. `readdir`
        // below reports the same condition as an empty list, which is the
        // honest rendering either way.
      }

      ensureWatcher(recreated);

      let folders: string[];

      try {
        folders = (await readdir(root, { withFileTypes: true }))
          .filter((entry) => entry.isDirectory())
          .map((entry) => entry.name)
          .sort((a, b) => a.localeCompare(b));
      } catch {
        return { agents: [], agentsRoot: root };
      }

      const agents: AgentSummary[] = [];
      // One whole-machine scan for the whole listing, not one per agent.
      const skills = await skillNames();

      for (const folder of folders) {
        /*
          A folder the IPC guard will refuse to address.

          `assertAgentName` throws for upper case, spaces and the reserved
          names, so `read` and `remove` cannot reach such a folder at all —
          which used to leave a row that highlighted, opened nothing, offered
          no Delete, and said nothing about why. Listing it with the real
          reason is the only honest option: the guard is a security boundary
          and must not be loosened, so the fix has to happen on disk.
        */
        if (!addressable(folder)) {
          agents.push({
            name: folder,
            description: '',
            icon: 'Warning',
            status: 'sleeping',
            wake: { on: [] },
            invalid:
              'The folder name cannot be used. Rename it on disk to lowercase letters, digits and dashes.',
          });
          continue;
        }

        const source = await read(folder);

        // A folder with no AGENT.md is not an agent — it is somebody's notes.
        if (source === null) continue;

        const result = parse(folder, source, skills);

        if ('def' in result) {
          const { def } = result;

          agents.push({
            name: def.name,
            description: def.description,
            icon: def.icon,
            status: 'sleeping',
            wake: def.wake,
          });
          continue;
        }

        const first = result.problems[0];
        const reason = first === undefined ? 'Could not be read.' : first.reason;

        agents.push({
          name: folder,
          description: '',
          icon: 'Warning',
          status: 'sleeping',
          wake: { on: [] },
          invalid:
            first === undefined || first.field === ''
              ? reason
              : `${first.field}: ${reason}`,
        });
      }

      return { agents, agentsRoot: root };
    },

    read,
    write,
    remove,

    async rename(from, to, source) {
      if (!safe(from) || !safe(to)) {
        return { ok: false, problems: [{ field: 'name', reason: 'Bad name.' }] };
      }

      try {
        await stat(join(root, to));

        return {
          ok: false,
          problems: [{ field: 'name', reason: `${to} already exists.` }],
        };
      } catch {
        // Nothing there, which is what we want.
      }

      /*
        Validate the text the caller is about to save, not the text on disk.

        Reading the old file here meant a rename carried the *stale* content
        through validation: open a broken agent, fix the bad key and rename it
        in one edit — the flow this pane exists to support — and the rename was
        refused with problems describing a key the user had already removed,
        while the corrected buffer was never written.

        Falling back to the file on disk keeps the verb usable on its own, for
        a caller that only wants to move a folder.
      */
      const moving = source ?? (await read(from));

      if (moving === null) {
        return {
          ok: false,
          problems: [{ field: 'name', reason: 'Not found.' }],
        };
      }

      // The name inside the file has to follow the folder, or the definition
      // fails its own folder-match rule. Only the value is rewritten, so a
      // comment on the `name:` line survives — `patchFrontmatter`'s rule.
      const written = await write(to, patchFrontmatter(moving, 'name', to));

      if (!written.ok) return written;

      await remove(from);

      return { ok: true };
    },

    onChange(fn) {
      ensureWatcher();
      listeners.add(fn);

      return () => {
        listeners.delete(fn);
      };
    },

    close() {
      if (timer !== null) clearTimeout(timer);

      timer = null;
      watcher?.close();
      watcher = null;
      listeners.clear();
    },
  };
}
