import { describe, expect, it } from 'vitest';

import { REMOTE_PROTOCOL_VERSION } from '@shared/remote-contract';

import { attachRequest } from '../../../electron/remote-client';

/**
 * The client half's only logic so far (HIVE-141).
 *
 * The assertion that earns its place is the last one: `resumeFrom` must be
 * *absent* on a first attach rather than `{}`, because a server reading the
 * contract branches on the difference. A spread of an optional would have
 * produced `undefined` under the key, which is not the same thing as no key at
 * all once the frame has been through `JSON.stringify`.
 */

describe('attachRequest', () => {
  it('speaks this build’s protocol version', () => {
    expect(attachRequest('d_9f2c', 'secret').protocol).toBe(REMOTE_PROTOCOL_VERSION);
  });

  it('carries the device id and its token', () => {
    const frame = attachRequest('d_9f2c', 'secret');

    expect(frame.kind).toBe('attach');
    expect(frame.deviceId).toBe('d_9f2c');
    expect(frame.token).toBe('secret');
  });

  it('omits resumeFrom entirely on a first attach', () => {
    const frame = attachRequest('d_9f2c', 'secret');

    expect('resumeFrom' in frame).toBe(false);
    expect(JSON.parse(JSON.stringify(frame))).not.toHaveProperty('resumeFrom');
  });

  it('carries the last-seen sequence per session on a resume', () => {
    const frame = attachRequest('d_9f2c', 'secret', { 's1': 42, 's2': 7 });

    expect(frame.resumeFrom).toEqual({ 's1': 42, 's2': 7 });
  });

  /**
   * An empty map is a real answer — "I have been here and hold nothing" — and
   * must survive as one rather than being collapsed into the absent case.
   */
  it('keeps an explicitly empty resumeFrom distinguishable from an absent one', () => {
    const frame = attachRequest('d_9f2c', 'secret', {});

    expect('resumeFrom' in frame).toBe(true);
    expect(frame.resumeFrom).toEqual({});
  });
});
