import DatabaseDriver from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { hashText, hashToken, ids } from './crypto.js';
import type { Config } from './config.js';

export type Device = { id: string; name: string; createdAt: number; lastSeenAt: number | null; revokedAt: number | null };
export type DeviceStatus = { online?: boolean; battery: number | null; charging: boolean | null; screenOn: boolean | null; wifiRssi: number | null; appVersion: string | null; androidVersion: string | null; updatedAt: number | null };
export type OutboundMessage = { id: string; deviceId: string; requestId: string | null; type: string; payload: string; createdAt: number; sentAt: number | null; acknowledgedAt: number | null };

export class Storage {
  private readonly db: DatabaseDriver.Database;
  constructor(private readonly config: Config) {
    mkdirSync(dirname(config.DATABASE_PATH), { recursive: true });
    this.db = new DatabaseDriver(config.DATABASE_PATH);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
    this.db.pragma('busy_timeout = 5000');
    this.migrate();
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS devices (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        token_hash TEXT NOT NULL UNIQUE,
        client_device_id TEXT,
        created_at INTEGER NOT NULL,
        last_seen_at INTEGER,
        revoked_at INTEGER
      );
      CREATE TABLE IF NOT EXISTS requests (
        id TEXT PRIMARY KEY,
        device_id TEXT NOT NULL REFERENCES devices(id),
        user_text TEXT,
        user_text_hash TEXT NOT NULL,
        user_text_length INTEGER NOT NULL,
        status TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        poke_accepted_at INTEGER,
        completed_at INTEGER,
        error TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_requests_device_created ON requests(device_id, created_at DESC);
      CREATE TABLE IF NOT EXISTS outbound_messages (
        id TEXT PRIMARY KEY,
        device_id TEXT NOT NULL REFERENCES devices(id),
        request_id TEXT REFERENCES requests(id),
        type TEXT NOT NULL,
        payload TEXT NOT NULL,
        payload_hash TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        sent_at INTEGER,
        acknowledged_at INTEGER,
        UNIQUE(device_id, request_id, type, payload_hash)
      );
      CREATE INDEX IF NOT EXISTS idx_outbound_pending ON outbound_messages(device_id, acknowledged_at, created_at);
      CREATE TABLE IF NOT EXISTS device_status (
        device_id TEXT PRIMARY KEY REFERENCES devices(id),
        battery INTEGER,
        charging INTEGER,
        screen_on INTEGER,
        wifi_rssi INTEGER,
        app_version TEXT,
        android_version TEXT,
        updated_at INTEGER NOT NULL
      );
    `);
  }

  ping(): boolean {
    const row = this.db.prepare('SELECT 1 AS ok').get() as { ok: number } | undefined;
    return row?.ok === 1;
  }

  enrollDevice(name: string, token: string, clientDeviceId?: string): Device {
    const id = ids.device();
    const now = Date.now();
    this.db.prepare('INSERT INTO devices(id,name,token_hash,client_device_id,created_at) VALUES(?,?,?,?,?)')
      .run(id, name, hashToken(token), clientDeviceId ?? null, now);
    return { id, name, createdAt: now, lastSeenAt: null, revokedAt: null };
  }

  authenticateDevice(token: string): Device | null {
    const row = this.db.prepare('SELECT id,name,created_at,last_seen_at,revoked_at FROM devices WHERE token_hash=? AND revoked_at IS NULL')
      .get(hashToken(token)) as any;
    return row ? { id: row.id, name: row.name, createdAt: row.created_at, lastSeenAt: row.last_seen_at, revokedAt: row.revoked_at } : null;
  }

  getDevice(id: string): Device | null {
    const row = this.db.prepare('SELECT id,name,created_at,last_seen_at,revoked_at FROM devices WHERE id=?').get(id) as any;
    return row ? { id: row.id, name: row.name, createdAt: row.created_at, lastSeenAt: row.last_seen_at, revokedAt: row.revoked_at } : null;
  }

  touchDevice(id: string): void { this.db.prepare('UPDATE devices SET last_seen_at=? WHERE id=?').run(Date.now(), id); }
  revokeDevice(id: string): void { this.db.prepare('UPDATE devices SET revoked_at=? WHERE id=?').run(Date.now(), id); }

  createRequest(deviceId: string, text: string): string {
    const id = ids.request();
    this.db.prepare(`INSERT INTO requests(id,device_id,user_text,user_text_hash,user_text_length,status,created_at) VALUES(?,?,?,?,?,?,?)`)
      .run(id, deviceId, this.config.STORE_MESSAGE_CONTENT ? text : null, hashText(text), text.length, 'pending', Date.now());
    return id;
  }

  requestBelongsTo(requestId: string, deviceId: string): boolean {
    return !!this.db.prepare('SELECT 1 FROM requests WHERE id=? AND device_id=?').get(requestId, deviceId);
  }

  markRequestAccepted(id: string): void { this.db.prepare("UPDATE requests SET status='accepted', poke_accepted_at=? WHERE id=?").run(Date.now(), id); }
  markRequestCompleted(id: string): void { this.db.prepare("UPDATE requests SET status='completed', completed_at=? WHERE id=?").run(Date.now(), id); }
  markRequestError(id: string, error: string): void { this.db.prepare("UPDATE requests SET status='error', error=? WHERE id=?").run(error.slice(0, 1000), id); }
  expireAcceptedRequest(id: string): boolean {
    const result = this.db.prepare("UPDATE requests SET status='reply_timeout', error='Poke reply timeout' WHERE id=? AND status='accepted'").run(id);
    return result.changes > 0;
  }

  queueOutbound(deviceId: string, requestId: string | null, type: string, payload: unknown): OutboundMessage {
    const payloadText = JSON.stringify(payload);
    const payloadHash = hashText(payloadText);
    const existing = this.db.prepare('SELECT * FROM outbound_messages WHERE device_id=? AND request_id IS ? AND type=? AND payload_hash=?')
      .get(deviceId, requestId, type, payloadHash) as any;
    if (existing) return this.mapOutbound(existing);

    const pending = this.db.prepare('SELECT COUNT(*) AS count FROM outbound_messages WHERE device_id=? AND acknowledged_at IS NULL')
      .get(deviceId) as { count: number };
    if (pending.count >= this.config.DEVICE_OFFLINE_QUEUE_LIMIT) throw new Error('device_outbound_queue_full');

    const id = ids.message();
    const createdAt = Date.now();
    this.db.prepare('INSERT INTO outbound_messages(id,device_id,request_id,type,payload,payload_hash,created_at) VALUES(?,?,?,?,?,?,?)')
      .run(id, deviceId, requestId, type, payloadText, payloadHash, createdAt);
    return { id, deviceId, requestId, type, payload: payloadText, createdAt, sentAt: null, acknowledgedAt: null };
  }

  pendingOutbound(deviceId: string, limit = this.config.DEVICE_OFFLINE_QUEUE_LIMIT): OutboundMessage[] {
    return (this.db.prepare('SELECT * FROM outbound_messages WHERE device_id=? AND acknowledged_at IS NULL ORDER BY created_at ASC LIMIT ?')
      .all(deviceId, limit) as any[]).map(row => this.mapOutbound(row));
  }

  markSent(id: string): void { this.db.prepare('UPDATE outbound_messages SET sent_at=? WHERE id=?').run(Date.now(), id); }
  acknowledge(deviceId: string, id: string): boolean {
    const result = this.db.prepare('UPDATE outbound_messages SET acknowledged_at=? WHERE id=? AND device_id=? AND acknowledged_at IS NULL').run(Date.now(), id, deviceId);
    return result.changes > 0;
  }

  updateStatus(deviceId: string, status: Record<string, unknown>): void {
    this.db.prepare(`INSERT INTO device_status(device_id,battery,charging,screen_on,wifi_rssi,app_version,android_version,updated_at)
      VALUES(@deviceId,@battery,@charging,@screenOn,@wifiRssi,@appVersion,@androidVersion,@updatedAt)
      ON CONFLICT(device_id) DO UPDATE SET
        battery=COALESCE(excluded.battery,device_status.battery),
        charging=COALESCE(excluded.charging,device_status.charging),
        screen_on=COALESCE(excluded.screen_on,device_status.screen_on),
        wifi_rssi=COALESCE(excluded.wifi_rssi,device_status.wifi_rssi),
        app_version=COALESCE(excluded.app_version,device_status.app_version),
        android_version=COALESCE(excluded.android_version,device_status.android_version),
        updated_at=excluded.updated_at`)
      .run({ deviceId, battery: status.battery ?? null, charging: status.charging == null ? null : Number(status.charging), screenOn: status.screenOn == null ? null : Number(status.screenOn), wifiRssi: status.wifiRssi ?? null, appVersion: status.appVersion ?? null, androidVersion: status.androidVersion ?? null, updatedAt: Date.now() });
  }

  getStatus(deviceId: string): DeviceStatus {
    const row = this.db.prepare('SELECT * FROM device_status WHERE device_id=?').get(deviceId) as any;
    if (!row) return { battery: null, charging: null, screenOn: null, wifiRssi: null, appVersion: null, androidVersion: null, updatedAt: null };
    return { battery: row.battery, charging: row.charging == null ? null : !!row.charging, screenOn: row.screen_on == null ? null : !!row.screen_on, wifiRssi: row.wifi_rssi, appVersion: row.app_version, androidVersion: row.android_version, updatedAt: row.updated_at };
  }

  close(): void { this.db.close(); }
  private mapOutbound(row: any): OutboundMessage { return { id: row.id, deviceId: row.device_id, requestId: row.request_id, type: row.type, payload: row.payload, createdAt: row.created_at, sentAt: row.sent_at, acknowledgedAt: row.acknowledged_at }; }
}
