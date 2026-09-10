import { execFileSync } from 'node:child_process';
import { closeSync, mkdirSync, openSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { configPath } from '../config/paths';

export interface ServerLockIo {
  create: (path: string, contents: string) => void;
  read: (path: string) => string;
  remove: (path: string) => void;
  createRecoveryGuard: (path: string, contents: string) => void;
  removeRecoveryGuard: (path: string) => void;
  processIdentity: (pid: number) => string | null;
}

export type ServerLockClaim =
  | { kind: 'claimed'; release: () => void }
  | { kind: 'active' };

function errorCode(cause: unknown): string | undefined {
  if (typeof cause !== 'object' || cause === null) return undefined;
  const code = Object.getOwnPropertyDescriptor(cause, 'code')?.value;
  return typeof code === 'string' ? code : undefined;
}

function exitStatus(cause: unknown): number | undefined {
  if (typeof cause !== 'object' || cause === null) return undefined;
  const status = Object.getOwnPropertyDescriptor(cause, 'status')?.value;
  return typeof status === 'number' ? status : undefined;
}

function defaultIo(): ServerLockIo {
  return {
    create(path, contents) {
      mkdirSync(dirname(path), { recursive: true });
      const descriptor = openSync(path, 'wx', 0o600);
      try {
        writeFileSync(descriptor, contents, 'utf8');
      } finally {
        closeSync(descriptor);
      }
    },
    read: (path) => readFileSync(path, 'utf8'),
    remove: (path) => unlinkSync(path),
    createRecoveryGuard(path, contents) {
      mkdirSync(dirname(path), { recursive: true });
      const descriptor = openSync(path, 'wx', 0o600);
      try {
        writeFileSync(descriptor, contents, 'utf8');
      } finally {
        closeSync(descriptor);
      }
    },
    removeRecoveryGuard: (path) => unlinkSync(path),
    processIdentity(pid) {
      try {
        process.kill(pid, 0);
      } catch (cause) {
        if (errorCode(cause) === 'ESRCH') return null;
        throw cause;
      }
      try {
        const started = execFileSync('ps', ['-o', 'lstart=', '-p', String(pid)], {
          encoding: 'utf8',
        }).trim();
        return started === '' ? null : `${String(pid)}:${started}`;
      } catch (cause) {
        if (exitStatus(cause) === 1) return null;
        throw cause;
      }
    },
  };
}

interface LockRecord {
  pid: number;
  identity: string;
}

function lockRecord(contents: string): LockRecord | null {
  try {
    const parsed: unknown = JSON.parse(contents);
    if (
      typeof parsed === 'object' &&
      parsed !== null &&
      'pid' in parsed &&
      typeof parsed.pid === 'number' &&
      Number.isSafeInteger(parsed.pid) &&
      parsed.pid > 0 &&
      'identity' in parsed &&
      typeof parsed.identity === 'string' &&
      parsed.identity !== ''
    ) {
      return { pid: parsed.pid, identity: parsed.identity };
    }
  } catch {
    return null;
  }
  return null;
}

export function serverLockPath(): string {
  return join(dirname(configPath()), 'server.lock');
}

export function hasActiveServerLock(path: string, io: ServerLockIo = defaultIo()): boolean {
  let contents: string;
  try {
    contents = io.read(path);
  } catch (cause) {
    if (errorCode(cause) === 'ENOENT') return false;
    throw cause;
  }

  const record = lockRecord(contents);
  return record === null || io.processIdentity(record.pid) === record.identity;
}

export function claimServerLock(
  path: string = serverLockPath(),
  pid: number = process.pid,
  io: ServerLockIo = defaultIo(),
): ServerLockClaim {
  const identity = io.processIdentity(pid);
  if (identity === null) throw new Error(`could not identify server process ${String(pid)}`);
  const contents = JSON.stringify({ pid, identity });
  const recoveryGuardPath = `${path}.recovery`;

  try {
    io.createRecoveryGuard(recoveryGuardPath, contents);
  } catch (cause) {
    if (errorCode(cause) === 'EEXIST') {
      if (hasActiveServerLock(recoveryGuardPath, io)) return { kind: 'active' };
      try {
        io.removeRecoveryGuard(recoveryGuardPath);
      } catch (removeCause) {
        if (errorCode(removeCause) !== 'ENOENT') throw removeCause;
      }
      return claimServerLock(path, pid, io);
    }
    throw cause;
  }

  const releaseRecoveryGuard = (): void => {
    try {
      io.removeRecoveryGuard(recoveryGuardPath);
    } catch (cause) {
      if (errorCode(cause) !== 'ENOENT') throw cause;
    }
  };

  let result: ServerLockClaim | undefined;
  try {
    let exists = true;
    try {
      io.read(path);
    } catch (cause) {
      if (errorCode(cause) === 'ENOENT') exists = false;
      else throw cause;
    }

    if (exists) {
      if (hasActiveServerLock(path, io)) {
        result = { kind: 'active' };
      } else {
        io.remove(path);
      }
    }

    if (result === undefined) {
      try {
        io.create(path, contents);
      } catch (cause) {
        if (errorCode(cause) === 'EEXIST') result = { kind: 'active' };
        else throw cause;
      }
    }

    result ??= {
      kind: 'claimed',
      release: () => {
        try {
          if (io.read(path) === contents) io.remove(path);
        } catch (cause) {
          if (errorCode(cause) !== 'ENOENT') throw cause;
        }
      },
    };
  } catch (cause) {
    releaseRecoveryGuard();
    throw cause;
  }
  releaseRecoveryGuard();
  if (result === undefined) throw new Error('server lock claim did not resolve');
  return result;
}
