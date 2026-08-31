import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../src/config.js';
import { Storage } from '../src/storage.js';

const cleanup: string[] = [];
afterEach(() => {
  for (const path of cleanup.splice(0)) rmSync(path, { recursive: true, force: true });
});

function createStorage(): Storage {
  const dir = mkdtempSync(join(tmpdir(), 'poke-bridge-test-'));
  cleanup.push(dir);
  const config = loadConfig({
    NODE_ENV: 'test',
    PUBLIC_BASE_URL: 'http://localhost:3000',
    POKE_API_KEY: 'test-poke-api-key-123456',
    MCP_SHARED_SECRET: 'test-mcp-shared-secret-0000000000000000',
    DEVICE_ENROLLMENT_SECRET: 'test-enrollment-secret-0000000000000000',
    DATABASE_PATH: join(dir, 'poke.db'),
    DEVICE_OFFLINE_QUEUE_LIMIT: '10',
    STORE_MESSAGE_CONTENT: 'false',
    TRUST_PROXY: 'false'
  });
  return new Storage(config);
}

describe('Storage', () => {
  it('authenticates hashed tokens and binds replies to their originating device', () => {
    const storage = createStorage();
    try {
      const first = storage.enrollDevice('first', 'token-one');
      const second = storage.enrollDevice('second', 'token-two');
      expect(storage.authenticateDevice('token-one')?.id).toBe(first.id);
      expect(storage.authenticateDevice('wrong')).toBeNull();

      const requestId = storage.createRequest(first.id, 'hello');
      expect(storage.requestBelongsTo(requestId, first.id)).toBe(true);
      expect(storage.requestBelongsTo(requestId, second.id)).toBe(false);

      const outbound = storage.queueOutbound(first.id, requestId, 'chat.message', { requestId, text: 'world' });
      expect(storage.pendingOutbound(first.id).map(item => item.id)).toEqual([outbound.id]);
      expect(storage.acknowledge(second.id, outbound.id)).toBe(false);
      expect(storage.acknowledge(first.id, outbound.id)).toBe(true);
      expect(storage.pendingOutbound(first.id)).toHaveLength(0);
    } finally {
      storage.close();
    }
  });

  it('preserves previously reported status fields on partial updates', () => {
    const storage = createStorage();
    try {
      const device = storage.enrollDevice('status-device', 'status-token');
      storage.updateStatus(device.id, { battery: 71, charging: false, appVersion: '0.1.0' });
      storage.updateStatus(device.id, { charging: true });
      const status = storage.getStatus(device.id);
      expect(status.battery).toBe(71);
      expect(status.charging).toBe(true);
      expect(status.appVersion).toBe('0.1.0');
    } finally {
      storage.close();
    }
  });
});
