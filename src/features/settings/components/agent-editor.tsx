import { useState } from 'react';

import { cn } from '@/lib/utils';

import { AgentForm } from '@features/settings/components/agent-form';
import type { AgentProblem } from '@shared/agent-contract';

type Tab = 'form' | 'source';

interface AgentEditorProps {
  /** The file being edited, or `null` while its contents are still arriving. */
  path: string | null;
  /** The whole file — one buffer, shown two ways. */
  source: string;
  dirty: boolean;
  /** Why it cannot be saved. Empty means it can. */
  problems: readonly AgentProblem[];
  /** Names already spoken for. Forwarded to the form's name field. */
  taken: readonly string[];
  onChange: (source: string) => void;
  onSave: () => void;
  onDelete: () => void;
}

/**
 * The editor half of Settings › Agents (HIVE-114).
 *
 * `skill-editor.tsx`'s frame, with a Form/Source tab pair in the header.
 *
 * ## Why tabs rather than a form above the source
 *
 * The ticket describes the form as a head *above* the body, and at this pane's
 * real width that does not fit: the editor column is roughly 500–700px after
 * the 150px list, and ten fields stacked over a textarea leave the body prompt
 * — the part the user actually writes prose into — the smallest thing on
 * screen. A side-by-side split is worse: each half lands near 300px, where
 * `slack.channel:#incorp-dev` wraps.
 *
 * Tabs give both views the full height. The cost is that you cannot watch the
 * frontmatter change as you edit the form, and that cost is cheap precisely
 * because the patch is surgical — there is nothing surprising to watch. See
 * `agent-form.tsx`.
 *
 * ## Why a plain `<textarea>`
 *
 * The same argument `skill-editor.tsx` makes, unchanged: the editor seam
 * exists for repo files, and mounting it here would pull the explorer's stack
 * into settings so the user can write a paragraph.
 */
export function AgentEditor({
  path,
  source,
  dirty,
  problems,
  taken,
  onChange,
  onSave,
  onDelete,
}: AgentEditorProps) {
  const [tab, setTab] = useState<Tab>('form');

  /*
    What the footer says, and what it deliberately does not.

    A problem that names a field is rendered beside that field by `AgentForm`,
    so repeating its sentence here would print the same complaint twice on one
    screen. But a footer that then said nothing would be the failure this
    replaces — a refused Save with no reason — so it counts them instead and
    points at where they are.

    A whole-file problem has no field to sit beside, so the footer owns it
    outright.
  */
  const footer = ((): string => {
    const wholeFile = problems.find((problem) => problem.field === '');

    if (wholeFile !== undefined) return wholeFile.reason;
    if (problems.length === 0) {
      return 'The name in the frontmatter names the folder.';
    }

    /*
      On the Source tab the form is not mounted, so nothing else on screen is
      showing these. Say the first one in full rather than counting — a count
      with no reachable detail is the disabled-Save-with-no-explanation this
      whole line exists to replace.
    */
    if (tab === 'source') {
      const first = problems[0];
      const text =
        first === undefined
          ? ''
          : first.field === 'name'
            ? first.reason
            : `${first.field}: ${first.reason}`;

      return problems.length === 1
        ? text
        : `${text} (+${problems.length - 1} more)`;
    }

    return problems.length === 1
      ? `1 problem — see ${problems[0]?.field ?? 'the form'}.`
      : `${problems.length} problems — see the form.`;
  })();

  const tabClass = (which: Tab) =>
    cn(
      'rounded-[5px] px-2 py-0.5 text-[11px]',
      tab === which ? 'bg-active text-ink' : 'text-subtle hover:text-ink',
    );

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-[7px] border border-border">
      <div className="flex items-center justify-between gap-3 border-b border-border-soft px-2.5 py-1.5">
        <div role="tablist" aria-label="Agent editor view" className="flex gap-1">
          <button
            type="button"
            role="tab"
            aria-selected={tab === 'form'}
            onClick={() => setTab('form')}
            className={tabClass('form')}
          >
            Form
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={tab === 'source'}
            onClick={() => setTab('source')}
            className={tabClass('source')}
          >
            Source
          </button>
        </div>

        <span
          className={
            dirty
              ? 'shrink-0 text-[11px] text-brand'
              : 'shrink-0 text-[11px] text-subtle'
          }
        >
          {dirty ? 'unsaved' : 'saved'}
        </span>
      </div>

      {/*
        The path, not the name — the name is on the selected row, and what this
        adds is *where the bytes go*, which is what a user needs when they go
        looking for the file outside the app. `min-w-0` is load-bearing for the
        reason `skill-editor.tsx` spells out: without it `truncate` never
        engages and a long path widens the panel instead of ellipsising.

        Its own row under the tabs, because the tabs took the header line that
        Skills gives to the path.
      */}
      <div className="border-b border-border-soft px-2.5 py-1">
        <span className="block min-w-0 truncate font-mono text-[11px] text-subtle">
          {path ?? 'New agent'}
        </span>
      </div>

      {tab === 'form' ? (
        <AgentForm
          source={source}
          problems={problems}
          taken={taken}
          onChange={onChange}
        />
      ) : (
        <>
          {/*
            The one thing the Source tab could not say for itself, and the one
            users got wrong: the text under the frontmatter is the agent's job,
            re-read on every wake — not a description of what sort of agent it
            is. Every field above the line has a `FIELD_HELP` sentence; the body
            is the largest thing in the file and had none.
          */}
          <p className="border-b border-border-soft px-2.5 py-1.5 text-[11px] leading-relaxed text-subtle">
            Below the <code className="font-mono">---</code> is what this agent
            does, carried out on every wake. Write it as instructions, not as a
            description.
          </p>
          <textarea
            aria-label="Agent source"
            spellCheck={false}
            value={source}
            onChange={(event) => onChange(event.target.value)}
            className="min-h-0 flex-1 resize-none bg-panel px-2.5 py-2 font-mono text-[12px] leading-relaxed text-ink outline-none"
          />
        </>
      )}

      <div className="flex items-center justify-between gap-3 border-t border-border-soft px-2.5 py-1.5">
        <span
          className={
            problems.length === 0
              ? 'min-w-0 text-[11px] text-subtle'
              : 'min-w-0 text-[11px] text-red'
          }
        >
          {footer}
        </span>
        <div className="flex shrink-0 gap-1.5">
          <button
            type="button"
            onClick={onDelete}
            className="rounded-md border border-border px-2.5 py-1 text-[12px] text-red hover:bg-hover"
          >
            Delete
          </button>
          {/*
            Native `title`, not a Radix tooltip: the app mounts no
            `TooltipProvider` (see `.claude/COMPONENTS.md`), and the one other
            disabled-with-explanation control in the app made the same choice.
          */}
          <button
            type="button"
            disabled
            title="Agents do not run yet — that lands with the waker."
            className="rounded-md border border-border px-2.5 py-1 text-[12px] text-muted disabled:opacity-60"
          >
            Run now
          </button>
          <button
            type="button"
            onClick={onSave}
            className="rounded-md bg-brand-fill px-2.5 py-1 text-[12px] text-on-brand hover:bg-brand-fill-hover disabled:opacity-60"
          >
            Save
          </button>
        </div>
      </div>
    </div>
  );
}
