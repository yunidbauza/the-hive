import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { SettingsGroup } from '@features/settings/components/settings-group';

describe('SettingsGroup', () => {
  it('renders its title, description and body', () => {
    render(
      <SettingsGroup title="Defaults" description="Used by every project.">
        <p>body</p>
      </SettingsGroup>,
    );

    expect(screen.getByRole('heading', { name: 'Defaults' })).toBeInTheDocument();
    expect(screen.getByText('Used by every project.')).toBeInTheDocument();
    expect(screen.getByText('body')).toBeInTheDocument();
  });

  /**
   * The rhythm, asserted where it is written.
   *
   * `pb-5` here against each pane's `gap-6` — the two numbers live apart, so
   * this pins the half that is a component's business. They used to be `pb-4`
   * and `gap-4`, which put the rule exactly halfway between the group it ends
   * and the one it starts; equidistant reads as belonging to neither.
   */
  it('closes itself with a rule and the shorter of the two gaps', () => {
    render(
      <SettingsGroup title="Defaults" description="Used by every project.">
        <p>body</p>
      </SettingsGroup>,
    );

    const group = screen.getByRole('heading', { name: 'Defaults' }).closest('section');

    expect(group?.className).toContain('border-b');
    expect(group?.className).toContain('pb-5');
  });

  describe('nested in a provider band', () => {
    it('draws no rule, because the band already carries one', () => {
      render(
        <SettingsGroup nested title="Site" description="Which instance.">
          <p>body</p>
        </SettingsGroup>,
      );

      const group = screen.getByRole('heading', { name: 'Site' }).closest('section');

      expect(group?.className).not.toContain('border-b');
      expect(group?.className).not.toContain('pb-5');
    });

    it('drops a heading level, so the band outranks it', () => {
      render(
        <SettingsGroup nested title="Site" description="Which instance.">
          <p>body</p>
        </SettingsGroup>,
      );

      expect(screen.getByRole('heading', { level: 4, name: 'Site' })).toBeInTheDocument();
    });

    it('is h3 by default — a pane’s own groups are not nested', () => {
      render(
        <SettingsGroup title="Defaults" description="Used by every project.">
          <p>body</p>
        </SettingsGroup>,
      );

      expect(
        screen.getByRole('heading', { level: 3, name: 'Defaults' }),
      ).toBeInTheDocument();
    });
  });
});
