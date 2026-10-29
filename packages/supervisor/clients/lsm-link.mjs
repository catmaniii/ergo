/**
 * 本地服务管理器 · 接入层客户端（Node）
 * 协议：docs/link-protocol.md v1        零依赖（Node 22+ 内置 WebSocket）
 *
 * ── 铁律 ──────────────────────────────────────────────────────────────
 * 没有 LSM_* 环境变量、连不上、协议不匹配 —— 一律静默降级为「不接入」，
 * 服务照常独立运行。接入层**绝不能**成为你的启动依赖，否则没人敢接入。
 * 本文件里所有路径都不抛异常给调用方。
 * ─────────────────────────────────────────────────────────────────────
 *
 * 用法（放在服务启动完成、开始监听之后）：
 *
 *   import { link } from './lsm-link.mjs';
 *
 *   const lsm = link({
 *     port: 8799,
 *     version: pkg.version,
 *     logs: ['tmp/server.log'],
 *     // 「现在中断会造成损失吗」——由你定义。管理器据此提供「等空闲再停」。
 *     busy: () => {
 *       const n = tasks.running();
 *       return n ? { busy: true, reason: `正在跑 ${n} 个任务` } : { busy: false };
 *     },
 *     health: () => (db.ok() ? 'ok' : 'degraded'),
 *     // 有它才会声明 stop 能力；没有就别写，管理器会如实在 WebUI 上灰显。
 *     onShutdown: async () => {
 *       await queue.drain();      // 你的领域知识写在这里，管理器不猜
 *       await db.flush();
 *     },
 *   });
 *
 * ── 名下的服务（docs/link-protocol.md §7）────────────────────
 * 接入之后可以让管理器替你登记、启停、撤销**你名下的**服务（id = <你的 serviceId>--<名字>）。
 * 它们是管理器 spawn 的独立常驻服务：你掉线、重启都不影响它们。
 *
 *   if (await lsm.services.ready()) {                  // false = 没接入，或者管理器版本太老不支持
 *     const r = await lsm.services.put({
 *       name: 'p-1-web', title: '示例站点', cwd: 'D:\\work\\p-1',
 *       command: 'node server.mjs', port: 8899,
 *       env: [{ name: 'PORT', from: 'literal', value: '8899' }],
 *       health: { path: '/health' }, autostart: true,
 *     });
 *     if (!r.ok) console.log(r.error.code, r.error.message);   // 比如 port-conflict：端口已登记给别人
 *     await lsm.services.start('p-1-web');
 *   }
 *   lsm.services.onStatus((m) => { ... });   // m = { full, services: [...], removed: [...] }
 *   // 停 / 重启：定义里没给 stop.command 的服务要带 { force: true }（直接杀进程树）
 *   await lsm.services.stop('p-1-web', { force: true });
 *   await lsm.services.remove('p-1-web');    // 先停再撤销登记
 *
 * 所有方法都不抛异常，失败一律返回 { ok: false, error: { code, message } }。
 */

const RECONNECT_MIN = 1000;
const RECONNECT_MAX = 30000;
const REQUEST_TIMEOUT = 180000;   // 启动要等服务就绪（readyTimeoutMs 默认 60 秒），给足

/** 管理器不在、没接入时的 services：什么都做不了，但也绝不抛异常（铁律）。 */
const NOOP_SERVICES = (() => {
  const no = async () => ({ ok: false, error: { code: 'not-linked', message: '没有注入 LSM_* 身份，没接入管理器' } });
  return {
    supported: false, ready: async () => false, onStatus: () => () => {},
    put: no, start: no, stop: no, restart: no, autostart: no, remove: no, list: no,
  };
})();

export function link(opts = {}) {
  const url = process.env.LSM_URL;
  const serviceId = process.env.LSM_SERVICE_ID;
  const token = process.env.LSM_TOKEN;
  const protocol = Number(process.env.LSM_PROTOCOL || 0);

  const noop = { enabled: false, close() {}, notifyBusy() {}, services: NOOP_SERVICES };
  if (!url || !serviceId || !token || protocol !== 1) return noop;      // 铁律：静默降级
  if (typeof globalThis.WebSocket !== 'function') return noop;

  const log = opts.log || ((m) => console.log(`[lsm] ${m}`));
  const capabilities = ['busy'];
  if (opts.onShutdown) capabilities.push('stop', 'restart');
  if (opts.health) capabilities.push('health');

  let ws = null;
  let beat = null;
  let backoff = RECONNECT_MIN;
  let closed = false;
  let retryScheduled = false;
  let pendingIdle = null;      // when-idle 挂起的指令
  // 名下的服务（§7）：welcome 带来的特性表（null = 还没接入 / 连接断了），在途的请求，状态订阅
  let features = null;
  let readyWaiters = [];
  const requests = new Map();  // 请求 id → resolve
  let reqSeq = 0;
  const statusListeners = new Set();

  const settleReady = () => { const w = readyWaiters; readyWaiters = []; for (const fn of w) fn(); };
  const failRequests = (code, message) => {
    for (const [, resolve] of requests) resolve({ ok: false, error: { code, message } });
    requests.clear();
  };

  const readBusy = () => {
    try {
      const b = opts.busy?.();
      if (!b) return { busy: false, reason: null };
      return typeof b === 'boolean' ? { busy: b, reason: null } : { busy: !!b.busy, reason: b.reason || null };
    } catch { return { busy: false, reason: null }; }
  };
  const readHealth = () => {
    try { return opts.health?.() || 'ok'; } catch { return 'degraded'; }
  };

  const send = (msg) => { try { if (ws?.readyState === 1) ws.send(JSON.stringify(msg)); } catch {} };

  async function doShutdown(cmd) {
    try { await opts.onShutdown?.(cmd); } catch (e) { log(`onShutdown 出错：${e?.message || e}`); }
    send({ type: 'bye', reason: 'shutdown-complete' });
    setTimeout(() => process.exit(0), 200);       // 留一拍把 bye 发出去
  }

  function handle(msg) {
    if (msg.type === 'welcome') {
      backoff = RECONNECT_MIN;
      // 老管理器的 welcome 没有 features：当成「不支持名下的服务」，别发了等不到回复
      features = Array.isArray(msg.features) ? msg.features : [];
      settleReady();
      return;
    }
    if (msg.type === 'services.reply') { const r = requests.get(msg.id); if (r) { requests.delete(msg.id); r(msg); } return; }
    if (msg.type === 'services.status') {
      for (const fn of statusListeners) { try { fn(msg); } catch (e) { log(`onStatus 回调出错：${e?.message || e}`); } }
      return;
    }
    if (msg.type === 'conflict') {
      // 同一个 serviceId 已有活跃会话 = 你被重复启动了。立刻退，别抢端口。
      log(`管理器拒绝接入：${msg.reason}。本实例退出，避免抢占端口。`);
      closed = true;
      try { ws.close(); } catch {}
      setTimeout(() => process.exit(1), 100);
      return;
    }
    if (msg.type === 'ping') { send({ type: 'ack', id: msg.id, ok: true }); return; }
    if (msg.type === 'cancel') {
      // 撤销挂起的「等空闲再停」。管理器那边取消了，服务这边也必须撤，
      // 否则它空闲时还是会自己退——那就成了「取消了却还是停了」。
      const had = !!pendingIdle;
      pendingIdle = null;
      if (had) log('挂起的停机已取消');
      send({ type: 'ack', id: msg.id, ok: true });
      return;
    }

    if (msg.type === 'stop' || msg.type === 'restart') {
      if (!opts.onShutdown) { send({ type: 'ack', id: msg.id, ok: false, error: '本服务未实现停机回调' }); return; }
      const { busy, reason } = readBusy();
      if (msg.mode === 'when-idle' && busy) {
        send({ type: 'ack', id: msg.id, ok: true });
        log(`收到「等空闲再停」，当前忙碌：${reason || '未说明'}——挂起等待`);
        pendingIdle = msg;
        return;
      }
      send({ type: 'ack', id: msg.id, ok: true });
      doShutdown(msg);
    }
  }

  function connect() {
    if (closed) return;
    retryScheduled = false;
    try { ws = new WebSocket(url, { headers: { Authorization: `Bearer ${token}` } }); }
    catch { return retry(); }

    // Node 的 WebSocket 构造不吃 headers 时退回子协议携带令牌（两种服务端都支持）
    ws.onopen = () => {
      send({
        type: 'hello', serviceId, protocol: 1,
        pid: process.pid, port: opts.port ?? null,
        version: opts.version || '', capabilities,
        logs: opts.logs || [],
        features: ['services'],     // 我会用名下的服务：接入时请推一次全量状态（§7）
      });
      clearInterval(beat);
      beat = setInterval(() => {
        const { busy, reason } = readBusy();
        send({ type: 'heartbeat', ts: Date.now(), health: readHealth(), busy, busyReason: reason, detail: opts.detail?.() ?? null });
        if (pendingIdle && !busy) { const c = pendingIdle; pendingIdle = null; doShutdown(c); }
      }, 5000);
      log(`已接入管理器（${serviceId}）`);
    };
    ws.onmessage = (e) => { try { handle(JSON.parse(e.data)); } catch {} };
    // error 和 close 都要能触发重连：连接建立失败时（管理器没起）实测只会走到 error，
    // 只在 close 里重连的话，管理器一重启这个服务就永远失联了（2026-08-23 踩到）。
    ws.onerror = () => { clearInterval(beat); lost(); retry(); };
    ws.onclose = () => { clearInterval(beat); lost(); retry(); };
  }

  // 连接断了：在途的请求一律回「断了」——管理器那边可能做完了也可能没做，重连后的全量状态推送会说清楚
  function lost() {
    features = null;
    failRequests('disconnected', '和管理器的连接断了；结果以重连后推来的全量状态为准');
  }

  function request(type, body = {}, { timeoutMs = REQUEST_TIMEOUT } = {}) {
    if (!features) return Promise.resolve({ ok: false, error: { code: 'not-connected', message: '还没接入管理器（或连接断了）' } });
    if (!features.includes('services')) return Promise.resolve({ ok: false, error: { code: 'unsupported', message: '这个版本的管理器不支持名下的服务（welcome 里没有 services）' } });
    const id = `q-${++reqSeq}`;
    return new Promise((resolve) => {
      const timer = setTimeout(() => { requests.delete(id); resolve({ ok: false, error: { code: 'timeout', message: '管理器没有应答' } }); }, timeoutMs);
      requests.set(id, (m) => { clearTimeout(timer); resolve(m); });
      send({ type, id, ...body });
    });
  }

  const services = {
    /** 管理器支不支持名下的服务（接入之后才知道）。 */
    get supported() { return !!features?.includes('services'); },
    /** 等到接入（welcome）为止，返回支不支持；超时返回 false。 */
    ready(timeoutMs = 10000) {
      if (features) return Promise.resolve(features.includes('services'));
      return new Promise((resolve) => {
        const t = setTimeout(() => resolve(false), timeoutMs);
        readyWaiters.push(() => { clearTimeout(t); resolve(!!features?.includes('services')); });
      });
    },
    /** 登记 / 更新（整份定义，字段见 §7）。同一份定义反复发不会重写注册表。 */
    put: (def) => request('services.put', { service: def }),
    start: (name) => request('services.start', { name }),
    stop: (name, { force = false, mode = 'now' } = {}) => request('services.stop', { name, force, mode }),
    restart: (name, { force = false, mode = 'now' } = {}) => request('services.restart', { name, force, mode }),
    autostart: (name, on) => request('services.autostart', { name, on: !!on }),
    remove: (name) => request('services.remove', { name }),
    list: () => request('services.list'),
    /** 订阅状态推送；返回取消订阅的函数。 */
    onStatus(fn) { statusListeners.add(fn); return () => statusListeners.delete(fn); },
  };

  function retry() {
    if (closed || retryScheduled) return;              // 一次失败只排一次重连，别指数爆炸
    retryScheduled = true;
    setTimeout(connect, backoff);
    backoff = Math.min(backoff * 2, RECONNECT_MAX);    // 管理器重启时自己爬回来
  }

  connect();

  return {
    enabled: true,
    serviceId,
    services,
    /** 忙碌状态变化时可以主动推一次，不必等下一个心跳 */
    notifyBusy() {
      const { busy, reason } = readBusy();
      send({ type: 'heartbeat', ts: Date.now(), health: readHealth(), busy, busyReason: reason });
      if (pendingIdle && !busy) { const c = pendingIdle; pendingIdle = null; doShutdown(c); }
    },
    close() {
      closed = true; clearInterval(beat);
      try { send({ type: 'bye', reason: 'closing' }); ws?.close(); } catch {}
      features = null; failRequests('closed', '接入层已关闭'); settleReady();
    },
  };
}
