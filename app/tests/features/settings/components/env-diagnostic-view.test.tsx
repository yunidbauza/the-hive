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
    expect(screen.getByText('/opt/nonexistent-shell')).toBeInTheDocument();
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
            { key: 'A', configured: '1', actual: '1', overridden: false },
            { key: 'B', configured: '2', actual: '9', overridden: true },
          ],
        })}
      />,
    );

    expect(screen.getByText('A')).toBeInTheDocument();
    expect(screen.getByText('B')).toBeInTheDocument();
  });
});
