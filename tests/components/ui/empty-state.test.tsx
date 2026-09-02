import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { EmptyState, EmptyStatePath } from '@components/ui/empty-state';
import { PHRASES } from '@lib/swarm/phrases';

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

  /**
   * The flavour line is additive. The whole design rests on this: the sentence
   * naming what is missing and the sentence naming the way out both survive
   * verbatim, so nothing became decorative *instead of* useful.
   */
  it('adds a flavour line above the copy without disturbing it', () => {
    render(
      <EmptyState phrase="empty.inbox" action="Sessions will show up here.">
        Nothing needs you.
      </EmptyState>,
    );

    const paragraph = screen.getByText(/Nothing needs you/);

    expect(paragraph).toHaveTextContent('Nothing needs you. Sessions will show up here.');

    const flavour = document.querySelector('[data-swarm-line]');

    expect(PHRASES['empty.inbox']).toContain(flavour?.textContent);
  });

  it('holds a creature at rail size when one is cast', () => {
    render(
      <EmptyState phrase="empty.inbox" creature="overlord">
        Nothing needs you.
      </EmptyState>,
    );

    const img = screen.getByRole('presentation', { hidden: true });

    expect(img).toHaveAttribute('data-creature', 'overlord');
    /**
     * The size is the whole argument for allowing a sprite in a 320px rail at
     * all, so it is asserted rather than left to a call site.
     */
    expect(img).toHaveStyle({ height: '44px' });
  });

  it('takes the flavour line without a creature', () => {
    render(<EmptyState phrase="empty.inbox">Nothing needs you.</EmptyState>);

    expect(document.querySelector('[data-swarm-line]')).not.toBeNull();
    expect(document.querySelector('[data-creature]')).toBeNull();
  });

  /**
   * A control is not copy. In the left column the sentences hang off it would
   * read as another one of them; centred under the flavour line it reads as the
   * thing to press — and whatever sentence survives it goes *underneath*,
   * because that half names the way out this panel cannot take itself.
   */
  it('puts a control under the flavour line and the sentence under the control', () => {
    render(
      <EmptyState
        phrase="empty.projects"
        control={<button type="button">new project</button>}
        action="Or clone one in Settings."
      />,
    );

    const control = screen.getByRole('button', { name: 'new project' });
    const sentence = screen.getByText('Or clone one in Settings.');

    expect(control.parentElement?.children[0]).toBe(control);
    expect(control.parentElement?.children[1]).toBe(sentence);
    expect(document.querySelector('[data-swarm-line]')).not.toBeNull();
  });

  /**
   * The flavour line is a sentence, so a panel whose emptiness it already
   * reports has nothing left for the body to say. What is asserted here is the
   * separator: with no `children`, the action is the whole sentence and must
   * not arrive with the leading space that would have joined it to one.
   */
  it('lets the flavour line be the message, with no body sentence', () => {
    render(
      <EmptyState
        phrase="empty.projects"
        control={<button type="button">new project</button>}
        action="Or clone one in Settings."
      />,
    );

    expect(screen.getByText('Or clone one in Settings.').textContent).toBe(
      'Or clone one in Settings.',
    );
  });

  it('renders a control with no sentence of any kind under it', () => {
    render(
      <EmptyState
        phrase="empty.projects"
        control={<button type="button">new project</button>}
      />,
    );

    const control = screen.getByRole('button', { name: 'new project' });

    // The flavour line is a paragraph of its own, one level up; what must not
    // exist is an empty one under the control.
    expect(control.parentElement?.children).toHaveLength(1);
  });

  /**
   * Twenty-odd call sites predate the prop, and their layout was tuned against
   * a bare paragraph. Wrapping all of them in a flex container to add nothing
   * would be a silent re-spacing of panels this change has no business
   * touching.
   */
  it('renders the bare paragraph when no phrase is asked for', () => {
    const { container } = render(<EmptyState>No agents running.</EmptyState>);

    expect(container.firstElementChild?.tagName).toBe('P');
    expect(document.querySelector('[data-swarm-line]')).toBeNull();
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
