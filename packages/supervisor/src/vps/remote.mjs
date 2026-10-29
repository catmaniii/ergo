// 连 VPS（321 号票）：VPS 地址怎么写、专用钥匙、ssh 的命令行、把脚本送上去跑。
//
// 钥匙：本机生成两把专用的 ed25519 钥匙，放数据目录的 .secrets/vps-setup/：
//  - admin：管理用。你在 VPS 上把它的公钥放进 root（或你登录的那个用户）的 authorized_keys——
//    程序只打印那一句命令，由你自己跑，密码只进 ssh 自己的提示，程序不经手、不保存 VPS 密码；
//  - tunnel：隧道用（只有 `setup tunnel` 用）。脚本把它的公钥放进 VPS 上一个只能做端口转发的受限账号。
// 主机指纹记在同一个目录的 known_hosts（第一次连接记下，之后对不上就拒绝），不碰你自己的 ~/.ssh。
import fs from 'node:fs';
import path from 'node:path';
import { VPS_KEYS_DIR } from '../paths.mjs';

export const ADMIN_COMMENT = 'ergo-supervisor-admin';
export const TUNNEL_COMMENT = 'ergo-supervisor-tunnel';

const IPV4 = /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/;
const HOSTNAME = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{0,61}[a-z0-9]$/;
const USER = /^[a-z_][a-z0-9_-]{0,31}$/;

export const isIPv4 = (s) => IPV4.test(String(s));

/**
 * VPS 地址：`[用户@]主机[:端口]`，主机是 IPv4 或域名（第一版不认 IPv6）。用户默认 root，端口默认 22。
 * 只认这几种字符——这串东西会进 ssh 的命令行和生成的注册表文件。
 */
export function parseHost(input, { port } = {}) {
  const s = String(input || '').trim();
  const m = /^(?:([^@\s]+)@)?([^@:\s]+)(?::(\d{1,5}))?$/.exec(s);
  if (!m) throw new Error(`VPS 地址看不懂：${JSON.stringify(s)}（写成 root@203.0.113.10 或 203.0.113.10）`);
  const user = m[1] || 'root';
  const host = m[2].toLowerCase();
  const p = Number(port ?? m[3] ?? 22);
  if (!USER.test(user)) throw new Error(`用户名只能是小写字母、数字、_ 和 -：${JSON.stringify(user)}`);
  if (!isIPv4(host) && !HOSTNAME.test(host)) throw new Error(`主机只能是 IPv4 地址或域名：${JSON.stringify(host)}`);
  if (!Number.isInteger(p) || p < 1 || p > 65535) throw new Error(`ssh 端口不对：${p}`);
  return { user, host, port: p };
}

export const target = (vps) => `${vps.user}@${vps.host}`;

export function keyPaths(dir = VPS_KEYS_DIR) {
  return {
    dir,
    admin: path.join(dir, 'admin_ed25519'),
    tunnel: path.join(dir, 'tunnel_ed25519'),
    knownHosts: path.join(dir, 'known_hosts'),
  };
}

/** ssh 的 -o 值里有空格要加引号（用户名带空格的 Windows 家目录） */
const optPath = (p) => (/\s/.test(p) ? `"${p}"` : p);

/** 连 VPS 的 ssh 命令行（不问密码、只用这把钥匙、主机指纹记在专用的 known_hosts）。remote 是在 VPS 上跑的命令。 */
export function sshArgv(vps, key, knownHosts, remote) {
  return [
    'ssh', '-i', key,
    '-o', 'BatchMode=yes', '-o', 'IdentitiesOnly=yes', '-o', 'ConnectTimeout=15',
    '-o', 'StrictHostKeyChecking=accept-new', '-o', `UserKnownHostsFile=${optPath(knownHosts)}`,
    '-o', 'ServerAliveInterval=15', '-o', 'ServerAliveCountMax=4',
    '-p', String(vps.port || 22), target(vps),
    ...(remote ? [remote] : []),
  ];
}

/** 脚本从 stdin 送进 VPS 上的 bash；不是 root 就经 sudo（要免密 sudo，体检会查）。 */
export const remoteShell = (vps) => (vps.user === 'root' ? 'bash -s' : 'sudo -n bash -s');

/** 在 VPS 上跑一段脚本。onData 边跑边给输出（长脚本要让用户看到进度）。 */
export function runScript(exec, vps, keys, script, { timeout = 30 * 60000, onData } = {}) {
  return exec.run(sshArgv(vps, keys.admin, keys.knownHosts, remoteShell(vps)), { input: script, timeout, onData });
}

/** 读一把钥匙的公钥（一行）。 */
export function readPublicKey(file) {
  const line = fs.readFileSync(`${file}.pub`, 'utf-8').trim().split(/\r?\n/)[0];
  if (!/^ssh-ed25519 [A-Za-z0-9+/=]+( \S+)?$/.test(line)) throw new Error(`${file}.pub 不像一把 ed25519 公钥`);
  return line;
}

/** 没有就生成（ssh-keygen，不设口令：管理器无人值守地用它）。已经有了原样用——重跑不会换钥匙。 */
export async function ensureKey(exec, file, comment) {
  if (fs.existsSync(file) && fs.existsSync(`${file}.pub`)) return { created: false, publicKey: readPublicKey(file) };
  fs.mkdirSync(path.dirname(file), { recursive: true });
  for (const f of [file, `${file}.pub`]) fs.rmSync(f, { force: true });
  const r = await exec.run(['ssh-keygen', '-q', '-t', 'ed25519', '-N', '', '-C', comment, '-f', file], { timeout: 30000 });
  if (r.code !== 0 || !fs.existsSync(`${file}.pub`)) throw new Error(`生成钥匙失败：${(r.err || r.out).trim() || `退出码 ${r.code}`}`);
  return { created: true, publicKey: readPublicKey(file) };
}

/**
 * 让你把管理用的公钥放上 VPS 的那一句（在你自己的终端里跑，密码只进 ssh 的提示）。重复跑不会重复加。
 * PowerShell 和 cmd 里都能原样粘贴：整段远端命令在一对双引号里，里面没有 $ 和 `。
 */
export function installKeyCommand(vps, publicKey) {
  if (/['"$`\\]/.test(publicKey)) throw new Error('公钥里有不该有的字符');
  const portPart = (vps.port || 22) === 22 ? '' : `-p ${vps.port} `;
  return `ssh ${portPart}${target(vps)} "umask 077; mkdir -p ~/.ssh; grep -qxF '${publicKey}' ~/.ssh/authorized_keys 2>/dev/null || echo '${publicKey}' >> ~/.ssh/authorized_keys"`;
}

/** 试一下钥匙能不能登进去（BatchMode：不会停下来问密码）。 */
export async function canLogin(exec, vps, keys) {
  const r = await exec.run(sshArgv(vps, keys.admin, keys.knownHosts, 'echo ERGO-LOGIN-OK'), { timeout: 30000 });
  if (r.code === 0 && /ERGO-LOGIN-OK/.test(r.out)) return { ok: true };
  const last = (r.err || r.out).trim().split(/\r?\n/).pop() || `退出码 ${r.code}`;
  const why = /Permission denied/i.test(last) ? '钥匙还没放上去（Permission denied）'
    : /Host key verification failed|REMOTE HOST IDENTIFICATION HAS CHANGED/i.test(r.err) ? 'VPS 的主机指纹和第一次记下的对不上——如果你重装过 VPS，删掉 .secrets/vps-setup/known_hosts 再来；不然先别连，查清楚是不是连错了机器'
      : /timed out|Connection refused|No route|Could not resolve/i.test(last) ? `连不上：${last}` : last;
  return { ok: false, why };
}
