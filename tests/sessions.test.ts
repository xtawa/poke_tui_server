import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import WebSocket from 'ws';
import { loadConfig } from '../src/config.js';
import { Storage } from '../src/storage.js';
import { SessionManager } from '../src/sessions.js';

const cleanup: string[] = [];

afterEach(() => {
  for (const path of cleanup.splice(0)) rmSync(path, { recursive: true, force: true });
});

function createDeps() {
  const dir = mkdtempSync(join(tmpdir(), 'poke-sessions-test-'));
  cleanup.push(dir);
  const config = loadConfig({
    NODE_ENV: 'test',
    PUBLIC_BASE_URL: 'http://127.0.0.1:3000',
    POKE_API_KEY: 'test-poke-api-key-123456',
    MCP_SHARED_SECRET: 'test-mcp-shared-secret-0000000000000000',
    DEVICE_ENROLLMENT_SECRET: 'test-enrollment-secret-0000000000000000',
    DATABASE_PATH: join(dir, 'poke.db'),
    TRUST_PROXY: 'false'
  });
  const storage = new Storage(config);
  const sessions = new SessionManager(storage, config);
  return { storage, sessions };
}

class FakeSocket extends EventEmitter {
  readyState = WebSocket.OPEN;
  shouldThrow = false;
  sent: string[] = [];

  send(data: string): void {
    if (this.shouldThrow) throw new Error('simulated send failure');
    this.sent.push(data);
  }

  close(): void {
    this.readyState = WebSocket.CLOSED;
    this.emit('close');
  }

  terminate(): void {
    this.readyState = WebSocket.CLOSED;
    this.emit('close');
  }

  ping(): void {}
}

describe('SessionManager delivery persistence', () => {
  it('marks sent_at only after a successful websocket send', () => {
    const { storage, sessions } = createDeps();
    try {
      const device = storage.enrollDevice('device', 'device-token');
      const socket = new FakeSocket();
      sessions.attach(device.id, socket as unknown as WebSocket);
      const outbound = storage.queueOutbound(device.id, null, 'notification', { title: 'A', body: 'B' });

      expect(sessions.deliver(outbound)).toBe(true);
      const pending = storage.pendingOutbound(device.id);
      expect(pending).toHaveLength(1);
      expect(pending[0].sentAt).not.toBeNull();
    } finally {
      sessions.stop();
      storage.close();
    }
  });

  it('keeps sent_at null when websocket send throws so diagnostics remain truthful', () => {
    const { storage, sessions } = createDeps();
    try {
      const device = storage.enrollDevice('device', 'device-token');
      const socket = new FakeSocket();
      sessions.attach(device.id, socket as unknown as WebSocket);
      socket.shouldThrow = true;
      const outbound = storage.queueOutbound(device.id, null, 'notification', { title: 'A', body: 'B' });

      expect(sessions.deliver(outbound)).toBe(false);
      const pending = storage.pendingOutbound(device.id);
      expect(pending).toHaveLength(1);
      expect(pending[0].sentAt).toBeNull();
    } finally {
      sessions.stop();
      storage.close();
    }
  });
});
