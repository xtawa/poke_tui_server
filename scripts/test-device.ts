import WebSocket from 'ws';
import { randomUUID } from 'node:crypto';

const serverUrl = process.env.SERVER_URL;
const deviceToken = process.env.DEVICE_TOKEN;
if (!serverUrl || !deviceToken) {
  console.error('SERVER_URL and DEVICE_TOKEN are required');
  process.exit(2);
}

const wsUrl = serverUrl.replace(/^http/, 'ws').replace(/\/$/, '') + '/ws';
const ws = new WebSocket(wsUrl, { headers: { Authorization: `Bearer ${deviceToken}` } });
const timeout = setTimeout(() => {
  console.error('FAIL: timeout waiting for chat.message');
  ws.terminate();
  process.exit(1);
}, 240_000);

let sent = false;
ws.on('message', raw => {
  const msg = JSON.parse(raw.toString()) as { id: string; type: string; payload?: any };
  console.log(msg.type, msg.payload ?? '');
  if (msg.type === 'hello' && !sent) {
    sent = true;
    ws.send(JSON.stringify({
      id: `client_${randomUUID()}`,
      type: 'chat.send',
      timestamp: Date.now(),
      payload: { text: 'Reply with exactly: POKE_DEVICE_BRIDGE_OK' }
    }));
  }
  if (msg.type === 'chat.message') {
    const text = String(msg.payload?.text ?? '');
    ws.send(JSON.stringify({ id: `client_${randomUUID()}`, type: 'ack', timestamp: Date.now(), payload: { messageId: msg.id } }));
    clearTimeout(timeout);
    ws.close(1000, 'test complete');
    if (text.trim() !== 'POKE_DEVICE_BRIDGE_OK') {
      console.error(`FAIL: unexpected response: ${text}`);
      process.exitCode = 1;
    } else {
      console.log('PASS: Poke reply reached simulated device');
    }
  }
});

ws.on('error', error => {
  clearTimeout(timeout);
  console.error('FAIL:', error.message);
  process.exitCode = 1;
});
