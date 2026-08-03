/**
 * Signal numbers to names, for the one place a user reads them (story 094).
 *
 * `node-pty` reports the raw number and main carries it through unchanged, so
 * the mapping has to happen somewhere. It happens here, in the renderer, for
 * the same reason colours do: this is a *display* concern, and main has no
 * business choosing the words a terminal shows.
 *
 * Only the signals that actually end a terminal session are listed. The numbers
 * below are the ones POSIX fixes, and they agree across macOS and Linux — the
 * two platforms that diverge (`SIGUSR1`/`SIGUSR2`, `SIGCHLD`) are deliberately
 * absent, because a wrong name is worse than a number: it sends the reader
 * looking for a cause that never happened.
 */
const SIGNAL_NAMES: Readonly<Record<number, string>> = {
  1: 'SIGHUP',
  2: 'SIGINT',
  3: 'SIGQUIT',
  4: 'SIGILL',
  6: 'SIGABRT',
  8: 'SIGFPE',
  9: 'SIGKILL',
  11: 'SIGSEGV',
  13: 'SIGPIPE',
  14: 'SIGALRM',
  15: 'SIGTERM',
};

/**
 * The name for a signal number, or `signal N` when it is not one we name.
 *
 * Never returns an empty string: this text goes into a sentence the user reads
 * ("session terminated (…)"), and a blank there reads as a rendering bug rather
 * than as an unusual signal.
 */
export function signalName(signal: number): string {
  return SIGNAL_NAMES[signal] ?? `signal ${signal}`;
}
