# Design system

Read this before any UI task. This file **is** the visual source of truth: it
records what the concept mock fixed, and when a story is silent on a colour, size,
or string, the values below decide. The mock itself is retired from the tree —
`git log -- concept/` still has it.

The values below are asserted against `src/styles/tokens.css` and
`src/lib/terminal/ansi.ts` by `tests/design-system.test.ts`. Edit them together or
the test fails.

## Colour tokens

Defined on `:root` (dark, the default) with a `body[data-theme="light"]` override,
and bound to Tailwind via `@theme inline` in `src/styles/tokens.css`.

| Token | Dark | Light | Used for |
| --- | --- | --- | --- |
| `--cc-bg` | `#10152a` | `#fdfdfb` | app background |
| `--cc-panel` | `#141a33` | `#ffffff` | rails, cards, panels |
| `--cc-panel-2` | `#121731` | `#f7fafb` | nested/recessed panels |
| `--cc-hover` | `#1b2344` | `#f4f9ff` | hover state |
| `--cc-active` | `#222c55` | `#e9f3fc` | active/selected row |
| `--cc-border` | `#273159` | `#d4dee3` | dividers, outlines |
| `--cc-border-soft` | `#1e2747` | `#edf2f4` | quieter dividers |
| `--cc-ink` | `#e9effc` | `#2c2f34` | primary text |
| `--cc-muted` | `#98a3cc` | `#73767c` | secondary text |
| `--cc-subtle` | `#6b779f` | `#8e949c` | tertiary text, idle status |
| `--cc-brand` | `#8fa7f2` | `#334fa9` | brand, done status |
| `--cc-green` | `#74b79c` | `#2e6b52` | working / online status |
| `--cc-amber` | `#ffac47` | `#c77414` | needs-input status |
| `--cc-red` | `#ff8d85` | `#d3372f` | errors, failing checks |
| `--cc-chip` | `#1c2648` | `#edf2f4` | chips, pills, raised cards |
| `--cc-chip-hover` | `#232e57` | `#e2eaee` | hover on a chip-filled card |
| `--cc-term-bg` | `#0b1023` | `#f7fafb` | terminal background |
| `--cc-term-input` | `#0e1430` | `#ffffff` | terminal input bar |
| `--cc-term-row-hover` | `#161f45` | `#eef4f9` | session-table row hover |
| `--cc-term-row-active` | `#1a2450` | `#e4edf5` | session-table selected row |
| `--cc-term-head` | `#4d5a86` | `#6b6e74` | session-table column headers |
| `--cc-term-track` | `#3a4674` | `#d4dee3` | picker stepper track and dots |
| `--cc-brand-fill` | `#5e76d0` | *(unchanged)* | primary button |
| `--cc-brand-fill-hover` | `#4f6ac5` | *(unchanged)* | primary button hover |
| `--cc-brand-fill-strong` | `#334fa9` | *(unchanged)* | hive-mark tile (Serenity) |
| `--cc-on-brand` | `#ffffff` | *(unchanged)* | text/icons on a brand fill |
| `--cc-danger-solid` | `#d3372f` | *(unchanged)* | notification badge fill |
| `--cc-on-danger` | `#ffffff` | *(unchanged)* | text/icons on a danger fill |
| `--cc-code-keyword` | `#b39ff0` | `#6f42c1` | editor: keywords |
| `--cc-code-string` | `#74b79c` | `#2e6b52` | editor: strings, regexps |
| `--cc-code-number` | `#ffac47` | `#a1541a` | editor: numbers, booleans, null |
| `--cc-code-comment` | `#6b779f` | `#8e949c` | editor: comments |
| `--cc-code-name` | `#8fa7f2` | `#334fa9` | editor: functions, properties, headings |
| `--cc-code-type` | `#7fd0e0` | `#0b6b7d` | editor: types, classes, tags |
| `--cc-code-operator` | `#98a3cc` | `#73767c` | editor: operators, punctuation |
| `--cc-code-constant` | `#ff8d85` | `#b3271f` | editor: constants |
| `--cc-code-invalid` | `#ff8d85` | `#d3372f` | editor: parse errors |
| `--cc-code-active-line` | `#171e3c` | `#f4f9ff` | editor: current line |
| `--cc-code-selection` | `#2b3768` | `#cfe3f7` | editor: selection |

**The editor and the terminal both follow the theme.** They did not always. The
terminal was pinned dark in both themes on the reasoning that a terminal is a
terminal in every theme — true of a terminal *emulator*, whose window is the
whole application, and false here. Once the editor landed on the same centre
stage and adopted the theme properly, the argument inverted: a dark slab in the
middle of a light app reads as a panel that failed to paint, and the seam is
loudest exactly where the two surfaces meet.

The eleven `--cc-code-*` tokens are also the one palette in the app that is
reachable from a third-party component's own theming. CodeMirror emits real CSS
rules, so `color: var(--cc-code-keyword)` resolves at paint time and a theme
switch repaints the editor with no JavaScript at all — which is exactly what
xterm cannot do, and why the TERM palette lives in `ansi.ts` instead.

**All six `--cc-term-*` tokens are overridden for light.** The row, header, and
track tokens exist because the orchestrator's session table (041) and the
new-session picker (044) are **DOM, not xterm**, so they need real CSS for
surfaces the TERM palette does not cover — and they sit *on* the terminal
ground, so they have to move with it or end up dark-on-light.

`--cc-term-bg` is `--cc-panel-2`, the editor's ground, and that identity is
load-bearing rather than tidy: it is also `TERM_LIGHT.bg` in `ansi.ts`, because
xterm paints its own background while the DOM paints the padding around it. Two
systems, one colour, or a rectangle appears at the terminal's edge.
`--cc-term-head` is four steps darker than `--cc-muted`, which lands at 4.34:1
on this ground — under AA.

Note what they are *not*: terminal **text** colours. Those live only in
`src/lib/terminal/ansi.ts` and never appear in this file or in `tokens.css` — a
rule with a test behind it. A DOM element sitting on the terminal background
takes its text colour from the ordinary UI tokens (`text-green`, `text-amber`,
`text-subtle`, `text-brand`), which is why the session table's status column
matches the rails rather than the transcript.

**Brand fills are surfaces, and do not flip with the theme.** `--cc-brand` is a
*text* colour and changes between themes so it stays legible on a panel. The
five tokens above paint filled shapes — the hive mark's tile, the primary
button, the unread badge — and keep the same value in both themes, exactly as
the concept does (`--blue-600/700/800` and `--color-error`, none of which its
light theme overrides). Painting the logo tile with `bg-brand` would turn it
pale blue in dark mode and read as a different logo.

`--cc-danger-solid` is darker than `--cc-red` on purpose: `--cc-on-danger` on
`#d3372f` clears WCAG AA at 4.87:1, where `--cc-red`'s dark-mode `#ff8d85` would
not.

**`--cc-on-danger` is a token of its own, and the reason is worth keeping.** The
badge used to paint `--cc-on-brand`, which is a different promise — "legible on
the *brand* fill". Graphite's brand is a light lime, so it correctly answers
that with a near-black `#141414`, and the badge then rendered black on crimson
at 3.22:1. No single token can be legible on two fills whose luminance differs
fourfold, and before this the theme had no way to say so. `validate.ts` now
checks both fill/on-fill pairs at import time, which is what makes the next one
fail loudly rather than quietly.

### Tailwind mapping

`@theme inline` binds each token to a Tailwind colour without copying its value,
so `tokens.css` stays the single source of truth and the light override keeps
working through the same variables:

```
--cc-bg → bg-bg / text-bg / border-bg
--cc-panel → bg-panel      --cc-panel-2 → bg-panel-2
--cc-hover → bg-hover      --cc-active → bg-active
--cc-border → border-border  --cc-border-soft → border-border-soft
--cc-ink → text-ink        --cc-muted → text-muted   --cc-subtle → text-subtle
--cc-brand → text-brand    --cc-green → text-green
--cc-amber → text-amber    --cc-red → text-red
--cc-chip → bg-chip        --cc-term-bg → bg-term-bg
--cc-brand-fill → bg-brand-fill    --cc-brand-fill-hover → bg-brand-fill-hover
--cc-brand-fill-strong → bg-brand-fill-strong
--cc-on-brand → text-on-brand      --cc-danger-solid → bg-danger-solid
--cc-on-danger → text-on-danger
--cc-code-* → text-code-* / bg-code-*   (keyword, string, number, comment,
                                         name, type, operator, constant,
                                         invalid, active-line, selection)
```

`inline` matters: it makes utilities emit `var(--cc-*)` rather than resolving the
value at build time, which is what lets a single `data-theme` flip recolour the
whole app.

**Raw hex literals in component code are banned.** If a colour is missing, add a
token.

## Terminal text palette

Exported from `src/lib/terminal/ansi.ts`. Deliberately **not** in `@theme` — it
never reaches CSS. xterm resolves colours from its own `theme` option and paints
them into markup it owns, so a CSS custom property has no path to a terminal cell;
this palette is consumed as JS by xterm and by the ANSI colorizer.

**There are two built-in palettes, and the terminal is handed one.** `TERM` is
dark, `TERM_LIGHT` is light — both are the built-in theme's `terminal` groups
under a name — and `xtermThemeFor(palette)` maps *any* palette into xterm's
sixteen slots, so palettes can differ in colour but never in structure. Which
one a surface gets is decided by the composition root, not by the terminal, so
an imported theme (HIVE-80) travels the same path these two do.

| Key | `TERM` (dark) | `TERM_LIGHT` | Mirrors (light) | Used for |
| --- | --- | --- | --- | --- |
| `ink` | `#dbe4ff` | `#2c2f34` | `--cc-ink` | default foreground |
| `dim` | `#7c88b8` | `#6b6e74` | `--cc-term-head` | secondary / meta |
| `green` | `#7ee2b8` | `#2e6b52` | `--cc-code-string` | success, prompts |
| `blue` | `#8fb5ff` | `#334fa9` | `--cc-code-name` | tool calls (Read/Edit/Bash lines) |
| `amber` | `#ffc06e` | `#a1541a` | `--cc-code-number` | working spinner, questions |
| `red` | `#ff8d85` | `#b3271f` | `--cc-code-constant` | errors |
| `cyan` | `#7edce2` | `#0b6b7d` | `--cc-code-type` | orchestrator-injected lines, PR refs |
| `magenta` | `#7edce2` | `#6f42c1` | `--cc-code-keyword` | ANSI slot 35 |
| `black` | `#0b1023` | `#2c2f34` | `--cc-ink` | text colour a theme may still name |
| `bg` | `#0b1023` | `#f7fafb` | `--cc-term-bg` | terminal background |
| `selection` | `#222c55` | `#cfe3f7` | `--cc-code-selection` | selection highlight |
| `surface` | `#0e1430` | `#ffffff` | `--cc-panel` | **ANSI slot 30** — panels a program paints |
| `surfaceAlt` | `#1b2344` | `#edf2f4` | `--cc-chip` | **ANSI slot 90** — the second fill |

`surface` and `surfaceAlt` arrived with HIVE-82, and they are the reason slots 30
and 90 no longer hold text colours. Claude Code paints its own chrome — the
submitted-prompt row, the composer sidebar, the bash block — out of exactly those
two slots, so binding them to `black` and `dim` drew a near-black bar across a
light terminal. They are **optional** in a theme file: `surfacesOf` in `ansi.ts`
blends them out of `bg` when a theme does not name them, so every theme exported
before HIVE-82 still imports unchanged.

The old rule they replace was not wrong, it was outvoted: a CLI that detects a
light terminal picks slot 30 for body text, and against a light `surface` that
text would vanish. `terminal-surface.tsx` passes `minimumContrastRatio: 4.5`, so
xterm lifts that foreground. A background has no such rescue — xterm adjusts
foregrounds only — which is what decided it.

`magenta` equals `cyan` in dark and always has: the concept never specified one,
so slot 35 has always rendered as cyan. Naming it lets the light palette give
the slot a real hue without moving a dark-mode pixel.

`black` equals `bg` in dark for the same historical reason, and **deliberately
does not in light**. On a dark ground, slot 30 being the background is invisible
and harmless — no program picks black for body text against black. On a light
ground it is the conventional choice, and xterm answers an OSC 11 background
query with `theme.background`, so a background-detecting CLI will actively
*choose* slot 30. Mapped to `bg` that renders at 1:1, and `minimumContrastRatio`
defaults to `1`, so nothing would correct it.

The xterm theme also sets **`cursorAccent` to the palette's `bg`** in both
themes. It is the glyph under a block cursor; xterm defaults it to `#000000`,
which was survivable only while every cursor was light. A light theme whose
cursor is `#2c2f34` would otherwise hide the character under the caret at
1.56:1.

**The two palettes follow opposite rules, on purpose.** The dark text colours are
deliberately *not* the UI tokens — `TERM.green` is not `--cc-green` — because
text on a dark canvas needs more lift than the same semantic colour does in
chrome; only three surface values coincide (`bg` is `--cc-term-bg`, `selection`
is `--cc-active`, `red` is shared with `--cc-red`). Every light value, by
contrast, **is** a token, listed above: the light terminal shares the editor's
ground, so the colours the editor already proved there are the right ones, and a
second light identity would be the actual bug. xterm cannot read a custom
property, so the value has to exist twice — `ansi.test.ts` reads `tokens.css`
and fails if the copies drift.

Every light pair clears WCAG AA on `#f7fafb` (lowest: `dim` at 4.87:1), asserted
in `ansi.test.ts` rather than eyeballed.

**Transcript colour is emitted as an ANSI *index*, not truecolor.** A baked
`38;2;r;g;b` escape stores RGB in the cell and no later theme change can reach
it; an index stores the slot and resolves at paint time. That is what lets a
theme toggle repaint scrollback written minutes ago instead of stranding pastel
text on a white page.

## Hierarchy → colour

One rule, applied wherever a thing on screen contains other things:

| Role | Token | Where |
| --- | --- | --- |
| the name of a **container** | `--cc-brand` | a project in the rail, a provider band in Integrations |
| a thing **inside** it | `--cc-ink` | a session, a settings group, a file |
| that thing's **metadata** | `--cc-subtle` | a branch, a description, a probe result |

Before this, a project row and a session row in the rail were the same size, the
same weight and the same colour, and the folder icon beside the project was
painted *quieter* than the sessions it contained — so the only thing marking a
project was its indent, and the tree read as one flat column of names. Settings
had the same problem one level up: Integrations was six equal groups with nothing
saying three of them were GitHub's and three were Jira's.

**It costs no token.** Every theme ships `brand` in both modes because
`contract.ts` requires it, so Honeycomb's orange, Graphite's lime and Cinder's
magenta all arrive without a theme file being touched — and an imported theme
cannot opt out of having one.

Two limits keep it from spreading into decoration:

- **Brand marks a container among things that are not containers.** In a list
  where every row *is* a project — Settings → Projects, the new-session picker —
  only the **icon** takes it. A coloured name there would be a dozen lines of
  brand with nothing to separate them from.
- **Status keeps its own vocabulary** (below) and always wins the row it is in.
  Nothing in this table is allowed to compete with it.

The provider level in Settings is added by *colour*, not by a fourth heading
size: the type scale is 15 / 13 / 11.5 and has no room above 13px
(`settings-section-header.tsx` records why), so `SettingsProviderGroup` is an
11px mono eyebrow in brand over a hairline — the device the explorer already
uses over the file tree. A group inside such a band draws no rule of its own.

Because `brand` is now body text rather than an accent, `validate.ts` measures
it: **`brand` below 4.5:1 is a note at import time**, alongside the `ink` checks.
Against *both* grounds brand text actually sits on — `panel` for the rail,
`panel-2` for the settings dialog — for the same reason `ink` is checked against
`panel` and `bg`. All seven built-ins clear both: 5.15:1 at worst on `panel`
(Graphite light), 4.80:1 at worst on `panel-2` (Graphite light again).

## Status → colour

| Status | Label | Token | Notes |
| --- | --- | --- | --- |
| `working` | working | `--cc-green` | dot pulses (`ccpulse`) |
| `waiting` | needs input | `--cc-amber` | blocked on user answer/permission |
| `idle` | idle | `--cc-subtle` | context saved, resumable |
| `done` | done | `--cc-brand` | the *work* finished; listed under ENDED |
| `terminated` | terminated | `--cc-muted` | the *process* is gone; listed under ENDED, not re-enterable |
| `online` | online | `--cc-green` | agents only |

`done` and `terminated` are two different endings and are coloured apart on
purpose (story 108). `done` keeps brand blue because a finished session still has
something to go and look at — a PR, a diff. `terminated` is a row explaining an
absence, so it takes neutral grey. It is deliberately **not** `--cc-subtle`,
which `idle` owns: idle and terminated are the two states most easily confused,
both quiet with only one still alive, and a shared dot would erase the
distinction that decides whether the user goes and looks.

Status is never carried by colour alone — every status also has a label, so the
model survives colour-blindness and reduced-motion.

## Type

- **Family:** `ui-mono` stack — `ui-monospace, Menlo, 'SF Mono', monospace`,
  registered as `--font-mono` and available as `font-mono`. All terminal and UI
  text is monospace; the command center is a terminal tool and reads as one.
- **Base size:** 13px / 1.5 on `body`.
- **Terminal:** 12px inside xterm.

## Motion

| Animation | Utility | Definition |
| --- | --- | --- |
| `ccpulse` | `animate-ccpulse` | opacity 1 → .3 → 1, 1.6s ease-in-out infinite |
| `ccblink` | `animate-ccblink` | opacity 1 → 0 → 1, 1s step-end infinite |

Both are registered in `tokens.css` as `--animate-*`, so components use the
utility rather than hand-written CSS.

`prefers-reduced-motion: reduce` collapses all animation and transition durations
to ~0. Safe because animation here is always decoration — the pulsing dot repeats
information the label already carries.

## Chrome

- Header height **56px**; left rail **268px**; activity rail **316px**.
- Scrollbars are thin (10px), thumb `--cc-border`, transparent track, rounded.
- Interactive controls show a pointer cursor — a base rule in `global.css`, since
  Tailwind v4 dropped the one that used to provide this. Do not add
  `cursor-pointer` per component.
- **Settings rhythm is asymmetric**: `pb-5` above a group's rule
  (`settings-group.tsx`), `gap-6` below it (each pane's scroll container). They
  were `pb-4` / `gap-4`, which put the rule exactly halfway between the group it
  ends and the group it starts — equidistant reads as belonging to neither, so a
  floor rendered as a divider between equals. The two numbers live in different
  files; change them together or the asymmetry inverts.
