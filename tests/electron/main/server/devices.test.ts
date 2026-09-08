import { describe, expect, it, vi } from 'vitest';

import type { MintedDevice } from '../../../../electron/main/server/devices';
import {
  MAX_MINT_ATTEMPTS,
  digestOf,
  mintDevice,
  mintUniqueDevice,
  revokeNamed,
  verifyDevice,
} from '../../../../electron/main/server/devices';

describe('mintDevice', () => {
  it('returns a token in four readable groups of four', () => {
    const { token } = mintDevice('MacBook');
    expect(token).toMatch(/^[0-9A-HJ-NP-TV-Z]{4}(-[0-9A-HJ-NP-TV-Z]{4}){3}$/);
  });

  it('omits the characters that misread on a screen', () => {
    for (let i = 0; i < 200; i += 1) {
      expect(mintDevice('x').token).not.toMatch(/[ILOU]/);
    }
  });

  it('never returns the same token twice', () => {
    const seen = new Set(Array.from({ length: 500 }, () => mintDevice('x').token));
    expect(seen.size).toBe(500);
  });

  it('stores a digest and not the token', () => {
    const { device, token } = mintDevice('MacBook', new Date('2026-09-07T12:00:00Z'));
    expect(device.credential).toEqual({ kind: 'sha256', digest: digestOf(token) });
    expect(JSON.stringify(device)).not.toContain(token);
    expect(device.name).toBe('MacBook');
    expect(device.paired).toBe('2026-09-07');
    expect(device.revoked).toBe(false);
  });
});

describe('mintUniqueDevice', () => {
  it('mints on the first try when nothing collides', () => {
    const existing = mintDevice('iPad').device;
    const minted = mintUniqueDevice('MacBook', [existing]);
    expect(minted).not.toBeNull();
    expect(minted?.device.name).toBe('MacBook');
  });

  it('re-mints when the id collides with an existing device, and stops once it does not', () => {
    const existing = mintDevice('iPad').device;
    const ids = [existing.id, 'd_ffff'];
    let call = 0;
    const mint = vi.fn(
      (name: string): MintedDevice => ({
        device: { ...mintDevice(name).device, id: ids[call++] ?? 'd_0000' },
        token: 'K7QM-4XR2-9WFD-A3LP',
      }),
    );

    const minted = mintUniqueDevice('MacBook', [existing], undefined, mint);

    expect(mint).toHaveBeenCalledTimes(2);
    expect(minted?.device.id).toBe('d_ffff');
  });

  it(`gives up after ${String(MAX_MINT_ATTEMPTS)} straight collisions`, () => {
    const existing = mintDevice('iPad').device;
    const mint = vi.fn(() => ({ device: { ...existing, name: 'MacBook' }, token: 'X' }));

    const minted = mintUniqueDevice('MacBook', [existing], undefined, mint);

    expect(minted).toBeNull();
    expect(mint).toHaveBeenCalledTimes(MAX_MINT_ATTEMPTS);
  });
});

describe('verifyDevice', () => {
  it('accepts the token it minted', () => {
    const { device, token } = mintDevice('MacBook');
    expect(verifyDevice([device], device.id, token)).toBe('ok');
  });

  it('refuses a wrong token', () => {
    const { device } = mintDevice('MacBook');
    expect(verifyDevice([device], device.id, 'AAAA-BBBB-CCCC-DDDD')).toBe('unknown');
  });

  it('refuses an unknown id', () => {
    const { device, token } = mintDevice('MacBook');
    expect(verifyDevice([device], 'd_nope', token)).toBe('unknown');
  });

  it('reports a revoked device distinctly', () => {
    const { device, token } = mintDevice('MacBook');
    const revoked = { ...device, revoked: true };
    expect(verifyDevice([revoked], device.id, token)).toBe('revoked');
  });

  it('refuses a revoked device even with a wrong token', () => {
    const { device } = mintDevice('MacBook');
    const revoked = { ...device, revoked: true };
    expect(verifyDevice([revoked], device.id, 'AAAA-BBBB-CCCC-DDDD')).toBe('unknown');
  });
});

describe('revokeNamed', () => {
  it('flips the flag and reports it did', () => {
    const { device } = mintDevice('MacBook');
    const result = revokeNamed([device], 'MacBook');
    expect(result.revoked).toBe(true);
    expect(result.devices[0]?.revoked).toBe(true);
  });

  it('reports false for a name it does not hold, and changes nothing', () => {
    const { device } = mintDevice('MacBook');
    const result = revokeNamed([device], 'iPad');
    expect(result.revoked).toBe(false);
    expect(result.devices).toEqual([device]);
  });
});
