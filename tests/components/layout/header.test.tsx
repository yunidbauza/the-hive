import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { Header } from '@components/layout/header';
import { resetProjectConfig, setProjectConfigForTest } from '@lib/project-config';
import { emptySnapshot } from '@shared/config-contract';
import { useAppearanceStore } from '@stores/appearance-store';
import { useHiveStore } from '@stores/hive-store';
import { useUiStore } from '@stores/ui-store';

import { notif } from '../../support/notifications';
import { seedDemoFleet } from '@tests/support/demo-fleet';

/**
 * The one seam the exposure chip's sub-tests below need mocked: `readAppInfo`
 * (HIVE-134). Everything else in `@lib/project-config` stays real, the same
 * split `advanced-section.test.tsx` and `use-project-config.test.tsx` make —
 * `ExposureChip` reads the receiver's *running* bind through this function,
 * never through `setProjectConfigForTest`'s snapshot, so a widened-bind test
 * that only installed a snapshot (the old, config-derived shape of this test)
 * would now assert on a chip with nothing to render. Defaults to resolving
 * `null`, matching what a real, un-mocked bridge would answer in this
 * environment (there is no `window.hive` in jsdom), so every test in this
 * file *except* the ones that override it behaves exactly as before.
 */
const readAppInfo = vi.fn();
vi.mock('@/lib/project-config', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/project-config')>();
  return { ...actual, readAppInfo: () => readAppInfo() };
});

/**
 * The header only composes — the three sub-components are asserted in their own
 * files. What is pinned here is the wiring: which zones are present, and what
 * the four controls do to the stores.
 */
describe('Header', () => {
  beforeEach(() => {
    document.body.removeAttribute('data-theme');
    localStorage.clear();
    useHiveStore.getState().reset();
    seedDemoFleet();
    useUiStore.getState().reset();
    readAppInfo.mockReset();
    readAppInfo.mockResolvedValue(null);
    /**
     * Pinned to dark rather than left on the story-105 default of `system`.
     * `system` resolves against `prefers-color-scheme`, which the test
     * environment answers for us — so leaving it would make the header's label
     * depend on happy-dom's media-query default rather than on the header.
     */
    useAppearanceStore.getState().reset();
    useAppearanceStore.getState().setTheme('dark');
  });

  afterEach(() => {
    // The real `@lib/project-config` module is a module-level singleton, so a
    // snapshot one test installs would otherwise leak into whichever test runs
    // next in this file.
    resetProjectConfig();
  });

  it('renders as the page banner at the fixed 56px height', () => {
    render(<Header />);

    const banner = screen.getByRole('banner');
    expect(banner).toBeInTheDocument();
    expect(banner).toHaveClass('h-14', 'shrink-0');
  });

  it('composes every zone', () => {
    useUiStore.setState({ activeTab: 'hero-refresh' });

    render(<Header />);

    expect(screen.getByText('The Hive')).toBeInTheDocument();
    expect(screen.getByText(/Opus 4.5 · high/)).toBeInTheDocument();
    expect(screen.getByText('4 working')).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'Switch to light theme' }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: /Inbox — nothing unread/ }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'New session' }),
    ).toBeInTheDocument();
  });

  /**
   * happy-dom performs no layout, so "does it line up with the rail?" is
   * unanswerable here — `chip-alignment.spec.ts` measures the boxes in a real
   * browser. What unit tests can pin is the structure that produces the
   * alignment: **three** zones since HIVE-79 — brand-and-chips, the counts,
   * and a control cluster that claims the activity rail's width so the counts
   * beside it end on the rail's edge — plus a brand wrapper that claims the
   * left rail's width so the chips start on that one.
   */
  describe('rail-aligned zones', () => {
    it('lays out as three zones, with both chips in the left one', () => {
      useUiStore.setState({ activeTab: 'hero-refresh' });

      render(<Header />);

      const banner = screen.getByRole('banner');
      // Flex, not a grid: nothing is centred any more, so the equal-track
      // machinery that existed to find the true midpoint is gone.
      expect(banner).toHaveClass('flex');
      expect(banner).not.toHaveClass('grid');

      const [left, counts, controls] = Array.from(banner.children);
      expect(banner.children).toHaveLength(3);
      expect(left).toHaveTextContent('The Hive');
      expect(left).toHaveTextContent(/Opus 4.5 · high/);

      /*
        The counts are their own zone now, and the controls no longer contain
        them. That separation is the whole mechanism: the control cluster
        claims the rail's width, so the counts' right edge is the rail's line.
      */
      expect(counts).toHaveTextContent('4 working');
      expect(controls).not.toHaveTextContent('4 working');
      expect(controls).toHaveTextContent('New session');
    });

    /**
     * The header itself must carry no row gap, or every zone boundary would sit
     * 14px away from the line it is supposed to land on.
     */
    it('spaces its zones without a row gap', () => {
      render(<Header />);

      expect(screen.getByRole('banner')).not.toHaveClass('gap-[14px]');
    });

    it('gives the controls the activity rail’s width, so the counts end on its edge', () => {
      useUiStore.setState({ activeTab: 'hero-refresh' });

      render(<Header />);

      const controls = screen.getByRole('banner').children[2];
      // A calc over the token, not a literal: the rail is 316px comfortable and
      // 276px compact, and a hardcoded number would be wrong in one of them.
      // The `-open` token specifically — see the collapsed case below.
      expect(controls).toHaveClass('w-[calc(var(--cc-rail-w-right-open)-1rem)]');
    });

    /**
     * With the rail unmounted there is no border to align to, so the cluster
     * drops its width and the counts are simply flush right — the layout this
     * header had before HIVE-79.
     */
    it('drops that width when the activity rail is hidden', () => {
      useUiStore.setState({ showActivityRail: false });

      render(<Header />);

      const controls = screen.getByRole('banner').children[2];
      expect(controls).not.toHaveClass('w-[calc(var(--cc-rail-w-right-open)-1rem)]');
    });

    /**
     * A **collapsed** rail keeps the column, and that is the whole point of
     * the `-open` token.
     *
     * Both other answers were tried and are wrong. Sizing from the plain
     * `--cc-rail-w-right`, which collapse paints at 44px, left a `shrink-0`
     * box of ~262px of buttons overflowing a 28px column onto the counts.
     * Dropping the column instead — the flush-right fallback the hidden case
     * takes — let the cluster shrink to its content, so the counts slid 31px
     * right and ended flush against the theme button.
     *
     * `--cc-rail-w-right-open` is the rail's width with collapse ignored, so
     * the column is the same in both states and nothing in the header moves
     * when a rail is toggled. Hidden is still the one case that drops it,
     * which is what the test above pins.
     */
    it('keeps the claimed column when the activity rail is collapsed', () => {
      useUiStore.setState({ activeTab: 'hero-refresh', showActivityRail: true });
      useAppearanceStore.getState().setRailCollapsed('right', true);

      render(<Header />);

      const controls = screen.getByRole('banner').children[2];
      expect(controls).toHaveClass('w-[calc(var(--cc-rail-w-right-open)-1rem)]');
    });

    it('gives the brand exactly the rail’s width, so the chips start on its edge', () => {
      useUiStore.setState({ activeTab: 'hero-refresh' });

      render(<Header />);

      /*
        The rail's own token minus the header's px-4 — not a pixel literal,
        which was right at comfortable density and 20px wrong at compact, and
        wrong by the drag after any drag. The real geometry is measured in
        chip-alignment.spec.ts; this pins the mechanism so a refactor cannot
        quietly put a number back.
      */
      const [left] = Array.from(screen.getByRole('banner').children);
      expect(left.firstElementChild).toHaveClass(
        'w-[calc(var(--cc-rail-w-left-open)-1rem)]',
        'shrink-0',
      );
    });

    /**
     * A collapsed left rail keeps the column too — the mirror of the activity
     * rail's case above, and for the same reason.
     *
     * Dropping it let the brand zone shrink to the wordmark, which put the
     * chips flush against the logo: the measured gap went from 168px to zero.
     * Sizing from the plain token instead would have claimed 28px for a
     * wordmark that does not fit in it. `--cc-rail-w-left-open` is the width
     * with collapse ignored, so the chips start on the same line either way.
     */
    it('keeps the claimed width when the left rail is collapsed', () => {
      useUiStore.setState({ activeTab: 'hero-refresh' });
      useAppearanceStore.getState().setRailCollapsed('left', true);

      render(<Header />);

      const [left] = Array.from(screen.getByRole('banner').children);
      expect(left.firstElementChild).toHaveClass(
        'w-[calc(var(--cc-rail-w-left-open)-1rem)]',
        'shrink-0',
      );
    });

    /**
     * The chip is conditional on a session being active. In a flex row its
     * absence simply closes the gap — there is no empty track to keep, which
     * is the simplification that dropping the grid bought.
     */
    it('closes the gap when the chip is absent instead of leaving a hole', () => {
      render(<Header />);

      const banner = screen.getByRole('banner');
      expect(banner.children).toHaveLength(3);
      expect(banner.children[0]).toHaveTextContent('The Hive');
      expect(banner.children[0]).not.toHaveTextContent(/Opus 4.5/);
      expect(banner.children[1]).toHaveTextContent('4 working');
    });
  });

  it('drops the model chip on the orchestrator tab but keeps everything else', () => {
    render(<Header />);

    expect(screen.queryByText(/Opus 4.5/)).not.toBeInTheDocument();
    expect(screen.getByText('The Hive')).toBeInTheDocument();
    expect(screen.getByText('4 working')).toBeInTheDocument();
  });

  describe('theme toggle', () => {
    it('offers the opposite theme and flips it', async () => {
      const user = userEvent.setup();
      render(<Header />);

      await user.click(
        screen.getByRole('button', { name: 'Switch to light theme' }),
      );

      expect(useAppearanceStore.getState().theme).toBe('light');
      expect(document.body.getAttribute('data-theme')).toBe('light');
      expect(
        screen.getByRole('button', { name: 'Switch to dark theme' }),
      ).toBeInTheDocument();
    });
  });

  describe('inbox bell', () => {
    it('shows the exact unread count, and names it on the button itself', () => {
      useHiveStore
        .getState()
        .hydrateNotifs([
          notif({ id: 'a' }),
          notif({ id: 'b' }),
          notif({ id: 'c' }),
        ]);
      render(<Header />);

      expect(screen.getByText('3')).toBeInTheDocument();
      // The badge is decoration here; the button's label carries the meaning.
      expect(
        screen.getByRole('button', { name: 'Inbox — 3 unread' }),
      ).toBeInTheDocument();
    });

    /**
     * The bell **shows** the inbox and leaves the count alone (HIVE-93).
     *
     * It used to mark everything read, which is the one action that destroys the
     * information the badge carries — from a control whose icon promises
     * navigation. A user reaching for the bell to see what happened wiped the
     * record of what happened.
     */
    it('opens the Inbox tab without touching the unread count', async () => {
      const user = userEvent.setup();
      useUiStore.setState({ railTab: 'prs', showActivityRail: false });
      useHiveStore
        .getState()
        .hydrateNotifs([
          notif({ id: 'a' }),
          notif({ id: 'b' }),
          notif({ id: 'c' }),
        ]);
      render(<Header />);

      await user.click(screen.getByRole('button', { name: 'Inbox — 3 unread' }));

      expect(useUiStore.getState().railTab).toBe('inbox');
      // And it reveals the rail, or the tab it selected would be off screen.
      expect(useUiStore.getState().showActivityRail).toBe(true);

      // Nothing was read: the badge still says 3, and every row is still unread.
      expect(
        useHiveStore.getState().notifs.every((notif) => notif.unread),
      ).toBe(true);
      expect(screen.getByText('3')).toBeInTheDocument();
    });

    it('still names itself when there is nothing unread', () => {
      render(<Header />);

      expect(
        screen.getByRole('button', { name: 'Inbox — nothing unread' }),
      ).toBeInTheDocument();
    });

    /**
     * On a collapsed rail, `revealRailTab` alone selects a tab nobody can see —
     * visibly nothing happens. The bell must also clear the collapse flag.
     */
    it('un-collapses the activity rail when the bell is clicked', async () => {
      const user = userEvent.setup();
      useAppearanceStore.getState().setRailCollapsed('right', true);

      render(<Header />);
      await user.click(screen.getByRole('button', { name: /inbox/i }));

      expect(useAppearanceStore.getState().railCollapsedRight).toBe(false);
      expect(useUiStore.getState().railTab).toBe('inbox');
    });
  });

  describe('New session', () => {
    it('keeps the button the only exact "New session", beside a terminal chevron', () => {
      render(<Header />);
      expect(screen.getAllByRole('button', { name: 'New session' })).toHaveLength(1);
      expect(
        screen.getByRole('button', { name: 'Terminal in a project' }),
      ).toBeInTheDocument();
    });

    it('opens the picker', async () => {
      const user = userEvent.setup();
      render(<Header />);

      await user.click(screen.getByRole('button', { name: 'New session' }));

      expect(useUiStore.getState().picker).toBe(true);
    });

    it('clears any stale query as it opens', async () => {
      const user = userEvent.setup();
      useUiStore.setState({ pickerQuery: 'nova' });
      render(<Header />);

      await user.click(screen.getByRole('button', { name: 'New session' }));

      expect(useUiStore.getState().pickerQuery).toBe('');
    });
  });

  describe('the settings gear (story 101)', () => {
    it('offers a way into settings', () => {
      render(<Header />);

      expect(screen.getByRole('button', { name: 'Settings' })).toBeInTheDocument();
    });

    it('opens settings when pressed', async () => {
      const user = userEvent.setup();
      render(<Header />);

      await user.click(screen.getByRole('button', { name: 'Settings' }));

      expect(useUiStore.getState().settings).toBe(true);
    });

    /**
     * The header is the window drag handle on desktop, so every control in it
     * needs the no-drag escape or it cannot be clicked at all.
     */
    it('is clickable despite sitting in the drag region', () => {
      render(<Header />);

      expect(
        screen.getByRole('button', { name: 'Settings' }).className,
      ).toContain('[-webkit-app-region:no-drag]');
    });
  });

  /**
   * `ExposureChip`'s own states — loopback renders nothing, a widened bind
   * names the address — belong to its own spec. What is pinned here is that it
   * is actually mounted in the `header-chips` cluster, after `DemoChip`
   * (HIVE-134). Not proven against `ModelChip` too: these tests render on the
   * default tab, where `ModelChip` itself renders `null` (see "drops the
   * model chip on the orchestrator tab" above), so there is nothing of
   * `ModelChip`'s in the cluster for an ordering assertion to compare against.
   *
   * The chip is sourced from the receiver's **running** bind, read through
   * `readAppInfo` — see the mock at the top of this file — never from
   * `setProjectConfigForTest`'s snapshot; a config-only snapshot install here
   * would exercise nothing the chip actually reads.
   */
  describe('the exposure chip (HIVE-134)', () => {
    /*
      No `setProjectConfigForTest` call here, so `useProjectConfig()` returns
      `null` — the same "no bridge" state the browser demo starts in — and
      `useReceiverExposure`'s gate means `readAppInfo` is never even called.
      This is not a loopback-bind scenario at all despite the old title's
      claim: it never installs a snapshot, so it cannot distinguish "bound
      loopback" from "bound nowhere." That case is already covered by
      `use-project-config.test.tsx`'s `useReceiverExposure` suite and by
      `receiver.test.ts`'s own guard coverage; what this test actually pins is
      the header's wiring — that the cluster renders nothing for the chip when
      there is no config snapshot to read at all.
    */
    it('is absent from the chips cluster when there is no config snapshot', () => {
      render(<Header />);

      const chips = screen.getByTestId('header-chips');
      expect(chips).not.toHaveTextContent('172.17.0.1');
    });

    it('joins the cluster, after DemoChip, once the running bind widens', async () => {
      // A real snapshot, because `useReceiverExposure` gates its `readAppInfo`
      // fetch on one resolving — see its own doc comment for why, and
      // `use-project-config.test.tsx` for the "no snapshot" case this gate
      // produces.
      setProjectConfigForTest(emptySnapshot('/Users/dev/.hive/config.json'));
      readAppInfo.mockResolvedValue({
        version: '0.1.0',
        electron: '38.0.0',
        chrome: '140.0.0',
        node: '22.0.0',
        platform: 'darwin',
        logPath: '/Users/dev/Library/Logs/The Hive',
        receiverBoundHost: '172.17.0.1',
      });

      render(<Header />);

      const chips = screen.getByTestId('header-chips');
      await waitFor(() => expect(chips).toHaveTextContent('172.17.0.1'));

      const names = Array.from(chips.children).map((child) => child.textContent);
      expect(names.indexOf('172.17.0.1')).toBeGreaterThan(names.indexOf('demo'));
    });
  });

  /**
   * `ServingChip`'s own states — same shape as `ExposureChip`'s block above,
   * for the same reason: its render logic belongs to its own spec, and what
   * is pinned here is only that it is actually mounted in the `header-chips`
   * cluster, after `ExposureChip` (HIVE-142).
   *
   * Sourced from the server-mode socket's **running** bind, read through the
   * same `readAppInfo` mock — see the mock at the top of this file — never
   * from `setProjectConfigForTest`'s snapshot.
   */
  describe('the serving chip (HIVE-142)', () => {
    /*
      No `setProjectConfigForTest` call here, so `useProjectConfig()` returns
      `null` and `useServerExposure`'s gate means `readAppInfo` is never even
      called — the same "no bridge" state `ExposureChip`'s absence test above
      exercises.
    */
    it('is absent from the chips cluster when there is no config snapshot', () => {
      render(<Header />);

      const chips = screen.getByTestId('header-chips');
      expect(chips).not.toHaveTextContent('100.101.102.103');
    });

    it('joins the cluster, after ExposureChip, once the server socket binds', async () => {
      // A real snapshot, because `useServerExposure` gates its `readAppInfo`
      // fetch on one resolving — see its own doc comment for why.
      setProjectConfigForTest(emptySnapshot('/Users/dev/.hive/config.json'));
      // Both fields bound at once, so the ordering assertion below actually
      // compares two rendered chips rather than one chip against a `demo`
      // text node that happens to sit earlier in the cluster.
      readAppInfo.mockResolvedValue({
        version: '0.1.0',
        electron: '38.0.0',
        chrome: '140.0.0',
        node: '22.0.0',
        platform: 'darwin',
        logPath: '/Users/dev/Library/Logs/The Hive',
        receiverBoundHost: '172.17.0.1',
        serverBoundHost: '100.101.102.103',
        servingDeviceCount: 2,
        attachedServerName: null,
  serving: false,
      });

      render(<Header />);

      const chips = screen.getByTestId('header-chips');
      await waitFor(() => expect(chips).toHaveTextContent('serving · 2 devices'));

      const names = Array.from(chips.children).map((child) => child.textContent);
      expect(names.indexOf('serving · 2 devices')).toBeGreaterThan(
        names.indexOf('172.17.0.1'),
      );
    });
  });

  /**
   * `AttachedChip`'s own states belong to its own spec; what is pinned here
   * is only that it is actually mounted in the `header-chips` cluster, after
   * `ServingChip` (HIVE-144, Task 13) — the same shape the exposure and
   * serving blocks above use.
   */
  describe('the attached chip (HIVE-144)', () => {
    it('is absent from the chips cluster when there is no config snapshot', () => {
      render(<Header />);

      const chips = screen.getByTestId('header-chips');
      expect(chips).not.toHaveTextContent('attached ·');
    });

    it('joins the cluster, after ServingChip, once this window attaches', async () => {
      setProjectConfigForTest(emptySnapshot('/Users/dev/.hive/config.json'));
      readAppInfo.mockResolvedValue({
        version: '0.1.0',
        electron: '38.0.0',
        chrome: '140.0.0',
        node: '22.0.0',
        platform: 'darwin',
        logPath: '/Users/dev/Library/Logs/The Hive',
        receiverBoundHost: null,
        serverBoundHost: '100.101.102.103',
        servingDeviceCount: 2,
        attachedServerName: 'mini',
      });

      render(<Header />);

      const chips = screen.getByTestId('header-chips');
      await waitFor(() => expect(chips).toHaveTextContent('attached · mini'));

      const names = Array.from(chips.children).map((child) => child.textContent);
      expect(names.indexOf('attached · mini')).toBeGreaterThan(
        names.indexOf('serving · 2 devices'),
      );
    });
  });

  /**
   * The two facts this task adds together (HIVE-144, Task 13) — proven both
   * ways, not just as "the row is non-empty": a header that rendered one
   * chip twice, or collapsed both into one node, would still make the row
   * non-empty.
   */
  describe('serving and attached together', () => {
    it('shows both chips when serving and attached at once', async () => {
      setProjectConfigForTest(emptySnapshot('/Users/dev/.hive/config.json'));
      readAppInfo.mockResolvedValue({
        version: '0.1.0',
        electron: '38.0.0',
        chrome: '140.0.0',
        node: '22.0.0',
        platform: 'darwin',
        logPath: '/Users/dev/Library/Logs/The Hive',
        receiverBoundHost: null,
        serverBoundHost: '100.101.102.103',
        servingDeviceCount: 2,
        attachedServerName: 'mini',
      });

      render(<Header />);

      const chips = screen.getByTestId('header-chips');
      await waitFor(() => expect(chips).toHaveTextContent('attached · mini'));

      // Both present, as two distinct child nodes — not one node carrying
      // both strings concatenated, and not one chip standing in for both.
      const names = Array.from(chips.children).map((child) => child.textContent);
      expect(names).toContain('serving · 2 devices');
      expect(names).toContain('attached · mini');
      expect(names.filter((name) => name === 'serving · 2 devices' || name === 'attached · mini')).toHaveLength(2);
    });

    /*
      Local mode at the default bind: every one of the three remote-attach
      chips reads a fact that is genuinely off here, not merely a snapshot
      that never resolved — the "no config snapshot" tests above already
      cover that weaker case. The positive control is the test just above:
      it proves this same `readAppInfo` mock and the same `header-chips`
      query can and do surface these two chips' text when the facts are on,
      so this test's silence cannot be explained by a broken query or a
      component that always renders nothing.
    */
    it('shows no chip in local mode at the default bind', async () => {
      setProjectConfigForTest(emptySnapshot('/Users/dev/.hive/config.json'));
      readAppInfo.mockResolvedValue({
        version: '0.1.0',
        electron: '38.0.0',
        chrome: '140.0.0',
        node: '22.0.0',
        platform: 'darwin',
        logPath: '/Users/dev/Library/Logs/The Hive',
        receiverBoundHost: null,
        serverBoundHost: null,
        servingDeviceCount: 0,
        attachedServerName: null,
  serving: false,
      });

      render(<Header />);

      // Waited on directly rather than via `waitFor(toHaveTextContent(...))`:
      // there is nothing here to wait to *appear*, so this instead drains the
      // same `readAppInfo` microtask the positive test above resolves before
      // asserting, or a genuinely broken assertion could pass on a render
      // that simply hadn't finished its effects yet.
      await act(async () => {
        await Promise.resolve();
      });

      const chips = screen.getByTestId('header-chips');
      expect(chips).not.toHaveTextContent('serving ·');
      expect(chips).not.toHaveTextContent('attached ·');
      expect(chips).not.toHaveTextContent(/\d\.\d+\.\d+\.\d+/);
    });
  });
});
