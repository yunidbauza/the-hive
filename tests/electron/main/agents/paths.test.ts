// @vitest-environment node
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { agentWorkdir, laneWorkdir } from '../../../../electron/main/agents/paths';

describe('laneWorkdir (HIVE-188)', () => {
  it('keeps the standing lane in the agent\'s own directory', () => {
    expect(laneWorkdir('shipper', 'standing')).toBe(agentWorkdir('shipper'));
  });

  it('puts every other lane under lanes/, one directory per key', () => {
    expect(laneWorkdir('shipper', 'repo:a/b')).toBe(join(agentWorkdir('shipper'), 'lanes', 'repo%3Aa%2Fb'));
    expect(laneWorkdir('builder', 'thread:20260913-004948-0001')).toBe(
      join(agentWorkdir('builder'), 'lanes', 'thread%3A20260913-004948-0001'),
    );
  });

  it('never folds two keys into one directory', () => {
    expect(laneWorkdir('s', 'repo:a__b/c')).not.toBe(laneWorkdir('s', 'repo:a/b__c'));
  });
});
