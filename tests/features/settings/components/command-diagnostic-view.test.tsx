import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import type { CommandDiagnostic } from '@shared/config-contract';

import { CommandDiagnosticView } from '@features/settings/components/command-diagnostic-view';

const diagnostic = (over: Partial<CommandDiagnostic> = {}): CommandDiagnostic => ({
  projectId: null,
  command: 'claude',
  isPath: false,
  resolved: null,
  path: '/usr/bin:/bin',
  probes: [
    { directory: '/usr/bin', found: false },
    { directory: '/bin', found: false },
  ],
  ...over,
});

describe('CommandDiagnosticView', () => {
  it('reports where a found command resolved', () => {
    render(
      <CommandDiagnosticView
        diagnostic={diagnostic({
          resolved: '/usr/bin/claude',
          probes: [{ directory: '/usr/bin', found: true }],
        })}
      />,
    );

    expect(screen.getByText('/usr/bin/claude')).toBeInTheDocument();
    expect(screen.getByText(/resolves to/)).toBeInTheDocument();
  });

  it('explains the launchd PATH problem when nothing was found', () => {
    render(<CommandDiagnosticView diagnostic={diagnostic()} />);

    expect(screen.getByText(/was not found/)).toBeInTheDocument();
    // The actual answer is almost never "you did not install it" — it is that a
    // GUI app does not inherit the login shell's PATH.
    expect(
      screen.getByText(/not the one your login shell builds/),
    ).toBeInTheDocument();
  });

  it('lists every directory it searched', () => {
    render(<CommandDiagnosticView diagnostic={diagnostic()} />);

    expect(screen.getByText('/usr/bin')).toBeInTheDocument();
    expect(screen.getByText('/bin')).toBeInTheDocument();
  });

  it('calls out a file that is present but not executable', () => {
    render(
      <CommandDiagnosticView
        diagnostic={diagnostic({
          probes: [{ directory: '/usr/bin', found: false, notExecutable: true }],
        })}
      />,
    );

    expect(screen.getByText('present, not executable')).toBeInTheDocument();
  });

  it('says PATH was never consulted for a command used as a path', () => {
    render(
      <CommandDiagnosticView
        diagnostic={diagnostic({
          command: '/opt/claude',
          isPath: true,
          probes: [],
        })}
      />,
    );

    // Telling the user to fix their PATH here would send them editing
    // something that was never read.
    expect(screen.getByText(/is never consulted/)).toBeInTheDocument();
  });

  it('renders an empty PATH as a legible placeholder', () => {
    render(<CommandDiagnosticView diagnostic={diagnostic({ path: '', probes: [] })} />);

    expect(screen.getByText('(empty)')).toBeInTheDocument();
  });
});
