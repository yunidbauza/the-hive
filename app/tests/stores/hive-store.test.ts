import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { isSession } from '@/types/entity';
import { ACK_DELAY_MS, useHiveStore } from '@stores/hive-store';
import { useUiStore } from '@stores/ui-store';

/**
 * Reference pattern for store tests (story 013): call the action against a
 * fresh store and assert the resulting state. No React involved.
 *
 * Timer-based behaviour is driven with fake timers, never with real waits.
 */
describe('hive-store', () => {
  beforeEach(() => {
    useHiveStore.getState().reset();
    useUiStore.getState().reset();
  });

  describe('fixtures', () => {
    it('loads the concept dataset', () => {
      const state = useHiveStore.getState();

      expect(state.order).toHaveLength(10);
      expect(state.agentOrder).toHaveLength(3);
      expect(state.projects).toHaveLength(5);
      expect(state.tickets).toHaveLength(8);
      expect(state.prs).toHaveLength(4);
      expect(state.notifs).toHaveLength(5);
      expect(state.feed).toHaveLength(7);
      expect(state.orchLines).toHaveLength(3);
      expect(Object.keys(state.entities)).toHaveLength(13);
    });

    it('boots the orchestrator console with the maestro banner', () => {
      expect(useHiveStore.getState().orchLines[0].text).toContain(
        'maestro v0.4.2',
      );
    });
  });

  describe('spawnSession', () => {
    it('creates a session, appends it to the order, and opens its tab', () => {
      const id = useHiveStore.getState().spawnSession('apfm-web');
      const state = useHiveStore.getState();

      expect(state.order.at(-1)).toBe(id);
      expect(state.entities[id]).toBeDefined();
      expect(useUiStore.getState().activeTab).toBe(id);
    });

    it('derives the branch from the generated id', () => {
      const id = useHiveStore.getState().spawnSession('referral-api');
      const session = useHiveStore.getState().entities[id];

      expect(isSession(session) && session.branch).toBe(`feat/${id}`);
      expect(isSession(session) && session.project).toBe('referral-api');
    });

    it('starts idle when no task is given', () => {
      const id = useHiveStore.getState().spawnSession('apfm-web');
      const session = useHiveStore.getState().entities[id];

      expect(isSession(session) && session.status).toBe('idle');
    });

    it('starts working when a task is given', () => {
      const id = useHiveStore.getState().spawnSession('apfm-web', 'Fix the nav');
      const session = useHiveStore.getState().entities[id];

      expect(isSession(session) && session.status).toBe('working');
    });

    it('seeds three transcript lines', () => {
      const id = useHiveStore.getState().spawnSession('apfm-web', 'Fix the nav');
      const session = useHiveStore.getState().entities[id];

      expect(isSession(session) && session.lines).toHaveLength(3);
    });

    it('defaults to opus / high effort', () => {
      const id = useHiveStore.getState().spawnSession('apfm-web');
      const session = useHiveStore.getState().entities[id];

      expect(isSession(session) && session.model).toBe('opus');
      expect(isSession(session) && session.effort).toBe('high');
    });

    it('honours an explicit model and effort', () => {
      const id = useHiveStore
        .getState()
        .spawnSession('apfm-web', 'Spike', 'haiku', 'low');
      const session = useHiveStore.getState().entities[id];

      expect(isSession(session) && session.model).toBe('haiku');
      expect(isSession(session) && session.effort).toBe('low');
    });

    it('pushes a feed item', () => {
      const before = useHiveStore.getState().feed.length;
      const id = useHiveStore.getState().spawnSession('design-system');

      const feed = useHiveStore.getState().feed;
      expect(feed).toHaveLength(before + 1);
      expect(feed[0].txt).toBe(`Spawned ${id} on design-system`);
    });

    it('gives each session a distinct id', () => {
      const first = useHiveStore.getState().spawnSession('apfm-web');
      const second = useHiveStore.getState().spawnSession('apfm-web');

      expect(first).not.toBe(second);
    });
  });

  describe('sendToEntity', () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it('appends the routed message immediately, in cyan', () => {
      useHiveStore.getState().sendToEntity('lead-form', 'y');
      const entity = useHiveStore.getState().entities['lead-form'];

      const last = entity.lines.at(-1);
      expect(last?.text).toBe('❯ [orchestrator] y');
      expect(last?.color).toBe('cyan');
    });

    it('acknowledges and starts working only after the delay', () => {
      useHiveStore.getState().sendToEntity('lead-form', 'y');

      expect(
        useHiveStore.getState().entities['lead-form'],
      ).toMatchObject({ status: 'waiting' });

      vi.advanceTimersByTime(ACK_DELAY_MS);

      const entity = useHiveStore.getState().entities['lead-form'];
      expect(isSession(entity) && entity.status).toBe('working');
      expect(entity.lines.at(-1)?.text).toBe('✱ Working…');
      expect(entity.lines.at(-2)?.text).toBe('  acknowledged — y');
    });

    it('returns the timer handle so the ack can be cancelled', () => {
      const handle = useHiveStore.getState().sendToEntity('lead-form', 'y');
      expect(handle).not.toBeNull();

      clearTimeout(handle!);
      vi.advanceTimersByTime(ACK_DELAY_MS);

      // Only the routed message landed; the acknowledgement never fired.
      const entity = useHiveStore.getState().entities['lead-form'];
      expect(entity.lines.at(-1)?.text).toBe('❯ [orchestrator] y');
    });

    it('is a no-op for an unknown entity', () => {
      const handle = useHiveStore.getState().sendToEntity('nope', 'hi');
      expect(handle).toBeNull();
    });

    it('pushes a feed item', () => {
      useHiveStore.getState().sendToEntity('call-notes', 'immutable');
      expect(useHiveStore.getState().feed[0].txt).toBe(
        'Routed your reply to call-notes',
      );
    });
  });

  describe('runOrchCommand', () => {
    it('ignores blank input', () => {
      const before = useHiveStore.getState().orchLines.length;
      useHiveStore.getState().runOrchCommand('   ');
      expect(useHiveStore.getState().orchLines).toHaveLength(before);
    });

    it('echoes the command', () => {
      useHiveStore.getState().runOrchCommand('help');
      expect(useHiveStore.getState().orchLines[3].text).toBe('❯ help');
    });

    it('lists commands for help', () => {
      useHiveStore.getState().runOrchCommand('help');
      const text = useHiveStore
        .getState()
        .orchLines.map((l) => l.text)
        .join('\n');
      expect(text).toContain('send <session> <message>');
    });

    it('routes a send to the target session', () => {
      vi.useFakeTimers();
      useHiveStore.getState().runOrchCommand('send lead-form y please');

      const entity = useHiveStore.getState().entities['lead-form'];
      expect(entity.lines.at(-1)?.text).toBe('❯ [orchestrator] y please');
      vi.useRealTimers();
    });

    it('rejects send with no message', () => {
      useHiveStore.getState().runOrchCommand('send lead-form');
      expect(useHiveStore.getState().orchLines.at(-1)).toMatchObject({
        text: '  usage: send <session> <message>',
        color: 'red',
      });
    });

    it('reports an unknown session', () => {
      useHiveStore.getState().runOrchCommand('send nope hello');
      expect(useHiveStore.getState().orchLines.at(-1)).toMatchObject({
        text: '  no such session: nope',
        color: 'red',
      });
    });

    it('reports an unknown command', () => {
      useHiveStore.getState().runOrchCommand('frobnicate');
      expect(useHiveStore.getState().orchLines.at(-1)).toMatchObject({
        text: '  unknown command: frobnicate',
        color: 'red',
      });
    });
  });

  describe('inbox', () => {
    it('markRead clears exactly one notification', () => {
      useHiveStore.getState().markRead(0);
      const notifs = useHiveStore.getState().notifs;

      expect(notifs[0].unread).toBe(false);
      expect(notifs[1].unread).toBe(true);
    });

    it('markAllRead clears every notification', () => {
      useHiveStore.getState().markAllRead();
      expect(
        useHiveStore.getState().notifs.every((n) => !n.unread),
      ).toBe(true);
    });
  });

  describe('pushFeed', () => {
    it('prepends, so the newest item reads first', () => {
      useHiveStore.getState().pushFeed({
        time: '15:00',
        txt: 'newest',
        tone: 'green',
        icon: 'ph-lightning',
      });
      expect(useHiveStore.getState().feed[0].txt).toBe('newest');
    });

    it('caps the feed at 24 items', () => {
      for (let i = 0; i < 40; i += 1) {
        useHiveStore.getState().pushFeed({
          time: '15:00',
          txt: `item ${i}`,
          tone: 'brand',
          icon: 'ph-lightning',
        });
      }

      const feed = useHiveStore.getState().feed;
      expect(feed).toHaveLength(24);
      // The cap drops the oldest, not the newest.
      expect(feed[0].txt).toBe('item 39');
    });
  });

  describe('appendEntityLines', () => {
    it('appends without touching status by default', () => {
      const before = useHiveStore.getState().entities['hero-refresh'];
      useHiveStore
        .getState()
        .appendEntityLines('hero-refresh', [{ text: 'more', color: 'ink' }]);

      const after = useHiveStore.getState().entities['hero-refresh'];
      expect(after.lines).toHaveLength(before.lines.length + 1);
      expect(isSession(after) && after.status).toBe('working');
    });

    it('updates status when one is supplied', () => {
      useHiveStore
        .getState()
        .appendEntityLines('hero-refresh', [{ text: 'done', color: 'green' }], 'done');

      const entity = useHiveStore.getState().entities['hero-refresh'];
      expect(isSession(entity) && entity.status).toBe('done');
    });

    it('leaves agents alone apart from their transcript', () => {
      useHiveStore
        .getState()
        .appendEntityLines('slack-agent', [{ text: 'ping', color: 'ink' }]);

      const entity = useHiveStore.getState().entities['slack-agent'];
      expect(entity.status).toBe('online');
      expect(entity.lines.at(-1)?.text).toBe('ping');
    });

    it('is a no-op for an unknown entity', () => {
      const before = useHiveStore.getState().entities;
      useHiveStore
        .getState()
        .appendEntityLines('nope', [{ text: 'x', color: 'ink' }]);

      expect(useHiveStore.getState().entities).toEqual(before);
    });
  });
});
