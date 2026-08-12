import { describe, expect, it } from 'vitest';

import type { Agent, Session } from '@/types/entity';
import { isEntityView, resolveView, type ViewState } from '@/lib/resolve-view';

/**
 * The view-state machine, tested exhaustively (story 040). The component's only
 * job is to render what this returns, so every state and every precedence rule
 * is pinned here rather than inferred from JSX.
 */

const session = { kind: 'session', id: 'hero-refresh' } as Session;
const agent = { kind: 'agent', id: 'slack-agent' } as Agent;

describe('resolveView', () => {
  it('shows the orchestrator for the reserved tab', () => {
    expect(resolveView({ activeTab: 'orch', picker: false, settings: false, entity: null, editorFull: false })).toBe(
      'orchestrator',
    );
  });

  it('shows a session for a session entity', () => {
    expect(
      resolveView({ activeTab: 'hero-refresh', picker: false, settings: false, entity: session, editorFull: false }),
    ).toBe('session');
  });

  it('shows an agent for an agent entity', () => {
    expect(
      resolveView({ activeTab: 'slack-agent', picker: false, settings: false, entity: agent, editorFull: false }),
    ).toBe('agent');
  });

  it('shows the picker whenever it is open', () => {
    expect(resolveView({ activeTab: 'orch', picker: true, settings: false, entity: null, editorFull: false })).toBe(
      'picker',
    );
  });

  describe('precedence', () => {
    it('lets the picker win over every underlying view', () => {
      /**
       * The picker is a full-stage overlay that deliberately does not change
       * `activeTab` — closing it has to return the user to what they were
       * looking at, which only works if the tab underneath is untouched.
       */
      for (const entity of [null, session, agent]) {
        expect(
          resolveView({
            activeTab: entity?.id ?? 'orch',
            picker: true,
            settings: false,
            entity,
            editorFull: false,
          }),
        ).toBe('picker');
      }
    });

    it('falls back to the orchestrator when the tab names no entity', () => {
      // A session can be removed while its tab is open. Stranding the user on a
      // blank stage is worse than sending them home.
      expect(
        resolveView({ activeTab: 'deleted-session', picker: false, settings: false, entity: null, editorFull: false }),
      ).toBe('orchestrator');
    });
  });

  it('resolves to exactly one state for every input combination', () => {
    const states = new Set<ViewState>();

    for (const settings of [true, false]) {
      for (const picker of [true, false]) {
        for (const editorFull of [true, false]) {
          for (const entity of [null, session, agent]) {
            for (const activeTab of ['orch', 'hero-refresh', 'slack-agent', 'gone']) {
              states.add(
                resolveView({ activeTab, picker, settings, entity, editorFull }),
              );
            }
          }
        }
      }
    }

    // All six states are reachable, and nothing else is.
    expect([...states].sort()).toEqual([
      'agent',
      'editor',
      'orchestrator',
      'picker',
      'session',
      'settings',
    ]);
  });

  describe('settings (story 101)', () => {
    /**
     * The realistic route into settings is the picker discovering it has no
     * projects to offer. If the picker won here, the user would be looking at
     * two stacked full-stage overlays.
     */
    it('wins over the picker', () => {
      expect(
        resolveView({
          activeTab: 'orch',
          picker: true,
          settings: true,
          entity: null,
          editorFull: false,
        }),
      ).toBe('settings');
    });

    it('wins over every underlying view', () => {
      for (const entity of [null, session, agent]) {
        expect(
          resolveView({
            activeTab: entity?.id ?? 'orch',
            picker: false,
            settings: true,
            entity,
            editorFull: false,
          }),
        ).toBe('settings');
      }
    });

    it('yields to the underlying view once closed', () => {
      // Closing settings must return the user to the terminal they were
      // watching, which only works because it never touched `activeTab`.
      expect(
        resolveView({
          activeTab: 'hero-refresh',
          picker: false,
          settings: false,
          entity: session,
          editorFull: false,
        }),
      ).toBe('session');
    });
  });

  /**
   * The editor, and the asymmetry that makes split placement work.
   *
   * `editorFull` is one boolean rather than the two facts behind it precisely
   * so that a split stage never resolves here: in a split the editor is a
   * *layout* of the entity view, and returning 'editor' would make
   * `isEntityView` false for a stage that is still showing a session's meta bar
   * and message row.
   */
  describe('the editor', () => {
    it('fills the stage when a file is open in full-stage placement', () => {
      expect(
        resolveView({
          activeTab: 'hero-refresh',
          picker: false,
          settings: false,
          entity: session,
          editorFull: true,
        }),
      ).toBe('editor');
    });

    it('yields to both overlays', () => {
      expect(
        resolveView({
          activeTab: 'orch',
          picker: true,
          settings: false,
          entity: null,
          editorFull: true,
        }),
      ).toBe('picker');
      expect(
        resolveView({
          activeTab: 'orch',
          picker: false,
          settings: true,
          entity: null,
          editorFull: true,
        }),
      ).toBe('settings');
    });

    it('leaves the underlying view untouched — split never resolves here', () => {
      // What a split stage passes: a file is open, but placement is 'split', so
      // the caller reports editorFull: false and the session view survives.
      expect(
        resolveView({
          activeTab: 'hero-refresh',
          picker: false,
          settings: false,
          entity: session,
          editorFull: false,
        }),
      ).toBe('session');
    });

    it('is not an entity view', () => {
      expect(isEntityView('editor')).toBe(false);
    });
  });
});

describe('isEntityView', () => {
  it('is true exactly for the views that show a terminal and meta bar', () => {
    expect(isEntityView('session')).toBe(true);
    expect(isEntityView('agent')).toBe(true);
    expect(isEntityView('orchestrator')).toBe(false);
    expect(isEntityView('picker')).toBe(false);
    expect(isEntityView('settings')).toBe(false);
  });
});
