# HIVE-5 — Activity Rail Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the 316px right-hand attention rail — Inbox, PRs, and the orchestrator Activity feed — replacing the empty `activity-rail.tsx` placeholder.

**Architecture:** `components/layout/activity-rail.tsx` is the composition root for this region (the one place under `components/` allowed to import `features/**`). It renders the shared `TabBar` atom and mounts exactly one of three feature panels, each owning its own slice: `features/inbox/`, `features/pull-requests/`, `features/activity-feed/`. PR badge rules live in `features/shared/pr-presentation.ts` so they stay a single source of truth. All state comes from the two existing zustand stores through named selector hooks; panels never read the store object directly.

**Tech Stack:** React 19, TypeScript, zustand, Tailwind v4 (`--cc-*` tokens via `@theme inline`), `@phosphor-icons/react`, vitest + Testing Library, Playwright.

## Global Constraints

Copied verbatim from `AGENTS.md`; every task's requirements implicitly include these.

- **kebab-case** for every file and folder under `src/`.
- **Absolute `@/` imports**, never relative parent imports (`../`).
- Import order: builtin → external → internal → parent → sibling → index, `@/**` pinned before internal, blank lines between groups, alphabetised.
- Colour comes from `--cc-*` tokens bound to Tailwind utilities (`bg-panel`, `text-muted`, `border-border-soft`). **Raw hex literals in component code are banned.**
- Icons: `@phosphor-icons/react`, resolved by name through `components/ui/icon.tsx`.
- **Components never read a store object directly and never call `getState()`** — every consumer goes through a named selector hook exported next to the store.
- Derived values are computed **in selectors, never stored**.
- Fixtures (`src/data/`) are **store-only consumers**. Nothing that renders may import them.
- `tests/` **mirrors** `src/`. No exceptions.
- **80% coverage** on lines, statements, branches, functions — the gate fails the build.
- Timer-based behaviour uses **fake timers**, never real waits.
- Import zones: `stores/` may not import `features/` or `components/`. `components/ui/` may not import `features/`. A feature slice may import only itself and `features/shared`.
- All commands run from `app/`: `pnpm test`, `pnpm lint`, `pnpm type-check`, `pnpm verify:boundaries`, `pnpm test:e2e`.

## Reconciliation decisions (agreed with the user before planning)

1. **`composeBadges` is consumed by the PRs panel only.** Story 052's AC claims the Work panel (032) renders the same badges — it does not; `ticket-pr-row.tsx` renders bare uppercase state plus `⚠ n`, which is correct for a 268px row. The shared module keeps colour rules single-source and gains `composeBadges`; the Work panel is left untouched. Ticket gets an UPDATED SPECS note.
2. **The fake clock lives at `src/lib/fake-clock.ts`, not `features/activity-feed/utils/`.** `hive-store` stamps feed items on spawn and send, and the lint zone bans `stores/ → features/`. `lib/` is leaf-level and importable from stores.
3. **A new `Tag` atom** carries 052's text badges. The existing `Badge` atom is count-only (`count: number`, renders nothing at zero) and `Chip` is a larger mono pill without a `subtle` tone.
4. **One PR for the whole epic** — 050 alone ships an empty tab shell.

## File Structure

**Create**
- `src/components/ui/tag.tsx` — small text badge (10.5px, 600, `bg-chip`, `rounded-full`, `px-2 py-0.5`), tones brand/green/amber/red/subtle. Domain-agnostic.
- `src/lib/fake-clock.ts` — deterministic demo clock: starts 14:38, +1 minute per `stamp()`, with `reset()`.
- `src/features/inbox/components/inbox-panel.tsx` — maps notifications to cards.
- `src/features/inbox/components/notification-card.tsx` — one notification.
- `src/features/pull-requests/components/prs-panel.tsx` — maps PRs to cards.
- `src/features/pull-requests/components/pr-card.tsx` — one PR, badge row from `composeBadges`.
- `src/features/activity-feed/components/activity-feed-panel.tsx` — maps feed items to rows.
- `src/features/activity-feed/components/feed-row.tsx` — one feed line (non-clickable).
- Mirrored tests for each of the above under `tests/`.

**Modify**
- `src/components/ui/tab-bar.tsx` — add optional `badgeTone` to `Tab`, passed through to `Badge`.
- `src/components/ui/icon.tsx` — add `ph-arrows-clockwise` and `ph-robot` glyphs (two feed fixtures currently render as `?`).
- `src/features/shared/pr-presentation.ts` — add `composeBadges({ state, findings, checks })`.
- `src/stores/hive-store.ts` — `nowLabel()` → fake clock; add `pushNotif` + `NOTIF_CAP = 8`; add `useNotifs`, `usePrs`, `useFeed`, `useMarkRead`, `usePushNotif` selectors; `reset()` resets the clock.
- `src/components/layout/activity-rail.tsx` — replace the placeholder with tabs + panels.
- `tests/e2e/waiting-session.spec.ts` — add the inbox→terminal jump.
- `.claude/COMPONENTS.md`, `docs/component-patterns.md`, `docs/state-and-data.md` — document the new atom, panels, clock, and store action.

**Untouched on purpose:** `src/features/work/**` (decision 1), `src/data/fixtures.ts` (all fixtures already correct).

---

### Task 1: The `Tag` atom

Story 052's badges. A small text pill, unlike the count-only `Badge` and the larger mono `Chip`.

**Files:**
- Create: `src/components/ui/tag.tsx`
- Test: `tests/components/ui/tag.test.tsx`

**Interfaces:**
- Consumes: nothing.
- Produces: `export type TagTone = 'brand' | 'green' | 'amber' | 'red' | 'subtle'` and `export function Tag({ children, tone }: { children: ReactNode; tone: TagTone; className?: string })`.

- [ ] **Step 1: Write the failing test**

```tsx
// tests/components/ui/tag.test.tsx
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { Tag } from '@components/ui/tag';

describe('Tag', () => {
  it('renders its text', () => {
    render(<Tag tone="green">approved</Tag>);
    expect(screen.getByText('approved')).toBeInTheDocument();
  });

  it.each([
    ['brand', 'text-brand'],
    ['green', 'text-green'],
    ['amber', 'text-amber'],
    ['red', 'text-red'],
    ['subtle', 'text-subtle'],
  ] as const)('colours the %s tone with %s', (tone, expected) => {
    render(<Tag tone={tone}>label</Tag>);
    expect(screen.getByText('label')).toHaveClass(expected);
  });

  it('merges a caller className', () => {
    render(
      <Tag tone="subtle" className="ml-1">
        draft
      </Tag>,
    );
    expect(screen.getByText('draft')).toHaveClass('ml-1');
  });
});
```

- [ ] **Step 2: Run the test and watch it fail**

Run: `cd app && pnpm exec vitest run tests/components/ui/tag.test.tsx`
Expected: FAIL — cannot resolve `@components/ui/tag`.

- [ ] **Step 3: Write the atom**

```tsx
// src/components/ui/tag.tsx
import type { ReactNode } from 'react';

import { cn } from '@/lib/utils';

export type TagTone = 'brand' | 'green' | 'amber' | 'red' | 'subtle';

const TONE_TEXT: Record<TagTone, string> = {
  brand: 'text-brand',
  green: 'text-green',
  amber: 'text-amber',
  red: 'text-red',
  subtle: 'text-subtle',
};

interface TagProps {
  children: ReactNode;
  tone: TagTone;
  className?: string;
}

/**
 * A small text pill — the PRs panel's state, findings, and checks badges (052).
 *
 * Distinct from the two neighbouring atoms on purpose. `Badge` takes a `count`
 * and renders nothing at zero, so it cannot carry a word. `Chip` is a larger
 * mono pill for dense status text (the header's model chip) and has no `subtle`
 * tone. This one is proportional text at badge scale: the fill is always
 * `--cc-chip` and only the ink changes, which is what lets four of them sit in
 * one wrapping row without competing.
 */
export function Tag({ children, tone, className }: TagProps) {
  return (
    <span
      className={cn(
        'inline-flex items-center rounded-full bg-chip px-2 py-0.5 text-[10.5px] font-semibold',
        TONE_TEXT[tone],
        className,
      )}
    >
      {children}
    </span>
  );
}
```

- [ ] **Step 4: Run the test and watch it pass**

Run: `cd app && pnpm exec vitest run tests/components/ui/tag.test.tsx`
Expected: PASS, 7 assertions.

- [ ] **Step 5: Commit**

```bash
cd "$WT/app"
git add src/components/ui/tag.tsx tests/components/ui/tag.test.tsx
git commit -m "feat(ui): Tag atom for the PRs panel's badges (HIVE-27)"
```

---

### Task 2: `composeBadges` in `features/shared`

The rule table from story 052, as a pure function. Order matters — it is the order the badges render in.

**Files:**
- Modify: `src/features/shared/pr-presentation.ts`
- Test: `tests/features/shared/pr-presentation.test.ts` (append a `describe`)

**Interfaces:**
- Consumes: `Tag`'s `TagTone` (Task 1); `Pr`, `PrListState`, `PrChecks` from `@/types/pull-request`.
- Produces: `export interface PrBadge { text: string; tone: TagTone }` and `export function composeBadges(pr: Pick<Pr, 'state' | 'findings' | 'checks'>): PrBadge[]`.

- [ ] **Step 1: Write the failing test**

Append to `tests/features/shared/pr-presentation.test.ts`:

```ts
import { composeBadges } from '@features/shared/pr-presentation';

/**
 * One case per row of story 052's rule table, then the four fixture PRs. The
 * rule rows prove each condition in isolation; the fixtures prove the order and
 * the combinations the panel actually renders.
 */
describe('composeBadges', () => {
  it('badges a merged PR', () => {
    expect(composeBadges({ state: 'merged', findings: 0, checks: 'passing' })).toEqual([
      { text: 'merged', tone: 'brand' },
    ]);
  });

  it('badges an approved PR', () => {
    expect(
      composeBadges({ state: 'approved', findings: 0, checks: 'passing' }),
    ).toEqual([
      { text: 'approved', tone: 'green' },
      { text: 'no findings', tone: 'subtle' },
    ]);
  });

  it('badges a draft PR', () => {
    expect(composeBadges({ state: 'draft', findings: 0, checks: 'passing' })).toEqual([
      { text: 'draft', tone: 'subtle' },
    ]);
  });

  it('pluralises a findings count above one', () => {
    expect(composeBadges({ state: 'open', findings: 2, checks: 'passing' })).toEqual([
      { text: '2 open findings', tone: 'amber' },
    ]);
  });

  it('keeps a single finding singular', () => {
    expect(composeBadges({ state: 'open', findings: 1, checks: 'passing' })).toEqual([
      { text: '1 open finding', tone: 'amber' },
    ]);
  });

  /** "no findings" is reassurance about an *open* PR; a draft has not been reviewed. */
  it('says "no findings" only for a clean open PR', () => {
    expect(composeBadges({ state: 'open', findings: 0, checks: 'passing' })).toEqual([
      { text: 'no findings', tone: 'subtle' },
    ]);
    expect(
      composeBadges({ state: 'draft', findings: 0, checks: 'passing' }),
    ).not.toContainEqual({ text: 'no findings', tone: 'subtle' });
  });

  it('badges running checks', () => {
    expect(
      composeBadges({ state: 'open', findings: 1, checks: 'running' }),
    ).toEqual([
      { text: '1 open finding', tone: 'amber' },
      { text: 'checks running', tone: 'subtle' },
    ]);
  });

  it('badges failing checks in red', () => {
    expect(
      composeBadges({ state: 'open', findings: 1, checks: 'failing' }),
    ).toEqual([
      { text: '1 open finding', tone: 'amber' },
      { text: 'checks failing', tone: 'red' },
    ]);
  });

  it('says nothing about passing checks', () => {
    const texts = composeBadges({
      state: 'open',
      findings: 1,
      checks: 'passing',
    }).map((badge) => badge.text);
    expect(texts).not.toContain('checks running');
    expect(texts).not.toContain('checks failing');
  });

  /** The four fixture PRs, exactly as the panel renders them. */
  it('composes the fixture combinations', () => {
    expect(composeBadges({ state: 'open', findings: 2, checks: 'passing' })).toEqual([
      { text: '2 open findings', tone: 'amber' },
    ]);
    expect(
      composeBadges({ state: 'approved', findings: 0, checks: 'passing' }),
    ).toEqual([
      { text: 'approved', tone: 'green' },
      { text: 'no findings', tone: 'subtle' },
    ]);
    expect(composeBadges({ state: 'draft', findings: 0, checks: 'running' })).toEqual([
      { text: 'draft', tone: 'subtle' },
      { text: 'checks running', tone: 'subtle' },
    ]);
    expect(composeBadges({ state: 'merged', findings: 0, checks: 'passing' })).toEqual([
      { text: 'merged', tone: 'brand' },
    ]);
  });
});
```

- [ ] **Step 2: Run the test and watch it fail**

Run: `cd app && pnpm exec vitest run tests/features/shared/pr-presentation.test.ts`
Expected: FAIL — `composeBadges` is not exported.

- [ ] **Step 3: Implement `composeBadges`**

Append to `src/features/shared/pr-presentation.ts` (and add the two imports at the top, in alphabetical order within their group):

```ts
import type { TagTone } from '@components/ui/tag';
import type { Pr } from '@/types/pull-request';

export interface PrBadge {
  text: string;
  tone: TagTone;
}

/**
 * Story 052's badge rule table, in render order.
 *
 * Order is part of the contract, not an accident of the `if` chain: state first
 * (what the PR *is*), then findings (what it needs), then checks (what CI is
 * doing). Reordering changes what the eye reads first in a 316px column.
 *
 * `no findings` is deliberately restricted to `open`. On a draft it would be
 * reassurance about a review that has not happened, and on a merged PR it is
 * noise about a question already settled.
 *
 * Passing checks produce no badge at all — a green tick for the expected case
 * is the kind of chrome that makes the two states that matter harder to spot.
 */
export function composeBadges(
  pr: Pick<Pr, 'state' | 'findings' | 'checks'>,
): PrBadge[] {
  const badges: PrBadge[] = [];

  if (pr.state === 'merged') badges.push({ text: 'merged', tone: 'brand' });
  if (pr.state === 'approved') badges.push({ text: 'approved', tone: 'green' });
  if (pr.state === 'draft') badges.push({ text: 'draft', tone: 'subtle' });

  if (pr.findings > 0) {
    badges.push({
      text: `${pr.findings} open finding${pr.findings === 1 ? '' : 's'}`,
      tone: 'amber',
    });
  } else if (pr.state === 'open') {
    badges.push({ text: 'no findings', tone: 'subtle' });
  }

  if (pr.checks === 'running') {
    badges.push({ text: 'checks running', tone: 'subtle' });
  }
  if (pr.checks === 'failing') {
    badges.push({ text: 'checks failing', tone: 'red' });
  }

  return badges;
}
```

- [ ] **Step 4: Run the tests and the boundary check**

Run: `cd app && pnpm exec vitest run tests/features/shared/pr-presentation.test.ts && pnpm verify:boundaries && pnpm lint`
Expected: PASS. `features/shared` importing `components/ui` is allowed — the ban runs the other way.

- [ ] **Step 5: Commit**

```bash
cd "$WT/app"
git add src/features/shared/pr-presentation.ts tests/features/shared/pr-presentation.test.ts
git commit -m "feat(shared): composeBadges rule table for the PRs panel (HIVE-27)"
```

---

### Task 3: A red badge on the Inbox tab

Story 050 wants the unread count "visually louder than the left rail's neutral badge". `TabBar` currently hardcodes `tone="muted"`.

**Files:**
- Modify: `src/components/ui/tab-bar.tsx`
- Test: `tests/components/ui/tab-bar.test.tsx` (append)

**Interfaces:**
- Produces: `Tab.badgeTone?: 'danger' | 'brand' | 'muted'`, defaulting to `'muted'`.

- [ ] **Step 1: Write the failing test**

Append to `tests/components/ui/tab-bar.test.tsx`:

```tsx
/**
 * The activity rail's unread count is an alarm, not an inventory: it means
 * agents are blocked on the user. The left rail's work count is neutral.
 */
it('lets a tab ask for a louder badge', () => {
  render(
    <TabBar
      tabs={[
        {
          id: 'inbox',
          label: 'Inbox',
          badgeCount: 3,
          badgeLabel: 'unread notifications',
          badgeTone: 'danger',
        },
      ]}
      active="inbox"
      onSelect={() => {}}
      label="Rail sections"
    />,
  );

  expect(screen.getByText('3')).toHaveClass('bg-danger-solid');
});

it('defaults to the quiet badge', () => {
  render(
    <TabBar
      tabs={[{ id: 'work', label: 'Work', badgeCount: 8, badgeLabel: 'work items' }]}
      active="work"
      onSelect={() => {}}
      label="Rail sections"
    />,
  );

  expect(screen.getByText('8')).toHaveClass('bg-chip');
});
```

- [ ] **Step 2: Run the test and watch it fail**

Run: `cd app && pnpm exec vitest run tests/components/ui/tab-bar.test.tsx`
Expected: FAIL — `badgeTone` is not a property of `Tab`; the badge renders `bg-chip`.

- [ ] **Step 3: Thread the tone through**

In `src/components/ui/tab-bar.tsx`, add to the `Tab` interface after `badgeLabel`:

```ts
  /**
   * How loud the count is. The left rail's work count is an inventory and stays
   * `muted`; the activity rail's unread count means agents are blocked on the
   * user, and story 050 asks for red. Defaults to `muted`.
   */
  badgeTone?: BadgeTone;
```

Export the tone union from `src/components/ui/badge.tsx` so the two atoms cannot drift — change `type BadgeTone` to `export type BadgeTone`, and import it in `tab-bar.tsx`:

```ts
import { Badge, type BadgeTone } from '@components/ui/badge';
```

Then in the render, replace `tone="muted"` with:

```tsx
            <Badge
              count={tab.badgeCount ?? 0}
              tone={tab.badgeTone ?? 'muted'}
              label={tab.badgeLabel}
            />
```

- [ ] **Step 4: Run the tests and watch them pass**

Run: `cd app && pnpm exec vitest run tests/components/ui/tab-bar.test.tsx tests/components/layout/left-rail.test.tsx tests/components/ui/badge.test.tsx`
Expected: PASS — the left rail is unchanged because the default is `muted`.

- [ ] **Step 5: Commit**

```bash
cd "$WT/app"
git add src/components/ui/tab-bar.tsx src/components/ui/badge.tsx tests/components/ui/tab-bar.test.tsx
git commit -m "feat(ui): per-tab badge tone so the inbox count can be red (HIVE-25)"
```

---

### Task 4: The deterministic demo clock

Story 053: timestamps start at 14:38 and advance one minute per event, so a demo and a test agree. The store currently stamps feed items from the real wall clock.

**Files:**
- Create: `src/lib/fake-clock.ts`
- Test: `tests/lib/fake-clock.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `export const FAKE_CLOCK_START = '14:38'`, `export function stamp(): string`, `export function reset(): void`, `export function peek(): string`.

- [ ] **Step 1: Write the failing test**

```ts
// tests/lib/fake-clock.test.ts
import { beforeEach, describe, expect, it } from 'vitest';

import { FAKE_CLOCK_START, peek, reset, stamp } from '@lib/fake-clock';

/**
 * A module, not a module-level counter, precisely so tests can reset it. Story
 * 053 calls that out: without `reset()` the first test to push a feed item
 * would leak its time into every test after it.
 */
beforeEach(() => {
  reset();
});

describe('fake clock', () => {
  it('starts at 14:38', () => {
    expect(FAKE_CLOCK_START).toBe('14:38');
    expect(peek()).toBe('14:38');
  });

  it('advances one minute per stamp', () => {
    expect(stamp()).toBe('14:38');
    expect(stamp()).toBe('14:39');
    expect(stamp()).toBe('14:40');
  });

  it('rolls the hour over', () => {
    for (let i = 0; i < 22; i += 1) stamp();
    expect(stamp()).toBe('15:00');
  });

  it('wraps past midnight rather than reaching 24:00', () => {
    for (let i = 0; i < 9 * 60 + 22; i += 1) stamp();
    expect(stamp()).toBe('00:00');
  });

  it('pads single digits to HH:MM', () => {
    for (let i = 0; i < 9 * 60 + 23; i += 1) stamp();
    expect(stamp()).toBe('00:01');
  });

  it('returns to the start on reset', () => {
    stamp();
    stamp();
    reset();
    expect(peek()).toBe('14:38');
  });

  it('does not advance when peeked', () => {
    expect(peek()).toBe('14:38');
    expect(peek()).toBe('14:38');
  });
});
```

- [ ] **Step 2: Run the test and watch it fail**

Run: `cd app && pnpm exec vitest run tests/lib/fake-clock.test.ts`
Expected: FAIL — cannot resolve `@lib/fake-clock`.

- [ ] **Step 3: Write the clock**

```ts
// src/lib/fake-clock.ts
/**
 * The prototype's clock (story 053).
 *
 * Every feed item is stamped from here rather than from `new Date()`, for two
 * reasons. A demo recorded at 03:11 should not say so — the seeded feed opens
 * at 14:37 and the story continues from 14:38. And a wall clock makes the
 * store's own tests unassertable: `expect(feed[0].time)` would have to match a
 * moving target.
 *
 * Lives in `lib/` rather than `features/activity-feed/` because `stores/` is
 * what stamps items on spawn and send, and the lint zone forbids
 * `stores/ → features/`. `lib/` is leaf-level, which is exactly what a clock
 * should be.
 *
 * `reset()` is the reason this is a module with a function rather than an
 * exported `let`: story 053 requires tests to be able to rewind it, and
 * `reset()` is called by the hive-store's own `reset()`.
 */

/** Where the demo's story starts — one minute after the last seeded feed item. */
export const FAKE_CLOCK_START = '14:38';

const MINUTES_PER_DAY = 24 * 60;
const START_MINUTES = 14 * 60 + 38;

let minutes = START_MINUTES;

const format = (value: number): string => {
  const wrapped = ((value % MINUTES_PER_DAY) + MINUTES_PER_DAY) % MINUTES_PER_DAY;
  const hours = Math.floor(wrapped / 60);
  const mins = wrapped % 60;
  return `${String(hours).padStart(2, '0')}:${String(mins).padStart(2, '0')}`;
};

/** The current time, then advance one minute. */
export function stamp(): string {
  const label = format(minutes);
  minutes += 1;
  return label;
}

/** The current time, without advancing — for assertions and debugging. */
export function peek(): string {
  return format(minutes);
}

/** Rewind to 14:38. Called by the hive-store's `reset()` and by tests. */
export function reset(): void {
  minutes = START_MINUTES;
}
```

- [ ] **Step 4: Run the test and watch it pass**

Run: `cd app && pnpm exec vitest run tests/lib/fake-clock.test.ts`
Expected: PASS, 7 tests.

- [ ] **Step 5: Commit**

```bash
cd "$WT/app"
git add src/lib/fake-clock.ts tests/lib/fake-clock.test.ts
git commit -m "feat(lib): deterministic demo clock for the activity feed (HIVE-28)"
```

---

### Task 5: Store — fake clock, notification pushes, and the rail's selectors

**Files:**
- Modify: `src/stores/hive-store.ts`
- Test: `tests/stores/hive-store.test.ts`, `tests/stores/hive-store.selectors.test.tsx`

**Interfaces:**
- Consumes: `stamp`, `reset as resetClock` from `@lib/fake-clock` (Task 4).
- Produces: `pushNotif(notif: Notification): void` on the store; selector hooks `useNotifs(): Notification[]`, `usePrs(): Pr[]`, `useFeed(): FeedItem[]`, `useMarkRead(): (index: number) => void`, `usePushNotif(): (notif: Notification) => void`.

- [ ] **Step 1: Write the failing tests**

Append to `tests/stores/hive-store.test.ts` (inside the existing top-level `describe`, which already calls `useHiveStore.getState().reset()` in `beforeEach`):

```ts
import { peek } from '@lib/fake-clock';

describe('the activity feed clock', () => {
  it('stamps a spawn with the fake clock, not the wall clock', () => {
    useHiveStore.getState().spawnSession('apfm-web', 'a task');

    expect(useHiveStore.getState().feed[0].time).toBe('14:38');
  });

  it('advances one minute per feed event', () => {
    useHiveStore.getState().spawnSession('apfm-web', 'first');
    useHiveStore.getState().spawnSession('apfm-web', 'second');

    const [newest, older] = useHiveStore.getState().feed;
    expect(newest.time).toBe('14:39');
    expect(older.time).toBe('14:38');
  });

  /** Otherwise the second test in any file inherits the first one's minutes. */
  it('rewinds the clock on reset', () => {
    useHiveStore.getState().spawnSession('apfm-web', 'a task');
    useHiveStore.getState().reset();

    expect(peek()).toBe('14:38');
  });
});

describe('pushNotif', () => {
  const notif = (title: string) => ({
    icon: 'ph-hand-palm',
    tone: 'amber' as const,
    title,
    sub: 'a subtitle',
    time: 'now',
    unread: true,
    target: 'lead-form',
  });

  it('prepends, so the newest notification is first', () => {
    useHiveStore.getState().pushNotif(notif('newest'));

    expect(useHiveStore.getState().notifs[0].title).toBe('newest');
  });

  it('caps the list at eight, dropping the oldest', () => {
    const before = useHiveStore.getState().notifs;
    expect(before).toHaveLength(5);
    const oldest = before[before.length - 1].title;

    for (let i = 0; i < 4; i += 1) {
      useHiveStore.getState().pushNotif(notif(`extra ${i}`));
    }

    const after = useHiveStore.getState().notifs;
    expect(after).toHaveLength(8);
    expect(after.map((n) => n.title)).not.toContain(oldest);
  });

  it('counts as unread the moment it lands', () => {
    const before = useHiveStore
      .getState()
      .notifs.filter((n) => n.unread).length;

    useHiveStore.getState().pushNotif(notif('needs you'));

    expect(
      useHiveStore.getState().notifs.filter((n) => n.unread).length,
    ).toBe(before + 1);
  });
});
```

Append to `tests/stores/hive-store.selectors.test.tsx` (follow the file's existing `renderHook` + `act` pattern and its import list):

```tsx
describe('rail selectors', () => {
  it('useNotifs returns the inbox in order', () => {
    const { result } = renderHook(() => useNotifs());

    expect(result.current).toHaveLength(5);
    expect(result.current[0].title).toBe('lead-form needs approval');
  });

  it('usePrs returns the four fixture PRs', () => {
    const { result } = renderHook(() => usePrs());

    expect(result.current.map((pr) => pr.n)).toEqual([482, 219, 495, 77]);
  });

  it('useFeed returns the seeded feed newest-first', () => {
    const { result } = renderHook(() => useFeed());

    expect(result.current).toHaveLength(7);
    expect(result.current[0].time).toBe('14:37');
  });

  it('useMarkRead marks exactly one notification read', () => {
    const { result } = renderHook(() => ({
      markRead: useMarkRead(),
      notifs: useNotifs(),
    }));

    act(() => {
      result.current.markRead(0);
    });

    expect(result.current.notifs[0].unread).toBe(false);
    expect(result.current.notifs[1].unread).toBe(true);
  });
});
```

- [ ] **Step 2: Run the tests and watch them fail**

Run: `cd app && pnpm exec vitest run tests/stores/`
Expected: FAIL — `pushNotif` is not a function; `useNotifs` is not exported; feed times are wall-clock.

- [ ] **Step 3: Wire the store**

In `src/stores/hive-store.ts`:

1. Add to the import block (alphabetised within the `@/`-prefixed internal group):

```ts
import { reset as resetClock, stamp } from '@lib/fake-clock';
```

2. Add to the `HiveState` interface, next to `markRead`:

```ts
  pushNotif: (notif: Notification) => void;
```

and add the type import `import type { Notification } from '@/types/notification';` if it is not already present.

3. Add the cap constant beside `FEED_CAP`:

```ts
/**
 * Inbox cap (story 051). Eight is what fits the rail without scrolling on a
 * laptop, and an inbox that grows without bound stops being an inbox.
 */
const NOTIF_CAP = 8;
```

4. Add the action beside `markRead`:

```ts
  pushNotif: (notif) =>
    set((state) => ({ notifs: [notif, ...state.notifs].slice(0, NOTIF_CAP) })),
```

5. Reset the clock in the store's `reset()`:

```ts
  reset: () => {
    spawnCounter = 0;
    resetClock();
    set(createInitialState());
  },
```

6. Replace the wall-clock helper. Delete the `nowLabel()` function near the bottom of the file and its two call sites' helper name — that is, change both `time: nowLabel(),` occurrences (in `spawnSession` and `sendToEntity`) to `time: stamp(),`, and delete:

```ts
/** `HH:MM`, matching the concept's feed timestamps. */
function nowLabel(): string {
  const now = new Date();
  return `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
}
```

7. Add the selector hooks beside `useUnreadCount`:

```ts
/** The inbox, newest first (story 051). */
export const useNotifs = () => useHiveStore((state) => state.notifs);

/** Every open PR the fleet produced (story 052). */
export const usePrs = () => useHiveStore((state) => state.prs);

/** The orchestrator's activity feed, newest first (story 053). */
export const useFeed = () => useHiveStore((state) => state.feed);

/** Mark one notification read, by its index in `notifs` (story 051). */
export const useMarkRead = () => useHiveStore((state) => state.markRead);

/** Push a notification — the simulation's entry point (stories 051, 061). */
export const usePushNotif = () => useHiveStore((state) => state.pushNotif);
```

- [ ] **Step 4: Run the full unit suite**

Run: `cd app && pnpm test`
Expected: PASS. If a pre-existing test asserted a wall-clock feed timestamp, it now asserts `'14:38'`; update it rather than reintroducing `nowLabel`.

- [ ] **Step 5: Commit**

```bash
cd "$WT/app"
git add src/stores/hive-store.ts tests/stores/
git commit -m "feat(store): fake-clock stamps, pushNotif cap, and rail selectors (HIVE-26, HIVE-28)"
```

---

### Task 6: Inbox panel (HIVE-26 / story 051)

**Files:**
- Create: `src/features/inbox/components/notification-card.tsx`, `src/features/inbox/components/inbox-panel.tsx`
- Test: `tests/features/inbox/components/notification-card.test.tsx`, `tests/features/inbox/components/inbox-panel.test.tsx`

**Interfaces:**
- Consumes: `useNotifs`, `useMarkRead` (Task 5); `useOpenTab` from `@stores/ui-store`; `Icon` from `@components/ui/icon`.
- Produces: `NotificationCard({ notif, index }: { notif: Notification; index: number })` and `InboxPanel()`.

- [ ] **Step 1: Write the failing tests**

```tsx
// tests/features/inbox/components/notification-card.test.tsx
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it } from 'vitest';

import { NotificationCard } from '@features/inbox/components/notification-card';
import { useHiveStore } from '@stores/hive-store';
import { useUiStore } from '@stores/ui-store';

const notif = (overrides = {}) => ({
  icon: 'ph-hand-palm',
  tone: 'amber' as const,
  title: 'lead-form needs approval',
  sub: 'prisma migrate dev — lead_phone_idx',
  time: '4m',
  unread: true,
  target: 'lead-form',
  ...overrides,
});

beforeEach(() => {
  useHiveStore.getState().reset();
  useUiStore.getState().reset();
});

describe('NotificationCard', () => {
  it('renders title, subtitle, and time', () => {
    render(<NotificationCard notif={notif()} index={0} />);

    expect(screen.getByText('lead-form needs approval')).toBeInTheDocument();
    expect(
      screen.getByText('prisma migrate dev — lead_phone_idx'),
    ).toBeInTheDocument();
    expect(screen.getByText('4m')).toBeInTheDocument();
  });

  /** Unread is a chip fill plus a stronger border; read is transparent. */
  it('fills an unread card and flattens a read one', () => {
    const { rerender } = render(<NotificationCard notif={notif()} index={0} />);
    expect(screen.getByRole('button')).toHaveClass('bg-chip');

    rerender(<NotificationCard notif={notif({ unread: false })} index={0} />);
    expect(screen.getByRole('button')).not.toHaveClass('bg-chip');
  });

  it('opens the target session and marks only this card read', async () => {
    const user = userEvent.setup();
    render(<NotificationCard notif={notif()} index={0} />);

    await user.click(screen.getByRole('button'));

    expect(useUiStore.getState().activeTab).toBe('lead-form');
    expect(useHiveStore.getState().notifs[0].unread).toBe(false);
    expect(useHiveStore.getState().notifs[1].unread).toBe(true);
  });

  /** The count is what the badges read; an unread card must say so out loud. */
  it('announces its unread state', () => {
    render(<NotificationCard notif={notif()} index={0} />);

    expect(screen.getByText('unread')).toBeInTheDocument();
  });
});
```

```tsx
// tests/features/inbox/components/inbox-panel.test.tsx
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { act } from 'react';
import { beforeEach, describe, expect, it } from 'vitest';

import { InboxPanel } from '@features/inbox/components/inbox-panel';
import { useHiveStore } from '@stores/hive-store';
import { useUiStore } from '@stores/ui-store';

beforeEach(() => {
  useHiveStore.getState().reset();
  useUiStore.getState().reset();
});

describe('InboxPanel', () => {
  it('renders every fixture notification, newest first', () => {
    render(<InboxPanel />);

    const cards = screen.getAllByRole('button');
    expect(cards).toHaveLength(5);
    expect(cards[0]).toHaveTextContent('lead-form needs approval');
  });

  it('drops the unread styling when everything is marked read', async () => {
    render(<InboxPanel />);
    expect(screen.getAllByText('unread')).toHaveLength(3);

    await act(async () => {
      useHiveStore.getState().markAllRead();
    });

    expect(screen.queryByText('unread')).not.toBeInTheDocument();
  });

  it('shows a pushed notification at the top', async () => {
    render(<InboxPanel />);

    await act(async () => {
      useHiveStore.getState().pushNotif({
        icon: 'ph-chat-circle-dots',
        tone: 'amber',
        title: 'nplusone asked a question',
        sub: 'index or denormalise?',
        time: 'now',
        unread: true,
        target: 'nplusone',
      });
    });

    expect(screen.getAllByRole('button')[0]).toHaveTextContent(
      'nplusone asked a question',
    );
  });

  it('caps the rendered list at eight', async () => {
    render(<InboxPanel />);

    await act(async () => {
      for (let i = 0; i < 5; i += 1) {
        useHiveStore.getState().pushNotif({
          icon: 'ph-hand-palm',
          tone: 'amber',
          title: `extra ${i}`,
          sub: 'a subtitle',
          time: 'now',
          unread: true,
          target: 'lead-form',
        });
      }
    });

    expect(screen.getAllByRole('button')).toHaveLength(8);
  });

  it('jumps to the session a card names', async () => {
    const user = userEvent.setup();
    render(<InboxPanel />);

    await user.click(screen.getByText('call-notes asked a question'));

    expect(useUiStore.getState().activeTab).toBe('call-notes');
  });
});
```

- [ ] **Step 2: Run the tests and watch them fail**

Run: `cd app && pnpm exec vitest run tests/features/inbox/`
Expected: FAIL — neither module resolves.

- [ ] **Step 3: Write the card**

```tsx
// src/features/inbox/components/notification-card.tsx
import { cn } from '@/lib/utils';
import type { Notification, Tone } from '@/types/notification';

import { Icon } from '@components/ui/icon';
import { useMarkRead } from '@stores/hive-store';
import { useOpenTab } from '@stores/ui-store';

const TONE_TEXT: Record<Tone, string> = {
  amber: 'text-amber',
  green: 'text-green',
  brand: 'text-brand',
  red: 'text-red',
};

interface NotificationCardProps {
  notif: Notification;
  /** Position in `notifs` — how `markRead` identifies this card. */
  index: number;
}

/**
 * One thing an agent needs from the user.
 *
 * Clicking does two things at once, and both matter: it opens the terminal that
 * is blocked, and it marks *this* card read. Marking read without navigating
 * would lose the thread; navigating without marking read would leave the badge
 * lying about how much is still waiting.
 *
 * The unread state is carried by fill *and* by a visually hidden word. Colour
 * alone would put the count's meaning out of reach of a screen reader, and the
 * count is the whole point of the red badge on the tab.
 */
export function NotificationCard({ notif, index }: NotificationCardProps) {
  const openTab = useOpenTab();
  const markRead = useMarkRead();

  return (
    <button
      type="button"
      onClick={() => {
        openTab(notif.target);
        markRead(index);
      }}
      className={cn(
        'flex items-start gap-2.5 rounded-xl border px-3 py-2.5 text-left hover:bg-hover',
        notif.unread ? 'border-border bg-chip' : 'border-border-soft',
      )}
    >
      <Icon
        name={notif.icon}
        size={16}
        className={cn('mt-px shrink-0', TONE_TEXT[notif.tone])}
      />

      <span className="flex min-w-0 flex-1 flex-col">
        <span className="text-[12.5px] font-semibold text-ink">
          {notif.title}
        </span>
        <span className="text-[11.5px] leading-[1.4] text-muted">
          {notif.sub}
        </span>
        {notif.unread ? <span className="sr-only">unread</span> : null}
      </span>

      <span className="shrink-0 font-mono text-[10px] text-subtle">
        {notif.time}
      </span>
    </button>
  );
}
```

- [ ] **Step 4: Write the panel**

```tsx
// src/features/inbox/components/inbox-panel.tsx
import { NotificationCard } from '@features/inbox/components/notification-card';
import { useNotifs } from '@stores/hive-store';

/**
 * The inbox — everything agents need from the user, newest first.
 *
 * Keyed by title rather than index: the simulation prepends, and an index key
 * would make React reuse the top card's DOM for a different notification,
 * animating the wrong row and briefly showing stale text.
 *
 * The index is still passed down, because `markRead` addresses a notification
 * by position in the store's array.
 */
export function InboxPanel() {
  const notifs = useNotifs();

  return (
    <div data-panel="inbox" className="flex flex-col gap-2">
      {notifs.map((notif, index) => (
        <NotificationCard
          key={`${notif.title}-${notif.time}`}
          notif={notif}
          index={index}
        />
      ))}
    </div>
  );
}
```

- [ ] **Step 5: Run the tests and watch them pass**

Run: `cd app && pnpm exec vitest run tests/features/inbox/ && pnpm verify:boundaries`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
cd "$WT/app"
git add src/features/inbox tests/features/inbox
git commit -m "feat(inbox): notification cards and the jump-to-blocked-session click (HIVE-26)"
```

---

### Task 7: PRs panel (HIVE-27 / story 052)

**Files:**
- Create: `src/features/pull-requests/components/pr-card.tsx`, `src/features/pull-requests/components/prs-panel.tsx`
- Test: `tests/features/pull-requests/components/pr-card.test.tsx`, `tests/features/pull-requests/components/prs-panel.test.tsx`

**Interfaces:**
- Consumes: `composeBadges`, `prStateText` (Task 2); `Tag` (Task 1); `usePrs` (Task 5); `useOpenTab`.
- Produces: `PrCard({ pr }: { pr: Pr })` and `PrsPanel()`.

- [ ] **Step 1: Write the failing tests**

```tsx
// tests/features/pull-requests/components/pr-card.test.tsx
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it } from 'vitest';

import type { Pr } from '@/types/pull-request';

import { PrCard } from '@features/pull-requests/components/pr-card';
import { useHiveStore } from '@stores/hive-store';
import { useUiStore } from '@stores/ui-store';

const pr = (overrides: Partial<Pr> = {}): Pr => ({
  n: 482,
  repo: 'apfm-web',
  title: 'Hero: semantic token refactor',
  state: 'open',
  findings: 2,
  checks: 'passing',
  session: 'hero-refresh',
  ...overrides,
});

beforeEach(() => {
  useHiveStore.getState().reset();
  useUiStore.getState().reset();
});

describe('PrCard', () => {
  it('renders number, title, and repo', () => {
    render(<PrCard pr={pr()} />);

    expect(screen.getByText('#482')).toBeInTheDocument();
    expect(screen.getByText('Hero: semantic token refactor')).toBeInTheDocument();
    expect(screen.getByText('apfm-web')).toBeInTheDocument();
  });

  it('renders the badges the rule table composes', () => {
    render(<PrCard pr={pr({ state: 'draft', findings: 0, checks: 'running' })} />);

    expect(screen.getByText('draft')).toBeInTheDocument();
    expect(screen.getByText('checks running')).toBeInTheDocument();
  });

  it('opens the owning session, not a browser', async () => {
    const user = userEvent.setup();
    render(<PrCard pr={pr()} />);

    await user.click(screen.getByRole('button'));

    expect(useUiStore.getState().activeTab).toBe('hero-refresh');
  });

  it('colours the icon by state', () => {
    const { container, rerender } = render(<PrCard pr={pr({ state: 'merged' })} />);
    expect(container.querySelector('svg')).toHaveClass('text-brand');

    rerender(<PrCard pr={pr({ state: 'draft' })} />);
    expect(container.querySelector('svg')).toHaveClass('text-subtle');
  });
});
```

```tsx
// tests/features/pull-requests/components/prs-panel.test.tsx
import { render, screen, within } from '@testing-library/react';
import { act } from 'react';
import { beforeEach, describe, expect, it } from 'vitest';

import { PrsPanel } from '@features/pull-requests/components/prs-panel';
import { useHiveStore } from '@stores/hive-store';
import { useUiStore } from '@stores/ui-store';

beforeEach(() => {
  useHiveStore.getState().reset();
  useUiStore.getState().reset();
});

const cardFor = (n: number) =>
  screen.getByText(`#${n}`).closest('button') as HTMLElement;

describe('PrsPanel', () => {
  it('renders one card per PR', () => {
    render(<PrsPanel />);

    expect(screen.getAllByRole('button')).toHaveLength(4);
  });

  /** Story 052's acceptance criterion, fixture by fixture. */
  it('gives each fixture PR the badge combination the rules produce', () => {
    render(<PrsPanel />);

    expect(within(cardFor(482)).getByText('2 open findings')).toBeInTheDocument();

    expect(within(cardFor(219)).getByText('approved')).toBeInTheDocument();
    expect(within(cardFor(219)).getByText('no findings')).toBeInTheDocument();

    expect(within(cardFor(495)).getByText('draft')).toBeInTheDocument();
    expect(within(cardFor(495)).getByText('checks running')).toBeInTheDocument();

    expect(within(cardFor(77)).getByText('merged')).toBeInTheDocument();
  });

  it('re-renders when a PR changes in the store', async () => {
    render(<PrsPanel />);
    expect(within(cardFor(482)).getByText('2 open findings')).toBeInTheDocument();

    await act(async () => {
      useHiveStore.setState((state) => ({
        prs: state.prs.map((pr) =>
          pr.n === 482 ? { ...pr, findings: 3, checks: 'failing' as const } : pr,
        ),
      }));
    });

    expect(within(cardFor(482)).getByText('3 open findings')).toBeInTheDocument();
    expect(within(cardFor(482)).getByText('checks failing')).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run the tests and watch them fail**

Run: `cd app && pnpm exec vitest run tests/features/pull-requests/`
Expected: FAIL — neither module resolves.

- [ ] **Step 3: Write the card**

```tsx
// src/features/pull-requests/components/pr-card.tsx
import { cn } from '@/lib/utils';
import type { Pr } from '@/types/pull-request';

import { Icon } from '@components/ui/icon';
import { Tag } from '@components/ui/tag';
import { composeBadges, prStateText } from '@features/shared/pr-presentation';
import { useOpenTab } from '@stores/ui-store';

interface PrCardProps {
  pr: Pr;
}

/**
 * One open PR: what it is, where it lives, and what it is waiting on.
 *
 * Clicking opens the *session* that produced it, not the PR on GitHub. A PR has
 * no tab of its own in this app; the agent that owns it does, and that is where
 * a human can actually do something about the findings.
 *
 * The badge row comes from `composeBadges` in `features/shared` rather than
 * from local `if`s, so the rules cannot drift from the ticket surface that
 * describes the same PRs (story 052).
 */
export function PrCard({ pr }: PrCardProps) {
  const openTab = useOpenTab();
  const badges = composeBadges(pr);

  return (
    <button
      type="button"
      onClick={() => openTab(pr.session)}
      className="flex items-start gap-2.5 rounded-xl border border-border-soft px-3 py-2.5 text-left hover:bg-hover"
    >
      <Icon
        name="ph-git-pull-request"
        size={16}
        className={cn('mt-px shrink-0', prStateText(pr.state))}
      />

      <span className="flex min-w-0 flex-1 flex-col">
        <span className="flex min-w-0 items-baseline gap-1.5">
          <span className="shrink-0 font-mono text-[12px] text-brand">
            #{pr.n}
          </span>
          <span className="truncate text-[12.5px] font-semibold text-ink">
            {pr.title}
          </span>
        </span>

        <span className="pt-px pb-1.5 font-mono text-[10.5px] text-subtle">
          {pr.repo}
        </span>

        {badges.length > 0 ? (
          <span className="flex flex-wrap gap-1.5">
            {badges.map((badge) => (
              <Tag key={badge.text} tone={badge.tone}>
                {badge.text}
              </Tag>
            ))}
          </span>
        ) : null}
      </span>
    </button>
  );
}
```

- [ ] **Step 4: Write the panel**

```tsx
// src/features/pull-requests/components/prs-panel.tsx
import { PrCard } from '@features/pull-requests/components/pr-card';
import { usePrs } from '@stores/hive-store';

/**
 * Every PR the fleet has open — what is shippable, and what is blocked.
 *
 * Reads the global `prs` collection, which is the single source of truth the
 * work panel (032) resolves against too. A second list here would let the two
 * surfaces disagree about the same number the moment the simulation moved one.
 */
export function PrsPanel() {
  const prs = usePrs();

  return (
    <div data-panel="prs" className="flex flex-col gap-2">
      {prs.map((pr) => (
        <PrCard key={pr.n} pr={pr} />
      ))}
    </div>
  );
}
```

- [ ] **Step 5: Run the tests and watch them pass**

Run: `cd app && pnpm exec vitest run tests/features/pull-requests/ && pnpm verify:boundaries`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
cd "$WT/app"
git add src/features/pull-requests tests/features/pull-requests
git commit -m "feat(pull-requests): PRs panel with the shared badge rules (HIVE-27)"
```

---

### Task 8: Activity feed panel (HIVE-28 / story 053)

**Files:**
- Create: `src/features/activity-feed/components/feed-row.tsx`, `src/features/activity-feed/components/activity-feed-panel.tsx`
- Modify: `src/components/ui/icon.tsx`
- Test: `tests/features/activity-feed/components/activity-feed-panel.test.tsx`, `tests/components/ui/icon.test.tsx` (append)

**Interfaces:**
- Consumes: `useFeed` (Task 5); `Icon`.
- Produces: `FeedRow({ item }: { item: FeedItem })` and `ActivityFeedPanel()`.

- [ ] **Step 1: Write the failing tests**

Append to `tests/components/ui/icon.test.tsx`:

```tsx
/**
 * Two feed fixtures (the PR poll and the pr-reviewer line) named glyphs the map
 * did not carry, so they rendered as the unknown-name question mark.
 */
it.each(['ph-arrows-clockwise', 'ph-robot'])(
  'knows the feed glyph %s',
  (name) => {
    const { container } = render(<Icon name={name} size={12} />);
    expect(container.querySelector('svg')).toBeInTheDocument();
    expect(container.innerHTML).not.toContain('question');
  },
);
```

```tsx
// tests/features/activity-feed/components/activity-feed-panel.test.tsx
import { render, screen } from '@testing-library/react';
import { act } from 'react';
import { beforeEach, describe, expect, it } from 'vitest';

import { ActivityFeedPanel } from '@features/activity-feed/components/activity-feed-panel';
import { useHiveStore } from '@stores/hive-store';
import { useUiStore } from '@stores/ui-store';

beforeEach(() => {
  useHiveStore.getState().reset();
  useUiStore.getState().reset();
});

describe('ActivityFeedPanel', () => {
  it('renders the seven seeded items in order, newest first', () => {
    render(<ActivityFeedPanel />);

    const times = screen
      .getAllByText(/^\d{2}:\d{2}$/)
      .map((node) => node.textContent);
    expect(times).toEqual([
      '14:37',
      '14:36',
      '14:34',
      '14:32',
      '14:28',
      '14:21',
      '14:12',
    ]);
  });

  it('renders each item text', () => {
    render(<ActivityFeedPanel />);

    expect(
      screen.getByText('Loop: polled 4 open PRs — no new feedback'),
    ).toBeInTheDocument();
    expect(
      screen.getByText('lead-form paused — permission needed'),
    ).toBeInTheDocument();
  });

  /** A log, not navigation — nothing here is clickable. */
  it('has no interactive rows', () => {
    render(<ActivityFeedPanel />);

    expect(screen.queryAllByRole('button')).toHaveLength(0);
  });

  it('prepends a routed message with the next fake-clock stamp', async () => {
    render(<ActivityFeedPanel />);

    await act(async () => {
      useHiveStore.getState().sendToEntity('lead-form', 'y');
    });

    expect(screen.getByText('Routed your reply to lead-form')).toBeInTheDocument();
    expect(screen.getAllByText(/^\d{2}:\d{2}$/)[0]).toHaveTextContent('14:38');
  });

  it('never renders more than twenty-four items', async () => {
    render(<ActivityFeedPanel />);

    await act(async () => {
      for (let i = 0; i < 30; i += 1) {
        useHiveStore.getState().pushFeed({
          time: '15:00',
          txt: `event ${i}`,
          tone: 'brand',
          icon: 'ph-plus-circle',
        });
      }
    });

    expect(screen.getAllByText(/^\d{2}:\d{2}$/)).toHaveLength(24);
  });
});
```

- [ ] **Step 2: Run the tests and watch them fail**

Run: `cd app && pnpm exec vitest run tests/features/activity-feed/ tests/components/ui/icon.test.tsx`
Expected: FAIL — panel does not resolve; the two glyphs fall back to `Question`.

- [ ] **Step 3: Add the missing glyphs**

In `src/components/ui/icon.tsx`, add `ArrowsClockwise` and `Robot` to the `@phosphor-icons/react` import (keeping it alphabetised) and add to `GLYPHS` under the notifications-and-feed comment:

```ts
  'ph-arrows-clockwise': ArrowsClockwise,
  'ph-robot': Robot,
```

- [ ] **Step 4: Write the row**

```tsx
// src/features/activity-feed/components/feed-row.tsx
import { cn } from '@/lib/utils';
import type { FeedItem } from '@/types/feed';
import type { Tone } from '@/types/notification';

import { Icon } from '@components/ui/icon';

const TONE_TEXT: Record<Tone, string> = {
  amber: 'text-amber',
  green: 'text-green',
  brand: 'text-brand',
  red: 'text-red',
};

interface FeedRowProps {
  item: FeedItem;
}

/**
 * One line of what the orchestrator did.
 *
 * Deliberately not a button. Every other card in this rail navigates somewhere,
 * and the temptation is to make these do the same — but a feed entry is a
 * record of something that already happened, and half of them (a PR poll, a
 * Slack answer) have nowhere to go. A row that navigates only sometimes is
 * worse than one that never does.
 */
export function FeedRow({ item }: FeedRowProps) {
  return (
    <div className="flex items-start gap-2.5">
      <span className="flex size-[22px] shrink-0 items-center justify-center rounded-full bg-chip">
        <Icon name={item.icon} size={12} className={TONE_TEXT[item.tone]} />
      </span>

      <span className="flex min-w-0 flex-1 flex-col">
        <span className="font-mono text-[10px] text-subtle">{item.time}</span>
        <span className={cn('text-[12.5px] leading-[1.45] text-muted')}>
          {item.txt}
        </span>
      </span>
    </div>
  );
}
```

- [ ] **Step 5: Write the panel**

```tsx
// src/features/activity-feed/components/activity-feed-panel.tsx
import { FeedRow } from '@features/activity-feed/components/feed-row';
import { useFeed } from '@stores/hive-store';

/**
 * What the orchestrator did while the user was not looking.
 *
 * The store caps the feed at 24 and drops the oldest, so this renders whatever
 * it is given without a slice of its own — a second cap here would be a second
 * place to get the number wrong.
 *
 * Keyed by time and text together: the fake clock makes timestamps unique in
 * practice, but two events in the same minute would collide on time alone.
 */
export function ActivityFeedPanel() {
  const feed = useFeed();

  return (
    <div data-panel="activity" className="flex flex-col gap-2.5">
      {feed.map((item, index) => (
        <FeedRow key={`${item.time}-${item.txt}-${index}`} item={item} />
      ))}
    </div>
  );
}
```

- [ ] **Step 6: Run the tests and watch them pass**

Run: `cd app && pnpm exec vitest run tests/features/activity-feed/ tests/components/ui/icon.test.tsx && pnpm verify:boundaries`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
cd "$WT/app"
git add src/features/activity-feed src/components/ui/icon.tsx tests/features/activity-feed tests/components/ui/icon.test.tsx
git commit -m "feat(activity-feed): orchestrator feed panel and its missing glyphs (HIVE-28)"
```

---

### Task 9: The rail container (HIVE-25 / story 050)

**Files:**
- Modify: `src/components/layout/activity-rail.tsx`
- Test: `tests/components/layout/activity-rail.test.tsx` (create)

**Interfaces:**
- Consumes: `InboxPanel` (Task 6), `PrsPanel` (Task 7), `ActivityFeedPanel` (Task 8); `TabBar`, `tabId` with `badgeTone` (Task 3); `useUnreadCount`; `useRailTab`, `useSetRailTab` from `@stores/ui-store`.
- Produces: the finished `ActivityRail()`.

**Note on scroll position (story 050 asks for an explicit choice):** the panel resets to top on tab switch. Preserving per-panel `scrollTop` means keeping all three mounted or storing offsets in the ui-store, and neither earns its cost for three short lists. Documented in the component and in the ticket.

- [ ] **Step 1: Write the failing test**

```tsx
// tests/components/layout/activity-rail.test.tsx
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { act } from 'react';
import { beforeEach, describe, expect, it } from 'vitest';

import { ActivityRail } from '@components/layout/activity-rail';
import { useHiveStore } from '@stores/hive-store';
import { useUiStore } from '@stores/ui-store';

beforeEach(() => {
  useHiveStore.getState().reset();
  useUiStore.getState().reset();
});

describe('ActivityRail', () => {
  it('opens on the inbox', () => {
    render(<ActivityRail />);

    expect(screen.getByTestId('inbox-panel')).toBeInTheDocument();
  });

  it('swaps the panel when a tab is selected', async () => {
    const user = userEvent.setup();
    render(<ActivityRail />);

    await user.click(screen.getByRole('tab', { name: /PRs/ }));
    expect(screen.getByTestId('prs-panel')).toBeInTheDocument();
    expect(screen.queryByTestId('inbox-panel')).not.toBeInTheDocument();

    await user.click(screen.getByRole('tab', { name: /Activity/ }));
    expect(screen.getByTestId('activity-panel')).toBeInTheDocument();
  });

  it('follows railTab from the store', async () => {
    render(<ActivityRail />);

    await act(async () => {
      useUiStore.getState().setRailTab('prs');
    });

    expect(screen.getByTestId('prs-panel')).toBeInTheDocument();
  });

  /** Louder than the left rail's neutral count: it means agents are blocked. */
  it('badges the inbox tab in red with the unread count', () => {
    render(<ActivityRail />);

    const badge = screen.getByText('3');
    expect(badge).toHaveClass('bg-danger-solid');
  });

  it('drops the badge when everything is read', async () => {
    render(<ActivityRail />);

    await act(async () => {
      useHiveStore.getState().markAllRead();
    });

    expect(screen.queryByText('3')).not.toBeInTheDocument();
  });

  it('updates the badge live when a notification arrives', async () => {
    render(<ActivityRail />);

    await act(async () => {
      useHiveStore.getState().markAllRead();
      useHiveStore.getState().pushNotif({
        icon: 'ph-hand-palm',
        tone: 'amber',
        title: 'nplusone needs approval',
        sub: 'drop the index?',
        time: 'now',
        unread: true,
        target: 'nplusone',
      });
    });

    expect(screen.getByText('1')).toBeInTheDocument();
  });
});
```

Add `data-testid` to the three panels' root elements so the rail test asserts *which* panel mounted without reaching into each panel's content: `data-testid="inbox-panel"` on `InboxPanel`, `data-testid="prs-panel"` on `PrsPanel`, `data-testid="activity-panel"` on `ActivityFeedPanel` (alongside the existing `data-panel` attributes).

- [ ] **Step 2: Run the test and watch it fail**

Run: `cd app && pnpm exec vitest run tests/components/layout/activity-rail.test.tsx`
Expected: FAIL — the placeholder renders an empty `<aside>`; no tabs, no panels.

- [ ] **Step 3: Build the rail**

```tsx
// src/components/layout/activity-rail.tsx
import type { ComponentType } from 'react';

import { TabBar, tabId, type Tab } from '@components/ui/tab-bar';
import { ActivityFeedPanel } from '@features/activity-feed/components/activity-feed-panel';
import { InboxPanel } from '@features/inbox/components/inbox-panel';
import { PrsPanel } from '@features/pull-requests/components/prs-panel';
import { useUnreadCount } from '@stores/hive-store';
import { useRailTab, useSetRailTab, type RailTab } from '@stores/ui-store';

/**
 * Activity rail — the attention queue: what agents need, what is shippable,
 * and what the orchestrator has been doing.
 *
 * 316px fixed, and the only region the shell can hide: `showActivityRail` in
 * the ui-store unmounts it (in `app-shell.tsx`) so the terminal reclaims the
 * width and refits.
 *
 * This file is part of `components/layout/`, the composition root — the one
 * place chrome may import feature slices (AGENTS.md → Import zones). The three
 * panels are mounted directly rather than threaded in as slots from `app.tsx`,
 * which would move the whole app's wiring into one untestable module.
 *
 * **Scroll position resets on tab switch**, which story 050 asks us to choose
 * explicitly. Preserving it per panel means either keeping all three mounted or
 * mirroring `scrollTop` into the ui-store; for three short lists neither earns
 * the complexity, and a stale offset on a list the simulation just prepended to
 * is worse than starting at the top.
 */
const PANELS: Record<RailTab, ComponentType> = {
  inbox: InboxPanel,
  prs: PrsPanel,
  activity: ActivityFeedPanel,
};

export function ActivityRail() {
  const railTab = useRailTab();
  const setRailTab = useSetRailTab();
  const unread = useUnreadCount();

  const tabs: Tab<RailTab>[] = [
    {
      id: 'inbox',
      label: 'Inbox',
      badgeCount: unread,
      badgeLabel: 'unread notifications',
      // Red, not the left rail's neutral chip: an unread count here means the
      // user is the thing blocking an agent.
      badgeTone: 'danger',
    },
    { id: 'prs', label: 'PRs' },
    { id: 'activity', label: 'Activity' },
  ];

  const Panel = PANELS[railTab];

  return (
    <aside
      aria-label="Activity"
      className="flex w-[316px] shrink-0 flex-col gap-[18px] border-l border-border-soft bg-panel px-3.5 pt-3.5 pb-5"
    >
      <TabBar
        tabs={tabs}
        active={railTab}
        onSelect={setRailTab}
        label="Activity sections"
        className="shrink-0"
      />

      <div
        role="tabpanel"
        aria-labelledby={tabId(railTab)}
        className="min-h-0 flex-1 overflow-y-auto"
      >
        <Panel />
      </div>
    </aside>
  );
}
```

Check `src/stores/ui-store.ts` exports `useRailTab` and `useSetRailTab`. If the existing export is a combined `useRailState()` selector, add the two narrow hooks beside it rather than subscribing the rail to state it does not read:

```ts
/** Which rail panel is showing (story 050). */
export const useRailTab = () => useUiStore((state) => state.railTab);

/** Switch rail panels (story 050). */
export const useSetRailTab = () => useUiStore((state) => state.setRailTab);
```

- [ ] **Step 4: Run the whole suite with coverage**

Run: `cd app && pnpm test && pnpm lint && pnpm type-check && pnpm verify:boundaries && pnpm test:coverage`
Expected: PASS, coverage ≥ 80% on all four metrics. `tests/components/layout/app-shell.test.tsx` already asserts the rail unmounts when `showActivityRail` is false — confirm it still passes.

- [ ] **Step 5: Commit**

```bash
cd "$WT/app"
git add src/components/layout/activity-rail.tsx src/stores/ui-store.ts src/features tests
git commit -m "feat(rail): activity rail tabs mounting inbox, PRs, and feed (HIVE-25)"
```

---

### Task 10: The payoff loop in a real browser

Story 051's E2E: the inbox→terminal jump is the entry point of the payoff loop (043/070). Story 050's third acceptance criterion — terminals refit when the rail is hidden — is also browser-only.

**Files:**
- Modify: `tests/e2e/waiting-session.spec.ts`

- [ ] **Step 1: Write the failing E2E tests**

Append to `tests/e2e/waiting-session.spec.ts`:

```ts
const activityRail = (page: Page) =>
  page.getByRole('complementary', { name: 'Activity' });

test('the inbox jumps to the session that is blocked', async ({ page }) => {
  const rail = activityRail(page);

  // The rail opens on the inbox, with the unread count on its tab.
  await expect(rail.getByRole('tab', { name: /Inbox/ })).toBeVisible();

  await rail.getByText('lead-form needs approval').click();

  // The payoff: one click from "something needs you" to the amber prompt.
  await expect(terminalFor(page, 'lead-form')).toBeVisible();
  await expect(terminalFor(page, 'lead-form')).toContainText(
    'Permission needed: yarn prisma migrate dev',
  );
});

test('reading a notification decrements both badges', async ({ page }) => {
  const rail = activityRail(page);
  const inboxTab = rail.getByRole('tab', { name: /Inbox/ });

  await expect(inboxTab).toContainText('3');

  await rail.getByText('lead-form needs approval').click();

  await expect(inboxTab).toContainText('2');
  // The header bell reads the same count.
  await expect(
    page.getByRole('button', { name: /Mark 2 unread notifications as read/ }),
  ).toBeVisible();
});

test('the PRs tab lists what is shippable with its badges', async ({ page }) => {
  const rail = activityRail(page);
  await rail.getByRole('tab', { name: /PRs/ }).click();

  await expect(rail.getByText('2 open findings')).toBeVisible();
  await expect(rail.getByText('approved')).toBeVisible();
  await expect(rail.getByText('checks running')).toBeVisible();
  await expect(rail.getByText('merged')).toBeVisible();

  // A PR opens the session that owns it, not a browser tab.
  await rail.getByText('Hero: semantic token refactor').click();
  await expect(terminalFor(page, 'hero-refresh')).toBeVisible();
});

test('the activity tab logs a routed message', async ({ page }) => {
  await openSession(page, 'lead-form');
  await messageInput(page, 'lead-form').fill('y');
  await messageInput(page, 'lead-form').press('Enter');

  const rail = activityRail(page);
  await rail.getByRole('tab', { name: /Activity/ }).click();

  await expect(rail.getByText('Routed your message to lead-form')).toBeVisible();
});
```

- [ ] **Step 2: Run the E2E suite and watch the new tests fail if anything is off**

Run: `cd app && pnpm test:e2e tests/e2e/waiting-session.spec.ts`
Expected: PASS. If `getByRole('complementary')` does not match, the `<aside>` needs no change — `aria-label="Activity"` already names it; check the selector before touching the component.

- [ ] **Step 3: Drive the built UI by hand**

Run `cd app && pnpm dev`, open the app, and confirm against the concept (`concept/Command Center.dc.html`, the `data-screen-label="Activity rail"` aside):

- Inbox: three unread cards with chip fill, two read cards flat; the red count on the tab.
- Clicking "lead-form needs approval" lands in the lead-form terminal with the amber prompt visible, and the card goes flat.
- PRs: `#482` shows `2 open findings`; `#219` shows `approved` + `no findings`; `#495` shows `draft` + `checks running`; `#77` shows `merged`.
- Activity: seven rows, 14:37 down to 14:12, each with a coloured glyph in a 22px tile — and **no question marks**.
- Toggle the rail off: the center stage reclaims 316px and the terminal refits without clipping.
- Toggle light mode: every surface in the rail still meets contrast; nothing renders a raw hex.

- [ ] **Step 4: Commit**

```bash
cd "$WT/app"
git add tests/e2e/waiting-session.spec.ts
git commit -m "test(e2e): the inbox-to-blocked-session jump and the rail's panels (HIVE-26)"
```

---

### Task 11: Documentation

The repo treats docs as verified artifacts — `tests/design-system.test.ts` diffs `.claude/DESIGN-SYSTEM.md` against `tokens.css` and fails on drift.

**Files:**
- Modify: `.claude/COMPONENTS.md`, `docs/component-patterns.md`, `docs/state-and-data.md`

- [ ] **Step 1: Document the atom and the panels**

In `.claude/COMPONENTS.md`, add `Tag` to the atoms table with its tones, and add the three panels to the feature-slice inventory. State plainly how `Tag` differs from `Badge` (count-only, hides at zero) and `Chip` (larger mono pill, no `subtle` tone) so the next person does not add a fourth.

- [ ] **Step 2: Document the clock and the store action**

In `docs/state-and-data.md`, add `pushNotif` (cap 8) beside `pushFeed` (cap 24), the five new selector hooks, and a short section on `src/lib/fake-clock.ts` — why it lives in `lib/` (the `stores/ → features/` zone) and why `reset()` exists (test isolation).

- [ ] **Step 3: Document the composition pattern**

In `docs/component-patterns.md`, note that `activity-rail.tsx` follows `left-rail.tsx`: a `Record<TabId, ComponentType>` panel map, `TabBar` + a `role="tabpanel"` wrapper labelled by `tabId(active)`, and the deliberate scroll-reset-on-switch choice.

- [ ] **Step 4: Verify docs did not break the guards**

Run: `cd app && pnpm test && pnpm lint && pnpm type-check && pnpm verify:boundaries`
Expected: PASS, including `tests/design-system.test.ts`.

- [ ] **Step 5: Commit**

```bash
cd "$WT/app"
git add .claude/COMPONENTS.md docs/component-patterns.md docs/state-and-data.md
git commit -m "docs: Tag atom, rail panels, fake clock, and pushNotif (HIVE-5)"
```

---

### Task 12: Propagate the spec deviations to Jira

Four reconciliation findings need to reach the tickets before the PR is reviewed. Use the `workstream:spec-deviation` skill, which writes the `UPDATED SPECS` blocks and links the PR.

- [ ] **Step 1: HIVE-27** — `composeBadges` is consumed by the PRs panel only; the Work panel's `ticket-pr-row.tsx` keeps its compact `state` + `⚠ n` row (a 268px row cannot hold four wrapping badges). `features/shared` still owns the colour rules, so the "single source of truth" intent holds; the "one test suite protects both surfaces" wording does not. Also note the new `Tag` atom and why `Badge`/`Chip` could not serve.

- [ ] **Step 2: HIVE-28** — the fake clock lives at `src/lib/fake-clock.ts`, not `features/activity-feed/utils/`, because `hive-store` stamps feed items and the lint zone forbids `stores/ → features/`. Note that this replaces the store's real-wall-clock `nowLabel()`, and that `ph-arrows-clockwise` / `ph-robot` had to be added to the icon map.

- [ ] **Step 3: HIVE-26** — the store gained `pushNotif` with `NOTIF_CAP = 8`; the cap is proven at store level rather than through the simulation, which lands in 061.

- [ ] **Step 4: HIVE-25** — scroll position **resets** on tab switch (the story asks for an explicit choice); `TabBar` gained an optional `badgeTone` so the inbox count can be red while the left rail's stays neutral.

- [ ] **Step 5: Move all four tickets to In Progress** (if a hook has not already) and note in each that all four ship in one PR, since 050 alone is an empty tab shell.

---

## Self-Review

**Spec coverage.**

| Story | Requirement | Task |
|---|---|---|
| 050 | 316px, tokens, padding, own scroll, hideable | 9 |
| 050 | TabBar with Inbox · PRs · Activity, `railTab` | 9 |
| 050 | Red unread badge, louder than the left rail | 3, 9 |
| 050 | Body renders exactly one panel | 9 |
| 050 | Scroll-position choice made and noted | 9, 11, 12 |
| 050 | Badge live-updates on read / mark-all / push | 9 |
| 050 | Rail hidden → terminals refit | 10 (E2E + manual) |
| 050 | Mounts panels directly (composition root) | 9 |
| 051 | Card layout, unread/read/hover styling | 6 |
| 051 | Tone-coloured 16px icon, title/sub/time | 6 |
| 051 | Click → `openTab` + mark that card read | 6 |
| 051 | Bell marks all read; both badges stay in sync | 9, 10 (already shipped in 021) |
| 051 | Simulation prepends; list caps at 8 | 5, 6 |
| 051 | 5 fixtures | already in `fixtures.ts`; asserted in 6 |
| 051 | E2E: inbox → blocked terminal | 10 |
| 052 | Card layout, state-coloured icon, click → session | 7 |
| 052 | `#N` + title + repo + wrapping badge row | 7 |
| 052 | Badge rule table, one test per row | 2 |
| 052 | Four fixture combinations | 2, 7 |
| 052 | Rules live in `features/shared` | 2 |
| 052 | Store mutation re-renders the panel | 7 |
| 053 | Row layout, 22px tile, timestamp over text | 8 |
| 053 | Non-clickable | 8 |
| 053 | Feed capped at 24 | 5 (existing), asserted in 8 |
| 053 | Routed message / spawn push a feed item | 5, 8 |
| 053 | Fake clock from 14:38, +1 min, with `reset()` | 4, 5 |
| 053 | 7 seed fixtures render in order | 8 |

**Placeholder scan.** No `TBD`, no "similar to Task N", no "add error handling". Every code step carries the full body; every test step carries the assertions.

**Type consistency.** `TagTone` is defined in Task 1 and consumed by `PrBadge` in Task 2 and `Tag` in Task 7. `composeBadges` takes `Pick<Pr, 'state' | 'findings' | 'checks'>` in Task 2 and is called with a full `Pr` in Task 7 — compatible. `pushNotif(notif: Notification)` in Task 5 matches its call sites in Tasks 6 and 9. `useMarkRead()` returns `(index: number) => void`, matching `markRead(index)` in Task 6. `RailTab` comes from the existing ui-store and keys `PANELS` in Task 9.

**Known gap, deliberate:** every "the simulation does X" acceptance criterion depends on story 061, which is an unbuilt slice. Those are proven at store level here (`pushNotif`, `pushFeed`, `stamp`) and wire up when 061 lands.
