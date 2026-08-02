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
  { id: 'beta', label: 'Beta', badgeCount: 4, badgeLabel: 'widgets' },
  { id: 'gamma', label: 'Gamma', badgeCount: 0 },
];

describe('TabBar', () => {
  it('renders one tab per item, in order', () => {
    render(
      <TabBar tabs={TABS} active="alpha" onSelect={vi.fn()} label="Sections" />,
    );

    expect(
      screen.getAllByRole('tab').map((tab) => tab.getAttribute('id')),
    ).toEqual(['tab-alpha', 'tab-beta', 'tab-gamma']);
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

    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(onSelect).toHaveBeenCalledWith('gamma');
  });

  /** `Badge` renders nothing at zero, so an empty count adds no visual noise. */
  it('shows a badge only for a positive count', () => {
    render(
      <TabBar tabs={TABS} active="alpha" onSelect={vi.fn()} label="Sections" />,
    );

    expect(screen.getByText('4')).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Gamma' })).toHaveTextContent(
      /^Gamma$/,
    );
    expect(screen.getByRole('tab', { name: 'Alpha' })).toHaveTextContent(
      /^Alpha$/,
    );
  });

  /**
   * A tab's accessible name comes from its content, not from an `aria-label`,
   * so an unlabelled badge would be `aria-hidden` and the count would reach
   * nobody using a screen reader — the number is visible but unannounced.
   */
  it('folds the badge count into the tab’s accessible name', () => {
    render(
      <TabBar tabs={TABS} active="alpha" onSelect={vi.fn()} label="Sections" />,
    );

    expect(
      screen.getByRole('tab', { name: 'Beta 4 widgets' }),
    ).toBeInTheDocument();
  });

  it('names the tablist for screen readers', () => {
    render(
      <TabBar tabs={TABS} active="alpha" onSelect={vi.fn()} label="Sections" />,
    );

    expect(
      screen.getByRole('tablist', { name: 'Sections' }),
    ).toBeInTheDocument();
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

  it('forwards a className onto the tablist', () => {
    render(
      <TabBar
        tabs={TABS}
        active="alpha"
        onSelect={vi.fn()}
        label="Sections"
        className="shrink-0"
      />,
    );

    expect(screen.getByRole('tablist')).toHaveClass('shrink-0');
  });

  /**
   * The activity rail's unread count is an alarm, not an inventory: it means
   * agents are blocked on the user. The left rail's work count is neutral.
   */
  it('lets a tab ask for a louder badge', () => {
    render(
      <TabBar
        tabs={[
          {
            id: 'delta',
            label: 'Delta',
            badgeCount: 3,
            badgeLabel: 'blocked things',
            badgeTone: 'danger',
          },
        ]}
        active="delta"
        onSelect={vi.fn()}
        label="Sections"
      />,
    );

    // A labelled badge puts the digit in an inner `aria-hidden` span, so the
    // fill lives on its parent.
    expect(screen.getByText('3').parentElement).toHaveClass('bg-danger-solid');
  });

  it('defaults to the quiet badge', () => {
    render(
      <TabBar tabs={TABS} active="alpha" onSelect={vi.fn()} label="Sections" />,
    );

    expect(screen.getByText('4').parentElement).toHaveClass('bg-chip');
  });
});
