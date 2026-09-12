import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { PlanRail } from '@features/plan/components/plan-rail';
import type { PlanTaskStatus, SessionPlan } from '@shared/plan-contract';

const STATUSES: PlanTaskStatus[] = [
  'completed',
  'completed',
  'completed',
  'in_progress',
  'pending',
  'pending',
  'pending',
];

const plan = (over: Partial<SessionPlan> = {}): SessionPlan => ({
  entityId: 'sess-01',
  source: 'task-tools',
  allDone: false,
  tasks: STATUSES.map((status, index) => ({
    id: String(index + 1),
    title: `Task number ${String(index + 1)} with a long enough name to truncate`,
    status,
  })),
  ...over,
});

/**
 * The glyph rail (HIVE-181): 34px at rest, a 232px drawer that peeks over the
 * terminal on hover or focus (CSS only, so happy-dom asserts the classes), and
 * a pin that docks it.
 */
describe('PlanRail', () => {
  it('summarises the plan on one button, with a glyph per task', () => {
    render(<PlanRail plan={plan()} pinned={false} onPinnedChange={vi.fn()} />);

    const rail = screen.getByRole('button', { name: 'Plan, 3 of 7 done' });
    expect(rail).toHaveTextContent('3/7');
    // The button's label carries the summary; its glyphs are not read twice.
    expect(within(rail).queryAllByRole('img')).toHaveLength(0);
    expect(rail.querySelectorAll('[role="img"]')).toHaveLength(7);
  });

  it('keeps the drawer in the DOM, shown only on hover or focus, over the terminal', () => {
    const { container } = render(<PlanRail plan={plan()} pinned={false} onPinnedChange={vi.fn()} />);

    const drawer = screen.getByRole('region', { name: 'Plan' });
    expect(drawer.className).toContain('hidden');
    expect(drawer.className).toContain('group-hover:block');
    expect(drawer.className).toContain('group-focus-within:block');
    expect(drawer.className).toContain('absolute');
    expect(container.firstElementChild?.className).toContain('w-[34px]');
  });

  it('focusing the rail puts focus inside the group that shows the drawer', async () => {
    const { container } = render(<PlanRail plan={plan()} pinned={false} onPinnedChange={vi.fn()} />);

    await userEvent.tab();

    expect(container.firstElementChild?.contains(document.activeElement)).toBe(true);
  });

  it('lists every task by name, truncated, with the full name in its title', () => {
    render(<PlanRail plan={plan()} pinned={false} onPinnedChange={vi.fn()} />);

    const rows = within(screen.getByRole('region', { name: 'Plan' })).getAllByRole('listitem');
    expect(rows).toHaveLength(7);
    expect(rows[3]).toHaveAttribute('title', 'Task number 4 with a long enough name to truncate');
    expect(within(rows[3] as HTMLElement).getByText(/Task number 4/).className).toContain('truncate');
    expect(within(rows[3] as HTMLElement).getByRole('img', { name: 'Task 4, in progress' })).toBeInTheDocument();
  });

  it('pins from the drawer header', async () => {
    const onPinnedChange = vi.fn();
    render(<PlanRail plan={plan()} pinned={false} onPinnedChange={onPinnedChange} />);

    const pin = screen.getByRole('button', { name: 'Pin plan' });
    expect(pin).toHaveAttribute('aria-pressed', 'false');
    await userEvent.click(pin);

    expect(onPinnedChange).toHaveBeenCalledWith(true);
  });

  it('pinned, docks the drawer at 232px and drops the glyph column', async () => {
    const onPinnedChange = vi.fn();
    const { container } = render(<PlanRail plan={plan()} pinned onPinnedChange={onPinnedChange} />);

    const unpin = screen.getByRole('button', { name: 'Unpin plan' });
    expect(unpin).toHaveAttribute('aria-pressed', 'true');
    expect(screen.queryByRole('button', { name: /^Plan,/ })).toBeNull();
    const drawer = screen.getByRole('region', { name: 'Plan' });
    expect(drawer.className).not.toContain('absolute');
    expect(drawer.className).not.toContain('hidden');
    expect(container.firstElementChild?.className).toContain('w-[232px]');

    await userEvent.click(unpin);
    expect(onPinnedChange).toHaveBeenCalledWith(false);
  });

  it('says "all done" once no task is left', () => {
    const tasks = plan().tasks.map((task) => ({ ...task, status: 'completed' as const }));
    render(<PlanRail plan={plan({ tasks, allDone: true })} pinned={false} onPinnedChange={vi.fn()} />);

    expect(screen.getByRole('button', { name: 'Plan, all done' })).toBeInTheDocument();
    expect(within(screen.getByRole('region', { name: 'Plan' })).getByText('all done')).toBeInTheDocument();
  });

  it("reads a plan-mode plan's tasks as proposed", () => {
    const tasks = plan().tasks.map((task) => ({ ...task, status: 'pending' as const }));
    render(<PlanRail plan={plan({ source: 'plan-mode', tasks })} pinned={false} onPinnedChange={vi.fn()} />);

    const drawer = screen.getByRole('region', { name: 'Plan' });
    expect(within(drawer).getByRole('img', { name: 'Task 1, proposed' })).toBeInTheDocument();
  });
});
