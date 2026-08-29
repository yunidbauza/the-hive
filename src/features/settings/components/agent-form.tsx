import { useState } from 'react';

import { IconPicker, type IconGroup } from '@components/ui/icon-picker';
import {
  SegmentedControl,
  type SegmentedOption,
} from '@components/ui/segmented-control';
import { SettingsGroup } from '@features/settings/components/settings-group';
import {
  AGENT_LIMIT_DEFAULTS,
  AUTONOMIES,
  WAKE_DAYS,
  parseDays,
  parseTimes,
  patchFrontmatter,
  readFrontmatter,
  type AgentProblem,
} from '@shared/agent-contract';
import { SESSION_MODELS } from '@shared/session-contract';


interface AgentFormProps {
  /** The whole file. The form reads it and patches it; it never rebuilds it. */
  source: string;
  problems: readonly AgentProblem[];
  /**
   * Names already spoken for, excluding the agent being edited.
   *
   * The form needs these because the *name* is the one field whose validity
   * depends on the rest of the fleet, and it is the field this form now dedupes
   * rather than refuses — see {@link AgentForm}'s name row.
   */
  taken: readonly string[];
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
 * sense: switching between them cannot change a byte. That is also what makes
 * the name field two-way for free — it reads and patches `name:` like every
 * other control, so typing in either view moves the other.
 *
 * ## Why the fields come from a table
 *
 * `AGENT_FIELDS` is the same table `parseAgent` validates against, so every
 * problem's `field` is a path this file knows about. The ones with a control
 * render beside it; the ones without — see {@link RENDERED_PATHS} — render at
 * the top, so a refusal can never point at nothing.
 *
 * ## Every field says what it wants
 *
 * {@link FIELD_HELP} carries one sentence per rendered path, drawn under the
 * control in the muted idiom `SettingsGroup` uses next door. The pane used to
 * show `[a, b]` as a placeholder for four different list fields and nothing at
 * all for the three limits — a syntax hint that names no value, and no hint of
 * the defaults. A test asserts every rendered path has a sentence, so a field
 * cannot be added without one.
 *
 * ## Four groups, because thirteen fields with explanations is a wall
 *
 * Each explanation roughly doubles a row's height, and a flat list of thirteen
 * of those scans as one undifferentiated column. The groups are not cosmetic
 * either: the group's own sentence carries the context that would otherwise be
 * repeated across three field-level ones.
 */

/**
 * Intervals worth one click.
 *
 * Wider than the original five. `3h`, `6h` and `12h` were always legal —
 * `parseDuration` takes any `<n>h` — and were unavailable only because nobody
 * had put them on the control, which is the gap the calendar mode made obvious.
 */
const WAKE_OPTIONS = [
  { value: '1m', label: '1m' },
  { value: '5m', label: '5m' },
  { value: '15m', label: '15m' },
  { value: '30m', label: '30m' },
  { value: '1h', label: '1h' },
  { value: '3h', label: '3h' },
  { value: '6h', label: '6h' },
  { value: '12h', label: '12h' },
  { value: 'daily', label: 'daily' },
] as const;

/**
 * The three ways an agent can be scheduled — or not be.
 *
 * `every` and `at` are two *modes* rather than two settings, and the parser
 * refuses a definition naming both: an interval measures from the last wake and
 * a time fires on the clock, so "every 3 hours, and also at 09:00" has no
 * honest reading. A toggle is how a form says "two modes" — offering both sets
 * of controls at once would invite exactly the file the parser rejects.
 */
const WAKE_MODES = [
  { value: 'off', label: 'off' },
  { value: 'every', label: 'every…' },
  { value: 'at', label: 'on a schedule' },
] as const;

type WakeMode = (typeof WAKE_MODES)[number]['value'];

/** Times offered as one click. Anything else is added in the Source tab. */
const TIME_PRESETS = ['06:00', '09:00', '12:00', '17:00', '21:00'] as const;

/** What a mode is switched *to*, when the buffer has nothing to switch to. */
const WAKE_DEFAULTS = { every: '5m', at: '[09:00]' } as const;

const MODEL_OPTIONS = [
  { value: 'default', label: 'default' },
  ...SESSION_MODELS.map((model) => ({ value: model, label: model })),
] as const;

const AUTONOMY_OPTIONS = [
  { value: 'ask', label: 'ask first' },
  { value: 'act', label: 'act' },
] as const;

/**
 * The glyphs an agent may wear, grouped by the kind of thing an agent is.
 *
 * A curated roster rather than the whole registry: most of what the app bundles
 * is file-type glyphs for the explorer, which say nothing about a background
 * agent. Every entry must still be a name the `Icon` atom can draw —
 * `tests/features/settings/components/agent-form.test.tsx` asserts it, which is
 * the property that makes the picker unable to reproduce the free-text field's
 * question mark.
 *
 * The groups earn their place at this size: thirty-six in one block is a wall,
 * and these six are genuinely the kinds of thing a background agent tends to be.
 */
export const AGENT_ICON_GROUPS: readonly IconGroup[] = [
  {
    label: 'watching',
    names: [
      'ph-eye',
      'ph-binoculars',
      'ph-detective',
      'ph-broadcast',
      'ph-pulse',
      'ph-target',
    ],
  },
  {
    label: 'messaging',
    names: [
      'ph-envelope',
      'ph-chat-circle-dots',
      'ph-slack-logo',
      'ph-paper-plane-tilt',
      'ph-megaphone',
      'ph-bell',
    ],
  },
  {
    label: 'code and repos',
    names: [
      'ph-git-pull-request',
      'ph-github-logo',
      'ph-git-branch',
      'ph-terminal',
      'ph-file-code',
      'ph-bug',
    ],
  },
  {
    label: 'time',
    names: [
      'ph-calendar-check',
      'ph-clock',
      'ph-alarm',
      'ph-hourglass',
      'ph-moon',
      'ph-arrows-clockwise',
    ],
  },
  {
    label: 'data',
    names: [
      'ph-database',
      'ph-chart-line',
      'ph-graph',
      'ph-stack',
      'ph-package',
      'ph-funnel',
    ],
  },
  {
    label: 'kind and state',
    names: [
      'ph-robot',
      'ph-gear',
      'ph-shield-check',
      'ph-warning',
      'ph-fire',
      'ph-lightning',
    ],
  },
];

const LIST_FIELDS = [
  { path: 'skills', label: 'skills', hint: '[jira-writer]' },
  { path: 'mcp', label: 'integrations', hint: '[slack]' },
  { path: 'tools', label: 'tools', hint: '[Read, Grep]' },
] as const;

const LIMIT_FIELDS = [
  {
    path: 'limits.turns',
    label: 'turns',
    hint: String(AGENT_LIMIT_DEFAULTS.turns),
  },
  {
    path: 'limits.budget_usd',
    label: 'budget $',
    hint: AGENT_LIMIT_DEFAULTS.budgetUsd.toFixed(2),
  },
  {
    path: 'limits.rotate_after',
    label: 'rotate after',
    hint: String(AGENT_LIMIT_DEFAULTS.rotateAfter),
  },
] as const;

/**
 * What each field wants, in one sentence, under the control.
 *
 * The defaults are interpolated from `AGENT_LIMIT_DEFAULTS` rather than typed
 * out, so a sentence cannot promise a default the parser does not apply.
 */
export const FIELD_HELP: Record<string, string> = {
  name: 'Lowercase letters, digits and dashes. Names the folder under ~/.hive/agents, and is how the agent signs its ledger entries.',
  description:
    'What this agent watches, and what it does about it. Shown under its name in the rail.',
  icon: 'Shown on the agent’s row in the rail. Every icon here ships with the app, so what you pick is what renders.',
  /*
    Says outright what `daily` means, because it is not what it looks like:
    `parseDuration` reads it as 86,400,000ms, so a "daily" agent wakes 24 hours
    after its last wake and drifts on every restart. The schedule mode beside it
    is what a fixed time of day is for.
  */
  'wake.every':
    'Measured from the last wake, so daily means every 24 hours rather than a fixed time of day. For a fixed time, use the schedule mode instead.',
  'wake.at':
    'Local times, as [09:00, 17:00]. Two times means it wakes twice a day. Other times can be added in the Source tab.',
  'wake.days':
    'Days those times fire on. Selecting all seven, or none, means every day.',
  'wake.quiet':
    'Local HH:MM-HH:MM, and may wrap midnight. No scheduled wakes inside the window; a message addressed to the agent still wakes it.',
  'wake.on':
    'Events that wake it outside its schedule. ledger — someone addresses it in the log. slack.mention — it is @-mentioned. slack.channel:#name — anything posted there.',
  skills:
    'Skills the agent may invoke, by name, as [a, b]. Empty means it runs with none.',
  mcp: 'Integrations it may reach, as [a, b]. Naming one here does not connect it — signing in is separate.',
  tools:
    'Tools it may call, as [a, b]. The hive ledger tools are always granted. A tool its body needs but this list omits is refused while it runs.',
  autonomy:
    'ask first — it posts a question to the ledger and waits for an answer. act — it proceeds and reports afterwards.',
  model:
    'Which model each wake runs on. Default follows the model Claude Code would pick on its own.',
  'limits.turns': `Most turns in one wake before the run is cut off. Default ${AGENT_LIMIT_DEFAULTS.turns}.`,
  'limits.budget_usd': `Most dollars one wake may spend. Default ${AGENT_LIMIT_DEFAULTS.budgetUsd.toFixed(2)}.`,
  'limits.rotate_after': `Runs before the agent starts a fresh session, carrying a written handoff. Default ${AGENT_LIMIT_DEFAULTS.rotateAfter}.`,
};

/**
 * The paths this form actually draws a control for.
 *
 * Not the same as `AGENT_FIELDS`, and the difference is load-bearing. `effort`
 * is in the table and has no control yet, so a problem naming it would have no
 * row to sit beside — testing membership against the table rather than against
 * this set made those problems render nowhere at all: refused Save, no visible
 * reason.
 *
 * `name` used to be the other one. It is here now: it has an input, so a
 * problem naming it belongs beside that input rather than in the banner.
 */
export const RENDERED_PATHS: readonly string[] = [
  'name',
  'description',
  'icon',
  'wake.every',
  'wake.at',
  'wake.days',
  'wake.quiet',
  'wake.on',
  ...LIST_FIELDS.map((field) => field.path),
  'autonomy',
  'model',
  ...LIMIT_FIELDS.map((field) => field.path),
];

/** The first free `-n` for a name someone else already holds. */
function firstFree(base: string, taken: readonly string[]): string {
  for (let suffix = 2; ; suffix += 1) {
    const candidate = `${base}-${suffix}`;

    if (!taken.includes(candidate)) return candidate;
  }
}

export function AgentForm({
  source,
  problems,
  taken,
  onChange,
}: AgentFormProps) {
  /**
   * What the name field did to the name on its way out, or `null`.
   *
   * A duplicate used to be a red refusal that disabled Save; it is now resolved
   * the way a colliding session name is, by numbering. But resolving silently
   * would be its own bug — the user typed one thing and the file says another —
   * so the blur that renumbers leaves a muted sentence saying what it did,
   * cleared by the next keystroke.
   */
  const [renamed, setRenamed] = useState<{ from: string; to: string } | null>(
    null,
  );

  const read = readFrontmatter(source);
  const fields = read?.fields;
  const at = (path: string) => fields?.get(path)?.value ?? '';
  const has = (path: string) => fields?.has(path) === true;

  /**
   * Delete the key's line entirely.
   *
   * Absence is a *value* in this grammar — no `every:` means not on an
   * interval, no `model:` means the default — and there is no token that spells
   * it. Writing `key:` with nothing after it instead produces a line the parser
   * rejects ("Must be a list, like [a, b]"), which is what clearing an optional
   * text field used to do: the form jammed, and the only way out was the Source
   * tab.
   */
  const clear = (path: string, from: string = source): string => {
    const line = readFrontmatter(from)?.fields.get(path)?.line;

    if (line === undefined) return from;

    const lines = from.split('\n');

    lines.splice(line, 1);

    return lines.join('\n');
  };

  const set = (path: string, value: string) => {
    if (value.trim() === '') {
      onChange(clear(path));
      return;
    }

    onChange(patchFrontmatter(source, path, value));
  };

  /*
    `name` never takes the `clear` branch, unlike every other text field.
    Absence is not a legal value for it — the folder is named from it — so an
    emptied box has to stay an empty `name:` line the user can type back into,
    rather than a deleted key that `patchFrontmatter` would later re-add at the
    bottom of the frontmatter, below the block it was declared above.
  */
  const setName = (value: string) => {
    setRenamed(null);
    onChange(patchFrontmatter(source, 'name', value));
  };

  // ---- the wake mode ----------------------------------------------------

  const mode: WakeMode = has('wake.at')
    ? 'at'
    : has('wake.every')
      ? 'every'
      : 'off';

  /*
    Switching modes clears the other mode's keys in the same edit, because the
    parser refuses a definition carrying both. Doing it as one `onChange` rather
    than three matters: each call is a whole new buffer, so three would have the
    last one win over a `source` prop that had not moved yet.
  */
  const setMode = (next: WakeMode) => {
    let draft = source;

    if (next === 'off') {
      draft = clear('wake.every', draft);
      draft = clear('wake.at', draft);
      draft = clear('wake.days', draft);
    } else if (next === 'every') {
      draft = clear('wake.at', draft);
      draft = clear('wake.days', draft);
      if (!has('wake.every')) {
        draft = patchFrontmatter(draft, 'wake.every', WAKE_DEFAULTS.every);
      }
    } else {
      draft = clear('wake.every', draft);
      if (!has('wake.at')) {
        draft = patchFrontmatter(draft, 'wake.at', WAKE_DEFAULTS.at);
      }
    }

    onChange(draft);
  };

  const times = parseTimes(at('wake.at')) ?? [];
  const days = parseDays(at('wake.days')) ?? [];

  /*
    Presets, plus anything the file already names that is not one — a
    hand-written 07:30 must stay visible and removable, not vanish because the
    form only knows five times.
  */
  const timeChips = [
    ...TIME_PRESETS,
    ...times.filter((time) => !(TIME_PRESETS as readonly string[]).includes(time)),
  ];

  const toggleTime = (time: string) => {
    const next = times.includes(time)
      ? times.filter((each) => each !== time)
      : [...times, time].sort();

    // The last time cannot be removed: `days` with no `at` names no wake at
    // all, and the parser says so. Switch the mode off instead.
    if (next.length === 0) return;

    set('wake.at', `[${next.join(', ')}]`);
  };

  /*
    What is *selected*, as opposed to what the file spells.

    An absent `wake.days` means every day, so the chips draw all seven as on.
    Toggling therefore has to start from all seven too — reading the empty list
    literally made a click on `sun` mean "add sun to nothing", which turned a
    seven-day schedule into a Sunday-only one from a chip that was lit.
  */
  const selectedDays = days.length === 0 ? [...WAKE_DAYS] : days;

  const toggleDay = (day: string) => {
    const next = selectedDays.includes(day as (typeof WAKE_DAYS)[number])
      ? selectedDays.filter((each) => each !== day)
      : WAKE_DAYS.filter(
          (each) => each === day || selectedDays.includes(each),
        );

    // All seven and none mean the same thing — every day — so the key goes
    // away rather than spelling out a list that says nothing.
    if (next.length === 0 || next.length === WAKE_DAYS.length) {
      onChange(clear('wake.days'));
      return;
    }

    set('wake.days', `[${next.join(', ')}]`);
  };

  // ---- rows -------------------------------------------------------------

  const problemFor = (path: string) =>
    problems.find((problem) => problem.field === path)?.reason ?? null;

  const row = (path: string, label: string, control: React.ReactNode) => {
    const problem = problemFor(path);
    const help = FIELD_HELP[path];

    return (
      <div key={path} className="grid grid-cols-[86px_minmax(0,1fr)] gap-2.5">
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
          {help === undefined ? null : (
            <span className="text-[10.5px] leading-snug text-subtle">
              {help}
            </span>
          )}
          {/*
            Shown only while it is still true. `AgentForm` is not remounted when
            a different agent is opened — `AgentEditor` swaps the `source` prop —
            so a notice cleared by keystroke alone outlived its own subject and
            rendered "drone was taken — using <the other agent's name>", which is
            not stale so much as false. Tying it to the name it describes means
            the sentence disappears with the buffer that earned it.
          */}
          {path === 'name' && renamed !== null && renamed.to === at('name') ? (
            <span role="status" className="text-[10.5px] text-muted">
              {renamed.from} was taken — using {renamed.to}.
            </span>
          ) : null}
        </div>
      </div>
    );
  };

  /**
   * A text field, named for assistive tech.
   *
   * The `aria-label` is not decoration. `row`'s `<label>` carries no `htmlFor`
   * — it cannot, because the control it sits beside is an arbitrary node — so
   * without this every input but `name` reached the accessibility tree
   * anonymous. A screen reader announced "edit text" thirteen times, and no
   * test could address a field by what the pane visibly calls it.
   *
   * It takes the **visible** label rather than the field path, so the
   * accessible name matches the words on screen: `quiet hours`, not
   * `wake.quiet`.
   */
  const input = (path: string, label: string, placeholder = '') => (
    <input
      type="text"
      spellCheck={false}
      aria-label={label}
      value={at(path)}
      placeholder={placeholder}
      onChange={(event) => set(path, event.target.value)}
      className="min-w-0 rounded-[5px] border border-border-soft bg-panel-2 px-2 py-1 text-[11.5px] text-ink outline-none focus:border-border"
    />
  );

  const chip = (label: string, on: boolean, onClick: () => void) => (
    <button
      key={label}
      type="button"
      aria-pressed={on}
      onClick={onClick}
      className={
        on
          ? 'rounded-[4px] border border-brand bg-active px-2 py-0.5 text-[11.5px] text-ink'
          : 'rounded-[4px] border border-border bg-panel-2 px-2 py-0.5 text-[11.5px] text-subtle hover:bg-hover hover:text-ink'
      }
    >
      {label}
    </button>
  );

  /*
    Problems with nowhere to sit: an unknown key (whose `field` is whatever the
    user typed) and `effort`. The name is no longer among them — it has a row.

    At the **top** rather than the bottom. This form scrolls past a dozen rows,
    and a homeless problem is the most global one there is — putting it below
    the fold is the same as not showing it.
  */
  /*
    The wake keys the *current mode* is not drawing. A path can be in
    `RENDERED_PATHS` and still have no row on screen, which is the one way a
    problem could go missing again after `name` gained a control: it would be
    excluded from the banner for being renderable, and excluded from the form
    for being in the other mode.
  */
  const hiddenByMode: readonly string[] =
    mode === 'every'
      ? ['wake.at', 'wake.days']
      : mode === 'at'
        ? ['wake.every']
        : ['wake.every', 'wake.at', 'wake.days'];

  const homeless = problems.filter(
    (problem) =>
      problem.field !== '' &&
      (!RENDERED_PATHS.includes(problem.field) ||
        hiddenByMode.includes(problem.field)),
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

  const wakeEvery = at('wake.every');

  /*
    Any `<n>m` or `<n>h` is legal — `parseDuration` says so and the docstring on
    WAKE_OPTIONS advertises it — but only nine of them are on the control. An
    unlisted one used to fall back to showing `5m` selected while the file said
    `2h`, which is not a missing option but a false statement: the row claimed a
    schedule the agent did not have, with nothing beside it to disagree.

    So an unlisted value joins the list as itself. It reads as the truth, stays
    selectable, and disappears again the moment the user picks something else.
  */
  const wakeOptions: readonly SegmentedOption<string>[] =
    wakeEvery !== '' && !WAKE_OPTIONS.some((option) => option.value === wakeEvery)
      ? [...WAKE_OPTIONS, { value: wakeEvery, label: wakeEvery }]
      : WAKE_OPTIONS;

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto px-3 py-3">
      {homeless.map((problem) => (
        <p
          key={`${problem.field}:${problem.reason}`}
          role="alert"
          className="flex flex-wrap gap-x-1 rounded-[5px] border border-red px-2.5 py-1.5 text-[11px] text-red"
        >
          {/*
            The path and the sentence are separate nodes rather than one
            interpolated string, so the sentence is addressable on its own. A
            reader scanning for the complaint should not have to read past a
            key path to find it — and a test asserting on the sentence should
            not have to know how the prefix is punctuated.
          */}
          <span className="font-mono text-subtle">{problem.field}:</span>
          <span>{problem.reason}</span>
        </p>
      ))}

      <SettingsGroup
        title="Identity"
        description="What this agent is called, and what it watches."
      >
        <div className="flex flex-col gap-2.5">
          {row(
            'name',
            'name',
            <input
              type="text"
              spellCheck={false}
              aria-label="name"
              value={at('name')}
              onChange={(event) => setName(event.target.value)}
              /*
                Renumber on the way out rather than refuse on the way in. Doing
                it per-keystroke would fight the typist — `drone` is a prefix of
                `drone-watcher`, so it would become `drone-2` before the word
                was finished — and doing it at Save would surface as the refusal
                this replaces.
              */
              onBlur={(event) => {
                const typed = event.target.value.trim();

                if (typed === '' || !taken.includes(typed)) return;

                const free = firstFree(typed, taken);

                setRenamed({ from: typed, to: free });
                onChange(patchFrontmatter(source, 'name', free));
              }}
              className="min-w-0 rounded-[5px] border border-border-soft bg-panel-2 px-2 py-1 text-[11.5px] text-ink outline-none focus:border-border"
            />,
          )}
          {row('description', 'description', input('description', 'description'))}
          {row(
            'icon',
            'icon',
            <IconPicker
              label="Icon"
              groups={AGENT_ICON_GROUPS}
              value={at('icon')}
              onChange={(next) => set('icon', next)}
            />,
          )}
        </div>
      </SettingsGroup>

      <SettingsGroup
        title="When it wakes"
        description="An agent sleeps until a schedule or a message wakes it. Both can be set."
      >
        <div className="flex flex-col gap-2.5">
          <div className="grid grid-cols-[86px_minmax(0,1fr)] gap-2.5">
            <span
              aria-hidden="true"
              className="pt-1 text-right text-[11px] text-subtle"
            >
              wakes
            </span>
            <div className="flex min-w-0 flex-col gap-1">
              <SegmentedControl
                label="Wake mode"
                options={WAKE_MODES}
                value={mode}
                onChange={setMode}
              />
              <span className="text-[10.5px] leading-snug text-subtle">
                Two ways to say when. every — it repeats on an interval from its
                last wake. on a schedule — it fires at fixed local times. off —
                it only wakes when something addresses it.
              </span>
            </div>
          </div>

          {mode === 'every'
            ? row(
                'wake.every',
                'every',
                <SegmentedControl
                  label="Wake every"
                  options={wakeOptions}
                  value={wakeEvery}
                  onChange={(next) => set('wake.every', next)}
                />,
              )
            : null}

          {mode === 'at' ? (
            <>
              {row(
                'wake.days',
                'on',
                <div className="flex flex-wrap gap-1">
                  {WAKE_DAYS.map((day) =>
                    chip(day, selectedDays.includes(day), () => toggleDay(day)),
                  )}
                </div>,
              )}
              {row(
                'wake.at',
                'at',
                <div className="flex flex-wrap gap-1">
                  {timeChips.map((time) =>
                    chip(time, times.includes(time), () => toggleTime(time)),
                  )}
                </div>,
              )}
            </>
          ) : null}

          {row(
            'wake.quiet',
            'quiet hours',
            input('wake.quiet', 'quiet hours', '23:00-07:00'),
          )}
          {row('wake.on', 'wake on', input('wake.on', 'wake on', '[ledger]'))}
        </div>
      </SettingsGroup>

      <SettingsGroup
        title="What it can do"
        description="Everything it may reach while awake. Anything not listed is refused."
      >
        <div className="flex flex-col gap-2.5">
          {LIST_FIELDS.map(({ path, label, hint }) =>
            row(path, label, input(path, label, hint)),
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
        </div>
      </SettingsGroup>

      <SettingsGroup
        title="Limits"
        description="Ceilings on one wake, and on how long the agent keeps one session. All have defaults."
      >
        <div className="flex flex-col gap-2.5">
          {row(
            'model',
            'model',
            <SegmentedControl
              label="Model"
              options={MODEL_OPTIONS}
              value={
                (SESSION_MODELS as readonly string[]).includes(at('model'))
                  ? (at('model') as (typeof MODEL_OPTIONS)[number]['value'])
                  : 'default'
              }
              onChange={(next) => {
                // Same absence-is-a-value argument as the wake keys.
                if (next === 'default') onChange(clear('model'));
                else set('model', next);
              }}
            />,
          )}
          {LIMIT_FIELDS.map(({ path, label, hint }) =>
            row(path, label, input(path, label, hint)),
          )}
        </div>
      </SettingsGroup>
    </div>
  );
}
