import { useEffect, useRef, useState } from 'react';

import { cn } from '@/lib/utils';

import { EditorSurface } from '@components/editor/editor-surface';
import { AgentForm } from '@features/settings/components/agent-form';
import { languageFor } from '@lib/explorer/language';
import type { AgentProblem } from '@shared/agent-contract';
import { useEditorAppearance } from '@stores/appearance-store';

type Tab = 'form' | 'source';

/**
 * The markdown grammar, resolved once at module scope.
 *
 * `EditorSurface` re-imports the grammar whenever this identity changes, so a
 * loader built in render would fetch the chunk on every keystroke. An AGENT.md
 * is always markdown — there is no file name to branch on here as there is in
 * the explorer — so the loader is a constant rather than a memo.
 */
const AGENT_LANGUAGE = languageFor('AGENT.md')?.load ?? null;

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
  /**
   * Wake this agent once, now (HIVE-117's verb, reached from here at last).
   *
   * The section owns the call rather than this component, for the reason every
   * other verb on this pane is a prop: the editor holds a buffer and knows
   * nothing about which agent is open on disk — `path` is a string it renders,
   * not a name it could pass to a bridge.
   */
  onRun: () => void;
  /**
   * What the last run attempt answered, or `null`.
   *
   * **Deliberately not a `problems` entry**, which is where this landed first
   * and where it was a trap. `problems` is what makes Save refuse *and* what
   * {@link cannotRun} reads, so reporting "it is already working" through it
   * disabled the very button that had just produced the message — and
   * relabelled it "this definition cannot be read", which was false: the
   * definition parsed, which is why the call reached main at all. The state
   * cleared only on reselect or a no-op Save.
   *
   * A refusal here is transient by construction. `working` ends, `paused` is
   * one click away, and `unknown` is the runtime coming up — every one of them
   * is a reason to try again shortly, so none of them may disable retrying.
   * `agent-view.tsx` reached the same shape from the other direction and calls
   * it `notice`.
   */
  notice: string | null;
}

/**
 * The editor half of Settings › Agents (HIVE-114).
 *
 * `skill-editor.tsx`'s frame, with a Form/Source tab pair in the header.
 *
 * ## Why tabs rather than a form above the source
 *
 * The ticket describes the form as a head *above* the body, and at this pane's
 * real width that does not fit: the editor column is roughly 450–650px after
 * the list, and ten fields stacked over a textarea leave the body prompt
 * — the part the user actually writes prose into — the smallest thing on
 * screen. A side-by-side split is worse: each half lands near 300px, where
 * `slack.channel:#incorp-dev` wraps.
 *
 * Tabs give both views the full height. The cost is that you cannot watch the
 * frontmatter change as you edit the form, and that cost is cheap precisely
 * because the patch is surgical — there is nothing surprising to watch. See
 * `agent-form.tsx`.
 *
 * ## Why the real editor, and not a `<textarea>`
 *
 * This used to be a plain textarea, on the argument `skill-editor.tsx` then
 * made — that the editor seam exists for repo files, and mounting it here would
 * pull the explorer's stack into settings so the user can write a paragraph.
 * That argument undersold what an AGENT.md is, and the skills pane has since
 * abandoned it too. It is not a paragraph: it is a
 * frontmatter block with a dozen keys whose problems the footer reports **by
 * line**, and a body long enough to scroll — so a reader told "unknown key on
 * line 7" had to count rows with a finger, and could not search the file at
 * all.
 *
 * `EditorSurface` answers all three at once — the gutter, the floating find
 * panel, and `Mod-s` bound *inside* the view, which is the only place a save
 * shortcut can be bound and still fire while CodeMirror holds focus. Markdown
 * highlighting comes with it, so the `---` fences and the keys between them
 * stop reading as prose. The cost is one CodeMirror mount in settings, which is
 * lazy-chunked like every other and only built when the Source tab is opened.
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
  onRun,
  notice,
}: AgentEditorProps) {
  const [tab, setTab] = useState<Tab>('form');
  const appearance = useEditorAppearance();

  /**
   * The live `onSave`, for a listener bound once on mount.
   *
   * `onSave` is a fresh closure on every render of `agents-section.tsx` — it
   * reads the buffer — so binding it directly would either re-attach the
   * listener on every keystroke or, with an empty dependency array, save a
   * buffer from the first render forever. The same shape `EditorSurface` uses
   * for its own `Mod-s`, and for the same reason.
   */
  const onSaveRef = useRef(onSave);
  onSaveRef.current = onSave;

  /**
   * Why Run now would refuse, or `null` when it would not.
   *
   * The button used to carry a literal `disabled` and the title "Agents do not
   * run yet — that lands with the waker." The waker landed: `agents.run` is the
   * same channel the agent view's own Run now has been calling since HIVE-117,
   * and leaving a dead control beside it told users the feature was missing
   * from the one screen where they had just finished configuring it.
   *
   * The three conditions are all about *what would actually run*. A wake reads
   * `AGENT.md` off disk — it does not see this buffer — so running with unsaved
   * edits would execute the previous version while the screen shows the new
   * one, and running a definition main has already refused would fail on the
   * problem the footer is showing. A never-saved agent has no file at all.
   *
   * Refusals that only main can know — the agent is working, or paused — are
   * not predicted here and must not appear in this chain. They arrive as an
   * `AgentRunResult` and are drawn from {@link AgentEditorProps.notice}, which
   * says why that is a separate channel rather than a fourth condition.
   */
  const cannotRun =
    path === null
      ? 'Save it first — there is no definition on disk yet.'
      : dirty
        ? 'Save first — a wake reads the file, not this buffer.'
        : problems.length > 0
          ? 'Fix the problems first — this definition cannot be read.'
          : null;

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

  /**
   * ⌘S from anywhere in the pane, and exactly once.
   *
   * The Source tab's own binding lives inside CodeMirror, which is the only
   * place a shortcut can be bound and still fire while the editor holds focus.
   * That leaves the Form tab — ten inputs, no editor — where ⌘S reached the
   * browser and offered to save the page. This listener is for them.
   *
   * A native listener on the frame rather than a JSX `onKeyDown`, the way
   * `editor-pane.tsx` binds Escape: a keyboard handler on a non-interactive
   * `<div>` is what `jsx-a11y` exists to reject, and the rule is right — the
   * shortcut must never be the *only* way to save, which is why the Save button
   * three lines below stays exactly where it is.
   *
   * Scoped to the frame, not to `window`: settings is an overlay over a shell
   * full of live terminals, and a global ⌘S would save whichever agent happened
   * to be open while the user was typing somewhere else entirely.
   *
   * `defaultPrevented` is what keeps the two bindings from doubling up:
   * CodeMirror's keymap prevents the default when it handles `Mod-s`, and the
   * event still bubbles out here. Saving twice is not harmless — `save` writes
   * through the bridge, and a rename writes through a *different* call — so the
   * guard is the point, not tidiness.
   */
  const frame = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const host = frame.current;
    if (host === null) return undefined;

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 's' || !(event.metaKey || event.ctrlKey)) return;
      if (event.defaultPrevented) return;

      event.preventDefault();
      onSaveRef.current();
    };

    host.addEventListener('keydown', onKeyDown);

    return () => {
      host.removeEventListener('keydown', onKeyDown);
    };
  }, []);

  return (
    <div
      ref={frame}
      className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-[7px] border border-border"
    >
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
          {/*
            `readOnly` is hard-`false`, and deliberately not
            `!appearance.editable`. That setting is the explorer's guard against
            editing repo files by accident; this pane exists to write this one
            file, and a settings editor that silently refused every keystroke
            because of a preference set three panes away would read as broken.

            The `fileKey` is the path, so the caret and the undo history survive
            a trip to the Form tab and back — and a *different* agent gets a
            different key, which is what stops one agent's undo stack reaching
            into another's file. A never-saved agent has no path, and every
            never-saved agent is the same draft, so they share one key.
          */}
          <EditorSurface
            ariaLabel="Agent source"
            fileKey={path ?? 'new-agent'}
            value={source}
            languageLoad={AGENT_LANGUAGE}
            readOnly={false}
            fontFamily={appearance.fontFamily}
            fontSize={appearance.fontSize}
            wordWrap={appearance.wordWrap}
            lineNumbers={appearance.lineNumbers}
            tabWidth={appearance.tabWidth}
            onChange={onChange}
            onSave={onSave}
          />
        </>
      )}

      <div className="flex items-center justify-between gap-3 border-t border-border-soft px-2.5 py-1.5">
        {/*
          The notice outranks the standing line, and is amber rather than red:
          "it is already working" is the system behaving correctly, not a fault
          in the file. A problem still wins over both — a definition that will
          not parse is the more urgent fact, and it is also why the run was
          never attempted.
        */}
        {problems.length === 0 && notice !== null ? (
          <span role="status" className="min-w-0 text-[11px] text-amber">
            {notice}
          </span>
        ) : (
          <span
            className={
              problems.length === 0
                ? 'min-w-0 text-[11px] text-subtle'
                : 'min-w-0 text-[11px] text-red'
            }
          >
            {footer}
          </span>
        )}
        <div className="flex shrink-0 gap-1.5">
          <button
            type="button"
            onClick={onDelete}
            className="rounded-md border border-border px-2.5 py-1 text-[12px] text-red hover:bg-hover"
          >
            Delete
          </button>
          {/*
            Native `title`, not a Radix tooltip: this affordance predates
            `TooltipProvider` (now mounted in `app.tsx` for the rail strips —
            see `.claude/COMPONENTS.md`), and the one other
            disabled-with-explanation control in the app made the same choice.
          */}
          <button
            type="button"
            disabled={cannotRun !== null}
            onClick={onRun}
            title={cannotRun ?? 'Wake this agent once, now.'}
            className="rounded-md border border-border px-2.5 py-1 text-[12px] text-muted hover:bg-hover hover:text-ink disabled:opacity-60 disabled:hover:bg-transparent disabled:hover:text-muted"
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
