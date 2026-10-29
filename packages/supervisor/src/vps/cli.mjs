// `lsm vps setup | status | remove | approve` 的命令行（321 号票）：解析参数、终端里问答、接上服务管家，交给 setup.mjs。
// （`lsm vps` 不带子命令、`lsm vps refresh` 仍是 VPS 订阅到期提醒，在 bin/lsm.mjs 里。）
import readline from 'node:readline';
import { loadExec } from './exec.mjs';
import * as flow from './setup.mjs';
import * as sites from './sites.mjs';

export const USAGE = `用法：
  lsm vps setup headscale|tunnel --host root@<VPS 的 IP> [选项]   一条命令在 VPS 上搭好（先体检、整份显示脚本、你同意了才跑）
  lsm vps status                                                  通不通、证书哪天到期、电脑这头怎样（只读）
  lsm vps remove headscale|tunnel                                 把装上去的原样撤掉（同样先显示、同意了才跑）
  lsm vps approve <手机登录页给的那一串>                          把手机登记进自建的 tailnet
  lsm vps site add <名字> --port <端口> [--domain <域名>]           加一个 https 站点：https://<名字>.<IP>.sslip.io → VPS 本机的 127.0.0.1:<端口>
  lsm vps site remove <名字>                                      把这个站点原样撤掉
  lsm vps certs                                                   VPS 上的证书和到期日（只读；少于 20 天提醒）
  lsm vps scan [--host root@<IP>]                                 只读扫一遍 VPS 上已有的站点和证书，认领进状态文件（不改它们）
  lsm vps [refresh]                                               VPS 订阅到期提醒（另一回事，见 README）

setup 的选项：
  --host [用户@]主机[:端口]   VPS 地址（第一次要给；之后记在状态文件里）     --port <ssh 端口>
  --domain <域名>             默认 <名字>.<IP>.sslip.io（不用买域名）        --name <名字>  默认隧道 ergo、headscale hs
  --email <邮箱>              Let's Encrypt 的到期提醒发到这里（可不填）
  --yes                       不问"照这份脚本执行？"（脚本照样整份显示）
  --print-script              只打印要在 VPS 上跑的脚本（自己登进 VPS 用 sudo bash 跑）
  --local-only                VPS 那半已经自己跑过了，只做电脑这一半和验收
  隧道：--remote-port <VPS 上的端口，默认 18811>  --service-id <服务管家里的 id，默认 ergo-vps-tunnel>  --no-start
        电脑这头只接二狗的外网端口 8811（--local-port 能改，但绝不接受 8810）
  headscale：--no-derp（不自建中转，不开 3478/udp）  --headscale-version <版本，默认 0.26.1>  --headscale-port <默认 8080>
             --headscale-mirror <前缀>（连 GitHub 慢时安装包从镜像下：地址 = 前缀 + GitHub 原地址；sha256 照样只认 GitHub 发布页的）

site add 的选项：--port <站点后面那个服务在 VPS 上听的端口>  --ssh-port <ssh 端口>  --domain  --email  --yes  --print-script
  --public（站点本来就公开、不带凭证也能打开）  --stop-unit <单元>（80 被别的程序占着时签证书要临时停的 systemd 单元，默认体检认出来的）
  --frontdoor-backend 127.0.0.1:<端口>（443 前面有 stream 前门、认不出前门后面的站点听哪个地址时手给）

详细步骤和每步做了什么：packages/supervisor/docs/vps.md（setup）、packages/supervisor/docs/vps-https.md（站点和证书）`;

const BOOL = new Set(['yes', 'print-script', 'local-only', 'no-start', 'no-derp', 'public']);
const VALUE = new Set(['host', 'port', 'domain', 'name', 'email', 'remote-port', 'local-port', 'service-id', 'headscale-version', 'headscale-port', 'headscale-mirror', 'tailscale', 'ssh-port', 'stop-unit', 'frontdoor-backend']);

/** 参数 → { positional, opts }。不认识的选项报错（打错字别悄悄当没写）。 */
export function parseArgs(args) {
  const positional = [];
  const o = {};
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (!a.startsWith('--')) { positional.push(a); continue; }
    const eq = a.indexOf('=');
    const k = (eq > 0 ? a.slice(2, eq) : a.slice(2));
    if (BOOL.has(k)) { o[k] = true; continue; }
    if (!VALUE.has(k)) throw new Error(`不认识的选项：${a}`);
    const v = eq > 0 ? a.slice(eq + 1) : args[++i];
    if (v == null || v === '') throw new Error(`${a} 后面要跟一个值`);
    o[k] = v;
  }
  return {
    positional,
    opts: {
      host: o.host, port: o.port, domain: o.domain, name: o.name, email: o.email,
      yes: !!o.yes, printScript: !!o['print-script'], localOnly: !!o['local-only'], noStart: !!o['no-start'],
      remotePort: o['remote-port'], localPort: o['local-port'], serviceId: o['service-id'],
      hsVersion: o['headscale-version'], hsPort: o['headscale-port'], hsMirror: o['headscale-mirror'], tailscaleCli: o.tailscale,
      sshPort: o['ssh-port'], stopUnit: o['stop-unit'], frontdoorBackend: o['frontdoor-backend'],
      ...(o.public ? { public: true } : {}),
      ...(o['no-derp'] ? { derp: false } : {}),
    },
  };
}

/** 终端里的问答。stdin 是管道时一行一行读（测试、脚本里用）。 */
export function terminalIo({ input = process.stdin, output = process.stdout } = {}) {
  let rl = null;
  const lines = [];
  const waiting = [];
  let closed = false;
  const open = () => {
    if (rl) return;
    rl = readline.createInterface({ input, terminal: false });
    rl.on('line', (l) => { const w = waiting.shift(); if (w) w(l); else lines.push(l); });
    rl.on('close', () => { closed = true; while (waiting.length) waiting.shift()(null); });
  };
  const ask = (prompt) => {
    output.write(prompt);
    open();
    if (lines.length) return Promise.resolve(lines.shift());
    if (closed) return Promise.resolve(null);
    return new Promise((r) => waiting.push(r));
  };
  return {
    say: (l) => output.write(`${l}\n`),
    ask,
    async confirm(q, { yes = false } = {}) {
      if (yes) { output.write(`${q} [y/N] y（--yes）\n`); return true; }
      const a = await ask(`${q} [y/N] `);
      return /^(y|yes|是|好)$/i.test(String(a || '').trim());
    },
    close() { rl?.close(); },
  };
}

/**
 * 跑一条 `lsm vps …`。lsmFactory()：要动服务管家时才接上（管理器在跑就经它，不在就本地直连）。
 * 返回退出码。
 */
export async function runVps(args, { lsmFactory, io = terminalIo(), exec: givenExec = null, now = () => new Date(), sleep = (ms) => new Promise((r) => setTimeout(r, ms)) } = {}) {
  let parsed;
  try { parsed = parseArgs(args); } catch (e) { io.say(`✗ ${e.message}`); io.say(USAGE); return 1; }
  const [sub, arg] = parsed.positional;
  const exec = givenExec || await loadExec();
  let lsm = null;
  const ctx = {
    exec, io, now, sleep,
    // 执行层自带 lsm（测试用的假执行层）就用它：测试里绝不起真的 ssh、绝不连真的管理器
    lsm: async () => { lsm ??= exec.lsm || await lsmFactory(); return lsm; },
  };
  try {
    switch (sub) {
      case 'setup':
        if (!['headscale', 'tunnel'].includes(arg)) { io.say('✗ 用法：lsm vps setup headscale|tunnel --host root@<VPS 的 IP>'); return 1; }
        return await flow.setup(arg, parsed.opts, ctx);
      case 'status': return await flow.status(parsed.opts, ctx);
      case 'remove':
        if (!['headscale', 'tunnel'].includes(arg)) { io.say('✗ 用法：lsm vps remove headscale|tunnel'); return 1; }
        return await flow.remove(arg, parsed.opts, ctx);
      case 'site':
        if (arg === 'add' && parsed.positional[2]) return await sites.siteAdd(parsed.positional[2], parsed.opts, ctx);
        if (arg === 'remove' && parsed.positional[2]) return await sites.siteRemove(parsed.positional[2], parsed.opts, ctx);
        io.say('✗ 用法：lsm vps site add <名字> --port <端口> | lsm vps site remove <名字>');
        return 1;
      case 'certs': return await sites.certs(parsed.opts, ctx);
      case 'scan': return await sites.scan(parsed.opts, ctx);
      case 'approve':
        if (!arg) { io.say('✗ 用法：lsm vps approve <手机登录页给的那一串>'); return 1; }
        return await flow.approve(arg, parsed.opts, ctx);
      default:
        io.say(USAGE);
        return sub ? 1 : 0;
    }
  } finally { io.close?.(); }
}
