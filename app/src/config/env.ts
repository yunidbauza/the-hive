/**
 * Runtime flags parsed from the query string.
 *
 * Story 010 (scaffold) establishes the module. Story 061 (simulation mode) owns
 * the `sim` flag's behaviour.
 */

const params = new URLSearchParams(
  typeof window === 'undefined' ? '' : window.location.search,
);

/** `?sim=1` replays a scripted event stream to make the demo feel alive (061). */
export const SIMULATION_ENABLED = params.get('sim') === '1';
