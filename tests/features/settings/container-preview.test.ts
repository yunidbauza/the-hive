import { describe, expect, it } from 'vitest';

import type { ContainerConfig } from '@shared/config-contract';

import { expandPreview } from '@features/settings/container-preview';

/**
 * Pins `expandPreview` — the renderer's own copy of the env-expansion logic —
 * against the same shapes `container-command.test.ts` asserts for the real
 * `expandEnvArgs`/`substituteEnv` pair in `electron/main/sessions/`. `src/**`
 * cannot import that module (the fence bans `electron/main/**`), so this is a
 * second implementation and these tests are what keeps the two from drifting.
 *
 * `GLOBAL_ALIAS` is the fourth argument every call below passes (final-review
 * fix, Important 5): the receiver's current global `hostAlias`, needed to
 * decide whether an `exec-env` project reads the shared set or its own alias
 * directory — see `hooks/index.ts`'s `config.hostAlias !== hostAlias()` and
 * `ipc/index.ts`'s mirroring `containerSet` comparison, which this preview
 * must agree with or it explains a command that is not the one that runs.
 * Every test but the ones under "the alias directory" below passes the same
 * value `config()`'s own `hostAlias` default already is, so none of them are
 * exercising divergence by accident.
 */

const GLOBAL_ALIAS = 'host.docker.internal';

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
      GLOBAL_ALIAS,
    );

    expect(line).toContain('a3f…');
    expect(line).toContain('HIVE_HOOK_TOKEN');
  });

  it('expands one argument per variable, in the fixed order the substitution always uses', () => {
    const line = expandPreview(
      'docker exec -it {env} devbox claude',
      config({ envArg: '-e {name}={value}' }),
      'proj1',
      GLOBAL_ALIAS,
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
      GLOBAL_ALIAS,
    );

    expect(line).toContain("--env HIVE_SESSION_ID --value 'proj1'");
  });

  it('substitutes the host alias into HIVE_RECEIVER_URL', () => {
    const line = expandPreview(
      'docker exec -it {env} devbox claude',
      config({ hostAlias: 'gateway' }),
      'proj1',
      GLOBAL_ALIAS,
    );

    expect(line).toContain("HIVE_RECEIVER_URL='http://gateway:63999'");
  });

  it('puts the expansion at {env}, exactly as substituteEnv does', () => {
    const line = expandPreview(
      'docker exec -it {env} devbox claude',
      config(),
      'proj1',
      GLOBAL_ALIAS,
    );

    expect(line).toMatch(/^docker exec -it -e HIVE_SESSION_ID=.* devbox claude --settings/);
  });

  it('repeats the expansion at every {env} placeholder — the same shape substituteEnv pins', () => {
    const line = expandPreview('run {env} then {env}', config(), 'proj1', GLOBAL_ALIAS);

    const firstIndex = line.indexOf('HIVE_SESSION_ID');
    const secondIndex = line.indexOf('HIVE_SESSION_ID', firstIndex + 1);
    expect(firstIndex).toBeGreaterThan(-1);
    expect(secondIndex).toBeGreaterThan(firstIndex);
  });

  it('appends the flags without expanding anything when the command has no {env}', () => {
    const line = expandPreview('docker exec -it devbox claude', config(), 'proj1', GLOBAL_ALIAS);

    expect(line).toBe(
      "docker exec -it devbox claude --settings '/hive/container/claude-hooks.settings.json' --plugin-dir '/hive/plugin' --mcp-config '/hive/container/hive.mcp.json'",
    );
  });

  it('uses one shared settings file for exec-env', () => {
    const line = expandPreview(
      'docker exec -it {env} devbox claude',
      config({ freshness: 'exec-env' }),
      'proj1',
      GLOBAL_ALIAS,
    );

    expect(line).toContain("--settings '/hive/container/claude-hooks.settings.json'");
  });

  it('uses a per-session settings file for rewrite, naming the project', () => {
    const line = expandPreview(
      'docker exec -it {env} devbox claude',
      config({ freshness: 'rewrite' }),
      'proj1',
      GLOBAL_ALIAS,
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

    const line = expandPreview('docker exec -it {env} devbox claude', bare, 'proj1', GLOBAL_ALIAS);

    expect(line).toContain("-e HIVE_SESSION_ID='proj1'");
  });

  it("escapes an embedded single quote in a value, mirroring shellQuote's POSIX idiom", () => {
    // container-command.test.ts's own case for `expandEnvArgs`:
    // `expandEnvArgs({ FOO: "a b'c" }, '-e {name}={value}')` →
    // `"-e FOO='a b'\\''c'"`. `projectId` is the one value here that is not
    // synthetic and not shape-checked, so it stands in for an arbitrary
    // value the way `FOO` does there.
    const line = expandPreview(
      'docker exec -it {env} devbox claude',
      config(),
      "a b'c",
      GLOBAL_ALIAS,
    );

    expect(line).toContain("HIVE_SESSION_ID='a b'\\''c'");
  });

  it('always names the plugin dir under hiveDir', () => {
    const line = expandPreview(
      'docker exec -it {env} devbox claude',
      config({ hiveDir: '/mnt/hive' }),
      'proj1',
      GLOBAL_ALIAS,
    );

    expect(line).toContain("--plugin-dir '/mnt/hive/plugin'");
  });

  /**
   * The two drifts a final-review pass caught between this preview and the
   * real spawn (HIVE-133, final-review fix, Important 5): `--mcp-config` is
   * missing entirely, though the spawn always passes it — `sessionCommand`'s
   * `flags` array includes it unconditionally once `mcpConfig` resolves,
   * which for a container project it always does (`mcp.configPathFor()` is
   * main's own path and never depends on the project). This component's
   * stated purpose is that the explanation *is* the thing run, so a preview
   * missing a flag the terminal will actually receive is not a rounding
   * error.
   */
  it('includes --mcp-config, matching what the spawn always passes', () => {
    const line = expandPreview(
      'docker exec -it {env} devbox claude',
      config(),
      'proj1',
      GLOBAL_ALIAS,
    );

    expect(line).toContain("--mcp-config '/hive/container/hive.mcp.json'");
  });

  it('uses a per-session mcp config for rewrite, naming the project — the same directory as --settings', () => {
    const line = expandPreview(
      'docker exec -it {env} devbox claude',
      config({ freshness: 'rewrite' }),
      'proj1',
      GLOBAL_ALIAS,
    );

    expect(line).toContain("--mcp-config '/hive/container/sessions/proj1/hive.mcp.json'");
  });

  /**
   * The second drift: an `exec-env` project whose `hostAlias` diverges from
   * the global one reads from `<hiveDir>/container/aliases/<alias>/…`
   * (`writeAliasContainerFiles`, `hooks/index.ts`) — but the old preview
   * always rendered `<hiveDir>/container/…`, the shared directory that
   * project's hooks would 403 against, since the shared set bakes the
   * *global* alias's origin.
   */
  describe('the alias directory', () => {
    it("reads the alias directory, not the shared one, when this project's hostAlias diverges from the global one", () => {
      const line = expandPreview(
        'docker exec -it {env} devbox claude',
        config({ freshness: 'exec-env', hostAlias: 'gateway' }),
        'proj1',
        GLOBAL_ALIAS,
      );

      expect(line).toContain(
        "--settings '/hive/container/aliases/gateway/claude-hooks.settings.json'",
      );
      expect(line).toContain("--mcp-config '/hive/container/aliases/gateway/hive.mcp.json'");
      expect(line).not.toContain("'/hive/container/claude-hooks.settings.json'");
    });

    it("still reads the shared directory when this project's hostAlias explicitly matches the global one", () => {
      const line = expandPreview(
        'docker exec -it {env} devbox claude',
        config({ freshness: 'exec-env', hostAlias: GLOBAL_ALIAS }),
        'proj1',
        GLOBAL_ALIAS,
      );

      expect(line).toContain("--settings '/hive/container/claude-hooks.settings.json'");
      expect(line).not.toContain('/aliases/');
    });

    it('uses the per-session directory for rewrite regardless of alias divergence — mirroring `writeContainerSession`, which never reads the alias set for `rewrite`', () => {
      const line = expandPreview(
        'docker exec -it {env} devbox claude',
        config({ freshness: 'rewrite', hostAlias: 'gateway' }),
        'proj1',
        GLOBAL_ALIAS,
      );

      expect(line).toContain(
        "--settings '/hive/container/sessions/proj1/claude-hooks.settings.json'",
      );
      expect(line).not.toContain('/aliases/');
    });
  });
});
