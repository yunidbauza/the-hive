/**
 * A plausible project key for a fixture (HIVE-94).
 *
 * Deliberately **not** `deriveProjectKey`. That function is production code
 * under test in `tests/electron/main/config/identity.test.ts`, and a fixture
 * factory that called it would assert its own behaviour into every other file —
 * a change to the generation rule would then rewrite the expectations of thirty
 * tests that have nothing to do with key generation.
 *
 * What fixtures actually need is a key that is *valid* (`[a-z]{2,4}`) and
 * *distinct* across the ids one test uses, which the first two letters give.
 * Padded so a one-letter id — `a`, `b`, `c` in the reorder tests — still
 * produces something the editor's own validation would accept.
 */
export const testProjectKey = (id: string): string =>
  (id.toLowerCase().replace(/[^a-z]/g, '').slice(0, 2) || 'px').padEnd(2, 'x');
