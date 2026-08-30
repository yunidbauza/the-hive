import {
  formatRunCost,
  readFrontmatter,
  type AgentStatus,
  type AgentsSnapshot,
  type AgentWriteResult,
  type RunSummary,
  type WakeSpec,
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

/**
 * What happens next without you — `08:30`, `on answer`, or `manual`.
 *
 * Here rather than in either caller because two surfaces say it: the rail
 * row's meta and the agent view's `Next` tile. A row reading `next 08:30`
 * beside a tile reading `manual` would be one fact spelled two ways, and this
 * is the smaller half of that fact — `useAgentFacts` composes the rest.
 *
 * An `asking` agent has no scheduled wake worth naming even when it has a
 * `nextRunAt`: the thing that will actually move it is a reply, and saying
 * `08:30` would promise a wake the answer is going to pre-empt.
 *
 * A `paused` one has none for a stronger reason (HIVE-117): `RunTracker.run`
 * refuses every trigger while an agent is paused, and nothing clears
 * `nextRunAt` when the pause is set — so the field outlives the schedule it
 * describes. Left unhandled, a paused agent would count down to a time at which
 * nothing happens.
 */
export function describeNextRun(agent: {
  status: AgentStatus;
  nextRunAt?: number;
}): string {
  if (agent.status === 'paused') return 'paused';
  if (agent.status === 'asking') return 'on answer';
  if (agent.nextRunAt === undefined) return 'manual';

  return new Date(agent.nextRunAt).toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
  });
}

/**
 * What this agent has cost you today — `31 runs · $2.14` (HIVE-116, HIVE-117).
 *
 * Beside {@link describeWake} for its reason, and with a second one of its own:
 * two surfaces now show this pair — the agent view's `Today` tile and the
 * console's `agents` table — and they sit on the same screen. Two spellings of
 * one number is a contradiction the reader has to resolve, so both read this.
 *
 * "Today" is the **user's** calendar day, compared with `toDateString()` rather
 * than against a UTC boundary: it is the person's day, and there is no server
 * to have another one. Derived on read rather than stored, so it cannot be
 * wrong the moment the clock passes midnight.
 */
export function runsToday(
  runs: readonly RunSummary[],
  now: number = Date.now(),
): { count: number; cost: string } {
  const today = new Date(now).toDateString();
  const todays = runs.filter(
    (run) => new Date(run.startedAt).toDateString() === today,
  );
  const spent = formatRunCost(
    todays.reduce((sum, run) => sum + (run.costUsd ?? 0), 0),
  );

  /*
    `$0.00` rather than a blank for a quiet day: this is a fact about spend, and
    an empty cell reads as "not measured" instead of "nothing".

    The no-runs case is spelled here rather than left to `formatRunCost`, which
    answers `$0.0000` for zero. Four decimals is right for a *run* — a wake
    routinely costs less than a cent, and `$0.00` for real work reads as a bug —
    but it is false precision about a day on which nothing happened. A day that
    did run, and cost less than a cent, still gets the four decimals.

    Both conditions in one branch on purpose: `spent` is only `undefined` for a
    non-finite input, which a sum of numbers is not, so a separate `?? '$0.00'`
    would be a branch no test could reach.
  */
  return {
    count: todays.length,
    cost: todays.length === 0 || spent === undefined ? '$0.00' : spent,
  };
}

/**
 * How it wakes — `every 5m · slack`, `at 09:00, 17:00 · Mon–Fri`, or `manual`.
 *
 * Beside {@link describeNextRun} for the same reason: the `Wake` tile and any
 * future row that summarises a schedule must not word it differently.
 *
 * `at` is a **list** of `HH:MM`, so it is joined explicitly rather than
 * interpolated — `${wake.at}` renders an array as `09:00,17:00`, comma-jammed
 * and inconsistent with the `·` this string separates its parts with. `days`
 * is rendered too: without it a Mon/Wed-only agent reads exactly like a daily
 * one, which is the schedule question a reader most wants answered.
 */
export function describeWake(wake: WakeSpec): string {
  const parts: string[] = [];

  if (wake.everyMs !== undefined) {
    parts.push(`every ${Math.round(wake.everyMs / 60_000)}m`);
  }
  if (wake.at !== undefined && wake.at.length > 0) {
    parts.push(`at ${wake.at.join(', ')}`);
  }
  // Absent `days` alongside `at` means every day, which needs no words.
  if (wake.days !== undefined && wake.days.length > 0) {
    parts.push(wake.days.join(', '));
  }
  if (wake.on.length > 0) parts.push(wake.on.join(' · '));

  return parts.length === 0 ? 'manual' : parts.join(' · ');
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

/**
 * The names a new agent is drawn from.
 *
 * Zerg units, because the app is already speaking this language: it ships a
 * `hydralisk` sprite, and the agents empty state reads "The brood sleeps. No
 * drones assigned. Ready to spawn." A default of `agent-1` was the thing out of
 * place in that room.
 *
 * Lowercased to satisfy `AGENT_NAME_PATTERN`, which is `[a-z0-9-]+`.
 *
 * `overlord` is kept despite sitting one syllable from `overmind`, the ledger's
 * coordinator identity — they are different strings, so nothing collides, and
 * the roster reads worse without it.
 */
export const AGENT_NAME_POOL = [
  'drone',
  'zergling',
  'hydralisk',
  'ultralisk',
  'lurker',
  'mutalisk',
  'overlord',
  'scourge',
  'broodling',
  'devourer',
  'defiler',
] as const;

/**
 * A name for a new agent: one of {@link AGENT_NAME_POOL}, drawn at random.
 *
 * **Unheld names are preferred over numbering.** Drawing blind and numbering on
 * collision would offer `drone-2` while `hydralisk` sat free, which reads as the
 * app having run out of names when it has ten left. Numbering is the fallback
 * for a fleet that genuinely holds all eleven.
 *
 * `pick` is injected so a test can be deterministic. It is not a seed — it is
 * the source of randomness itself, which keeps this a pure function of its
 * arguments and means no test has to stub a global.
 */
export function nextAgentName(
  taken: readonly string[],
  pick: () => number = Math.random,
): string {
  const free = AGENT_NAME_POOL.filter((name) => !taken.includes(name));
  const from = free.length > 0 ? free : AGENT_NAME_POOL;
  const index = Math.min(from.length - 1, Math.floor(pick() * from.length));
  const base = from[index] as string;

  if (!taken.includes(base)) return base;

  // Starts at 2, exactly as a second session on one ticket is numbered.
  for (let suffix = 2; ; suffix += 1) {
    const candidate = `${base}-${suffix}`;

    if (!taken.includes(candidate)) return candidate;
  }
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
