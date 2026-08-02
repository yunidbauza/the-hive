# 021 — Header

| | |
|---|---|
| **ID** | HIVE-021 |
| **Epic** | Shell |
| **Depends on** | [020-app-shell-layout.md](020-app-shell-layout.md) |
| **Blocks** | — |
| **Points** | 5 |
| **Location** | `src/components/layout/header.tsx`, `model-chip.tsx`, `status-counts.tsx` |

## Story

> As a user, I want a persistent header with the brand, the active session's model
> status, fleet-wide status counts, theme toggle, inbox bell, and a New-session button,
> so I always see the health of the whole hive and can act from anywhere.

## Anatomy (three zones)

The bar is a `1fr minmax(0,auto) 1fr` grid, not a flex row with a spacer: the model
chip sits on the header's **true midpoint**. Equal side tracks are what buys that —
flex spacers would centre the gap between two unequal clusters (brand ~150px,
controls ~517px) and leave the chip ~198px left of centre.

Both side tracks therefore size to the *wider* side, so the bar needs
`2 × controls + chip` = 1493px of track and a 1440px header has 1380px. The 113px
deficit is spent on the **status counts**, which ellipsise from the tail rather than
wrap — the header is one line tall, and the chip is the thing being centred. Above
roughly 1553px nothing truncates. See [Trade-off](#trade-off-centring-vs-density).

**Left track**

1. **Brand block**: 30×30 rounded logo tile (hive mark image from `concept/assets/`),
   then two lines: wordmark "The Hive" (display serif 17px, letter-spacing −0.02em) and
   "APFM ENGINEERING" (10px, uppercase, letter-spacing 0.08em, `--cc-subtle`).
**Centre track**

2. **Model chip** *(conditional)* — only when the active tab is a **session**:
   pill (`--cc-chip` bg, radius 999) with `ph-brain` icon in `--cc-brand`, mono 11.5px:
   `Opus 4.5 (1M) · high | ███░░░░░░░ 32% | 4% · resets 02:30 PM`
   - model display names: opus → `Opus 4.5`, sonnet → `Sonnet 4.5`, haiku → `Haiku 4.5`,
     fable → `Fable 1`.
   - context meter: 10-char bar of `█`/`░` from a ctx % (mock: derive deterministically
     from the session id as the concept does, or store per-session).
   - the wrapper renders even when the chip does not, so the track collapses to zero
     width and the two side zones never move on a tab switch.

**Right track** (right-aligned cluster, 14px between items)

3. **Status counts** (mono 12px `--cc-muted`):
   `{working} working · {waiting} waiting · {idle} idle · {done} done`
   with "working" in `--cc-green` and "waiting" in `--cc-amber`. Derived live from the
   store — updates when simulation or actions change statuses. Truncates on one line
   (never wraps) and carries the full string in its `title`.
4. **Theme toggle**: 34px circular ghost button, `ph-sun`/`ph-moon`
   (see [011](011-design-tokens-and-theming.md)).
5. **Inbox bell**: 34px circular ghost button, `ph-bell`; red badge (top-right, min 16px,
   count) when unread > 0. Click = mark all read ([051](051-inbox-panel.md)).
6. **New session** button: primary small button → opens the picker
   ([044-new-session-picker.md](044-new-session-picker.md)).

## Trade-off: centring vs. density

Worth stating explicitly, because it is a deliberate cost and not a bug:

| Width | Model chip | Status counts |
|---|---|---|
| ≥ ~1553px | full, centred | full |
| 1440px (the E2E viewport) | full, centred | ellipsised at the tail — `… 2 idle…` |

The counts pay before the chip does: the chip is what the centring exists to serve,
`done` is the least urgent number on the bar, and the tooltip keeps the whole string.
The chip's own `truncate` is the last valve and only fires far below any supported
width. The rejected alternative — letting the counts wrap, which is what a grid does
if nothing stops it — puts two lines of text in a one-line bar.

## Acceptance criteria

- [ ] All six zones render per spec at 56px height, gap 14px, padding 0 16px.
- [ ] The model chip's horizontal midpoint is within 2px of the header's midpoint, at
      1440 and at 1600 — measured in a browser, not inferred from markup.
- [ ] The header stays one line at every supported width: the counts ellipsise, never
      wrap.
- [ ] Model chip appears/disappears correctly when switching orchestrator ↔ session ↔
      agent tabs (agents and orchestrator show no chip), and the side zones do not move
      when it does.
- [ ] Counts come from the `useCounts()` selector ([012](012-mock-data-layer.md)) —
      no local state, no store-object reads.
- [ ] Bell badge shows exact unread count and hides at 0.
- [ ] Hover states: ghost buttons get `--cc-hover` bg and `--cc-ink` icon.
- [ ] "New session" opens the picker overlay and focuses its search input.

## Tests

- Unit ([013](013-testing-infrastructure.md)): counts render from fixture state;
  the model chip is absent for the orchestrator and for agents and present for a
  session; the bell badge hides at 0 unread and shows the exact count above 0.
- The three sub-components (`ModelChip`, `StatusCounts`, brand block) are tested
  independently — the header itself only composes.
- Unit tests can pin the *structure* that produces centring — three tracks, the chip
  in the middle one, the middle wrapper surviving a null chip — but not the centring
  itself: happy-dom performs no layout.
- E2E ([070](070-e2e-harness.md)) owns the geometry: midpoint within 2px, no overlap
  with either side zone, counts on one line, and the truncation appearing at 1440 and
  gone at 1600.

## Out of scope

- Real token/usage metering (values are mock).
- Clicking the bell opening a dropdown — the inbox lives in the activity rail.
