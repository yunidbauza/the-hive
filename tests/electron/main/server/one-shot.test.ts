import { describe, expect, it, vi } from 'vitest';

import type { ServerDevice } from '@shared/config-contract';

import { runOneShot } from '../../../../electron/main/server/one-shot';
import { mintDevice } from '../../../../electron/main/server/devices';

/** `persistWrites` defaults `true`; pass `false` for the C1 write-failure branch. */
const io = (devices: readonly ServerDevice[] = [], persistWrites = true) => {
  const written: ServerDevice[][] = [];
  const lines: string[] = [];
  return {
    written,
    lines,
    io: {
      readDevices: () => devices,
      writeDevices: (next: readonly ServerDevice[]) => {
        written.push([...next]);
        return persistWrites;
      },
      print: (line: string) => lines.push(line),
    },
  };
};

describe('runOneShot --pair', () => {
  it('prints a token and persists a device', () => {
    const { io: i, written, lines } = io();
    const code = runOneShot({ kind: 'pair', name: 'MacBook' }, i);
    expect(code).toBe(0);
    expect(written).toHaveLength(1);
    expect(written[0]).toHaveLength(1);
    expect(lines.join('\n')).toMatch(/[0-9A-HJ-NP-TV-Z]{4}(-[0-9A-HJ-NP-TV-Z]{4}){3}/);
  });

  it('never prints or persists the digest alongside the token', () => {
    const { io: i, written, lines } = io();
    runOneShot({ kind: 'pair', name: 'MacBook' }, i);
    const digest = written[0]?.[0]?.credential.digest ?? '';
    expect(lines.join('\n')).not.toContain(digest);
  });

  /**
   * HIVE-142 review, I5: `AttachRequest` needs the device id alongside the
   * token, and until now the id was readable only inside `config.json`.
   */
  it('prints the device id alongside the token', () => {
    const { io: i, written, lines } = io();
    runOneShot({ kind: 'pair', name: 'MacBook' }, i);
    const id = written[0]?.[0]?.id ?? '';
    expect(id).not.toBe('');
    expect(lines).toContain(`Device id: ${id}`);
  });

  /**
   * HIVE-142 review, C1: a device minted in memory but never persisted must
   * not exit 0 having printed a token for a credential that exists nowhere.
   */
  it('exits non-zero and prints no token when the write does not land', () => {
    const { io: i, written, lines } = io([], false);
    const code = runOneShot({ kind: 'pair', name: 'MacBook' }, i);
    expect(code).toBe(1);
    expect(written).toHaveLength(1); // the write was attempted...
    expect(lines.join('\n')).not.toMatch(/[0-9A-HJ-NP-TV-Z]{4}(-[0-9A-HJ-NP-TV-Z]{4}){3}/); // ...but no token was ever shown
    expect(lines.join('\n')).toMatch(/MacBook/);
  });

  it('keeps devices that already exist', () => {
    const existing = mintDevice('iPad').device;
    const { io: i, written } = io([existing]);
    runOneShot({ kind: 'pair', name: 'MacBook' }, i);
    expect(written[0]).toHaveLength(2);
    expect(written[0]?.map((d) => d.name).sort()).toEqual(['MacBook', 'iPad']);
  });

  it('refuses a duplicate name rather than minting a second credential for it', () => {
    const existing = mintDevice('MacBook').device;
    const { io: i, written, lines } = io([existing]);
    const code = runOneShot({ kind: 'pair', name: 'MacBook' }, i);
    expect(code).toBe(1);
    expect(written).toHaveLength(0);
    expect(lines.join('\n')).toMatch(/already/i);
  });

  it('re-mints rather than pairing a device whose id collides with an existing one', () => {
    const existing = mintDevice('iPad').device;
    const { io: i, written } = io([existing]);
    // Force the first mint to collide, then succeed.
    const ids = [existing.id, 'd_ffff'];
    let call = 0;
    const mint = vi.fn(() => {
      const device = { ...mintDevice('MacBook').device, id: ids[call++] ?? 'd_0000' };
      return { device, token: 'K7QM-4XR2-9WFD-A3LP' };
    });

    const code = runOneShot({ kind: 'pair', name: 'MacBook' }, i, undefined, mint);
    expect(code).toBe(0);
    expect(mint).toHaveBeenCalledTimes(2);
    expect(written[0]?.map((d) => d.id).sort()).toEqual([existing.id, 'd_ffff'].sort());
  });

  it('gives up rather than looping forever if minting keeps colliding', () => {
    const existing = mintDevice('iPad').device;
    const { io: i, written, lines } = io([existing]);
    const mint = vi.fn(() => ({ device: { ...existing, name: 'MacBook' }, token: 'X' }));

    expect(runOneShot({ kind: 'pair', name: 'MacBook' }, i, undefined, mint)).toBe(1);
    expect(written).toHaveLength(0);
    expect(lines.join('\n')).toMatch(/could not/i);
  });
});

describe('runOneShot --revoke', () => {
  it('revokes a known device and reports it', () => {
    const existing = mintDevice('MacBook').device;
    const { io: i, written } = io([existing]);
    expect(runOneShot({ kind: 'revoke', name: 'MacBook' }, i)).toBe(0);
    expect(written[0]?.[0]?.revoked).toBe(true);
  });

  it('exits non-zero for a name it does not hold, and writes nothing', () => {
    const { io: i, written } = io([]);
    expect(runOneShot({ kind: 'revoke', name: 'ghost' }, i)).toBe(1);
    expect(written).toHaveLength(0);
  });

  /**
   * HIVE-142 review, C1 — the sharpest version of this finding: `--revoke`
   * must fail closed, not print success for a device whose digest is still
   * live on disk because the write never landed.
   */
  it('exits non-zero and does not claim success when the write does not land', () => {
    const existing = mintDevice('MacBook').device;
    const { io: i, lines } = io([existing], false);
    const code = runOneShot({ kind: 'revoke', name: 'MacBook' }, i);
    expect(code).toBe(1);
    expect(lines.join('\n')).not.toMatch(/no longer reach/i);
    expect(lines.join('\n')).toMatch(/MacBook/);
  });
});

describe('runOneShot --devices', () => {
  it('lists names, ids and states without printing any credential', () => {
    const a = mintDevice('MacBook').device;
    const b = { ...mintDevice('iPad').device, revoked: true };
    const { io: i, lines } = io([a, b]);
    expect(runOneShot({ kind: 'devices' }, i)).toBe(0);
    const out = lines.join('\n');
    expect(out).toContain('MacBook');
    expect(out).toContain('iPad');
    // The id (HIVE-142 review, I5): an operator holding only a token has to
    // find the id the attach handshake also needs without opening
    // config.json by hand.
    expect(out).toContain(a.id);
    expect(out).toContain(b.id);
    expect(out).toMatch(/revoked/i);
    expect(out).not.toContain(a.credential.digest);
  });

  it('says so plainly when nothing is paired', () => {
    const { io: i, lines } = io([]);
    expect(runOneShot({ kind: 'devices' }, i)).toBe(0);
    expect(lines.join('\n')).toMatch(/no devices/i);
  });
});
