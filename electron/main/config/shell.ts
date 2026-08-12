import os from 'node:os';
import path from 'node:path';

import { DEFAULT_SHELL } from '@shared/config-contract';

/**
 * The shell a session spawns when nothing overrides it.
 *
 * **`getpwuid`, not `$SHELL`.** Three comments in this codebase have long
 * claimed the default came from `$SHELL`; none of them was ever true, and
 * making it true would have been the wrong fix. A GUI app opened from Finder
 * or the Dock inherits launchd's environment, where `SHELL` is unset — the
 * same launch mode `config/runtime.ts` already warns about for `PATH`. So the
 * variable is absent in exactly the case that matters most, a packaged build.
 * `os.userInfo()` reads the password database, which is populated regardless
 * of how the process was started.
 *
 * Both inputs are injected so the branches are testable without mocking
 * `node:os`.
 */
export function defaultShell(
  userInfo: () => { shell?: string | null } = os.userInfo,
  platform: string = process.platform,
): string {
  let login: string | null | undefined;
  try {
    login = userInfo().shell;
  } catch {
    // A container or a directory service that cannot answer is not an error
    // worth surfacing — it is a reason to use the platform default.
    login = null;
  }

  /**
   * Absolute or nothing. A relative or empty entry cannot be spawned, and
   * letting it through would fail inside the child with no context — the
   * failure mode `config/resolve.ts` already documents for `cwd`.
   */
  if (typeof login === 'string' && login !== '' && path.isAbsolute(login)) {
    return login;
  }

  return platform === 'darwin' ? '/bin/zsh' : DEFAULT_SHELL;
}
