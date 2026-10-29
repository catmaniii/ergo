// 接入层服务端，协议见 docs/link-protocol.md。
// 连接在 = 服务真的活着；失联只降级观测精度，绝不判死。
import { EventEmitter } from 'node:events';
import crypto from 'node:crypto';
import { WebSocketServer } from 'ws';
import { info, warn, audit } from './log.mjs';
import { FEATURE as OWNED_FEATURE, wireReply } from './owned.mjs';

const HEARTBEAT_GRACE_MS = 15000;   // 3 个心跳周期
const PROTOCOL = 1;
// 协议还是 v1：新能力只加消息，在 welcome.features 里声明（docs/link-protocol.md §7）。
// 不升版本号是因为现有客户端见到 LSM_PROTOCOL 不是 1 就整个不接入——升了等于让所有老服务静默掉线。
const FEATURES = [OWNED_FEATURE];

export function attachLink(sup) {
  const wss = new WebSocketServer({ noServer: true });
  const sessions = new Map();     // serviceId -> session
  const pending = new Map();      // cmdId -> {resolve, timer}
  const bus = new EventEmitter();

  function tokenOwner(token) {
    if (!token) return null;
    for (const svc of sup.services.values()) {
      const st = sup.st(svc.id);
      if (st.linkToken && st.linkToken === token) return svc.id;
    }
    return null;
  }

  function drop(id, why) {
    const s = sessions.get(id);
    if (!s) return;
    sessions.delete(id);
    try { s.ws.close(); } catch {}
    // 它名下的服务不受任何影响：那是管理器 spawn 的独立进程，跟这条连接毫无关系
    sup.owned?.forget(id);
    info(`接入层断开：${id}（${why}）——观测精度降级，但不判定服务已死`);
    bus.emit('change');
  }

  function send(ws, msg) { try { ws.send(JSON.stringify(msg)); } catch {} }

  // ---- 名下的服务（docs/link-protocol.md §7）

  /** 把这个登记方名下变了的服务推给它；full = 全量（接入时推一次）。 */
  function pushOwned(id, { full = false } = {}) {
    const s = sessions.get(id);
    if (!s || !sup.owned) return;
    const d = sup.owned.diff(id, { full });
    if (d) send(s.ws, { type: 'services.status', ...d });
  }
  const pushOwnedAll = () => { for (const id of sessions.keys()) pushOwned(id); };
  // 探活每轮、启停的每次跳变、注册表一变，都看一眼有没有要推的（只推变了的，见 owned.diff）
  sup.on?.('refresh', pushOwnedAll);
  sup.on?.('change', pushOwnedAll);
  sup.on?.('registry-changed', pushOwnedAll);

  function onServices(ws, ownerId, msg) {
    // id 放最后：回复的内容里绝不能盖掉请求编号，否则登记方永远对不上这条回复
    const reply = (r) => send(ws, { type: 'services.reply', ...wireReply(r), id: msg.id ?? null });
    // 只有已经接入（hello 过）、会话有效的项目能发：令牌在升级时验过，这里再确认这条连接就是它的活跃会话
    if (sessions.get(ownerId)?.ws !== ws) return reply({ ok: false, code: 'not-linked', why: '先发 hello 接入，再管名下的服务' });
    if (typeof msg.id !== 'string' && typeof msg.id !== 'number') return reply({ ok: false, code: 'bad-request', why: '缺少 id（请求编号，回复原样带回）' });
    if (!sup.owned) return reply({ ok: false, code: 'unsupported', why: '管理器没有挂上名下服务的模块' });
    sup.owned.request(ownerId, msg)
      .catch((e) => ({ ok: false, code: 'failed', why: String(e?.message || e) }))
      .then((r) => {
        audit('link-services', { owner: ownerId, type: msg.type, name: msg.name ?? msg.service?.name ?? null, ok: r.ok, code: r.code });
        reply(r);
        pushOwnedAll();
      });
  }

  function onMessage(ws, raw, ctx) {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    if (!msg || typeof msg !== 'object') return;

    if (typeof msg.type === 'string' && msg.type.startsWith('services.')) return onServices(ws, ctx.serviceId, msg);

    if (msg.type === 'hello') {
      if (msg.serviceId !== ctx.serviceId) {
        send(ws, { type: 'conflict', reason: '令牌与 serviceId 不匹配' });
        return ws.close();
      }
      if (sessions.has(ctx.serviceId)) {
        // 第二个实例带着同一个 ID 接入 —— 立刻发现重复启动，不必等端口冲突（接入的服务身份来自这条连接本身）
        warn(`检测到重复启动：${ctx.serviceId} 已有活跃会话`);
        send(ws, { type: 'conflict', reason: '该 serviceId 已有活跃会话' });
        return ws.close();
      }
      const session = {
        ws, serviceId: ctx.serviceId, pid: msg.pid ?? null, port: msg.port ?? null,
        version: msg.version || '', capabilities: msg.capabilities || [],
        logs: msg.logs || [], health: 'ok', busy: false, busyReason: null,
        features: Array.isArray(msg.features) ? msg.features.filter((f) => typeof f === 'string') : [],
        lastBeat: Date.now(), since: Date.now(),
      };
      sessions.set(ctx.serviceId, session);
      send(ws, { type: 'welcome', sessionId: crypto.randomBytes(8).toString('hex'), heartbeatIntervalMs: 5000, features: FEATURES });
      info(`接入：${ctx.serviceId}`, { pid: session.pid, capabilities: session.capabilities });
      audit('link-hello', { id: ctx.serviceId, pid: session.pid, capabilities: session.capabilities });
      // 接入时推一次名下服务的全量。只推给说了要的（hello.features 里有 services）或者名下真有服务的——
      // 老项目什么都不会多收到（除了 welcome 里多一个它不认识的字段）
      if (session.features.includes(OWNED_FEATURE) || sup.owned?.listFor(ctx.serviceId).length) pushOwned(ctx.serviceId, { full: true });
      bus.emit('change');
      return;
    }

    const s = sessions.get(ctx.serviceId);
    if (!s) return;

    if (msg.type === 'heartbeat') {
      s.lastBeat = Date.now();
      s.health = msg.health || 'ok';
      const wasBusy = s.busy;
      s.busy = !!msg.busy;
      s.busyReason = msg.busyReason || null;
      s.detail = msg.detail || null;
      if (wasBusy !== s.busy) bus.emit('change');
      // busy 转空闲时唤醒 when-idle 的挂起指令
      if (wasBusy && !s.busy) bus.emit(`idle:${ctx.serviceId}`);
      return;
    }
    if (msg.type === 'ack') {
      const p = pending.get(msg.id);
      if (p) { clearTimeout(p.timer); pending.delete(msg.id); p.resolve({ ok: !!msg.ok, why: msg.error || null }); }
      return;
    }
    if (msg.type === 'bye') {
      info(`${ctx.serviceId} 主动告别：${msg.reason || '未说明'}`);
      drop(ctx.serviceId, 'bye');
    }
  }

  function handleUpgrade(req, socket, head) {
    const token = (req.headers.authorization || '').replace(/^Bearer\s+/i, '').trim();
    const serviceId = tokenOwner(token);
    if (!serviceId) {
      // 没有有效身份就不是接入层的连接。铁律：这不该影响服务本身运行（link-protocol §0）
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      return socket.destroy();
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      const ctx = { serviceId };
      ws.on('message', (raw) => onMessage(ws, raw, ctx));
      ws.on('close', () => { if (sessions.get(serviceId)?.ws === ws) drop(serviceId, '连接关闭'); });
      ws.on('error', () => {});
    });
  }

  async function command(id, type, { mode = 'now', deadlineMs = 60000 } = {}) {
    const s = sessions.get(id);
    if (!s) return { ok: false, why: '服务未接入' };
    const cmdId = `cmd-${crypto.randomBytes(4).toString('hex')}`;
    const ack = new Promise((resolve) => {
      pending.set(cmdId, { resolve, timer: setTimeout(() => { pending.delete(cmdId); resolve({ ok: false, why: '服务没有应答' }); }, 15000) });
    });
    send(s.ws, { type, id: cmdId, mode, deadlineMs });
    audit(`link-${type}`, { id, mode, deadlineMs });
    return await ack;
  }

  const sweep = setInterval(() => {
    for (const [id, s] of sessions) {
      if (Date.now() - s.lastBeat > HEARTBEAT_GRACE_MS) drop(id, '心跳超时');
    }
  }, 5000);

  return {
    handleUpgrade,
    on: (ev, fn) => bus.on(ev, fn),
    status(id) {
      const s = sessions.get(id);
      if (!s) return { connected: false };
      return {
        connected: Date.now() - s.lastBeat <= HEARTBEAT_GRACE_MS,
        health: s.health, busy: s.busy, busyReason: s.busyReason,
        capabilities: s.capabilities, pid: s.pid, version: s.version, detail: s.detail,
      };
    },
    stop: (id, opts) => command(id, 'stop', opts),
    cancel: (id) => command(id, 'cancel', {}),
    restart: (id, opts) => command(id, 'restart', opts),
    close() {
      clearInterval(sweep);
      sup.off?.('refresh', pushOwnedAll); sup.off?.('change', pushOwnedAll); sup.off?.('registry-changed', pushOwnedAll);
      for (const id of Array.from(sessions.keys())) drop(id, '管理器退出');   // 先拷一份：drop 会删 sessions 里的项
      wss.close();
    },
    PROTOCOL, FEATURES,
  };
}
