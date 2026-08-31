import { parseList } from '@shared/agent-contract';
import type { AgentWriteResult } from '@shared/agent-contract';
import type { LedgerEntry, LedgerPostRequest } from '@shared/ledger-contract';
import type { Rung } from '@shared/permission-rules';

import { patchFrontmatter } from './patch';

/**
 * Answers become grants (HIVE-119).
 *
 * Two roads out of one answer, and which one it takes is the difference
 * between "this once" and "for good":
 *
 * - `allow-once` writes nothing. It is read back at the wake the answer
 *   triggers, handed to that wake's `HIVE_GRANTS`, and retired by an `event`
 *   so a later wake cannot pick it up a second time.
 * - `allow-family` / `allow-tool` are written into `AGENT.md` **here**, the
 *   moment the answer arrives, so the grant is visible in Settings › Agents
 *   before the agent has even woken. The next wake then carries it as an
 *   ordinary `def.tools` entry, through no special path at all.
 *
 * Both roads end in an `event`, so the log always records that an answer was
 * acted on — including when acting on it failed.
 */

const record = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;

const rungsOf = (entry: LedgerEntry): Rung[] => {
  const raw = entry.meta?.['rungs'];
  if (!Array.isArray(raw)) return [];
  return raw.filter((rung): rung is Rung => {
    const shape = record(rung);
    return typeof shape?.['id'] === 'string' && typeof shape['label'] === 'string';
  });
};

const isPermissionAsk = (entry: LedgerEntry): boolean =>
  entry.kind === 'ask' && entry.meta?.['kind'] === 'permission';

export interface PermissionDeps {
  entries: () => readonly LedgerEntry[];
  /**
   * The real `Ledger.append` request shape, not a hand-rolled subset — a
   * `body` is required by that contract, and it is the human-readable line
   * someone reads in the ledger later, so it is written here, next to the
   * code that knows which rule was granted to which agent and why. This
   * module never acts on the `LedgerResult` `append` would normally return,
   * so the dep is typed to discard it.
   */
  append: (request: LedgerPostRequest) => void;
  read: (name: string) => Promise<string | null>;
  write: (name: string, source: string) => Promise<AgentWriteResult>;
}

export interface Permissions {
  grantsFor: (name: string) => string[];
  onAnswer: (entry: LedgerEntry) => Promise<void>;
}

export function createPermissions(deps: PermissionDeps): Permissions {
  /** The ask a thread names, if that ask is a permission ask. */
  const askFor = (thread: string): LedgerEntry | undefined =>
    deps
      .entries()
      .find((entry) => entry.id === thread && isPermissionAsk(entry));

  const answerTo = (askId: string): LedgerEntry | undefined =>
    deps
      .entries()
      .find((entry) => entry.kind === 'answer' && entry.thread === askId);

  const consumed = (askId: string): boolean =>
    deps
      .entries()
      .some(
        (entry) => entry.kind === 'event' && entry.meta?.['granted'] === askId,
      );

  return {
    grantsFor(name) {
      const grants: string[] = [];

      for (const ask of deps.entries()) {
        if (!isPermissionAsk(ask) || ask.from !== name) continue;
        if (answerTo(ask.id)?.body !== 'allow-once') continue;
        if (consumed(ask.id)) continue;

        const tool = ask.meta?.['tool'];
        if (typeof tool !== 'string' || tool === '') continue;

        grants.push(tool);
        /*
          Retired the moment it is handed out, not after the wake succeeds. A
          grant that survived a failed wake would be a one-shot that fires
          twice, and "once" is the only promise this rung makes.
        */
        deps.append({
          from: 'overmind',
          kind: 'event',
          body: `granted ${tool} to ${name} for one wake`,
          meta: { granted: ask.id, rule: tool },
        });
      }

      return grants;
    },

    async onAnswer(entry) {
      if (entry.kind !== 'answer' || entry.thread === undefined) return;

      const ask = askFor(entry.thread);
      if (ask === undefined) return;

      const rung = rungsOf(ask).find((candidate) => candidate.id === entry.body);
      // `allow-once` carries no rule and `deny` is no rung at all. A body that
      // names neither is a stale or forged card, and must not widen anything.
      if (rung?.rule === undefined) return;

      const name = ask.from;
      const source = await deps.read(name);
      if (source === null) {
        deps.append({
          from: 'overmind',
          kind: 'event',
          body: `could not grant ${rung.rule} to ${name}: no definition`,
          meta: { grantFailed: ask.id, reason: `no definition for ${name}` },
        });
        return;
      }

      const line = /^tools:(.*)$/m.exec(source)?.[1]?.trim() ?? '[]';
      const current = parseList(line) ?? [];

      if (current.includes(rung.rule)) {
        deps.append({
          from: 'overmind',
          kind: 'event',
          // The rule was already there — the answer is still acted on and
          // recorded, the file just already said so.
          body: `granted ${rung.rule} to ${name}`,
          meta: { granted: ask.id, rule: rung.rule },
        });
        return;
      }

      const patched = patchFrontmatter(
        source,
        'tools',
        `[${[...current, rung.rule].join(', ')}]`,
      );

      const result = await deps.write(name, patched);

      deps.append({
        from: 'overmind',
        kind: 'event',
        body: result.ok
          ? `granted ${rung.rule} to ${name}`
          : `could not grant ${rung.rule} to ${name}: ${result.problems.map((p) => p.reason).join('; ')}`,
        meta: result.ok
          ? { granted: ask.id, rule: rung.rule }
          : {
              grantFailed: ask.id,
              reason: result.problems.map((p) => p.reason).join('; '),
            },
      });
    },
  };
}
