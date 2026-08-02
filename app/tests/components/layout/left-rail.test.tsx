import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it } from 'vitest';

import { LeftRail } from '@components/layout/left-rail';
import { useHiveStore } from '@stores/hive-store';
import { useUiStore } from '@stores/ui-store';

const panel = (container: HTMLElement, name: string) =>
  container.querySelector(`[data-panel="${name}"]`);

const rail = () =>
  screen.getByRole('navigation', { name: 'Projects, work, and agents' });

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

    // The count is part of the tab's accessible name, not just visible text —
    // a tab is named by its content, so an unannounced badge would be lost.
    expect(
      screen.getAllByRole('tab').map((tab) => tab.getAttribute('aria-label')),
    ).toEqual([null, null, null]);
    expect(screen.getByRole('tab', { name: 'Projects' })).toBeInTheDocument();
    expect(
      screen.getByRole('tab', { name: 'Work 8 work items' }),
    ).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Agents' })).toBeInTheDocument();
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
   * `collapsed` lives in the ui-store rather than in a panel's `useState` —
   * the panel unmounts on every tab switch.
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
   * owns the scrollbar. Scrolling the rail as a whole would push the tabs
   * off-screen as soon as a project tree grew — taking away the one control the
   * user needs to get back out of it. happy-dom does no layout, so assert the
   * contract on the class list.
   */
  it('scrolls the panel, not the tab bar', () => {
    render(<LeftRail />);

    expect(screen.getByRole('tablist')).toHaveClass('shrink-0');
    expect(screen.getByRole('tabpanel')).toHaveClass(
      'min-h-0',
      'flex-1',
      'overflow-y-auto',
    );
    expect(rail()).not.toHaveClass('overflow-y-auto');
  });

  it('keeps the rail at its fixed 268px', () => {
    render(<LeftRail />);

    expect(rail()).toHaveClass('w-[268px]', 'shrink-0');
  });
});
