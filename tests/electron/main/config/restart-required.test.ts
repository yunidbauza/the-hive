// @vitest-environment node
import { describe, expect, it } from 'vitest';

import { restartRequired } from '../../../../electron/main/config/restart-required';
import { emptySnapshot, type ConfigSnapshot } from '../../../../electron/shared/config-contract';

const boot = emptySnapshot('/tmp/config.json', '/bin/zsh');
const edited = (over: Partial<ConfigSnapshot>): ConfigSnapshot => ({ ...boot, ...over });

describe('restartRequired', () => {
  it('asks for nothing when no launch-only field moved', () => {
    expect(restartRequired(boot, edited({ projects: [], env: { A: '1' } }))).toEqual([]);
  });

  it.each([
    ['receiver bind', { receiver: { ...boot.receiver, bind: { ...boot.receiver.bind, port: 4100 } } }],
    ['server mode', { server: { ...boot.server, enabled: !boot.server.enabled } }],
    ['server bind', { server: { ...boot.server, bind: { ...boot.server.bind, port: 7500 } } }],
    ['login environment', { importLoginEnv: !boot.importLoginEnv }],
    ['login environment', { shell: '/bin/bash' }],
    ['remote attach', { remote: { ...boot.remote, mode: boot.remote.mode === 'local' ? 'remote' : 'local' } }],
  ] as const)('names %s when it changed', (label, over) => {
    expect(restartRequired(boot, edited(over as Partial<ConfigSnapshot>))).toEqual([label]);
  });

  it('names each field once, in a fixed order', () => {
    const now = edited({
      shell: '/bin/bash',
      importLoginEnv: !boot.importLoginEnv,
      receiver: { ...boot.receiver, bind: { ...boot.receiver.bind, host: '0.0.0.0' } },
    });
    expect(restartRequired(boot, now)).toEqual(['receiver bind', 'login environment']);
  });

  it('ignores the receiver host alias, which is read per use', () => {
    expect(restartRequired(boot, edited({ receiver: { ...boot.receiver, hostAlias: 'x.internal' } }))).toEqual([]);
  });
});
