// 管理器读写的每一个路径都从这里取，别的地方不自己拼（327 号票）。
//
// 两个目录：
//  - 代码目录（ROOT，就是 packages/supervisor）：bin/、webui/、deploy/、examples/——跟着版本走，装成安装包后会整个换掉。
//  - 数据目录（DATA_DIR）：你的服务清单（registry/）、账本（state.json）、日志（logs/）、密钥（.secrets/）、
//    tailnet 网关的路由表（tailnet-routes.json）——是你的，换版本不能动它。
//
// 数据目录按这个顺序定，只在这里定一次：
//  1. 命令行 `--data-dir <目录>`（lsm 的任何命令、tailnet-gateway 都认；install-autostart 会把它写进计划任务）；
//  2. 环境变量 LSM_DATA_DIR（测试用它指向临时目录，绝不碰本机正在用的那份）；
//  3. 默认 %LOCALAPPDATA%\ergo\supervisor。
//
// 「沿用旧位置」：327 之前数据就放在 LSM 自己的代码目录里，目录里的布局和这里一模一样
// （registry/、state.json、logs/、.secrets/、tailnet-routes.json）。把 --data-dir 或 LSM_DATA_DIR 指向旧目录，
// 新代码就原样接着用旧数据；确认没问题后把这五样原样搬到默认位置、去掉这个开关即可。
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** 命令行里指定数据目录的参数名 */
export const DATA_DIR_FLAG = '--data-dir';

/** 默认的数据目录：%LOCALAPPDATA%\ergo\supervisor（不跟着漫游：PID、日志、计划任务都只对这台机器有意义） */
export function defaultDataDir(env = process.env) {
  const local = env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
  return path.join(local, 'ergo', 'supervisor');
}

/** argv 里 `--data-dir <目录>` / `--data-dir=<目录>` 给的值；没给就是 null */
export function dataDirArg(argv = process.argv) {
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === DATA_DIR_FLAG && argv[i + 1]) return argv[i + 1];
    if (a.startsWith(`${DATA_DIR_FLAG}=`) && a.length > DATA_DIR_FLAG.length + 1) return a.slice(DATA_DIR_FLAG.length + 1);
  }
  return null;
}

/** 去掉 argv 里的 `--data-dir <目录>`，剩下的交给各命令自己解析 */
export function withoutDataDirArg(argv) {
  const out = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === DATA_DIR_FLAG) { i++; continue; }
    if (argv[i].startsWith(`${DATA_DIR_FLAG}=`)) continue;
    out.push(argv[i]);
  }
  return out;
}

/** 数据目录和它是从哪来的（from：flag / env / default） */
export function resolveDataDir({ argv = process.argv, env = process.env } = {}) {
  const flag = dataDirArg(argv);
  if (flag) return { dir: path.resolve(flag), from: 'flag' };
  if (env.LSM_DATA_DIR) return { dir: path.resolve(env.LSM_DATA_DIR), from: 'env' };
  return { dir: defaultDataDir(env), from: 'default' };
}

const resolved = resolveDataDir();
export const DATA_DIR = resolved.dir;
/** 数据目录是怎么定的：flag（命令行）/ env（LSM_DATA_DIR）/ default */
export const DATA_DIR_FROM = resolved.from;
export const REGISTRY_DIR = path.join(DATA_DIR, 'registry');
export const SERVICES_DIR = path.join(REGISTRY_DIR, 'services');
// 接入的项目经协议登记的「名下的服务」：services/owned/<登记方>/<名字>.yaml
export const OWNED_DIR = path.join(SERVICES_DIR, 'owned');
export const MANAGER_YAML = path.join(REGISTRY_DIR, 'manager.yaml');
export const BOOT_FILE = path.join(REGISTRY_DIR, 'autostart.yaml');
export const STATE_FILE = path.join(DATA_DIR, 'state.json');
export const LOGS_DIR = path.join(DATA_DIR, 'logs');
export const MANAGER_LOG = path.join(LOGS_DIR, 'manager.log');
export const AUDIT_LOG = path.join(LOGS_DIR, 'audit.log');
export const TAILNET_FILE = path.join(REGISTRY_DIR, 'tailnet.yaml');
export const TAILNET_ROUTES = path.join(DATA_DIR, 'tailnet-routes.json');
// 密钥：WebUI 口令和盐、tailnet 证书、云账号的只读 AccessKey
export const SECRETS_DIR = path.join(DATA_DIR, '.secrets');
export const TAILNET_CERTS = path.join(SECRETS_DIR, 'tailnet');
// `lsm vps setup` 搭的 VPS（321 号票）：装了什么记在这里；专用钥匙（管理用、隧道用）和这台 VPS 的主机指纹放密钥区
export const VPS_STATE = path.join(DATA_DIR, 'vps-setup.json');
export const VPS_KEYS_DIR = path.join(SECRETS_DIR, 'vps-setup');
// VPS 上证书的到期日（322 号票）：lsm vps certs 写（管理器、WebUI 读它是下一步）
export const VPS_CERTS = path.join(DATA_DIR, 'vps-certs.json');
// 每次显示给你看的 VPS 脚本另存一份（setup / remove 各留最近一份），方便用编辑器细看
export const VPS_SCRIPTS_DIR = path.join(DATA_DIR, 'vps-scripts');
export const WEBUI_DIR = path.join(ROOT, 'webui');

/** manager.yaml 里写的相对路径（auth.passwordFile、vps.billing.credentials）都相对数据目录；绝对路径原样用 */
export function dataPath(p) {
  return path.isAbsolute(p) ? p : path.join(DATA_DIR, p);
}
