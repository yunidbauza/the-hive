import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { EditorSection } from '@features/settings/components/editor-section';
import { useAppearanceStore } from '@stores/appearance-store';

/**
 * The Editor settings section.
 *
 * Every control writes straight to `appearance-store`, which persists itself —
 * so there is no save button, no error state, and nothing here crosses a
 * process boundary. The assertions are therefore about what the store holds
 * afterwards, not about a round trip.
 */

const settings = () => useAppearanceStore.getState();

beforeEach(() => {
  act(() => {
    useAppearanceStore.getState().reset();
  });
});

afterEach(() => {
  act(() => {
    useAppearanceStore.getState().reset();
  });
});

describe('EditorSection', () => {
  it('opens on the documented defaults', () => {
    render(<EditorSection />);

    expect(screen.getByRole('radio', { name: 'Full stage' })).toBeChecked();
    expect(screen.getByRole('radio', { name: 'Tabs' })).toBeChecked();
    // On by default since the editor became editable. The toggle stays for
    // anyone who wants the old read-only guard back.
    expect(screen.getByRole('switch', { name: /Allow editing/ })).toBeChecked();
    expect(screen.getByRole('switch', { name: /Wrap long lines/ })).toBeChecked();
    expect(screen.getByRole('switch', { name: /Show line numbers/ })).toBeChecked();
  });

  it('changes the placement', async () => {
    render(<EditorSection />);

    await userEvent.click(screen.getByRole('radio', { name: 'Split' }));

    expect(settings().editorPlacement).toBe('split');
  });

  /**
   * Present but disabled rather than hidden. A control that appears the first
   * time you pick an option makes that option feel like it did nothing,
   * because the thing it enabled arrived somewhere the eye was not.
   */
  it('disables the split direction until placement is Split', async () => {
    render(<EditorSection />);

    const stacked = screen.getByRole('radio', { name: 'Stacked' });
    expect(stacked).toBeDisabled();

    await userEvent.click(screen.getByRole('radio', { name: 'Split' }));
    expect(screen.getByRole('radio', { name: 'Stacked' })).toBeEnabled();

    await userEvent.click(screen.getByRole('radio', { name: 'Stacked' }));
    expect(settings().editorSplitAxis).toBe('horizontal');
  });

  it('explains the cost of a side-by-side split only when one is chosen', async () => {
    render(<EditorSection />);
    expect(screen.queryByText(/Drag the divider/)).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole('radio', { name: 'Split' }));
    expect(screen.getByText(/Drag the divider/)).toBeInTheDocument();
  });

  it('switches to one file at a time', async () => {
    render(<EditorSection />);

    await userEvent.click(screen.getByRole('radio', { name: 'One at a time' }));

    expect(settings().editorNav).toBe('single');
  });

  it('turns editing off, and back on', async () => {
    render(<EditorSection />);

    await userEvent.click(screen.getByRole('switch', { name: /Allow editing/ }));
    expect(settings().editorEditable).toBe(false);

    await userEvent.click(screen.getByRole('switch', { name: /Allow editing/ }));
    expect(settings().editorEditable).toBe(true);
  });

  it('changes the typography independently of the terminal', async () => {
    render(<EditorSection />);

    await userEvent.selectOptions(screen.getByLabelText('Size'), '16');
    await userEvent.selectOptions(screen.getByLabelText('Tab width'), '8');
    await userEvent.selectOptions(screen.getByLabelText('Font'), 'menlo');

    expect(settings().editorFontSize).toBe(16);
    expect(settings().editorTabWidth).toBe(8);
    expect(settings().editorFont).toBe('menlo');
    // The terminal's own values are untouched.
    expect(settings().terminalFontSize).toBe(12.5);
    expect(settings().terminalFont).toBe('system');
  });

  it('toggles wrapping and line numbers', async () => {
    render(<EditorSection />);

    await userEvent.click(screen.getByRole('switch', { name: /Wrap long lines/ }));
    await userEvent.click(screen.getByRole('switch', { name: /Show line numbers/ }));

    expect(settings().editorWordWrap).toBe(false);
    expect(settings().editorLineNumbers).toBe(false);
  });
});
