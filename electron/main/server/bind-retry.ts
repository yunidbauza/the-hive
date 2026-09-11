/**
 * Keep trying to bind the server socket until it binds (HIVE-147).
 *
 * On the Mac mini this ships to, `server.bind.host` is the machine's Tailscale
 * address, and at login Tailscale may not have brought that address up yet.
 * One failed attempt at boot used to be final: the tray named the error and
 * the server stayed unreachable until someone restarted it by hand, which on
 * an unattended machine means never. So a failed bind is retried, first after
 * {@link SERVER_BIND_RETRY_MS} and then doubling to {@link SERVER_BIND_RETRY_MAX_MS},
 * so a typo in the config costs a log line a minute rather than one every five
 * seconds. The listener records each failure as it happens, so the tray goes
 * on showing the latest reason until a bind lands.
 */

export const SERVER_BIND_RETRY_MS = 5_000;
export const SERVER_BIND_RETRY_MAX_MS = 60_000;

/**
 * @param start Resolves the bound URL, or `null` when the bind failed — the
 * shape `startRemoteListener` answers. A rejection counts as a failure.
 * @returns Stops retrying. Idempotent.
 */
export function bindUntilBound(start: () => Promise<string | null>): () => void {
  let stopped = false;
  let delay = SERVER_BIND_RETRY_MS;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const attempt = (): void => {
    void start()
      .catch(() => null)
      .then((url) => {
        if (url !== null || stopped) return;
        timer = setTimeout(attempt, delay);
        delay = Math.min(delay * 2, SERVER_BIND_RETRY_MAX_MS);
      });
  };
  attempt();

  return () => {
    stopped = true;
    clearTimeout(timer);
  };
}
