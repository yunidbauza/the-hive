import type { ContainerConfig } from '@shared/config-contract';
import { DEFAULT_ENV_ARG } from '@shared/config-contract';

/** Stands in for the real token, which must never be rendered. */
const ELIDED = 'a3f…';

/**
 * The command as it will be typed, with sample identity.
 *
 * Deliberately a **second** implementation of the expansion rather than an
 * import of `container-command.ts`: that module is main-process code, and
 * `src/**` may not import `electron/main/**` — the fence fails the build. The
 * shapes are pinned to each other by `tests/features/settings/container-preview.test.ts`, which
 * asserts this output against the same inputs `container-command.test.ts` uses.
 *
 * `config` is the **file** shape — `envArg` may be absent, exactly as it is
 * on disk when a project has not overridden it — so it is defaulted here the
 * same way `effectiveRuntime` defaults it for a real spawn. `hostAlias` stays
 * un-defaulted: unlike `envArg` there is no single fallback this function
 * could apply on its own (it inherits `receiver.hostAlias`, which this helper
 * is never given), so the caller resolves it before calling in — see
 * `container-group.tsx`'s `effective`.
 */
export function expandPreview(
  command: string,
  config: ContainerConfig,
  projectId: string,
): string {
  const envArg = config.envArg ?? DEFAULT_ENV_ARG;
  const env: Record<string, string> = {
    HIVE_SESSION_ID: projectId,
    HIVE_HOOK_TOKEN: ELIDED,
    HIVE_RECEIVER_URL: `http://${config.hostAlias}:63999`,
  };

  const args = Object.entries(env)
    .map(([name, value]) =>
      envArg.replaceAll('{name}', name).replaceAll('{value}', `'${value}'`),
    )
    .join(' ');

  const settings =
    config.freshness === 'rewrite'
      ? `${config.hiveDir}/container/sessions/${projectId}/claude-hooks.settings.json`
      : `${config.hiveDir}/container/claude-hooks.settings.json`;

  const flags = `--settings '${settings}' --plugin-dir '${config.hiveDir}/plugin'`;

  return command.includes('{env}')
    ? `${command.replaceAll('{env}', args)} ${flags}`
    : `${command} ${flags}`;
}
