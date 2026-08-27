import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import type { LoginEnvStatus } from '@shared/ipc-contract';

import { PHRASES } from '@lib/swarm/phrases';
import { PathSourceGroup } from '@features/settings/components/path-source-group';

/**
 * The ordinary post-HIVE-84 state: the import ran and replaced the `PATH`.
 *
 * Defaulted to the *succeeded* case, as it was in
 * `integrations-section.test.tsx` where these assertions used to live. The
 * failure and disabled shapes are passed explicitly by the tests that are
 * about them.
 */
const loginEnv = (over: Partial<LoginEnvStatus> = {}): LoginEnvStatus => ({
  enabled: true,
  imported: true,
  shell: '/bin/zsh',
  inheritedEntries: 4,
  effectiveEntries: 12,
  varsImported: ['PATH'],
  error: null,
  ...over,
});

describe('PathSourceGroup', () => {
  it('names the shell it imported from, and both entry counts', () => {
    render(<PathSourceGroup loginEnv={loginEnv()} />);

    expect(screen.getByText(/Imported from your login shell/)).toBeInTheDocument();
    expect(screen.getByText('/bin/zsh')).toBeInTheDocument();
    expect(
      screen.getByText(/12 entries · the inherited PATH had 4/),
    ).toBeInTheDocument();
  });

  it('names an imported token variable but never a value', () => {
    render(
      <PathSourceGroup loginEnv={loginEnv({ varsImported: ['PATH', 'GH_TOKEN'] })} />,
    );

    expect(screen.getByText(/Also taken from it/)).toBeInTheDocument();
    expect(screen.getByText('GH_TOKEN')).toBeInTheDocument();
    expect(screen.getByText(/never what they contain/)).toBeInTheDocument();
  });

  it('reports a clean run that changed nothing as success, not a warning', () => {
    // Launched from a terminal. The users with nothing wrong must not be shown
    // a warning.
    render(
      <PathSourceGroup
        loginEnv={loginEnv({
          imported: false,
          varsImported: [],
          inheritedEntries: 12,
          effectiveEntries: 12,
        })}
      />,
    );

    expect(screen.getByText(/Already your login shell/)).toBeInTheDocument();
    expect(screen.queryByText(/could not be read/)).not.toBeInTheDocument();
  });

  it('surfaces a failed import, and says the app kept what it had', () => {
    render(
      <PathSourceGroup
        loginEnv={loginEnv({
          imported: false,
          varsImported: [],
          effectiveEntries: 4,
          error: 'the shell did not finish within 5s and was killed (SIGKILL)',
        })}
      />,
    );

    expect(
      screen.getByText(/Your login shell could not be read/),
    ).toBeInTheDocument();
    expect(screen.getByText(/was killed \(SIGKILL\)/)).toBeInTheDocument();
    expect(
      screen.getByText(/kept the environment it was launched with/),
    ).toBeInTheDocument();
  });

  /**
   * The copy that moved with the group.
   *
   * In Integrations this sentence had to name its destination — "turned off in
   * Settings → Runtime". Here the switch is the previous group in the same
   * pane, so a path to somewhere the reader is already standing reads as a
   * redirect rather than an instruction.
   *
   * Past tense, though, and that is the load-bearing half. This group reports
   * what happened at *startup*; the switch above reports the config as it
   * stands and takes effect next launch. Written in the present, the two
   * disagree the instant someone flips it on — a switch reading ON directly
   * above a sentence saying it is off.
   */
  it('reports the launch, so it cannot contradict the switch above it', () => {
    render(
      <PathSourceGroup
        loginEnv={loginEnv({
          enabled: false,
          imported: false,
          shell: null,
          varsImported: [],
          effectiveEntries: 4,
        })}
      />,
    );

    expect(
      screen.getByText(/Inherited from whatever launched this app/),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/was off when this app started/),
    ).toBeInTheDocument();
    expect(screen.getByText(/takes effect on the next launch/)).toBeInTheDocument();
    // And it does not send the reader to a pane they are already standing in.
    expect(screen.queryByText(/Settings → Runtime/)).not.toBeInTheDocument();
  });

  it('says it is checking while the probe is still out', () => {
    render(<PathSourceGroup loginEnv={null} />);

    /**
     * The verb is drawn from a pool, so this asserts the group says it is busy
     * — in whichever words it drew — rather than pinning one of them.
     */
    const busy = PHRASES['loading.diagnostics'].flatMap((verb) =>
      screen.queryAllByText(verb),
    );

    expect(busy.length).toBeGreaterThan(0);
  });
});

describe('PathSourceGroup — when the read failed', () => {
  /**
   * The state that could not be reached before.
   *
   * `readLoginEnvStatus` answers `null` both for "no bridge" and for "the
   * channel threw", so a group treating `null` as "still waiting" would sit on
   * its checking line for the lifetime of the window — no error, no retry, and
   * nothing distinguishing a broken channel from a slow one.
   */
  it('says so, instead of claiming to still be checking', () => {
    render(<PathSourceGroup loginEnv="unavailable" />);

    expect(
      screen.getByText(/could not be asked what environment it is using/),
    ).toBeInTheDocument();
    expect(document.querySelector('[data-probing]')).toBeNull();
  });

  it('still shows the probing line while the read is genuinely out', () => {
    render(<PathSourceGroup loginEnv={null} />);

    expect(document.querySelector('[data-probing]')).not.toBeNull();
  });
});
