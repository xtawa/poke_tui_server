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

function mcpMethod(body: unknown): string | undefined {
  if (!body || typeof body !== 'object' || !('method' in body)) return undefined;
  const method = (body as { method?: unknown }).method;
  return typeof method === 'string' ? method.slice(0, 128) : undefined;
}

export async function buildServer(deps: { config: Config; storage: Storage; poke: PokeClient; sessions: SessionManager }): Promise<FastifyInstance> {
  const { config, storage, poke, sessions } = deps;
  const app = Fastify({
    logger: { level: config.LOG_LEVEL, redact: ['req.headers.authorization'] },
    trustProxy: config.TRUST_PROXY,
    bodyLimit: 128 * 1024,
    // Query-token WebSocket auth is opt-in for legacy Android clients. Avoid logging URLs containing it.
    disableRequestLogging: true
  });
  await app.register(websocket, { options: { perMessageDeflate: false, maxPayload: 64 * 1024 } });
  const mcpNode = createMcpNodeHandler(storage, sessions, event => app.log.info(event, event.event));
  const allowlist = pokeUserAllowlist(config);
  const limiter = new FixedWindowRateLimiter();
  const expectedPublicHost = new URL(config.PUBLIC_BASE_URL).hostname;
  const pruneTimer = setInterval(() => limiter.prune(), 5 * 60_000);
  pruneTimer.unref();
  const replyTimeouts = new Set<NodeJS.Timeout>();
  app.addHook('onClose', async () => {
    clearInterval(pruneTimer);
    for (const timer of replyTimeouts) clearTimeout(timer);
    replyTimeouts.clear();
  });

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
    app.log.info({ event: 'device_enrolled', deviceId: device.id }, 'device_enrolled');
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
    app.log.info({ event: 'device_revoked', deviceId: device.id }, 'device_revoked');
    return reply.code(204).send();
  });

  const submit = async (device: Device, text: string, clientMessageId?: string): Promise<string> => {
    if (text.length > config.MAX_MESSAGE_LENGTH) throw new Error('message_too_long');

    if (clientMessageId) {
      const existing = storage.findRequestByClientMessage(device.id, clientMessageId);
      if (existing) {
        if (existing.textHash !== hashText(text)) throw new Error('idempotency_conflict');
        app.log.info({ event: 'chat_request_duplicate', deviceId: device.id, requestId: existing.requestId }, 'chat_request_duplicate');
        sessions.sendTransient(device.id, 'chat.accepted', { requestId: existing.requestId, duplicate: true });
        return existing.requestId;
      }
    }

    if (!limiter.allow(`chat:${device.id}`, 30, 60_000)) throw new Error('rate_limited');
    const requestId = storage.createRequest(device.id, text, clientMessageId);
    app.log.info({ event: 'chat_request_received', deviceId: device.id, requestId, textLength: text.length }, 'chat_request_received');
    try {
      app.log.info({ event: 'poke_api_request', deviceId: device.id, requestId }, 'poke_api_request');
      await poke.sendDeviceMessage({ deviceId: device.id, requestId, text });
      storage.markRequestAccepted(requestId);
      app.log.info({ event: 'poke_api_accepted', deviceId: device.id, requestId }, 'poke_api_accepted');
      sessions.sendTransient(device.id, 'chat.accepted', { requestId });
      const timeout = setTimeout(() => {
        replyTimeouts.delete(timeout);
        if (storage.expireAcceptedRequest(requestId)) {
          app.log.warn({ event: 'request_reply_timeout', deviceId: device.id, requestId }, 'request_reply_timeout');
          sessions.sendTransient(device.id, 'error', { requestId, code: 'POKE_REPLY_TIMEOUT', message: 'Poke accepted the request but did not return a device reply in time.' });
        }
      }, config.POKE_REPLY_TIMEOUT_MS);
      timeout.unref();
      replyTimeouts.add(timeout);
      return requestId;
    } catch (error) {
      const message = error instanceof Error ? error.message : 'unknown_error';
      storage.markRequestError(requestId, message);
      app.log.warn({ event: 'poke_api_failed', deviceId: device.id, requestId }, 'poke_api_failed');
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
    app.log.info({ event: 'message_acknowledged', deviceId: device.id, messageId, transport: 'http' }, 'message_acknowledged');
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
    const queryToken = config.ALLOW_WS_QUERY_TOKEN && typeof query.token === 'string' && query.token.length <= 256 ? query.token : null;
    const token = headerToken ?? queryToken;
    const device = token ? storage.authenticateDevice(token) : null;
    if (!device) {
      app.log.warn({ event: 'device_ws_auth_failed', ip: request.ip }, 'device_ws_auth_failed');
      socket.close(1008, 'unauthorized');
      return;
    }
    sessions.attach(device.id, socket);
    app.log.info({ event: 'device_connected', deviceId: device.id }, 'device_connected');
    socket.on('close', (code: number) => app.log.info({ event: 'device_disconnected', deviceId: device.id, code }, 'device_disconnected'));
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
          if (!storage.acknowledge(device.id, payload.messageId)) {
            sessions.sendTransient(device.id, 'error', { code: 'MESSAGE_NOT_FOUND', message: 'Unknown message ID for this device.', messageId: payload.messageId });
          } else {
            app.log.info({ event: 'message_acknowledged', deviceId: device.id, messageId: payload.messageId, transport: 'websocket' }, 'message_acknowledged');
          }
        } else if (envelope.type === 'device.status') {
          const payload = deviceStatusSchema.parse(envelope.payload);
          storage.updateStatus(device.id, payload);
          storage.touchDevice(device.id);
        } else if (envelope.type === 'ping') {
          sessions.sendTransient(device.id, 'pong', { clientMessageId: envelope.id });
        }
      } catch {
        app.log.warn({ event: 'device_protocol_error', deviceId: device.id }, 'device_protocol_error');
        sessions.sendTransient(device.id, 'error', { code: 'PROTOCOL_ERROR', message: 'Invalid WebSocket message.' });
      }
    });
  });

  app.all('/mcp', async (request, reply) => {
    if (config.NODE_ENV === 'production' && request.hostname !== expectedPublicHost) {
      app.log.warn({ event: 'mcp_host_rejected', host: request.hostname }, 'mcp_host_rejected');
      return reply.code(403).send({ error: 'invalid_host' });
    }
    const origin = request.headers.origin;
    if (origin) {
      try {
        if (new URL(origin).hostname !== expectedPublicHost) {
          app.log.warn({ event: 'mcp_origin_rejected' }, 'mcp_origin_rejected');
          return reply.code(403).send({ error: 'invalid_origin' });
        }
      } catch {
        app.log.warn({ event: 'mcp_origin_rejected' }, 'mcp_origin_rejected');
        return reply.code(403).send({ error: 'invalid_origin' });
      }
    }
    const token = bearer(request.headers.authorization);
    if (!token || !constantTimeEqual(token, config.MCP_SHARED_SECRET)) {
      app.log.warn({ event: 'mcp_auth_failed', ip: request.ip }, 'mcp_auth_failed');
      return reply.code(401).send({ error: 'unauthorized' });
    }
    const pokeUserId = request.headers['x-poke-user-id'];
    if (allowlist.size > 0 && (typeof pokeUserId !== 'string' || !allowlist.has(pokeUserId))) {
      app.log.warn({ event: 'mcp_user_rejected', pokeUserId: typeof pokeUserId === 'string' ? pokeUserId : undefined }, 'mcp_user_rejected');
      return reply.code(403).send({ error: 'poke_user_not_allowed' });
    }
    if (!limiter.allow(`mcp:${typeof pokeUserId === 'string' ? pokeUserId : 'unknown'}`, 120, 60_000)) {
      app.log.warn({ event: 'mcp_rate_limited', pokeUserId: typeof pokeUserId === 'string' ? pokeUserId : undefined }, 'mcp_rate_limited');
      return reply.code(429).send({ error: 'rate_limited' });
    }
    app.log.info({ event: 'mcp_request', pokeUserId: typeof pokeUserId === 'string' ? pokeUserId : undefined, method: mcpMethod(request.body) }, 'mcp_request');
    reply.hijack();
    await mcpNode(request.raw, reply.raw, request.body);
  });

  return app;
}
