// @vitest-environment node
import { describe, expect, it } from 'vitest';

import { buildEnv, COLORTERM, TERM } from '../../../electron/pty-host/env';

/**
 * Environment sanitisation for spawned shells (story 092, HIVE-64).
 *
 * The module had no mirrored test, which is how the `CLAUDE_*` leak reached a
 * running build: every rule here is invisible until something downstream
 * behaves strangely, and nothing was pinning the deny list.
 */

describe('buildEnv', () => {
  it('passes ordinary variables through', () => {
    const env = buildEnv({ PATH: '/usr/bin', HOME: '/Users/dev' }, '/repo');

    expect(env.PATH).toBe('/usr/bin');
    expect(env.HOME).toBe('/Users/dev');
  });

  it('forces the terminal’s own identity last', () => {
    // An injected TERM is far likelier to be a mistake than an intention.
    const env = buildEnv({ TERM: 'dumb' }, '/repo', { COLORTERM: 'nope' });

    expect(env.TERM).toBe(TERM);
    expect(env.COLORTERM).toBe(COLORTERM);
    expect(env.PWD).toBe('/repo');
  });

  it.each(['ELECTRON_RUN_AS_NODE', 'NODE_OPTIONS', 'NODE_PATH'])(
    'strips %s, which silently changes how child processes run',
    (key) => {
      expect(buildEnv({ [key]: 'x' }, '/repo')).not.toHaveProperty(key);
    },
  );

  it.each(['ELECTRON_FOO', 'GDK_PIXBUF_MODULE_FILE', 'CHROME_DESKTOP'])(
    'strips %s by prefix',
    (key) => {
      expect(buildEnv({ [key]: 'x' }, '/repo')).not.toHaveProperty(key);
    },
  );

  describe('Claude Code session leakage (HIVE-64)', () => {
    /**
     * The variables an app launched from inside a Claude Code session inherits.
     * Handing these to a spawned `claude` makes it **join the launching
     * session** rather than start its own — so every session opened with the
     * launcher's name, and renaming one renamed all of them.
     */
    const LEAKED = {
      CLAUDECODE: '1',
      CLAUDE_CODE_SESSION_ID: 'ac8c6688-a8cb-4ab9-ae17-ff4f51c2c3ce',
      CLAUDE_CODE_CHILD_SESSION: '1',
      CLAUDE_CODE_ENTRYPOINT: 'cli',
      CLAUDE_CODE_AGENT: 'claude',
      CLAUDE_PID: '42336',
      CLAUDE_EFFORT: 'high',
      CLAUDE_JOB_DIR: '/Users/dev/.claude/jobs/ac8c6688',
      CLAUDE_CODE_EXECPATH: '/Users/dev/.local/share/claude/versions/2.1.222',
    };

    it.each(Object.keys(LEAKED))('strips %s', (key) => {
      expect(buildEnv(LEAKED, '/repo')).not.toHaveProperty(key);
    });

    it('leaves nothing Claude-related behind at all', () => {
      const env = buildEnv({ ...LEAKED, PATH: '/usr/bin' }, '/repo');

      expect(Object.keys(env).filter((key) => key.toUpperCase().startsWith('CLAUDE'))).toEqual(
        [],
      );
      // And does not throw the baby out: the rest of the environment survives.
      expect(env.PATH).toBe('/usr/bin');
    });

    it('strips them even when injected explicitly', () => {
      /**
       * Per-project `env` in the workspace config goes through `injected`. A
       * project cannot opt back into joining the launcher's session, by
       * accident or otherwise.
       */
      const env = buildEnv({}, '/repo', { CLAUDE_CODE_SESSION_ID: 'someone-elses' });

      expect(env).not.toHaveProperty('CLAUDE_CODE_SESSION_ID');
    });

    it('does not strip merely Claude-adjacent names', () => {
      // The prefix is `CLAUDE_`; an unrelated variable that starts with the
      // letters must survive, or a user's own tooling breaks silently.
      const env = buildEnv({ CLAUDIA_HOME: '/opt/claudia' }, '/repo');

      expect(env.CLAUDIA_HOME).toBe('/opt/claudia');
    });
  });
});
