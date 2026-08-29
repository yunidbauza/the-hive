import {
  readFrontmatter,
  type AgentsSnapshot,
  type AgentWriteResult,
} from '@shared/agent-contract';

/**
 * The agent definitions, as the renderer sees them (HIVE-114).
 *
 * A module with a subscription rather than a Zustand store, for the reason
 * `skills.ts` gives: this is a fact about the **disk**, read from main, and it
 * is neither "what the user is looking at" nor a derived view of anything on
 * screen.
 *
 * ## Why the mutating verbs do not return a snapshot
 *
 * `skills.ts`'s do, because a skill's only writer is the pane and every write
 * can therefore answer with the settled truth. Agents have two writers — the
 * pane and the person with a text editor — so main pushes `agents:changed` and
 * the list is re-read from that. A write here answers with an
 * {@link AgentWriteResult} instead, because a *refusal* carries structure the
 * pane has to render: problems, each naming the field it belongs to.
 *
 * A successful mutation still re-lists explicitly rather than waiting for the
 * push. `fs.watch` is best-effort — it is unavailable on some platforms and
 * silently absent when the folder does not exist yet — and a pane that only
 * updated when the watcher happened to fire would be correct on the developer's
 * machine and stale on somebody else's.
 */

let snapshot: AgentsSnapshot | null = null;
const listeners = new Set<() => void>();

function emit(): void {
  // Copied before iterating: a listener unsubscribing during the emit is the
  // ordinary React teardown case, not an edge case.
  for (const listener of [...listeners]) listener();
}

/** `useSyncExternalStore`'s subscribe. Returns its own disposer. */
export function subscribeAgents(listener: () => void): () => void {
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
 * asking yet. The pane renders a header-only nothing for both.
 */
export function agentsSnapshot(): AgentsSnapshot | null {
  return snapshot;
}

/** Ask main for the agents. Safe to call repeatedly. */
export async function loadAgents(): Promise<void> {
  const bridge = window.hive;

  // No bridge is the browser demo, not a failure — feature-detect the bridge,
  // never the user agent.
  if (!bridge) return;

  try {
    snapshot = await bridge.agents.list();
  } catch (cause) {
    console.error('[hive] could not read the agents:', cause);
    snapshot = null;
  }

  emit();
}

const NO_BRIDGE: AgentWriteResult = {
  ok: false,
  problems: [
    { field: '', reason: 'Agents are only available in the desktop app.' },
  ],
};

/**
 * Write one agent, creating it if new.
 *
 * A refusal is a **value**, not a throw and not a log line, for the reason
 * `skills.ts` records paying for: a caller that cannot tell a refusal from a
 * success runs its success path anyway, and the editor flips to "saved" over a
 * file that was never written.
 */
export async function saveAgent(
  name: string,
  source: string,
): Promise<AgentWriteResult> {
  const bridge = window.hive;

  if (!bridge) return NO_BRIDGE;

  try {
    const result = await bridge.agents.write({ name, source });

    // Only on success: a refusal changed nothing on disk, so the snapshot the
    // pane already holds is still exactly true.
    if (result.ok) await loadAgents();

    return result;
  } catch (cause) {
    console.error('[hive] the agent was not written:', cause);

    return {
      ok: false,
      problems: [
        {
          field: '',
          reason: cause instanceof Error ? cause.message : String(cause),
        },
      ],
    };
  }
}

/** Remove one agent, folder and all. */
export async function deleteAgent(name: string): Promise<AgentWriteResult> {
  const bridge = window.hive;

  if (!bridge) return NO_BRIDGE;

  try {
    await bridge.agents.remove({ name });
    await loadAgents();

    return { ok: true };
  } catch (cause) {
    console.error('[hive] the agent was not removed:', cause);

    return {
      ok: false,
      problems: [
        {
          field: '',
          reason: cause instanceof Error ? cause.message : String(cause),
        },
      ],
    };
  }
}

/**
 * Rename an agent.
 *
 * One call, unlike {@link renameSkill}'s two: main moves the folder, rewrites
 * the `name:` inside it, and writes `source` in the same operation — so there
 * is no window in which the definition contradicts its own folder. That window
 * is exactly what forced the skills version to report whether the move landed.
 *
 * `source` is the buffer being saved. Passing it is what makes the move
 * validate the text about to be written rather than the stale file on disk.
 */
export async function renameAgent(
  from: string,
  to: string,
  source?: string,
): Promise<AgentWriteResult> {
  const bridge = window.hive;

  if (!bridge) return NO_BRIDGE;

  try {
    const result = await bridge.agents.rename({
      from,
      to,
      ...(source === undefined ? {} : { source }),
    });

    if (result.ok) await loadAgents();

    return result;
  } catch (cause) {
    console.error('[hive] the agent was not renamed:', cause);

    return {
      ok: false,
      problems: [
        {
          field: '',
          reason: cause instanceof Error ? cause.message : String(cause),
        },
      ],
    };
  }
}

/**
 * One file, for the editor.
 *
 * Outside the snapshot on purpose, as a skill's body is: an agent's source is
 * only needed while it is open, and putting every file's text in the
 * subscribed value would re-render the list on every keystroke elsewhere.
 */
export async function readAgent(name: string): Promise<string | null> {
  const bridge = window.hive;

  if (!bridge) return null;

  try {
    return await bridge.agents.read({ name });
  } catch (cause) {
    console.error('[hive] could not read the agent:', cause);

    return null;
  }
}

/**
 * The `name:` a buffer declares, or `''` when it declares none.
 *
 * The folder name is **mirrored** from the frontmatter rather than typed
 * separately, so an agent has exactly one name and the two cannot drift into
 * the mismatch main would refuse. This is the renderer's half of the rule
 * `parseAgent` enforces on disk.
 *
 * It reads through the shared {@link readFrontmatter} rather than a local
 * regex — which is the whole reason that function lives in the contract. A
 * second, simpler reader here would disagree with main about
 * `name: a  # comment`, and the pane would offer a Save that main rejects.
 */
export function frontmatterName(source: string): string {
  return readFrontmatter(source)?.fields.get('name')?.value ?? '';
}

/** Test-only: drop the snapshot and every subscriber. */
export function resetAgents(): void {
  snapshot = null;
  listeners.clear();
}

/** Test-only: install a snapshot without going through the bridge. */
export function setAgentsForTest(next: AgentsSnapshot | null): void {
  snapshot = next;
  emit();
}
