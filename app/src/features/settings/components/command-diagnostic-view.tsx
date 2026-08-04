import { CheckCircle, WarningCircle } from '@phosphor-icons/react';

import type { CommandDiagnostic } from '@shared/config-contract';

/**
 * Why the agent command was or was not found (story 104).
 *
 * The epic asks for "a PATH diagnostic that says why `claude` was not found".
 * The answer is almost never "you did not install it" — it is that **a GUI app
 * does not inherit the login shell's `PATH`**. On macOS an app launched from
 * Finder or Dock gets launchd's environment, not the one `.zshrc` assembles, so
 * a `claude` installed by a version manager is genuinely invisible here while
 * being obviously present in the user's terminal.
 *
 * So the failure case leads with that explanation and shows the `PATH` that was
 * actually searched, rather than asserting the command is missing.
 */

interface CommandDiagnosticViewProps {
  diagnostic: CommandDiagnostic;
}

export function CommandDiagnosticView({ diagnostic }: CommandDiagnosticViewProps) {
  const { command, resolved, isPath, path, probes } = diagnostic;
  const found = resolved !== null;

  return (
    <div className="flex flex-col gap-2 rounded-[7px] border border-border-soft p-3">
      <p className="flex items-start gap-2 text-[12.5px]">
        {found ? (
          <CheckCircle size={14} className="mt-px shrink-0 text-green" />
        ) : (
          <WarningCircle size={14} className="mt-px shrink-0 text-amber" />
        )}
        <span className={found ? 'text-ink' : 'text-amber'}>
          {found ? (
            <>
              <code className="font-mono">{command}</code> resolves to{' '}
              <code className="font-mono text-muted">{resolved}</code>
            </>
          ) : (
            <>
              <code className="font-mono">{command}</code> was not found
            </>
          )}
        </span>
      </p>

      {!found && !isPath ? (
        <p className="text-[11.5px] text-subtle">
          This app searches its own <code className="font-mono">PATH</code>, which is
          usually not the one your login shell builds — a desktop app inherits the
          environment it was launched from, not your <code className="font-mono">
            .zshrc
          </code>. Set an absolute path to the command above, or add its directory to
          this project&rsquo;s <code className="font-mono">PATH</code> variable.
        </p>
      ) : null}

      {!found && isPath ? (
        <p className="text-[11.5px] text-subtle">
          The command contains a path separator, so it is used as a path and{' '}
          <code className="font-mono">PATH</code> is never consulted. A relative path
          is resolved against the project directory when the session starts, which
          cannot be checked from here.
        </p>
      ) : null}

      <div className="flex flex-col gap-1">
        <span className="text-[11.5px] text-muted">Searched</span>
        <code className="rounded-[5px] bg-chip px-2 py-1.5 font-mono text-[11px] break-all text-muted">
          {path === '' ? '(empty)' : path}
        </code>
      </div>

      {probes.length > 0 ? (
        <ul className="flex flex-col gap-0.5">
          {probes.map((probe) => (
            <li
              key={probe.directory}
              className="flex items-center gap-2 font-mono text-[11px]"
            >
              <span
                aria-hidden
                className={
                  probe.found ? 'text-green' : probe.notExecutable ? 'text-amber' : 'text-subtle'
                }
              >
                {probe.found ? '✓' : probe.notExecutable ? '!' : '·'}
              </span>
              <span className={probe.found ? 'text-ink' : 'text-subtle'}>
                {probe.directory}
              </span>
              {/* The genuinely confusing case: the file is right there, and the
                  only reason it does not run is a missing +x bit. */}
              {probe.notExecutable ? (
                <span className="text-amber">present, not executable</span>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
