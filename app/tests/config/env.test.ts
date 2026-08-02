import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * `env.ts` reads the query string once at module load, so each case has to
 * re-import the module with a different `location.search`. `vi.resetModules()`
 * is what makes that possible — without it the first import is cached and every
 * later assertion tests the same value.
 */
async function loadEnvWithSearch(search: string) {
  vi.resetModules();
  vi.stubGlobal('window', { location: { search } });
  return import('@config/env');
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('SIMULATION_ENABLED', () => {
  it('is off by default', async () => {
    const { SIMULATION_ENABLED } = await loadEnvWithSearch('');
    expect(SIMULATION_ENABLED).toBe(false);
  });

  it('is on for ?sim=1', async () => {
    const { SIMULATION_ENABLED } = await loadEnvWithSearch('?sim=1');
    expect(SIMULATION_ENABLED).toBe(true);
  });

  it('reads sim alongside other params', async () => {
    const { SIMULATION_ENABLED } = await loadEnvWithSearch('?theme=light&sim=1');
    expect(SIMULATION_ENABLED).toBe(true);
  });

  it('treats any value other than 1 as off, rather than as truthy', async () => {
    const { SIMULATION_ENABLED } = await loadEnvWithSearch('?sim=0');
    expect(SIMULATION_ENABLED).toBe(false);
  });

  it('treats a bare ?sim as off', async () => {
    const { SIMULATION_ENABLED } = await loadEnvWithSearch('?sim');
    expect(SIMULATION_ENABLED).toBe(false);
  });

  it('does not touch window when there is none', async () => {
    vi.resetModules();
    vi.stubGlobal('window', undefined);

    const { SIMULATION_ENABLED } = await import('@config/env');
    expect(SIMULATION_ENABLED).toBe(false);
  });
});
