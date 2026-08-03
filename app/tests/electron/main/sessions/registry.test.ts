// @vitest-environment node
import { describe, expect, it } from 'vitest';

import { createSessionRegistry } from '../../../../electron/main/sessions/registry';

/**
 * `entityId → sessionId → pty` (story 096).
 *
 * The indirection buys exactly one thing, and every test here is about it:
 * output from a killed process is droppable rather than delivered to the
 * session that replaced it.
 */

describe('session registry', () => {
  it('mints a session id derived from the entity, and a new one per generation', () => {
    const registry = createSessionRegistry();

    const first = registry.open('hero-refresh');
    const second = registry.open('hero-refresh');

    expect(first).toContain('hero-refresh');
    expect(second).toContain('hero-refresh');
    // Derived rather than random: every log line and host-side error carries
    // this string, and `hero-refresh.g2` says which session and which
    // generation at a glance where a uuid says nothing.
    expect(second).not.toBe(first);
  });

  it('keeps session ids legal wherever an id is accepted', () => {
    // The IPC guard's pattern — a session id reaches process control, so it
    // stays a bounded printable token with no path separators.
    const registry = createSessionRegistry();
    expect(registry.open('hero-refresh')).toMatch(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/);
  });

  it('resolves the live session both ways', () => {
    const registry = createSessionRegistry();
    const sessionId = registry.open('hero-refresh');

    expect(registry.sessionFor('hero-refresh')).toBe(sessionId);
    expect(registry.entityFor(sessionId)).toBe('hero-refresh');
  });

  it('makes the previous generation unresolvable', () => {
    /**
     * The whole point. A restart's old process can still have bytes in flight
     * through the host, the supervisor and the batching layer. With one shared
     * id they would land in the new session's terminal, so a restarted `claude`
     * would open showing the tail of the conversation the user restarted to be
     * rid of.
     */
    const registry = createSessionRegistry();
    const stale = registry.open('hero-refresh');
    registry.open('hero-refresh');

    expect(registry.entityFor(stale)).toBeUndefined();
  });

  it('makes a closed session unresolvable', () => {
    const registry = createSessionRegistry();
    const sessionId = registry.open('hero-refresh');

    registry.close('hero-refresh');

    expect(registry.sessionFor('hero-refresh')).toBeUndefined();
    expect(registry.entityFor(sessionId)).toBeUndefined();
  });

  it('counts live sessions, which is what the cap is checked against', () => {
    const registry = createSessionRegistry();
    registry.open('a');
    registry.open('b');
    expect(registry.size()).toBe(2);
    expect(registry.entities().sort()).toEqual(['a', 'b']);

    // Re-opening the same entity is a new generation, not a new session.
    registry.open('a');
    expect(registry.size()).toBe(2);

    registry.close('a');
    expect(registry.size()).toBe(1);
  });

  it('tolerates closing something it never had', () => {
    const registry = createSessionRegistry();
    expect(() => registry.close('ghost')).not.toThrow();
  });
});
