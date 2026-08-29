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
  KNOWN_AGENT_MCP,
  type AgentsSnapshot,
  type AgentSummary,
  type AgentWriteResult,
} from '@shared/agent-contract';

import { parseAgent } from './definition';

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
  skillNames: () => Promise<readonly string[]>;
  watch?: WatchFactory;
}

export interface AgentRegistry {
  list(): Promise<AgentsSnapshot>;
  read(name: string): Promise<string | null>;
  write(name: string, source: string): Promise<AgentWriteResult>;
  remove(name: string): Promise<void>;
  rename(from: string, to: string): Promise<AgentWriteResult>;
  onChange(fn: () => void): () => void;
  close(): void;
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

  const ensureWatcher = () => {
    if (watcher !== null) return;

    watcher = makeWatcher(root, announce);
  };

  const parse = async (folder: string, source: string) =>
    parseAgent(source, {
      folder,
      skillNames: await skillNames(),
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

    const result = await parse(name, source);

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
      ensureWatcher();

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

      for (const folder of folders) {
        const source = await read(folder);

        // A folder with no AGENT.md is not an agent — it is somebody's notes.
        if (source === null) continue;

        const result = await parse(folder, source);

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

    async rename(from, to) {
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

      const source = await read(from);

      if (source === null) {
        return {
          ok: false,
          problems: [{ field: 'name', reason: 'Not found.' }],
        };
      }

      // The name inside the file has to follow the folder, or the definition
      // the rename produces fails its own folder-match rule.
      const moved = source.replace(/^name:[ \t]*.*$/m, `name: ${to}`);
      const written = await write(to, moved);

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
