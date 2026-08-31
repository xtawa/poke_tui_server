import WebSocket from 'ws';
import type { Config } from './config.js';
import type { Storage, OutboundMessage } from './storage.js';
import { ids } from './crypto.js';
import type { ServerEnvelope } from './protocol.js';

interface Session {
  socket: WebSocket;
  alive: boolean;
}

export class SessionManager {
  private readonly sessions = new Map<string, Session>();
  private heartbeatTimer: NodeJS.Timeout | null = null;

  constructor(private readonly storage: Storage, private readonly config: Config) {}

  start(): void {
    if (this.heartbeatTimer) return;
    this.heartbeatTimer = setInterval(() => {
      for (const [deviceId, session] of this.sessions) {
        if (!session.alive) {
          session.socket.terminate();
          this.sessions.delete(deviceId);
          continue;
        }
        session.alive = false;
        try { session.socket.ping(); } catch { session.socket.terminate(); }
      }
    }, this.config.WS_HEARTBEAT_INTERVAL);
    this.heartbeatTimer.unref();
  }

  stop(): void {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = null;
    for (const session of this.sessions.values()) session.socket.close(1001, 'server shutdown');
    this.sessions.clear();
  }

  count(): number { return this.sessions.size; }

  disconnect(deviceId: string, code = 4003, reason = 'device revoked'): void {
    const session = this.sessions.get(deviceId);
    if (!session) return;
    this.sessions.delete(deviceId);
    session.socket.close(code, reason);
  }

  attach(deviceId: string, socket: WebSocket): void {
    const previous = this.sessions.get(deviceId);
    if (previous && previous.socket !== socket) previous.socket.close(4001, 'session replaced');
    const session: Session = { socket, alive: true };
    this.sessions.set(deviceId, session);
    this.storage.touchDevice(deviceId);

    socket.on('pong', () => { session.alive = true; this.storage.touchDevice(deviceId); });
    socket.on('close', () => {
      if (this.sessions.get(deviceId)?.socket === socket) this.sessions.delete(deviceId);
    });

    this.sendEnvelope(socket, {
      id: ids.message(),
      type: 'hello',
      timestamp: Date.now(),
      payload: { deviceId, serverVersion: '0.1.0', heartbeatInterval: this.config.WS_HEARTBEAT_INTERVAL }
    });
    this.flushPending(deviceId);
  }

  isOnline(deviceId: string): boolean {
    const socket = this.sessions.get(deviceId)?.socket;
    return !!socket && socket.readyState === WebSocket.OPEN;
  }

  deliver(outbound: OutboundMessage): boolean {
    const session = this.sessions.get(outbound.deviceId);
    if (!session || session.socket.readyState !== WebSocket.OPEN) return false;
    const envelope: ServerEnvelope = {
      id: outbound.id,
      type: outbound.type as ServerEnvelope['type'],
      timestamp: outbound.createdAt,
      payload: JSON.parse(outbound.payload)
    };
    this.sendEnvelope(session.socket, envelope);
    this.storage.markSent(outbound.id);
    return true;
  }

  flushPending(deviceId: string): void {
    for (const message of this.storage.pendingOutbound(deviceId)) this.deliver(message);
  }

  sendTransient(deviceId: string, type: ServerEnvelope['type'], payload: unknown): boolean {
    const session = this.sessions.get(deviceId);
    if (!session || session.socket.readyState !== WebSocket.OPEN) return false;
    this.sendEnvelope(session.socket, { id: ids.message(), type, timestamp: Date.now(), payload });
    return true;
  }

  private sendEnvelope(socket: WebSocket, envelope: ServerEnvelope): void {
    if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(envelope));
  }
}
