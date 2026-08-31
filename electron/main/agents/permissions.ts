import { parseList, readFrontmatter } from '@shared/agent-contract';
import type { AgentWriteResult } from '@shared/agent-contract';
import { OVERMIND } from '@shared/ledger-contract';
import type { LedgerEntry, LedgerPostRequest } from '@shared/ledger-contract';
import { isToolName, oneShotRuleFor, rungsFor } from '@shared/permission-rules';

import { patchFrontmatter } from './patch';

/**
 * Answers become grants (HIVE-119).
 *
 * Two roads out of one answer, and which one it takes is the difference
 * between "this once" and "for good":
 *
 * - `allow-once` writes nothing. It is read back at the wake the answer
 *   triggers, handed to that wake's `HIVE_GRANTS`, and retired by an `event`
 *   so a later wake cannot pick it up a second time. It is composed as a
 *   `literal:` rule naming the one call — a channel that exists only here
 *   and only for one wake, and that must never reach `tools:`. It cannot:
 *   the permanent road writes only rules that came out of `rungsFor`, and
 *   `isToolName` forbids the `:` a forged one would need.
 * - `allow-family` / `allow-tool` are written into `AGENT.md` **here**, the
 *   moment the answer arrives, so the grant is visible in Settings › Agents
 *   before the agent has even woken. The next wake then carries it as an
 *   ordinary `def.tools` entry, through no special path at all.
 *
 * Both roads end in an `event`, so the log always records that an answer was
 * acted on — including when acting on it failed.
 *
 * ## Two things this module must never trust
 *
 * **Who wrote the answer.** An answer only grants when its author is the
 * {@link OVERMIND}. Without that check the fence was self-service: the ledger
 * deliberately lets an asker close its own thread (`ledger/index.ts` — "the
 * asker itself can always close its own question"), and every agent holds
 * `mcp__hive__*` unconditionally (`waker.ts`), so an agent could escalate in
 * two tool calls with no human anywhere: call `Bash` → denied, an ask written
 * `from: <itself>` → `ledger_read` the thread it can see → `ledger_answer`
 * with `'allow-tool'` → this module appends `Bash` to that agent's own
 * `AGENT.md`, and every later wake carries it as ordinary `def.tools`.
 * `allow-once` escalated the same way, because the old `grantsFor` tested
 * only the answer's *body*. Removing the author check reopens that, it does
 * not tidy a redundant guard.
 *
 * **What the ask says its ladder is.** `meta` on `ledger_ask` is free-form
 * and passes through the MCP host unfiltered, so `meta.rungs` is
 * model-supplied text. An agent could post a rung labelled `once`, captioned
 * "runs this once", and carrying `rule: "*"` — one user click would then have
 * written `*` into `tools:`, which `matches` grants for everything. So the
 * ladder is **recomputed** here from `meta.tool` and `meta.input` with the
 * same `rungsFor` that wrote it, and only the recomputed rung's `rule` is
 * ever written. `meta.rungs` is display data, which is all the module
 * comment in `@shared/permission-rules` ever claimed it was.
 */

const record = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;

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
  /**
   * Whether `entry` is an answer to a permission ask — the one case a caller
   * must sequence a wake *behind*, never beside (`ipc/index.ts`). Every other
   * answer wakes the agent it is addressed to the moment it is appended,
   * synchronously, because there is nothing to write first. This one has a
   * write: `onAnswer` may still be putting a rung into `AGENT.md` when the
   * agent's next wake would otherwise read that same file. A caller that
   * schedules the wake without checking this first will see it *most* of the
   * time — the write is fast — and then, once in a while, watch a user's
   * "allow for this agent" click retry into a second denial.
   *
   * An answer from anyone but the overmind is not one of these: it grants
   * nothing, so there is nothing for a wake to be sequenced behind.
   */
  isPermissionAnswer: (entry: LedgerEntry) => boolean;
}

export function createPermissions(deps: PermissionDeps): Permissions {
  /** The ask a thread names, if that ask is a permission ask. */
  const askFor = (thread: string): LedgerEntry | undefined =>
    deps
      .entries()
      .find((entry) => entry.id === thread && isPermissionAsk(entry));

  /**
   * The answer that closed a thread, whoever wrote it.
   *
   * Deliberately *not* filtered by author: a self-answer has to be found in
   * order to be refused out loud. Filtering here would drop it silently, and
   * `grantsFor` would then retry the same doomed lookup on every wake.
   */
  const answerTo = (askId: string): LedgerEntry | undefined =>
    deps
      .entries()
      .find((entry) => entry.kind === 'answer' && entry.thread === askId);

  /**
   * Whether this ask's one-shot has already been acted on — granted *or*
   * refused. A refusal counts: an ask whose answer was forged closes its
   * thread like any other, so without counting it the refusal event would be
   * re-appended on every single wake for the life of the ledger.
   */
  const consumed = (askId: string): boolean =>
    deps
      .entries()
      .some(
        (entry) =>
          entry.kind === 'event' &&
          /*
            The author check again, and for the same reason as everywhere
            else on this road: any party can append an `event` through the
            MCP host, so without it an agent could forge its own
            `meta.grantFailed` and pre-consume a one-shot the user was about
            to be asked about — or, on the other side of the same coin, mark
            a grant spent before it was ever handed out. Only the overmind
            writes these, and this module is the only thing that writes them
            as the overmind.
          */
          entry.from === OVERMIND &&
          (entry.meta?.['granted'] === askId ||
            entry.meta?.['grantFailed'] === askId),
      );

  const refuse = (ask: LedgerEntry, name: string, reason: string): void => {
    deps.append({
      from: OVERMIND,
      to: ask.from,
      kind: 'event',
      thread: ask.id,
      body: `could not grant to ${name}: ${reason}`,
      meta: { grantFailed: ask.id, reason },
    });
  };

  return {
    grantsFor(name) {
      const grants: string[] = [];

      for (const ask of deps.entries()) {
        if (!isPermissionAsk(ask) || ask.from !== name) continue;
        if (consumed(ask.id)) continue;

        const answer = answerTo(ask.id);
        if (answer === undefined) continue;

        /*
          The author check, on the one-shot road — and it is made *before* the
          body is looked at, so every forged answer is recorded, not only the
          `allow-once` ones. The permanent rungs never reach `onAnswer` when
          they are forged (`isPermissionAnswer` already turned them away), so
          this loop is the only place left that will ever see them, and the
          attempt has to become a line in the log somewhere.

          `allow-once` used to look like the harmless rung, because it never
          touches `AGENT.md` — but it is handed straight to the wake's
          `HIVE_GRANTS`, which is the same fence the permanent rules feed. An
          agent answering its own ask therefore granted itself the tool it had
          just been denied, for the whole of the next wake, with no human
          anywhere in it.
        */
        if (answer.from !== OVERMIND) {
          refuse(
            ask,
            name,
            `only the overmind may answer a permission ask; "${answer.body}" came from ${answer.from}`,
          );
          continue;
        }

        if (answer.body !== 'allow-once') continue;

        /*
          `meta.tool` is model-supplied and this road used to take it
          verbatim. `meta.tool: '*'` composed into no rule at all, so the
          old bare-name fallback pushed `'*'` straight into `HIVE_GRANTS` —
          one click on **once**, the least dangerous button on the card, and
          the next wake ran unfenced. See `isToolName`.
        */
        const tool = ask.meta?.['tool'];
        if (!isToolName(tool)) {
          refuse(ask, name, `${JSON.stringify(tool)} is not a tool name`);
          continue;
        }

        /*
          The exact call, as a literal rule — and no fallback. A bare tool
          name matches every call to that tool, so `once` on `touch /tmp/x`
          used to authorise every `Bash` command for the rest of the wake
          while its caption read "runs this once. asks again next time."

          `undefined` here means a tool the grammar *can* specify was asked
          about with no specifier — `meta.input` omitted, which is how the
          untrusted side chose when the old fallback fired. Refused out loud
          rather than widened quietly: an event nobody reads is not consent.
        */
        const rule = oneShotRuleFor(tool, record(ask.meta?.['input']) ?? {});
        if (rule === undefined) {
          refuse(ask, name, `the ask carries no ${tool} call to grant`);
          continue;
        }

        grants.push(rule);
        /*
          Retired the moment it is handed out, not after the wake succeeds. A
          grant that survived a failed wake would be a one-shot that fires
          twice, and "once" is the only promise this rung makes.
        */
        deps.append({
          from: OVERMIND,
          to: ask.from,
          kind: 'event',
          thread: ask.id,
          body: `granted ${rule} to ${name} for one wake`,
          meta: { granted: ask.id, rule },
        });
      }

      return grants;
    },

    isPermissionAnswer(entry) {
      return (
        entry.kind === 'answer' &&
        entry.from === OVERMIND &&
        entry.thread !== undefined &&
        askFor(entry.thread) !== undefined
      );
    },

    async onAnswer(entry) {
      if (entry.kind !== 'answer' || entry.thread === undefined) return;

      const ask = askFor(entry.thread);
      if (ask === undefined) return;

      const name = ask.from;

      /*
        The author check, on the permanent road — and the one that mattered
        most, because this road *writes a file*. See the module comment: an
        agent answering its own ask with `allow-tool` wrote the tool it had
        just been denied into its own `AGENT.md`, permanently, and every
        later wake carried it as an ordinary granted tool.

        Recorded, not dropped. A silent no-op here would make an attempted
        self-grant indistinguishable on replay from an ask nobody answered;
        the author is named so the attempt is legible in the log.
      */
      if (entry.from !== OVERMIND) {
        refuse(
          ask,
          name,
          `only the overmind may answer a permission ask; "${entry.body}" came from ${entry.from}`,
        );
        return;
      }

      /*
        `deny` is not a rung at all — the approve tool always appends it to
        an ask's `meta.options` after the real rungs (`mcp-host/tools.ts`),
        so it never appears in `meta.rungs` by design. Nothing widens, and
        the `answer` entry itself is already the ledger's record of the
        refusal, so there is nothing further to append here.
      */
      if (entry.body === 'deny') return;

      /*
        The ladder is recomputed, never read off the ask. `meta.rungs` is
        model-supplied — see the module comment — and the old code wrote
        `rung.rule` from it verbatim, so a rung captioned "runs this once"
        could carry `rule: "*"`, or an array that `join` would splice into
        the `tools:` list past the comma guard. `rungsFor` is the same
        function that produced the ladder the card drew, so recomputing it
        from `meta.tool` and `meta.input` yields the rung the user actually
        clicked — with a rule this process derived itself.
      */
      /*
        And the same gate on the permanent road, which is the one that
        *writes a file*. `rungsFor` echoes its argument back as the
        `allow-tool` rule, and `patchFrontmatter` writes a value unescaped —
        so `meta.tool: "Bash]\ntools: [Write"` closed the list early and gave
        the file a second `tools:` key, which `readFrontmatter` lets win. The
        user clicked a rung labelled "all Bash" and the agent permanently
        held `Write`. Any known frontmatter key was settable that way, which
        is why this is a shape check on the input rather than an escape at
        the writer: `isToolName` admits no `]`, no newline and no `:`, so
        nothing composed from it can break out of the value it is written
        into — nor look like a one-shot literal.
      */
      const tool = ask.meta?.['tool'];
      if (!isToolName(tool)) {
        refuse(ask, name, `${JSON.stringify(tool)} is not a tool name`);
        return;
      }

      const rung = rungsFor(tool, record(ask.meta?.['input']) ?? {}).find(
        (candidate) => candidate.id === entry.body,
      );

      if (rung === undefined) {
        /*
          A stale or forged card — the body names an option this ask's real
          ladder never offered. `Ledger.append` only lets an `answer` target
          an *open* ask, so this one has already closed its thread: without
          an event here, this is on replay indistinguishable from an ask
          nobody ever answered. Nothing widens, but the refusal is recorded.
        */
        refuse(ask, name, `no such option "${entry.body}"`);
        return;
      }

      // `allow-once` carries no rule — its one-shot grant is handed out by
      // `grantsFor`, read back at the wake it triggers, not written here.
      if (rung.rule === undefined) return;

      const source = await deps.read(name);
      if (source === null) {
        deps.append({
          from: OVERMIND,
          to: ask.from,
          kind: 'event',
          thread: ask.id,
          body: `could not grant ${rung.rule} to ${name}: no definition`,
          meta: { grantFailed: ask.id, reason: `no definition for ${name}` },
        });
        return;
      }

      /*
        `readFrontmatter`, not a hand-rolled regex — `patchFrontmatter` (the
        function this reads through before writing) already parses via
        `readFrontmatter`, and a reader that disagrees with the writer is
        exactly how a comment on the `tools:` line (a documented, supported
        pattern — see `stripComment`) used to make the regex see `null`,
        `current` fall back to `[]`, and the write silently discard every
        tool the user had already granted.
      */
      const toolsField = readFrontmatter(source)?.fields.get('tools');
      const current = (toolsField === undefined ? null : parseList(toolsField.value)) ?? [];

      if (current.includes(rung.rule)) {
        deps.append({
          from: OVERMIND,
          to: ask.from,
          kind: 'event',
          thread: ask.id,
          // The rule was already there — the answer is still acted on and
          // recorded, the file just already said so.
          body: `granted ${rung.rule} to ${name}`,
          meta: { granted: ask.id, rule: rung.rule },
        });
        return;
      }

      const entries = [...current, rung.rule];

      /*
        The second shape check, on the exact bytes about to be written.

        `isSafeToCompose` is the first, and a single shape check is what
        failed here twice: `isToolName` closed `meta.tool`, and the *other*
        half of a composed rule — the path dirname, the WebFetch host, the
        Bash head — then turned out to be guarded only by a denylist of `,`
        and `*`, which a `\n` or a `]` walks straight through. A rule
        carrying either forges a **second `tools:` line**: `readFrontmatter`
        builds a `Map`, the later key wins, and `parseAgent` reports no
        problem at all, so the agent quietly ends up holding a tool nobody
        granted while the one the user did grant disappears.

        This is deliberately redundant with the composer, and it must stay
        redundant. It is also not only about `rung.rule`: `current` is read
        off whatever is on disk, and `parseList` splits on `,` alone, so an
        entry already in the file can carry a `]` into the value being
        composed here. Refusing the whole write is the only safe answer —
        writing "most of" a frontmatter value is how the file gets a second
        key in the first place.
      */
      const unwritable = entries.find((entry) => /[\n\r[\]#]/.test(entry));

      if (unwritable !== undefined) {
        refuse(
          ask,
          name,
          `${JSON.stringify(unwritable)} cannot be written into tools: safely`,
        );
        return;
      }

      const patched = patchFrontmatter(source, 'tools', `[${entries.join(', ')}]`);

      const result = await deps.write(name, patched);

      deps.append({
        from: OVERMIND,
        to: ask.from,
        kind: 'event',
        thread: ask.id,
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
