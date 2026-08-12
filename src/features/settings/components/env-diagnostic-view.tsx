import { CheckCircle, WarningCircle } from '@phosphor-icons/react';

import { ENV_PROBE_ARGS, type EnvDiagnostic } from '@shared/config-contract';

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
 *
 * The exact invocation (`ENV_PROBE_ARGS`, shared with the module that runs
 * it) is shown whether the probe succeeded or failed, and on **every**
 * project — a section with per-project shell overrides is exactly the place
 * where "which shell did this actually check?" needs an answer visible on
 * screen, not just knowable by reading the code.
 */

interface EnvDiagnosticViewProps {
  diagnostic: EnvDiagnostic;
}

export function EnvDiagnosticView({ diagnostic }: EnvDiagnosticViewProps) {
  const { shell, error, vars } = diagnostic;

  return (
    <div className="flex flex-col gap-2 rounded-[7px] border border-border-soft p-3">
      <div className="flex flex-col gap-1">
        <span className="text-[11.5px] text-muted">Ran</span>
        <code className="rounded-[5px] bg-chip px-2 py-1.5 font-mono text-[11px] break-all text-muted">
          {shell} {ENV_PROBE_ARGS.join(' ')}
        </code>
        {/*
         * The residual gap review asked to be documented rather than hidden:
         * an interactive login shell sources rc files the same way a real
         * session's PTY-backed shell does, but this probe has no terminal —
         * so an rc file gated on `[[ -t 0 ]]` can still behave differently
         * here than it would for the user.
         */}
        <p className="text-[11px] text-subtle">
          Interactive, so rc files are sourced the same way a real session's
          would be — but this probe has no terminal, so a check like{' '}
          <code className="font-mono">[[ -t 0 ]]</code> in your rc file can
          still make it behave differently here than in a real session.
        </p>
      </div>

      {error !== null ? (
        <p className="flex items-start gap-2 text-[12.5px]">
          <WarningCircle size={14} className="mt-px shrink-0 text-amber" />
          <span className="text-amber">Could not probe this shell: {error}</span>
        </p>
      ) : vars.length === 0 ? (
        <p className="text-[11.5px] text-subtle">
          No environment variables are configured for this shell.
        </p>
      ) : (
        <ul className="flex flex-col gap-1.5">
          {vars.map((verdict) => (
            <li key={verdict.key} className="flex flex-col gap-1 text-[12.5px]">
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
                <div className="flex flex-col gap-1 pl-[22px]">
                  <p className="text-[11.5px] text-subtle">
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
                  {/*
                   * Remediation, matching `command-diagnostic-view.tsx`'s
                   * tone: name the likely cause and what to do about it,
                   * rather than stating the fact and stopping.
                   */}
                  <p className="text-[11.5px] text-subtle">
                    This is usually your shell&rsquo;s rc file —{' '}
                    <code className="font-mono">.zshrc</code>,{' '}
                    <code className="font-mono">.bash_profile</code>, or
                    similar — setting <code className="font-mono">{verdict.key}</code>{' '}
                    again after Settings&rsquo; value was already injected. Change
                    it there, or remove this variable from Settings if the rc
                    file&rsquo;s value is the one you actually want.
                  </p>
                </div>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
