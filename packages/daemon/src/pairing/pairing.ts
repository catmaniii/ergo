// 设备配对（规格第 2、6 节、第 21 节）：配对请求、批准、发凭证、吊销、校验凭证。
//
// 一次配对：
// 1. 新设备在外网端口上发起请求（createRequest）：拿到设备名（默认由 User-Agent 生成）、6 位短码、8 位十六进制短指纹，
//    和一个认出这个请求的配对 cookie；同时卡片频道上多一张配对请求卡、待我处理里多一项（页面内提示）。
//    同一来源 10 分钟内最多 5 个请求（经隧道的以 nginx 覆盖写的 X-Real-IP 为来源）；
// 2. 新设备上改设备名（rename）：卡片跟着改（版本加 1），所以用户批准的一定是他看到的那个名字；
// 3. 用户在本机或已配对的设备上核对后批准（卡片的按钮闭环：按版本条件更新、先到先得）。批准不产生素材：
//    这张卡不是审批卡，"批准"只是请求的状态变化；
// 4. 新设备下一次来问（claim）时领到设备凭证：256 位随机值放进 HttpOnly cookie，服务端只存哈希。
//    这时设备记录是"等待首次使用"：领取的响应可能丢了（凭证到不了设备手里），所以第一次带着凭证来才算启用，
//    24 小时（DEVICE_FIRST_USE_WINDOW_MS）里一次也没来就自动作废；
// 5. 待批的请求 5 分钟后过期（卡片变成已过期，不能再处理）；批准后 5 分钟内没来领也作废。
// 时长都取共享协议包里的常量，上面写的数字只是说明。
//
// 凭证从最近一次使用起 365 天有效，每次使用都续期（使用记录最多一小时落一次，免得每个请求都写一条事件：
// 续期因此最多提前一小时失效，不会推迟）；吊销后立即失效，网关关掉这台设备开着的 WebSocket（onRevoked）。
import { randomUUID } from "node:crypto";
import net from "node:net";
import {
  type CredentialRejection,
  DEVICE_CREDENTIAL_TTL_MS,
  DEVICE_FIRST_USE_WINDOW_MS,
  defaultDeviceName,
  durationText,
  normalizeDeviceName,
  nowIso,
  PAIRING_CLAIM_WINDOW_MS,
  PAIRING_RATE_LIMIT,
  PAIRING_RATE_WINDOW_MS,
  PAIRING_REQUEST_TTL_MS,
  type PairedDevice,
  type PairingCardPayload,
  type PairingRequestView,
  pairingRequestTitle,
  type RevokeDeviceResult,
} from "@ergou/protocol";
import type { CardActionEffect } from "../cards/registry.ts";
import type { CardService } from "../cards/cards.ts";
import { RequestRejected } from "../errors.ts";
import type { EventStore, NewEvent } from "../events/event-store.ts";
import type { InboxService } from "../inbox/inbox.ts";
import type { Clock } from "../scheduler/clock.ts";
import type { Scheduler } from "../scheduler/scheduler.ts";
import { fingerprintOf, hashSecret, isSecretShaped, newSecret, newShortCode } from "./credentials.ts";
import {
  countRequestsSince,
  credentialEvent,
  deviceByCredentialHash,
  deviceEvent,
  getDevice,
  getRequest,
  listDevices,
  openRequests,
  PAIRING_CHANNEL,
  PAIRING_EVENT_TYPES,
  type PairingRequestEventPayload,
  type PairingRequestRecord,
  requestBySecretHash,
  requestEvent,
  revokedByKey,
} from "./views.ts";

/** 使用记录最多隔这么久落一次（续期因此最多提前这么多失效，偏保守） */
export const DEVICE_USE_RECORD_INTERVAL_MS = 3600_000;

/** 待我处理里配对请求的来源 */
const INBOX_SOURCE = "设备配对";

/** 来源是本机地址：请求经 VPS 上的前门（按 SNI 分流的 stream 转发）过来，nginx 只看得到 127.0.0.1，认不出真实来源 */
export const UNIDENTIFIED_SOURCE_LABEL = "经前门转发，无法识别";

/** 拒绝的说法（几处共用） */
const REJECT = {
  badName: "设备名不能为空，也不能太长",
  noRequest: "没有这个配对请求",
  handled: "已被处理",
} as const;

export interface NewPairingRequest {
  /** 新设备上填的设备名；不给就按 User-Agent 生成 */
  deviceName?: string;
  userAgent: string;
  /** 来源 IP（限频用） */
  source: string;
  /** 经隧道来的（来源取自 X-Real-IP） */
  viaTunnel: boolean;
}

export interface PairingService {
  /** 新设备发起配对请求；返回新设备看到的请求，和配对 cookie 的原值（只放进这一个响应） */
  createRequest(input: NewPairingRequest): { request: PairingRequestView; secret: string };
  /**
   * 新设备来问自己这个请求的状态（配对 cookie 认出是哪个请求，认不出是 undefined）。
   * 已批准、还在领取期限内：这一次就发凭证（credential 是原值，只放进这一个响应），请求变成已配对
   */
  claim(secret: string | undefined): { request: PairingRequestView; credential?: string; device?: PairedDevice } | undefined;
  /** 新设备上改设备名（只在待批时能改）；配对请求卡跟着改 */
  rename(secret: string | undefined, deviceName: string): PairingRequestView;
  /** 外网端口上的请求带来的凭证：有效（没吊销、没过期）就算这台设备用了一次（第一次是启用，之后是续期），返回设备 */
  authenticate(credential: string | undefined): PairedDevice | undefined;
  /** 不认的凭证是怎么回事（认得出是哪台设备时）；没带、乱写的是 undefined */
  rejectionOf(credential: string | undefined): CredentialRejection | undefined;
  /** 开着的 WebSocket 心跳时复查：还有效就算用了一次（续期） */
  refresh(deviceId: string): boolean;
  /** 吊销（来自前端的请求，带幂等键） */
  revoke(deviceId: string, idempotencyKey: string): RevokeDeviceResult;
  list(): PairedDevice[];
  /** 订阅"某台设备被吊销了"；返回取消订阅的函数 */
  onRevoked(listener: (deviceId: string) => void): () => void;
  /** 配对请求卡上的按钮（卡片类型注册表调用） */
  approveFromCard(payload: PairingCardPayload, now: string): CardActionEffect<PairingCardPayload>;
  denyFromCard(payload: PairingCardPayload): CardActionEffect<PairingCardPayload>;
  /** 把还要计时的请求登记进调度器（守护进程启动时），之后跟着每条请求事件重新登记 */
  start(): void;
  stop(): void;
}

export interface PairingServiceOptions {
  store: EventStore;
  cards: CardService;
  inbox: InboxService;
  scheduler: Scheduler;
  clock: Clock;
}

const ms = (iso: string) => Date.parse(iso);
const iso = (t: number) => nowIso(new Date(t));
const timerKey = (requestId: string) => `pairing:${requestId}`;

/** 请求的截止时间（毫秒）：待批的到这时过期，已批准的到这时还没来领就作废 */
function deadlineOf(r: PairingRequestRecord): number {
  return r.status === "approved" ? ms(r.claimBefore ?? r.expiresAt) : ms(r.expiresAt);
}

/** 卡片和设备列表上给人看的来源 */
function sourceLabel(source: string, viaTunnel: boolean): string {
  if (isLoopback(source)) return UNIDENTIFIED_SOURCE_LABEL;
  return `${viaTunnel ? "经隧道" : "外网端口"} · ${source}`;
}

function isLoopback(address: string): boolean {
  const a = address.replace(/^::ffff:/i, "");
  return a === "::1" || (net.isIPv4(a) && a.startsWith("127."));
}

/** 设备现在还有效吗：没吊销、还没到期（启用之后是最近一次使用后 365 天，还没启用是领到凭证后 24 小时） */
function isValid(d: PairedDevice, now: number): boolean {
  return !d.revoked && now < ms(d.expiresAt);
}

export function createPairingService(options: PairingServiceOptions): PairingService {
  const { store, cards, inbox, scheduler, clock } = options;
  const revokedListeners = new Set<(deviceId: string) => void>();
  let unsubscribe: (() => void) | undefined;

  /** 新设备看到的状态：过了截止时间的按已过期算（计时器还没来得及落事件也一样） */
  const viewOf = (r: PairingRequestRecord): PairingRequestView => {
    const late = (r.status === "pending" || r.status === "approved") && clock.now() >= deadlineOf(r);
    const status = r.status === "claimed" ? "paired" : late ? "expired" : r.status;
    return { id: r.id, status, deviceName: r.deviceName, shortCode: r.shortCode, fingerprint: r.fingerprint, expiresAt: r.expiresAt };
  };

  const bySecret = (secret: string | undefined): PairingRequestRecord | undefined =>
    secret !== undefined && isSecretShaped(secret) ? requestBySecretHash(store.reader, hashSecret(secret)) : undefined;

  const byCredential = (credential: string | undefined): PairedDevice | undefined =>
    credential !== undefined && isSecretShaped(credential) ? deviceByCredentialHash(store.reader, hashSecret(credential)) : undefined;

  /** 到了截止时间：待批的过期（卡片跟着过期），已批准没来领的作废 */
  const expire = (requestId: string) => {
    const r = getRequest(store.reader, requestId);
    if (!r || (r.status !== "pending" && r.status !== "approved") || clock.now() < deadlineOf(r)) return;
    const events: NewEvent[] = [requestEvent({ ...r, status: "expired" })];
    if (r.status === "pending" && cards.get(r.cardId)?.status === "pending") events.push(cards.buildUpdate(r.cardId, { status: "expired" }).event);
    store.appendBatch(events);
  };

  const scheduleTimer = (r: PairingRequestRecord) => {
    if (r.status === "pending" || r.status === "approved") scheduler.schedule(timerKey(r.id), deadlineOf(r), () => expire(r.id));
    else scheduler.cancel(timerKey(r.id));
  };

  /**
   * 用了一次。第一次带着凭证来就是启用（马上落一条，有效期从这时起算 365 天）；
   * 之后离上一次记录超过一小时才落一条（续期）
   */
  const touch = (d: PairedDevice): PairedDevice => {
    const now = clock.now();
    if (d.activated && now - ms(d.lastUsedAt) < DEVICE_USE_RECORD_INTERVAL_MS) return d;
    const next: PairedDevice = { ...d, activated: true, lastUsedAt: iso(now), expiresAt: iso(now + DEVICE_CREDENTIAL_TTL_MS) };
    store.append(deviceEvent(next, d.activated ? "used" : "activated"));
    return next;
  };

  const pendingRequest = (payload: PairingCardPayload): PairingRequestRecord => {
    const r = getRequest(store.reader, payload.requestId);
    if (!r) throw new RequestRejected("not_found", REJECT.noRequest);
    if (r.status !== "pending") throw new RequestRejected("conflict", REJECT.handled);
    return r;
  };

  return {
    createRequest(input) {
      const now = clock.now();
      if (countRequestsSince(store.reader, input.source, now - PAIRING_RATE_WINDOW_MS) >= PAIRING_RATE_LIMIT) {
        throw new RequestRejected("rate_limited", `同一来源 ${durationText(PAIRING_RATE_WINDOW_MS)}内最多 ${PAIRING_RATE_LIMIT} 个配对请求，请过一会儿再试`);
      }
      const deviceName = normalizeDeviceName(input.deviceName ?? defaultDeviceName(input.userAgent));
      if (deviceName === undefined) throw new RequestRejected("bad_params", REJECT.badName);
      const secret = newSecret();
      const requestId = `pr-${randomUUID()}`;
      const shortCode = newShortCode();
      const fingerprint = fingerprintOf(secret);
      const from = sourceLabel(input.source, input.viaTunnel);
      const expiresAt = iso(now + PAIRING_REQUEST_TTL_MS);
      const payload: PairingCardPayload = { requestId, deviceName, shortCode, fingerprint, from, expiresAt };
      const card = cards.buildCreate({ type: "pairing", payload, urgency: "non_blocking" });
      const record: PairingRequestRecord = {
        id: requestId,
        secretHash: hashSecret(secret),
        deviceName,
        shortCode,
        fingerprint,
        source: input.source,
        from,
        userAgent: input.userAgent,
        cardId: card.card.id,
        createdAt: iso(now),
        expiresAt,
        status: "pending",
      };
      const item = inbox.buildAdd({ kind: "card", cardId: card.card.id, title: pairingRequestTitle(deviceName), source: INBOX_SOURCE, urgency: "non_blocking" });
      store.appendBatch([requestEvent(record), card.event, item.event]);
      // 新设备那边的人正等着：在本机和已配对设备的任意页面上提示一下
      inbox.alert(item.item);
      return { request: viewOf(record), secret };
    },

    claim(secret) {
      const r = bySecret(secret);
      if (!r) return undefined;
      const now = clock.now();
      if (r.status !== "approved" || now >= deadlineOf(r)) return { request: viewOf(r) };
      const credential = newSecret();
      // 等待首次使用：领取的响应到了设备手里，它下一次带着凭证来才启用
      const device: PairedDevice = {
        id: `d-${randomUUID()}`,
        name: r.deviceName,
        from: r.from,
        pairedAt: iso(now),
        activated: false,
        lastUsedAt: iso(now),
        expiresAt: iso(now + DEVICE_FIRST_USE_WINDOW_MS),
        revoked: false,
      };
      const claimed: PairingRequestRecord = { ...r, status: "claimed", deviceId: device.id };
      store.appendBatch([credentialEvent(device.id, hashSecret(credential)), deviceEvent(device, "paired"), requestEvent(claimed)]);
      return { request: viewOf(claimed), credential, device };
    },

    rename(secret, name) {
      const r = bySecret(secret);
      if (!r) throw new RequestRejected("not_found", "没有找到这台设备的配对请求：重新发起一个");
      if (viewOf(r).status !== "pending") throw new RequestRejected("not_allowed", "这个配对请求已经不在等批准了，不能再改设备名");
      const deviceName = normalizeDeviceName(name);
      if (deviceName === undefined) throw new RequestRejected("bad_params", REJECT.badName);
      if (deviceName === r.deviceName) return viewOf(r);
      const next: PairingRequestRecord = { ...r, deviceName };
      const card = cards.get(r.cardId);
      const events: NewEvent[] = [requestEvent(next)];
      if (card?.status === "pending") events.push(cards.buildUpdate(r.cardId, { payload: { ...(card.payload as PairingCardPayload), deviceName } }).event);
      for (const item of inbox.itemsForCard(r.cardId)) events.push(inbox.buildUpdate(item, { title: pairingRequestTitle(deviceName) }).event);
      store.appendBatch(events);
      return viewOf(next);
    },

    authenticate(credential) {
      const device = byCredential(credential);
      return device && isValid(device, clock.now()) ? touch(device) : undefined;
    },

    rejectionOf(credential) {
      const device = byCredential(credential);
      if (!device || isValid(device, clock.now())) return undefined;
      return device.revoked ? "revoked" : "expired";
    },

    refresh(deviceId) {
      const device = getDevice(store.reader, deviceId);
      if (!device || !isValid(device, clock.now())) return false;
      touch(device);
      return true;
    },

    revoke(deviceId, idempotencyKey) {
      const done = revokedByKey(store.reader, idempotencyKey);
      if (done !== undefined) {
        if (done !== deviceId) throw new RequestRejected("bad_params", "这个幂等键已经用在别的请求上了");
        return { deviceId };
      }
      const device = getDevice(store.reader, deviceId);
      if (!device) throw new RequestRejected("not_found", `没有这台设备：${deviceId}`);
      if (device.revoked) throw new RequestRejected("conflict", "这台设备已经吊销了");
      const { duplicate } = store.append(deviceEvent({ ...device, revoked: true, revokedAt: iso(clock.now()) }, "revoked", idempotencyKey));
      if (duplicate) throw new RequestRejected("bad_params", "这个幂等键已经用在别的请求上了");
      for (const listener of revokedListeners) listener(deviceId);
      return { deviceId };
    },

    list: () => listDevices(store.reader),

    onRevoked(listener) {
      revokedListeners.add(listener);
      return () => revokedListeners.delete(listener);
    },

    approveFromCard(payload, now) {
      const r = pendingRequest(payload);
      if (ms(now) >= deadlineOf(r)) {
        throw new RequestRejected("not_allowed", `这个配对请求已经过期了（${durationText(PAIRING_REQUEST_TTL_MS)}），请在新设备上重新请求`);
      }
      const approved: PairingRequestRecord = { ...r, status: "approved", approvedAt: now, claimBefore: iso(ms(now) + PAIRING_CLAIM_WINDOW_MS) };
      return { status: "handled", events: [requestEvent(approved)] };
    },

    denyFromCard(payload) {
      const r = pendingRequest(payload);
      return { status: "handled", events: [requestEvent({ ...r, status: "denied" })] };
    },

    start() {
      unsubscribe = store.onAppend((event) => {
        if (event.channel === PAIRING_CHANNEL && event.type === PAIRING_EVENT_TYPES.request) scheduleTimer((event.payload as PairingRequestEventPayload).request);
      });
      for (const r of openRequests(store.reader)) scheduleTimer(r);
    },

    stop() {
      unsubscribe?.();
      for (const r of openRequests(store.reader)) scheduler.cancel(timerKey(r.id));
    },
  };
}
