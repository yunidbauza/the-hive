import { describe, expect, it } from 'vitest';

import {
  NOTIFICATION_CAP,
  NOTIFICATION_KINDS,
  NOTIFICATION_KIND_SPECS,
  NOTIFICATION_SOURCE_LABELS,
  NOTIFICATION_SOURCE_ORDER,
  defaultNotificationPrefs,
  isNotificationDelivery,
  isNotificationKind,
  kindsForSource,
  resolveNotificationPrefs,
} from '@shared/notification-contract';

describe('the kind registry', () => {
  /**
   * The property the whole design rests on: the settings section renders this
   * record, so a kind without an entry has no UI and cannot be configured.
   */
  it('has a complete spec for every kind', () => {
    for (const kind of NOTIFICATION_KINDS) {
      const spec = NOTIFICATION_KIND_SPECS[kind];
      expect(spec, kind).toBeDefined();
      expect(spec.label, kind).not.toBe('');
      expect(spec.description, kind).not.toBe('');
      expect(spec.icon, kind).toMatch(/^ph-/);
    }
  });

  /** Every source a kind claims must have a heading, or its group renders blank. */
  it('has a label and an ordering slot for every source in use', () => {
    for (const kind of NOTIFICATION_KINDS) {
      const { source } = NOTIFICATION_KIND_SPECS[kind];
      expect(NOTIFICATION_SOURCE_LABELS[source], kind).toBeDefined();
      expect(NOTIFICATION_SOURCE_ORDER, kind).toContain(source);
    }
  });

  /** Every kind is reachable through exactly one group. */
  it('partitions the kinds across the sources', () => {
    const grouped = NOTIFICATION_SOURCE_ORDER.flatMap((source) =>
      kindsForSource(source),
    );
    expect([...grouped].sort()).toEqual([...NOTIFICATION_KINDS].sort());
  });

  /**
   * Slack is HIVE-77 and has no producer. A registered kind would put a switch
   * in the pane that silently does nothing — the failure story 106 named.
   */
  it('registers no kind that nothing can raise yet', () => {
    expect(NOTIFICATION_KINDS.filter((k) => k.startsWith('slack.'))).toEqual([]);
  });

  it('recognises its own kinds and deliveries, and nothing else', () => {
    expect(isNotificationKind('session.waiting')).toBe(true);
    expect(isNotificationKind('slack.mention')).toBe(false);
    expect(isNotificationKind(3)).toBe(false);

    expect(isNotificationDelivery('both')).toBe(true);
    expect(isNotificationDelivery(true)).toBe(false);
  });

  /** The renderer's cap and the hub's are the same number by intent. */
  it('publishes one cap for both processes', () => {
    expect(NOTIFICATION_CAP).toBeGreaterThan(0);
  });
});

describe('resolveNotificationPrefs', () => {
  it('answers with the registry defaults for an absent block', () => {
    expect(resolveNotificationPrefs(undefined)).toEqual(
      defaultNotificationPrefs(),
    );
  });

  it('answers with the defaults for a block of the wrong shape', () => {
    expect(resolveNotificationPrefs('nonsense')).toEqual(
      defaultNotificationPrefs(),
    );
    expect(resolveNotificationPrefs([])).toEqual(defaultNotificationPrefs());
  });

  it('lets a per-kind value win over the default', () => {
    const prefs = resolveNotificationPrefs({ 'session.waiting': 'off' });
    expect(prefs['session.waiting']).toBe('off');
    expect(prefs['session.ended']).toBe(
      NOTIFICATION_KIND_SPECS['session.ended'].defaultDelivery,
    );
  });

  /**
   * The migration that keeps a promise the old contract made explicitly: a
   * preference someone already turned off must not come back on.
   */
  it('migrates the legacy booleans', () => {
    const prefs = resolveNotificationPrefs({
      sessionDone: false,
      sessionIdle: true,
      cloneDone: false,
    });

    expect(prefs['session.ended']).toBe('off');
    expect(prefs['session.idle']).toBe('both');
    expect(prefs['clone.done']).toBe('off');
  });

  /** A downgrade-then-upgrade leaves both shapes in the file. Newer wins. */
  it('prefers a per-kind value over a legacy boolean for the same class', () => {
    const prefs = resolveNotificationPrefs({
      sessionDone: false,
      'session.ended': 'inbox',
    });
    expect(prefs['session.ended']).toBe('inbox');
  });

  it('ignores an unparseable value rather than coercing it', () => {
    const prefs = resolveNotificationPrefs({ 'session.waiting': 'loud' });
    expect(prefs['session.waiting']).toBe(
      NOTIFICATION_KIND_SPECS['session.waiting'].defaultDelivery,
    );
  });
});
