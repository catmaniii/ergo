// 管理器常驻进程：HTTP + WebSocket + 探活循环 + 哨兵循环。
// 绑 127.0.0.1，出网走 VPS 反向隧道。
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { WebSocketServer } from 'ws';
import { WEBUI_DIR, DATA_DIR, DATA_DIR_FROM } from './paths.mjs';
import { tail, resolveLogPath, resolveLogFile, readRange, streamLog, INITIAL_BYTES } from './logs.mjs';
import { scan } from './sentinel.mjs';
import { checkAll } from './exposure.mjs';
import { attachLink } from './link.mjs';
import { createAuth } from './auth.mjs';
import { info, warn, audit } from './log.mjs';

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml' };

function send(res, code, body, type = 'application/json; charset=utf-8') {
  const data = typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body);
  res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store' });
  res.end(data);
}

async function readBody(req, limit = 1 << 20) {
  const chunks = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > limit) throw new Error('请求体过大');
    chunks.push(c);
  }
  if (!chunks.length) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString('utf-8')); } catch { return {}; }
}

export async function serve(sup, { lifeline = false } = {}) {
  const cfg = sup.manager;
  const auth = createAuth(cfg);
  const link = attachLink(sup);
  sup.link = link;   // 探活时优先看接入层
  let lastScan = { ports: [], tasks: [], duplicateTasks: [] };

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const p = url.pathname;

    try {
      // ---- 鉴权：未配口令时 /api/* 与 /admin 一律 404（secure by default）
      const gate = auth.check(req, p);
      if (gate.reject) return send(res, gate.code, gate.body, gate.type || 'application/json; charset=utf-8');

      if (p === '/api/auth/challenge' && req.method === 'POST') return send(res, 200, auth.challenge(await readBody(req)));
      if (p === '/api/auth/verify' && req.method === 'POST') {
        const r = auth.verify(await readBody(req), req);
        audit('auth', { ok: r.ok, ip: req.socket.remoteAddress });
        return send(res, r.ok ? 200 : 401, r);
      }
      if (p === '/api/auth/status') return send(res, 200, auth.status(req));

      if (p === '/api/state') {
        return send(res, 200, { ...sup.snapshotForUi(), sentinel: lastScan, authed: true });
      }
      if (p === '/api/logs') {
        const id = url.searchParams.get('id');
        const idx = Number(url.searchParams.get('i') || 0);
        const svc = sup.services.get(id);
        if (!svc) return send(res, 404, { ok: false, why: '没有这个服务' });
        const entries = logEntries(sup, svc);
        const entry = entries[idx];
        if (!entry) return send(res, 404, { ok: false, why: '这个服务没有登记日志' });
        return send(res, 200, { ok: true, label: entry.label, ...tail(entry.file, { lines: Number(url.searchParams.get('lines') || 200) }) });
      }
      // ---- 日志页（logs.html）：只读，整份可往前翻，新输出实时推（SSE）
      if (p === '/api/logs/sources') {
        const svc = sup.services.get(url.searchParams.get('id'));
        if (!svc) return send(res, 404, { ok: false, why: '没有这个服务' });
        const sources = logEntries(sup, svc).map((e, i) => {
          const file = resolveLogFile(e.file);
          let size = null;
          try { if (file) size = fs.statSync(file).size; } catch {}
          return { i, label: e.label, path: e.file, file, size };
        });
        return send(res, 200, { ok: true, id: svc.id, name: svc.name, kind: svc.kind, sources });
      }
      if (p === '/api/logs/stream') {
        const svc = sup.services.get(url.searchParams.get('id'));
        const idx = Number(url.searchParams.get('i') || 0);
        if (!svc || !logEntries(sup, svc)[idx]) return send(res, 404, { ok: false, why: '没有这个服务或这份日志' });
        // 断线重连时浏览器自动带上 Last-Event-ID（= 上次读到的字节位置），从那里续，不重放、不漏
        const last = Number(req.headers['last-event-id']);
        return streamLog(req, res, () => {
          const e = logEntries(sup, svc)[idx];
          return e ? resolveLogFile(e.file) : null;
        }, { from: Number.isFinite(last) && req.headers['last-event-id'] !== '' ? last : null });
      }
      if (p === '/api/logs/range') {
        const svc = sup.services.get(url.searchParams.get('id'));
        const entry = svc && logEntries(sup, svc)[Number(url.searchParams.get('i') || 0)];
        const file = entry && resolveLogFile(entry.file);
        if (!file) return send(res, 404, { ok: false, why: '没有这份日志' });
        const end = Math.max(0, Number(url.searchParams.get('end')) || 0);
        const bytes = Math.min(8 * 1048576, Math.max(65536, Number(url.searchParams.get('bytes')) || INITIAL_BYTES));
        return send(res, 200, { ...readRange(file, Math.max(0, end - bytes), end), file });
      }

      if (p === '/api/action' && req.method === 'POST') {
        const body = await readBody(req);
        const r = await runAction(sup, body, () => scan(sup).then((s) => { lastScan = s; }));
        broadcast();
        return send(res, r.ok ? 200 : 400, r);
      }
      if (p === '/api/scan') { lastScan = await scan(sup); return send(res, 200, lastScan); }

      // ---- 静态文件
      const file = p === '/' ? 'index.html' : p.replace(/^\/+/, '');
      const full = path.join(WEBUI_DIR, file);
      if (!full.startsWith(WEBUI_DIR) || !fs.existsSync(full) || fs.statSync(full).isDirectory()) return send(res, 404, 'not found', 'text/plain');
      return send(res, 200, fs.readFileSync(full), MIME[path.extname(full)] || 'application/octet-stream');
    } catch (e) {
      warn('请求处理出错', { path: p, error: String(e) });
      return send(res, 500, { ok: false, why: String(e) });
    }
  });

  // ---- WebSocket：/ws 给 WebUI 推状态；/link 给接入的服务（docs/link-protocol.md）
  const wss = new WebSocketServer({ noServer: true });
  const clients = new Set();
  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname === '/link') return link.handleUpgrade(req, socket, head);
    if (url.pathname !== '/ws' || !auth.checkWs(req)) return socket.destroy();
    wss.handleUpgrade(req, socket, head, (ws) => {
      clients.add(ws);
      ws.on('close', () => clients.delete(ws));
      ws.send(JSON.stringify({ type: 'state', ...sup.snapshotForUi(), sentinel: lastScan }));
    });
  });

  const broadcast = () => {
    const msg = JSON.stringify({ type: 'state', ...sup.snapshotForUi(), sentinel: lastScan });
    for (const ws of clients) { try { ws.send(msg); } catch {} }
  };
  sup.on('refresh', broadcast);
  // 名下的服务登记 / 撤销、开机自启被登记方改了：注册表变了，卡片要立刻出现 / 消失
  sup.on('registry-changed', broadcast);
  link.on('change', broadcast);

  // ---- 探活循环：状态永远实时推，不靠前端轮询
  //
  // 两个循环都必须防重入：它们每轮都要起 PowerShell 查进程表，一轮跑多久取决于机器有多忙，
  // **不可能**保证短于间隔。没有这道闸的后果 2026-08-29 亲眼见过：
  // 一轮 ~5.5s 撞上 5s 间隔 → 轮次无限叠加 → PowerShell 进程堆积 → 机器更慢 → 轮次更长，
  // 最后管理器的事件循环被自己饿死：7420 端口能连上但永远不回包，
  // 所有服务被误判 FAILED，autoRestart 对着活得好好的进程空转了 8 次。
  // 定时器能跑赢自己的活儿，这本身就是 bug——间隔是「最短间隔」，不是「保证间隔」。
  let probing = false;
  const probeTimer = setInterval(() => {
    if (probing) return;      // 上一轮还没跑完就跳过这一轮，绝不叠加
    probing = true;
    sup.refresh()
      .catch((e) => warn('探活出错', { error: String(e) }))
      .finally(() => { probing = false; });
  }, cfg.probeIntervalMs);

  let scanning = false;
  const slowCycle = async () => {
    if (scanning) return;
    scanning = true;
    try {
      try { lastScan = await scan(sup); } catch {}
      try { sup.exposureChecks = await checkAll(sup); } catch {}
      try { await sup.refreshTailnet(); } catch (e) { warn('tailnet 巡检出错', { error: String(e) }); }
    } finally { scanning = false; }
    broadcast();
    // VPS 费用要连阿里云（最慢十几秒），不让它拖住哨兵和这一轮的推送；真查了才再推一次
    sup.refreshVpsBilling()
      .then((r) => { if (!r?.cached) broadcast(); })
      .catch((e) => warn('VPS 费用查询出错', { error: String(e) }));
  };
  const scanTimer = setInterval(() => { slowCycle().catch(() => {}); }, cfg.sentinels?.intervalMs ?? 60000);

  // 先监听再对账：重认领和哨兵巡检要好几秒（Get-ScheduledTask 尤其慢），
  // 排在 listen 前面会让管理器启动初期整个不可达，CLI 会误判成「管理器没在跑」。
  await new Promise((resolve, reject) => {
    server.on('error', reject);
    server.listen(cfg.port, cfg.bind, resolve);
  });
  info(`管理器已就绪 http://${cfg.bind}:${cfg.port}  （鉴权：${auth.enabled ? '已开启' : '关闭，仅本机可达'}）`, { dataDir: DATA_DIR, dataDirFrom: DATA_DIR_FROM });
  // 抢到端口之后才往账本里记「管理器是我」：抢不到的那个（看门狗多拉的、手滑多起的）
  // 会在上面 listen 时就 EADDRINUSE 退出，不该先把正在干活的那个的记录覆盖掉。
  sup.state.manager = { ...sup.state.manager, startedAt: Date.now(), pid: process.pid };
  sup.persist();

  const shutdown = () => {
    clearInterval(probeTimer); clearInterval(scanTimer);
    server.close(); link.close();
    info('管理器退出——托管的服务不受影响');
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  // 生命线（2026-10-08 实测后加的）：计划任务用 conhost --headless 拉起管理器，
  // 任务实例的死活就是那个 conhost 的死活。可管理器有了自己的控制台之后，conhost 被结束它还会活着
  // （实测：Stop-ScheduledTask 只结束任务的主进程）——于是「停任务」停不掉管理器，
  // 看门狗的 IgnoreNew 也失效，每 5 分钟白起一个撞端口的实例。
  // 所以：父进程一没，管理器跟着退出。托管的服务各有自己的控制台，照样不受影响。
  if (lifeline) {
    const parent = process.ppid;
    setInterval(() => {
      try { process.kill(parent, 0); } catch (e) {
        if (e.code !== 'ESRCH') return;   // EPERM = 进程还在，只是没权限碰它
        warn(`父进程 ${parent} 没了（计划任务被停止或删除）——管理器跟着退出`);
        shutdown();
      }
    }, 2000).unref();
  }

  await sup.adopt();
  await slowCycle();
  return server;
}

function logEntries(sup, svc) {
  const out = (svc.logs || []).map((l) => ({ label: l.label || l.path, file: resolveLogPath(svc, l.path) }));
  // 管理器托管的服务永远有「命令行输出」这一份：它 spawn 的进程的输出、各个钩子的输出都写在这里。
  // 还没起过也列出来——日志页会等着它出现，起了之后自动开始滚动。
  if (svc.kind !== 'external') out.unshift({ label: '命令行输出', file: sup.st(svc.id).managerLog || sup.outLog(svc.id) });
  return out;
}

async function runAction(sup, body, rescan) {
  const { action, id } = body;
  switch (action) {
    case 'start': return sup.start(id);
    case 'stop': return sup.stop(id, { mode: body.mode || 'now', force: !!body.force });
    case 'restart': return sup.restart(id, { mode: body.mode || 'now' });
    case 'profile-start': return sup.startProfile(id);
    case 'profile-stop': return sup.stopProfile(id, { force: !!body.force });
    case 'orphan': return sup.resolveOrphan(id, body.decision);
    case 'cancel-stop': return sup.cancelPendingStop(id);
    case 'expose-create': return sup.createExposure(id, { remotePort: body.remotePort });
    case 'expose-on': case 'expose-off': {
      // 「管理公网接口」= 管那条隧道服务。公网入口没有独立生命周期，它就是隧道。
      const svc = sup.services.get(id);
      const via = svc?.exposure?.via;
      if (!via) return { ok: false, why: `${id} 没有声明公网入口` };
      return action === 'expose-on' ? sup.start(via) : sup.stop(via, { force: true });
    }
    case 'detach-task': {
      const r = await sup.detachTask(body.task);
      await rescan();
      return r;
    }
    case 'reload': { const errors = sup.reload(); return { ok: !errors.length, errors }; }
    case 'autostart-set': return sup.setAutostart(id, !!body.on);
    case 'tailnet-open': return sup.openTailnet(id, { name: body.name });
    case 'tailnet-close': return sup.closeTailnet(id);
    case 'vps-refresh': return sup.refreshVpsBilling({ force: true });
    // 你手动撤销一个名下的服务：和登记方发 services.remove 走同一条路（先强制停，再拿掉登记）
    case 'owned-remove': return sup.owned.withdraw(id, { by: 'user' });
    default: return { ok: false, why: `未知操作：${action}` };
  }
}
