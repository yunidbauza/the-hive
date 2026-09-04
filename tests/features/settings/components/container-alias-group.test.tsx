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
});
