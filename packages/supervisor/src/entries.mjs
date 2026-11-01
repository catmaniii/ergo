// 指向自己的入口（docs/link-protocol.md §8，二狗）：接入的服务问管理器「外面的人经哪些地址能连到我的对外端口」。
//
// 管理器知道这些（公网隧道的 exposure、tailnet 入口、VPS 上的站点），服务自己不知道：它只听 127.0.0.1。
// 这里只读，不开隧道、不改任何东西。
//
// 判「指向哪个端口」看实际接线，不看字面：
//  - 公网：隧道的 -R 写着连本机哪个端口（exposure.localPort 不写时 exposedPort 回探活端口，
//    而二狗手写的示例就是 probe 8810 + 隧道 -R 8811，照字面算会冤枉它），读不出 -R 才退回 exposedPort；
//  - tailnet：网关的路由表就是按 exposedPort 写的（tailnet.mjs 的 routesFor），它就是实际接线。
// 接入方在 hello 里说了 externalPort 时，指向别的端口的入口只放进 wrongPort（带网址，让它写进日志和体检），不算能用的入口——
// 二狗的本机端口对本机请求自动信任，指向它的入口等于把不要凭证的门开到外面。
import fs from 'node:fs';
import { VPS_STATE } from './paths.mjs';
import { exposedPort, exposureOf } from './exposure.mjs';
import { hostOf } from './tailnet.mjs';

export const FEATURE = 'entries';

/** ssh -R 的最后一段是本机端口：127.0.0.1:18811:127.0.0.1:8811 → 8811 */
const portOfForward = (spec) => {
  const m = /:(\d{1,5})$/.exec(String(spec));
  return m ? Number(m[1]) : null;
};

/** 隧道服务的 -R 实际连本机哪个端口；不是 ssh 反向隧道、读不出来是 null。 */
export function tunnelTargetPort(tunnel) {
  const start = tunnel?.hooks?.start;
  const argv = start?.argv;
  if (Array.isArray(argv)) {
    const at = argv.indexOf('-R');
    if (at >= 0 && at + 1 < argv.length) return portOfForward(argv[at + 1]);
  }
  const m = /(?:^|\s)-R\s+(\S+)/.exec(String(start?.cmd ?? ''));
  return m ? portOfForward(m[1]) : null;
}

/** lsm vps site add 加的站点（vps-setup.json）；读不了就当没有：入口清单不该因为这个文件坏了而整个没了。 */
function readSites(file) {
  try {
    const doc = JSON.parse(fs.readFileSync(file, 'utf-8'));
    return doc?.sites && typeof doc.sites === 'object' ? Object.values(doc.sites) : [];
  } catch {
    return [];
  }
}

/** 网址规范化之后比较：同一个地址在 exposure 和站点里各写了一次时只算一条。 */
const sameKey = (url) => {
  try { return new URL(url).href; } catch { return String(url); }
};

const httpWhy = (check) => check?.why ?? (check?.status != null ? `HTTP ${check.status}` : null);

/** tailnet 实测三段（网关、DNS、serve）里卡在哪一段，给日志看。 */
const tailnetWhy = (check) => {
  if (!check || check.ok) return null;
  if (check.gateway && !check.gateway.ok) return `网关：${check.gateway.why ?? `HTTP ${check.gateway.status}`}`;
  if (check.dns && !check.dns.ok) return `DNS：${check.dns.why ?? '没解析到本机'}`;
  if (check.serve && !check.serve.ok) return `tailscale serve：${check.serve.target ?? '没配'}`;
  return check.cert?.ok === false ? `证书：${check.cert.why}` : null;
};

/**
 * 这个服务现在的入口，公网在前、tailnet 在后（排序是接入方的事，这里只保证同一输入同一顺序）。
 * reachable：true / false 是最近一次从外面打的结果，null 是没测过（check: false、慢周期还没轮到、站点管理器不测）。
 */
function allEntries(sup, id, sitesFile) {
  const svc = sup.services.get(id);
  if (!svc) return [];
  const out = [];
  const exp = exposureOf(svc);
  const tunnel = exp.via ? sup.services.get(exp.via) : null;
  const tunnelPort = tunnelTargetPort(tunnel) ?? exp.localPort ?? null;
  if (exp.scope === 'public' && exp.publicUrl) {
    const check = sup.exposureChecks?.get(id) ?? null;
    out.push({
      kind: 'public', url: exp.publicUrl, port: tunnelPort,
      reachable: exp.check && check ? !!check.ok : null,
      why: exp.check && check && !check.ok ? httpWhy(check) : null,
    });
  }
  // VPS 站点：上游正好是这条隧道在 VPS 上的端口，那它就是这个服务的公网地址（exposure.publicUrl 没填时只有这里知道）
  if (exp.scope === 'public' && exp.remotePort != null) {
    for (const site of readSites(sitesFile)) {
      if (site?.upstreamPort !== exp.remotePort || !site.domain) continue;
      const url = `https://${site.domain}/`;
      if (out.some((e) => sameKey(e.url) === sameKey(url))) continue;
      out.push({ kind: 'public', url, port: tunnelPort, reachable: null, why: null });
    }
  }
  const entry = sup.tailnetEntries?.get(id);
  const cfg = sup.manager?.tailnet;
  if (entry && cfg?.domain) {
    const check = sup.tailnetChecks?.get(id) ?? null;
    out.push({
      kind: 'tailnet', url: `https://${hostOf(entry.name, cfg)}/`, port: exposedPort(svc),
      reachable: check ? !!check.ok : null, why: tailnetWhy(check),
    });
  }
  return out;
}

/**
 * 推给接入方的那一份：entries 是指向它对外端口的，wrongPort 是指向别的端口的（只给它记日志、上体检）。
 * 接入方没说 externalPort（别的项目）时不分对错，全在 entries 里。
 */
export function entriesFor(sup, id, externalPort, sitesFile = VPS_STATE) {
  const all = allEntries(sup, id, sitesFile);
  if (externalPort == null) return { entries: all, wrongPort: [] };
  return {
    entries: all.filter((e) => e.port === externalPort),
    wrongPort: all.filter((e) => e.port !== externalPort),
  };
}
