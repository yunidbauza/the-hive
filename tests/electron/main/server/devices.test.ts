import { describe, expect, it, vi } from 'vitest';

import type { ServerDevice } from '@shared/config-contract';

import type { DeviceStore, MintedDevice } from '../../../../electron/main/server/devices';
import {
  MAX_MINT_ATTEMPTS,
  digestOf,
  mintDevice,
  mintUniqueDevice,
  pairDevice,
  pairOutcomeMessage,
  revokeDevice,
  revokeNamed,
  revokeOutcomeMessage,
  verifyDevice,
} from '../../../../electron/main/server/devices';

/**
 * A `DeviceStore` over a plain in-memory array, recording every write.
 *
 * `persistWrites` defaults `true` (a filesystem that works) — a test that
 * wants the write-failure branch (HIVE-142 review, C1) passes `false`
 * without needing a real read-only file or directory, exactly the seam the
 * finding asked for.
 */
function fakeStore(
  initial: readonly ServerDevice[],
  persistWrites = true,
): DeviceStore & { writes: (readonly ServerDevice[])[] } {
  const writes: (readonly ServerDevice[])[] = [];
  return {
    writes,
    readDevices: vi.fn(() => initial),
    writeDevices: vi.fn((devices: readonly ServerDevice[]) => {
      writes.push(devices);
      return persistWrites;
    }),
  };
}

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

describe('pairDevice', () => {
  it('reads the store once, mints and persists when the name is free', () => {
    const existing = mintDevice('iPad').device;
    const store = fakeStore([existing]);

    const outcome = pairDevice('MacBook', store);

    expect(outcome.ok).toBe(true);
    expect(store.readDevices).toHaveBeenCalledTimes(1);
    if (outcome.ok) {
      expect(outcome.device.name).toBe('MacBook');
      expect(outcome.token).toMatch(/^[0-9A-HJ-NP-TV-Z]{4}(-[0-9A-HJ-NP-TV-Z]{4}){3}$/);
    }
  });

  it('refuses a duplicate name without minting or writing anything', () => {
    const existing = mintDevice('MacBook').device;
    const store = fakeStore([existing]);
    const mint = vi.fn(mintDevice);

    const outcome = pairDevice('MacBook', store, undefined, mint);

    expect(outcome).toEqual({ ok: false, reason: 'duplicate-name' });
    expect(mint).not.toHaveBeenCalled();
    expect(store.writeDevices).not.toHaveBeenCalled();
  });

  it('re-mints on an id collision, then persists the device it settled on', () => {
    const existing = mintDevice('iPad').device;
    const store = fakeStore([existing]);
    const ids = [existing.id, 'd_ffff'];
    let call = 0;
    const mint = vi.fn(
      (name: string): MintedDevice => ({
        device: { ...mintDevice(name).device, id: ids[call++] ?? 'd_0000' },
        token: 'K7QM-4XR2-9WFD-A3LP',
      }),
    );

    const outcome = pairDevice('MacBook', store, undefined, mint);

    expect(mint).toHaveBeenCalledTimes(2);
    expect(outcome.ok && outcome.device.id).toBe('d_ffff');
    expect(store.writes[0]?.map((d) => d.id)).toEqual([existing.id, 'd_ffff']);
  });

  it(`gives up after ${String(MAX_MINT_ATTEMPTS)} collisions and writes nothing`, () => {
    const existing = mintDevice('iPad').device;
    const store = fakeStore([existing]);
    const mint = vi.fn(() => ({ device: { ...existing, name: 'MacBook' }, token: 'X' }));

    const outcome = pairDevice('MacBook', store, undefined, mint);

    expect(outcome).toEqual({ ok: false, reason: 'mint-failed' });
    expect(mint).toHaveBeenCalledTimes(MAX_MINT_ATTEMPTS);
    expect(store.writeDevices).not.toHaveBeenCalled();
  });

  it('a name held only by revoked devices is free to re-pair, and the old digest is gone (HIVE-142 review, I1)', () => {
    // The scenario verbatim: pair, revoke, pair the same name again.
    const first = mintDevice('MacBook');
    const store = fakeStore([first.device]);

    const revokeOutcome = revokeDevice('MacBook', store);
    expect(revokeOutcome.revoked).toBe(true);

    const afterRevoke = store.writes[0] ?? [];
    // The second `pairDevice` call reads whatever the revoke just wrote, the
    // same "read once, act on it" shape every other call in this store goes
    // through — a second `fakeStore` seeded with that result stands in for
    // the real `DeviceStore`'s next `readDevices()`.
    const store2 = fakeStore(afterRevoke);
    const outcome = pairDevice('MacBook', store2);

    expect(outcome.ok).toBe(true);
    const written = store2.writes[0] ?? [];
    // Exactly one "MacBook" survives, and it is not the revoked one.
    const macBooks = written.filter((d) => d.name === 'MacBook');
    expect(macBooks).toHaveLength(1);
    expect(macBooks[0]?.revoked).toBe(false);
    expect(macBooks[0]?.credential.digest).not.toBe(first.device.credential.digest);
    if (outcome.ok) {
      expect(verifyDevice(written, outcome.device.id, outcome.token)).toBe('ok');
    }
    // The dead credential no longer verifies against anything in the roster.
    expect(written.some((d) => d.credential.digest === first.device.credential.digest)).toBe(
      false,
    );
  });

  it('still refuses a name held by an active device, even alongside revoked rows of the same name', () => {
    const revokedHolder = { ...mintDevice('MacBook').device, revoked: true };
    const activeHolder = mintDevice('MacBook').device;
    const store = fakeStore([revokedHolder, activeHolder]);
    const mint = vi.fn(mintDevice);

    const outcome = pairDevice('MacBook', store, undefined, mint);

    expect(outcome).toEqual({ ok: false, reason: 'duplicate-name' });
    expect(mint).not.toHaveBeenCalled();
    expect(store.writeDevices).not.toHaveBeenCalled();
  });

  it('persists against the roster it just read — a device present at read time is never dropped (HIVE-142 review, I3b)', () => {
    // The exact shape of the earlier bug: a roster that already includes a
    // device paired by a concurrent `--pair` (or, before this roster's own
    // fix, by a second tray action) must still be there after this call's
    // own write — proof, at the unit level, of "persist against the roster
    // you just read" rather than a stale one.
    const fromBoot = mintDevice('iPad').device;
    const pairedConcurrently = mintDevice('Old Phone').device;
    const store = fakeStore([fromBoot, pairedConcurrently]);

    const outcome = pairDevice('MacBook', store);

    expect(outcome.ok).toBe(true);
    const written = store.writes[0] ?? [];
    expect(written.map((d) => d.name).sort()).toEqual(['MacBook', 'Old Phone', 'iPad'].sort());
  });

  /**
   * HIVE-142 review, C1: `pairDevice` used to return `{ ok: true, token }`
   * whether or not `store.writeDevices` actually persisted anything —
   * `setServer` never throws on a write failure, it reports one, and this
   * used to discard that report. A token handed out for a digest that
   * exists nowhere is a credential that can never authenticate.
   */
  it('reports write-failed, not ok, when the store could not persist the mint', () => {
    const store = fakeStore([], false);

    const outcome = pairDevice('MacBook', store);

    expect(outcome).toEqual({ ok: false, reason: 'write-failed' });
    expect(store.writeDevices).toHaveBeenCalledTimes(1);
  });
});

describe('pairOutcomeMessage', () => {
  it('names the device for a duplicate-name refusal', () => {
    expect(pairOutcomeMessage({ ok: false, reason: 'duplicate-name' }, 'MacBook')).toBe(
      'A device named "MacBook" already exists. Revoke it first, or choose another name.',
    );
  });

  it('names the attempt cap for a mint-failed refusal', () => {
    expect(pairOutcomeMessage({ ok: false, reason: 'mint-failed' }, 'MacBook')).toBe(
      `Could not mint a unique device credential after ${String(MAX_MINT_ATTEMPTS)} attempts. Try again.`,
    );
  });

  it('names the device and the write failure for a write-failed refusal', () => {
    expect(pairOutcomeMessage({ ok: false, reason: 'write-failed' }, 'MacBook')).toMatch(
      /MacBook/,
    );
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

describe('revokeDevice', () => {
  it('reads the store once, revokes and persists a matching device', () => {
    const macBook = mintDevice('MacBook').device;
    const store = fakeStore([macBook]);

    const outcome = revokeDevice('MacBook', store);

    expect(outcome.revoked).toBe(true);
    expect(store.readDevices).toHaveBeenCalledTimes(1);
    expect(store.writes[0]?.[0]?.revoked).toBe(true);
  });

  it('writes nothing for a name it does not hold', () => {
    const macBook = mintDevice('MacBook').device;
    const store = fakeStore([macBook]);

    const outcome = revokeDevice('ghost', store);

    expect(outcome).toEqual({ revoked: false, reason: 'not-found' });
    expect(store.writeDevices).not.toHaveBeenCalled();
  });

  it('persists against the roster it just read — every other device survives untouched', () => {
    const macBook = mintDevice('MacBook').device;
    const iPad = mintDevice('iPad').device;
    const store = fakeStore([macBook, iPad]);

    revokeDevice('MacBook', store);

    const written = store.writes[0] ?? [];
    expect(written.map((d) => d.name).sort()).toEqual(['MacBook', 'iPad']);
    expect(written.find((d) => d.name === 'iPad')?.revoked).toBe(false);
    expect(written.find((d) => d.name === 'MacBook')?.revoked).toBe(true);
  });

  /**
   * HIVE-142 review, C1 — the sharpest version of the finding: revoking a
   * stolen device must fail closed. `revokeDevice` used to return
   * `{ revoked: true }` whether or not the write actually landed, which
   * means a device whose digest is still live on disk was reported gone.
   */
  it('fails closed: reports write-failed, not revoked, when the store could not persist it', () => {
    const macBook = mintDevice('MacBook').device;
    const store = fakeStore([macBook], false);

    const outcome = revokeDevice('MacBook', store);

    expect(outcome).toEqual({ revoked: false, reason: 'write-failed' });
    expect(store.writeDevices).toHaveBeenCalledTimes(1);
  });
});

describe('revokeOutcomeMessage', () => {
  it('names the device for a not-found refusal', () => {
    expect(revokeOutcomeMessage({ revoked: false, reason: 'not-found' }, 'MacBook')).toBe(
      'No device named "MacBook" is paired.',
    );
  });

  it('names the device and the write failure for a write-failed refusal', () => {
    expect(
      revokeOutcomeMessage({ revoked: false, reason: 'write-failed' }, 'MacBook'),
    ).toMatch(/MacBook/);
  });
});
