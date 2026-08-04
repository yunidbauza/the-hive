import { CheckCircle, WarningCircle } from '@phosphor-icons/react';

import type { EnvDiagnostic } from '@shared/config-contract';

/**
 * Which configured environment variables survived the shell's rc file
 * (story 108).
 *
 * The design decision this view exists to make visible: environment is
 * injected before the shell starts, and a login shell's rc file — which runs
 * afterward — can silently overwrite anything set here. Without this, "I set
 * FOO in Settings and it's still the old value" reads as a bug in this app
 * rather than a line in `.zshrc`. See `command-diagnostic-view.tsx` for the
 * sibling diagnostic this one is styled to match.
 */

interface EnvDiagnosticViewProps {
  diagnostic: EnvDiagnostic;
}

export function EnvDiagnosticView({ diagnostic }: EnvDiagnosticViewProps) {
  const { shell, error, vars } = diagnostic;

  if (error !== null) {
    return (
      <div className="flex flex-col gap-2 rounded-[7px] border border-border-soft p-3">
        <p className="flex items-start gap-2 text-[12.5px]">
          <WarningCircle size={14} className="mt-px shrink-0 text-amber" />
          <span className="text-amber">
            Could not probe <code className="font-mono">{shell}</code>: {error}
          </span>
        </p>
      </div>
    );
  }

  if (vars.length === 0) {
    return (
      <div className="flex flex-col gap-2 rounded-[7px] border border-border-soft p-3">
        <p className="text-[11.5px] text-subtle">
          No environment variables are configured for this shell.
        </p>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-2 rounded-[7px] border border-border-soft p-3">
      <ul className="flex flex-col gap-1.5">
        {vars.map((verdict) => (
          <li key={verdict.key} className="flex flex-col gap-0.5 text-[12.5px]">
            <p className="flex items-start gap-2">
              {verdict.overridden ? (
                <WarningCircle size={14} className="mt-px shrink-0 text-amber" />
              ) : (
                <CheckCircle size={14} className="mt-px shrink-0 text-green" />
              )}
              <span className={verdict.overridden ? 'text-amber' : 'text-ink'}>
                <code className="font-mono">{verdict.key}</code>
                {' = '}
                <code className="font-mono text-muted">{verdict.configured}</code>
              </span>
            </p>
            {verdict.overridden ? (
              <p className="pl-[22px] text-[11.5px] text-subtle">
                {verdict.actual === null ? (
                  <>
                    dropped by your rc file — the shell reported no such
                    variable
                  </>
                ) : (
                  <>
                    overridden by your rc file — the shell reported{' '}
                    <code className="font-mono">{verdict.actual}</code>
                  </>
                )}
              </p>
            ) : null}
          </li>
        ))}
      </ul>
    </div>
  );
}
