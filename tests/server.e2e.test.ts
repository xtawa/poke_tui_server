import { afterEach, describe, expect, it, vi } from 'vitest';
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

const MCP_SECRET = 'test-mcp-shared-secret-0000000000000000';
const ENROLL_SECRET = 'test-enrollment-secret-0000000000000000';

function createDeps(overrides: Record<string, string> = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'poke-bridge-e2e-'));
  cleanup.push(dir);
  const pokeCalls: Array<{ deviceId: string; requestId: string; text: string }> = [];
  const config = loadConfig({
    NODE_ENV: 'test',
    HOST: '127.0.0.1',
    PUBLIC_BASE_URL: 'http://127.0.0.1:3000',
    POKE_API_KEY: 'test-poke-api-key-123456',
    MCP_SHARED_SECRET: MCP_SECRET,
    DEVICE_ENROLLMENT_SECRET: ENROLL_SECRET,
    DATABASE_PATH: join(dir, 'poke.db'),
    DEVICE_OFFLINE_QUEUE_LIMIT: '10',
    STORE_MESSAGE_CONTENT: 'false',
    TRUST_PROXY: 'false',
    POKE_REPLY_TIMEOUT_MS: '10000',
    ...overrides
  });
  const storage = new Storage(config);
  const sessions = new SessionManager(storage, config);
  const poke = {
    sendDeviceMessage: async (input: { deviceId: string; requestId: string; text: string }) => {
      pokeCalls.push(input);
    }
  } as PokeClient;
  return { dir, config, storage, sessions, poke, pokeCalls };
}

async function startApp(deps: ReturnType<typeof createDeps>) {
  const app = await buildServer(deps);
  await app.listen({ host: '127.0.0.1', port: 0 });
  const address = app.server.address();
  if (!address || typeof address === 'string') throw new Error('no listen address');
  const baseUrl = `http://127.0.0.1:${address.port}`;
  closers.push(async () => {
    deps.sessions.stop();
    await app.close();
    deps.storage.close();
  });
  return { app, baseUrl };
}

async function enroll(baseUrl: string, name: string) {
  const response = await fetch(`${baseUrl}/api/v1/enroll`, {
    method: 'POST',
    headers: { authorization: `Bearer ${ENROLL_SECRET}`, 'content-type': 'application/json' },
    body: JSON.stringify({ name })
  });
  expect(response.status).toBe(201);
  return response.json() as Promise<{ deviceId: string; deviceToken: string }>;
}

async function mcp(baseUrl: string, body: unknown, headers: Record<string, string> = {}) {
  const response = await fetch(`${baseUrl}/mcp`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${MCP_SECRET}`,
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      ...headers
    },
    body: JSON.stringify(body)
  });
  const text = await response.text();
  const dataLine = text.split('\n').find(line => line.startsWith('data: '));
  return { status: response.status, text, json: dataLine ? JSON.parse(dataLine.slice(6)) : null };
}

type TestSocket = WebSocket & { waitForType: (type: string, timeoutMs?: number) => Promise<any> };

function openDeviceSocket(baseUrl: string, deviceToken: string): Promise<TestSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(baseUrl.replace(/^http/, 'ws') + '/ws', {
      headers: { Authorization: `Bearer ${deviceToken}` }
    }) as TestSocket;
    const pending = new Map<string, Array<(msg: any) => void>>();
    ws.on('message', raw => {
      const msg = JSON.parse(raw.toString());
      const waiters = pending.get(msg.type);
      if (waiters && waiters.length) waiters.shift()!(msg);
      else {
        const queued = pending.get(`*${msg.type}`) ?? [];
        queued.push(msg);
        pending.set(`*${msg.type}`, queued);
      }
    });
    ws.waitForType = (type: string, timeoutMs = 3000) => new Promise((res, rej) => {
      const queued = pending.get(`*${type}`);
      if (queued && queued.length) {
        res(queued.shift());
        return;
      }
      const timer = setTimeout(() => rej(new Error(`timeout waiting for ${type}`)), timeoutMs);
      const list = pending.get(type) ?? [];
      list.push(msg => {
        clearTimeout(timer);
        res(msg);
      });
      pending.set(type, list);
    });
    ws.once('open', () => resolve(ws));
    ws.once('error', reject);
    ws.once('close', (code, reason) => {
      if (ws.readyState !== WebSocket.OPEN) {
        reject(new Error(`websocket closed ${code} ${reason.toString()}`));
      }
    });
  });
}

describe('local protocol e2e', () => {
  it('serves health, ready and MCP tool discovery', async () => {
    const deps = createDeps();
    const { baseUrl } = await startApp(deps);
    const health = await (await fetch(`${baseUrl}/health`)).json() as { status: string; database: string };
    const ready = await (await fetch(`${baseUrl}/ready`)).json() as { status: string };
    expect(health.status).toBe('ok');
    expect(health.database).toBe('ok');
    expect(ready.status).toBe('ready');

    const listed = await mcp(baseUrl, { jsonrpc: '2.0', id: 1, method: 'tools/list' });
    expect(listed.status).toBe(200);
    const names = listed.json.result.tools.map((tool: { name: string }) => tool.name);
    expect(names).toEqual(['reply_to_device', 'notify_device', 'get_device_status']);

    const unauth = await fetch(`${baseUrl}/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' })
    });
    expect(unauth.status).toBe(401);
  });

  it('completes device WS chat -> mock Poke -> reply_to_device -> ACK', async () => {
    const deps = createDeps();
    const { baseUrl } = await startApp(deps);
    const device = await enroll(baseUrl, 'E2E Test Device');
    const ws = await openDeviceSocket(baseUrl, device.deviceToken);
    closers.push(() => ws.close());
    const hello = await ws.waitForType('hello');
    expect(hello.payload.deviceId).toBe(device.deviceId);

    ws.send(JSON.stringify({
      id: 'e2e_test_001',
      type: 'chat.send',
      timestamp: 0,
      payload: { text: 'Reply with exactly: POKE_DEVICE_BRIDGE_OK' }
    }));
    const accepted = await ws.waitForType('chat.accepted');
    expect(accepted.payload.requestId).toMatch(/^req_/);
    expect(deps.pokeCalls).toHaveLength(1);
    expect(deps.pokeCalls[0].deviceId).toBe(device.deviceId);
    expect(deps.pokeCalls[0].requestId).toBe(accepted.payload.requestId);

    const reply = await mcp(baseUrl, {
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: {
        name: 'reply_to_device',
        arguments: {
          deviceId: device.deviceId,
          requestId: accepted.payload.requestId,
          text: 'POKE_DEVICE_BRIDGE_OK'
        }
      }
    });
    expect(reply.json.result.isError ?? false).toBe(false);
    const message = await ws.waitForType('chat.message');
    expect(message.payload.text).toBe('POKE_DEVICE_BRIDGE_OK');

    ws.send(JSON.stringify({ id: 'ack_1', type: 'ack', timestamp: Date.now(), payload: { messageId: message.id } }));
    await vi.waitFor(() => {
      expect(deps.storage.pendingOutbound(device.deviceId)).toHaveLength(0);
    });
    const request = deps.storage.findRequestByClientMessage(device.deviceId, 'e2e_test_001');
    expect(request?.requestId).toBe(accepted.payload.requestId);
  });

  it('returns the same requestId for identical inbound retries and rejects payload conflicts', async () => {
    const deps = createDeps();
    const { baseUrl } = await startApp(deps);
    const device = await enroll(baseUrl, 'Idempotency Device');
    const ws = await openDeviceSocket(baseUrl, device.deviceToken);
    closers.push(() => ws.close());
    await ws.waitForType('hello');

    const send = (text: string) => ws.send(JSON.stringify({
      id: 'retry_test_001',
      type: 'chat.send',
      timestamp: Date.now(),
      payload: { text }
    }));

    send('Reply with exactly IDEMPOTENCY_OK');
    const first = await ws.waitForType('chat.accepted');
    send('Reply with exactly IDEMPOTENCY_OK');
    const second = await ws.waitForType('chat.accepted');
    expect(second.payload.requestId).toBe(first.payload.requestId);
    expect(second.payload.duplicate).toBe(true);
    expect(deps.pokeCalls).toHaveLength(1);

    send('THIS IS DIFFERENT');
    const conflict = await ws.waitForType('error');
    expect(conflict.payload.code).toBe('IDEMPOTENCY_CONFLICT');
    expect(deps.pokeCalls).toHaveLength(1);
  });

  it('replays pending outbound after disconnect and keeps distinct repeated notifications', async () => {
    const deps = createDeps();
    const { baseUrl } = await startApp(deps);
    const device = await enroll(baseUrl, 'Offline Device');
    const firstWs = await openDeviceSocket(baseUrl, device.deviceToken);
    await firstWs.waitForType('hello');
    firstWs.close();
    await vi.waitFor(() => {
      expect(deps.sessions.isOnline(device.deviceId)).toBe(false);
    });

    const notify = async () => mcp(baseUrl, {
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/call',
      params: { name: 'notify_device', arguments: { deviceId: device.deviceId, title: 'Test', body: 'Same message' } }
    });
    const firstNotify = await notify();
    const firstId = JSON.parse(firstNotify.json.result.content[0].text).messageId;
    const secondNotify = await notify();
    const secondId = JSON.parse(secondNotify.json.result.content[0].text).messageId;
    expect(firstId).not.toBe(secondId);
    expect(deps.storage.pendingOutbound(device.deviceId)).toHaveLength(2);

    const secondWs = await openDeviceSocket(baseUrl, device.deviceToken);
    closers.push(() => secondWs.close());
    await secondWs.waitForType('hello');
    const replayed = new Set<string>();
    while (replayed.size < 2) {
      const msg = await secondWs.waitForType('notification');
      replayed.add(msg.id);
      secondWs.send(JSON.stringify({ id: `ack_${msg.id}`, type: 'ack', timestamp: Date.now(), payload: { messageId: msg.id } }));
    }
    expect(replayed.has(firstId)).toBe(true);
    expect(replayed.has(secondId)).toBe(true);
    await vi.waitFor(() => {
      expect(deps.storage.pendingOutbound(device.deviceId)).toHaveLength(0);
    });
  });

  it('isolates request routing and ACKs across devices', async () => {
    const deps = createDeps();
    const { baseUrl } = await startApp(deps);
    const deviceA = await enroll(baseUrl, 'Device A');
    const deviceB = await enroll(baseUrl, 'Device B');
    const wsA = await openDeviceSocket(baseUrl, deviceA.deviceToken);
    const wsB = await openDeviceSocket(baseUrl, deviceB.deviceToken);
    closers.push(() => { wsA.close(); wsB.close(); });
    await wsA.waitForType('hello');
    await wsB.waitForType('hello');

    wsA.send(JSON.stringify({
      id: 'request_a',
      type: 'chat.send',
      timestamp: Date.now(),
      payload: { text: 'from A' }
    }));
    const acceptedA = await wsA.waitForType('chat.accepted');

    const crossed = await mcp(baseUrl, {
      jsonrpc: '2.0',
      id: 4,
      method: 'tools/call',
      params: {
        name: 'reply_to_device',
        arguments: { deviceId: deviceB.deviceId, requestId: acceptedA.payload.requestId, text: 'should fail' }
      }
    });
    expect(crossed.json.result.isError).toBe(true);
    expect(String(crossed.json.result.content[0].text)).toContain('does not belong');

    const valid = await mcp(baseUrl, {
      jsonrpc: '2.0',
      id: 5,
      method: 'tools/call',
      params: {
        name: 'reply_to_device',
        arguments: { deviceId: deviceA.deviceId, requestId: acceptedA.payload.requestId, text: 'ok-a' }
      }
    });
    expect(valid.json.result.isError ?? false).toBe(false);
    const messageA = await wsA.waitForType('chat.message');

    wsB.send(JSON.stringify({ id: 'bad_ack', type: 'ack', timestamp: Date.now(), payload: { messageId: messageA.id } }));
    const ackError = await wsB.waitForType('error');
    expect(ackError.payload.code).toBe('MESSAGE_NOT_FOUND');
    expect(deps.storage.pendingOutbound(deviceA.deviceId)).toHaveLength(1);
  });

  it('revokes a device token and rejects subsequent access', async () => {
    const deps = createDeps();
    const { baseUrl } = await startApp(deps);
    const device = await enroll(baseUrl, 'Revoke Device');
    const ws = await openDeviceSocket(baseUrl, device.deviceToken);
    await ws.waitForType('hello');
    const closed = new Promise<number | undefined>(resolve => ws.once('close', code => resolve(code)));

    const revoke = await fetch(`${baseUrl}/api/v1/device`, {
      method: 'DELETE',
      headers: { authorization: `Bearer ${device.deviceToken}` }
    });
    expect(revoke.status).toBe(204);
    expect(await closed).toBe(4003);

    const rest = await fetch(`${baseUrl}/api/v1/device`, {
      headers: { authorization: `Bearer ${device.deviceToken}` }
    });
    expect(rest.status).toBe(401);

    const requestId = deps.storage.createRequest(device.deviceId, 'after-revoke');
    const reply = await mcp(baseUrl, {
      jsonrpc: '2.0',
      id: 6,
      method: 'tools/call',
      params: {
        name: 'reply_to_device',
        arguments: { deviceId: device.deviceId, requestId, text: 'nope' }
      }
    });
    expect(reply.json.result.isError).toBe(true);
    expect(String(reply.json.result.content[0].text)).toContain('revoked');
  });

  it('times out accepted Poke requests without retrying the user message', async () => {
    const deps = createDeps({ POKE_REPLY_TIMEOUT_MS: '10000' });
    const { baseUrl } = await startApp(deps);
    const device = await enroll(baseUrl, 'Timeout Device');
    const ws = await openDeviceSocket(baseUrl, device.deviceToken);
    closers.push(() => ws.close());
    await ws.waitForType('hello');
    ws.send(JSON.stringify({
      id: 'timeout_001',
      type: 'chat.send',
      timestamp: Date.now(),
      payload: { text: 'wait forever' }
    }));
    await ws.waitForType('chat.accepted');
    expect(deps.pokeCalls).toHaveLength(1);
    const timeout = await ws.waitForType('error', 12_000);
    expect(timeout.payload.code).toBe('POKE_REPLY_TIMEOUT');
    expect(deps.pokeCalls).toHaveLength(1);
  }, 20_000);

  it('exposes HTTP polling fallback and persists pending messages across storage reopen', async () => {
    const deps = createDeps();
    const { baseUrl } = await startApp(deps);
    const device = await enroll(baseUrl, 'REST Device');
    const send = await fetch(`${baseUrl}/api/v1/messages`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${device.deviceToken}`,
        'content-type': 'application/json',
        'idempotency-key': 'rest-key-1'
      },
      body: JSON.stringify({ text: 'Reply with exactly SIMPLE_OK' })
    });
    expect(send.status).toBe(202);
    const body = await send.json() as { requestId: string };
    const retry = await fetch(`${baseUrl}/api/v1/messages`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${device.deviceToken}`,
        'content-type': 'application/json',
        'idempotency-key': 'rest-key-1'
      },
      body: JSON.stringify({ text: 'Reply with exactly SIMPLE_OK' })
    });
    expect(retry.status).toBe(202);
    expect((await retry.json() as { requestId: string }).requestId).toBe(body.requestId);
    expect(deps.pokeCalls).toHaveLength(1);

    await mcp(baseUrl, {
      jsonrpc: '2.0',
      id: 7,
      method: 'tools/call',
      params: {
        name: 'reply_to_device',
        arguments: { deviceId: device.deviceId, requestId: body.requestId, text: 'SIMPLE_OK' }
      }
    });
    const pending = await (await fetch(`${baseUrl}/api/v1/messages`, {
      headers: { authorization: `Bearer ${device.deviceToken}` }
    })).json() as { messages: Array<{ id: string; payload: { text: string } }> };
    expect(pending.messages[0].payload.text).toBe('SIMPLE_OK');

    deps.storage.close();
    const reopened = new Storage(deps.config);
    closers.push(() => reopened.close());
    expect(reopened.pendingOutbound(device.deviceId)).toHaveLength(1);
    expect(reopened.acknowledge(device.deviceId, pending.messages[0].id)).toBe(true);
  });
});
