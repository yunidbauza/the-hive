# Retire fixtures where real data exists — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop seeding invented projects and sessions on the desktop, where config and the pty-host now supply both, without blanking panels whose data source does not exist yet.

**Architecture:** `src/data/fixtures.ts` is renamed to `src/data/demo-data.ts` and keeps only the sections nothing can produce yet — agents, tickets, PRs, notifications, feed, orchestrator lines. `createInitialState` takes an injected `desktop` flag: on the desktop it returns no sessions, no order and no projects; in the browser it returns the full dataset unchanged, because the browser build *is* the demo (`config/runtime.ts` states this outright) and emptying it would destroy the concept surface for no gain.

**Tech Stack:** TypeScript, React 19, Zustand, Vitest, Testing Library, Playwright.

**Spec:** [`../specs/2026-08-04-109-retire-fixtures-design.md`](../specs/2026-08-04-109-retire-fixtures-design.md)

## Global Constraints

- All commands run from `app/`. Unit tests: `pnpm vitest run <path>`. Type check: `pnpm type-check`. Lint: `pnpm lint`. Boundaries: `pnpm verify:boundaries`. E2E: `pnpm test:e2e:electron`.
- **The import zone is directory-scoped, not filename-scoped.** `eslint.config.mjs:199-210` restricts `./src/data/**/*` to `stores/` only. Renaming a file inside `src/data/` needs no rule change — only the message wording. Do not weaken the rule.
- **The browser build must degrade visibly** (`config/runtime.ts`). It is a demo surface, and its dataset stays whole.
- `createInitialState` is a **factory, not a frozen object** (`fixtures.ts:296-299`): every test starts from a clean copy so one test's mutation cannot leak into the next. Keep it a factory.
- `app/tests/e2e/electron/fixtures/` is **Playwright's own fixtures directory**. It is unrelated to this work and must not be touched.
- Retired sections are deleted, not commented out. A commented-out dataset is a merge conflict waiting to happen.

---

### Task 1: Rename the module and update every reference

**Files:**
- Rename: `app/src/data/fixtures.ts` → `app/src/data/demo-data.ts`
- Rename: `app/tests/data/fixtures.test.ts` → `app/tests/data/demo-data.test.ts`
- Modify: `app/src/stores/hive-store.ts:5`
- Modify: `app/src/components/ui/icon.tsx:36`, `app/src/types/entity.ts:45-52` (prose only)
- Modify: `app/eslint.config.mjs:209` (message wording only)

**Interfaces:**
- Consumes: nothing.
- Produces: `createInitialState()` and `InitialState` importable from `@/data/demo-data`. Signature unchanged in this task.

- [ ] **Step 1: Rename with git so history follows**

```bash
git mv app/src/data/fixtures.ts app/src/data/demo-data.ts
git mv app/tests/data/fixtures.test.ts app/tests/data/demo-data.test.ts
```

- [ ] **Step 2: Run the type check to enumerate every broken import**

Run: `pnpm type-check`
Expected: FAIL, listing each unresolved `@/data/fixtures`. That list is the work for this task — do not guess at it.

- [ ] **Step 3: Update the imports**

In `hive-store.ts:5` and `demo-data.test.ts:3`:

```ts
import { createInitialState } from '@/data/demo-data';
```

- [ ] **Step 4: Update the module's own header**

Replace the doc comment at the top of `demo-data.ts`:

```ts
/**
 * The demo dataset, ported verbatim from `concept/Command Center.dc.html`.
 *
 * **Renamed from `fixtures.ts` in story 109.** "Fixtures" read as test
 * scaffolding somebody forgot to delete, which is exactly the confusion that
 * story was filed to end: the desktop now maps real repositories and spawns
 * real sessions, and a panel showing both could not be used to judge whether a
 * feature worked.
 *
 * What remains is what nothing can produce yet — agents, tickets, PRs,
 * notifications, the feed and the orchestrator transcript. It is well-tuned,
 * and the browser build still renders all of it: that build *is* the demo
 * (`config/runtime.ts`), so emptying it would cost the concept surface and buy
 * nothing, because there is nothing real in a browser to confuse it with.
 *
 * Nothing outside `src/stores/` may import this module — enforced by an import
 * zone (story 014), not by review.
 */
```

- [ ] **Step 5: Update the two prose references and the lint message**

`icon.tsx:36` — change `src/data/fixtures.ts` to `src/data/demo-data.ts`.

`entity.ts:45-52` — the block referring to "fixture projects"; change the filename reference to `demo-data.ts`. Leave the reasoning intact, it is still correct.

`eslint.config.mjs:209`:

```js
              message:
                'Only stores/ may import data/. Read demo-derived state through a selector hook.',
```

- [ ] **Step 6: Verify**

Run: `pnpm type-check && pnpm lint && pnpm verify:boundaries && pnpm vitest run`
Expected: all PASS. This task is a pure rename — a behaviour change here means something was edited that should not have been.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "refactor(data): rename fixtures to demo-data"
```

---

### Task 2: Split the dataset by runtime

**Files:**
- Modify: `app/src/data/demo-data.ts` (`createInitialState:300`)
- Modify: `app/src/stores/hive-store.ts` (the `createInitialState()` call site)
- Test: `app/tests/data/demo-data.test.ts`

**Interfaces:**
- Consumes: `isDesktop()` from `@config/runtime`.
- Produces: `createInitialState(desktop?: boolean): InitialState`. The parameter is injected — defaulting to `isDesktop()` — so both branches are testable without a fake bridge. `InitialState` keeps all nine fields; the desktop branch returns empty arrays for the retired three, never omits them.

- [ ] **Step 1: Write the failing test**

```ts
// app/tests/data/demo-data.test.ts — replace the existing suite body
import { describe, expect, it } from 'vitest';

import { createInitialState } from '@/data/demo-data';

describe('createInitialState on the desktop', () => {
  const state = () => createInitialState(true);

  it('seeds no sessions and no session order', () => {
    expect(state().order).toEqual([]);
    const kinds = Object.values(state().entities).map((entity) => entity.kind);
    expect(kinds).not.toContain('session');
  });

  it('seeds no projects — the config supplies them', () => {
    expect(state().projects).toEqual([]);
  });

  it('still seeds agents, which nothing else can produce', () => {
    expect(state().agentOrder.length).toBeGreaterThan(0);
    for (const id of state().agentOrder) {
      expect(state().entities[id]?.kind).toBe('agent');
    }
  });

  it('still seeds tickets, PRs, notifications and the feed', () => {
    expect(state().tickets.length).toBeGreaterThan(0);
    expect(state().prs.length).toBeGreaterThan(0);
    expect(state().notifs.length).toBeGreaterThan(0);
    expect(state().feed.length).toBeGreaterThan(0);
  });
});

describe('createInitialState in the browser', () => {
  const state = () => createInitialState(false);

  it('returns the whole demo dataset — that build is the demo', () => {
    expect(state().order.length).toBeGreaterThan(0);
    expect(state().projects.length).toBeGreaterThan(0);
    expect(
      Object.values(state().entities).filter((entity) => entity.kind === 'session'),
    ).not.toHaveLength(0);
  });
});

describe('createInitialState', () => {
  it('is a factory — two calls do not share state', () => {
    const first = createInitialState(false);
    first.order.push('mutated');
    expect(createInitialState(false).order).not.toContain('mutated');
  });
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `pnpm vitest run tests/data/demo-data.test.ts`
Expected: FAIL — `createInitialState` takes no argument, so the desktop branch returns the full dataset and `order` is non-empty.

- [ ] **Step 3: Add the branch**

In `demo-data.ts`, keep `createSessions()` — the browser branch still needs it — and change the factory:

```ts
import { isDesktop } from '@config/runtime';

/**
 * A factory rather than a frozen object: every test starts from a clean copy,
 * so mutating one test's state cannot leak into the next (story 013).
 *
 * `desktop` is injected rather than read inline so both branches are unit
 * testable without standing up a fake bridge.
 */
export function createInitialState(desktop: boolean = isDesktop()): InitialState {
  const agents = createAgents();

  const entities: Record<string, Entity> = {};
  for (const entity of desktop ? agents : [...createSessions(), ...agents]) {
    entities[entity.id] = entity;
  }

  return {
    entities,
    /**
     * Sessions and projects are retired on the desktop (story 109): the
     * pty-host and `~/.hive/config.json` supply both, and showing invented
     * ones alongside real ones made the app unusable for judging whether a
     * feature worked.
     *
     * The browser has neither, and its dataset is the product there.
     */
    order: desktop ? [] : [/* the existing ten session ids, unchanged */],
    agentOrder: ['slack-agent', 'pr-reviewer', 'standup-agent'],
    projects: desktop ? [] : [/* the existing five entries, unchanged */],
    tickets: [/* unchanged */],
    prs: [/* unchanged */],
    notifs: [/* unchanged */],
    feed: [/* unchanged */],
    orchLines: [/* unchanged */],
  };
}
```

Move the existing literal arrays into the ternaries verbatim. Do not retype them — a transcription slip here is invisible until a browser demo looks wrong.

- [ ] **Step 4: Run the tests and confirm they pass**

Run: `pnpm vitest run tests/data/demo-data.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Run the store suite**

Run: `pnpm vitest run tests/stores`
Expected: PASS. These run under jsdom with no `window.hive`, so `isDesktop()` is false and they keep the full dataset — which is why they need no changes. If one fails, it was depending on the desktop branch and needs an explicit `createInitialState(true)`.

- [ ] **Step 6: Commit**

```bash
git add app/src/data/demo-data.ts app/tests/data/demo-data.test.ts
git commit -m "feat(data): retire demo sessions and projects on the desktop"
```

---

### Task 3: Confirm the project list needs no change

**Files:**
- Test: `app/tests/stores/hive-store.selectors.test.tsx`
- Modify: `app/src/stores/hive-store.ts:701-723` (doc comment only, if the test confirms the behaviour)

**Interfaces:**
- Consumes: `createInitialState(true)` (Task 2).
- Produces: nothing.

This task is a **verification** task. `useProjects` already prefers the config and already drops fixture projects that own no sessions (`hive-store.ts:753`). With Task 2 there are no demo projects and no demo sessions on the desktop, so both branches should already be correct. Prove it rather than assume it.

- [ ] **Step 1: Write the test**

```tsx
// append to app/tests/stores/hive-store.selectors.test.tsx
describe('useProjects after story 109', () => {
  it('returns exactly the configured rows, all marked config', () => {
    // Seed the store from createInitialState(true) and stub the config
    // snapshot with two projects, following this file's existing harness.
    const rows = renderHookResult();
    expect(rows.map((row) => row.id)).toEqual(['claude-kit', 'incorpx']);
    expect(rows.every((row) => row.source === 'config')).toBe(true);
  });

  it('returns an empty list when the config has no projects and the desktop seeded none', () => {
    expect(renderHookResult()).toEqual([]);
  });
});
```

Follow the harness already in this file for seeding the store and stubbing `projectConfigSnapshot` — do not introduce a second approach.

- [ ] **Step 2: Run it**

Run: `pnpm vitest run tests/stores/hive-store.selectors.test.tsx`
Expected: PASS without touching `useProjects`. **If it fails, stop and re-read `hive-store.ts:733-757` before changing anything** — the merge is load-bearing for the work panel, the orchestrator table and `resolve-transport`, all of which reach sessions through `entity.project`.

- [ ] **Step 3: Update the selector's doc table**

The three-row table at `hive-store.ts:701-711` describes fixture behaviour that is now browser-only. Amend the rows to say so; leave the third row's reasoning intact, since it still governs the browser build.

- [ ] **Step 4: Commit**

```bash
git add app/src/stores/hive-store.ts app/tests/stores/hive-store.selectors.test.tsx
git commit -m "test: pin useProjects to config-only rows on the desktop"
```

---

### Task 4: Mark the kept demo data as demo

**Files:**
- Modify: the ticket, PR and feed row components under `app/src/features/`
- Test: `app/tests/features/demo-marking.test.tsx` (create)

**Interfaces:**
- Consumes: `createInitialState(true)` (Task 2).
- Produces: nothing.

Spec decision 4. Tickets, PRs and the feed are now the only invented data on a
desktop screen, sitting beside real projects and real sessions. Unmarked, they
read as fetched — which is the exact confusion this story exists to end, moved
rather than removed.

- [ ] **Step 1: Find the affected row components**

Run: `rg -n 'useTickets|usePrs|useFeed' app/src/features`
Expected: the ticket list, the PR card (`pr-card.tsx`) and the feed. Read each
before editing.

- [ ] **Step 2: Write the failing test**

```tsx
// app/tests/features/demo-marking.test.tsx
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

/**
 * Real projects and real sessions now share the screen with invented tickets
 * and PRs. Without a marker the invented ones read as fetched.
 */
describe('demo marking', () => {
  it('labels a ticket row as demo', () => {
    render(<TicketRow id="GRAC-3018" />);
    expect(screen.getByText(/demo/i)).toBeInTheDocument();
  });

  it('labels a PR card as demo', () => {
    render(<PrCard id={/* an id from the demo dataset */ 'demo-pr-id'} />);
    expect(screen.getByText(/demo/i)).toBeInTheDocument();
  });
});
```

Replace the component names and the PR id with the real ones found in Step 1.

- [ ] **Step 3: Run it and confirm it fails**

Run: `pnpm vitest run tests/features/demo-marking.test.tsx`
Expected: FAIL — no marker is rendered.

- [ ] **Step 4: Add the marker**

Reuse the visual treatment the project rail already uses for `source: 'demo'`
rather than inventing a second one — find it with
`rg -n "'demo'" app/src/features app/src/components` and copy that element.
A one-word `demo` chip in `text-subtle` is the whole change; do not add a
tooltip, a banner, or a dismissable notice.

- [ ] **Step 5: Run the tests and confirm they pass**

Run: `pnpm vitest run tests/features/demo-marking.test.tsx`
Expected: PASS (2 tests).

- [ ] **Step 6: Commit**

```bash
git add app/src/features app/tests/features/demo-marking.test.tsx
git commit -m "feat(ui): mark demo tickets, PRs and feed items as demo"
```

---

### Task 5: Prove every panel survives zero rows

**Files:**
- Test: `app/tests/features/empty-panels.test.tsx` (create)

**Interfaces:**
- Consumes: `createInitialState(true)` (Task 2).
- Produces: nothing.

- [ ] **Step 1: Write the test**

```tsx
// app/tests/features/empty-panels.test.tsx
import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

/**
 * The one real risk in story 109: a panel that assumed a non-empty seed and
 * throws — or renders a bare frame — at zero rows. A crash here is a blank
 * window on launch for anyone whose config lists no projects.
 */
describe('panels at zero rows', () => {
  it.each([
    ['work panel', WorkPanel],
    ['orchestrator table', OrchestratorTable],
    ['left rail', LeftRail],
    ['session list', SessionList],
  ])('%s renders without throwing', (_name, Panel) => {
    // Seed the store from createInitialState(true) with an empty config
    // snapshot, following tests/features/ for the render harness.
    expect(() => render(<Panel />)).not.toThrow();
  });
});
```

Replace the component names with the real exports — find them with `rg -n 'export function' app/src/features` and read each panel's props before writing the case.

- [ ] **Step 2: Run it and fix what breaks**

Run: `pnpm vitest run tests/features/empty-panels.test.tsx`
Expected: some panels may fail. Fix each by rendering an empty state, not by re-seeding data — re-seeding would defeat the story. Keep each empty state to one sentence in `text-subtle`, matching `runtime-section.tsx`'s browser-only notice.

- [ ] **Step 3: Commit**

```bash
git add app/src app/tests/features/empty-panels.test.tsx
git commit -m "test: cover every panel at zero rows, add empty states where missing"
```

---

### Task 6: End-to-end and final verification

**Files:**
- Modify: `app/tests/e2e/electron/session-lifecycle.spec.ts` (or a new spec alongside it)

**Interfaces:**
- Consumes: everything above.
- Produces: nothing.

- [ ] **Step 1: Write the e2e assertion**

Seed a config with two real directories, launch, and assert: the left rail shows exactly those two names and no demo project; the session list is empty before a spawn; and after spawning one, exactly one session appears. Follow the existing spec's fixture and launch harness.

- [ ] **Step 2: Run the electron e2e suite**

Run: `pnpm test:e2e:electron`
Expected: PASS.

- [ ] **Step 3: Run the web e2e suite**

Run: `pnpm test:e2e:web`
Expected: PASS **unchanged**. These six specs exercise the browser demo, and `config/runtime.ts` names keeping them passing as a reason the browser build exists. A failure here means the browser branch lost data it should have kept — fix the branch, not the spec.

- [ ] **Step 4: Full verification**

Run: `pnpm vitest run && pnpm type-check && pnpm lint && pnpm verify:boundaries && pnpm test:e2e:electron && pnpm test:e2e:web`
Expected: all PASS. Paste the real output into the commit body — do not summarise it.

- [ ] **Step 5: Commit**

```bash
git add app/tests
git commit -m "test: assert the desktop starts from config alone"
```

---

## Self-Review

**Spec coverage.** Decision 1 (split by whether a real source exists; agents stay because nothing can create one) → Task 2. Decision 2 (rename, import zone follows, prose references updated) → Task 1. Decision 3 (desktop starts empty, browser demo does not) → Task 2's injected `desktop` flag. Decision 4 (kept data stays visibly demo) → Task 4, which the first draft of this plan omitted entirely and which the self-review added. The spec's Testing section maps as: `createInitialState` both branches → Task 2; `useProjects` → Task 3; panels at zero rows → Task 5; e2e → Task 6; "Playwright's own fixtures directory is untouched" → Global Constraints.

**Type consistency.** `createInitialState(desktop?: boolean)` is defined in Task 2 and called as `createInitialState(true)` in Tasks 3, 4 and 5. `InitialState` keeps all nine fields in both branches — the desktop branch returns empty arrays, never omits keys, so no consumer needs a new optional-field check. `ProjectRow.source` is the existing `'config' | 'demo'` union throughout; Task 4 reuses its visual treatment rather than adding a third value.

**Placeholder scan.** No "TBD", no "add appropriate error handling", no code step without a code block. Three steps direct the implementer to a discovery command instead of naming symbols: Task 2 Step 3 (move the existing literal arrays verbatim), Task 4 Step 1 (`rg` for the row components) and Task 5 Step 1 (`rg` for the panel exports). This is deliberate. Transcribing roughly 200 lines of demo data into a plan invites a silent copy error that only shows up as a wrong-looking browser demo, and the instruction "move it, do not retype it" is both shorter and safer than reproducing it.

**One risk called out in the plan itself.** Task 3 is a verification task that expects to change no production code. Its Step 2 says to stop and re-read the selector if the test fails, rather than editing `useProjects` — the merge at `hive-store.ts:733-757` is load-bearing for three consumers that reach sessions through `entity.project`, and "make the test pass" is the wrong instinct there.
