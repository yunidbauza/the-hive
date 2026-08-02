# HIVE-16 — Left Rail (container & tabs) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the 268px left rail's container and tab bar, plus the two shared atoms it introduces (`TabBar`, `StatusDot`), so stories 031/032/033 have a mounting point for their panels.

**Architecture:** `LeftRail` becomes a flex column whose first child is a pinned `TabBar` and whose second child is a scrolling tab panel rendering exactly one of `ProjectsPanel` / `WorkPanel` / `AgentsPanel`. Those panels live in feature slices, so `src/components/layout/` is promoted to the app's **composition root** — a narrow, documented exemption from the `components/ → features/` import zone. Tab state already lives in `ui-store` (`leftTab`), so panels keep their own state across switches for free.

**Tech Stack:** React 19, TypeScript, Zustand, Tailwind v4 (token utilities only), Vitest + React Testing Library, ESLint with `import/no-restricted-paths`.

## Global Constraints

- Work from `app/` (the pnpm package root). All paths below are relative to `app/`.
- **No raw hex literals in component code.** Colour only through Tailwind token utilities (`bg-panel`, `text-subtle`, `border-brand`).
- **kebab-case** for every file and folder under `src/`.
- **Absolute `@/` imports**, never relative parent imports (`../`).
- Import order: builtin → external → internal → parent → sibling → index, `@/**` pinned before internal, blank lines between groups, alphabetised.
- **Components never call `getState()` or read a store object directly** — always a named selector hook exported next to the store.
- Atoms in `src/components/ui/` are domain-agnostic: props are the whole API, and they may not import from `src/features/**`.
- `StatusDot` pulses via `animate-ccpulse` — never a hand-written keyframe.
- Coverage gate is **80% on lines, statements, branches, and functions** (`pnpm test:coverage`).
- Every new atom must be documented in `.claude/COMPONENTS.md`.
- Exact geometry comes from `concept/Command Center.dc.html` (repo root, one level above `app/`); it is the approved design and is authoritative over prose.

## Reference values (from the concept, verbatim)

Tab button — `tabStyle(on)` at `concept/Command Center.dc.html:750`:
```
display: flex; align-items: center; gap: 6px; padding: 6px 10px 9px;
font-size: 11px; font-weight: 600; letter-spacing: 0.08em; text-transform: uppercase;
color: on ? var(--cc-ink) : var(--cc-subtle);
border-bottom: 2px solid (on ? var(--cc-brand) : transparent); margin-bottom: -1px;
```

Tab bar container — `concept/Command Center.dc.html:77`:
```
display: flex; gap: 2px; border-bottom: 1px solid var(--cc-border-soft); flex: 0 0 auto;
```

Tab badge — `concept/Command Center.dc.html:81`:
```
min-width: 15px; height: 15px; border-radius: 999px; background: var(--cc-chip);
color: var(--cc-muted); font-size: 9.5px; font-weight: 700; padding: 0 4px;
```

Rail container — `concept/Command Center.dc.html:76`:
```
width: 268px; flex: 0 0 auto; border-right: 1px solid var(--cc-border-soft);
background: var(--cc-panel); padding: 14px 10px 20px;
display: flex; flex-direction: column; gap: 18px;
```

Status dot — `sessionRow` at `concept/Command Center.dc.html:644`:
```
width: 7px; height: 7px; border-radius: 999px; background: <status colour>;
animation: working ? ccpulse 1.6s ease-in-out infinite : none;
```

Status → colour (`stMeta`, `concept/Command Center.dc.html:636`, matches `.claude/DESIGN-SYSTEM.md:109-119`):

| status | label | token |
| --- | --- | --- |
| `working` | working | `--cc-green` (pulses) |
| `waiting` | needs input | `--cc-amber` |
| `idle` | idle | `--cc-subtle` |
| `done` | done | `--cc-brand` |
| `online` | online | `--cc-green` |

## Deviations from the ticket (already agreed)

1. **`Chip` and `Badge` already exist** (shipped with story 021). HIVE-16 lists them as "introduced here"; only `TabBar` and `StatusDot` remain to build. `Badge` gains a `muted` tone for the tab badge.
2. **`src/components/layout/` becomes the documented composition root** — a narrow `except` on the `components/ → features/` zone. Without it, HIVE-16's own stated file location (`src/components/layout/left-rail.tsx` importing `ProjectsPanel`) fails lint.
3. **Badge geometry stays shared.** The concept's tab badge is 15px/9.5px; the existing atom is 16px/10px. One `Badge` geometry with three tones beats a second near-identical atom — a deliberate 1px deviation, recorded in COMPONENTS.md.
4. **Prop name is `badgeCount`** (HIVE-16's wording) — `.claude/COMPONENTS.md:69` says `badge?` and gets corrected to match.

## File Structure

| File | Responsibility |
| --- | --- |
| `eslint.config.mjs` (modify) | Exempt `src/components/layout/**` from the `components/ → features/` zone |
| `scripts/verify-boundaries.mjs` (modify) | Move the violation probe out of `layout/`; add an inverse case proving the exemption |
| `AGENTS.md` (modify) | Import-zone table records the composition root |
| `.claude/COMPONENTS.md` (modify) | Document `TabBar`, `StatusDot`, `Badge`'s `muted` tone, the composition root, and `LeftRail` |
| `src/components/ui/badge.tsx` (modify) | Add the `muted` tone |
| `src/components/ui/tab-bar.tsx` (create) | Generic tablist atom |
| `src/components/ui/status-dot.tsx` (create) | Status-coloured dot with pulse |
| `src/features/projects/components/projects-panel.tsx` (create) | Stub, filled by 031 |
| `src/features/work/components/work-panel.tsx` (create) | Stub, filled by 032 |
| `src/features/agents/components/agents-panel.tsx` (create) | Stub, filled by 033 |
| `src/stores/hive-store.ts` (modify) | Add `useTicketCount()` selector for the Work tab badge |
| `src/components/layout/left-rail.tsx` (modify) | Container + tab bar + tab panel |
| `tests/components/ui/tab-bar.test.tsx` (create) | Generic, no Hive fixtures |
| `tests/components/ui/status-dot.test.tsx` (create) | Colour per status, pulse only for `working` |
| `tests/components/ui/badge.test.tsx` (modify) | `muted` tone |
| `tests/components/layout/left-rail.test.tsx` (create) | Tab switching, state preservation, scroll contract |
| `tests/components/layout/app-shell.test.tsx` (modify) | Scroll container moved inward |
| `tests/stores/hive-store.selectors.test.tsx` (modify) | `useTicketCount()` |

---

### Task 1: Promote `components/layout/` to the composition root

The `components/ → features/` zone currently makes HIVE-16's own file layout illegal. Narrow it to everything **except** `layout/`, and prove both halves still fire.

**Files:**
- Modify: `eslint.config.mjs:121-127`
- Modify: `scripts/verify-boundaries.mjs:36-44`
- Modify: `AGENTS.md:64-79`

**Interfaces:**
- Consumes: nothing.
- Produces: the ability for `src/components/layout/**` to import `@features/**`. Every later task depends on this.

- [ ] **Step 1: Make the boundary verifier assert the new contract (this is the failing test)**

In `scripts/verify-boundaries.mjs`, replace the case at lines 36-44 so the violation probe sits in `ui/` (still forbidden) rather than `layout/` (now allowed):

```js
  {
    name: 'zone: components/ may not import features/',
    rule: 'import/no-restricted-paths',
    files: {
      'src/features/work/probe-target.ts': 'export const work = 1;\n',
      'src/components/ui/probe.ts':
        "import { work } from '@features/work/probe-target';\nexport const probe = work;\n",
    },
  },
```

Then add this inverse case to the "Inverse cases — these must stay legal" block near line 128, immediately after the `ALLOWED: a slice may import features/shared` entry:

```js
  {
    name: 'ALLOWED: components/layout/ (the composition root) may import features/',
    rule: null,
    files: {
      'src/features/work/probe-target.ts': 'export const work = 1;\n',
      'src/components/layout/probe.ts':
        "import { work } from '@features/work/probe-target';\nexport const probe = work;\n",
    },
  },
```

- [ ] **Step 2: Run the verifier to watch the new case fail**

Run: `pnpm verify:boundaries`
Expected: FAIL — `ALLOWED: components/layout/ (the composition root) may import features/` reports `expected: (no error)` / `fired: import/no-restricted-paths`, and the script exits non-zero.

- [ ] **Step 3: Add the exemption to the zone**

In `eslint.config.mjs`, replace the zone at lines 121-127 with:

```js
            /**
             * Chrome and atoms stay domain-agnostic — with one exemption.
             *
             * `components/layout/` is THE COMPOSITION ROOT: the rails and the
             * center stage exist to mount feature panels, and every alternative
             * (slot props threaded from `app.tsx`, a `features/` slice importing
             * three sibling slices) either defeats the per-slice isolation zone
             * or pushes the whole app's wiring into one untestable module.
             *
             * The exemption is deliberately narrow. `components/ui/` (atoms) and
             * `components/terminal/` (THE SEAM) stay fully fenced, and
             * `scripts/verify-boundaries.mjs` proves both halves.
             */
            {
              target: './src/components/**/*',
              from: './src/features/**/*',
              except: [`${appRoot}/src/components/layout/**/*`],
              message:
                'Only components/layout/ (the composition root) may import features/. Atoms and the terminal stay domain-agnostic.',
            },
```

Note: `except` globs must be ABSOLUTE — see the comment at `eslint.config.mjs:47-52`. A relative pattern silently never matches.

- [ ] **Step 4: Run the verifier to confirm both halves fire**

Run: `pnpm verify:boundaries`
Expected: PASS on all cases, including both `zone: components/ may not import features/` (fires) and `ALLOWED: components/layout/ (the composition root) may import features/` (silent). Exit code 0.

- [ ] **Step 5: Record the zone change in AGENTS.md**

In the import-zone table at `AGENTS.md:66-74`, replace the `src/components/**` row with:

```markdown
| `src/components/**` (except `layout/`) | `src/features/**` |
```

And add this paragraph directly beneath the table, before the "Feature isolation is generated as..." paragraph:

```markdown
`src/components/layout/` is the **composition root** and is exempt from the
`features/` ban: the rails and the center stage exist to mount feature panels. The
exemption stops there — `components/ui/` and `components/terminal/` stay fully
fenced, and `pnpm verify:boundaries` proves both halves.
```

- [ ] **Step 6: Verify lint and types still pass**

Run: `pnpm lint && pnpm run type-check`
Expected: both silent, exit 0.

- [ ] **Step 7: Commit**

```bash
git add eslint.config.mjs scripts/verify-boundaries.mjs AGENTS.md
git commit -m "refactor(lint): make components/layout the documented composition root

The rails and center stage exist to mount feature panels, so the blanket
components/ -> features/ ban made story 030's own file layout illegal. Narrow
it to everything except layout/; ui/ and terminal/ stay fully fenced, and
verify-boundaries proves both halves."
```

---

### Task 2: Add the `muted` tone to `Badge`

The tab badge is chip-filled with muted text, unlike the existing solid `danger`/`brand` fills.

**Files:**
- Modify: `src/components/ui/badge.tsx:3-8`
- Test: `tests/components/ui/badge.test.tsx:53-61`

**Interfaces:**
- Consumes: nothing.
- Produces: `<Badge tone="muted" />` renders `bg-chip text-muted`. `TabBar` (Task 3) uses it.

- [ ] **Step 1: Write the failing test**

In `tests/components/ui/badge.test.tsx`, replace the `defaults to the danger fill and accepts the brand tone` test (lines 53-61) with:

```tsx
  it('defaults to the danger fill and accepts the other tones', () => {
    const { container, rerender } = render(
      <Badge count={1} label="unread notifications" />,
    );
    expect(container.firstChild).toHaveClass('bg-danger-solid');

    rerender(<Badge count={1} tone="brand" label="open pull requests" />);
    expect(container.firstChild).toHaveClass('bg-brand-fill');

    rerender(<Badge count={1} tone="muted" label="work items" />);
    expect(container.firstChild).toHaveClass('bg-chip', 'text-muted');
  });
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `pnpm exec vitest run tests/components/ui/badge.test.tsx`
Expected: FAIL — TypeScript rejects `tone="muted"`, or the class assertion fails.

- [ ] **Step 3: Add the tone**

In `src/components/ui/badge.tsx`, replace lines 3-8 with:

```tsx
type BadgeTone = 'danger' | 'brand' | 'muted';

const TONE_FILL: Record<BadgeTone, string> = {
  danger: 'bg-danger-solid text-on-brand',
  brand: 'bg-brand-fill text-on-brand',
  // The tab-bar count: a quiet chip, not an alert. Story 030.
  muted: 'bg-chip text-muted',
};
```

- [ ] **Step 4: Run the tests**

Run: `pnpm exec vitest run tests/components/ui/badge.test.tsx`
Expected: PASS, 8 tests.

- [ ] **Step 5: Commit**

```bash
git add src/components/ui/badge.tsx tests/components/ui/badge.test.tsx
git commit -m "feat(ui): add a muted tone to Badge for tab-bar counts"
```

---

### Task 3: Build the `TabBar` atom

Generic by contract: if a `TabBar` test needs to know what "Projects" means, the atom has leaked domain knowledge.

**Files:**
- Create: `src/components/ui/tab-bar.tsx`
- Test: `tests/components/ui/tab-bar.test.tsx`

**Interfaces:**
- Consumes: `Badge` with `tone="muted"` (Task 2).
- Produces:
  ```ts
  export interface Tab { id: string; label: string; badgeCount?: number }
  export function TabBar(props: {
    tabs: Tab[];
    active: string;
    onSelect: (id: string) => void;
    label: string;
    className?: string;
  }): JSX.Element
  ```
  Each tab button carries `role="tab"`, `aria-selected`, and `id={`tab-${tab.id}`}` — `LeftRail` (Task 7) points its tab panel at that id with `aria-labelledby`. Story 050 reuses this atom for the activity rail.

- [ ] **Step 1: Write the failing test**

Create `tests/components/ui/tab-bar.test.tsx`:

```tsx
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { TabBar } from '@components/ui/tab-bar';

/**
 * Deliberately non-Hive fixtures. `TabBar` is reused by the left rail (030) and
 * the activity rail (050); if a test here needed to know what "Projects" is,
 * the atom would have leaked domain knowledge.
 */
const TABS = [
  { id: 'alpha', label: 'Alpha' },
  { id: 'beta', label: 'Beta', badgeCount: 4 },
  { id: 'gamma', label: 'Gamma', badgeCount: 0 },
];

describe('TabBar', () => {
  it('renders one tab per item, in order', () => {
    render(
      <TabBar tabs={TABS} active="alpha" onSelect={vi.fn()} label="Sections" />,
    );

    expect(screen.getAllByRole('tab').map((tab) => tab.textContent)).toEqual([
      'Alpha',
      'Beta4',
      'Gamma',
    ]);
  });

  it('marks exactly the active tab as selected', () => {
    render(
      <TabBar tabs={TABS} active="beta" onSelect={vi.fn()} label="Sections" />,
    );

    expect(screen.getByRole('tab', { name: /Beta/ })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    expect(screen.getByRole('tab', { name: 'Alpha' })).toHaveAttribute(
      'aria-selected',
      'false',
    );
  });

  it('fires onSelect with the tab id', async () => {
    const onSelect = vi.fn();
    render(
      <TabBar tabs={TABS} active="alpha" onSelect={onSelect} label="Sections" />,
    );

    await userEvent.click(screen.getByRole('tab', { name: 'Gamma' }));

    expect(onSelect).toHaveBeenCalledExactlyOnceWith('gamma');
  });

  it('shows a badge only for a positive count', () => {
    render(
      <TabBar tabs={TABS} active="alpha" onSelect={vi.fn()} label="Sections" />,
    );

    expect(screen.getByText('4')).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Gamma' })).toHaveTextContent(
      /^Gamma$/,
    );
  });

  it('names the tablist for screen readers', () => {
    render(
      <TabBar tabs={TABS} active="alpha" onSelect={vi.fn()} label="Sections" />,
    );

    expect(screen.getByRole('tablist', { name: 'Sections' })).toBeInTheDocument();
  });

  it('gives each tab a stable id so a panel can point back at it', () => {
    render(
      <TabBar tabs={TABS} active="alpha" onSelect={vi.fn()} label="Sections" />,
    );

    expect(screen.getByRole('tab', { name: 'Alpha' })).toHaveAttribute(
      'id',
      'tab-alpha',
    );
  });

  it('underlines the active tab and greys the rest', () => {
    render(
      <TabBar tabs={TABS} active="alpha" onSelect={vi.fn()} label="Sections" />,
    );

    expect(screen.getByRole('tab', { name: 'Alpha' })).toHaveClass(
      'border-brand',
      'text-ink',
    );
    expect(screen.getByRole('tab', { name: /Beta/ })).toHaveClass(
      'border-transparent',
      'text-subtle',
    );
  });
});
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `pnpm exec vitest run tests/components/ui/tab-bar.test.tsx`
Expected: FAIL — `Failed to resolve import "@components/ui/tab-bar"`.

- [ ] **Step 3: Write the implementation**

Create `src/components/ui/tab-bar.tsx`:

```tsx
import { Badge } from '@components/ui/badge';
import { cn } from '@/lib/utils';

export interface Tab {
  id: string;
  label: string;
  /** Rendered as a muted chip. Omitted or zero renders no badge at all. */
  badgeCount?: number;
}

interface TabBarProps {
  tabs: Tab[];
  active: string;
  onSelect: (id: string) => void;
  /** Names the tablist for screen readers — e.g. `'Rail sections'`. */
  label: string;
  className?: string;
}

/**
 * The rails' tab bar — left rail (030) and activity rail (050).
 *
 * Domain-agnostic by contract: it takes `{ id, label, badgeCount }` and hands
 * back an id. It knows nothing about projects, tickets, or notifications, which
 * is what lets both rails share it.
 *
 * `-mb-px` pulls each tab's 2px underline over the container's 1px bottom
 * border, so the active indicator sits *on* the rule rather than below it.
 */
export function TabBar({
  tabs,
  active,
  onSelect,
  label,
  className,
}: TabBarProps) {
  return (
    <div
      role="tablist"
      aria-label={label}
      className={cn('flex gap-0.5 border-b border-border-soft', className)}
    >
      {tabs.map((tab) => {
        const selected = tab.id === active;

        return (
          <button
            key={tab.id}
            type="button"
            role="tab"
            id={`tab-${tab.id}`}
            aria-selected={selected}
            onClick={() => onSelect(tab.id)}
            className={cn(
              '-mb-px flex items-center gap-1.5 border-b-2 px-2.5 pt-1.5 pb-[9px] text-[11px] font-semibold uppercase tracking-[0.08em]',
              selected
                ? 'border-brand text-ink'
                : 'border-transparent text-subtle hover:text-ink',
            )}
          >
            {tab.label}
            {/* No label: the count sits inside an already-named control. */}
            <Badge count={tab.badgeCount ?? 0} tone="muted" />
          </button>
        );
      })}
    </div>
  );
}
```

- [ ] **Step 4: Run the tests**

Run: `pnpm exec vitest run tests/components/ui/tab-bar.test.tsx`
Expected: PASS, 7 tests.

- [ ] **Step 5: Verify lint and types**

Run: `pnpm lint && pnpm run type-check`
Expected: both silent.

- [ ] **Step 6: Commit**

```bash
git add src/components/ui/tab-bar.tsx tests/components/ui/tab-bar.test.tsx
git commit -m "feat(ui): add the generic TabBar atom

Takes { id, label, badgeCount } and returns an id — no rail-specific logic,
so 030 and 050 share one implementation."
```

---

### Task 4: Build the `StatusDot` atom

**Files:**
- Create: `src/components/ui/status-dot.tsx`
- Test: `tests/components/ui/status-dot.test.tsx`

**Interfaces:**
- Consumes: `SessionStatus` from `@/types/entity`.
- Produces:
  ```ts
  export type DotStatus = SessionStatus | 'online';
  export const STATUS_LABEL: Record<DotStatus, string>;
  export function StatusDot(props: {
    status: DotStatus;
    pulse?: boolean;
    label?: string;
    className?: string;
  }): JSX.Element
  ```
  `STATUS_LABEL` maps `waiting → 'needs input'`; stories 031 and 032 import it for their visible status labels rather than re-deriving it.

- [ ] **Step 1: Write the failing test**

Create `tests/components/ui/status-dot.test.tsx`:

```tsx
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { STATUS_LABEL, StatusDot } from '@components/ui/status-dot';

describe('StatusDot', () => {
  it.each([
    ['working', 'bg-green'],
    ['waiting', 'bg-amber'],
    ['idle', 'bg-subtle'],
    ['done', 'bg-brand'],
    ['online', 'bg-green'],
  ] as const)('paints %s with %s', (status, expected) => {
    const { container } = render(<StatusDot status={status} />);

    expect(container.firstChild).toHaveClass(expected);
  });

  it('pulses only for working', () => {
    const { container, rerender } = render(<StatusDot status="working" />);
    expect(container.firstChild).toHaveClass('animate-ccpulse');

    for (const status of ['waiting', 'idle', 'done', 'online'] as const) {
      rerender(<StatusDot status={status} />);
      expect(container.firstChild).not.toHaveClass('animate-ccpulse');
    }
  });

  it('lets a caller force the pulse off for a working session', () => {
    const { container } = render(<StatusDot status="working" pulse={false} />);

    expect(container.firstChild).not.toHaveClass('animate-ccpulse');
  });

  it('is a 7px circle', () => {
    const { container } = render(<StatusDot status="idle" />);

    expect(container.firstChild).toHaveClass(
      'size-[7px]',
      'rounded-full',
      'shrink-0',
    );
  });

  /**
   * Same contract as `Badge`: with a label the dot joins the accessibility
   * tree, without one it is decoration. Story 031 pairs it with a visible
   * status label and omits it; story 032 has no visible label and passes one,
   * so status is never carried by colour alone.
   */
  it('is decoration when no label is given', () => {
    const { container } = render(<StatusDot status="working" />);

    expect(container.firstChild).toHaveAttribute('aria-hidden', 'true');
  });

  it('announces its status once a label is given', () => {
    const { container } = render(
      <StatusDot status="waiting" label="lead-form status" />,
    );

    expect(container.firstChild).not.toHaveAttribute('aria-hidden');
    expect(
      screen.getByText('lead-form status: needs input'),
    ).toBeInTheDocument();
  });

  it('names waiting "needs input"', () => {
    expect(STATUS_LABEL.waiting).toBe('needs input');
    expect(STATUS_LABEL.working).toBe('working');
    expect(STATUS_LABEL.idle).toBe('idle');
    expect(STATUS_LABEL.done).toBe('done');
    expect(STATUS_LABEL.online).toBe('online');
  });
});
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `pnpm exec vitest run tests/components/ui/status-dot.test.tsx`
Expected: FAIL — `Failed to resolve import "@components/ui/status-dot"`.

- [ ] **Step 3: Write the implementation**

Create `src/components/ui/status-dot.tsx`:

```tsx
import { cn } from '@/lib/utils';
import type { SessionStatus } from '@/types/entity';

/** Sessions have four states; agents are always `online`. */
export type DotStatus = SessionStatus | 'online';

const STATUS_FILL: Record<DotStatus, string> = {
  working: 'bg-green',
  waiting: 'bg-amber',
  idle: 'bg-subtle',
  done: 'bg-brand',
  online: 'bg-green',
};

/**
 * The words that go with the colours.
 *
 * Exported because status is never carried by colour alone: the projects panel
 * (031) and the orchestrator table (041) render these as visible labels, and
 * re-deriving the `waiting → "needs input"` rename in three places is how the
 * three drift apart.
 */
export const STATUS_LABEL: Record<DotStatus, string> = {
  working: 'working',
  waiting: 'needs input',
  idle: 'idle',
  done: 'done',
  online: 'online',
};

interface StatusDotProps {
  status: DotStatus;
  /** Defaults to pulsing only while `working`. Pass `false` to force it off. */
  pulse?: boolean;
  /**
   * What the dot describes — e.g. `'lead-form status'`. Produces
   * `"lead-form status: needs input"` for screen readers.
   *
   * **Omit it when a visible status label sits beside the dot**, which is the
   * common case; the dot is then decoration and is hidden from the
   * accessibility tree rather than duplicating the text next to it.
   */
  label?: string;
  className?: string;
}

/**
 * A 7px status dot. The pulse is `animate-ccpulse` from `global.css` — never a
 * hand-written keyframe, so one definition drives every pulsing surface.
 */
export function StatusDot({
  status,
  pulse,
  label,
  className,
}: StatusDotProps) {
  const pulsing = pulse ?? status === 'working';

  return (
    <span
      aria-hidden={label ? undefined : 'true'}
      className={cn(
        'inline-flex size-[7px] shrink-0 rounded-full',
        STATUS_FILL[status],
        pulsing && 'animate-ccpulse',
        className,
      )}
    >
      {label ? (
        <span className="sr-only">{`${label}: ${STATUS_LABEL[status]}`}</span>
      ) : null}
    </span>
  );
}
```

- [ ] **Step 4: Run the tests**

Run: `pnpm exec vitest run tests/components/ui/status-dot.test.tsx`
Expected: PASS, 11 tests (the `it.each` contributes 5).

- [ ] **Step 5: Verify lint and types**

Run: `pnpm lint && pnpm run type-check`
Expected: both silent.

- [ ] **Step 6: Commit**

```bash
git add src/components/ui/status-dot.tsx tests/components/ui/status-dot.test.tsx
git commit -m "feat(ui): add the StatusDot atom

Colour per status with animate-ccpulse for working only, and STATUS_LABEL
exported so 031/032/041 share one waiting -> 'needs input' rename."
```

---

### Task 5: Add the `useTicketCount()` selector

The Work tab's badge is the ticket count. The concept uses `workVm.length` (`concept/Command Center.dc.html:753`), i.e. every ticket, not just open ones.

**Files:**
- Modify: `src/stores/hive-store.ts` (append after `useTicketPrs`, around line 305)
- Test: `tests/stores/hive-store.selectors.test.tsx`

**Interfaces:**
- Consumes: nothing.
- Produces: `export const useTicketCount: () => number`. `LeftRail` (Task 7) uses it.

- [ ] **Step 1: Write the failing test**

Append to `tests/stores/hive-store.selectors.test.tsx` (inside the top-level `describe`, matching the file's existing `renderHook` style):

```tsx
  describe('useTicketCount', () => {
    it('counts every fixture ticket, open or not', () => {
      const { result } = renderHook(() => useTicketCount());

      expect(result.current).toBe(8);
    });

    it('follows the store rather than caching a number', () => {
      const { result } = renderHook(() => useTicketCount());

      act(() => {
        useHiveStore.setState({ tickets: [] });
      });

      expect(result.current).toBe(0);
    });
  });
```

Add `useTicketCount` to the file's existing `@stores/hive-store` import, and make sure `act` and `renderHook` are imported from `@testing-library/react` (they already are if the file uses them; add whichever is missing).

- [ ] **Step 2: Run it to make sure it fails**

Run: `pnpm exec vitest run tests/stores/hive-store.selectors.test.tsx`
Expected: FAIL — `useTicketCount is not a function` / no exported member.

- [ ] **Step 3: Add the selector**

In `src/stores/hive-store.ts`, immediately after the `useTicketPrs` export (ends around line 305), add:

```ts
/**
 * How many work items exist — the left rail's Work tab badge (story 030).
 *
 * Counts every ticket, including Done ones, matching the concept. The badge
 * answers "how much work is tracked here", not "how much is outstanding".
 */
export const useTicketCount = () =>
  useHiveStore((state) => state.tickets.length);
```

- [ ] **Step 4: Run the tests**

Run: `pnpm exec vitest run tests/stores/hive-store.selectors.test.tsx`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/stores/hive-store.ts tests/stores/hive-store.selectors.test.tsx
git commit -m "feat(store): add useTicketCount for the Work tab badge"
```

---

### Task 6: Create the three panel stubs

Stories 031/032/033 fill these in. Each keeps its `data-panel` marker so the rail's tests keep working as the panels grow real content.

**Files:**
- Create: `src/features/projects/components/projects-panel.tsx`
- Create: `src/features/work/components/work-panel.tsx`
- Create: `src/features/agents/components/agents-panel.tsx`
- Delete: `src/features/projects/.gitkeep`, `src/features/work/.gitkeep`, `src/features/agents/.gitkeep`

**Interfaces:**
- Consumes: nothing.
- Produces: `ProjectsPanel`, `WorkPanel`, `AgentsPanel` — all `(): JSX.Element`, no props. `LeftRail` (Task 7) mounts exactly one.

- [ ] **Step 1: Create the projects panel stub**

Create `src/features/projects/components/projects-panel.tsx`:

```tsx
/**
 * Projects panel — a collapsible tree of projects and their live sessions.
 *
 * Placeholder until story 031 builds the project and session rows. The
 * `data-panel` marker is the rail's test hook for "which panel is mounted", and
 * survives into 031.
 */
export function ProjectsPanel() {
  return <div data-panel="projects" className="flex flex-col gap-0.5" />;
}
```

- [ ] **Step 2: Create the work panel stub**

Create `src/features/work/components/work-panel.tsx`:

```tsx
/**
 * Work panel — one card per ticket, with its sessions and PRs.
 *
 * Placeholder until story 032 builds the ticket cards.
 */
export function WorkPanel() {
  return <div data-panel="work" className="flex flex-col gap-2.5" />;
}
```

- [ ] **Step 3: Create the agents panel stub**

Create `src/features/agents/components/agents-panel.tsx`:

```tsx
/**
 * Agents panel — the long-lived background agents and their status.
 *
 * Placeholder until story 033 builds the agent rows.
 */
export function AgentsPanel() {
  return <div data-panel="agents" className="flex flex-col gap-0.5" />;
}
```

- [ ] **Step 4: Drop the now-redundant .gitkeep files**

```bash
git rm -q src/features/projects/.gitkeep src/features/work/.gitkeep src/features/agents/.gitkeep
```

- [ ] **Step 5: Verify lint and types**

Run: `pnpm lint && pnpm run type-check`
Expected: both silent. (These files are unreferenced so far, which is fine — Task 7 wires them.)

- [ ] **Step 6: Commit**

```bash
git add src/features/projects src/features/work src/features/agents
git commit -m "feat(features): scaffold the three left-rail panels

Stubs with a data-panel marker; 031/032/033 fill them in."
```

---

### Task 7: Wire up the `LeftRail` container

**Files:**
- Modify: `src/components/layout/left-rail.tsx` (whole file)
- Test: `tests/components/layout/left-rail.test.tsx` (create)
- Modify: `tests/components/layout/app-shell.test.tsx:70-79`

**Interfaces:**
- Consumes: `TabBar`/`Tab` (Task 3), `useTicketCount` (Task 5), the three panels (Task 6), and `useLeftTab` / `useSetLeftTab` from `@stores/ui-store` (already exist at `src/stores/ui-store.ts:164-165`).
- Produces: a `LeftRail` that still renders `<nav aria-label="Projects, work, and agents">`, so `app-shell.test.tsx` keeps addressing it by role.

- [ ] **Step 1: Write the failing test**

Create `tests/components/layout/left-rail.test.tsx`:

```tsx
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it } from 'vitest';

import { LeftRail } from '@components/layout/left-rail';
import { useHiveStore } from '@stores/hive-store';
import { useUiStore } from '@stores/ui-store';

const panel = (container: HTMLElement, name: string) =>
  container.querySelector(`[data-panel="${name}"]`);

describe('LeftRail', () => {
  beforeEach(() => {
    useUiStore.getState().reset();
    useHiveStore.getState().reset();
  });

  it('opens on the projects panel', () => {
    const { container } = render(<LeftRail />);

    expect(panel(container, 'projects')).toBeInTheDocument();
    expect(panel(container, 'work')).not.toBeInTheDocument();
    expect(panel(container, 'agents')).not.toBeInTheDocument();
  });

  it('renders the three tabs with the ticket count on Work', () => {
    render(<LeftRail />);

    expect(screen.getAllByRole('tab').map((tab) => tab.textContent)).toEqual([
      'Projects',
      'Work8',
      'Agents',
    ]);
  });

  it('swaps the panel when a tab is clicked', async () => {
    const { container } = render(<LeftRail />);

    await userEvent.click(screen.getByRole('tab', { name: /Work/ }));
    expect(panel(container, 'work')).toBeInTheDocument();
    expect(panel(container, 'projects')).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole('tab', { name: 'Agents' }));
    expect(panel(container, 'agents')).toBeInTheDocument();
    expect(panel(container, 'work')).not.toBeInTheDocument();
  });

  it('writes the active tab to the store, not to component state', async () => {
    render(<LeftRail />);

    await userEvent.click(screen.getByRole('tab', { name: 'Agents' }));

    expect(useUiStore.getState().leftTab).toBe('agents');
  });

  /**
   * The AC that matters: a project collapsed in the projects panel must still
   * be collapsed after a round trip through Agents. That only holds because
   * `collapsed` lives in the store rather than in a panel's `useState`.
   */
  it('preserves each panel’s state across tab switches', async () => {
    render(<LeftRail />);

    useUiStore.getState().toggleProject('apfm-web');
    expect(useUiStore.getState().collapsed['apfm-web']).toBe(true);

    await userEvent.click(screen.getByRole('tab', { name: 'Agents' }));
    await userEvent.click(screen.getByRole('tab', { name: 'Projects' }));

    expect(useUiStore.getState().collapsed['apfm-web']).toBe(true);
  });

  it('points the tab panel at the tab that names it', async () => {
    render(<LeftRail />);

    expect(screen.getByRole('tabpanel')).toHaveAttribute(
      'aria-labelledby',
      'tab-projects',
    );

    await userEvent.click(screen.getByRole('tab', { name: /Work/ }));
    expect(screen.getByRole('tabpanel')).toHaveAttribute(
      'aria-labelledby',
      'tab-work',
    );
  });

  /**
   * The tab bar is the first flex child and does not scroll; the panel below it
   * owns the scrollbar. happy-dom does no layout, so assert the contract on the
   * class list.
   */
  it('scrolls the panel, not the tab bar', () => {
    render(<LeftRail />);

    expect(screen.getByRole('tablist')).toHaveClass('shrink-0');
    expect(screen.getByRole('tabpanel')).toHaveClass(
      'min-h-0',
      'flex-1',
      'overflow-y-auto',
    );
    expect(
      screen.getByRole('navigation', { name: 'Projects, work, and agents' }),
    ).not.toHaveClass('overflow-y-auto');
  });

  it('keeps the rail at its fixed 268px', () => {
    render(<LeftRail />);

    expect(
      screen.getByRole('navigation', { name: 'Projects, work, and agents' }),
    ).toHaveClass('w-[268px]', 'shrink-0');
  });
});
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `pnpm exec vitest run tests/components/layout/left-rail.test.tsx`
Expected: FAIL — no tabs render; the current `LeftRail` is an empty `<nav>`.

- [ ] **Step 3: Write the implementation**

Replace the whole of `src/components/layout/left-rail.tsx` with:

```tsx
import { AgentsPanel } from '@features/agents/components/agents-panel';
import { ProjectsPanel } from '@features/projects/components/projects-panel';
import { WorkPanel } from '@features/work/components/work-panel';

import { TabBar, type Tab } from '@components/ui/tab-bar';
import { useTicketCount } from '@stores/hive-store';
import { useLeftTab, useSetLeftTab, type LeftTab } from '@stores/ui-store';

/**
 * Left rail — three views of the same fleet: by project, by work item, by agent.
 *
 * 268px fixed: the rails never flex, so the center stage absorbs every width
 * change and the terminal is the only thing that resizes with the window.
 *
 * The tab bar is the first flex child and stays put; the panel below it owns the
 * scrollbar. Scrolling the whole rail instead would push the tabs off-screen the
 * moment a project tree grew, which is the one control the user needs to get
 * back out of it.
 *
 * This file is part of `components/layout/`, the composition root — the one
 * place chrome is allowed to import feature slices (see AGENTS.md → Import
 * zones). Panel state lives in the stores, never in the panels, so switching
 * tabs unmounts a panel without losing what the user did in it.
 */
const PANELS: Record<LeftTab, () => React.JSX.Element> = {
  projects: ProjectsPanel,
  work: WorkPanel,
  agents: AgentsPanel,
};

export function LeftRail() {
  const leftTab = useLeftTab();
  const setLeftTab = useSetLeftTab();
  const ticketCount = useTicketCount();

  const tabs: Tab[] = [
    { id: 'projects', label: 'Projects' },
    { id: 'work', label: 'Work', badgeCount: ticketCount },
    { id: 'agents', label: 'Agents' },
  ];

  const Panel = PANELS[leftTab];

  return (
    <nav
      aria-label="Projects, work, and agents"
      className="flex w-[268px] shrink-0 flex-col gap-[18px] border-r border-border-soft bg-panel px-2.5 pt-3.5 pb-5"
    >
      <TabBar
        tabs={tabs}
        active={leftTab}
        onSelect={(id) => setLeftTab(id as LeftTab)}
        label="Rail sections"
        className="shrink-0"
      />

      <div
        role="tabpanel"
        aria-labelledby={`tab-${leftTab}`}
        className="min-h-0 flex-1 overflow-y-auto"
      >
        <Panel />
      </div>
    </nav>
  );
}
```

- [ ] **Step 4: Run the tests**

Run: `pnpm exec vitest run tests/components/layout/left-rail.test.tsx`
Expected: PASS, 8 tests.

- [ ] **Step 5: Update the app-shell scroll assertion**

The left rail no longer scrolls as a whole. In `tests/components/layout/app-shell.test.tsx`, replace the test at lines 70-79 with:

```tsx
  it('gives each rail its own scrollbar rather than scrolling the page', () => {
    render(<AppShell />);

    // The left rail delegates scrolling to its tab panel (story 030) so the
    // tab bar stays visible; the activity rail still scrolls as a whole until
    // story 050 does the same.
    expect(screen.getByRole('tabpanel')).toHaveClass('overflow-y-auto');
    expect(screen.getByRole('complementary', { name: 'Activity' })).toHaveClass(
      'overflow-y-auto',
    );
  });
```

- [ ] **Step 6: Run the full suite**

Run: `pnpm test`
Expected: PASS, all files. If `app-shell.test.tsx`'s `pins the rails to a fixed width` test fails, the rail lost its `w-[268px] shrink-0` classes — restore them.

- [ ] **Step 7: Verify lint, types, boundaries, and coverage**

Run: `pnpm lint && pnpm run type-check && pnpm verify:boundaries && pnpm test:coverage`
Expected: all four green; coverage at or above 80% on all metrics.

- [ ] **Step 8: Commit**

```bash
git add src/components/layout/left-rail.tsx tests/components/layout/left-rail.test.tsx tests/components/layout/app-shell.test.tsx
git commit -m "feat(rail): left rail container with a pinned tab bar

Tab bar stays put while the panel below it scrolls, so the tabs never leave
the viewport. leftTab lives in the ui-store, so a collapsed project survives
a round trip through Agents."
```

---

### Task 8: Document the new components

**Files:**
- Modify: `.claude/COMPONENTS.md:60-93` (Hive atoms) and `:153-165` (Region placeholders)

**Interfaces:**
- Consumes: everything built above.
- Produces: nothing code-facing.

- [ ] **Step 1: Update the atoms table**

In `.claude/COMPONENTS.md`, replace the atom table rows for `TabBar` and `StatusDot` (lines 69-70) with:

```markdown
| `TabBar` | `ui/tab-bar.tsx` | 030 (reused by 050) | `tabs: { id: string; label: string; badgeCount?: number }[]`, `active: string`, `onSelect(id: string): void`, `label: string`, `className?: string` | **built** |
| `StatusDot` | `ui/status-dot.tsx` | 030 (used by 031, 032, 041) | `status: SessionStatus \| 'online'`, `pulse?: boolean`, `label?: string`, `className?: string` | **built** |
```

- [ ] **Step 2: Update the `Badge` row for the new tone**

Replace the `Badge` row (line 68) with:

```markdown
| `Badge` | `ui/badge.tsx` | **021** (also 030, 050, 052) | `count: number`, `tone?: 'danger' \| 'brand' \| 'muted'`, `label?: string`, `className?: string` | **built** |
```

- [ ] **Step 3: Add the contracts worth knowing**

In the "Two contracts worth knowing before reusing them" list (lines 85-93), change the lead-in to "Contracts worth knowing before reusing them:" and append:

```markdown
- **`StatusDot` follows `Badge`'s label contract.** With a `label` it announces
  `"lead-form status: needs input"`; without one it is `aria-hidden` decoration.
  Omit it wherever a visible status label already sits beside the dot (031),
  pass it where none does (032) — status is never carried by colour alone.
- **`StatusDot` derives its pulse from its status**, so only `working` pulses.
  `pulse={false}` is an override for the rare caller that needs a still dot.
- **`TabBar`'s badge reuses `Badge` at `Badge`'s geometry**, not the concept's
  15px/9.5px. One badge geometry with three tones beats a second near-identical
  atom; the 1px difference is deliberate.
- **`STATUS_LABEL` is exported from `ui/status-dot.tsx`.** It owns the
  `waiting → "needs input"` rename. Import it rather than re-deriving it.
```

- [ ] **Step 4: Document the composition root and the built rail**

Replace the "Region placeholders" section (lines 153-165) with:

```markdown
### `<LeftRail />`

`src/components/layout/left-rail.tsx` — story 030, built.

268px fixed. A flex column of two children: a pinned `<TabBar />` and a scrolling
tab panel that mounts exactly one of `ProjectsPanel` (031), `WorkPanel` (032), or
`AgentsPanel` (033). Reads `useLeftTab()` / `useSetLeftTab()` and `useTicketCount()`
for the Work tab's badge.

**The tab bar does not scroll — the panel below it does.** Scrolling the rail as a
whole would push the tabs off-screen as soon as a project tree grew, taking away
the one control the user needs to get back out.

Panel state lives in the stores, never in the panels: `collapsed` in the ui-store
is why a collapsed project survives a round trip through the Agents tab even
though the panel unmounts.

### `components/layout/` is the composition root

It is the one place under `src/components/` allowed to import `src/features/**` —
the rails and the center stage exist to mount feature panels. `components/ui/` and
`components/terminal/` stay fully fenced. See AGENTS.md → Import zones;
`pnpm verify:boundaries` proves both halves.

### Region placeholders

Still bare panels, owned by the story that fills each in.

| Region | File | Filled in by |
| --- | --- | --- |
| `CenterStage` | `layout/center-stage.tsx` | 040 — view-state machine, session meta bar |
| `ActivityRail` | `layout/activity-rail.tsx` | 050 — tab bar, inbox/PRs/feed panels |

`CenterStage` mounts `<TerminalSurface />` on purpose, so the shell's `min-w-0`
shrink contract is proven against a real xterm instance rather than an empty box.

Still unbuilt: `session-meta-bar` (040), `KeyHint` (041).
```

- [ ] **Step 5: Verify the docs test still passes**

Run: `pnpm exec vitest run tests/design-system.test.ts`
Expected: PASS — no tokens changed, so the doc/token diff is unaffected.

- [ ] **Step 6: Commit**

```bash
git add .claude/COMPONENTS.md
git commit -m "docs: document TabBar, StatusDot, and the composition root"
```

---

### Task 9: Verify in a real browser, then open the draft PR

Green unit tests do not prove a rail renders. Drive the built UI before opening the PR.

**Files:** none.

- [ ] **Step 1: Run the full gate**

Run: `pnpm lint && pnpm run type-check && pnpm verify:boundaries && pnpm test:coverage && pnpm build`
Expected: all green, coverage ≥80% on all four metrics.

- [ ] **Step 2: Drive the built UI in a browser**

Start the dev server (`pnpm dev`), open the app, and confirm by eye:
- The rail is 268px with the three uppercase tabs across the top and the Work tab showing a muted `8` badge.
- Clicking each tab moves the underline and the `--cc-ink` text colour to it.
- The tab bar stays fixed at the top; nothing yet scrolls beneath it (panels are stubs).
- Toggling the theme repaints the rail — no hardcoded colour survives the flip.

Capture a screenshot for the PR body.

- [ ] **Step 3: Push and open the draft PR**

```bash
git push -u origin HEAD
gh pr create --draft --title "feat(rail): left rail container and tab bar (HIVE-16)" --body-file - <<'EOF'
...
EOF
```

The PR body must list the four agreed deviations from the ticket (see "Deviations from the ticket" above) so the reviewer sees them without opening Jira.

- [ ] **Step 4: Hand off to `ship`**

The `workstream:ship` skill drives the draft to merge: self review → mark ready (the CI trigger) → CI watch → findings triage → merge.
