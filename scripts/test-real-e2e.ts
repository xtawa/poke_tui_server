import WebSocket from 'ws';
import { randomUUID } from 'node:crypto';

const serverUrl = process.env.SERVER_URL?.replace(/\/$/, '');
const enrollmentSecret = process.env.DEVICE_ENROLLMENT_SECRET;
const expectedText = process.env.E2E_EXPECTED_TEXT ?? 'POKE_DEVICE_BRIDGE_OK';
const timeoutMs = Number(process.env.E2E_TIMEOUT_MS ?? 240_000);

if (!serverUrl || !enrollmentSecret) {
  console.error('SERVER_URL and DEVICE_ENROLLMENT_SECRET are required');
  process.exit(2);
}
if (!Number.isFinite(timeoutMs) || timeoutMs < 10_000) {
  console.error('E2E_TIMEOUT_MS must be a number >= 10000');
  process.exit(2);
}

type Enrollment = {
  deviceId: string;
  deviceToken: string;
  websocketUrl: string;
  apiBaseUrl: string;
};

type Envelope = {
  id: string;
  type: string;
  timestamp: number;
  payload?: Record<string, unknown>;
};

function authHeaders(token: string): Record<string, string> {
  return { Authorization: `Bearer ${token}` };
}

async function expectJson(url: string, expectedStatus = 200, init?: RequestInit): Promise<any> {
  const response = await fetch(url, init);
  const text = await response.text();
  let body: any = null;
  if (text) {
    try { body = JSON.parse(text); } catch { body = text; }
  }
  if (response.status !== expectedStatus) {
    throw new Error(`${init?.method ?? 'GET'} ${url} expected ${expectedStatus}, got ${response.status}: ${text}`);
  }
  return body;
}

async function waitForMessage(
  ws: WebSocket,
  predicate: (message: Envelope) => boolean,
  timeout: number
): Promise<Envelope> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`timeout after ${timeout}ms waiting for WebSocket message`));
    }, timeout);
    const onMessage = (raw: WebSocket.RawData) => {
      let message: Envelope;
      try {
        message = JSON.parse(raw.toString()) as Envelope;
      } catch {
        return;
      }
      if (message.type === 'error') {
        cleanup();
        reject(new Error(`bridge returned error: ${JSON.stringify(message.payload ?? {})}`));
        return;
      }
      if (predicate(message)) {
        cleanup();
        resolve(message);
      }
    };
    const onClose = (code: number, reason: Buffer) => {
      cleanup();
      reject(new Error(`WebSocket closed before expected message: ${code} ${reason.toString()}`));
    };
    const cleanup = () => {
      clearTimeout(timer);
      ws.off('message', onMessage);
      ws.off('close', onClose);
    };
    ws.on('message', onMessage);
    ws.on('close', onClose);
  });
}

async function openWebSocket(url: string, token: string): Promise<WebSocket> {
  const ws = new WebSocket(url, { headers: authHeaders(token) });
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timeout opening WebSocket')), 15_000);
    ws.once('open', () => {
      clearTimeout(timer);
      resolve();
    });
    ws.once('error', error => {
      clearTimeout(timer);
      reject(error);
    });
  });
  return ws;
}

async function run(): Promise<void> {
  let enrollment: Enrollment | null = null;
  let ws: WebSocket | null = null;
  let revoked = false;
  const startedAt = Date.now();

  try {
    const health = await expectJson(`${serverUrl}/health`);
    if (health?.status !== 'ok' || health?.database !== 'ok') throw new Error(`health not ok: ${JSON.stringify(health)}`);
    const ready = await expectJson(`${serverUrl}/ready`);
    if (ready?.status !== 'ready') throw new Error(`ready not ok: ${JSON.stringify(ready)}`);
    console.log('PASS health + ready');

    enrollment = await expectJson(`${serverUrl}/api/v1/enroll`, 201, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${enrollmentSecret}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ name: `Real E2E ${new Date().toISOString()}`, clientDeviceId: `e2e_${randomUUID()}` })
    }) as Enrollment;
    if (!enrollment.deviceId || !enrollment.deviceToken || !enrollment.websocketUrl) throw new Error('invalid enrollment response');
    console.log(`PASS enrollment (${enrollment.deviceId})`);

    const deviceInfo = await expectJson(`${serverUrl}/api/v1/device`, 200, { headers: authHeaders(enrollment.deviceToken) });
    if (deviceInfo?.id !== enrollment.deviceId) throw new Error('device auth returned wrong device');
    console.log('PASS device auth');

    ws = await openWebSocket(enrollment.websocketUrl, enrollment.deviceToken);
    const helloPromise = waitForMessage(ws, message => message.type === 'hello', 10_000);
    const hello = await helloPromise;
    if (hello.payload?.deviceId !== enrollment.deviceId) throw new Error('hello deviceId mismatch');
    console.log('PASS WebSocket hello');

    const clientMessageId = `e2e_${randomUUID()}`;
    const prompt = `Reply with exactly: ${expectedText}`;
    const acceptedPromise = waitForMessage(ws, message => message.type === 'chat.accepted', 30_000);
    ws.send(JSON.stringify({
      id: clientMessageId,
      type: 'chat.send',
      timestamp: Date.now(),
      payload: { text: prompt }
    }));
    const accepted = await acceptedPromise;
    const requestId = String(accepted.payload?.requestId ?? '');
    if (!requestId.startsWith('req_')) throw new Error(`invalid requestId: ${requestId}`);
    console.log(`PASS Poke API accepted (${requestId})`);

    const reply = await waitForMessage(
      ws,
      message => message.type === 'chat.message' && String(message.payload?.requestId ?? '') === requestId,
      timeoutMs
    );
    const text = String(reply.payload?.text ?? '').trim();
    if (text !== expectedText) throw new Error(`unexpected Poke reply: ${JSON.stringify(text)}`);
    console.log(`PASS real Poke -> Remote MCP -> device reply (${reply.id})`);

    ws.send(JSON.stringify({
      id: `ack_${randomUUID()}`,
      type: 'ack',
      timestamp: Date.now(),
      payload: { messageId: reply.id }
    }));

    const queueDeadline = Date.now() + 10_000;
    let acknowledged = false;
    while (Date.now() < queueDeadline) {
      const pending = await expectJson(`${serverUrl}/api/v1/messages`, 200, { headers: authHeaders(enrollment.deviceToken) });
      const messages = Array.isArray(pending?.messages) ? pending.messages : [];
      if (!messages.some((item: any) => item?.id === reply.id)) {
        acknowledged = true;
        break;
      }
      await new Promise(resolve => setTimeout(resolve, 250));
    }
    if (!acknowledged) throw new Error('reply remained pending after ACK');
    console.log('PASS ACK persisted / pending queue cleared');

    ws.close(1000, 'real e2e complete');
    ws = null;

    await expectJson(`${serverUrl}/api/v1/device`, 204, {
      method: 'DELETE',
      headers: authHeaders(enrollment.deviceToken)
    });
    revoked = true;
    console.log('PASS test device revoked');

    const afterRevoke = await fetch(`${serverUrl}/api/v1/device`, { headers: authHeaders(enrollment.deviceToken) });
    if (afterRevoke.status !== 401) throw new Error(`revoked token expected 401, got ${afterRevoke.status}`);
    console.log('PASS revoked token rejected');

    console.log(`REAL POKE E2E PASS in ${Date.now() - startedAt}ms`);
  } finally {
    if (ws) {
      try { ws.close(1000, 'cleanup'); } catch { /* ignore */ }
    }
    if (enrollment && !revoked) {
      try {
        await fetch(`${serverUrl}/api/v1/device`, {
          method: 'DELETE',
          headers: authHeaders(enrollment.deviceToken)
        });
      } catch {
        // Best-effort cleanup only; retain the original failure.
      }
    }
  }
}

run().catch(error => {
  console.error('REAL POKE E2E FAIL:', error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
