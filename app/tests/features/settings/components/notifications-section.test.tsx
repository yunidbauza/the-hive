import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { NotificationsSection } from '@features/settings/components/notifications-section';
import {
  NOTIFICATION_KINDS,
  NOTIFICATION_KIND_SPECS,
} from '@shared/notification-contract';

const setNotificationPrefs = vi.fn((_request: unknown) => Promise.resolve());
let status: { notificationsSupported: boolean } | null = {
  notificationsSupported: true,
};
let snapshot: unknown = { notifications: {} };

vi.mock('@lib/project-config', () => ({
  setNotificationPrefs: (request: unknown) => setNotificationPrefs(request),
  readIntegrationsStatus: () => Promise.resolve(status),
}));

vi.mock('@hooks/use-project-config', () => ({
  useProjectConfig: () => snapshot,
}));

beforeEach(() => {
  setNotificationPrefs.mockClear();
  status = { notificationsSupported: true };
  snapshot = { notifications: {} };
});

describe('NotificationsSection', () => {
  /**
   * The property the whole shape exists for: this file does not name a single
   * kind, so a kind added to the registry gets its control without an edit
   * here, and one removed cannot leave a dead switch behind.
   */
  it('renders one control for every registered kind', () => {
    render(<NotificationsSection />);

    for (const kind of NOTIFICATION_KINDS) {
      expect(
        screen.getByRole('radiogroup', {
          name: NOTIFICATION_KIND_SPECS[kind].label,
        }),
        kind,
      ).toBeInTheDocument();
    }
  });

  it('shows each kind at its registry default when the config says nothing', () => {
    render(<NotificationsSection />);

    // Read from the registry rather than restated, so the assertion cannot
    // drift the way a hardcoded default did when `session.idle` changed.
    const LABELS = { off: 'Off', inbox: 'Inbox', both: 'Inbox + desktop' };

    for (const kind of NOTIFICATION_KINDS) {
      const group = screen.getByRole('radiogroup', {
        name: NOTIFICATION_KIND_SPECS[kind].label,
      });
      const expected = LABELS[NOTIFICATION_KIND_SPECS[kind].defaultDelivery];
      expect(within(group).getByRole('radio', { name: expected }), kind).toBeChecked();
    }
  });

  it('shows a stored preference over the default', () => {
    snapshot = { notifications: { 'session.waiting': 'off' } };
    render(<NotificationsSection />);

    const group = screen.getByRole('radiogroup', {
      name: NOTIFICATION_KIND_SPECS['session.waiting'].label,
    });
    expect(within(group).getByRole('radio', { name: 'Off' })).toBeChecked();
  });

  /** One kind per call — saving one control may not restate another. */
  it('writes only the kind that changed', async () => {
    const user = userEvent.setup();
    render(<NotificationsSection />);

    const group = screen.getByRole('radiogroup', {
      name: NOTIFICATION_KIND_SPECS['session.waiting'].label,
    });
    await user.click(within(group).getByRole('radio', { name: 'Off' }));

    expect(setNotificationPrefs).toHaveBeenCalledTimes(1);
    expect(setNotificationPrefs).toHaveBeenCalledWith({
      'session.waiting': 'off',
    });
  });

  /**
   * Disabled rather than hidden: hiding it would change what the control means
   * between two machines without saying so.
   */
  it('disables the desktop option when the OS cannot present one', async () => {
    status = { notificationsSupported: false };
    render(<NotificationsSection />);

    const group = await screen.findByRole('radiogroup', {
      name: NOTIFICATION_KIND_SPECS['session.waiting'].label,
    });
    expect(
      within(group).getByRole('radio', { name: 'Inbox + desktop' }),
    ).toBeDisabled();
    expect(within(group).getByRole('radio', { name: 'Inbox' })).toBeEnabled();
  });

  /** Slack has no producer, so it must not appear (HIVE-77). */
  it('shows no group for a source with no registered kinds', () => {
    render(<NotificationsSection />);
    expect(screen.queryByText('Slack')).toBeNull();
  });

  /** The browser demo has no config file; defaults still render. */
  it('renders on a null snapshot rather than refusing', () => {
    snapshot = null;
    render(<NotificationsSection />);

    expect(
      screen.getByRole('radiogroup', {
        name: NOTIFICATION_KIND_SPECS['session.waiting'].label,
      }),
    ).toBeInTheDocument();
  });
});
