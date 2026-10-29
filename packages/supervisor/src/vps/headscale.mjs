// 自建 tailnet 的控制节点（headscale）：VPS 上的配置、电脑加入、手机加入的步骤（321 号票）。
//
// 配置整份由这里生成，只认 HEADSCALE_VERSION 这一版的格式（headscale 的配置格式跨版本会变）；
// 换版本（--headscale-version）时先对照那一版的 config-example.yaml，脚本里的 headscale configtest 不过会换回原来的配置。
import { DEFAULT_CLI, DEFAULT_RECORDS } from '../tailnet.mjs';

export const HEADSCALE_VERSION = '0.26.1';
export const HEADSCALE_PORT = 8080;
export const HEADSCALE_USER = 'ergo';
/** tailnet 里设备的短名字挂在这个后缀下（不能是 headscale 自己域名的上级） */
export const BASE_DOMAIN = 'ergo-tailnet.internal';
/** headscale 下发给设备的 DNS：一个国外的、一个国内的 */
export const NAMESERVERS = ['1.1.1.1', '223.5.5.5'];

const MIRROR = /^https?:\/\/[A-Za-z0-9.-]+(:\d{1,5})?(\/[A-Za-z0-9._~%/+=-]*)?$/;

/**
 * 下载安装包的镜像（--headscale-mirror，给连 GitHub 慢的 VPS 用）：前缀式，安装包地址 = 前缀 + GitHub 上的原地址
 * （国内常见的 GitHub 加速都是这种写法）。只换安装包从哪下；sha256 照样只认 GitHub 发布页 checksums.txt 里的值，
 * 校验和不从镜像取。空的 = 不用镜像。返回规整过的前缀（补上结尾的 /）。
 */
export function normalizeMirror(s) {
  const v = String(s ?? '').trim();
  if (!v) return '';
  if (!MIRROR.test(v)) throw new Error(`--headscale-mirror 要写成 https://镜像地址/ 这样的前缀（安装包地址 = 前缀 + GitHub 上的原地址）：${JSON.stringify(v)}`);
  return v.endsWith('/') ? v : `${v}/`;
}

/** headscale 的配置（YAML）。derp：要不要开内置的中转（国内设备之间连不上时走它，比 Tailscale 官方的中转快）。 */
export function headscaleConfig({ domain, publicIp, port = HEADSCALE_PORT, derp = true }) {
  return `# headscale ${HEADSCALE_VERSION} 的配置：由二狗的服务管家（lsm vps setup headscale）整份写的，重跑会覆盖。
# 安装包自带的那份留在 config.yaml.ergo-orig（lsm vps remove 时还原或连同 headscale 一起卸掉）。
server_url: https://${domain}
listen_addr: 127.0.0.1:${port}
metrics_listen_addr: 127.0.0.1:9090
grpc_listen_addr: 127.0.0.1:50443
grpc_allow_insecure: false

noise:
  private_key_path: /var/lib/headscale/noise_private.key

prefixes:
  v4: 100.64.0.0/10
  v6: fd7a:115c:a1e0::/48
  allocation: sequential

derp:
  server:
    # 内置中转：经 https://${domain}/derp（nginx 转进来），打洞用 3478/udp
    enabled: ${derp ? 'true' : 'false'}
    region_id: 999
    region_code: ergo
    region_name: ergo self-hosted DERP
    stun_listen_addr: 0.0.0.0:3478
    private_key_path: /var/lib/headscale/derp_server_private.key
    automatically_add_embedded_derp_region: true
    ipv4: ${publicIp}
  urls:
    - https://controlplane.tailscale.com/derpmap/default
  paths: []
  auto_update_enabled: true
  update_frequency: 24h

disable_check_updates: true
ephemeral_node_inactivity_timeout: 30m

database:
  type: sqlite
  sqlite:
    path: /var/lib/headscale/db.sqlite
    write_ahead_log: true

log:
  level: info
  format: text

policy:
  mode: file
  path: ""

dns:
  magic_dns: true
  base_domain: ${BASE_DOMAIN}
  # 设备的 DNS 都交给 tailnet：tailnet 入口的名字（服务管家写进下面那个文件）在 tailnet 里才解析得到
  override_local_dns: true
  nameservers:
    global:
${NAMESERVERS.map((n) => `      - ${n}`).join('\n')}
  search_domains: []
  extra_records_path: ${DEFAULT_RECORDS}

unix_socket: /var/run/headscale/headscale.sock
unix_socket_permission: "0770"

logtail:
  enabled: false

randomize_client_port: false
`;
}

/** 电脑上的 tailscale 现在连着谁（读 `tailscale debug prefs` 的 ControlURL 和 `tailscale status --json`）。 */
export async function localNode(exec, cli = DEFAULT_CLI) {
  const st = await exec.run([cli, 'status', '--json'], { timeout: 15000 });
  if (st.code === -1) return { installed: false, why: st.err };
  let status = null;
  try { status = JSON.parse(st.out); } catch { /* 没登录时有的版本不给 JSON */ }
  const prefs = await exec.run([cli, 'debug', 'prefs'], { timeout: 15000 });
  let controlURL = null;
  try { controlURL = JSON.parse(prefs.out).ControlURL || null; } catch { /* 读不到就当不知道 */ }
  return { installed: true, backend: status?.BackendState || null, controlURL, self: status?.Self?.HostName || null };
}

/**
 * 电脑加入要不要做、怎么做：
 *  - 已经连着这台 headscale：不用做；
 *  - 没登录、没连任何地方：用一次性钥匙 `tailscale up --login-server … --auth-key …`；
 *  - 正连着别的 tailnet：不动它（换过来会把这台电脑从现在的 tailnet 上摘下来），打印命令让你自己决定。
 */
export function joinPlan(node, domain) {
  const url = `https://${domain}`;
  if (!node.installed) return { action: 'install', why: '这台电脑没装 Tailscale（https://tailscale.com/download 装好再跑 lsm vps setup headscale --local-only）' };
  if (node.controlURL && node.controlURL.replace(/\/+$/, '') === url && node.backend === 'Running') return { action: 'none', why: `已经连着 ${url}` };
  const elsewhere = node.backend === 'Running' && node.controlURL && node.controlURL.replace(/\/+$/, '') !== url;
  if (elsewhere) return { action: 'manual', why: `这台电脑正连着别的 tailnet（${node.controlURL}）。换到新的会把它从那边摘下来，所以没动` };
  return { action: 'join', url };
}

export function joinArgv(cli, domain, authKey) {
  return [cli, 'up', `--login-server=https://${domain}`, `--auth-key=${authKey}`, '--accept-dns=true', '--reset', '--unattended'];
}

/** 你自己换过去时跑的命令（不带钥匙：浏览器登录后在 VPS 上批准，见手机那几步） */
export const manualJoinCommand = (cli, domain) => `& "${cli}" up --login-server=https://${domain} --accept-dns=true --reset --unattended`;

/** 手机加入的步骤（终端里打印）。 */
export function phoneSteps(domain) {
  return [
    `手机加入这个 tailnet（安卓、iPhone 都装官方的 Tailscale App）：`,
    `  1. 打开 Tailscale App，先别点登录。`,
    `     安卓：右上角 ⋮ →「Change server」（或「使用其他服务器」），填 https://${domain}；`,
    `     iPhone：系统「设置」→ 往下找到 Tailscale →「Alternate Coordination Server URL」填 https://${domain}，再回 App。`,
    `  2. 点登录，浏览器会打开一页，上面有一行 headscale nodes register --user … --key <一串>。`,
    `  3. 把那一串（--key 后面的）复制下来，在电脑上跑：lsm vps approve <那一串>`,
    `     （等于在 VPS 上跑那一行，把手机登记到 ${HEADSCALE_USER} 名下）。`,
    `  4. 回到 App，几秒内显示已连接。安卓上确认「使用 Tailscale DNS」开着——tailnet 入口的名字只在 tailnet 的 DNS 里解析得到。`,
  ];
}

/** 手机登录页给的那一串：只认字母数字和 : _ -（它要进 VPS 上的命令行） */
export function validRegistrationKey(s) {
  return /^[A-Za-z0-9:_-]{8,128}$/.test(String(s || ''));
}

/** 把手机登记进来的那一句（VPS 上跑） */
export function approveScript(user, key) {
  if (!validRegistrationKey(key)) throw new Error('这一串不像 headscale 登录页给的 key');
  if (!/^[a-z0-9_-]+$/.test(user)) throw new Error(`用户名不对：${user}`);
  return `set -euo pipefail\nheadscale nodes register --user ${user} --key ${key} || { uid=$(headscale users list -o json-line | grep -Eo '"id": *"?[0-9]+"?, *"name": *"${user}"' | grep -Eo '[0-9]+' | head -1); headscale nodes register --user "$uid" --key ${key}; }\necho ERGO-DONE approve\n`;
}
