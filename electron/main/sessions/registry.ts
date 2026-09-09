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
  /**
   * The generation number minted for this entity's **live** session, or
   * `undefined` if it has none (HIVE-144).
   *
   * The counter `open()` mints session ids from — `undefined` here means
   * exactly what `sessionFor` returning `undefined` means, for the same
   * reason. This is what lets `sessions/index.ts`'s `resume` tell a client
   * that watched the previous generation apart from one that watched the
   * current one: two lookups can independently answer "session id" and
   * "generation" for the same entity, but only if both come from state that
   * changes atomically with every `open()`/`close()` — parsing a generation
   * back out of a minted session id would not, because the id's shape is a
   * debugging affordance, not an API this function gets to depend on.
   */
  generationFor(entityId: string): number | undefined;
  /** Every live entity id. */
  entities(): string[];
  /** How many sessions are live — what the cap is checked against. */
  size(): number;
  clear(): void;
}

export function createSessionRegistry(): SessionRegistry {
  const byEntity = new Map<string, string>();
  const bySession = new Map<string, string>();
  /**
   * `entityId -> generation`, kept in step with `byEntity` — set in the same
   * `open()` call, deleted in the same `close()`/`clear()` (HIVE-144). Not
   * derived from `byEntity`'s value: the id's `.gN` suffix is a debugging
   * affordance (see {@link SessionRegistry.generationFor}), not a value this
   * module parses back out of itself.
   */
  const byGeneration = new Map<string, number>();
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
      byGeneration.set(entityId, generation);
      return sessionId;
    },

    sessionFor: (entityId) => byEntity.get(entityId),
    entityFor: (sessionId) => bySession.get(sessionId),
    generationFor: (entityId) => byGeneration.get(entityId),

    close(entityId) {
      const sessionId = byEntity.get(entityId);
      if (sessionId === undefined) return;
      byEntity.delete(entityId);
      bySession.delete(sessionId);
      byGeneration.delete(entityId);
    },

    entities: () => [...byEntity.keys()],
    size: () => byEntity.size,

    clear() {
      byEntity.clear();
      bySession.clear();
      byGeneration.clear();
    },
  };
}
