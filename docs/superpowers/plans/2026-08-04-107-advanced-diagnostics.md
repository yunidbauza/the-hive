# 107 — Advanced & diagnostics Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the fifth Settings section — Advanced — carrying reveal-config, an explicit reload, reset-to-template, app/Electron versions, PTY flow-control counters, and the log location.

**Architecture:** Two new no-payload bridge verbs (`config.revealConfig`, `config.resetConfig`) plus one new field on the existing `AppInfo` (`logPath`). Reset routes through the single `writeConfig` path like every other mutation. Reload and `appInfo()` already exist end-to-end and are only being wired to UI. The pane is a fifth entry in the settings overlay's `SECTIONS`/`PANES` maps, composed from the shared `SettingsGroup` exactly as sections 104–106 are.

**Tech Stack:** Electron 38 · React 19 · TypeScript strict · Vitest + Testing Library · Playwright `_electron` · Tailwind v4 with `--cc-*` tokens.

Spec: `docs/superpowers/specs/2026-08-04-107-advanced-diagnostics-design.md`

## Global Constraints

- `pnpm lint` and `pnpm type-check` must both pass before any task is done. No inline rule disables.
- Tests mirror `src/` and `electron/` under `tests/`. 80% coverage gate on lines, statements, branches, functions.
- **kebab-case** filenames; **absolute `@/`-style imports** only, never `../` from a component.
- No raw hex literals in component code — colour comes from `--cc-*` tokens (`text-ink`, `text-subtle`, `text-muted`, `text-amber`, `text-red`, `bg-panel-2`, `border-border-soft`, `bg-brand-fill`, `text-on-brand`).
- Icons come from `@phosphor-icons/react`, the one icon library.
- Components never touch `window.hive` directly — every bridge call goes through `src/lib/project-config.ts`.
- Every mutating config verb returns `ConfigSnapshot` (epic rule, `stories/100-settings-epic.md:160`).
- No config verb takes a destination path (epic rule, `stories/100-settings-epic.md:86`). Both verbs added here take **no argument at all**.
- Run all commands from `app/`: `cd app && pnpm …`.

---

### Task 1: `resetConfig` in main

**Files:**
- Modify: `app/electron/main/config/index.ts` (append after `setNotifications`)
- Test: `app/tests/electron/main/config/reset.test.ts` (create)

**Interfaces:**
- Consumes: `writeConfig`, `commit`, `ConfigDocument` — all already in `index.ts`; `CONFIG_TEMPLATE` — already imported there.
- Produces: `resetConfig(): ConfigSnapshot`, exported from `electron/main/config/index.ts`.

- [ ] **Step 1: Write the failing test**

Create `app/tests/electron/main/config/reset.test.ts`. Model the fixture setup on the existing `app/tests/electron/main/config/write.test.ts` — read it first and copy how it points `HIVE_CONFIG_PATH` at a temp directory and how it imports the module under test.

```ts
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { CONFIG_PATH_ENV, CONFIG_VERSION } from '@shared/config-contract';

let dir: string;
let path: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'hive-reset-'));
  path = join(dir, 'config.json');
  process.env[CONFIG_PATH_ENV] = path;
  vi.resetModules();
});

afterEach(() => {
  delete process.env[CONFIG_PATH_ENV];
  rmSync(dir, { recursive: true, force: true });
});

const load = async () => import('@electron/main/config');

describe('resetConfig', () => {
  it('replaces a populated config with the template', async () => {
    writeFileSync(
      path,
      `${JSON.stringify(
        {
          version: 2,
          shell: '/bin/zsh',
          projects: [{ id: 'a', name: 'A', path: dir, icon: 'ph-folder', origin: 'local' }],
        },
        null,
        2,
      )}\n`,
    );

    const { resetConfig } = await load();
    const snapshot = resetConfig();

    expect(snapshot.projects).toEqual([]);
    expect(snapshot.errors).toEqual([]);

    const written = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
    expect(written.projects).toEqual([]);
    expect(written.version).toBe(CONFIG_VERSION);
    // The reset file is still the commented one — that is the whole reason the
    // template is written rather than a bare `{ projects: [] }`.
    expect(written['//']).toContain('The Hive');
    // Reset is the one write that does NOT preserve what was there.
    expect(written.shell).toBeUndefined();
  });

  it('discards unknown top-level keys and comments the user added', async () => {
    writeFileSync(
      path,
      `${JSON.stringify({ version: 2, projects: [], '//mine': 'keep me', future: 1 }, null, 2)}\n`,
    );

    const { resetConfig } = await load();
    resetConfig();

    const written = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
    expect(written['//mine']).toBeUndefined();
    expect(written.future).toBeUndefined();
  });

  it('refuses and reports when there is no file to read', async () => {
    const { resetConfig } = await load();
    const snapshot = resetConfig();

    expect(snapshot.errors).toHaveLength(1);
    expect(snapshot.errors[0]).toContain('nothing was written');
  });
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `cd app && pnpm test tests/electron/main/config/reset.test.ts`
Expected: FAIL — `resetConfig is not a function` / no export named `resetConfig`.

- [ ] **Step 3: Implement**

Append to `app/electron/main/config/index.ts`, after `setNotifications`:

```ts
/**
 * Put the config file back to the first-run template (story 107).
 *
 * The one mutation that deliberately **discards** user data, and so the one
 * exception to the epic's preservation promise: unknown top-level keys and
 * hand-written comments ride across every other write and are replaced here.
 * That is what "reset" means, and the confirmation in the UI says so in those
 * words rather than asking a generic "are you sure?".
 *
 * Still routed through `writeConfig` like everything else, which is the point.
 * It inherits the whole discipline for free — the file is re-read first, the
 * result is validated by the *reader's* own parser before anything touches
 * disk, the swap is a temp file plus `rename`, the mode and any symlink are
 * preserved, and the fresh snapshot comes back. A reset that wrote the template
 * string directly would be the one write path in the app that could leave a
 * torn file.
 *
 * `JSON.parse` of the template rather than the string verbatim, so the mutation
 * has the same shape as every other (a `ConfigDocument` in, one out) and so the
 * template goes through the reader's validator — a template this build could
 * not read back fails in CI rather than on a user's machine. The `"//"` comment
 * keys survive `JSON.parse`, so the file written is still the commented one.
 *
 * `writeConfig` refuses when there is no file to read, so a reset with the
 * config deleted underneath reports that rather than recreating it. Recreating
 * it is `reload`'s job — `loadConfig` writes the template when the file is
 * gone — and having exactly one path that creates the file is worth the extra
 * click.
 */
export function resetConfig(): ConfigSnapshot {
  return commit(writeConfig(() => JSON.parse(CONFIG_TEMPLATE) as ConfigDocument));
}
```

- [ ] **Step 4: Run the test**

Run: `cd app && pnpm test tests/electron/main/config/reset.test.ts`
Expected: PASS, 3 tests.

- [ ] **Step 5: Lint and type-check**

Run: `cd app && pnpm type-check && pnpm lint`
Expected: both clean.

- [ ] **Step 6: Commit**

```bash
cd app && git add electron/main/config/index.ts tests/electron/main/config/reset.test.ts
git commit -m "feat(107): reset the config to the first-run template"
```

---

### Task 2: The IPC seam — two verbs and `AppInfo.logPath`

**Files:**
- Modify: `app/electron/shared/ipc-contract.ts` (`CH`, `AppInfo`, `HiveBridge.config`, `BRIDGE_CONFIG_KEYS`)
- Modify: `app/electron/main/ipc/index.ts` (imports, `appInfo` handler, two new handlers)
- Modify: `app/electron/preload/index.ts` (two bridge methods)
- Test: `app/tests/electron/preload/bridge.test.ts` (extend)

**Interfaces:**
- Consumes: `resetConfig()` from Task 1.
- Produces:
  - `CH.configReveal = 'config:reveal'`, `CH.configReset = 'config:reset'`
  - `AppInfo.logPath: string`
  - `window.hive.config.revealConfig(): Promise<void>`
  - `window.hive.config.resetConfig(): Promise<ConfigSnapshot>`

- [ ] **Step 1: Write the failing test**

In `app/tests/electron/preload/bridge.test.ts`, find the existing `appInfo invokes app:info` test and the surface test that asserts `typeof exposed.appInfo`. Add alongside them (adapt the local helper names — read the file's existing `config` tests and copy their exact shape):

```ts
it('revealConfig invokes config:reveal with no payload', async () => {
  await (exposed.config as { revealConfig: () => Promise<void> }).revealConfig();
  expect(ipcRendererMock.invoke).toHaveBeenCalledWith(CH.configReveal);
});

it('resetConfig invokes config:reset with no payload', async () => {
  await (exposed.config as { resetConfig: () => Promise<unknown> }).resetConfig();
  expect(ipcRendererMock.invoke).toHaveBeenCalledWith(CH.configReset);
});

it('exposes exactly BRIDGE_CONFIG_KEYS on config', () => {
  expect(Object.keys(exposed.config as object).sort()).toEqual(
    [...BRIDGE_CONFIG_KEYS].sort(),
  );
});
```

Import `BRIDGE_CONFIG_KEYS` from `@shared/ipc-contract` at the top if it is not already imported.

- [ ] **Step 2: Run it and confirm it fails**

Run: `cd app && pnpm test tests/electron/preload/bridge.test.ts`
Expected: FAIL — `CH.configReveal` is `undefined`, and `revealConfig` is not a function.

- [ ] **Step 3: Add the channels and the contract**

In `app/electron/shared/ipc-contract.ts`, add to `CH` immediately after `configSetNotifications`:

```ts
  /**
   * Story 107's two verbs. Both `invoke`, and both take **no payload at all**.
   *
   * That is the whole security design rather than an omission, and it is the
   * same one story 106's `integrations:status` uses: with nothing arriving from
   * the renderer there is no payload guard to write and nothing to inject into.
   * Main resolves the target from its own `configPath()` in both cases, so a
   * compromised renderer cannot aim either verb at a file main did not choose.
   * The epic's rule is that no verb takes a destination path; these take no
   * argument, which is strictly stronger.
   *
   * `reveal` returns nothing — showing a file in the OS file manager has no
   * verdict to report. `reset` returns the fresh snapshot, like every other
   * mutating verb.
   */
  configReveal: 'config:reveal',
  configReset: 'config:reset',
```

Add to `AppInfo`, after `platform`:

```ts
  /**
   * Electron's log directory (story 107).
   *
   * Reported, not written to. **This app writes no log file** — main logs to
   * stdout with a `[hive]` prefix — and the Advanced pane says exactly that
   * next to this path. It is here rather than behind a verb of its own because
   * `AppInfo` already exists "for the About box and bug reports", and this is
   * the same kind of fact as `electron` and `chrome`.
   *
   * Building a real log file, sink and rotation is a logging feature that a
   * diagnostics pane would then report on — larger than this story, and
   * deliberately out of it. A "Reveal logs" button that opened an empty folder
   * while implying the app had written to it would answer the user's question
   * wrongly rather than not answering it, so no such button ships.
   */
  logPath: string;
```

Add to `HiveBridge.config`, after `setNotifications`:

```ts
    /**
     * Show the config file in the OS file manager (story 107).
     *
     * Takes no argument: main reveals its own `configPath()`. Reveal is the
     * gentler of the two ways to open a file — it selects the file in a folder
     * window rather than launching whatever application claims `.json`.
     */
    revealConfig(): Promise<void>;
    /**
     * Put the config file back to the first-run template (story 107).
     *
     * Destructive, and the one write that does not preserve unknown keys or the
     * user's comments. Takes no argument; the confirmation is the renderer's.
     */
    resetConfig(): Promise<ConfigSnapshot>;
```

Append to `BRIDGE_CONFIG_KEYS`, after the story 106 entry:

```ts
  // Story 107.
  'revealConfig',
  'resetConfig',
```

- [ ] **Step 4: Add the main handlers**

In `app/electron/main/ipc/index.ts`:

Add `resetConfig` to the existing `from '../config'` import list (alphabetical: it goes between `repointProject` and `setNotifications`).

Add `shell` to the existing `from 'electron'` import list (alphabetical: between `ipcMain` and the `type` imports).

Add `configPath` to the `'../config'` import list — it is already re-exported from there.

Extend the `appInfo` handler's returned object with `logPath`, immediately after `platform`:

```ts
      // Reported, never written to — this app logs to stdout. See `AppInfo`.
      logPath: app.getPath('logs'),
```

Add the two handlers immediately after the `configSetNotifications` handler:

```ts
  /**
   * Story 107's two verbs. Neither takes a payload, so — exactly like
   * `config:get` and `config:reload` — the sender check `handle` applies is
   * their whole validation. There is no guard to write because there is no
   * input: main reveals and rewrites the file *it* resolved.
   */
  handle(CH.configReveal, (): void => {
    shell.showItemInFolder(configPath());
  });
  handle(CH.configReset, (): ConfigSnapshot => resetConfig());
```

- [ ] **Step 5: Add the preload methods**

In `app/electron/preload/index.ts`, inside `config`, after `setNotifications`:

```ts
    // Story 107. Neither takes an argument — see the contract for why that is
    // the security design and not an oversight.
    revealConfig: (): Promise<void> => ipcRenderer.invoke(CH.configReveal),
    resetConfig: (): Promise<ConfigSnapshot> => ipcRenderer.invoke(CH.configReset),
```

- [ ] **Step 6: Run the tests**

Run: `cd app && pnpm test tests/electron/preload/bridge.test.ts`
Expected: PASS.

- [ ] **Step 7: Lint and type-check**

Run: `cd app && pnpm type-check && pnpm lint`
Expected: both clean. If `pnpm test` reports failures in other electron tests that build an `AppInfo` literal, add `logPath: '/tmp/logs'` to those fixtures.

- [ ] **Step 8: Run the whole unit suite**

Run: `cd app && pnpm test`
Expected: PASS. Fix any `AppInfo` fixture that now misses `logPath`.

- [ ] **Step 9: Commit**

```bash
cd app && git add electron/shared/ipc-contract.ts electron/main/ipc/index.ts electron/preload/index.ts tests/
git commit -m "feat(107): reveal and reset config verbs, log path on appInfo"
```

---

### Task 3: The renderer's three lib calls

**Files:**
- Modify: `app/src/lib/project-config.ts`
- Test: `app/tests/lib/project-config.test.ts` (extend)

**Interfaces:**
- Consumes: `window.hive.config.revealConfig`, `window.hive.config.resetConfig`, `window.hive.appInfo` from Task 2.
- Produces, all exported from `@lib/project-config`:
  - `revealConfigFile(): Promise<void>`
  - `resetConfigToTemplate(): Promise<void>`
  - `readAppInfo(): Promise<AppInfo | null>`

- [ ] **Step 1: Write the failing test**

Append to `app/tests/lib/project-config.test.ts`. Read the file first — it already has a `window.hive` stub factory and a `resetProjectConfig()` in `beforeEach`; reuse them rather than building a second stub.

```ts
describe('story 107 verbs', () => {
  it('revealConfigFile calls through to the bridge', async () => {
    const revealConfig = vi.fn().mockResolvedValue(undefined);
    (window as { hive?: unknown }).hive = { config: { revealConfig } };

    await revealConfigFile();

    expect(revealConfig).toHaveBeenCalledWith();
  });

  it('revealConfigFile is a no-op with no bridge', async () => {
    delete (window as { hive?: unknown }).hive;
    await expect(revealConfigFile()).resolves.toBeUndefined();
  });

  it('resetConfigToTemplate installs the snapshot main returns', async () => {
    const next = emptySnapshot('/tmp/hive/config.json');
    (window as { hive?: unknown }).hive = {
      config: { resetConfig: vi.fn().mockResolvedValue(next) },
    };

    await resetConfigToTemplate();

    expect(projectConfigSnapshot()).toEqual(next);
  });

  it('resetConfigToTemplate keeps the last good snapshot when refused', async () => {
    const good = emptySnapshot('/tmp/hive/config.json');
    setProjectConfigForTest(good);
    (window as { hive?: unknown }).hive = {
      config: { resetConfig: vi.fn().mockRejectedValue(new Error('nope')) },
    };

    await resetConfigToTemplate();

    expect(projectConfigSnapshot()).toEqual(good);
  });

  it('readAppInfo returns what the bridge answers', async () => {
    const info = { version: '1.2.3', electron: '38', chrome: '140', node: '22', platform: 'darwin', logPath: '/tmp/logs' };
    (window as { hive?: unknown }).hive = { appInfo: vi.fn().mockResolvedValue(info) };

    await expect(readAppInfo()).resolves.toEqual(info);
  });

  it('readAppInfo returns null with no bridge and on a failed channel', async () => {
    delete (window as { hive?: unknown }).hive;
    await expect(readAppInfo()).resolves.toBeNull();

    (window as { hive?: unknown }).hive = {
      appInfo: vi.fn().mockRejectedValue(new Error('gone')),
    };
    await expect(readAppInfo()).resolves.toBeNull();
  });
});
```

Add `readAppInfo`, `resetConfigToTemplate`, `revealConfigFile` and `projectConfigSnapshot` to the file's existing import from `@lib/project-config`, and `emptySnapshot` from `@shared/config-contract` if not already there. The two rejection tests log through `console.error` — if the file already silences that with a `vi.spyOn(console, 'error')`, reuse it; otherwise add one in this describe's `beforeEach`.

- [ ] **Step 2: Run it and confirm it fails**

Run: `cd app && pnpm test tests/lib/project-config.test.ts`
Expected: FAIL — the three functions are not exported.

- [ ] **Step 3: Implement**

In `app/src/lib/project-config.ts`, add `AppInfo` to the existing type import from `@shared/ipc-contract`:

```ts
import type { AppInfo, IntegrationsStatus } from '@shared/ipc-contract';
```

Add after `readIntegrationsStatus`:

```ts
/**
 * Show the config file in the OS file manager (story 107).
 *
 * Not routed through `mutate`: it writes nothing and returns no snapshot, so
 * there is nothing to install. Silent with no bridge — the browser demo has no
 * file manager to open, and story 083's rule is to feature-detect the bridge
 * rather than the user agent.
 *
 * A failure is logged rather than surfaced. The one thing that can go wrong is
 * that the OS declined to open a window, and there is no action the user could
 * take in this pane about that which the path printed above the button does not
 * already give them.
 */
export async function revealConfigFile(): Promise<void> {
  const bridge = window.hive;
  if (!bridge) return;

  try {
    await bridge.config.revealConfig();
  } catch (cause) {
    console.error('[hive] could not reveal the config file:', cause);
  }
}

/**
 * Put the config file back to the first-run template (story 107).
 *
 * Routed through `mutate` like every other write, which is what makes a refused
 * reset leave the last good snapshot in place rather than emptying the UI's
 * project list over a write that never happened — the bug story 103 fixed, and
 * the reason `mutate` exists separately from `read`.
 */
export const resetConfigToTemplate = (): Promise<void> =>
  mutate((bridge) => bridge.config.resetConfig());

/**
 * Versions, platform, log directory and PTY counters (story 107).
 *
 * Not routed through `mutate` — it writes nothing, so there is no snapshot to
 * install. `null` with no bridge (the browser demo) or on a failed channel, and
 * the caller says so rather than rendering fabricated version numbers; a
 * diagnostics pane that invented an answer would be worse than no pane.
 *
 * Asked on demand rather than subscribed to. `appInfo` is `invoke`-only and
 * there is no push channel for the counters, so the pane carries an explicit
 * refresh — see `advanced-section.tsx` for why polling was rejected.
 */
export async function readAppInfo(): Promise<AppInfo | null> {
  const bridge = window.hive;
  if (!bridge) return null;

  try {
    return await bridge.appInfo();
  } catch (cause) {
    console.error('[hive] reading app info failed:', cause);
    return null;
  }
}
```

- [ ] **Step 4: Run the test**

Run: `cd app && pnpm test tests/lib/project-config.test.ts`
Expected: PASS.

- [ ] **Step 5: Lint and type-check**

Run: `cd app && pnpm type-check && pnpm lint`

- [ ] **Step 6: Commit**

```bash
cd app && git add src/lib/project-config.ts tests/lib/project-config.test.ts
git commit -m "feat(107): renderer verbs for reveal, reset and app info"
```

---

### Task 4: The reset confirmation

**Files:**
- Create: `app/src/features/settings/components/config-reset-confirm.tsx`
- Test: `app/tests/features/settings/components/config-reset-confirm.test.tsx` (create)

**Interfaces:**
- Consumes: nothing from earlier tasks — it is a pure presentational component.
- Produces:
  ```ts
  interface ConfigResetConfirmProps {
    projectCount: number;
    onConfirm: () => void;
    onCancel: () => void;
  }
  export function ConfigResetConfirm(props: ConfigResetConfirmProps): JSX.Element;
  ```

- [ ] **Step 1: Write the failing test**

Create `app/tests/features/settings/components/config-reset-confirm.test.tsx`:

```tsx
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { ConfigResetConfirm } from '@features/settings/components/config-reset-confirm';

describe('ConfigResetConfirm', () => {
  it('names how many projects are lost, pluralised', () => {
    const { unmount } = render(
      <ConfigResetConfirm projectCount={1} onConfirm={vi.fn()} onCancel={vi.fn()} />,
    );
    expect(screen.getByText(/1 project/)).toBeInTheDocument();
    unmount();

    render(<ConfigResetConfirm projectCount={3} onConfirm={vi.fn()} onCancel={vi.fn()} />);
    expect(screen.getByText(/3 projects/)).toBeInTheDocument();
  });

  it('says the comments and unknown keys go too', () => {
    render(<ConfigResetConfirm projectCount={0} onConfirm={vi.fn()} onCancel={vi.fn()} />);
    expect(screen.getByText(/comments/i)).toBeInTheDocument();
  });

  it('focuses Cancel, not the destructive button', () => {
    render(<ConfigResetConfirm projectCount={2} onConfirm={vi.fn()} onCancel={vi.fn()} />);
    expect(screen.getByRole('button', { name: 'Cancel' })).toHaveFocus();
  });

  it('calls onConfirm only when the destructive button is pressed', async () => {
    const onConfirm = vi.fn();
    const onCancel = vi.fn();
    render(
      <ConfigResetConfirm projectCount={2} onConfirm={onConfirm} onCancel={onCancel} />,
    );

    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onConfirm).not.toHaveBeenCalled();

    await userEvent.click(screen.getByRole('button', { name: 'Reset config' }));
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it('backs out on Escape', async () => {
    const onCancel = vi.fn();
    render(<ConfigResetConfirm projectCount={0} onConfirm={vi.fn()} onCancel={onCancel} />);

    await userEvent.keyboard('{Escape}');
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it('claims Escape from the settings dialog', () => {
    render(<ConfigResetConfirm projectCount={0} onConfirm={vi.fn()} onCancel={vi.fn()} />);
    expect(screen.getByRole('alertdialog')).toHaveAttribute('data-escape-scope');
  });
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `cd app && pnpm test tests/features/settings/components/config-reset-confirm.test.tsx`
Expected: FAIL — cannot resolve the module.

- [ ] **Step 3: Implement**

Create `app/src/features/settings/components/config-reset-confirm.tsx`:

```tsx
import { useEffect, useRef, type KeyboardEvent } from 'react';

interface ConfigResetConfirmProps {
  /** Projects in the current snapshot. Zero is valid — the file may be empty. */
  projectCount: number;
  onConfirm: () => void;
  onCancel: () => void;
}

/**
 * Confirm resetting the config file (story 107).
 *
 * Inline and in place, following `project-remove-confirm.tsx` exactly rather
 * than inventing a second dialect of "confirm a destructive thing". The epic's
 * first binding decision is that settings is a full-stage overlay and
 * explicitly not a modal, because "a modal floating over thirteen live
 * terminals fights the attention model" — and that reasoning does not stop
 * applying because this particular action is a larger one.
 *
 * ## What it says is the design
 *
 * Reset is the **only** write in the app that discards what it did not write.
 * Every other verb spreads the document it read, so unknown top-level keys and
 * the user's own `"//"` comments survive; this one replaces them. Naming the
 * comments specifically is the point: the template is deliberately
 * comment-heavy and the product encourages hand-editing, so a user who has
 * annotated their config is exactly the user this confirmation exists for.
 *
 * It does **not** claim anything happens to their repositories. Resetting the
 * config forgets where they are; the directories on disk are untouched and the
 * PTYs already running keep running, exactly as with a removed project.
 */
export function ConfigResetConfirm({
  projectCount,
  onConfirm,
  onCancel,
}: ConfigResetConfirmProps) {
  const cancel = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    /*
      Focus lands on Cancel, never Reset — the destructive option should not be
      one stray Enter away the moment the group changes shape. In an effect
      rather than `autoFocus`, which `jsx-a11y` bans for the usual case of a
      page stealing focus on load; this is the opposite, since the user just
      asked for this and a confirmation they had to go find would be the
      accessibility problem.
    */
    cancel.current?.focus();
  }, []);

  const projects =
    projectCount === 1 ? '1 project' : `${projectCount} projects`;

  /**
   * Escape backs out, listened for on the buttons rather than the container.
   *
   * The container is `role="alertdialog"`, which `jsx-a11y` classes as
   * non-interactive and rightly does not want listening for keys. Focus starts
   * on Cancel and the only other stop is Reset, so the two buttons cover every
   * position focus can hold in here.
   */
  const escapes = (event: KeyboardEvent) => {
    if (event.key !== 'Escape') return;
    // Stops bubble-phase ancestors seeing it; `data-escape-scope` below is what
    // keeps Radix's document-capture listener from closing the whole overlay.
    event.stopPropagation();
    onCancel();
  };

  return (
    <div
      role="alertdialog"
      // Claims Escape from the settings dialog — see `settings-overlay.tsx`.
      data-escape-scope=""
      aria-label="Reset the config file?"
      className="rounded-[7px] border border-red bg-red/8 px-3 py-2.5"
    >
      <p className="text-[12.5px] text-ink">
        Reset the config file to the first-run template?
      </p>
      <p className="mt-0.5 text-[11.5px] text-subtle">
        {projects}, every per-project shell, command and environment override,
        and your notification preferences are forgotten. Any comments you added
        to the file go too — this is the one write that does not preserve them.
        Nothing on disk is deleted: the repositories stay where they are and
        sessions already running keep running.
      </p>
      <div className="mt-2 flex justify-end gap-1.5">
        <button
          ref={cancel}
          type="button"
          onClick={onCancel}
          onKeyDown={escapes}
          className="rounded-md border border-border px-2.5 py-1 text-[12px] text-muted hover:bg-hover hover:text-ink"
        >
          Cancel
        </button>
        <button
          type="button"
          onClick={onConfirm}
          onKeyDown={escapes}
          className="rounded-md bg-red px-2.5 py-1 text-[12px] font-medium text-bg hover:opacity-90"
        >
          Reset config
        </button>
      </div>
    </div>
  );
}
```

- [ ] **Step 4: Run the test**

Run: `cd app && pnpm test tests/features/settings/components/config-reset-confirm.test.tsx`
Expected: PASS, 6 tests.

- [ ] **Step 5: Lint and type-check**

Run: `cd app && pnpm type-check && pnpm lint`

- [ ] **Step 6: Commit**

```bash
cd app && git add src/features/settings/components/config-reset-confirm.tsx tests/features/settings/components/config-reset-confirm.test.tsx
git commit -m "feat(107): inline confirmation for resetting the config"
```

---

### Task 5: The Advanced pane

**Files:**
- Create: `app/src/features/settings/components/advanced-section.tsx`
- Test: `app/tests/features/settings/components/advanced-section.test.tsx` (create)

**Interfaces:**
- Consumes: `revealConfigFile()`, `resetConfigToTemplate()`, `readAppInfo()` (Task 3); `reloadProjectConfig()` (already exists); `ConfigResetConfirm` (Task 4); `SettingsGroup`, `useProjectConfig` (already exist).
- Produces: `export function AdvancedSection(): JSX.Element` — consumed by Task 6.

- [ ] **Step 1: Write the failing test**

Create `app/tests/features/settings/components/advanced-section.test.tsx`:

```tsx
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { emptySnapshot, type ConfigSnapshot } from '@shared/config-contract';
import type { AppInfo } from '@shared/ipc-contract';

import { AdvancedSection } from '@features/settings/components/advanced-section';
import { resetProjectConfig, setProjectConfigForTest } from '@lib/project-config';

const readAppInfo = vi.fn();
const revealConfigFile = vi.fn();
const resetConfigToTemplate = vi.fn();
const reloadProjectConfig = vi.fn();

vi.mock('@/lib/project-config', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/project-config')>();
  return {
    ...actual,
    readAppInfo: () => readAppInfo(),
    revealConfigFile: () => revealConfigFile(),
    resetConfigToTemplate: () => resetConfigToTemplate(),
    reloadProjectConfig: () => reloadProjectConfig(),
  };
});

const info = (over: Partial<AppInfo> = {}): AppInfo => ({
  version: '0.1.0',
  electron: '38.0.0',
  chrome: '140.0.0',
  node: '22.0.0',
  platform: 'darwin',
  logPath: '/Users/me/Library/Logs/The Hive',
  ...over,
});

const install = (over: Partial<ConfigSnapshot> = {}): void => {
  setProjectConfigForTest({ ...emptySnapshot('/Users/me/.hive/config.json'), ...over });
};

beforeEach(() => {
  vi.clearAllMocks();
  readAppInfo.mockResolvedValue(info());
  revealConfigFile.mockResolvedValue(undefined);
  resetConfigToTemplate.mockResolvedValue(undefined);
  reloadProjectConfig.mockResolvedValue(undefined);
  install();
});

afterEach(() => {
  resetProjectConfig();
});

describe('AdvancedSection', () => {
  it('shows the config path and reveals it', async () => {
    render(<AdvancedSection />);
    expect(screen.getByText('/Users/me/.hive/config.json')).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: /reveal in finder/i }));
    expect(revealConfigFile).toHaveBeenCalledTimes(1);
  });

  it('names the platform file manager', async () => {
    readAppInfo.mockResolvedValue(info({ platform: 'win32' }));
    render(<AdvancedSection />);

    expect(
      await screen.findByRole('button', { name: /reveal in explorer/i }),
    ).toBeInTheDocument();
  });

  it('reports what a reload found', async () => {
    render(<AdvancedSection />);

    reloadProjectConfig.mockImplementation(() => {
      install({ projects: [{ id: 'a', name: 'A', path: '/a', icon: 'ph-folder', origin: 'local', status: 'ok', isRepo: true }] });
      return Promise.resolve();
    });

    await userEvent.click(screen.getByRole('button', { name: 'Reload' }));

    expect(reloadProjectConfig).toHaveBeenCalledTimes(1);
    expect(await screen.findByText(/reloaded — 1 project/i)).toBeInTheDocument();
  });

  it('does not reset until the confirmation is accepted', async () => {
    install({ projects: [] });
    render(<AdvancedSection />);

    await userEvent.click(screen.getByRole('button', { name: 'Reset to template' }));
    expect(resetConfigToTemplate).not.toHaveBeenCalled();

    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(resetConfigToTemplate).not.toHaveBeenCalled();

    await userEvent.click(screen.getByRole('button', { name: 'Reset to template' }));
    await userEvent.click(screen.getByRole('button', { name: 'Reset config' }));
    expect(resetConfigToTemplate).toHaveBeenCalledTimes(1);
  });

  it('shows the versions and the log path', async () => {
    render(<AdvancedSection />);

    expect(await screen.findByText('0.1.0')).toBeInTheDocument();
    expect(screen.getByText('38.0.0')).toBeInTheDocument();
    expect(screen.getByText('/Users/me/Library/Logs/The Hive')).toBeInTheDocument();
    expect(screen.getByText(/writes no log file/i)).toBeInTheDocument();
  });

  it('says so when no session has ever run', async () => {
    render(<AdvancedSection />);
    expect(
      await screen.findByText(/no session has run yet/i),
    ).toBeInTheDocument();
  });

  it('renders the pty counters and refreshes them on demand', async () => {
    readAppInfo.mockResolvedValue(
      info({
        pty: [
          { sessionId: 's1', bytesIn: 2048, bytesAcked: 1024, unacked: 1024, pauses: 2, batches: 8, dropped: 0, paused: true },
        ],
      }),
    );
    render(<AdvancedSection />);

    expect(await screen.findByText('s1')).toBeInTheDocument();
    expect(readAppInfo).toHaveBeenCalledTimes(1);

    await userEvent.click(screen.getByRole('button', { name: 'Refresh' }));
    await waitFor(() => expect(readAppInfo).toHaveBeenCalledTimes(2));
  });

  it('degrades to a sentence with no bridge', () => {
    setProjectConfigForTest(null);
    render(<AdvancedSection />);

    expect(screen.getByText(/only available in the desktop app/i)).toBeInTheDocument();
    expect(readAppInfo).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `cd app && pnpm test tests/features/settings/components/advanced-section.test.tsx`
Expected: FAIL — cannot resolve the module.

- [ ] **Step 3: Implement**

Create `app/src/features/settings/components/advanced-section.tsx`:

```tsx
import { ArrowClockwise, FolderOpen } from '@phosphor-icons/react';
import { useCallback, useEffect, useState } from 'react';

import { ConfigResetConfirm } from '@features/settings/components/config-reset-confirm';
import { SettingsGroup } from '@features/settings/components/settings-group';
import { useProjectConfig } from '@hooks/use-project-config';
import {
  readAppInfo,
  reloadProjectConfig,
  resetConfigToTemplate,
  revealConfigFile,
} from '@lib/project-config';
import type { AppInfo, PtyDiagnostics } from '@shared/ipc-contract';

/**
 * Advanced & diagnostics (story 107).
 *
 * The last of the epic's six section slots, and the one that answers questions
 * about the app rather than setting anything in it.
 *
 * ## Why there is a Reload button at all
 *
 * The epic declined a config-file watcher and named this story as the
 * alternative: "a config that changes under a live session raises questions
 * about the PTY already running in the old directory … the explicit reload in
 * 107 is the answer." So reload is not a convenience here, it is the whole
 * mechanism by which a hand-edited file reaches a running app — and it reports
 * what it found, because a button that flashes and says nothing leaves the user
 * unable to tell a successful reload from a broken one.
 *
 * ## Why the counters have a Refresh and not an interval
 *
 * `appInfo()` is `invoke`-only and there is no push channel for the PTY
 * counters; this story does not add one. Polling would re-render a settings
 * pane every second for numbers nobody is watching, and the moment these are
 * useful is the moment the user deliberately asks for them.
 */

/** What the reveal button is called, per platform. */
function fileManager(platform: string | undefined): string {
  if (platform === 'darwin') return 'Reveal in Finder';
  if (platform === 'win32') return 'Reveal in Explorer';
  // Linux and everything else: there is no one file manager to name.
  return 'Show in file manager';
}

/** One label/value row, the shape every fact in this pane takes. */
function Fact({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-4">
      <span className="text-[12px] text-subtle">{label}</span>
      <span className="truncate font-mono text-[11.5px] text-ink">{value}</span>
    </div>
  );
}

const COUNTERS: readonly { key: keyof PtyDiagnostics; label: string }[] = [
  { key: 'bytesIn', label: 'in' },
  { key: 'bytesAcked', label: 'acked' },
  { key: 'unacked', label: 'unacked' },
  { key: 'pauses', label: 'pauses' },
  { key: 'batches', label: 'batches' },
  { key: 'dropped', label: 'dropped' },
];

function PtyCounters({ rows }: { rows: PtyDiagnostics[] }) {
  return (
    <div className="flex flex-col gap-2">
      {rows.map((row) => (
        <div
          key={row.sessionId}
          className="flex flex-col gap-1 rounded-[7px] border border-border-soft p-2.5"
        >
          <div className="flex items-center justify-between gap-2">
            <span className="font-mono text-[11.5px] text-ink">{row.sessionId}</span>
            {row.paused ? (
              <span className="text-[11px] text-amber">paused</span>
            ) : null}
          </div>
          <dl className="flex flex-wrap gap-x-4 gap-y-0.5">
            {COUNTERS.map((counter) => (
              <div key={counter.key} className="flex items-baseline gap-1">
                <dt className="text-[11px] text-subtle">{counter.label}</dt>
                <dd className="font-mono text-[11px] text-muted">
                  {/*
                    Raw numbers, not humanised. The ratio between them is what
                    diagnoses a flow-control bug — `bytesIn / batches` is the
                    coalescing ratio — and "2.1 MB" destroys exactly that.
                  */}
                  {row[counter.key]}
                </dd>
              </div>
            ))}
          </dl>
        </div>
      ))}
    </div>
  );
}

export function AdvancedSection() {
  const snapshot = useProjectConfig();
  const [info, setInfo] = useState<AppInfo | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [reloaded, setReloaded] = useState<string | null>(null);
  /** A reload is in flight, and its outcome has not been read yet. */
  const [pending, setPending] = useState(false);

  /**
   * Keyed on *whether* there is a snapshot, never on the snapshot itself.
   *
   * The same trap story 106 documents: every mutating verb installs a fresh
   * `ConfigSnapshot` object, so an effect depending on `snapshot` would re-run
   * on each save. Here that would re-ask main for versions that cannot have
   * changed.
   */
  const hasSnapshot = snapshot !== null;

  const refresh = useCallback(async (): Promise<void> => {
    setInfo(await readAppInfo());
  }, []);

  useEffect(() => {
    if (!hasSnapshot) return;

    let cancelled = false;
    void readAppInfo().then((next) => {
      if (!cancelled) setInfo(next);
    });

    return () => {
      cancelled = true;
    };
  }, [hasSnapshot]);

  if (!snapshot) {
    return (
      <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-5 py-4">
        <h2 className="text-[13px] text-ink">Advanced</h2>
        <p className="text-[11.5px] text-subtle">
          Diagnostics are only available in the desktop app.
        </p>
      </div>
    );
  }

  /**
   * Report what the reload found, from the snapshot it installed.
   *
   * Two steps rather than one, and the split is the whole point: `snapshot`
   * inside `onReload` is that render's closure and is by definition the
   * *pre*-reload value, so reading the count there would always describe the
   * config the user was already looking at. Setting a pending marker and
   * resolving it in an effect keyed on the snapshot means the sentence names
   * the file that was actually just read.
   */
  useEffect(() => {
    if (!pending || !snapshot) return;
    setPending(false);

    const problems = snapshot.errors.length;
    if (problems > 0) {
      setReloaded(
        `Reloaded — ${problems === 1 ? '1 problem' : `${problems} problems`}, listed above.`,
      );
      return;
    }

    const count = snapshot.projects.length;
    setReloaded(`Reloaded — ${count === 1 ? '1 project' : `${count} projects`}.`);
  }, [pending, snapshot]);

  const onReload = async (): Promise<void> => {
    await reloadProjectConfig();
    setPending(true);
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-5 py-4">
      <div className="flex flex-col gap-0.5">
        <h2 className="text-[13px] text-ink">Advanced</h2>
        <p className="text-[11.5px] text-subtle">
          The config file itself, and what this build is made of.
        </p>
      </div>

      <SettingsGroup
        title="Config file"
        description="Everything Settings writes goes in this one file, and it is meant to be hand-editable."
      >
        <p className="break-all font-mono text-[11.5px] text-muted">
          {snapshot.configPath}
        </p>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => void revealConfigFile()}
            className="flex w-fit items-center gap-1.5 rounded-md border border-border px-3 py-1.5 text-[12.5px] text-muted hover:bg-hover hover:text-ink"
          >
            <FolderOpen size={12} weight="bold" />
            {fileManager(info?.platform)}
          </button>
          <button
            type="button"
            onClick={() => void onReload()}
            className="flex w-fit items-center gap-1.5 rounded-md border border-border px-3 py-1.5 text-[12.5px] text-muted hover:bg-hover hover:text-ink"
          >
            <ArrowClockwise size={12} weight="bold" />
            Reload
          </button>
        </div>
        {reloaded === null ? (
          <p className="text-[11.5px] text-subtle">
            The file is deliberately not watched. Edit it by hand and reload
            here — a config that changed under a live session would leave the
            terminal already running in the old directory.
          </p>
        ) : (
          <p className="text-[11.5px] text-green">{reloaded}</p>
        )}
      </SettingsGroup>

      <SettingsGroup
        title="Reset"
        description="Put the file back to the commented template it started as."
      >
        {confirming ? (
          <ConfigResetConfirm
            projectCount={snapshot.projects.length}
            onCancel={() => setConfirming(false)}
            onConfirm={() => {
              setConfirming(false);
              void resetConfigToTemplate();
            }}
          />
        ) : (
          <button
            type="button"
            onClick={() => setConfirming(true)}
            className="w-fit rounded-md border border-border px-3 py-1.5 text-[12.5px] text-muted hover:bg-hover hover:text-ink"
          >
            Reset to template
          </button>
        )}
      </SettingsGroup>

      <SettingsGroup title="About" description="This build.">
        {info === null ? (
          <p className="text-[12.5px] text-subtle">Reading…</p>
        ) : (
          <div className="flex flex-col gap-1 rounded-[7px] border border-border-soft p-3">
            <Fact label="The Hive" value={info.version} />
            <Fact label="Electron" value={info.electron} />
            <Fact label="Chromium" value={info.chrome} />
            <Fact label="Node" value={info.node} />
            <Fact label="Platform" value={info.platform} />
          </div>
        )}
      </SettingsGroup>

      <SettingsGroup
        title="Diagnostics"
        description="Per-session flow control, and where to look when something goes wrong."
      >
        <div className="flex items-center justify-between gap-2">
          <p className="text-[11.5px] text-subtle">
            Counters are a snapshot, not a stream.
          </p>
          <button
            type="button"
            onClick={() => void refresh()}
            className="rounded-md border border-border px-2.5 py-1 text-[12px] text-muted hover:bg-hover hover:text-ink"
          >
            Refresh
          </button>
        </div>

        {info?.pty === undefined ? (
          <p className="text-[12.5px] text-subtle">
            No session has run yet, so there is nothing to count.
          </p>
        ) : (
          <PtyCounters rows={info.pty} />
        )}

        {info === null ? null : (
          <div className="flex flex-col gap-0.5 border-t border-border-soft pt-2">
            <p className="text-[12px] text-subtle">Log location</p>
            <p className="break-all font-mono text-[11.5px] text-muted">
              {info.logPath}
            </p>
            <p className="text-[11.5px] text-subtle">
              This app writes no log file — it logs to the terminal it was
              launched from. That directory is Electron&rsquo;s, and is where a
              crash report would land.
            </p>
          </div>
        )}
      </SettingsGroup>
    </div>
  );
}
```

One more block belongs in the returned tree, between the heading and the first
`SettingsGroup` — the snapshot's errors, rendered verbatim exactly as
`integrations-section.tsx` and `projects-section.tsx` both do. The reload
message above says "listed above" and this is what it means:

```tsx
      {snapshot.errors.map((error) => (
        <p
          key={error}
          className="rounded-[5px] border border-red px-2.5 py-1.5 text-[11.5px] text-red"
        >
          {error}
        </p>
      ))}
```

- [ ] **Step 4: Run the test**

Run: `cd app && pnpm test tests/features/settings/components/advanced-section.test.tsx`
Expected: PASS, 9 tests.

- [ ] **Step 5: Lint and type-check**

Run: `cd app && pnpm type-check && pnpm lint`

- [ ] **Step 6: Commit**

```bash
cd app && git add src/features/settings/components/advanced-section.tsx tests/features/settings/components/advanced-section.test.tsx
git commit -m "feat(107): the Advanced & diagnostics pane"
```

---

### Task 6: Wire the fifth nav entry

**Files:**
- Modify: `app/src/features/settings/components/settings-overlay.tsx` (`SECTIONS`, `PANES`, the doc comment at lines 35–45)
- Test: `app/tests/features/settings/components/settings-overlay.test.tsx` (extend)

**Interfaces:**
- Consumes: `AdvancedSection` from Task 5.
- Produces: nothing further.

- [ ] **Step 1: Write the failing test**

In `app/tests/features/settings/components/settings-overlay.test.tsx`, find the existing nav test (it asserts the four current section buttons) and extend it. Add:

```tsx
it('offers Advanced and switches to it', async () => {
  render(<SettingsOverlay />);

  const advanced = screen.getByRole('button', { name: 'Advanced' });
  expect(advanced).toBeInTheDocument();

  await userEvent.click(advanced);
  expect(advanced).toHaveAttribute('aria-current', 'page');
  expect(screen.getByRole('heading', { name: 'Advanced' })).toBeInTheDocument();
});
```

If the file has an assertion listing the exact section labels, add `'Advanced'` to it as the last entry.

- [ ] **Step 2: Run it and confirm it fails**

Run: `cd app && pnpm test tests/features/settings/components/settings-overlay.test.tsx`
Expected: FAIL — no button named Advanced.

- [ ] **Step 3: Implement**

In `app/src/features/settings/components/settings-overlay.tsx`:

Add the import, alphabetically first among the `@features` imports:

```ts
import { AdvancedSection } from '@features/settings/components/advanced-section';
```

Add to `SECTIONS`, last:

```ts
  { id: 'advanced', label: 'Advanced' },
```

Add to `PANES`:

```ts
  advanced: AdvancedSection,
```

Update the `SECTIONS` doc comment's last sentence — it currently predicts this
story in the future tense. Replace `and 107 fills the last slot the same way.`
with:

```
 * and 107 filled the last slot the same way — five rows, five entries in
 * `PANES`, and no control flow anywhere in this file.
```

- [ ] **Step 4: Run the test**

Run: `cd app && pnpm test tests/features/settings/components/settings-overlay.test.tsx`
Expected: PASS.

- [ ] **Step 5: Full unit suite with coverage**

Run: `cd app && pnpm test:coverage`
Expected: PASS, gate met. If a branch in `advanced-section.tsx` is uncovered, add the case to its test rather than an ignore comment.

- [ ] **Step 6: Lint and type-check**

Run: `cd app && pnpm type-check && pnpm lint`

- [ ] **Step 7: Commit**

```bash
cd app && git add src/features/settings/components/settings-overlay.tsx tests/features/settings/components/settings-overlay.test.tsx
git commit -m "feat(107): add Advanced to the settings nav"
```

---

### Task 7: E2E — the bridge surface and the reset round trip

**Files:**
- Modify: `app/tests/e2e/electron/security.spec.ts` (the exact `config` key-set assertion)
- Create: `app/tests/e2e/electron/advanced-settings.spec.ts`

**Interfaces:**
- Consumes: everything above.
- Produces: nothing further.

- [ ] **Step 1: Update the security spec**

`tests/e2e/electron/security.spec.ts` asserts the bridge's exact key sets and
will already be failing after Task 2. Find the `expect(surface.config).toEqual([…])`
assertion and add the two new keys in the same position they hold in
`BRIDGE_CONFIG_KEYS`, with a comment in the file's established voice:

```ts
    /**
     * Story 107 adds two verbs, and both take **no argument at all**.
     *
     * That is what makes widening the surface here acceptable: `revealConfig`
     * shows main's own `configPath()` in the file manager and `resetConfig`
     * rewrites that same file through the one guarded write path. Neither
     * accepts anything from the renderer, so there is no input to guard and no
     * way to aim either at a file main did not choose.
     */
    'revealConfig',
    'resetConfig',
```

Run: `cd app && pnpm desktop:build && pnpm test:e2e:electron -- security.spec.ts`
Expected: PASS.

- [ ] **Step 2: Write the round-trip spec**

Read `tests/e2e/electron/runtime-settings.spec.ts` first — it is the closest
model: it opens Settings, clicks a section, and asserts against a
`HIVE_CONFIG_PATH` sandbox. Copy its fixture import and launch shape exactly.

Create `app/tests/e2e/electron/advanced-settings.spec.ts`:

```ts
import { readFileSync } from 'node:fs';

import { expect, test } from './fixtures';

/**
 * Story 107, end to end.
 *
 * Reset is the only verb here worth driving through a real app: it writes the
 * user's file, and the thing that could go wrong — a torn or unreadable config
 * — is invisible to a unit test that mocks the bridge.
 *
 * Reveal is deliberately **not** driven. `shell.showItemInFolder` opens a real
 * Finder window on the machine running CI, which is not something to do to CI;
 * its contract is covered by the preload test and the security spec's key set.
 */
test('resetting from Advanced writes the template and empties the list', async ({
  app,
  page,
  configPath,
}) => {
  await page.getByRole('button', { name: /settings/i }).click();
  await page.getByRole('button', { name: 'Projects' }).click();

  // Whatever the fixture seeded, prove there is something to lose first.
  const before = JSON.parse(readFileSync(configPath, 'utf8')) as {
    projects: unknown[];
  };
  expect(before.projects.length).toBeGreaterThan(0);

  await page.getByRole('button', { name: 'Advanced' }).click();
  await expect(page.getByRole('heading', { name: 'Advanced' })).toBeVisible();
  await expect(page.getByText(configPath)).toBeVisible();

  await page.getByRole('button', { name: 'Reset to template' }).click();
  await page.getByRole('button', { name: 'Reset config' }).click();

  await expect
    .poll(() => (JSON.parse(readFileSync(configPath, 'utf8')) as { projects: unknown[] }).projects.length)
    .toBe(0);

  const after = JSON.parse(readFileSync(configPath, 'utf8')) as Record<string, unknown>;
  // Still the commented template, not a bare `{ projects: [] }`.
  expect(after['//']).toContain('The Hive');
  expect(after.version).toBe(2);

  await page.getByRole('button', { name: 'Projects' }).click();
  await expect(page.getByText(/no projects/i)).toBeVisible();

  // The About group read a real appInfo through a real bridge.
  await page.getByRole('button', { name: 'Advanced' }).click();
  await expect(page.getByText('Electron')).toBeVisible();
});
```

Adjust the fixture destructuring (`app`, `page`, `configPath`) to whatever
`tests/e2e/electron/fixtures` actually exposes — read it, do not guess. If the
fixture seeds no project, add one through the Projects pane first, or seed the
sandbox file in the spec before launching, whichever the existing specs do.

Also adjust the final "no projects" assertion to the empty-state copy
`projects-section.tsx` actually renders — read it rather than guessing.

- [ ] **Step 3: Run it**

Run: `cd app && pnpm desktop:build && pnpm test:e2e:electron -- advanced-settings.spec.ts`
Expected: PASS.

- [ ] **Step 4: Run the whole electron e2e project**

Run: `cd app && pnpm test:e2e:electron`
Expected: PASS. `settings.spec.ts` and `manage-projects.spec.ts` may assert the
section list — update them if so.

- [ ] **Step 5: Commit**

```bash
cd app && git add tests/e2e/electron/
git commit -m "test(107): e2e for the reset round trip and the widened bridge"
```

---

### Task 8: Full verification and the story record

**Files:**
- Modify: `stories/100-settings-epic.md` (mark 107 done in the story table if the file marks status; otherwise no change)
- Create: `stories/107-advanced-diagnostics.md`

**Interfaces:** none.

- [ ] **Step 1: Write the story file**

The ticket says `stories/107-*.md` "has not been written yet". Write it now, in the
shape of `stories/101-settings-add-local-project.md` — read that file first for the
header table, section order and voice. It records what shipped: the header table
(ID `HIVE-107`, epic, depends-on `101`, points 3, location), the problem, the
decisions (the two no-argument verbs, reset as the one non-preserving write, why
the log location is reported rather than built), the file-touch table, and the test
plan. Most of the substance is already written in
`docs/superpowers/specs/2026-08-04-107-advanced-diagnostics-design.md` — carry it
across rather than re-deriving it, and cut the reconciliation table, which is a
process artefact rather than a story record.

- [ ] **Step 2: Run every gate**

Run, each as its own command:

```bash
cd app && pnpm lint
cd app && pnpm type-check
cd app && pnpm test:coverage
cd app && pnpm verify:boundaries
cd app && pnpm build
cd app && pnpm test:e2e
```

Expected: all pass. `pnpm verify:boundaries` matters here because the new
component imports across `@features` / `@hooks` / `@lib` / `@shared`.

- [ ] **Step 3: Drive the built UI in a real browser**

The unit tests mock the bridge, so they prove plumbing and not rendering. Run
the built desktop app and look at the pane:

```bash
cd app && pnpm desktop:build && pnpm desktop:preview
```

Open Settings (`Cmd+,`) → Advanced and confirm, by eye: the config path is
readable and does not overflow its column; both buttons sit on one line; Reload
reports a count; Reset shows the red confirmation inline without the overlay
closing on Escape; the About rows align; the log-location paragraph reads
honestly. Fix anything that does not, then re-run `pnpm test:e2e:electron`.

- [ ] **Step 4: Commit**

```bash
git add stories/
git commit -m "docs(107): story record for Advanced & diagnostics"
```

---

## Self-review

**Spec coverage.** Reveal → Tasks 2, 5. Reload → Task 5 (verb already existed).
Reset → Tasks 1, 2, 3, 4, 5, 7. Versions → Tasks 2, 3, 5. PTY diagnostics →
Task 5. Log location → Tasks 2, 5. Nav entry → Task 6. Security key set →
Task 7. Story file → Task 8.

**Placeholders.** None. Every step carries the code it asks for. Task 7 tells the
implementer to read the e2e fixture rather than guess its shape, and Task 8 to
read `101-settings-add-local-project.md` for the story-file shape — both are
genuine unknowns in existing files, not deferred decisions.

**Type consistency.** `revealConfigFile` / `resetConfigToTemplate` / `readAppInfo`
are named identically in Tasks 3 and 5. `resetConfig` is the main-side function
(Task 1), the bridge verb (Task 2) and the channel `config:reset` — the same name
at each layer, matching how `setNotifications` already spans all three.
`ConfigResetConfirm`'s props in Task 4 match its call site in Task 5.
`AppInfo.logPath` is added in Task 2 and read in Task 5.
