// 设备配对的事件和派生视图（ergo.db）。
// - 配对请求和设备凭证的哈希在守护进程内部的频道 `pairing` 上：它不在前端协议的频道里，前端订阅不了，
//   哈希不会推给任何前端；
// - 已配对设备本身（名字、配对和最近使用的时间、有没有吊销）在前端频道 `devices` 上，设置页订阅它。
// 视图：配对请求（按配对 cookie 的哈希找、按来源数最近的请求）、已配对设备（按凭证的哈希找）、吊销请求的幂等键。
// 123 号票：删了的设备记录还在（设备 JSON 里有 deletedAt，凭证的哈希也留着，好认出"这个凭证属于一台被删掉的设备"），
// 只是列表里不出现。
import { CHANNELS, type DeviceEventPayload, EVENT_TYPES, type PairedDevice } from "@ergo/protocol";
import type { DerivedView, NewEvent } from "../events/event-store.ts";
import type { ReadonlyDatabase } from "../storage/sqlite.ts";

/** 守护进程内部的频道：配对请求、设备凭证的哈希。不是前端协议的频道 */
export const PAIRING_CHANNEL = "pairing";

export const PAIRING_EVENT_TYPES = {
  /** 一个配对请求的最新状态 */
  request: "pairing_request",
  /** 一台设备领到了凭证：只记哈希 */
  credential: "device_credential",
} as const;

/** 配对请求在服务端的样子（新设备看到的是 PairingRequestView） */
export interface PairingRequestRecord {
  id: string;
  /** 配对 cookie 的 sha256 */
  secretHash: string;
  deviceName: string;
  shortCode: string;
  fingerprint: string;
  /** 来源 IP：经隧道的是 nginx 覆盖写的 X-Real-IP，限频按它算 */
  source: string;
  /** 给人看的来源："经隧道 · 203.0.113.24" */
  from: string;
  userAgent: string;
  cardId: string;
  createdAt: string;
  /** 待批的请求什么时候过期 */
  expiresAt: string;
  /** 待批、已批准（等新设备来领凭证）、凭证已领走、被拒绝、已过期 */
  status: "pending" | "approved" | "claimed" | "denied" | "expired";
  approvedAt?: string;
  /** 批准之后最晚什么时候来领 */
  claimBefore?: string;
  /** 领走凭证的那台设备 */
  deviceId?: string;
  /** 浏览器标识看起来像网络上的自动访问（137 号票）：原因；像普通浏览器的没有 */
  automated?: { reason: string };
}

export interface PairingRequestEventPayload {
  request: PairingRequestRecord;
}

export interface DeviceCredentialEventPayload {
  deviceId: string;
  /** 设备凭证的 sha256；原值不落盘 */
  credentialHash: string;
}

export function requestEvent(request: PairingRequestRecord): NewEvent {
  const payload: PairingRequestEventPayload = { request };
  return { channel: PAIRING_CHANNEL, type: PAIRING_EVENT_TYPES.request, payload };
}

export function credentialEvent(deviceId: string, credentialHash: string): NewEvent {
  const payload: DeviceCredentialEventPayload = { deviceId, credentialHash };
  return { channel: PAIRING_CHANNEL, type: PAIRING_EVENT_TYPES.credential, payload };
}

export function deviceEvent(device: PairedDevice, change: DeviceEventPayload["change"], idempotencyKey?: string): NewEvent {
  const payload: DeviceEventPayload = { device, change };
  return { channel: CHANNELS.devices, type: EVENT_TYPES.device, payload, ...(idempotencyKey === undefined ? {} : { idempotencyKey }) };
}

export const pairingView: DerivedView = {
  name: "pairing",
  create: (db) =>
    db.exec(`
      CREATE TABLE IF NOT EXISTS pairing_requests (
        request_id TEXT PRIMARY KEY,
        secret_hash TEXT NOT NULL UNIQUE,
        source TEXT NOT NULL,
        created_ms INTEGER NOT NULL,
        status TEXT NOT NULL,
        request TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS pairing_requests_by_source ON pairing_requests (source, created_ms);
      CREATE TABLE IF NOT EXISTS paired_devices (
        device_id TEXT PRIMARY KEY,
        credential_hash TEXT UNIQUE,
        device TEXT
      );
      CREATE TABLE IF NOT EXISTS device_revoke_keys (
        idempotency_key TEXT PRIMARY KEY,
        device_id TEXT NOT NULL
      );
    `),
  clear: (db) => db.exec("DELETE FROM pairing_requests; DELETE FROM paired_devices; DELETE FROM device_revoke_keys;"),
  apply(db, event) {
    if (event.channel === PAIRING_CHANNEL && event.type === PAIRING_EVENT_TYPES.request) {
      const { request } = event.payload as PairingRequestEventPayload;
      db.run(
        `INSERT INTO pairing_requests (request_id, secret_hash, source, created_ms, status, request) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT (request_id) DO UPDATE SET status = excluded.status, request = excluded.request`,
        request.id,
        request.secretHash,
        request.source,
        Date.parse(request.createdAt),
        request.status,
        JSON.stringify(request),
      );
    } else if (event.channel === PAIRING_CHANNEL && event.type === PAIRING_EVENT_TYPES.credential) {
      const { deviceId, credentialHash } = event.payload as DeviceCredentialEventPayload;
      db.run(
        "INSERT INTO paired_devices (device_id, credential_hash) VALUES (?, ?) ON CONFLICT (device_id) DO UPDATE SET credential_hash = excluded.credential_hash",
        deviceId,
        credentialHash,
      );
    } else if (event.channel === CHANNELS.devices && event.type === EVENT_TYPES.device) {
      const { device, change } = event.payload as DeviceEventPayload;
      db.run("INSERT INTO paired_devices (device_id, device) VALUES (?, ?) ON CONFLICT (device_id) DO UPDATE SET device = excluded.device", device.id, JSON.stringify(device));
      if (change === "revoked" && event.idempotencyKey !== null) {
        db.run("INSERT OR IGNORE INTO device_revoke_keys (idempotency_key, device_id) VALUES (?, ?)", event.idempotencyKey, device.id);
      }
    }
  },
};

export function getRequest(db: ReadonlyDatabase, requestId: string): PairingRequestRecord | undefined {
  const row = db.get<{ request: string }>("SELECT request FROM pairing_requests WHERE request_id = ?", requestId);
  return row && (JSON.parse(row.request) as PairingRequestRecord);
}

export function requestBySecretHash(db: ReadonlyDatabase, secretHash: string): PairingRequestRecord | undefined {
  const row = db.get<{ request: string }>("SELECT request FROM pairing_requests WHERE secret_hash = ?", secretHash);
  return row && (JSON.parse(row.request) as PairingRequestRecord);
}

/** 某个来源从某一刻（毫秒）起发过几个配对请求 */
export function countRequestsSince(db: ReadonlyDatabase, source: string, sinceMs: number): number {
  const row = db.get<{ n: number }>("SELECT COUNT(*) AS n FROM pairing_requests WHERE source = ? AND created_ms > ?", source, sinceMs);
  return Number(row?.n ?? 0);
}

/** 还要计时的请求：待批的（到点过期）、已批准还没领的（到点作废） */
export function openRequests(db: ReadonlyDatabase): PairingRequestRecord[] {
  return db.all<{ request: string }>("SELECT request FROM pairing_requests WHERE status IN ('pending', 'approved')").map((r) => JSON.parse(r.request) as PairingRequestRecord);
}

export function getDevice(db: ReadonlyDatabase, deviceId: string): PairedDevice | undefined {
  const row = db.get<{ device: string | null }>("SELECT device FROM paired_devices WHERE device_id = ?", deviceId);
  return row?.device ? (JSON.parse(row.device) as PairedDevice) : undefined;
}

export function deviceByCredentialHash(db: ReadonlyDatabase, credentialHash: string): PairedDevice | undefined {
  const row = db.get<{ device: string | null }>("SELECT device FROM paired_devices WHERE credential_hash = ?", credentialHash);
  return row?.device ? (JSON.parse(row.device) as PairedDevice) : undefined;
}

/** 已配对设备，删了的不算 */
export function listDevices(db: ReadonlyDatabase): PairedDevice[] {
  return db
    .all<{ device: string | null }>("SELECT device FROM paired_devices WHERE device IS NOT NULL ORDER BY rowid")
    .map((r) => JSON.parse(r.device!) as PairedDevice)
    .filter((d) => d.deletedAt === undefined);
}

/** 用某个幂等键吊销的是哪台设备（这个键还没用过是 undefined） */
export function revokedByKey(db: ReadonlyDatabase, idempotencyKey: string): string | undefined {
  return db.get<{ device_id: string }>("SELECT device_id FROM device_revoke_keys WHERE idempotency_key = ?", idempotencyKey)?.device_id;
}
