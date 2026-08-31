import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';
import websocket from '@fastify/websocket';
import type WebSocket from 'ws';
import type { Config } from './config.js';
import { pokeUserAllowlist } from './config.js';
import { constantTimeEqual, hashText, newToken } from './crypto.js';
import { ackSchema, chatSendSchema, clientEnvelopeSchema, deviceStatusSchema } from './protocol.js';
import type { Storage, Device } from './storage.js';
import type { PokeClient } from './poke.js';
import type { SessionManager } from './sessions.js';
import { createMcpNodeHandler } from './mcp.js';
import { FixedWindowRateLimiter } from './rate-limit.js';

function bearer(header: string | undefined): string | null {
  if (!header?.startsWith('Bearer ')) return null;
  return header.slice(7).trim() || null;
}

export async function buildServer(deps: { config: Config; storage: Storage; poke: PokeClient; sessions: SessionManager }): Promise<FastifyInstance> {
  const { config, storage, poke, sessions } = deps;
  const app = Fastify({
    logger: { level: config.LOG_LEVEL, redact: ['req.headers.authorization'] },
    trustProxy: config.TRUST_PROXY,
    bodyLimit: 128 * 1024,
    // Query-token WebSocket auth exists only for old Android clients. Avoid logging URLs containing it.
    disableRequestLogging: true
  });
  await app.register(websocket, { options: { perMessageDeflate: false, maxPayload: 64 * 1024 } });
  const mcpNode = createMcpNodeHandler(storage, sessions);
  const allowlist = pokeUserAllowlist(config);
  const limiter = new FixedWindowRateLimiter();
  const expectedPublicHost = new URL(config.PUBLIC_BASE_URL).hostname;
  const pruneTimer = setInterval(() => limiter.prune(), 5 * 60_000);
  pruneTimer.unref();
  app.addHook('onClose', async () => { clearInterval(pruneTimer); });

  const authDevice = (request: FastifyRequest): Device | null => {
    const token = bearer(request.headers.authorization);
    return token ? storage.authenticateDevice(token) : null;
  };

  app.get('/health', async () => ({ status: 'ok', uptime: process.uptime(), connectedDevices: sessions.count(), database: storage.ping() ? 'ok' : 'error' }));
  app.get('/ready', async (_request, reply) => storage.ping() ? { status: 'ready' } : reply.code(503).send({ status: 'not_ready' }));

  app.post('/api/v1/enroll', async (request, reply) => {
    if (!limiter.allow(`enroll:${request.ip}`, 10, 10 * 60_000)) return reply.code(429).send({ error: 'rate_limited' });
    const token = bearer(request.headers.authorization);
    if (!token || !constantTimeEqual(token, config.DEVICE_ENROLLMENT_SECRET)) return reply.code(401).send({ error: 'unauthorized' });
    const body = request.body as { name?: unknown; clientDeviceId?: unknown };
    if (typeof body?.name !== 'string' || body.name.length < 1 || body.name.length > 128) return reply.code(400).send({ error: 'invalid_name' });
    const deviceToken = newToken();
    const device = storage.enrollDevice(body.name, deviceToken, typeof body.clientDeviceId === 'string' ? body.clientDeviceId.slice(0, 256) : undefined);
    return reply.code(201).send({ deviceId: device.id, deviceToken, websocketUrl: `${config.PUBLIC_BASE_URL.replace(/^http/, 'ws')}/ws`, apiBaseUrl: `${config.PUBLIC_BASE_URL}/api/v1` });
  });

  app.get('/api/v1/device', async (request, reply) => {
    const device = authDevice(request);
    if (!device) return reply.code(401).send({ error: 'unauthorized' });
    return { id: device.id, name: device.name, lastSeenAt: device.lastSeenAt, status: storage.getStatus(device.id), online: sessions.isOnline(device.id) };
  });

  app.delete('/api/v1/device', async (request, reply) => {
    const device = authDevice(request);
    if (!device) return reply.code(401).send({ error: 'unauthorized' });
    storage.revokeDevice(device.id);
    sessions.disconnect(device.id);
    return reply.code(204).send();
  });

  const submit = async (device: Device, text: string, clientMessageId?: string): Promise<string> => {
    if (text.length > config.MAX_MESSAGE_LENGTH) throw new Error('message_too_long');

    if (clientMessageId) {
      const existing = storage.findRequestByClientMessage(device.id, clientMessageId);
      if (existing) {
        if (existing.textHash !== hashText(text)) throw new Error('idempotency_conflict');
        sessions.sendTransient(device.id, 'chat.accepted', { requestId: existing.requestId, duplicate: true });
        return existing.requestId;
      }
    }

    if (!limiter.allow(`chat:${device.id}`, 30, 60_000)) throw new Error('rate_limited');
    const requestId = storage.createRequest(device.id, text, clientMessageId);
    try {
      await poke.sendDeviceMessage({ deviceId: device.id, requestId, text });
      storage.markRequestAccepted(requestId);
      sessions.sendTransient(device.id, 'chat.accepted', { requestId });
      const timeout = setTimeout(() => {
        if (storage.expireAcceptedRequest(requestId)) {
          sessions.sendTransient(device.id, 'error', { requestId, code: 'POKE_REPLY_TIMEOUT', message: 'Poke accepted the request but did not return a device reply in time.' });
        }
      }, config.POKE_REPLY_TIMEOUT_MS);
      timeout.unref();
      return requestId;
    } catch (error) {
      const message = error instanceof Error ? error.message : 'unknown_error';
      storage.markRequestError(requestId, message);
      sessions.sendTransient(device.id, 'error', { requestId, code: 'POKE_API_ERROR', message: 'Poke did not accept the request.' });
      throw error;
    }
  };

  app.post('/api/v1/messages', async (request, reply) => {
    const device = authDevice(request);
    if (!device) return reply.code(401).send({ error: 'unauthorized' });
    const parsed = chatSendSchema.safeParse(request.body);
    if (!parsed.success || parsed.data.text.length > config.MAX_MESSAGE_LENGTH) return reply.code(400).send({ error: 'invalid_message' });
    const rawIdempotencyKey = request.headers['idempotency-key'];
    if (rawIdempotencyKey !== undefined && (typeof rawIdempotencyKey !== 'string' || rawIdempotencyKey.length < 1 || rawIdempotencyKey.length > 128)) {
      return reply.code(400).send({ error: 'invalid_idempotency_key' });
    }
    try {
      const requestId = await submit(device, parsed.data.text, rawIdempotencyKey);
      return reply.code(202).send({ accepted: true, requestId });
    } catch (error) {
      if (error instanceof Error && error.message === 'rate_limited') return reply.code(429).send({ accepted: false, error: 'rate_limited' });
      if (error instanceof Error && error.message === 'idempotency_conflict') return reply.code(409).send({ accepted: false, error: 'idempotency_conflict' });
      return reply.code(502).send({ accepted: false, error: 'poke_api_error' });
    }
  });

  app.get('/api/v1/messages', async (request, reply) => {
    const device = authDevice(request);
    if (!device) return reply.code(401).send({ error: 'unauthorized' });
    return { messages: storage.pendingOutbound(device.id).map(m => ({ id: m.id, type: m.type, timestamp: m.createdAt, payload: JSON.parse(m.payload) })) };
  });

  app.post('/api/v1/messages/:messageId/ack', async (request, reply) => {
    const device = authDevice(request);
    if (!device) return reply.code(401).send({ error: 'unauthorized' });
    const { messageId } = request.params as { messageId: string };
    if (!storage.acknowledge(device.id, messageId)) return reply.code(404).send({ error: 'message_not_found' });
    return reply.code(204).send();
  });

  app.post('/api/v1/device/status', async (request, reply) => {
    const device = authDevice(request);
    if (!device) return reply.code(401).send({ error: 'unauthorized' });
    const parsed = deviceStatusSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_status' });
    storage.updateStatus(device.id, parsed.data);
    storage.touchDevice(device.id);
    return reply.code(204).send();
  });

  app.get('/ws', { websocket: true }, (socket: WebSocket, request) => {
    const query = request.query as { token?: unknown };
    const headerToken = bearer(request.headers.authorization);
    const queryToken = typeof query.token === 'string' && query.token.length <= 256 ? query.token : null;
    const token = headerToken ?? queryToken;
    const device = token ? storage.authenticateDevice(token) : null;
    if (!device) { socket.close(1008, 'unauthorized'); return; }
    sessions.attach(device.id, socket);
    socket.on('message', data => {
      try {
        const json = JSON.parse(data.toString());
        const envelope = clientEnvelopeSchema.parse(json);
        if (envelope.type === 'chat.send') {
          const payload = chatSendSchema.parse(envelope.payload);
          if (payload.text.length > config.MAX_MESSAGE_LENGTH) throw new Error('message_too_long');
          void submit(device, payload.text, envelope.id).catch(error => {
            const code = error instanceof Error && error.message === 'rate_limited'
              ? 'RATE_LIMITED'
              : error instanceof Error && error.message === 'idempotency_conflict'
                ? 'IDEMPOTENCY_CONFLICT'
                : 'REQUEST_FAILED';
            const message = code === 'RATE_LIMITED'
              ? 'Too many messages.'
              : code === 'IDEMPOTENCY_CONFLICT'
                ? 'The same message ID was reused with different content.'
                : 'Request failed.';
            sessions.sendTransient(device.id, 'error', { clientMessageId: envelope.id, code, message });
          });
        } else if (envelope.type === 'ack') {
          const payload = ackSchema.parse(envelope.payload);
          storage.acknowledge(device.id, payload.messageId);
        } else if (envelope.type === 'device.status') {
          const payload = deviceStatusSchema.parse(envelope.payload);
          storage.updateStatus(device.id, payload);
          storage.touchDevice(device.id);
        } else if (envelope.type === 'ping') {
          sessions.sendTransient(device.id, 'pong', { clientMessageId: envelope.id });
        }
      } catch {
        sessions.sendTransient(device.id, 'error', { code: 'PROTOCOL_ERROR', message: 'Invalid WebSocket message.' });
      }
    });
  });

  app.all('/mcp', async (request, reply) => {
    if (config.NODE_ENV === 'production' && request.hostname !== expectedPublicHost) return reply.code(403).send({ error: 'invalid_host' });
    const origin = request.headers.origin;
    if (origin) {
      try {
        if (new URL(origin).hostname !== expectedPublicHost) return reply.code(403).send({ error: 'invalid_origin' });
      } catch {
        return reply.code(403).send({ error: 'invalid_origin' });
      }
    }
    const token = bearer(request.headers.authorization);
    if (!token || !constantTimeEqual(token, config.MCP_SHARED_SECRET)) return reply.code(401).send({ error: 'unauthorized' });
    const pokeUserId = request.headers['x-poke-user-id'];
    if (allowlist.size > 0 && (typeof pokeUserId !== 'string' || !allowlist.has(pokeUserId))) return reply.code(403).send({ error: 'poke_user_not_allowed' });
    if (!limiter.allow(`mcp:${typeof pokeUserId === 'string' ? pokeUserId : 'unknown'}`, 120, 60_000)) return reply.code(429).send({ error: 'rate_limited' });
    reply.hijack();
    await mcpNode(request.raw, reply.raw, request.body);
  });

  return app;
}
