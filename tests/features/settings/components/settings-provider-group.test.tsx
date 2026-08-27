import { render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { SettingsGroup } from '@features/settings/components/settings-group';
import { SettingsProviderGroup } from '@features/settings/components/settings-provider-group';

describe('SettingsProviderGroup', () => {
  it('names the band, so a screen reader can jump between providers', () => {
    render(
      <SettingsProviderGroup name="GitHub">
        <p>anything</p>
      </SettingsProviderGroup>,
    );

    expect(screen.getByRole('region', { name: 'GitHub' })).toBeInTheDocument();
  });

  /**
   * Upper-cased by CSS, not by the string.
   *
   * A `.toUpperCase()` in the component would put "GITHUB" in the accessibility
   * tree and have a screen reader spell it, and would make the name untypeable
   * in a locator. `uppercase` is a paint-time transform; the DOM keeps the word
   * the user would say.
   */
  it('keeps the provider name readable in the DOM', () => {
    render(
      <SettingsProviderGroup name="GitHub">
        <p>anything</p>
      </SettingsProviderGroup>,
    );

    const heading = screen.getByRole('heading', { name: 'GitHub' });

    expect(heading.textContent).toContain('GitHub');
    expect(heading.className).toContain('uppercase');
    expect(heading.className).toContain('text-brand');
  });

  /**
   * The heading order is the containment claim, so it has to be true.
   *
   * A pane is `h2` and a group is `h3`. Rendering the provider as `h3` too
   * would tell a screen reader that the band and the groups inside it are
   * peers — the exact confusion the band exists to remove — so a group inside
   * a band drops to `h4`. It is told so by the band, not by a prop: nothing
   * below passes one.
   */
  it('outranks the groups inside it', () => {
    render(
      <SettingsProviderGroup name="Jira">
        <SettingsGroup title="Site" description="Which instance.">
          <p>body</p>
        </SettingsGroup>
      </SettingsProviderGroup>,
    );

    const band = screen.getByRole('region', { name: 'Jira' });

    expect(within(band).getByRole('heading', { level: 3 }).textContent).toContain('Jira');
    expect(within(band).getByRole('heading', { level: 4 }).textContent).toBe('Site');
  });

  it('hides its rule from the accessibility tree', () => {
    const { container } = render(
      <SettingsProviderGroup name="GitHub">
        <p>anything</p>
      </SettingsProviderGroup>,
    );

    const rule = container.querySelector('[aria-hidden="true"]');

    expect(rule).not.toBeNull();
    expect(rule?.className).toContain('bg-brand/25');
  });
});
