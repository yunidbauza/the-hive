/**
 * The swarm layer — what the app says when it has nothing to say.
 *
 * ## Why a pool and not a line
 *
 * Every one of these surfaces used to carry exactly one sentence, and one
 * sentence read the same on the four-hundredth viewing as on the first. A pool
 * costs nothing to carry and turns a state the user sees constantly into one
 * they occasionally re-read.
 *
 * ## What a pool does NOT do
 *
 * It does not replace the copy that was already there. `empty-state.tsx` fixes
 * the convention — one sentence naming what is missing, then one naming the way
 * out — and a flavour line is a *third* thing, rendered above both. Nothing here
 * is decorative instead of useful; the useful sentences are untouched.
 *
 * That is also why this change is nearly invisible to the existing suite: the
 * assertions that matter still find their exact strings.
 *
 * ## Register
 *
 * Sentence case, one line, a full stop. No exclamation marks in idle states — an
 * empty list is not an emergency. No pun that has to be read twice. The failure
 * pools are the most restrained of all: amber and red already mean "something
 * went wrong", and a joke there reads as flippant.
 */

/**
 * A surface that can draw a phrase.
 *
 * Keys are `family.surface`. The family is the *state*, not the panel, because
 * two panels in different rails can be in the same state and the vocabulary
 * should agree with itself when they are.
 */
export type PhraseKey =
  // Empty — nothing to show.
  | 'empty.inbox'
  | 'empty.work'
  | 'empty.workUnconfigured'
  | 'empty.pullRequests'
  | 'empty.projects'
  | 'empty.agents'
  | 'empty.sessions'
  | 'empty.explorer'
  | 'empty.settingsProjects'
  | 'empty.editor'
  // A search that found nothing. Distinct from empty: something *is* there.
  | 'noMatch.picker'
  // Loading — in flight.
  | 'loading.directory'
  | 'loading.file'
  | 'loading.connection'
  | 'loading.diagnostics'
  | 'loading.update'
  | 'loading.transitions'
  // Working — an active session.
  | 'working.session'
  // Complete.
  | 'complete.update'
  // Failed. Deliberately the driest pools in the file.
  | 'failed.sessionExit'
  | 'failed.hostLost';

/**
 * The pools.
 *
 * `as const` all the way down so a typo in a key is a type error rather than an
 * empty pool at runtime, and so nothing can push onto one of these by accident.
 */
export const PHRASES = {
  'empty.inbox': [
    'The swarm is silent.',
    'No signals on the creep.',
    'All larvae accounted for.',
    'Nothing stirs in the hive.',
    'The Overmind rests.',
  ],
  'empty.work': [
    'Nothing left to mutate.',
    'The mutation queue is empty.',
    'No larvae in the incubation chamber.',
    'The evolution chamber is idle.',
  ],
  'empty.workUnconfigured': [
    'No psionic link to Jira.',
    'The hive cluster is unlinked.',
  ],
  'empty.pullRequests': [
    'Nothing awaits metamorphosis.',
    'No mutations awaiting approval.',
    'The chrysalis is empty.',
    'No spawn awaits your review.',
  ],
  'empty.projects': [
    'No hatcheries detected.',
    'The creep has not yet spread.',
    'Spawn more Overlords.',
    'This sector is unclaimed.',
  ],
  'empty.agents': ['The brood sleeps.', 'No drones assigned.', 'Ready to spawn.'],
  'empty.sessions': [
    'Awaiting your command.',
    'The hive is dormant.',
    'No broods active.',
  ],
  'empty.explorer': [
    'Barren ground.',
    'Nothing has taken root here.',
    'No creep in this sector.',
  ],
  'empty.settingsProjects': [
    'Unclaimed ground.',
    'No hatcheries detected.',
    'This sector is unclaimed.',
  ],
  'empty.editor': [
    'No strand under the microscope.',
    'No genome selected.',
    'Select a strand to splice.',
  ],
  'noMatch.picker': [
    'Nothing detected in this sector.',
    'No trace on the creep.',
    'The scan returns nothing.',
    'Detection field is clear.',
  ],
  /**
   * The two update pools are trailing asides — "Downloading 0.2.0… ·
   * incubating" — not standalone labels, so they carry no ellipsis and no
   * capital. The update line has to keep saying "Downloading" during a
   * multi-hundred-megabyte transfer; the flavour leads nowhere here, it
   * follows.
   */
  'loading.directory': ['Spreading creep…', 'Scanning the sector…'],
  'loading.file': ['Splicing…', 'Reading the strand…'],
  'loading.connection': ['Establishing psionic link…', 'Probing…'],
  'loading.diagnostics': ['Probing…', 'Scanning the sector…'],
  'loading.update': ['incubating', 'morphing'],
  'loading.transitions': ['Reading the strain…', 'Burrowing…'],
  'working.session': [
    'Metamorphosing…',
    'Mutating…',
    'Evolving…',
    'Spreading creep…',
    'Morphing…',
  ],
  'complete.update': ['metamorphosis complete', 'evolution complete'],
  'failed.sessionExit': ['the strain did not take', 'the mutation was rejected'],
  'failed.hostLost': ['unit lost', 'psionic link severed'],
} as const satisfies Record<PhraseKey, readonly [string, string, ...string[]]>;

/**
 * A source of randomness, injectable so the suite stays deterministic.
 *
 * `src/` contained no `Math.random` at all before this module, and a test that
 * has to retry until it happens to see every branch is not a test. Callers in
 * the app take the default; tests pass a stub and assert every index is
 * reachable.
 *
 * Contract: returns `[0, 1)`, exactly like `Math.random`.
 */
export type Rng = () => number;

/**
 * One phrase from the pool.
 *
 * Clamped rather than trusting the rng: a stub that returns exactly `1` — an
 * easy thing to write in a test, and outside `Math.random`'s range — would
 * otherwise index past the end and return `undefined`, which would reach the
 * screen as a blank line rather than as a failure.
 */
export function pickPhrase(key: PhraseKey, rng: Rng = Math.random): string {
  const pool = PHRASES[key];
  const index = Math.min(Math.floor(rng() * pool.length), pool.length - 1);

  return pool[Math.max(index, 0)];
}
