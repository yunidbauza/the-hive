import { join } from 'node:path';

/**
 * The two host trees a container session needs, and where each is mounted.
 *
 * Two rather than one, because the ticket's `workspace` alone cannot reach the
 * files a session is actually launched with. `--settings`, `--mcp-config` and
 * `--plugin-dir` all name paths under `<userData>/hive` — `HOOK_SETTINGS_DIR`,
 * `PLUGIN_DIR`, `CONTAINER_DIR` and `AGENT_MCP_DIR` are all rooted there — and
 * none of them is under `project.path`. One extra root covers all four.
 */
export interface PathMapRoots {
  /** The resolved, symlink-free project directory. */
  projectPath: string;
  /** Electron's `userData`; the hive root is `<userData>/hive`. */
  userDataPath: string;
  /** Container-side path of {@link projectPath}. */
  workspace: string;
  /** Container-side path of `<userData>/hive`. */
  hiveDir: string;
}

export interface PathMap {
  /** The container-side spelling of a host path, or `null` if unmapped. */
  toContainer(hostPath: string): string | null;
  /** The host-side spelling of a container path, or `null` if unmapped. */
  toHost(containerPath: string): string | null;
}

/**
 * `null`, never a guess.
 *
 * A path under neither root has no container-side spelling, and inventing one
 * would produce a flag that names a file the container cannot open — which
 * fails at `claude` startup with an error about the file rather than about the
 * mapping. The caller decides what unmappable means; for the three spawn flags
 * it means a diagnostic before the session starts.
 */
function translate(
  value: string,
  pairs: readonly (readonly [string, string])[],
): string | null {
  /*
    Longest source first, so a root nested inside another wins. Without it
    `/srv/data/hive` under `projectPath: '/srv'` would map through the project
    root and produce a path the container has never heard of.
  */
  const ordered = [...pairs].sort(([a], [b]) => b.length - a.length);

  for (const [from, to] of ordered) {
    if (value === from) return to;
    /*
      Segment-aware, not a bare `startsWith`. `/work` is not a prefix of
      `/workspace-2` in any sense that matters, and treating it as one maps a
      sibling project's file into this project's container.
    */
    if (value.startsWith(`${from}/`)) return `${to}${value.slice(from.length)}`;
  }

  return null;
}

export function createPathMap(roots: PathMapRoots): PathMap {
  const hiveRoot = join(roots.userDataPath, 'hive');

  const pairs = [
    [roots.projectPath, roots.workspace],
    [hiveRoot, roots.hiveDir],
  ] as const;

  const reversed = pairs.map(([host, container]) => [container, host] as const);

  return {
    toContainer: (hostPath) => translate(hostPath, pairs),
    toHost: (containerPath) => translate(containerPath, reversed),
  };
}
