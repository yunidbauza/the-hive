import { describe, expect, it } from 'vitest';

import {
  LEGACY_NOTIFICATION_KEYS,
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
    expect(isNotificationKind('session.blocked')).toBe(true);
    expect(isNotificationKind('slack.mention')).toBe(false);
    expect(isNotificationKind(3)).toBe(false);

    expect(isNotificationDelivery('both')).toBe(true);
    expect(isNotificationDelivery(true)).toBe(false);
  });

  /** The renderer's cap and the hub's are the same number by intent. */
  it('publishes one cap for both processes', () => {
    expect(NOTIFICATION_CAP).toBeGreaterThan(0);
  });

  /**
   * HIVE-83: `session.waiting` and `session.asked` merged into one kind, and
   * `session.ended` / `session.idle` were retired outright. HIVE-89 brought
   * `session.idle` back with a new meaning — the turn actually ended — so it
   * is live again and no longer a legacy key.
   */
  it('carries one blocked kind and no retired ones', () => {
    expect(NOTIFICATION_KINDS).toContain('session.blocked');
    for (const gone of ['session.waiting', 'session.asked', 'session.ended']) {
      expect(NOTIFICATION_KINDS).not.toContain(gone);
    }
  });

  it('revives session.idle as a live kind that interrupts by default', () => {
    expect(NOTIFICATION_KINDS).toContain('session.idle');
    expect(LEGACY_NOTIFICATION_KEYS).not.toContain('session.idle');
    const spec = NOTIFICATION_KIND_SPECS['session.idle'];
    expect(spec.source).toBe('session');
    expect(spec.defaultDelivery).toBe('both');
    expect(spec.label).not.toBe('');
    expect(spec.description).not.toBe('');
  });

  /**
   * A HIVE-75-era file that silenced the old `session.idle` keeps the revived
   * kind quiet too: same key, valid delivery, and preserving what the user
   * chose is the rule every legacy entry follows.
   */
  it('honours an old session.idle delivery as the choice for the revived kind', () => {
    expect(resolveNotificationPrefs({ 'session.idle': 'off' })['session.idle']).toBe('off');
  });

  /** The old `sessionIdle` boolean gated a pause-toast; it says nothing about this kind. */
  it('does not migrate the legacy sessionIdle boolean into the revived kind', () => {
    expect(resolveNotificationPrefs({ sessionIdle: false })['session.idle']).toBe('both');
  });

  /** `inbox`, not `both` — the toast is what made this kind chatty, not the row. */
  it('defaults the run-out-of-instructions row to the inbox', () => {
    expect(NOTIFICATION_KIND_SPECS['session.input_needed'].defaultDelivery).toBe('inbox');
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
    const prefs = resolveNotificationPrefs({ 'session.blocked': 'off' });
    expect(prefs['session.blocked']).toBe('off');
    expect(prefs['clone.done']).toBe(
      NOTIFICATION_KIND_SPECS['clone.done'].defaultDelivery,
    );
  });

  /**
   * The migration that keeps a promise the old contract made explicitly: a
   * preference someone already turned off must not come back on.
   */
  it('migrates the legacy cloneDone boolean', () => {
    const prefs = resolveNotificationPrefs({ cloneDone: false });

    expect(prefs['clone.done']).toBe('off');
  });

  /**
   * `sessionDone` and `sessionIdle` used to migrate into `session.ended` and
   * `session.idle`. HIVE-83 retires both kinds outright, so there is nothing
   * left for either boolean to become — accepted without error (see
   * `parse.test.ts`), migrated to nothing.
   */
  it('accepts the retired sessionDone and sessionIdle booleans without migrating them anywhere', () => {
    const prefs = resolveNotificationPrefs({ sessionDone: false, sessionIdle: true });

    expect(prefs).toEqual(defaultNotificationPrefs());
  });

  /** A downgrade-then-upgrade leaves both shapes in the file. Newer wins. */
  it('prefers a per-kind value over a legacy boolean for the same class', () => {
    const prefs = resolveNotificationPrefs({
      cloneDone: false,
      'clone.done': 'inbox',
    });
    expect(prefs['clone.done']).toBe('inbox');
  });

  it('ignores an unparseable value rather than coercing it', () => {
    const prefs = resolveNotificationPrefs({ 'session.blocked': 'loud' });
    expect(prefs['session.blocked']).toBe(
      NOTIFICATION_KIND_SPECS['session.blocked'].defaultDelivery,
    );
  });

  /**
   * Review Fix 8. Unlike `sessionDone`/`sessionIdle`, `session.waiting` and
   * `session.asked` **do** have somewhere left to go: HIVE-83 merged them
   * into `session.blocked`, and a config that had turned either off must not
   * find toasts back on because the parser only ever forwarded legacy
   * *booleans*, not the `NotificationDelivery` string these two retired keys
   * actually held.
   */
  it('migrates a retired session.waiting value into session.blocked', () => {
    const prefs = resolveNotificationPrefs({ 'session.waiting': 'off' });
    expect(prefs['session.blocked']).toBe('off');
  });

  it('migrates a retired session.asked value into session.blocked', () => {
    const prefs = resolveNotificationPrefs({ 'session.asked': 'inbox' });
    expect(prefs['session.blocked']).toBe('inbox');
  });

  it('takes the quieter of session.waiting and session.asked when both are present', () => {
    const prefs = resolveNotificationPrefs({
      'session.waiting': 'both',
      'session.asked': 'off',
    });
    expect(prefs['session.blocked']).toBe('off');
  });

  it('lets a current session.blocked value win over both retired keys', () => {
    const prefs = resolveNotificationPrefs({
      'session.waiting': 'off',
      'session.asked': 'off',
      'session.blocked': 'both',
    });
    expect(prefs['session.blocked']).toBe('both');
  });
});

describe('the agent kinds (HIVE-118)', () => {
  it('replaces agent.custom with four kinds under the agent source', () => {
    expect(NOTIFICATION_KINDS).not.toContain('agent.custom');
    expect(kindsForSource('agent')).toEqual([
      'agent.ask',
      'agent.permission',
      'agent.done',
      'agent.failed',
    ]);
  });

  it('gives each one the tone and delivery the design asks for', () => {
    expect(NOTIFICATION_KIND_SPECS['agent.ask']).toMatchObject({
      source: 'agent',
      tone: 'amber',
      defaultDelivery: 'both',
    });
    expect(NOTIFICATION_KIND_SPECS['agent.permission']).toMatchObject({
      tone: 'amber',
      defaultDelivery: 'both',
    });
    expect(NOTIFICATION_KIND_SPECS['agent.done']).toMatchObject({
      tone: 'green',
      defaultDelivery: 'inbox',
    });
    expect(NOTIFICATION_KIND_SPECS['agent.failed']).toMatchObject({
      tone: 'red',
      defaultDelivery: 'both',
    });
  });

  it('ignores a preference naming the retired kind', () => {
    const resolved = resolveNotificationPrefs({ 'agent.custom': 'off' });
    expect(resolved).not.toHaveProperty('agent.custom');
    expect(resolved['agent.ask']).toBe('both');
  });
});
