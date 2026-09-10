import { renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';

import type { Agent, Session } from '@/types/entity';
import type { RemoteLinkStatus } from '@shared/ipc-contract';

import { useForegroundSession } from '@/hooks/use-foreground-session';
import { useAppearanceStore } from '@stores/appearance-store';
import { useEditorStore } from '@stores/editor-store';
import { useHiveStore } from '@stores/hive-store';
import { useUiStore } from '@stores/ui-store';

/**
 * The renderer half of the foreground gate (HIVE-81).
 *
 * A table over `resolveView`'s inputs, the way `use-session-status.test.ts`
 * tables over the status listeners. `sess-03` carries a `terminalId` of
 * `term-3` distinct from its own id — a stand-in for a session that has
 * survived a `/clear` — which is what proves the hook reports a **terminal**
 * id and not the row id `activeTab` names. `agent-1` has no such distinction:
 * `terminalIdFor` only remaps sessions, so an agent's own id *is* its terminal
 * id, and the case exists to prove an agent tab still counts as foreground.
 */

const session: Session = {
  kind: 'session',
  id: 'sess-03',
  terminalId: 'term-3',
  project: 'nova-web',
  status: 'idle',
  task: 'refresh the hero',
  cost: '$0.00',
  lines: [],
};

const agent: Agent = {
  kind: 'agent',
  id: 'agent-1',
  icon: 'ph-slack-logo',
  sub: '#eng-alerts',
  task: 'watch the channel',
  status: 'sleeping',
  wake: { on: [] },
  mcp: [],
  runsSinceRotate: 0,
  rotateAfter: 50,
  skipsSinceRun: 0,
  runs: [],
  live: [],
  lines: [],
};

interface Case {
  name: string;
  state: {
    activeTab: string;
    picker?: boolean;
    settings?: boolean;
    editorFull?: boolean;
    editorSplit?: boolean;
  };
  expected: string | null;
}

const cases: Case[] = [
  { name: 'orchestrator tab', state: { activeTab: 'orch' }, expected: null },
  // Distinct from its row id — the point of the fixture.
  { name: 'session tab', state: { activeTab: 'sess-03' }, expected: 'term-3' },
  // No terminalId remapping for agents — its own id is its terminal id.
  { name: 'agent tab', state: { activeTab: 'agent-1' }, expected: 'agent-1' },
  {
    name: 'picker open',
    state: { activeTab: 'sess-03', picker: true },
    expected: null,
  },
  {
    name: 'settings open',
    state: { activeTab: 'sess-03', settings: true },
    expected: null,
  },
  {
    name: 'editor full',
    state: { activeTab: 'sess-03', editorFull: true },
    expected: null,
  },
  {
    name: 'editor split',
    state: { activeTab: 'sess-03', editorSplit: true },
    expected: 'term-3',
  },
];

let calls: (string | null)[];

function withBridge() {
  calls = [];
  (window as { hive?: unknown }).hive = {
    ui: {
      reportForeground: (terminalId: string | null) => {
        calls.push(terminalId);
      },
    },
  };
}

/** Installs a link status, the way `remote:link-status` would (HIVE-150). */
function link(over: Partial<RemoteLinkStatus> = {}) {
  useHiveStore.getState().setRemoteLink({
    state: 'attached',
    serverName: 'mini',
    attempt: 0,
    nextAttemptAt: null,
    reason: null,
    epoch: 0,
    ...over,
  });
}

function seed({ activeTab, picker, settings, editorFull, editorSplit }: Case['state']) {
  useUiStore.setState({
    activeTab,
    picker: picker ?? false,
    settings: settings ?? false,
  });
  useEditorStore.setState({
    activeKey: editorFull || editorSplit ? 'nova-web:src/index.ts' : null,
  });
  useAppearanceStore.setState({
    editorPlacement: editorFull ? 'full' : editorSplit ? 'split' : 'full',
  });
}

beforeEach(() => {
  useHiveStore.getState().reset();
  useUiStore.getState().reset();
  useEditorStore.getState().reset();
  useAppearanceStore.getState().reset();
  useHiveStore.setState({
    entities: {
      'sess-03': session,
      'agent-1': agent,
    },
  });
  delete (window as { hive?: unknown }).hive;
});

describe('useForegroundSession', () => {
  it.each(cases)('reports $expected for $name', ({ state, expected }) => {
    withBridge();
    seed(state);

    renderHook(() => useForegroundSession());

    expect(calls).toEqual([expected]);
  });

  it('does nothing without a bridge', () => {
    // window.hive undefined — the browser demo, where nothing is listening.
    seed({ activeTab: 'sess-03' });

    expect(() => renderHook(() => useForegroundSession())).not.toThrow();
  });

  it('reports once per change, not once per render', () => {
    withBridge();
    seed({ activeTab: 'sess-03' });

    const { rerender } = renderHook(() => useForegroundSession());
    rerender();
    rerender();

    expect(calls).toEqual(['term-3']);
  });

  it('reports again when the terminal id actually changes', () => {
    withBridge();
    seed({ activeTab: 'sess-03' });
    const { rerender } = renderHook(() => useForegroundSession());

    useUiStore.setState({ activeTab: 'orch' });
    rerender();

    expect(calls).toEqual(['term-3', null]);
  });

  /**
   * Re-announced on every reattach (HIVE-150).
   *
   * The foreground record is per *surface* on the machine that answers it, and
   * a reconnect is a new surface — ids are minted from a `WeakMap` on the
   * socket object, and HIVE-145 wired the old surface's release to its socket
   * going away. Nothing else here would ever say it again: the terminal on
   * screen has not changed and the renderer never unmounted.
   */
  it('says it again after a reattach, with the same terminal on screen', () => {
    withBridge();
    seed({ activeTab: 'sess-03' });
    const { rerender } = renderHook(() => useForegroundSession());
    expect(calls).toEqual(['term-3']);

    link({ epoch: 1 });
    rerender();

    /*
      The same id twice, which is exactly the point: without the epoch this is
      a no-op re-render, and notification suppression on the server would go on
      naming a surface that no longer exists — silently toasting for the
      session the user is watching and staying quiet for the ones they are not.
    */
    expect(calls).toEqual(['term-3', 'term-3']);
  });

  it('does not re-announce while the link is merely reconnecting', () => {
    withBridge();
    seed({ activeTab: 'sess-03' });
    const { rerender } = renderHook(() => useForegroundSession());

    // A drop raises statuses, but the epoch only moves on a successful
    // reattach — there is no surface to announce to until there is a socket.
    link({ state: 'reconnecting', attempt: 2, epoch: 0 });
    rerender();

    expect(calls).toEqual(['term-3']);
  });
});
