import { describe, expect, it } from 'vitest';

import type { ContainerConfig } from '@shared/config-contract';

import { expandPreview } from '@features/settings/container-preview';

/**
 * Pins `expandPreview` — the renderer's own copy of the env-expansion logic —
 * against the same shapes `container-command.test.ts` asserts for the real
 * `expandEnvArgs`/`substituteEnv` pair in `electron/main/sessions/`. `src/**`
 * cannot import that module (the fence bans `electron/main/**`), so this is a
 * second implementation and these tests are what keeps the two from drifting.
 */

const config = (over: Partial<ContainerConfig> = {}): ContainerConfig => ({
  workspace: '/workspace',
  hiveDir: '/hive',
  envArg: '-e {name}={value}',
  freshness: 'exec-env',
  hostAlias: 'host.docker.internal',
  ...over,
});

describe('expandPreview', () => {
  it('elides the token — the real value must never be rendered', () => {
    const line = expandPreview(
      'docker exec -it {env} devbox claude',
      config(),
      'proj1',
    );

    expect(line).toContain('a3f…');
    expect(line).toContain('HIVE_HOOK_TOKEN');
  });

  it('expands one argument per variable, in the fixed order the substitution always uses', () => {
    const line = expandPreview(
      'docker exec -it {env} devbox claude',
      config({ envArg: '-e {name}={value}' }),
      'proj1',
    );

    expect(line).toContain(
      "-e HIVE_SESSION_ID='proj1' -e HIVE_HOOK_TOKEN='a3f…' -e HIVE_RECEIVER_URL='http://host.docker.internal:63999'",
    );
  });

  it('leaves the template text verbatim, so any runtime can spell it — mirrors container-command.test.ts', () => {
    const line = expandPreview(
      'docker exec -it {env} devbox claude',
      config({ envArg: '--env {name} --value {value}' }),
      'proj1',
    );

    expect(line).toContain("--env HIVE_SESSION_ID --value 'proj1'");
  });

  it('substitutes the host alias into HIVE_RECEIVER_URL', () => {
    const line = expandPreview(
      'docker exec -it {env} devbox claude',
      config({ hostAlias: 'gateway' }),
      'proj1',
    );

    expect(line).toContain("HIVE_RECEIVER_URL='http://gateway:63999'");
  });

  it('puts the expansion at {env}, exactly as substituteEnv does', () => {
    const line = expandPreview(
      'docker exec -it {env} devbox claude',
      config(),
      'proj1',
    );

    expect(line).toMatch(/^docker exec -it -e HIVE_SESSION_ID=.* devbox claude --settings/);
  });

  it('repeats the expansion at every {env} placeholder — the same shape substituteEnv pins', () => {
    const line = expandPreview('run {env} then {env}', config(), 'proj1');

    const firstIndex = line.indexOf('HIVE_SESSION_ID');
    const secondIndex = line.indexOf('HIVE_SESSION_ID', firstIndex + 1);
    expect(firstIndex).toBeGreaterThan(-1);
    expect(secondIndex).toBeGreaterThan(firstIndex);
  });

  it('appends the flags without expanding anything when the command has no {env}', () => {
    const line = expandPreview('docker exec -it devbox claude', config(), 'proj1');

    expect(line).toBe(
      "docker exec -it devbox claude --settings '/hive/container/claude-hooks.settings.json' --plugin-dir '/hive/plugin'",
    );
  });

  it('uses one shared settings file for exec-env', () => {
    const line = expandPreview(
      'docker exec -it {env} devbox claude',
      config({ freshness: 'exec-env' }),
      'proj1',
    );

    expect(line).toContain("--settings '/hive/container/claude-hooks.settings.json'");
  });

  it('uses a per-session settings file for rewrite, naming the project', () => {
    const line = expandPreview(
      'docker exec -it {env} devbox claude',
      config({ freshness: 'rewrite' }),
      'proj1',
    );

    expect(line).toContain(
      "--settings '/hive/container/sessions/proj1/claude-hooks.settings.json'",
    );
  });

  it('defaults envArg to DEFAULT_ENV_ARG when the file has not set one — the same default effectiveRuntime applies for a real spawn', () => {
    const bare: ContainerConfig = {
      workspace: '/workspace',
      hiveDir: '/hive',
      freshness: 'exec-env',
      hostAlias: 'host.docker.internal',
    };

    const line = expandPreview('docker exec -it {env} devbox claude', bare, 'proj1');

    expect(line).toContain("-e HIVE_SESSION_ID='proj1'");
  });

  it('always names the plugin dir under hiveDir', () => {
    const line = expandPreview(
      'docker exec -it {env} devbox claude',
      config({ hiveDir: '/mnt/hive' }),
      'proj1',
    );

    expect(line).toContain("--plugin-dir '/mnt/hive/plugin'");
  });
});
