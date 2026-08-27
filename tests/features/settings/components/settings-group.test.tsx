import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { SettingsGroup } from '@features/settings/components/settings-group';
import { SettingsProviderGroup } from '@features/settings/components/settings-provider-group';

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

  it('is h3 outside a band — a pane’s own groups are not nested', () => {
    render(
      <SettingsGroup title="Defaults" description="Used by every project.">
        <p>body</p>
      </SettingsGroup>,
    );

    expect(
      screen.getByRole('heading', { level: 3, name: 'Defaults' }),
    ).toBeInTheDocument();
  });

  /**
   * Nesting comes from where the group is rendered, not from a prop.
   *
   * This is the whole point of `settings-nesting.ts`: the three consequences —
   * no rule, no bottom padding, one heading level down — are a structural fact,
   * and a `nested` boolean made it something every call site had to remember
   * and three components hard-coded. Nothing here passes anything; the band
   * decides.
   */
  describe('inside a provider band', () => {
    const inBand = () =>
      render(
        <SettingsProviderGroup name="Jira">
          <SettingsGroup title="Site" description="Which instance.">
            <p>body</p>
          </SettingsGroup>
        </SettingsProviderGroup>,
      );

    it('draws no rule, because the band already carries one', () => {
      inBand();

      const group = screen.getByRole('heading', { name: 'Site' }).closest('section');

      expect(group?.className).not.toContain('border-b');
      expect(group?.className).not.toContain('pb-5');
    });

    it('drops a heading level, so the band outranks it', () => {
      inBand();

      expect(
        screen.getByRole('heading', { level: 4, name: 'Site' }),
      ).toBeInTheDocument();
    });

    /**
     * The regression the prop could not prevent.
     *
     * A group that leaves a band goes back to being top-level on its own. Under
     * the old boolean, a component that hard-coded `nested` kept rendering `h4`
     * under an `h2` wherever it was reused — an invalid heading order with
     * nothing to catch it.
     */
    it('reverts the moment it is rendered outside one', () => {
      render(
        <>
          <SettingsProviderGroup name="Jira">
            <SettingsGroup title="Site" description="Which instance.">
              <p>in band</p>
            </SettingsGroup>
          </SettingsProviderGroup>
          <SettingsGroup title="Defaults" description="Used by every project.">
            <p>outside</p>
          </SettingsGroup>
        </>,
      );

      expect(
        screen.getByRole('heading', { level: 4, name: 'Site' }),
      ).toBeInTheDocument();
      expect(
        screen.getByRole('heading', { level: 3, name: 'Defaults' }),
      ).toBeInTheDocument();
    });
  });
});
