import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';

import {
  useActiveTab,
  useLeftTab,
  useOpenTab,
  usePickerActions,
  usePickerState,
  useProjectCollapsed,
  useRailState,
  useSelIdx,
  useSetLeftTab,
  useSetSelIdx,
  useShowActivityRail,
  useToggleProject,
  useUiStore,
} from '@stores/ui-store';

/**
 * Every selector hook gets a test. These are thin by design — the value of the
 * convention is that no component ever reaches for the store object, so the
 * hooks are the API surface and are worth pinning.
 */
describe('ui-store selectors', () => {
  beforeEach(() => {
    useUiStore.getState().reset();
  });

  it('useActiveTab and useOpenTab drive the center stage', () => {
    const { result } = renderHook(() => ({
      activeTab: useActiveTab(),
      openTab: useOpenTab(),
    }));

    expect(result.current.activeTab).toBe('orch');

    act(() => {
      result.current.openTab('webhooks');
    });

    expect(result.current.activeTab).toBe('webhooks');
  });

  it('useLeftTab and useSetLeftTab switch the left rail', () => {
    const { result } = renderHook(() => ({
      leftTab: useLeftTab(),
      setLeftTab: useSetLeftTab(),
    }));

    expect(result.current.leftTab).toBe('projects');

    act(() => {
      result.current.setLeftTab('work');
    });

    expect(result.current.leftTab).toBe('work');
  });

  it('useRailState reports the activity rail tab and visibility', () => {
    const { result } = renderHook(() => useRailState());
    expect(result.current).toEqual({ railTab: 'inbox', showActivityRail: true });

    act(() => {
      useUiStore.getState().setRailTab('prs');
      useUiStore.getState().toggleActivityRail();
    });

    expect(result.current).toEqual({ railTab: 'prs', showActivityRail: false });
  });

  it('useShowActivityRail narrows to visibility alone', () => {
    const { result } = renderHook(() => useShowActivityRail());
    expect(result.current).toBe(true);

    // Switching rail tabs must not disturb the shell's subscription.
    act(() => {
      useUiStore.getState().setRailTab('prs');
    });
    expect(result.current).toBe(true);

    act(() => {
      useUiStore.getState().toggleActivityRail();
    });
    expect(result.current).toBe(false);
  });

  it('useProjectCollapsed defaults to expanded and follows the toggle', () => {
    const { result } = renderHook(() => ({
      collapsed: useProjectCollapsed('apfm-web'),
      toggleProject: useToggleProject(),
    }));

    // An untouched project has no entry at all, which must read as expanded.
    expect(result.current.collapsed).toBe(false);

    act(() => {
      result.current.toggleProject('apfm-web');
    });

    expect(result.current.collapsed).toBe(true);
  });

  it('usePickerState and usePickerActions drive the overlay', () => {
    const { result } = renderHook(() => ({
      state: usePickerState(),
      actions: usePickerActions(),
    }));

    expect(result.current.state).toEqual({
      picker: false,
      pickerQuery: '',
      pickerTicket: null,
      newModel: 'opus',
      newEffort: 'high',
    });

    act(() => {
      result.current.actions.openPicker();
      result.current.actions.setPickerQuery('apfm');
      result.current.actions.setNewModel('sonnet');
      result.current.actions.setNewEffort('max');
    });

    expect(result.current.state).toEqual({
      picker: true,
      pickerQuery: 'apfm',
      // The header's entry point — no ticket, and `openPicker` assigns it on
      // every open rather than leaving whatever was there before (HIVE-73).
      pickerTicket: null,
      newModel: 'sonnet',
      newEffort: 'max',
    });

    act(() => {
      result.current.actions.closePicker();
    });

    expect(result.current.state.picker).toBe(false);
  });

  it('useSelIdx and useSetSelIdx track the orchestrator table selection', () => {
    const { result } = renderHook(() => ({
      selIdx: useSelIdx(),
      setSelIdx: useSetSelIdx(),
    }));

    expect(result.current.selIdx).toBe(0);

    act(() => {
      result.current.setSelIdx(3);
    });

    expect(result.current.selIdx).toBe(3);
  });
});
