// 拼 VPS 上跑的脚本（321 号票）：参数 + 内容（nginx 站点、headscale 配置）+ 公共函数（sh/lib.sh、sh/certs.sh）+ 这一步的正文（sh/*.sh）。
//
// 拼出来的是一份完整、自带参数的 bash 脚本：本机先整份显示给你看、你同意了才经 ssh 送上去跑；
// 也可以 `--print-script` 存下来，自己登进 VPS 用 `sudo bash` 跑（电脑那半再回来 `--local-only`）。
// 正文和公共函数放在 sh/ 下的真 .sh 文件里（能直接 bash -n、shellcheck），这里只填参数，不在 JS 里拼 shell 语句。
import fs from 'node:fs';
import { ergoTunnelSite, headscaleSite, httpOnlySite, genericSite } from './nginx.mjs';
import { headscaleConfig } from './headscale.mjs';

const SH = (name) => fs.readFileSync(new URL(`./sh/${name}`, import.meta.url), 'utf-8').replace(/\r\n/g, '\n');

/** bash 单引号：里面什么都不展开；单引号本身写成 '\'' */
export const shq = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;

const NAME = /^[A-Z][A-Z0-9_]*$/;
const EOF = 'ERGO_CONTENT_EOF';

function paramLines(params) {
  return Object.entries(params).map(([k, v]) => {
    if (!NAME.test(k)) throw new Error(`参数名不对：${k}`);
    if (v == null) v = '';
    if (/[\r\n]/.test(String(v))) throw new Error(`参数 ${k} 里不能有换行`);
    return `${k}=${shq(v)}`;
  });
}

/** 把一段内容做成一个 bash 函数：调用它就把内容原样打到 stdout（单引号 heredoc，里面的 $ 不展开） */
export function contentFunction(name, body) {
  if (!/^content_[a-z0-9_]+$/.test(name)) throw new Error(`内容函数名不对：${name}`);
  const text = body.endsWith('\n') ? body : `${body}\n`;
  if (text.split('\n').includes(EOF)) throw new Error(`${name} 的内容里出现了分隔行 ${EOF}`);
  return `${name}() {\ncat <<'${EOF}'\n${text}${EOF}\n}\n`;
}

function assemble({ title, about, params, contents = {}, body, now }) {
  const head = [
    '#!/usr/bin/env bash',
    `# 二狗服务管家 · VPS 脚本：${title}`,
    `# 由 lsm vps 在 ${now.toISOString().slice(0, 19).replace('T', ' ')} UTC 生成。`,
    ...about.map((l) => `# ${l}`),
    'set -euo pipefail',
    '',
    '# ---------------------------------------------------------------- 参数（生成时填好）',
    ...paramLines(params),
    '',
  ];
  const fns = Object.entries(contents).map(([n, b]) => contentFunction(n, b));
  return [
    head.join('\n'),
    SH('lib.sh'),
    SH('certs.sh'),
    ...(fns.length ? ['# ---------------------------------------------------------------- 要写上去的文件内容\n' + fns.join('\n')] : []),
    SH(body),
  ].join('\n');
}

const RERUN = [
  '可以重复跑：每一步先看现状，做过的跳过；断了重跑接着做。',
];

/** 体检（只读）。nginxDump：把 nginx 的配置（nginx -T）也交回来（site add 看布局用）。 */
export function checkupScript(plan, { now = new Date(), nginxDump = false } = {}) {
  return assemble({
    title: '体检（只读，什么都不改）',
    about: [
      '只看：系统、已经装了什么、谁占着 80 / 443 / 3478、防火墙、sshd 的设置、域名指到哪。',
      ...(nginxDump ? ['  另外把 nginx 的配置（nginx -T）原样交回电脑，看 443 前面有没有 stream 前门、前门后面的站点听哪个地址。'] : []),
    ],
    params: {
      SSH_PORT: plan.vps.port, PUBLIC_IP: plan.publicIp, DOMAIN: plan.domain,
      HS_PORT: plan.hsPort ?? 8080, TUNNEL_PORT: plan.remotePort ?? 18811, WANT_NGINX_DUMP: nginxDump ? 1 : 0,
    },
    body: 'checkup.sh', now,
  });
}

/**
 * 加一个 https 站点（lsm vps site add，322 号票）。plan.layout 是体检看出来的布局（sites.mjs 的 decideLayout）。
 */
export function siteAddScript(plan, { now = new Date() } = {}) {
  const L = plan.layout;
  const fd = L.frontdoor;
  const how = L.certHow === 'standalone'
    ? `签证书时 80 端口被 ${L.stopUnits.join(' ')} 占着：临时停它、签完马上拉起来（签失败也拉起来）；以后自动续期也这样停一下`
    : L.certHow === 'existing' ? '证书原来就有，不签' : '80 端口 webroot 签（不停 nginx）';
  return assemble({
    title: `加 https 站点 ${plan.name}：https://${plan.domain} → 127.0.0.1:${plan.upstreamPort}`,
    about: [
      ...RERUN,
      '做的事：先核对布局和体检时一样（变了就停下，一样东西都不改）；缺 nginx、certbot、ufw、自动安全更新的装上；防火墙只开 ssh、80、443；',
      `  签 ${plan.domain} 的证书（Let's Encrypt，${how}）；`,
      L.kind === 'frontdoor'
        ? `  写 nginx 站点（只听前门后面的 ${fd.backend}，不抢 443${fd.proxyProtocol ? '，前门开了 proxy_protocol，真实 IP 用 $proxy_protocol_addr' : ''}），往前门 ${fd.file} 的 map 里加一行 ${plan.domain} → ${fd.backend}；`
        : '  写 nginx 站点（直接听 443；WebSocket、Host 原样转发、大上传、不缓冲请求体、长超时、HSTS）；',
      '  每次改 nginx 都先 nginx -t，不过就换回原样；续期后自动让 nginx 读新证书。',
      `也能自己登进 VPS 跑：sudo bash 这个文件。撤掉：lsm vps site remove ${plan.name}。`,
    ],
    params: {
      MODE: 'site', SSH_PORT: plan.vps.port, PUBLIC_IP: plan.publicIp, DOMAIN: plan.domain, SITE: plan.site, SITE_NAME: plan.name,
      UPSTREAM_PORT: plan.upstreamPort, LAYOUT: L.kind, CERT_HOW: L.certHow === 'standalone' ? 'standalone' : 'webroot',
      STOP_UNITS: (L.stopUnits || []).join(' '), HTTP80: L.http80 ? 1 : 0, NO_START_INSTALL: L.noStartInstall ? 1 : 0,
      FD_FILE: fd?.file || '', FD_VAR: fd?.mapVar || '', FD_BACKEND: fd?.backend || '', CERT_EMAIL: plan.email || '',
    },
    contents: {
      content_site_http: httpOnlySite(plan.domain, `站点 ${plan.name}`, `lsm vps site add ${plan.name}`),
      content_site_full: genericSite({ name: plan.name, domain: plan.domain, upstreamPort: plan.upstreamPort, listen: L.listen, clientAddress: L.clientAddress, http80: L.http80 }),
    },
    body: 'site-add.sh', now,
  });
}

/** 列证书（只读）。 */
export function certsScript(vps, { now = new Date() } = {}) {
  return assemble({
    title: '列证书（只读）',
    about: ['只看：这台 VPS 上的 Let\'s Encrypt 证书、nginx 里引用的别的证书文件，各自哪天到期。'],
    params: { SSH_PORT: vps.port },
    body: 'certs-list.sh', now,
  });
}

/** 扫一遍已有的站点和证书（只读）。 */
export function scanScript(vps, { now = new Date() } = {}) {
  return assemble({
    title: '扫一遍已有的站点和证书（只读）',
    about: ['只看：nginx 的配置（nginx -T）、证书和到期日、谁占着 80 / 443、服务管家在这台装过什么。不装包、不写文件、不 reload。'],
    params: { SSH_PORT: vps.port },
    body: 'scan.sh', now,
  });
}

/** 搭隧道入口。 */
export function tunnelSetupScript(plan, { now = new Date() } = {}) {
  return assemble({
    title: `搭隧道入口 https://${plan.domain}`,
    about: [
      ...RERUN,
      '做的事：装 nginx、certbot、ufw、自动安全更新（缺哪个装哪个）；防火墙只开 ssh、80、443；',
      `  建只能做端口转发的受限账号 ${plan.account}（只许把 127.0.0.1:${plan.remotePort} 转回电脑，不能登录、不能执行命令——钥匙那行带 command="/bin/false"）；`,
      `  签 ${plan.domain} 的证书（Let's Encrypt，80 端口 webroot），写 nginx 站点（WebSocket、真实 IP、HSTS），续期后自动让 nginx 读新证书。`,
      '也能自己登进 VPS 跑：sudo bash 这个文件。电脑那半（登记隧道服务）回到电脑上跑 lsm vps setup tunnel --local-only。',
    ],
    params: {
      MODE: 'tunnel', SSH_PORT: plan.vps.port, PUBLIC_IP: plan.publicIp, DOMAIN: plan.domain, SITE: plan.site,
      TUNNEL_USER: plan.account, TUNNEL_PORT: plan.remotePort, TUNNEL_PUBKEY: plan.tunnelPubkey, CERT_EMAIL: plan.email || '',
    },
    contents: {
      content_site_http: httpOnlySite(plan.domain, '二狗（ergo）的隧道入口'),
      content_site_full: ergoTunnelSite({ domain: plan.domain, upstreamPort: plan.remotePort }),
    },
    body: 'setup-tunnel.sh', now,
  });
}

/** 搭 headscale。wantAuthKey：顺便发一把给电脑加入用的一次性钥匙（本机自动加入时要）。 */
export function headscaleSetupScript(plan, { now = new Date(), wantAuthKey = false } = {}) {
  return assemble({
    title: `搭自建 tailnet 的控制节点 https://${plan.domain}`,
    about: [
      ...RERUN,
      `做的事：装 nginx、certbot、ufw、自动安全更新；防火墙只开 ssh、80、443${plan.derp ? '、3478/udp（自建中转）' : ''}；`,
      plan.hsMirror
        ? `  从镜像 ${plan.hsMirror} 下载 headscale ${plan.hsVersion} 的安装包（sha256 只认 GitHub 发布页 checksums.txt 里的值）装上，写配置（DNS 记录走 extra_records_path），`
        : `  从 GitHub 发布页下载 headscale ${plan.hsVersion} 的安装包（核对 sha256）装上，写配置（DNS 记录走 extra_records_path），`,
      `  只听本机 127.0.0.1:${plan.hsPort}；签 ${plan.domain} 的证书、写 nginx 站点；建用户 ${plan.hsUser}${wantAuthKey ? '，发一把电脑加入用的一次性钥匙（1 小时内有效）' : ''}。`,
      '也能自己登进 VPS 跑：sudo bash 这个文件。电脑那半（加入 tailnet）回到电脑上跑 lsm vps setup headscale --local-only。',
    ],
    params: {
      MODE: 'headscale', SSH_PORT: plan.vps.port, PUBLIC_IP: plan.publicIp, DOMAIN: plan.domain, SITE: plan.site,
      HS_VERSION: plan.hsVersion, HS_MIRROR: plan.hsMirror || '', HS_PORT: plan.hsPort, HS_USER: plan.hsUser, HS_DERP: plan.derp ? 1 : 0,
      WANT_AUTHKEY: wantAuthKey ? 1 : 0, CERT_EMAIL: plan.email || '',
    },
    contents: {
      content_site_http: httpOnlySite(plan.domain, 'headscale'),
      content_site_full: headscaleSite({ domain: plan.domain, upstreamPort: plan.hsPort }),
      content_headscale_config: headscaleConfig({ domain: plan.domain, publicIp: plan.publicIp, port: plan.hsPort, derp: plan.derp }),
    },
    body: 'setup-headscale.sh', now,
  });
}

/** 撤掉一种方式或一个站点（mode 是 tunnel / headscale / site）。revokeAdmin：这是最后一样了，顺手把管理用的钥匙从 VPS 上拿掉。 */
export function removeScript(mode, rec, { vps, adminPubkey = '', revokeAdmin = false, now = new Date() } = {}) {
  const what = { tunnel: '隧道入口', headscale: 'headscale', site: `站点 ${rec.name}` }[mode];
  const does = {
    tunnel: `做的事：拿掉 nginx 站点、删 ${rec.domain} 的证书、删受限账号 ${rec.account}，关上只给它开的端口；`,
    headscale: `做的事：停掉并卸载 headscale（连同它的数据：tailnet 里登记的设备一起没了）、拿掉 nginx 站点、删 ${rec.domain} 的证书，关上只给它开的端口；`,
    site: `做的事：拿掉 nginx 站点${rec.frontdoor ? `、前门 ${rec.frontdoor.file} 里加的那一行` : ''}、${rec.certOurs === false ? `${rec.domain} 的证书原来就有，留着` : `删 ${rec.domain} 的证书`}，关上只给它开的端口；`,
  }[mode];
  return assemble({
    title: `撤掉 ${what}（${rec.domain}）`,
    about: [
      '能重复跑：已经撤掉的跳过。',
      does,
      '  两种方式和所有站点都撤完时，原来没有、是这里装的 nginx / certbot / ufw 也一起撤掉，原来就有的不动；自动安全更新留着（不跟着关）。',
      ...(revokeAdmin ? ['  最后把管理用的钥匙从 authorized_keys 里拿掉（之后这台 VPS 不再认电脑上的那把钥匙）。'] : []),
    ],
    params: {
      MODE: mode, SSH_PORT: vps.port, DOMAIN: rec.domain, SITE: rec.site,
      TUNNEL_USER: rec.account || 'ergo-tunnel', TUNNEL_PORT: rec.remotePort || 18811, HS_PORT: rec.hsPort || 8080,
      ...(mode === 'site' ? {
        SITE_NAME: rec.name, FD_FILE: rec.frontdoor?.file || '', FD_VAR: rec.frontdoor?.mapVar || '', CERT_OURS: rec.certOurs === false ? 0 : 1,
      } : {}),
      ADMIN_PUBKEY: adminPubkey, REVOKE_ADMIN: revokeAdmin ? 1 : 0,
    },
    body: 'remove.sh', now,
  });
}

/** 现在怎样（只读）。 */
export function statusScript(state, { now = new Date() } = {}) {
  const t = state.modes.tunnel, h = state.modes.headscale;
  return assemble({
    title: '现在怎样（只读）',
    about: ['只看：服务在不在跑、隧道接上没有、证书哪天到期。'],
    params: {
      SSH_PORT: state.vps.port, DOMAINS: [t?.domain, h?.domain, ...Object.values(state.sites || {}).map((s) => s.domain)].filter(Boolean).join(' '),
      TUNNEL_USER: t?.account || 'ergo-tunnel', TUNNEL_PORT: t?.remotePort || 18811, HS_PORT: h?.hsPort || 8080,
    },
    body: 'status.sh', now,
  });
}

/** 解析脚本输出里的标记行。 */
export function parseOutput(text) {
  const s = String(text);
  const kv = {};
  for (const m of s.matchAll(/^([A-Z][A-Z0-9_]*)=(.*)$/gm)) kv[m[1]] = m[2].trim();
  return {
    kv,
    steps: [...s.matchAll(/^ERGO-STEP (\S+) (ok|skip)(?: (.*))?$/gm)].map((m) => ({ step: m[1], status: m[2], note: m[3] || '' })),
    results: Object.fromEntries([...s.matchAll(/^ERGO-RESULT ([A-Z_]+)=(\S+)$/gm)].map((m) => [m[1], m[2]])),
    warnings: [...s.matchAll(/^ERGO-WARN (.*)$/gm)].map((m) => m[1]),
    failure: (/^ERGO-FAIL (.*)$/m.exec(s) || [])[1] || null,
    done: [...s.matchAll(/^ERGO-DONE (\S+)/gm)].map((m) => m[1]),
  };
}

/** 显示给用户看时藏起一次性钥匙（它只交给本机的 tailscale，不显示、不落盘） */
export const maskSecrets = (text) => String(text).replace(/^(ERGO-RESULT AUTHKEY=)\S+/gm, '$1（一次性加入钥匙，已收下，不显示）');
