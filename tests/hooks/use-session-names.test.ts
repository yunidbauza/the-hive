import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { useSessionNames } from '@/hooks/use-session-names';
import { useHiveStore } from '@stores/hive-store';

import { seedDemoFleet } from '@tests/support/demo-fleet';

/**
 * The renderer telling main what the rail calls each session (HIVE-110).
 *
 * Stubbed the way `use-foreground-session.test.ts` stubs its half of the same
 * bridge: `window.hive` is a recorder, and every assertion is about *what was
 * sent and when* rather than about IPC, which has its own suites.
 *
 * The two properties that matter are opposite in shape. It has to report
 * **everything** on mount — main's map is per-process and empty at launch, so a
 * session restored from the session history is otherwise a name main will never learn —
 * and **only the delta** afterwards, or a fleet of ten sends ten messages every
 * time one of them is titled.
 */
let calls: { terminalId: string; name: string }[] = [];

function withBridge() {
  calls = [];
  (window as { hive?: unknown }).hive = {
    ui: {
      reportSessionName: (terminalId: string, name: string) => {
        calls.push({ terminalId, name });
      },
    },
  };
}

const nameFor = (terminalId: string) =>
  calls.filter((call) => call.terminalId === terminalId).map((call) => call.name);

beforeEach(() => {
  useHiveStore.getState().reset();
  seedDemoFleet();
});

afterEach(() => {
  delete (window as { hive?: unknown }).hive;
});

describe('useSessionNames', () => {
  it('reports every live session on mount', () => {
    withBridge();

    renderHook(() => useSessionNames());

    // The id is what the rail shows for a session nothing has titled yet, so it
    // is what main is told — a toast then says exactly what the rail says.
    expect(nameFor('lead-form')).toEqual(['lead-form']);
    expect(calls.length).toBeGreaterThan(1);
  });

  it('reports a rename, and only the session that was renamed', () => {
    withBridge();

    const { rerender } = renderHook(() => useSessionNames());
    const initial = calls.length;

    act(() => {
      useHiveStore.getState().renameSession('lead-form', 'Mutex explanation');
    });
    rerender();

    expect(calls.slice(initial)).toEqual([
      { terminalId: 'lead-form', name: 'mutex-explanation' },
    ]);
  });

  it('says nothing again for a name it has already sent', () => {
    withBridge();

    const { rerender } = renderHook(() => useSessionNames());
    const initial = calls.length;

    act(() => {
      useHiveStore.getState().setSessionStatus('lead-form', 'working');
    });
    rerender();
    rerender();

    expect(calls).toHaveLength(initial);
  });

  it('reports the successor a /clear minted, under the same terminal', () => {
    withBridge();

    const { rerender } = renderHook(() => useSessionNames());

    let successor = '';
    act(() => {
      successor = useHiveStore.getState().clearSession('lead-form')!;
      useHiveStore.getState().renameSession(successor, 'Mutex explanation');
    });
    rerender();

    expect(nameFor('lead-form').at(-1)).toBe('mutex-explanation');
  });

  it('does nothing without a bridge', () => {
    // window.hive undefined — the browser demo, where nothing is listening.
    expect(() => renderHook(() => useSessionNames())).not.toThrow();
  });
});
