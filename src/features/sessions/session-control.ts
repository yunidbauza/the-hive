/**
 * The one refusal the renderer owns (story 096).
 *
 * Distinct from `DESKTOP_ONLY_REASON` in `config/runtime.ts`, which answers a
 * different question ("this control does nothing here") for a different
 * audience. This one is about starting a process. The wording lives here
 * rather than in `session-contract.ts` because `src/**` imports that module
 * type-only, so a shared message function is not reachable from the renderer.
 */
export const SESSIONS_REQUIRE_DESKTOP = 'sessions require the desktop app';
