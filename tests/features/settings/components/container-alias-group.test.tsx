import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ContainerAliasGroup } from '@features/settings/components/container-alias-group';
import { setReceiverConfig } from '@lib/project-config';

vi.mock('@lib/project-config', () => ({
  setReceiverConfig: vi.fn(() => Promise.resolve()),
}));

/**
 * The container host alias field (HIVE-131).
 *
 * Committed on Enter and blur, never per keystroke — this writes to
 * `~/.hive/config.json`, so a commit per character would be a whole-file atomic
 * write per character (`text-field.tsx:24`).
 */

describe('ContainerAliasGroup', () => {
  beforeEach(() => {
    vi.mocked(setReceiverConfig).mockClear();
  });

  it('renders the resolved alias', () => {
    render(<ContainerAliasGroup hostAlias="host.docker.internal" />);

    expect(screen.getByLabelText('Host alias')).toHaveValue(
      'host.docker.internal',
    );
  });

  it('does not write on every keystroke', () => {
    render(<ContainerAliasGroup hostAlias="host.docker.internal" />);

    fireEvent.change(screen.getByLabelText('Host alias'), {
      target: { value: 'host.containers.internal' },
    });

    expect(setReceiverConfig).not.toHaveBeenCalled();
  });

  it('commits on blur', () => {
    render(<ContainerAliasGroup hostAlias="host.docker.internal" />);
    const field = screen.getByLabelText('Host alias');

    fireEvent.change(field, { target: { value: 'host.containers.internal' } });
    fireEvent.blur(field);

    expect(setReceiverConfig).toHaveBeenCalledWith({
      hostAlias: 'host.containers.internal',
    });
  });

  it('commits on Enter', () => {
    render(<ContainerAliasGroup hostAlias="host.docker.internal" />);
    const field = screen.getByLabelText('Host alias');

    fireEvent.change(field, { target: { value: 'gateway' } });
    fireEvent.keyDown(field, { key: 'Enter' });

    expect(setReceiverConfig).toHaveBeenCalledWith({ hostAlias: 'gateway' });
  });

  it('does not write when the value did not change', () => {
    render(<ContainerAliasGroup hostAlias="host.docker.internal" />);

    fireEvent.blur(screen.getByLabelText('Host alias'));

    expect(setReceiverConfig).not.toHaveBeenCalled();
  });

  it('trims before comparing, so re-committing padding writes nothing', () => {
    render(<ContainerAliasGroup hostAlias="gateway" />);
    const field = screen.getByLabelText('Host alias');

    fireEvent.change(field, { target: { value: '  gateway  ' } });
    fireEvent.blur(field);

    expect(setReceiverConfig).not.toHaveBeenCalled();
    expect(field).toHaveValue('gateway');
  });

  /**
   * There is no "unset" alias to fall back to — the substitution always needs a
   * name, and `""` would produce `http://:63999` — so emptying restores the
   * default rather than clearing the key.
   */
  it('restores the default when the field is emptied', () => {
    render(<ContainerAliasGroup hostAlias="gateway" />);
    const field = screen.getByLabelText('Host alias');

    fireEvent.change(field, { target: { value: '   ' } });
    fireEvent.blur(field);

    expect(setReceiverConfig).toHaveBeenCalledWith({
      hostAlias: 'host.docker.internal',
    });
    expect(field).toHaveValue('host.docker.internal');
  });

  /**
   * `mutate` swallows an IPC rejection into `console.error`
   * (`project-config.ts:117-119`), so a value the guard would refuse must never
   * be sent — otherwise the write fails silently and the field goes on showing
   * something that was never saved.
   */
  describe('a value the guard would refuse', () => {
    it.each([
      ['a port', 'host.docker.internal:1234'],
      ['a scheme', 'http://host.docker.internal'],
      ['a path', 'host.docker.internal/x'],
      ['a query delimiter', '10.0.0.5?'],
      ['a fragment delimiter', 'evil.com#'],
      ['credentials', 'user@evil.com'],
      ['a backslash', 'evil.com\\x'],
    ])('is not sent — %s', (_label, value) => {
      render(<ContainerAliasGroup hostAlias="host.docker.internal" />);
      const field = screen.getByLabelText('Host alias');

      fireEvent.change(field, { target: { value } });
      fireEvent.blur(field);

      expect(setReceiverConfig).not.toHaveBeenCalled();
    });

    it('says so, and keeps what was typed so it can be corrected', () => {
      render(<ContainerAliasGroup hostAlias="host.docker.internal" />);
      const field = screen.getByLabelText('Host alias');

      fireEvent.change(field, { target: { value: '10.0.0.5?' } });
      fireEvent.blur(field);

      expect(screen.getByText(/no scheme, port, path or credentials/i)).toBeInTheDocument();
      expect(field).toHaveValue('10.0.0.5?');
    });

    it('clears the complaint as soon as the value is edited again', () => {
      render(<ContainerAliasGroup hostAlias="host.docker.internal" />);
      const field = screen.getByLabelText('Host alias');

      fireEvent.change(field, { target: { value: 'bad:1234' } });
      fireEvent.blur(field);
      expect(
        screen.getByText(/no scheme, port, path or credentials/i),
      ).toBeInTheDocument();

      fireEvent.change(field, { target: { value: 'gateway' } });

      expect(
        screen.queryByText(/no scheme, port, path or credentials/i),
      ).not.toBeInTheDocument();
    });
  });

  /**
   * The pane is never remounted — `AdvancedSection`'s `!snapshot` early return
   * only fires before the first load — so the field has to follow the snapshot
   * on its own. Reload and Reset both change it underneath.
   */
  describe('when the snapshot changes underneath it', () => {
    it('follows the new value', () => {
      const { rerender } = render(<ContainerAliasGroup hostAlias="gateway" />);
      expect(screen.getByLabelText('Host alias')).toHaveValue('gateway');

      rerender(<ContainerAliasGroup hostAlias="host.docker.internal" />);

      expect(screen.getByLabelText('Host alias')).toHaveValue(
        'host.docker.internal',
      );
    });

    it('does not write a stale draft back after a reset', () => {
      const { rerender } = render(<ContainerAliasGroup hostAlias="gateway" />);

      // The reset lands while the field still shows the old value.
      rerender(<ContainerAliasGroup hostAlias="host.docker.internal" />);
      fireEvent.blur(screen.getByLabelText('Host alias'));

      expect(setReceiverConfig).not.toHaveBeenCalled();
    });

    it('drops a pending edit rather than resurrecting it', () => {
      const { rerender } = render(<ContainerAliasGroup hostAlias="gateway" />);
      fireEvent.change(screen.getByLabelText('Host alias'), {
        target: { value: 'half-typed' },
      });

      rerender(<ContainerAliasGroup hostAlias="host.docker.internal" />);

      expect(screen.getByLabelText('Host alias')).toHaveValue(
        'host.docker.internal',
      );
    });
  });
});
