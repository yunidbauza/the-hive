import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import type {
  CommandDiagnostic,
  ConfigSnapshot,
  ContainerConfig,
  ContainerDiagnostic,
  EffectiveRuntime,
  ProjectConfig,
  ResolvedContainer,
} from '../../shared/config-contract';
import {
  DEFAULT_ENV_ARG,
  DEFAULT_FRESHNESS,
  ENV_PLACEHOLDER,
} from '../../shared/config-contract';

import { probeCommand } from './probe';

/**
 * What a session actually spawns with, and why (story 104).
 *
 * Two jobs, deliberately in one module: resolving the effective runtime, and
 * explaining where the command was looked for. Keeping them together is what
 * guarantees the diagnostic describes the *same* values the spawn path uses —
 * a diagnostic that resolved its own `PATH` would eventually reassure the user
 * about an environment no session runs in, which is exactly the failure it
 * exists to prevent.
 *
 * The filesystem search itself moved to `probe.ts` in story 106, when `gh`
 * detection needed the identical question asked. That does not weaken the
 * pairing above: choosing the command and the `PATH` — the part that must match
 * the spawn path — still happens here.
 */

/**
 * Finish a file's container block into the one a spawn can use.
 *
 * The parser reports what the file said and defaults nothing — the same
 * division {@link ConfigSnapshot.shell} and `subscriptionAuth` already use. So
 * every default in the block is applied here, in one place, against a snapshot
 * that has `receiver.hostAlias` already resolved.
 *
 * `probe` is the one field with no default: absent means no precondition, and
 * inventing one would run a command the user never configured.
 */
function resolveContainer(
  container: ContainerConfig,
  snapshot: ConfigSnapshot,
): ResolvedContainer {
  return {
    workspace: container.workspace,
    hiveDir: container.hiveDir,
    envArg: container.envArg ?? DEFAULT_ENV_ARG,
    ...(container.probe === undefined ? {} : { probe: container.probe }),
    freshness: container.freshness ?? DEFAULT_FRESHNESS,
    hostAlias: container.hostAlias ?? snapshot.receiver.hostAlias,
  };
}

/**
 * Resolve one project's runtime against the snapshot's top-level values.
 *
 * A project override wins; absent means inherit. There is no third state —
 * `parse.ts` already rejects a blank override and drops it, so an empty string
 * never reaches here to be mistaken for a deliberate choice.
 *
 * `project` is nullable because the top-level command is diagnosable on its own,
 * before any project is selected.
 */
export function effectiveRuntime(
  snapshot: ConfigSnapshot,
  project: ProjectConfig | null,
): EffectiveRuntime {
  const shellFromProject = project?.shell !== undefined;
  const commandFromProject = project?.claudeCommand !== undefined;

  return {
    shell: project?.shell ?? snapshot.shell,
    claudeCommand: project?.claudeCommand ?? snapshot.claudeCommand,
    /**
     * Workspace first, project over it, per key (story 108) — the same
     * "project overrides default" rule `shell` and `claudeCommand` above
     * already follow, so all three runtime values resolve the same way.
     *
     * A fresh object every call: the caller passes this to the pty-host, and
     * handing out either stored map would let a mutation downstream edit the
     * cached config.
     */
    env: { ...snapshot.env, ...(project?.env ?? {}) },
    shellFromProject,
    commandFromProject,
    ...(project?.container === undefined
      ? {}
      : { container: resolveContainer(project.container, snapshot) }),
  };
}

/**
 * Explain where a command was looked for, and what was found (story 104).
 *
 * The epic asks for "a PATH diagnostic that says why `claude` was not found".
 * The honest answer is nearly always that **the app's `PATH` is not the login
 * shell's `PATH`**: a GUI app launched from Finder or Dock inherits launchd's
 * environment, not the one `.zshrc` assembles, so a `claude` installed by a
 * version manager is genuinely absent from where the app can see — while being
 * obviously present in the user's terminal. Reporting the `PATH` that was
 * actually searched is what turns "command not found" into something the user
 * can act on.
 *
 * Read-only: it stats files and writes nothing, so it does not go through
 * `writeConfig`.
 *
 * `env` is the **merged** environment the session would get, not
 * `process.env` — a project that sets its own `PATH` must be diagnosed against
 * that `PATH`, or the diagnostic describes a session nobody is running.
 *
 * **POSIX only, deliberately.** `PATHEXT` is not consulted, so on Windows a
 * `claude.cmd` would be reported as not found. That is consistent rather than
 * wrong: the whole session model is POSIX today — `DEFAULT_SHELL` is
 * `/bin/sh`, `LOGIN_SHELL_ARGS` is `['-l']`, and nothing packages a Windows
 * build. Teaching only the diagnostic about Windows would make it describe a
 * session this app cannot start.
 *
 * **Asynchronous since HIVE-133.** A container precondition cannot be answered
 * by stat-ing the filesystem — it needs the runtime's own answer, which means
 * shelling out. Its only caller was already `Promise`-typed at the IPC
 * contract, so the change costs the renderer nothing.
 *
 * The probe is a user-authored command string, run through a shell. That is the
 * same trust level `claudeCommand` already has — it is typed verbatim into a
 * login shell on every spawn — and both come from a file the user owns.
 */
export async function diagnoseCommand(
  runtime: EffectiveRuntime,
  projectId: string | null,
  baseEnv: NodeJS.ProcessEnv = process.env,
  run: RunProbe = runProbeCommand,
): Promise<CommandDiagnostic> {
  const command = runtime.claudeCommand;
  const path = runtime.env.PATH ?? baseEnv.PATH ?? '';

  // The search itself lives in `probe.ts` (story 106), because `gh` detection
  // asks the identical question. What stays here is the part that is specific
  // to *this* diagnostic: which command to look for, and which `PATH` the
  // session would really use.
  const { isPath, resolved, probes } = probeCommand(command, path);

  const base = { projectId, command, isPath, resolved, path, probes };
  if (runtime.container === undefined) return base;

  return {
    ...base,
    container: await diagnoseContainer(
      runtime.container,
      command,
      { ...baseEnv, ...runtime.env },
      run,
    ),
  };
}

const execFileAsync = promisify(execFile);

/** Long enough for a cold container runtime, short enough not to freeze Settings. */
const PROBE_TIMEOUT_MS = 5_000;
/** A runtime error is a line or two; anything past this is not a diagnostic. */
const PROBE_MAX_BUFFER = 64 * 1024;

/**
 * Run one liveness probe and report what happened.
 *
 * Injected for the reason {@link RunLoginShell} is: the unit tests must be able
 * to answer without executing anything, or they assert the machine they run on.
 */
export type RunProbe = (
  command: string,
  options: { env: NodeJS.ProcessEnv; timeout: number },
) => Promise<{ code: number | null; stderr: string }>;

/**
 * Run the probe through a shell, the same way a session's `claudeCommand` is
 * spawned.
 *
 * Modelled on `login-env.ts`'s `runLoginShell`, which already paid for these
 * lessons: `execFile` rather than `spawnSync` so the timeout below can act
 * while the process runs; `killSignal: 'SIGKILL'`, because a `trap '' TERM` rc
 * file once blocked the main process for 20+ seconds against a 2-second
 * timeout; a bounded `maxBuffer`; and closing the child's stdin so a probe
 * that reads stdin gets an EOF instead of hanging until the kill. This runs on
 * the main process from a settings handler, so a hang here is a frozen pane.
 */
export const runProbeCommand: RunProbe = async (command, { env, timeout }) => {
  const probe = execFileAsync('/bin/sh', ['-c', command], {
    env,
    encoding: 'utf8',
    timeout,
    // Cannot be trapped or ignored — the second line of defence that makes the
    // timeout above something this process can actually rely on. `login-env.ts`
    // records the measurement that earned this: a `trap '' TERM` blocked the
    // main process for 20+ seconds against a 2-second timeout.
    killSignal: 'SIGKILL',
    maxBuffer: PROBE_MAX_BUFFER,
  });

  // `execFile` forwards no `stdio` option, so this is the only way to give the
  // child an EOF. Without it a probe that reads stdin blocks until the kill.
  probe.child?.stdin?.end();

  try {
    const { stderr } = await probe;
    return { code: 0, stderr: String(stderr) };
  } catch (cause) {
    /*
      `execFile`'s own error is honest about this even where the cast below
      was not (final-review fix): a probe that ran and exited abnormally
      reports a *numeric* `code`, but one that never got that far — `/bin/sh`
      itself missing, or a `maxBuffer` overrun — reports a *string* one
      (`'ENOENT'`, `'ERR_CHILD_PROCESS_STDIO_MAXBUFFER'`). The old
      `number | null` cast let a string code through unchanged into a field
      the type checker believed was numeric, and this diagnostic's own
      contract — `ContainerDiagnostic.exitCode: number | null` — means "what
      the probe exited with", which a spawn failure never reached. A string
      code becomes `null` here, with the code itself folded into `stderr`
      rather than silently dropped.
    */
    const error = cause as { code?: number | string | null; stderr?: string };
    const code = typeof error.code === 'number' ? error.code : null;
    const base = error.stderr === undefined || error.stderr === '' ? String(cause) : error.stderr;
    /*
      Appended, not substituted for, whatever stderr the probe did manage to
      write — a `maxBuffer` overrun still hands back the truncated buffer it
      collected before giving up, and that partial output is worth keeping
      alongside the reason it stopped, not instead of it.
    */
    const detail = typeof error.code === 'string' ? `${base} (${error.code})` : base;
    return { code, stderr: String(detail) };
  }
};

/**
 * The container half of the diagnostic, or the trivially-passing no-probe case.
 *
 * Never throws. A probe that cannot even start reports `ok: false` with the
 * reason in `stderr` — the same shape as one that ran and failed — so the pane
 * draws one thing either way.
 */
async function diagnoseContainer(
  container: ResolvedContainer,
  command: string,
  env: NodeJS.ProcessEnv,
  run: RunProbe,
): Promise<ContainerDiagnostic> {
  const missingEnvPlaceholder = !command.includes(ENV_PLACEHOLDER);

  if (container.probe === undefined) {
    return { probe: null, ok: true, exitCode: 0, stderr: '', missingEnvPlaceholder };
  }

  const { code, stderr } = await run(container.probe, {
    env,
    timeout: PROBE_TIMEOUT_MS,
  });

  return {
    probe: container.probe,
    ok: code === 0,
    exitCode: code,
    stderr: stderr.trim(),
    missingEnvPlaceholder,
  };
}
