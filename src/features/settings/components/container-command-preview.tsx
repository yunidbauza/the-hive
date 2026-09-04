import { expandPreview } from '@features/settings/container-preview';
import type { ContainerConfig, ContainerDiagnostic } from '@shared/config-contract';

/**
 * The command this project will actually type, and whether it can run.
 *
 * The principle `CommandDiagnosticView` states — the thing explained must be
 * the thing run — applied to a command that is now assembled from six config
 * fields rather than typed whole. A user who cannot see the result has no way
 * to tell a wrong `workspace` from a wrong `envArg`.
 *
 * The token is elided. Every other value is shown as it will be sent, because
 * the point of the preview is that it is not a paraphrase.
 */
export function ContainerCommandPreview({
  command,
  config,
  projectId,
  diagnostic,
}: {
  command: string;
  config: ContainerConfig;
  projectId: string;
  diagnostic?: ContainerDiagnostic;
}) {
  const line = expandPreview(command, config, projectId);

  return (
    <div className="flex flex-col gap-1.5">
      <span className="text-[12.5px] text-muted">What will be typed</span>

      {/* Scrolls inside itself; the pane must never scroll horizontally. */}
      <pre className="overflow-x-auto rounded-[7px] border border-border-soft bg-term-bg px-3 py-2.5 text-[11.5px] leading-relaxed text-muted">
        {line}
      </pre>

      {diagnostic?.missingEnvPlaceholder === true ? (
        <p className="text-[11.5px] text-red">
          The agent command has no {'{env}'}, so no HIVE_ variable would reach
          the container and every hook would be refused.
        </p>
      ) : null}

      {diagnostic === undefined || diagnostic.probe === null ? null : (
        <div className="flex items-start gap-2 text-[12px]">
          <span
            aria-hidden
            className={`mt-1.5 size-[7px] shrink-0 rounded-full ${
              diagnostic.ok ? 'bg-green' : 'bg-red'
            }`}
          />
          <span className="text-muted">
            {diagnostic.ok ? (
              'Probe passed. The container is running.'
            ) : (
              <>
                <b className="font-semibold text-ink">
                  Probe failed (exit {diagnostic.exitCode ?? 'signal'})
                </b>{' '}
                <code>{diagnostic.stderr}</code>
              </>
            )}
          </span>
        </div>
      )}
    </div>
  );
}
