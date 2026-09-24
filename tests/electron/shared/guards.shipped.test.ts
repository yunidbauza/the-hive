import { describe, expect, it } from 'vitest';

import { parseShippedRequest } from '../../../electron/shared/guards';

/**
 * `shipped:*` requests name a kind and an agent or skill, never a path: main
 * joins the name onto `~/.hive/<kind>/`.
 */
describe('parseShippedRequest', () => {
  it('passes a shipped agent and a shipped skill through', () => {
    expect(parseShippedRequest({ kind: 'agents', name: 'builder' })).toEqual({ kind: 'agents', name: 'builder' });
    expect(parseShippedRequest({ kind: 'skills', name: 'work-on' })).toEqual({ kind: 'skills', name: 'work-on' });
  });

  it('refuses a kind that is not one of the two', () => {
    expect(() => parseShippedRequest({ kind: 'config', name: 'x' })).toThrow(/shipped\.kind/);
  });

  it('refuses a name that is a path, or reserved for its kind', () => {
    expect(() => parseShippedRequest({ kind: 'agents', name: '../x' })).toThrow(/shipped\.name/);
    expect(() => parseShippedRequest({ kind: 'skills', name: 'done' })).toThrow(/reserved/);
    expect(() => parseShippedRequest({ kind: 'agents', name: 'overmind' })).toThrow(/reserved/);
  });

  it('refuses extra fields', () => {
    expect(() => parseShippedRequest({ kind: 'agents', name: 'builder', path: '/etc' })).toThrow();
  });
});
