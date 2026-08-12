/**
 * `entityId → sessionId → pty` (story 096).
 *
 * The renderer addresses sessions by **entity id** and never sees a pty handle
 * or a session id. Main mints the session id, and mints a *new* one on every
 * restart.
 *
 * That indirection buys exactly one thing, and it is worth the whole module:
 * **stale output from a killed process is droppable**. A restart kills, waits,
 * and spawns — but the old process's last bytes can still be in flight through
 * the host, the supervisor and the batching layer when the new one starts. With
 * one shared id those bytes are indistinguishable from the new session's and
 * land in its terminal, so a restarted `claude` opens showing the tail of the
 * conversation the user just restarted to get rid of. With a generation, they
 * belong to an id nothing maps to any more and are dropped where they arrive.
 */

export interface SessionRegistry {
  /** Mint a session id for a new generation of this entity. */
  open(entityId: string): string;
  /** The live session id for an entity, or `undefined` if it has none. */
  sessionFor(entityId: string): string | undefined;
  /**
   * The entity a session id belongs to, or `undefined` if it is stale.
   *
   * `undefined` is the load-bearing answer: it is how output from a previous
   * generation gets dropped rather than delivered.
   */
  entityFor(sessionId: string): string | undefined;
  /** Forget this entity's current session. Its id becomes stale. */
  close(entityId: string): void;
  /** Every live entity id. */
  entities(): string[];
  /** How many sessions are live — what the cap is checked against. */
  size(): number;
  clear(): void;
}

export function createSessionRegistry(): SessionRegistry {
  const byEntity = new Map<string, string>();
  const bySession = new Map<string, string>();
  let generation = 0;

  return {
    open(entityId) {
      const previous = byEntity.get(entityId);
      if (previous !== undefined) bySession.delete(previous);

      generation += 1;
      /**
       * Derived from the entity id rather than random, and it matters for
       * debugging: every log line, diagnostic counter and host-side error
       * carries this string, and `hero-refresh.g3` says which session and which
       * generation at a glance where a uuid says nothing.
       *
       * `.` is deliberate — the IPC guard's id pattern allows it, so a session
       * id remains a legal id everywhere one is accepted.
       */
      const sessionId = `${entityId}.g${generation}`;
      byEntity.set(entityId, sessionId);
      bySession.set(sessionId, entityId);
      return sessionId;
    },

    sessionFor: (entityId) => byEntity.get(entityId),
    entityFor: (sessionId) => bySession.get(sessionId),

    close(entityId) {
      const sessionId = byEntity.get(entityId);
      if (sessionId === undefined) return;
      byEntity.delete(entityId);
      bySession.delete(sessionId);
    },

    entities: () => [...byEntity.keys()],
    size: () => byEntity.size,

    clear() {
      byEntity.clear();
      bySession.clear();
    },
  };
}
