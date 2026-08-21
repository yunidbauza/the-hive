import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { NotificationsSection } from '@features/settings/components/notifications-section';
import {
  NOTIFICATION_KINDS,
  NOTIFICATION_KIND_SPECS,
} from '@shared/notification-contract';

const setNotificationPrefs = vi.fn((_request: unknown) => Promise.resolve());
let status: { supported: boolean; refused: string | null } | null = {
  supported: true,
  refused: null,
};
let snapshot: unknown = { notifications: {} };

vi.mock('@lib/project-config', () => ({
  setNotificationPrefs: (request: unknown) => setNotificationPrefs(request),
  readNotificationDelivery: () => Promise.resolve(status),
}));

vi.mock('@hooks/use-project-config', () => ({
  useProjectConfig: () => snapshot,
}));

beforeEach(() => {
  setNotificationPrefs.mockClear();
  status = { supported: true, refused: null };
  snapshot = { notifications: {} };
});

describe('NotificationsSection', () => {
  /**
   * The pane shell every other section carries.
   *
   * The overlay mounts panes bare and contributes no padding of its own, so a
   * section that omits the shell runs its rows edge to edge and scrolls the
   * wrong box. This one did, and looked broken beside Integrations and Editor.
   */
  it('names itself and carries the standard pane shell', () => {
    const { container } = render(<NotificationsSection />);

    expect(
      screen.getByRole('heading', { name: 'Notifications', level: 2 }),
    ).toBeInTheDocument();
    expect(container.firstElementChild).toHaveClass(
      'px-5',
      'py-4',
      'overflow-y-auto',
      'min-h-0',
      'flex-1',
    );
  });

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
    const LABELS = { off: 'Off', inbox: 'Inbox', both: 'System' };

    for (const kind of NOTIFICATION_KINDS) {
      const group = screen.getByRole('radiogroup', {
        name: NOTIFICATION_KIND_SPECS[kind].label,
      });
      const expected = LABELS[NOTIFICATION_KIND_SPECS[kind].defaultDelivery];
      expect(within(group).getByRole('radio', { name: expected }), kind).toBeChecked();
    }
  });

  it('shows a stored preference over the default', () => {
    snapshot = { notifications: { 'session.blocked': 'off' } };
    render(<NotificationsSection />);

    const group = screen.getByRole('radiogroup', {
      name: NOTIFICATION_KIND_SPECS['session.blocked'].label,
    });
    expect(within(group).getByRole('radio', { name: 'Off' })).toBeChecked();
  });

  /** One kind per call — saving one control may not restate another. */
  it('writes only the kind that changed', async () => {
    const user = userEvent.setup();
    render(<NotificationsSection />);

    const group = screen.getByRole('radiogroup', {
      name: NOTIFICATION_KIND_SPECS['session.blocked'].label,
    });
    await user.click(within(group).getByRole('radio', { name: 'Off' }));

    expect(setNotificationPrefs).toHaveBeenCalledTimes(1);
    expect(setNotificationPrefs).toHaveBeenCalledWith({
      'session.blocked': 'off',
    });
  });

  /**
   * Disabled rather than hidden: hiding it would change what the control means
   * between two machines without saying so.
   */
  it('disables the desktop option when the OS cannot present one', async () => {
    status = { supported: false, refused: null };
    render(<NotificationsSection />);

    const group = await screen.findByRole('radiogroup', {
      name: NOTIFICATION_KIND_SPECS['session.blocked'].label,
    });
    expect(
      within(group).getByRole('radio', { name: 'System' }),
    ).toBeDisabled();
    expect(within(group).getByRole('radio', { name: 'Inbox' })).toBeEnabled();
  });

  /**
   * The case the pane used to hide.
   *
   * `Notification.isSupported()` answers `true` on macOS and every send is then
   * refused — measured, `UNErrorDomain error 1`. Without this the pane went on
   * describing a "System" delivery that had never once been delivered, and the
   * user had no way to find out.
   */
  it('says so when the OS claimed support and then refused delivery', async () => {
    status = { supported: true, refused: 'UNErrorDomain error 1.' };
    render(<NotificationsSection />);

    const note = await screen.findByText(/refused this app/i);
    expect(note).toHaveTextContent('UNErrorDomain error 1.');
    // The actionable half: nothing was lost, and the dock still reacts.
    expect(note).toHaveTextContent(/inbox/i);
    expect(note).toHaveTextContent(/dock/i);
  });

  /** Two notes describing one system would be one note too many. */
  it('shows only the unsupported note when the OS never claimed support', async () => {
    status = { supported: false, refused: 'UNErrorDomain error 1.' };
    render(<NotificationsSection />);

    expect(
      await screen.findByText(/cannot show desktop notifications/i),
    ).toBeInTheDocument();
    expect(screen.queryByText(/refused this app/i)).toBeNull();
  });

  /**
   * The hole a single mount-time read leaves.
   *
   * `refused` is only knowable in main *after* a
   * `both`-delivery notification has been attempted and refused — so the user
   * who opens this pane to find out why nothing arrives is, at that instant,
   * looking at `null`. Without the poll they would have to close and reopen
   * Settings to be told the thing the note exists to tell them.
   */
  it('picks up a refusal that only happens after the pane is open', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      render(<NotificationsSection />);
      await vi.waitFor(() =>
        expect(
          screen.getByRole('heading', { name: 'Notifications', level: 2 }),
        ).toBeInTheDocument(),
      );
      expect(screen.queryByText(/refused this app/i)).toBeNull();

      // A session raises one, and the OS turns it down — while the pane is open.
      status = { supported: true, refused: 'UNErrorDomain error 1.' };

      await vi.advanceTimersByTimeAsync(5_000);

      await vi.waitFor(() =>
        expect(screen.getByText(/refused this app/i)).toBeInTheDocument(),
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it('says nothing at all while delivery is working', async () => {
    render(<NotificationsSection />);
    // Awaited so the status fetch has resolved before the absence is asserted.
    await screen.findByRole('heading', { name: 'Notifications', level: 2 });

    expect(screen.queryByText(/refused this app/i)).toBeNull();
    expect(screen.queryByText(/cannot show desktop notifications/i)).toBeNull();
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
        name: NOTIFICATION_KIND_SPECS['session.blocked'].label,
      }),
    ).toBeInTheDocument();
  });
});
