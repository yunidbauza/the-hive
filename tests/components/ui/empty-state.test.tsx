import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { EmptyState, EmptyStatePath } from '@components/ui/empty-state';

/**
 * The atom the rail panels use to say why they have nothing to list.
 *
 * It exists because "empty" stopped being a state that only happened in tests:
 * the store used to boot pre-populated, so a fresh install never saw a blank
 * panel. It does now, and a blank column is indistinguishable from a panel that
 * failed to render.
 */
describe('EmptyState', () => {
  it('states what is missing', () => {
    render(<EmptyState>No projects yet.</EmptyState>);

    expect(screen.getByText('No projects yet.')).toBeInTheDocument();
  });

  /**
   * The shape the copy is supposed to take: what is missing, then the way out.
   * A bare "No projects" reports a state without offering an exit.
   */
  it('puts the action in the same sentence when there is one', () => {
    render(
      <EmptyState action={<EmptyStatePath>Settings → Projects</EmptyStatePath>}>
        No projects yet.
      </EmptyState>,
    );

    const paragraph = screen.getByText(/No projects yet/);

    expect(paragraph).toHaveTextContent('No projects yet. Settings → Projects');
  });

  it('renders without an action, for a state with no way out', () => {
    render(<EmptyState>No agents running.</EmptyState>);

    const paragraph = screen.getByText(/No agents running/);

    // Trailing whitespace would be the tell that an absent action still
    // rendered its separator.
    expect(paragraph.textContent).toBe('No agents running.');
  });
});

describe('EmptyStatePath', () => {
  /**
   * Not a button. None of these panels can route to Settings from where they
   * sit, so the path is named the way the work panel already names
   * `Settings → Integrations` — and does not pretend to be clickable.
   */
  it('names a destination without offering to go there', () => {
    render(<EmptyStatePath>Settings → Projects</EmptyStatePath>);

    const path = screen.getByText('Settings → Projects');

    expect(path.tagName).toBe('SPAN');
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
    expect(screen.queryByRole('link')).not.toBeInTheDocument();
  });
});
