import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import type { EnvDiagnostic } from '@shared/config-contract';

import { EnvDiagnosticView } from '@features/settings/components/env-diagnostic-view';

const diagnostic = (over: Partial<EnvDiagnostic> = {}): EnvDiagnostic => ({
  projectId: null,
  shell: '/bin/zsh',
  error: null,
  vars: [],
  ...over,
});

describe('EnvDiagnosticView', () => {
  it('reports a variable the shell kept', () => {
    render(
      <EnvDiagnosticView
        diagnostic={diagnostic({
          vars: [
            { key: 'AWS_PROFILE', configured: 'incorp', actual: 'incorp', overridden: false },
          ],
        })}
      />,
    );

    expect(screen.getByText('AWS_PROFILE')).toBeInTheDocument();
    // Only one "incorp" is rendered per row — the configured value — since
    // the actual value is identical and there is nothing extra to say.
    expect(screen.queryByText(/overridden by/)).not.toBeInTheDocument();
  });

  it('says a changed variable was overridden by the rc file, and shows what it became', () => {
    render(
      <EnvDiagnosticView
        diagnostic={diagnostic({
          vars: [
            { key: 'AWS_PROFILE', configured: 'hive', actual: 'incorp', overridden: true },
          ],
        })}
      />,
    );

    expect(screen.getByText(/overridden by your rc file/)).toBeInTheDocument();
    expect(screen.getByText('incorp')).toBeInTheDocument();
  });

  it('says a dropped variable was dropped, not merely overridden', () => {
    render(
      <EnvDiagnosticView
        diagnostic={diagnostic({
          vars: [{ key: 'AWS_PROFILE', configured: 'hive', actual: null, overridden: true }],
        })}
      />,
    );

    expect(screen.getByText(/dropped by your rc file/)).toBeInTheDocument();
    expect(screen.queryByText(/overridden by your rc file/)).not.toBeInTheDocument();
  });

  it('renders the probe failure rather than a verdict when the shell could not run', () => {
    render(
      <EnvDiagnosticView
        diagnostic={diagnostic({
          shell: '/opt/nonexistent-shell',
          error: 'spawn /opt/nonexistent-shell ENOENT',
          vars: [],
        })}
      />,
    );

    expect(screen.getByText(/ENOENT/)).toBeInTheDocument();
    // The invocation block ("Ran ...") always shows the exact shell that was
    // probed, whether or not the probe succeeded — it appears twice here,
    // once in that block and once in the error message itself.
    expect(screen.getAllByText(/\/opt\/nonexistent-shell/).length).toBeGreaterThan(0);
  });

  it('says nothing is configured when there is nothing to report', () => {
    render(<EnvDiagnosticView diagnostic={diagnostic({ vars: [] })} />);

    expect(screen.getByText(/No environment variables are configured/)).toBeInTheDocument();
  });

  it('lists more than one variable', () => {
    render(
      <EnvDiagnosticView
        diagnostic={diagnostic({
          vars: [
            { key: 'FOO_KEPT', configured: '1', actual: '1', overridden: false },
            // Overridden, so its key legitimately appears twice: once in the
            // row header, once again inside that row's own remediation
            // prose. Distinct from the kept variable's key precisely so this
            // test cannot pass by accident.
            { key: 'BAR_OVERRIDDEN', configured: '2', actual: '9', overridden: true },
          ],
        })}
      />,
    );

    expect(screen.getByText('FOO_KEPT')).toBeInTheDocument();
    expect(screen.getAllByText('BAR_OVERRIDDEN').length).toBeGreaterThan(0);
  });

  it('shows the exact shell and argv that were probed, even on a clean success', () => {
    render(
      <EnvDiagnosticView
        diagnostic={diagnostic({
          shell: '/bin/zsh',
          vars: [{ key: 'A', configured: '1', actual: '1', overridden: false }],
        })}
      />,
    );

    // Review's finding: a successful verdict never named what was probed,
    // which matters once per-project shell overrides are in the same
    // section. The exact invocation — including the interactive flag — is
    // now always shown, success or failure.
    expect(screen.getByText(/\/bin\/zsh.*-l.*-i.*-c.*printenv/)).toBeInTheDocument();
  });

  it('names the rc file as the likely cause and says what to do about an override', () => {
    render(
      <EnvDiagnosticView
        diagnostic={diagnostic({
          vars: [
            { key: 'AWS_PROFILE', configured: 'hive', actual: 'incorp', overridden: true },
          ],
        })}
      />,
    );

    // Matches `command-diagnostic-view.tsx`'s tone: name the likely cause and
    // what to do, not just state the fact and stop.
    expect(screen.getByText(/usually your shell.s rc file/)).toBeInTheDocument();
    expect(screen.getByText(/remove this variable from Settings/)).toBeInTheDocument();
  });

  it('documents the no-TTY gap rather than hiding it', () => {
    render(<EnvDiagnosticView diagnostic={diagnostic()} />);

    // The residual gap review asked to be surfaced: the probe has no
    // terminal, so a `[[ -t 0 ]]`-gated rc file can still diverge from a
    // real, PTY-backed session.
    expect(screen.getByText(/no terminal/)).toBeInTheDocument();
  });
});
