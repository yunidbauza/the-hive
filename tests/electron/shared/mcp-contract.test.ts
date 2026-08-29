import { describe, expect, it } from 'vitest';

import {
  LEDGER_READ_DEFAULT_LIMIT,
  MCP_PROTOCOL_VERSION,
  MCP_SERVER_NAME,
  RECEIVER_TIMEOUT_MS,
  RPC_INVALID_PARAMS,
  RPC_METHOD_NOT_FOUND,
} from '@shared/mcp-contract';

describe('mcp-contract', () => {
  it('pins the protocol version observed from claude 2.1.251', () => {
    // Not a guess: the probe recorded this in the initialize params.
    expect(MCP_PROTOCOL_VERSION).toBe('2025-11-25');
  });

  it('names the server so tools resolve as mcp__hive__*', () => {
    expect(MCP_SERVER_NAME).toBe('hive');
  });

  it('bounds a first read and the receiver call', () => {
    expect(LEDGER_READ_DEFAULT_LIMIT).toBe(50);
    expect(RECEIVER_TIMEOUT_MS).toBe(5_000);
  });

  it('uses the standard JSON-RPC error codes', () => {
    expect(RPC_METHOD_NOT_FOUND).toBe(-32601);
    expect(RPC_INVALID_PARAMS).toBe(-32602);
  });
});
