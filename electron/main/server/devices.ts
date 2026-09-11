import { createHash, randomBytes } from 'node:crypto';

import type { ServerDevice } from '@shared/config-contract';

import { secretEquals } from '../hooks/http-guard';

/**
 * Minting, verifying and revoking paired devices (HIVE-142).
 *
 * Pure logic over an in-memory `ServerDevice[]` — no file I/O, no stdout, no
 * Electron import. `server/one-shot.ts` wires `mintDevice`'s output to the config
 * file and to stdout (HIVE-142), and `remote-host/listener.ts` wires
 * `verifyDevice` to the server's request path.
 *
 * The design decision that shapes this module: the server stores a digest,
 * never the token. A server verifying a credential does not need to hold one.
 * That is what lets pairing happen from a terminal on an unattended machine —
 * `safeStorage` (the macOS Keychain) is measurably unavailable before
 * `app.whenReady()`, even in a GUI session. The token's plaintext exists in
 * exactly two places: stdout at mint time, and the client's own `safeStorage`
 * (`remote-client/token-store.ts`, HIVE-144). This module never writes either.
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
 * is reached over Tailscale and refuses every wrong token immediately, with
 * no lockout state to bypass. Because the
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

/**
 * How many times {@link mintUniqueDevice} re-mints on an id collision before
 * giving up.
 *
 * `mintDevice`'s id is 16 bits of randomness (`d_` + 4 hex characters), so at
 * realistic device counts the first draw essentially always misses every
 * existing id — a handful of retries is generous headroom, not a real
 * mitigation for a crowded namespace. Looping without a cap would turn a
 * one-in-a-billion fluke into a hang instead of a clean refusal.
 */
export const MAX_MINT_ATTEMPTS = 8;

/**
 * Mints a device named `name`, retrying up to {@link MAX_MINT_ATTEMPTS} times
 * if the freshly-minted id collides with one already in `devices` — the id
 * space {@link mintDevice} draws from, not the credential.
 *
 * `mintDevice` itself takes no device list and so cannot check uniqueness; a
 * collision is not an auth bypass (`verifyDevice`'s digest compare still
 * gates access) but it silently strands the *second* device paired under a
 * colliding id forever, because `verifyDevice` finds by id and returns only
 * the first match. Every caller that mints and persists a device — the CLI's
 * `--pair` and the tray's "Pair a device…" alike — goes through this rather
 * than re-deriving the retry loop, so there is one implementation of the
 * collision check rather than two that can drift (HIVE-142 review).
 *
 * `mint` is an injected seam over {@link mintDevice} purely so a test can
 * force a collision without stubbing the CSPRNG; every real caller takes the
 * default. Returns `null` after {@link MAX_MINT_ATTEMPTS} straight collisions
 * — the caller decides what "could not pair" looks like to whoever asked.
 */
export function mintUniqueDevice(
  name: string,
  devices: readonly ServerDevice[],
  now?: Date,
  mint: (name: string, now?: Date) => MintedDevice = mintDevice,
): MintedDevice | null {
  for (let attempt = 0; attempt < MAX_MINT_ATTEMPTS; attempt += 1) {
    const candidate = mint(name, now);
    if (!devices.some((device) => device.id === candidate.device.id)) {
      return candidate;
    }
  }
  return null;
}

/**
 * The read/write seam every caller that mints or revokes a *persisted*
 * device goes through (HIVE-142 review, N2) — `--pair`/`--revoke` (backed by
 * `OneShotIo` in `one-shot.ts`) and the tray's "Pair a device…"/"Revoke"
 * (backed by `index.ts`'s own device store) alike.
 *
 * `readDevices` is called exactly once per {@link pairDevice} or
 * {@link revokeDevice} call — freshness (or the lack of it) is entirely the
 * caller's business, and both real implementations read from disk on every
 * call rather than a cache, which is what makes "persist against the roster
 * you just read" true rather than aspirational.
 */
export interface DeviceStore {
  readDevices: () => readonly ServerDevice[];
  /**
   * Persists `devices` as the whole roster, and reports whether it actually
   * landed (HIVE-142 review, C1).
   *
   * `true` means the config file was written; `false` means it was not —
   * a read-only file, a read-only parent directory, a full disk, or any
   * other `writeConfig` failure (`config/write.ts` never throws at a
   * caller; it reports). Before this was `=> void`, both real
   * implementations (`file-backed-io.ts`) discarded that answer, so a mint
   * or a revoke that could not actually be written to disk still reported
   * success to whoever asked — worst on `revokeDevice`, where it meant a
   * stolen device's digest stayed live while its owner was told it was
   * gone. `pairDevice`/`revokeDevice` below both fail closed on `false`
   * rather than report the mutation they merely computed in memory.
   */
  writeDevices: (devices: readonly ServerDevice[]) => boolean;
}

export type PairOutcome =
  | { ok: true; device: ServerDevice; token: string }
  /** An *active* device already holds this name — refused before anything is minted. */
  | { ok: false; reason: 'duplicate-name' }
  /** {@link mintUniqueDevice} gave up after {@link MAX_MINT_ATTEMPTS} collisions. */
  | { ok: false; reason: 'mint-failed' }
  /**
   * `store.writeDevices` reported `false` (HIVE-142 review, C1): a device was
   * minted in memory but never reached disk. Nothing was stored — the
   * caller must not treat this as "pairing worked, saving failed
   * separately", because there is no separate save; a token handed out here
   * would authenticate against a digest that exists nowhere.
   */
  | { ok: false; reason: 'write-failed' };

/**
 * The one place a `PairOutcome` becomes a message a person reads (HIVE-142
 * review, I1/minor) — `--pair`, the tray's "Pair a device…", and the
 * Settings pane's `server:pair` handler all had their own copy of this
 * ternary, verbatim in two of the three, differently worded in the third.
 * One mapping means the wording can only drift by being changed here.
 */
export function pairOutcomeMessage(
  outcome: Extract<PairOutcome, { ok: false }>,
  name: string,
): string {
  switch (outcome.reason) {
    case 'duplicate-name':
      return `A device named "${name}" already exists. Revoke it first, or choose another name.`;
    case 'mint-failed':
      return `Could not mint a unique device credential after ${String(MAX_MINT_ATTEMPTS)} attempts. Try again.`;
    case 'write-failed':
      return `Could not save "${name}" to the config file. Nothing was stored — no credential for it exists anywhere. Check that the config file and its directory are writable, and try again.`;
  }
}

/**
 * Mints and persists a device named `name`, or refuses — the one
 * implementation `--pair` and the tray's "Pair a device…" both call
 * (HIVE-142 review, N2), so the duplicate-name refusal, the collision retry
 * and "write the roster you just read, not a stale one" are each proven
 * once rather than twice.
 *
 * `store.readDevices()` is called exactly once, and the write — when there
 * is one — is built from that same array plus the one device this call
 * added, never from a second, later read. That is the whole of what makes a
 * concurrent pairing from elsewhere survive: two callers racing this
 * function each still write *their own* read plus their own addition, so
 * the loser of the race overwrites the winner's addition only if the two
 * writes land in exactly the wrong order — the same bounded, documented gap
 * `--pair`'s one-shot always had (spec §8's "Concurrency" note), not a new
 * one this function introduces.
 *
 * ## A name held only by revoked devices is free (HIVE-142 review, I1)
 *
 * `revokeNamed` flips the flag on *every* device matching `name`, which only
 * makes sense if names are unique among devices someone could still use —
 * an invariant this function has to maintain, not just assume. Refusing a
 * name forever because some now-dead device once held it would make revoking
 * a stolen laptop and buying a replacement of the same model an unfixable
 * dead end (the review's exact scenario), and it would grow `config.json`
 * without bound — `config.json` is not an audit log. So a name is refused
 * only when an *active* device holds it; every revoked row with that name is
 * dropped in the same write that adds the new one. Nothing is lost: a
 * revoked device's digest can never verify again (`verifyDevice` checks
 * `revoked` after a successful digest compare, so a revoked credential is
 * already permanently dead), so there is no audit value being discarded,
 * only a disabled row that would otherwise sit there forever.
 */
export function pairDevice(
  name: string,
  store: DeviceStore,
  now?: Date,
  mint: (name: string, now?: Date) => MintedDevice = mintDevice,
): PairOutcome {
  const devices = store.readDevices();

  const holders = devices.filter((device) => device.name === name);
  if (holders.some((device) => !device.revoked)) {
    return { ok: false, reason: 'duplicate-name' };
  }

  // Every existing holder of this name (if any) is revoked. Drop them here —
  // not in a separate "forget" step — so `revokeNamed`'s uniqueness
  // assumption holds again the moment a fresh device takes the name.
  const survivors = devices.filter((device) => device.name !== name);

  const minted = mintUniqueDevice(name, survivors, now, mint);
  if (!minted) return { ok: false, reason: 'mint-failed' };

  const persisted = store.writeDevices([...survivors, minted.device]);
  if (!persisted) return { ok: false, reason: 'write-failed' };
  return { ok: true, device: minted.device, token: minted.token };
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

export type RevokeOutcome =
  | { revoked: true }
  /** No device holds `name` — nothing to persist, and nothing wrong either. */
  | { revoked: false; reason: 'not-found' }
  /**
   * `revokeNamed` found the device and flipped its flag in memory, but
   * `store.writeDevices` reported `false` (HIVE-142 review, C1) — the write
   * did not land. This is the fail-closed answer: the digest on disk is
   * unchanged, so the device can still authenticate, and `revoked: true`
   * here would be exactly the "reports success without applying" shape the
   * review called out as the wrong one for a security control. The caller
   * must treat this like the revoke never happened, because — on disk — it
   * did not.
   */
  | { revoked: false; reason: 'write-failed' };

/**
 * The one place a {@link RevokeOutcome} becomes a message a person reads
 * (HIVE-142 review, C1) — the same reason {@link pairOutcomeMessage} exists:
 * `--revoke`, the tray's "Revoke" and the Settings pane's `server:revoke`
 * handler each get the accurate reason from one implementation rather than
 * three that can drift, or three that all say "no such device" for a write
 * failure that was never that.
 */
export function revokeOutcomeMessage(
  outcome: Extract<RevokeOutcome, { revoked: false }>,
  name: string,
): string {
  switch (outcome.reason) {
    case 'not-found':
      return `No device named "${name}" is paired.`;
    case 'write-failed':
      return `"${name}" was not revoked — the config file could not be written. It can still reach this Hive; check that the file is writable and try again.`;
  }
}

/**
 * Revokes the device named `name` against a freshly-read roster, and
 * persists the result — the one implementation `--revoke` and the tray's
 * "Revoke" both call (HIVE-142 review, N2), for the same reason
 * {@link pairDevice} exists: `store.readDevices()` is called exactly once,
 * and a no-op (unknown name) writes nothing at all.
 *
 * Fails closed on a write failure (HIVE-142 review, C1): revoking a stolen
 * device is the single most security-critical action this module offers,
 * and reporting `revoked: true` for a write that never reached disk would
 * tell whoever is holding the stolen laptop's clock nothing has changed —
 * because, until the write actually lands, nothing has.
 */
export function revokeDevice(name: string, store: DeviceStore): RevokeOutcome {
  const result = revokeNamed(store.readDevices(), name);
  if (!result.revoked) return { revoked: false, reason: 'not-found' };

  const persisted = store.writeDevices(result.devices);
  if (!persisted) return { revoked: false, reason: 'write-failed' };
  return { revoked: true };
}
