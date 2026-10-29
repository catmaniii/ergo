// 体检（321 号票）：VPS 上跑只读的 sh/checkup.sh，本机解析、判断能不能搭；再从电脑上连一下 VPS 的端口，
// 看云厂商的安全组放没放行（程序不替你开安全组，只告诉你去开哪几个）。
import { parseOutput } from './scripts.mjs';

const has = (v) => v != null && String(v).trim() !== '';

/** "9.2" → [9, 2]；认不出来是 null */
function version(v) {
  const m = /^(\d+)\.(\d+)/.exec(String(v || ''));
  return m ? [Number(m[1]), Number(m[2])] : null;
}
const atLeast = (v, [a, b]) => v && (v[0] > a || (v[0] === a && v[1] >= b));

/** 这种方式要在安全组 / 防火墙里放行的端口 */
export function neededPorts(plan) {
  const ports = [{ proto: 'tcp', port: plan.vps.port, why: 'ssh' }, { proto: 'tcp', port: 80, why: '签证书、跳 https' }, { proto: 'tcp', port: 443, why: 'https' }];
  if (plan.mode === 'headscale' && plan.derp) ports.push({ proto: 'udp', port: 3478, why: '自建中转打洞（STUN）' });
  return ports;
}

export const portsText = (ports) => ports.map((p) => `${p.proto.toUpperCase()} ${p.port}`).join('、');

/** 解析体检输出 → 键值。没跑完（没有开头那行）就是 null。 */
export function parseCheckup(text) {
  const { kv } = parseOutput(text);
  return /^ERGO-CHECKUP=1$/m.test(String(text)) ? kv : null;
}

/**
 * 能不能搭：blocking（停下，不往上装）、warnings（照样能搭，但要你知道）、info（照它怎么做）。
 * kv 是 parseCheckup 的结果，plan 是这次要搭的东西。
 */
export function assessCheckup(kv, plan) {
  const blocking = [], warnings = [], info = [];
  if (!kv) return { blocking: ['体检脚本没跑完（输出里没有开头那一行）'], warnings, info };
  const os = `${kv.OS_ID} ${kv.OS_LIKE}`;
  if (!/\b(debian|ubuntu)\b/.test(os)) blocking.push(`第一版只支持 Debian / Ubuntu，这台是 ${kv.OS_PRETTY || kv.OS_ID || '认不出来的系统'}`);
  else info.push(`系统：${kv.OS_PRETTY || kv.OS_ID}（${kv.ARCH}）`);
  if (kv.IS_ROOT !== '1') blocking.push('脚本要 root 跑：用 root 登录，或者给登录的用户免密 sudo');
  if (kv.SYSTEMD !== '1') blocking.push('没有 systemd');
  if (kv.APT !== '1') blocking.push('没有 apt-get');

  const proc = (k) => (has(kv[k]) ? kv[k] : null);
  // 443 前面有前门、80 / 443 被 nginx 以外占着：setup 停下不装；site add（plan.mode === 'site'）照布局办，由 sites.mjs 的 decideLayout 判断
  if (plan.mode !== 'site') {
    if (kv.NGINX_STREAM_443 === '1') {
      blocking.push('nginx 的 443 前面有一层 stream 前门（ssl_preread）：新站点不能直接听 443，访客的真实 IP 也要前门开了 proxy_protocol 才传得过来'
        + '（不然所有访客在二狗看来都是 127.0.0.1，配对限频挤成一个桶）。lsm vps setup 不改你现有的前门——见 docs/vps.md 的「443 前面已经有前门」');
    }
    for (const port of [80, 443]) {
      const who = proc(`LISTEN_TCP_${port}`);
      if (who && who !== 'nginx') blocking.push(`${port} 端口被 ${who} 占着：新站点要 nginx 听 ${port}${port === 80 ? '（签证书、续期也走它）' : ''}。先把它挪开（lsm vps site add 能处理"临时停、签完拉起"这种布局，setup 不处理）`);
    }
  }
  if (kv.PKG_NGINX === '1' && kv.MANIFEST_BASE !== '1') info.push('VPS 上原来就有 nginx：沿用它，只加一个站点文件，撤的时候也不卸它');

  if (plan.mode === 'headscale') {
    if ((kv.PKG_HEADSCALE === '1' || kv.HEADSCALE_BIN === '1') && kv.MANIFEST_HEADSCALE !== '1') {
      blocking.push(`这台 VPS 上原来就有 headscale（${kv.HEADSCALE_VERSION || '版本不明'}），不覆盖它——那是你现有的 tailnet。见 docs/vps.md 的「已经有 headscale」`);
    }
    const hs = proc('LISTEN_TCP_HS');
    if (hs && hs !== 'headscale') blocking.push(`127.0.0.1:${plan.hsPort} 被 ${hs} 占着：用 --headscale-port 换一个`);
    const stun = proc('LISTEN_UDP_3478');
    if (plan.derp && stun && stun !== 'headscale') blocking.push(`3478/udp 被 ${stun} 占着：自建中转要用它。不要自建中转就加 --no-derp`);
    if (!/^(amd64|arm64)$/.test(kv.ARCH || '')) blocking.push(`headscale 没有 ${kv.ARCH} 的安装包`);
  }

  if (plan.mode === 'tunnel') {
    const v = version(kv.OPENSSH_VERSION);
    if (!atLeast(v, [7, 8])) blocking.push(`OpenSSH ${kv.OPENSSH_VERSION || '版本不明'}：受限账号要用 permitlisten，得 7.8 以上`);
    const fwd = (kv.SSHD_TCP_FORWARDING || '').toLowerCase();
    if (fwd === 'no' || fwd === 'local') blocking.push(`sshd 的 AllowTcpForwarding 是 ${fwd}：反向隧道建不起来。这一版不改 sshd 的配置，请你改成 yes 或 remote`);
    if (!fwd) warnings.push('读不到 sshd 的 AllowTcpForwarding（sshd -T 没跑起来），默认是允许的');
    const users = (kv.SSHD_ALLOW_USERS || '').split(/\s+/).filter(Boolean);
    if (users.length && !users.some((u) => u === plan.account || u.startsWith(`${plan.account}@`))) {
      blocking.push(`sshd 的 AllowUsers 只放行 ${users.join(' ')}：受限账号 ${plan.account} 登不进来。请你把它加进 AllowUsers`);
    }
    if (has(kv.SSHD_ALLOW_GROUPS)) warnings.push(`sshd 设了 AllowGroups（${kv.SSHD_ALLOW_GROUPS}）：受限账号不在这些组里就登不进来`);
    const t = proc('LISTEN_TCP_TUNNEL');
    if (t && kv.MANIFEST_TUNNEL !== '1') blocking.push(`127.0.0.1:${plan.remotePort} 已经被 ${t} 占着（可能是你以前手搭的隧道）：用 --remote-port 换一个`);
  }

  if (kv.DNS_OK !== '1') blocking.push(`${plan.domain} 在 VPS 上解析不到它自己的 IP（${plan.publicIp}）：用 sslip.io 的默认名字时不该这样，先看看 VPS 的 DNS；用自己的域名先加 A 记录`);

  const rules = neededPorts(plan).filter((p) => p.why !== 'ssh').map((p) => `${p.port}/${p.proto}`).join('、');
  if (kv.FIREWALLD_ACTIVE === '1') warnings.push(`这台用的是 firewalld：脚本不动它，请自己放行 ssh 端口和 ${rules}`);
  else if (kv.UFW_ACTIVE === '1') info.push(`ufw 开着：只加放行 ${rules} 的规则`);
  else {
    info.push(`会打开 ufw，只放行 ssh（${plan.vps.port}/tcp）和 ${rules}`);
    const keep = new Set([String(plan.vps.port), '80', '443']);
    const others = String(kv.PUBLIC_TCP || '').split(/\s+/).filter((p) => p && !keep.has(p));
    if (others.length) warnings.push(`这些端口现在对外在听：${others.join(' ')}。打开防火墙后外面就进不来了——还要用的话，装完自己 ufw allow`);
  }
  if (kv.AUTO_UPGRADES !== '1') info.push('会打开自动安全更新（unattended-upgrades）');
  const disk = Number(kv.DISK_FREE_MB);
  if (Number.isFinite(disk) && disk < 300) blocking.push(`根分区只剩 ${disk} MB`);
  else if (Number.isFinite(disk) && disk < 1000) warnings.push(`根分区只剩 ${disk} MB`);
  return { blocking, warnings, info };
}

/**
 * 从电脑上连 VPS 的端口：timeout 多半是安全组没放行；refused 说明到了机器、只是还没人听（装完就有了）。
 * UDP 从这里测不出来，只提醒。
 */
export async function probePorts(exec, plan) {
  const out = [];
  for (const p of neededPorts(plan)) {
    if (p.proto !== 'tcp') { out.push({ ...p, result: 'untested' }); continue; }
    out.push({ ...p, result: await exec.tcp(plan.publicIp, p.port, { timeout: 5000 }) });
  }
  return out;
}

export function portWarnings(results) {
  const blocked = results.filter((r) => r.result === 'timeout' || String(r.result).startsWith('error'));
  const lines = blocked.map((r) => `从这里连 VPS 的 TCP ${r.port}（${r.why}）${r.result === 'timeout' ? '超时' : `出错（${r.result}）`}：多半是云厂商的安全组没放行`);
  const udp = results.filter((r) => r.result === 'untested').map((r) => `UDP ${r.port}`);
  if (udp.length) lines.push(`${udp.join('、')} 从这里测不出来：记得在安全组里也放行`);
  return lines;
}
