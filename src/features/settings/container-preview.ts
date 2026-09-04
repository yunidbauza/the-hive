import type { ContainerConfig } from '@shared/config-contract';
import { DEFAULT_ENV_ARG } from '@shared/config-contract';

/** Stands in for the real token, which must never be rendered. */
const ELIDED = 'a3f…';

/**
 * Wrap a value in single quotes, escaping any it contains.
 *
 * A duplicate of `electron/main/sessions/shell-quote.ts`'s `shellQuote`, for
 * the same reason `expandPreview` below is a duplicate of `expandEnvArgs`:
 * `src/**` cannot import `electron/main/**`. Kept even though every value
 * this module actually quotes today is synthetic and quote-free
 * (`HIVE_SESSION_ID` is a project id, `HIVE_HOOK_TOKEN` is always
 * {@link ELIDED}, `HIVE_RECEIVER_URL` is built from an `isHostAlias`-checked
 * value) — the point of pinning the quoting rule, not just the shape, is that
 * a preview claiming to show what will be typed must not be wrong the day
 * one of those assumptions changes.
 */
const quote = (value: string): string => `'${value.replaceAll("'", `'\\''`)}'`;

/**
 * The command as it will be typed, with sample identity.
 *
 * Deliberately a **second** implementation of the expansion rather than an
 * import of `container-command.ts`: that module is main-process code, and
 * `src/**` may not import `electron/main/**` — the fence fails the build.
 * Pinned to `expandEnvArgs`/`substituteEnv` by
 * `tests/features/settings/container-preview.test.ts`, which asserts this
 * output against the same shapes `container-command.test.ts` uses for
 * per-variable expansion, template-verbatim-ness, and quoting — not merely
 * against the same *inputs*, since the two modules' inputs cannot be
 * literally identical (this one builds its own synthetic `env`).
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
      envArg.replaceAll('{name}', name).replaceAll('{value}', quote(value)),
    )
    .join(' ');

  const settings =
    config.freshness === 'rewrite'
      ? `${config.hiveDir}/container/sessions/${projectId}/claude-hooks.settings.json`
      : `${config.hiveDir}/container/claude-hooks.settings.json`;

  const flags = `--settings ${quote(settings)} --plugin-dir ${quote(`${config.hiveDir}/plugin`)}`;

  return command.includes('{env}')
    ? `${command.replaceAll('{env}', args)} ${flags}`
    : `${command} ${flags}`;
}
