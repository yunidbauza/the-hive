// @vitest-environment node
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

/**
 * How boot decides which IPC mode is bound (HIVE-144).
 *
 * Read as source text rather than run, for the reason `window-import.test.ts`
 * exists in its narrow shape: `electron/main/index.ts` is the entry point, and
 * evaluating it means `requestSingleInstanceLock`, a tray, a window, an
 * updater and a CSP — a fixture several times the size of the two lines under
 * test. What is being asserted here is a *rule about the file*, and the rule is
 * one the plan flagged by name: **boot and the settings pane must produce the
 * same bound surface**, because a difference between them would first show up
 * after a switch, which is the worst possible moment to find it.
 *
 * Two halves, and the second is what makes the first worth having:
 *
 * 1. Boot binds **local** unconditionally, before anything is awaited. A window
 *    opens from `whenReady`, and a window whose channels are not bound is an
 *    app that looks alive and answers nothing.
 * 2. Boot reaches remote mode only through `switchIpcMode` — the same function
 *    `config:set-remote` calls. A `registerIpc('remote', …)` here would be a
 *    second description of what remote mode is bound to, with no unbind, no
 *    refusal check and no rebind-on-failure.
 */
const source = readFileSync(
  fileURLToPath(new URL('../../../electron/main/index.ts', import.meta.url)),
  'utf8',
);

describe('the boot path chooses an IPC mode', () => {
  it('binds local before it ever tries to attach', () => {
    const local = source.indexOf("registerIpc('local')");
    const attach = source.indexOf("switchIpcMode('remote'");

    expect(local, 'boot must call registerIpc(\'local\')').toBeGreaterThan(-1);
    expect(attach, "boot must attach through switchIpcMode('remote')").toBeGreaterThan(-1);
    expect(local).toBeLessThan(attach);
  });

  it('never registers the remote proxy directly', () => {
    expect(
      source,
      [
        "electron/main/index.ts calls registerIpc('remote', …) itself.",
        'That skips the unbind, the refusal checks and the rebind-on-failure that',
        'switchIpcMode owns — and makes boot a second, divergent registration path.',
      ].join(' '),
    ).not.toMatch(/registerIpc\(\s*'remote'/);
  });

  it('attaches behind the stored mode, not unconditionally', () => {
    expect(source).toMatch(/getConfig\(\)\.remote\.mode === 'remote'/);
  });

  /**
   * `switchIpcMode` answers a *refusal* as a value, but it can still reject —
   * nothing wraps its unbind, and its own rebind-local arm throws if `ipcMain`
   * refuses a channel (`remote-composition.test.ts` drives exactly that). At
   * boot, unhandled, that is an unhandled rejection over the one state this
   * story exists to prevent: a window with no IPC and nothing said about it.
   */
  it('handles a boot attach that throws, not only one that refuses', () => {
    const attach = source.slice(source.indexOf("switchIpcMode('remote'"));
    const nextStatement = attach.indexOf('\n  const ');

    expect(
      nextStatement === -1 ? attach : attach.slice(0, nextStatement),
      'the boot attach needs a .catch() — a rejection here is an app with no IPC',
      /*
        Anchored to the start of a line, so it matches a link in the promise
        chain and not the word inside the comment that explains it. Caught by
        the mutation for this case, whose first spelling put ".catch(" in its
        own marker and went green on it.
      */
    ).toMatch(/^\s*\.catch\(/m);
  });
});
