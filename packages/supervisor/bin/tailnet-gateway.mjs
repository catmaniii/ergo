#!/usr/bin/env node
// Tailnet HTTPS 网关。
//
// tailnet 上的 443（`tailscale serve --tcp 443` 转来）→ 按 SNI 挑证书做 TLS 终结 → 解密后的字节原样转给对应服务的对外端口。
// 只做 TLS、不解析 HTTP：Host 头、WebSocket 升级、分片上传、Range 请求都原样过去，服务看到的和浏览器发的一字不差
// （有的服务要求 Origin 的 host:port 与 Host 完全一致——不改 Host 就天然满足）。
//
// 路由表和证书由管理器维护（数据目录里的 tailnet-routes.json、.secrets/tailnet/<名字>/），这里每 5 秒看一眼变没变，变了就重载；
// 数据目录不在默认位置时，登记它的启动参数里加 --data-dir <目录>（管理器拉它时不把自己的环境变量传下去，见 paths.mjs）。
// 已经建立的连接不受影响。只绑 127.0.0.1：外面能进来的只有 tailscale serve 这一条路。
import fs from 'node:fs';
import net from 'node:net';
import tls from 'node:tls';
import { TAILNET_ROUTES } from '../src/paths.mjs';

const arg = (k, d) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d; };
const PORT = Number(arg('--port', 8445));
const log = (...a) => console.log(new Date().toISOString(), ...a);

let table = new Map();   // host → { port, ctx }
let stamp = '';

const mtime = (f) => { try { return fs.statSync(f).mtimeMs; } catch { return 0; } };

function reload() {
  let raw;
  try { raw = fs.readFileSync(TAILNET_ROUTES, 'utf-8'); } catch {
    if (stamp !== 'missing') { log(`路由表不在（${TAILNET_ROUTES}），所有连接都会被拒`); table = new Map(); stamp = 'missing'; }
    return;
  }
  let doc;
  try { doc = JSON.parse(raw); } catch (e) { log(`路由表解析失败，沿用上一份：${e.message}`); return; }
  const routes = doc.routes || [];
  const next = routes.map((r) => `${r.host}>${r.port}@${mtime(r.cert)}/${mtime(r.key)}`).join(',');
  if (next === stamp) return;
  const t = new Map();
  for (const r of routes) {
    try {
      t.set(r.host.toLowerCase(), { port: r.port, ctx: tls.createSecureContext({ cert: fs.readFileSync(r.cert), key: fs.readFileSync(r.key) }) });
    } catch (e) { log(`${r.host}：证书读不了，这个名字先不接（${e.message}）`); }
  }
  table = t;
  stamp = next;
  log(`路由表已载入：${[...t].map(([h, r]) => `${h} → 127.0.0.1:${r.port}`).join('，') || '（空）'}`);
}

let tlsErrors = 0;
const server = tls.createServer({
  SNICallback: (name, cb) => {
    const r = table.get(String(name || '').toLowerCase());
    if (r) cb(null, r.ctx);
    else cb(new Error(`没有这个名字：${name}`));
  },
  ALPNProtocols: ['http/1.1'],   // 只说 HTTP/1.1：字节原样转发，服务那边不一定会 h2
  minVersion: 'TLSv1.2',
}, (client) => {
  const host = String(client.servername || '').toLowerCase();
  const r = table.get(host);
  if (!r) return client.destroy();
  const up = net.connect(r.port, '127.0.0.1');
  client.setKeepAlive(true, 60000);
  up.setKeepAlive(true, 60000);
  client.setNoDelay(true);
  up.setNoDelay(true);
  client.pipe(up);
  up.pipe(client);
  const end = () => { client.destroy(); up.destroy(); };
  up.on('error', (e) => { log(`${host} → 127.0.0.1:${r.port} 连不上：${e.code || e.message}`); end(); });
  client.on('error', end);
  client.on('close', end);
  up.on('close', end);
});
// 握手失败（扫端口的、名字不对的）不逐条记，攒着每小时报一次数
server.on('tlsClientError', () => { tlsErrors++; });
setInterval(() => { if (tlsErrors) { log(`过去一小时 TLS 握手失败 ${tlsErrors} 次（名字不对或不是 TLS）`); tlsErrors = 0; } }, 3600_000).unref();

reload();
setInterval(reload, 5000);
server.on('error', (e) => { log(`监听 127.0.0.1:${PORT} 失败：${e.code || e.message}`); process.exit(1); });
server.listen(PORT, '127.0.0.1', () => log(`tailnet 网关已就绪 127.0.0.1:${PORT}`));
