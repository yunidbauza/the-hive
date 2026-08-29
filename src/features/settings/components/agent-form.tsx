import { SegmentedControl } from '@components/ui/segmented-control';
import {
  AUTONOMIES,
  patchFrontmatter,
  readFrontmatter,
  type AgentProblem,
} from '@shared/agent-contract';
import { SESSION_MODELS } from '@shared/session-contract';


interface AgentFormProps {
  /** The whole file. The form reads it and patches it; it never rebuilds it. */
  source: string;
  problems: readonly AgentProblem[];
  onChange: (source: string) => void;
}

/**
 * The frontmatter, as a form (HIVE-114).
 *
 * ## It edits the file, not a model
 *
 * Every control's `onChange` calls {@link patchFrontmatter}, which rewrites one
 * line's value and leaves the rest of the bytes alone. The form never
 * *constructs* frontmatter, because constructing it would mean serialising a
 * parsed model — and that destroys every `#` comment and any key order the
 * author chose. The example definition in the ticket is full of both.
 *
 * So the Form tab and the Source tab are two views of one buffer in the strict
 * sense: switching between them cannot change a byte.
 *
 * ## Why the fields come from a table
 *
 * `AGENT_FIELDS` is the same table `parseAgent` validates against, so every
 * problem's `field` is a path this file knows about. The ones with a control
 * render beside it; the ones without — see {@link RENDERED_PATHS} — render at
 * the top, so a refusal can never point at nothing.
 */

/** Wake intervals worth one click. `off` writes no `every:` at all. */
const WAKE_OPTIONS = [
  { value: 'off', label: 'off' },
  { value: '1m', label: '1m' },
  { value: '5m', label: '5m' },
  { value: '15m', label: '15m' },
  { value: '1h', label: '1h' },
  { value: 'daily', label: 'daily' },
] as const;

const MODEL_OPTIONS = [
  { value: 'default', label: 'default' },
  ...SESSION_MODELS.map((model) => ({ value: model, label: model })),
] as const;

const AUTONOMY_OPTIONS = [
  { value: 'ask', label: 'ask first' },
  { value: 'act', label: 'act' },
] as const;

/** Fields shown as a plain text input, in the order the table declares them. */
const TEXT_FIELDS = ['description', 'icon'] as const;

const LIST_FIELDS = [
  { path: 'wake.on', label: 'wake on' },
  { path: 'skills', label: 'skills' },
  { path: 'mcp', label: 'integrations' },
  { path: 'tools', label: 'tools' },
] as const;

const LIMIT_FIELDS = [
  { path: 'limits.turns', label: 'turns' },
  { path: 'limits.budget_usd', label: 'budget $' },
  { path: 'limits.rotate_after', label: 'rotate after' },
] as const;

/**
 * The paths this form actually draws a control for.
 *
 * Not the same as `AGENT_FIELDS`, and the difference is load-bearing. `name`
 * is in the table but has no control on purpose — it is *mirrored* from the
 * frontmatter so an agent has exactly one name — and `effort` has none yet. A
 * problem naming either would have no row to sit beside, so testing membership
 * against the table rather than against this set made those problems render
 * nowhere at all: refused Save, no visible reason.
 */
const RENDERED_PATHS: readonly string[] = [
  ...TEXT_FIELDS,
  'wake.every',
  'wake.quiet',
  ...LIST_FIELDS.map((field) => field.path),
  'autonomy',
  'model',
  ...LIMIT_FIELDS.map((field) => field.path),
];

export function AgentForm({ source, problems, onChange }: AgentFormProps) {
  const read = readFrontmatter(source);
  const fields = read?.fields;
  const at = (path: string) => fields?.get(path)?.value ?? '';

  /**
   * Delete the key's line entirely.
   *
   * Absence is a *value* in this grammar — no `every:` means manual-only, no
   * `model:` means the default — and there is no token that spells it. Writing
   * `key:` with nothing after it instead produces a line the parser rejects
   * ("Must be a list, like [a, b]"), which is what clearing an optional text
   * field used to do: the form jammed, and the only way out was the Source tab.
   */
  const clear = (path: string) => {
    const line = readFrontmatter(source)?.fields.get(path)?.line;

    if (line === undefined) return;

    const lines = source.split('\n');

    lines.splice(line, 1);
    onChange(lines.join('\n'));
  };

  const set = (path: string, value: string) => {
    if (value.trim() === '') {
      clear(path);
      return;
    }

    onChange(patchFrontmatter(source, path, value));
  };

  const problemFor = (path: string) =>
    problems.find((problem) => problem.field === path)?.reason ?? null;

  const row = (path: string, label: string, control: React.ReactNode) => {
    const problem = problemFor(path);

    return (
      <div key={path} className="grid grid-cols-[92px_minmax(0,1fr)] gap-2.5">
        <label className="pt-1 text-right text-[11px] text-subtle">
          {label}
        </label>
        <div className="flex min-w-0 flex-col gap-1">
          {control}
          {/*
            Beside the field it names, not only in the footer. A list of
            problems under the buttons makes the reader match names to controls
            themselves; this puts the sentence where the fix happens.
          */}
          {problem === null ? null : (
            <span role="alert" className="text-[11px] text-red">
              {problem}
            </span>
          )}
        </div>
      </div>
    );
  };

  const input = (path: string, placeholder = '') => (
    <input
      type="text"
      spellCheck={false}
      value={at(path)}
      placeholder={placeholder}
      onChange={(event) => set(path, event.target.value)}
      className="min-w-0 rounded-[5px] border border-border-soft bg-panel-2 px-2 py-1 text-[11.5px] text-ink outline-none focus:border-border"
    />
  );

  const wakeEvery = at('wake.every');
  const model = at('model');

  /*
    Problems with nowhere to sit: the name (mirrored, so it has no control), an
    unknown key (whose `field` is whatever the user typed), and `effort`.

    At the **top** rather than the bottom. This form scrolls past a dozen rows,
    and a homeless problem is the most global one there is — putting it below
    the fold is the same as not showing it.

    Whole-file problems are excluded: the footer owns those, and printing them
    in both places says one sentence twice.
  */
  const homeless = problems.filter(
    (problem) =>
      problem.field !== '' && !RENDERED_PATHS.includes(problem.field),
  );

  /*
    Without fences there is no frontmatter to read *or* patch: every field
    would render blank and every keystroke would be a silent no-op, because
    `patchFrontmatter` returns the source unchanged. That is precisely the file
    the pane promises can be opened and fixed, so it says what is wrong and
    sends the user to the tab that can fix it.
  */
  if (read === null) {
    return (
      <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-1 px-4 text-center">
        <span className="text-[11.5px] text-amber">
          This file has no frontmatter.
        </span>
        <span className="text-[11.5px] text-subtle">
          It must open and close with a --- line. Fix it in the Source tab and
          the form comes back.
        </span>
      </div>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-2.5 overflow-y-auto px-3 py-3">
      {homeless.map((problem) => (
        <p
          key={`${problem.field}:${problem.reason}`}
          role="alert"
          className="rounded-[5px] border border-red px-2.5 py-1.5 text-[11px] text-red"
        >
          {problem.field === 'name'
            ? problem.reason
            : `${problem.field}: ${problem.reason}`}
        </p>
      ))}

      {TEXT_FIELDS.map((path) =>
        row(path, path, input(path, path === 'icon' ? 'a Phosphor name' : '')),
      )}

      {row(
        'wake.every',
        'wake every',
        <SegmentedControl
          label="Wake every"
          options={WAKE_OPTIONS}
          value={
            WAKE_OPTIONS.some((option) => option.value === wakeEvery)
              ? (wakeEvery as (typeof WAKE_OPTIONS)[number]['value'])
              : 'off'
          }
          onChange={(next) => {
            /*
              `off` is the absence of a key, not a value — an agent with no
              `every:` is manual-only, which the grammar expresses by the line
              simply not being there. Writing `every: off` would be a value the
              parser rejects.
            */
            if (next === 'off') clear('wake.every');
            else set('wake.every', next);
          }}
        />,
      )}

      {row('wake.quiet', 'quiet hours', input('wake.quiet', '23:00-07:00'))}

      {LIST_FIELDS.map(({ path, label }) =>
        row(path, label, input(path, '[a, b]')),
      )}

      {row(
        'autonomy',
        'autonomy',
        <SegmentedControl
          label="Autonomy"
          options={AUTONOMY_OPTIONS}
          value={
            (AUTONOMIES as readonly string[]).includes(at('autonomy'))
              ? (at('autonomy') as (typeof AUTONOMY_OPTIONS)[number]['value'])
              : 'ask'
          }
          onChange={(next) => set('autonomy', next)}
        />,
      )}

      {row(
        'model',
        'model',
        <SegmentedControl
          label="Model"
          options={MODEL_OPTIONS}
          value={
            (SESSION_MODELS as readonly string[]).includes(model)
              ? (model as (typeof MODEL_OPTIONS)[number]['value'])
              : 'default'
          }
          onChange={(next) => {
            // Same absence-is-a-value argument as `wake.every`'s `off`.
            if (next === 'default') clear('model');
            else set('model', next);
          }}
        />,
      )}

      {LIMIT_FIELDS.map(({ path, label }) => row(path, label, input(path)))}
    </div>
  );
}
