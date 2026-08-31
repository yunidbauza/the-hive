import { renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Agent, Session } from '@/types/entity';

import { useNotificationActivate } from '@features/settings/hooks/use-notification-activate';
import type { NotificationActivateEvent } from '@shared/ipc-contract';
import { useHiveStore } from '@stores/hive-store';
import { useUiStore } from '@stores/ui-store';

/**
 * The renderer half of click-to-open (story 106).
 *
 * Main raises the window; this opens the tab. The test that matters most is the
 * unsubscribe: this mounts at the composition root, so a leak here is a
 * listener per app lifetime rather than per component.
 */

type Listener = (event: NotificationActivateEvent) => void;

let listeners: Listener[] = [];
const unsubscribe = vi.fn();

const bridge = {
  notifications: {
    onActivate: vi.fn((callback: Listener) => {
      listeners.push(callback);
      return unsubscribe;
    }),
  },
} as unknown as Window['hive'];

beforeEach(() => {
  listeners = [];
  vi.clearAllMocks();
  useUiStore.getState().openTab('orch');
  useHiveStore.getState().reset();
});

afterEach(() => {
  delete (window as { hive?: unknown }).hive;
});

describe('useNotificationActivate', () => {
  it('opens the session the notification named', () => {
    (window as { hive?: unknown }).hive = bridge;
    renderHook(() => useNotificationActivate());

    listeners[0]?.({ type: 'entity', entityId: 'nova-web' });

    expect(useUiStore.getState().activeTab).toBe('nova-web');
  });

  it('unsubscribes on unmount', () => {
    (window as { hive?: unknown }).hive = bridge;
    const { unmount } = renderHook(() => useNotificationActivate());

    unmount();

    expect(unsubscribe).toHaveBeenCalled();
  });

  it('does nothing without a bridge — the browser demo has no OS to notify', () => {
    expect(() => renderHook(() => useNotificationActivate())).not.toThrow();
  });

  /**
   * The regression a review round caught (HIVE-118): `currentRowFor` resolves
   * two ways, not one — a direct `entities[id]` hit, and a search over live
   * sessions for one whose `terminalId` matches. `hydrateAgents`'s own guard
   * concedes "an agent name is a legal session id", so nothing stops a live
   * session's terminal from carrying an agent's exact name. Before the fix,
   * an agent notification clicked while that collision existed opened the
   * *session*, silently, because the search loop matched before this hook
   * ever noticed the id was an agent's.
   */
  it('opens the agent, not a live session whose terminal happens to share its name', () => {
    const agent: Agent = {
      kind: 'agent',
      id: 'drone',
      icon: 'ph-robot',
      sub: '',
      task: '',
      status: 'sleeping',
      wake: { on: [] },
      runsSinceRotate: 0,
      rotateAfter: 50,
      skipsSinceRun: 0,
      runs: [],
      lines: [],
    };
    const session: Session = {
      kind: 'session',
      id: 'sess-successor',
      // The collision itself: this session's *terminal*, not its own row id,
      // is named exactly like the agent above.
      terminalId: 'drone',
      project: 'nova-web',
      status: 'working',
      task: '',
      cost: '$0.00',
      lines: [],
    };

    useHiveStore.setState((state) => ({
      entities: { ...state.entities, [agent.id]: agent, [session.id]: session },
      order: [...state.order, session.id],
      agentOrder: [...state.agentOrder, agent.id],
    }));

    (window as { hive?: unknown }).hive = bridge;
    renderHook(() => useNotificationActivate());

    listeners[0]?.({ type: 'entity', entityId: 'drone' });

    expect(useUiStore.getState().activeTab).toBe('drone');
    expect(useUiStore.getState().activeTab).not.toBe('sess-successor');
  });

  /**
   * The finding this closes (HIVE-118 self-review): an ask toast focused the
   * window and stopped. Main returned early, the renderer heard nothing, and
   * the rail stayed exactly where it was — which, for a user parked on the
   * explorer with the rail collapsed, meant clicking a question and landing on
   * a file tree with no card and no signal on it.
   *
   * Both halves are asserted, because the rail has two independent ways to
   * hide the inbox: the wrong tab, and no rail at all. The starting state is
   * deliberately the worst one.
   */
  it('reveals the inbox when an ask is activated, opening the rail if it was hidden', () => {
    useUiStore.setState({ railTab: 'explorer', showActivityRail: false });

    (window as { hive?: unknown }).hive = bridge;
    renderHook(() => useNotificationActivate());

    listeners[0]?.({ type: 'ask' });

    expect(useUiStore.getState().railTab).toBe('inbox');
    expect(useUiStore.getState().showActivityRail).toBe(true);
  });

  /** An ask is answered where it is: nothing opens on the centre stage. */
  it('opens no tab for an ask', () => {
    useUiStore.getState().openTab('orch');

    (window as { hive?: unknown }).hive = bridge;
    renderHook(() => useNotificationActivate());

    listeners[0]?.({ type: 'ask' });

    expect(useUiStore.getState().activeTab).toBe('orch');
  });
});
