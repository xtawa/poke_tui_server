import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import WebSocket from 'ws';
import { loadConfig } from '../src/config.js';
import { Storage } from '../src/storage.js';
import { SessionManager } from '../src/sessions.js';
import { buildServer } from '../src/server.js';
import type { PokeClient } from '../src/poke.js';

const cleanup: string[] = [];
const closers: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  while (closers.length) await closers.pop()?.();
  for (const path of cleanup.splice(0)) rmSync(path, { recursive: true, force: true });
});

async function start(allowQueryToken: boolean) {
  const dir = mkdtempSync(join(tmpdir(), 'poke-ws-auth-'));
  cleanup.push(dir);
  const config = loadConfig({
    NODE_ENV: 'test',
    HOST: '127.0.0.1',
    PUBLIC_BASE_URL: 'http://127.0.0.1:3000',
    POKE_API_KEY: 'test-poke-api-key-123456',
    MCP_SHARED_SECRET: 'test-mcp-shared-secret-0000000000000000',
    DEVICE_ENROLLMENT_SECRET: 'test-enrollment-secret-0000000000000000',
    DATABASE_PATH: join(dir, 'poke.db'),
    TRUST_PROXY: 'false',
    ALLOW_WS_QUERY_TOKEN: String(allowQueryToken)
  });
  const storage = new Storage(config);
  const sessions = new SessionManager(storage, config);
  const poke = { sendDeviceMessage: async () => undefined } as unknown as PokeClient;
  const app = await buildServer({ config, storage, sessions, poke });
  await app.listen({ host: '127.0.0.1', port: 0 });
  const address = app.server.address();
  if (!address || typeof address === 'string') throw new Error('no listen address');
  closers.push(async () => {
    sessions.stop();
    await app.close();
    storage.close();
  });
  return { storage, wsBase: `ws://127.0.0.1:${address.port}` };
}

function waitForClose(ws: WebSocket): Promise<number> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timeout waiting for close')), 3000);
    ws.once('close', code => {
      clearTimeout(timer);
      resolve(code);
    });
    ws.once('error', () => undefined);
  });
}

function waitForOpen(ws: WebSocket): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timeout waiting for open')), 3000);
    ws.once('open', () => {
      clearTimeout(timer);
      resolve();
    });
    ws.once('error', error => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

describe('WebSocket query-token compatibility', () => {
  it('rejects query token authentication by default', async () => {
    const { storage, wsBase } = await start(false);
    const token = 'device-token-query-disabled';
    storage.enrollDevice('query-disabled', token);
    const ws = new WebSocket(`${wsBase}/ws?token=${encodeURIComponent(token)}`);
    expect(await waitForClose(ws)).toBe(1008);
  });

  it('accepts query token only when explicitly enabled', async () => {
    const { storage, wsBase } = await start(true);
    const token = 'device-token-query-enabled';
    storage.enrollDevice('query-enabled', token);
    const ws = new WebSocket(`${wsBase}/ws?token=${encodeURIComponent(token)}`);
    await waitForOpen(ws);
    ws.close(1000, 'done');
  });
});
