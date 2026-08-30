import { useEffect, useState } from 'react';

import { useSwarmPhrase } from '@/hooks/use-swarm-phrase';
import {
  deleteAgent,
  frontmatterName,
  loadAgents,
  nextAgentName,
  readAgent,
  renameAgent,
  saveAgent,
} from '@/lib/agents';

import { SwarmCreature } from '@components/ui/swarm-creature';
import { AgentEditor } from '@features/settings/components/agent-editor';
import { SettingsSectionHeader } from '@features/settings/components/settings-section-header';
import { SkillDiscardConfirm } from '@features/settings/components/skill-discard-confirm';
import { useAgents } from '@hooks/use-agents';
import {
  AGENT_NAME_PATTERN,
  RESERVED_AGENT_NAMES,
  type AgentProblem,
} from '@shared/agent-contract';

/**
 * The Agents section of settings (HIVE-114).
 *
 * `skills-section.tsx`'s skeleton — master–detail, 150px list beside the
 * editor — with three deliberate differences, each earned rather than
 * inherited:
 *
 * 1. **A broken definition can be opened.** An invalid *skill*'s row is
 *    disabled because main could not read a name out of the file, so there was
 *    nothing for the pane to address. An agent's *folder* names it, so there
 *    is always a file to open — and the acceptance criteria require fixing an
 *    unknown key after being told about it, which a disabled row makes
 *    impossible.
 * 2. **Refusals are structured.** `AgentWriteResult` carries problems that each
 *    name a field, and the editor renders them beside the controls they name.
 *    Skills have one error string because their only rule is the name.
 * 3. **Renaming is one call.** Main moves the folder and rewrites the `name:`
 *    inside it together, so there is no window in which the definition
 *    contradicts its own folder — the window that forced `renameSkill` to
 *    report whether the move landed.
 */

/**
 * What a new agent starts as.
 *
 * A template rather than an empty box: the frontmatter is not guessable and a
 * file without it is one main refuses.
 *
 * **`name` is seeded, not blank.** It used to be left empty on the argument
 * that the user must supply it and that seeding invites a tree full of
 * `new-agent`s — but the form had no name control at all, so the only
 * expression that argument found was a red box the form could not clear. A
 * free `agent-n` plus an editable field is the same argument made somewhere
 * the user can act on it, and it is how a session already opens.
 *
 * `icon` is seeded with a name the icon registry can actually draw. `Robot`
 * was not one: `GLYPHS` is keyed `ph-robot`, so every agent created from this
 * template rendered the fallback question mark on its own row.
 */
const templateFor = (taken: readonly string[]): string => `---
name: ${nextAgentName(taken)}
description: What this agent watches, and what it does about it
icon: ph-robot
wake:
  every: 5m
  on: [ledger]
autonomy: ask
---

You are … . On every wake, read your ledger inbox first, then do your job.
`;

/** Why this name cannot be saved, or `null`. Mirrors main's own rules. */
function nameProblem(name: string, taken: readonly string[]): string | null {
  if (name === '') return 'Give the agent a name in its frontmatter.';
  if ((RESERVED_AGENT_NAMES as readonly string[]).includes(name)) {
    return `"${name}" is reserved by The Hive.`;
  }
  if (!AGENT_NAME_PATTERN.test(name)) {
    return 'Lowercase letters, digits and dashes only.';
  }
  if (taken.includes(name)) return `You already have an agent called ${name}.`;
  return null;
}

export function AgentsSection() {
  const snapshot = useAgents();
  const phrase = useSwarmPhrase('empty.settingsSkills');

  /** Which agent is open, or `null` for a new one never saved. */
  const [open, setOpen] = useState<string | null>(null);
  const [buffer, setBuffer] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  const [pending, setPending] = useState<{
    question: string;
    detail: string;
    confirmLabel: string;
    act: () => void;
  } | null>(null);
  /** What main refused, field by field. Cleared on every fresh attempt. */
  const [problems, setProblems] = useState<AgentProblem[]>([]);

  useEffect(() => {
    void loadAgents();
  }, []);

  const agents = snapshot?.agents ?? [];
  const dirty = buffer !== null && buffer !== saved;
  const empty = agents.length === 0 && buffer === null;

  /**
   * Names already spoken for, excluding the one being edited.
   *
   * Invalid ones count, for the reason the skills pane learned: they are
   * folders on disk with an AGENT.md in them, so saving under one of their
   * names overwrites a real file — and the likeliest invalid agent is one
   * whose frontmatter name and folder disagree, which is exactly the name the
   * user is then likely to type.
   */
  const allNames = agents.map((agent) => agent.name);
  const taken = allNames.filter((name) => name !== open);
  const typed = buffer === null ? '' : frontmatterName(buffer);
  const localProblem = buffer === null ? null : nameProblem(typed, taken);

  /*
    What the editor shows: the local name check first, then whatever main last
    refused. The local one comes first because it is the only problem the pane
    can know before asking, and it is by far the most common.
  */
  const shown: AgentProblem[] =
    localProblem === null
      ? problems
      : [{ field: 'name', reason: localProblem }, ...problems];

  const guard = (
    act: () => void,
    question: string,
    detail: string,
    confirmLabel: string,
  ): void => {
    if (!dirty) {
      act();
      return;
    }
    setPending({ question, detail, confirmLabel, act });
  };

  const discardQuestion =
    open === null ? 'Discard this new agent?' : `Discard changes to ${open}?`;
  const discardDetail =
    open === null
      ? 'It has never been saved, so there is nothing on disk to keep.'
      : 'The file on disk is unchanged. Your edits in this box are lost.';

  const openAgent = (name: string): void => {
    guard(
      () => {
        setOpen(name);
        setBuffer(null);
        setSaved(null);
        setProblems([]);

        void readAgent(name).then((source) => {
          if (source === null) {
            /*
              The folder is on disk but the IPC guard refuses to address it —
              an upper-case or reserved folder name. Saying so beats the
              silence this used to render: the row highlighted, the editor
              stayed on its placeholder, and nothing explained why.
            */
            setProblems([
              {
                field: '',
                reason:
                  'This folder cannot be opened. Rename it on disk to lowercase letters, digits and dashes.',
              },
            ]);
            return;
          }

          /*
            Drop a response the user has moved on from — two quick clicks race,
            and whichever read resolves last would otherwise land the first
            row's body under the second row's name. `skills-section.tsx` pays
            for this one too.
          */
          setOpen((current) => {
            if (current !== name) return current;
            setBuffer(source);
            setSaved(source);
            return current;
          });
        });
      },
      discardQuestion,
      discardDetail,
      'Discard',
    );
  };

  const newAgent = (): void => {
    guard(
      () => {
        setOpen(null);
        /*
          `allNames`, not `taken`. `taken` excludes the *currently open* agent
          so its own name does not read as a duplicate of itself — but by the
          time this runs `open` is being set to null, so seeding from it could
          draw the open agent's own name and produce a brand-new agent that
          arrives already refused: exactly the pre-refused state the name field
          exists to make unreachable.
        */
        setBuffer(templateFor(allNames));
        // Never equal to the buffer, so a fresh template counts as unsaved —
        // which it is: nothing has been written.
        setSaved(null);
        setProblems([]);
      },
      discardQuestion,
      discardDetail,
      'Discard',
    );
  };

  const save = (): void => {
    if (buffer === null || localProblem !== null) return;

    setProblems([]);

    void (async () => {
      /*
        A rename carries the buffer, so it is one operation rather than a move
        followed by a write. Moving first and writing after validated the
        *stale* file: fixing a broken definition and renaming it in the same
        edit — the flow this pane exists to support — was refused with problems
        the user had already resolved, and the corrected buffer never landed.
      */
      const result =
        open !== null && open !== typed
          ? await renameAgent(open, typed, buffer)
          : await saveAgent(typed, buffer);

      if (!result.ok) {
        setProblems(result.problems);
        return;
      }

      setOpen(typed);
      setSaved(buffer);
    })();
  };

  const remove = (): void => {
    if (open === null) {
      // Never written, so there is nothing to delete — just close it.
      setBuffer(null);
      setSaved(null);
      setProblems([]);
      return;
    }

    setPending({
      question: `Delete ${open}?`,
      detail: 'The folder and its AGENT.md are removed from disk.',
      confirmLabel: 'Delete',
      act: () => {
        void deleteAgent(open).then((result) => {
          if (!result.ok) {
            setProblems(result.problems);
            return;
          }
          setOpen(null);
          setBuffer(null);
          setSaved(null);
        });
      },
    });
  };

  const description =
    'Background agents that wake on a schedule or a message and correspond through the ledger. Saved as AGENT.md under ~/.hive/agents.';

  /*
    No snapshot is the browser demo, which has no bridge to ask and no disk to
    write to — the same header-only shape `skills-section.tsx` uses, and for
    the same reason: a pane of dead controls teaches the user the app is broken.
  */
  if (!snapshot) {
    return (
      <div className="flex min-h-0 flex-1 flex-col gap-6 overflow-y-auto px-5 py-4">
        <SettingsSectionHeader
          title="Agents"
          description="Background agents are only available in the desktop app."
        />
      </div>
    );
  }

  if (empty) {
    return (
      <div className="flex min-h-0 flex-1 flex-col gap-3.5 overflow-y-auto px-5 py-4">
        <SettingsSectionHeader title="Agents" description={description} />

        <div className="flex flex-col items-center gap-1 rounded-[7px] border border-dashed border-border px-4 py-6 text-center">
          <SwarmCreature creature="hydralisk" size={72} />
          <span className="text-[11.5px] text-muted">{phrase}</span>
          <span className="text-[11.5px] text-subtle">
            Write one and it will be listed here, asleep until the waker lands.
          </span>
        </div>

        <button
          type="button"
          onClick={newAgent}
          className="w-fit rounded-md bg-brand-fill px-3 py-1.5 text-[12.5px] text-on-brand hover:bg-brand-fill-hover"
        >
          + New agent
        </button>

        <p className="mt-auto pt-2 text-[11px] text-subtle">
          Agents folder: {snapshot.agentsRoot}
        </p>
      </div>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3.5 overflow-hidden px-5 py-4">
      <SettingsSectionHeader title="Agents" description={description} />

      <div className="grid min-h-0 flex-1 grid-cols-[150px_minmax(0,1fr)] gap-3">
        <div className="flex flex-col overflow-y-auto rounded-[7px] border border-border">
          {agents.map((agent) => {
            const active = agent.name === open;
            const broken = agent.invalid !== undefined;

            return (
              <button
                key={agent.name}
                type="button"
                /*
                  Not disabled when broken — unlike an invalid skill's row.
                  The folder names it, so there is a file to open, and the user
                  has to be able to open it to fix the key they were told about.
                */
                onClick={() => openAgent(agent.name)}
                title={broken ? agent.invalid : undefined}
                className={`flex items-center justify-between gap-2 border-b border-border-soft px-2.5 py-1.5 text-left text-[12.5px] last:border-b-0 hover:bg-hover hover:text-ink ${
                  active ? 'bg-active text-ink' : 'text-muted'
                }`}
              >
                <span className="truncate font-mono">{agent.name}</span>
                {broken ? (
                  <span className="shrink-0 text-[11px] text-amber">invalid</span>
                ) : (
                  <span
                    className="shrink-0 text-[11px] text-subtle"
                    title={
                      agent.wake.everyMs === undefined &&
                      agent.wake.on.length === 0
                        ? 'Manual only — no schedule and no triggers.'
                        : undefined
                    }
                  >
                    {agent.status}
                  </span>
                )}
                {active && dirty ? (
                  <span className="shrink-0 text-[11px] text-brand">edited</span>
                ) : null}
              </button>
            );
          })}

          <button
            type="button"
            onClick={newAgent}
            className="border-t border-border-soft px-2.5 py-1.5 text-left font-mono text-[12.5px] text-brand hover:bg-hover"
          >
            + New agent
          </button>
        </div>

        {buffer === null ? (
          <div className="flex items-center justify-center rounded-[7px] border border-dashed border-border px-4 text-center text-[11.5px] text-subtle">
            Select an agent, or write a new one.
          </div>
        ) : (
          <div className="flex min-h-0 flex-col gap-2">
            <AgentEditor
              path={
                open === null
                  ? null
                  : `${snapshot.agentsRoot}/${open}/AGENT.md`
              }
              source={buffer}
              dirty={dirty}
              taken={taken}
              problems={shown}
              onChange={setBuffer}
              onSave={save}
              onDelete={remove}
            />

            {pending === null ? null : (
              <SkillDiscardConfirm
                question={pending.question}
                detail={pending.detail}
                confirmLabel={pending.confirmLabel}
                onConfirm={() => {
                  pending.act();
                  setPending(null);
                }}
                onCancel={() => setPending(null)}
              />
            )}
          </div>
        )}
      </div>

      <p className="text-[11px] text-subtle">
        Agents folder: {snapshot.agentsRoot}
      </p>
    </div>
  );
}
