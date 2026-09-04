import { chmod, mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { ContainerFreshness } from '@shared/config-contract';

import { withHostAlias } from '../hooks/container-origin';
import {
  type HookIdentity,
  agentSettings,
  hookSettings,
  metricsScript,
  statusLineSettings,
} from '../hooks/settings';
import { containerMcpConfig } from '../mcp/container-config';

/**
 * The container-flavoured set of every file a session is launched with
 * (HIVE-132).
 *
 * A **parallel** set rather than a branch inside the existing writers, for the
 * reason `hooks/settings.ts` already gives about writing both themes up front:
 * writing everything ahead of time means the spawn path never writes, it picks
 * a path. Nothing here decides *which* path — that is HIVE-133's per-project
 * `container` block, and its absence is why this module has no notion of a
 * session being containerised.
 *
 * The filenames match the host set exactly, one directory down, so that choice
 * is a directory swap rather than a per-file mapping.
 */

/** `<userData>/hive/container` — the shared, secret-free `exec-env` set. */
export const CONTAINER_DIR = join('hive', 'container');

/**
 * `<userData>/hive/container/sessions` — one directory per session, `rewrite`
 * only.
 *
 * Per-session because a resolved `HIVE_HOOK_TOKEN` is per-session, and one
 * shared file cannot carry a per-session secret. That reintroduces exactly what
 * the one-file-per-launch rule avoided — per-session cleanup, and a directory
 * that grows by one entry every time a session starts — so both are paid for
 * rather than inherited: {@link removeSessionContainerFiles} when a session
 * ends, and {@link sweepSessionContainerFiles} at launch for whatever a crash
 * left behind.
 */
export const CONTAINER_SESSIONS_DIR = join(CONTAINER_DIR, 'sessions');

const MCP_FILE = 'hive.mcp.json';
const SETTINGS_FILE = 'claude-hooks.settings.json';
const AGENT_FILE = 'claude-agent.settings.json';
const SCRIPT_FILE = 'statusline.sh';

/** The receiver's URLs, as some host addresses them. */
export interface ContainerOrigins {
  url: string;
  origin: string;
  metricsUrl?: string;
  readyUrl?: string;
}

/**
 * The same URLs, addressed by `alias` instead of loopback.
 *
 * Uniform across every field because each is `origin + <fixed path>` and
 * `withHostAlias` rewrites the authority in place: it never touches the path,
 * and it never *adds* one to a bare origin the way a `new URL()` round-trip
 * does.
 */
export const containerOrigins = (
  origins: ContainerOrigins,
  alias: string,
): ContainerOrigins => ({
  url: withHostAlias(origins.url, alias),
  origin: withHostAlias(origins.origin, alias),
  ...(origins.metricsUrl === undefined
    ? {}
    : { metricsUrl: withHostAlias(origins.metricsUrl, alias) }),
  ...(origins.readyUrl === undefined
    ? {}
    : { readyUrl: withHostAlias(origins.readyUrl, alias) }),
});

const writeSet = async (
  root: string,
  origins: ContainerOrigins,
  freshness: ContainerFreshness,
  identity?: HookIdentity,
): Promise<void> => {
  await mkdir(root, { recursive: true });

  const settings = hookSettings(origins.url, origins.readyUrl, identity);

  if (origins.metricsUrl !== undefined) {
    const scriptPath = join(root, SCRIPT_FILE);

    await writeFile(
      scriptPath,
      metricsScript(origins.metricsUrl, identity),
      'utf8',
    );
    /* Owner-only, for the reason `writeHookSettings` sets the same bit. */
    await chmod(scriptPath, 0o700);
    settings.statusLine = statusLineSettings(scriptPath);
  }

  await writeFile(
    join(root, SETTINGS_FILE),
    `${JSON.stringify(settings, null, 2)}\n`,
    'utf8',
  );
  await writeFile(
    join(root, AGENT_FILE),
    `${JSON.stringify(
      agentSettings(origins.url, origins.readyUrl, identity),
      null,
      2,
    )}\n`,
    'utf8',
  );
  await writeFile(
    join(root, MCP_FILE),
    containerMcpConfig(
      freshness,
      identity === undefined
        ? undefined
        : {
            receiverUrl: origins.origin,
            session: identity.session,
            token: identity.token,
          },
    ),
    'utf8',
  );
};

/**
 * The shared `exec-env` set, written once per launch beside the host one.
 *
 * Holds no secret: every per-session value is a `${VAR}` the container runtime
 * resolves at exec time, which is what lets this directory be mounted
 * read-only or baked into an image.
 */
export const writeSharedContainerFiles = (
  userDataPath: string,
  origins: ContainerOrigins,
): Promise<void> =>
  writeSet(join(userDataPath, CONTAINER_DIR), origins, 'exec-env');

/**
 * One session's `rewrite` set, with its identity resolved. Returns the
 * directory written.
 *
 * Called again for the same session on a re-launch, which is the point: a new
 * `launchSecret` means a new token, and the file has to say so or the container
 * 403s on every call.
 */
export async function writeSessionContainerFiles(
  userDataPath: string,
  sessionId: string,
  origins: ContainerOrigins,
  identity: HookIdentity,
): Promise<string> {
  const root = join(userDataPath, CONTAINER_SESSIONS_DIR, sessionId);

  await writeSet(root, origins, 'rewrite', identity);

  return root;
}

/**
 * Take one session's resolved token off disk.
 *
 * Silent when the session never had a directory — a host session ending is the
 * common case, not a failure.
 */
export async function removeSessionContainerFiles(
  userDataPath: string,
  sessionId: string,
): Promise<void> {
  await rm(join(userDataPath, CONTAINER_SESSIONS_DIR, sessionId), {
    recursive: true,
    force: true,
  });
}

/**
 * Remove every session directory except the live ones.
 *
 * Run at launch. Without it a crash leaves a resolved token on disk with no
 * session behind it, and the directory grows by one entry per crash forever.
 */
export async function sweepSessionContainerFiles(
  userDataPath: string,
  live: readonly string[],
): Promise<void> {
  const root = join(userDataPath, CONTAINER_SESSIONS_DIR);

  let entries: string[];

  try {
    entries = await readdir(root);
  } catch {
    /* Never written. Nothing to sweep is the common case, not a failure. */
    return;
  }

  const keep = new Set(live);

  await Promise.all(
    entries
      .filter((entry) => !keep.has(entry))
      .map((entry) => rm(join(root, entry), { recursive: true, force: true })),
  );
}
