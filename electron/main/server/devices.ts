import { createHash, randomBytes } from 'node:crypto';

import type { ServerDevice } from '@shared/config-contract';

import { secretEquals } from '../hooks/http-guard';

/**
 * Minting, verifying and revoking paired devices (HIVE-142).
 *
 * Pure logic over an in-memory `ServerDevice[]` — no file I/O, no stdout, no
 * Electron import. A later story wires `mintDevice`'s output to the config
 * file and to stdout, and `verifyDevice` to the server's request path.
 *
 * The design decision that shapes this module: the server stores a digest,
 * never the token. A server verifying a credential does not need to hold one.
 * That is what lets pairing happen from a terminal on an unattended machine —
 * `safeStorage` (the macOS Keychain) is measurably unavailable before
 * `app.whenReady()`, even in a GUI session. The token's plaintext exists in
 * exactly two places: stdout at mint time, and the client's own `safeStorage`
 * in a later story. This module never writes either.
 */

/**
 * Crockford base32 — `0`-`9` then `A`-`Z` minus `I`, `L`, `O` and `U`.
 *
 * The token is read off one screen and typed on another device, so `I`, `L`
 * and `O` are excluded because they are misread as `1`, `1` and `0`. `U` is
 * excluded for consistency with Crockford's own alphabet (there to avoid
 * accidental obscenity) rather than for a misreading reason of its own —
 * inventing a different 32-character set here would just be a second
 * alphabet nobody asked for.
 */
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/**
 * Encodes `bytes` five bits at a time over {@link ALPHABET}.
 *
 * Only ever called with 10 bytes (80 bits) from {@link mintDevice}, which
 * divides evenly into 16 five-bit groups with nothing left over — so there is
 * no padding case to get wrong.
 */
function toBase32(bytes: Buffer): string {
  let bits = '';
  for (const byte of bytes) bits += byte.toString(2).padStart(8, '0');
  let out = '';
  for (let i = 0; i < bits.length; i += 5) {
    out += ALPHABET[parseInt(bits.slice(i, i + 5), 2)];
  }
  return out;
}

export interface MintedDevice {
  device: ServerDevice;
  token: string;
}

/**
 * Mints a new device: a token to hand to the person pairing, and the
 * `ServerDevice` record — carrying only the digest — to store.
 *
 * ## Why 10 bytes, why 16 characters, why no KDF
 *
 * `crypto.randomBytes(10)` is 80 bits, rendered whole as 16 base32 characters
 * (16 × 5 = 80, so nothing is thrown away and nothing needs padding). That is
 * the real entropy of the credential — the digest is taken over the *rendered
 * token string*, so however many bytes were drawn, what actually resists
 * guessing is the 80 bits the 16 characters encode.
 *
 * 80 bits is plenty: an offline attack against a leaked SHA-256 digest costs
 * roughly 2^80 hashes, which at 10^12 hashes/second is on the order of 38,000
 * years, and there is no online guessing surface worth naming — this socket
 * is reached over Tailscale and refuses on the first wrong token. Because the
 * input is 80 uniform random bits rather than a low-entropy human password,
 * a KDF (bcrypt/argon2) would be cargo cult, and a salt buys nothing when the
 * thing being hashed is already unguessable. That is why {@link digestOf} is
 * a bare SHA-256 and not a salted, iterated hash — do not "fix" that later.
 *
 * The rendering stays four groups of four (not five groups, which would need
 * 100 bits) because a human reads this off one screen and types it on
 * another device, and this is the shape the pairing UI's regex expects.
 */
export function mintDevice(name: string, now: Date = new Date()): MintedDevice {
  const raw = toBase32(randomBytes(10));
  const token = [raw.slice(0, 4), raw.slice(4, 8), raw.slice(8, 12), raw.slice(12, 16)].join('-');

  const device: ServerDevice = {
    id: `d_${randomBytes(2).toString('hex')}`,
    name,
    paired: now.toISOString().slice(0, 10),
    revoked: false,
    credential: { kind: 'sha256', digest: digestOf(token) },
  };

  return { device, token };
}

/** SHA-256 of the rendered token string, hex-encoded. */
export function digestOf(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export type VerifyResult = 'ok' | 'unknown' | 'revoked';

/**
 * Checks `token` against the device named `id` in `devices`.
 *
 * The digest compare happens **before** the `revoked` check, and that
 * ordering is deliberate: if a wrong token against a revoked device answered
 * `'revoked'`, a caller who does not hold the credential could learn which
 * device ids exist and which of them were revoked, purely from the
 * difference between `'unknown'` and `'revoked'` — no token required. Putting
 * the digest check first means both a nonexistent id and a right-id-wrong-
 * token guess are indistinguishable from `'unknown'`, and `'revoked'` is only
 * ever reached by someone who actually holds (or held) the credential.
 */
export function verifyDevice(
  devices: readonly ServerDevice[],
  id: string,
  token: string,
): VerifyResult {
  const device = devices.find((candidate) => candidate.id === id);
  if (!device) return 'unknown';

  const offered = digestOf(token);
  if (!secretEquals(offered, device.credential.digest)) return 'unknown';

  return device.revoked ? 'revoked' : 'ok';
}

/**
 * Revokes the device named `name`, if one exists.
 *
 * Returns a new array on a match and the input array unchanged otherwise —
 * never mutates `devices` or any element in it, so a caller holding the old
 * array still sees the pre-revocation state.
 */
export function revokeNamed(
  devices: readonly ServerDevice[],
  name: string,
): { devices: readonly ServerDevice[]; revoked: boolean } {
  let found = false;
  const next = devices.map((device) => {
    if (device.name !== name) return device;
    found = true;
    return { ...device, revoked: true };
  });

  return found ? { devices: next, revoked: true } : { devices, revoked: false };
}
