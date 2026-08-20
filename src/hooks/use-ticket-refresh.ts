import { createPoller } from '@hooks/create-poller';
import { useRefreshTickets } from '@stores/hive-store';

/**
 * The cadence. One minute, the same as the PR poller.
 *
 * The WORK panel used to read once on mount and never again, on the argument
 * that "a Jira issue moves when a human moves it, which is roughly never while
 * the panel is open". The premise is false in the way that matters: *other
 * people* assign you work, and this app's own sessions file tickets. Because
 * the left rail unmounts inactive panels, switching tabs refetched — so the bug
 * only bit the normal way to use the panel, which is to leave it open.
 *
 * One cadence in the app rather than two to reason about. A Jira search is a
 * single HTTP round trip to the user's own cloud instance, cheaper than the
 * `gh` subprocess already running on this schedule.
 */
const INTERVAL_MS = 60_000;

const usePoller = createPoller({ intervalMs: INTERVAL_MS });

export function useTicketRefresh(): void {
  usePoller(useRefreshTickets());
}
