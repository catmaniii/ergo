// @i18n-ignore-file log：部署命令（命令行工具）的输出和 VPS 上跑的脚本
// 部署公网入口的 nginx 站点：一次 ssh 上 VPS 的动作，"对外发送或发布"一类。
// 落实为用户在本机亲手运行部署命令（src/deploy-nginx.ts），运行即确认，不另出卡；守护进程和任何 agent 都不会自己
// 发起部署（只有部署命令的入口引用这个模块，test/deploy/deploy.test.ts 扫源码检查）。部署不是 agent 的工具调用，不经守卫。
//
// 做法：一条 ssh，VPS 上跑 `sh -s`，脚本和生成的配置都从 stdin 送过去（不在命令行上拼引号）：
// 写进 sites-available/<站点名>.conf（默认那份是 ergo.conf，ergo init 建的一份是它的登记 id，比如 ergo-b.conf；旧的留一份 .bak）、链接到 sites-enabled、nginx -t 通过才 reload，
// 没通过就恢复原来的配置并以非零退出。证书沿用 VPS 上现有的 Let's Encrypt 做法，这里不签证书。
import { spawn } from "node:child_process";
import { loadConfig } from "../config/config.ts";
import { InstanceMarkerError, readMarker } from "../cli/instances.ts";
import { dataDirLayout } from "../config/data-dir.ts";
import { nginxSiteConfig } from "./nginx.ts";
import { loadPublicAccess, type PublicAccess } from "./public-access.ts";

/** 执行一条命令（argv[0] 是程序），stdin 送进去；输出直接给用户看。测试换成假的 */
export type CommandExecutor = (argv: readonly string[], stdin: string) => Promise<{ status: number }>;

/** 默认那份（~/.ergo，没有实例标记）的站点名 */
export const DEFAULT_SITE_NAME = "ergo";

/**
 * 这一份的站点名：数据文件夹里有 ergo init 留下的实例标记，就用它的登记 id（标记里的名字已按 INSTANCE_NAME 严格校验过，
 * 只有小写字母、数字、连字符）；没有就是默认那份的 ergo。一台电脑上的多份各写各的站点文件，互不覆盖。
 * 标记坏了抛 InstanceMarkerError（认不准是哪一份就不部署）
 */
export function siteNameFor(dataDir: string): string {
  return readMarker(dataDir)?.serviceId ?? DEFAULT_SITE_NAME;
}

function sitePaths(name: string): { site: string; enabled: string } {
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name)) throw new Error(`站点名不合规：${name}`);
  return { site: `/etc/nginx/sites-available/${name}.conf`, enabled: `/etc/nginx/sites-enabled/${name}.conf` };
}

const HEREDOC = "ERGO_NGINX_SITE_EOF";

/** ssh 的命令行：不问密码（BatchMode）、第一次连接记下主机指纹；远端跑 sh -s，读 stdin 里的脚本 */
export function sshArgv(access: PublicAccess): string[] {
  return ["ssh", "-i", access.sshKey, "-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=accept-new", `${access.sshUser}@${access.vpsHost}`, "sh -s"];
}

/** VPS 上执行的脚本（配置原样夹在里面） */
export function remoteScript(config: string, siteName: string = DEFAULT_SITE_NAME): string {
  if (config.split("\n").includes(HEREDOC)) throw new Error("站点配置里出现了脚本的分隔行");
  const { site: SITE, enabled: ENABLED } = sitePaths(siteName);
  return `set -eu
tmp=$(mktemp)
cat > "$tmp" <<'${HEREDOC}'
${config}${HEREDOC}
if [ -f ${SITE} ]; then cp ${SITE} ${SITE}.bak; fi
install -m 644 "$tmp" ${SITE}
rm -f "$tmp"
ln -sf ${SITE} ${ENABLED}
if nginx -t; then
  systemctl reload nginx
  echo "nginx 已加载新的站点配置"
else
  if [ -f ${SITE}.bak ]; then mv ${SITE}.bak ${SITE}; else rm -f ${SITE} ${ENABLED}; fi
  echo "nginx -t 没通过，已恢复原来的配置" >&2
  exit 1
fi
`;
}

export interface DeployCommandOptions {
  /** 命令行参数（不含 node 和脚本）：--print 只打印配置 */
  argv: readonly string[];
  env: Readonly<Record<string, string | undefined>>;
  homeDir: string;
  exec: CommandExecutor;
  log: (line: string) => void;
}

/** 部署命令本身：读配置、生成站点配置、ssh 一次。返回退出码 */
export async function runDeployCommand(options: DeployCommandOptions): Promise<number> {
  const { log } = options;
  let access: PublicAccess;
  let siteName: string;
  try {
    const config = loadConfig({ env: options.env, homeDir: options.homeDir });
    access = loadPublicAccess(dataDirLayout(config.dataDir).configFile);
    siteName = siteNameFor(config.dataDir);
  } catch (err) {
    const detail = err instanceof InstanceMarkerError ? `实例标记文件不对（${err.file}：${err.reason}）` : err instanceof Error ? err.message : String(err);
    log(`没有部署：${detail}`);
    return 2;
  }
  const site = nginxSiteConfig(access);
  if (options.argv.includes("--print")) {
    log(site);
    return 0;
  }
  log(`部署公网入口 https://${access.domain}/ ：ssh 到 ${access.sshUser}@${access.vpsHost}，写入 ${sitePaths(siteName).site}，nginx -t 通过后 reload`);
  const { status } = await options.exec(sshArgv(access), remoteScript(site, siteName));
  if (status !== 0) {
    log(`部署没有完成：ssh 或 VPS 上的脚本以 ${status} 退出（看上面的输出）。VPS 上原来的配置没动或已恢复`);
    return 1;
  }
  log(`部署完成：https://${access.domain}/ → VPS 127.0.0.1:${access.tunnelPort} → 这一份的隧道 → 守护进程的外网端口`);
  return 0;
}

/** 真的执行器：起子进程，stdin 送进去，stdout 和 stderr 直接给用户看 */
export const spawnCommand: CommandExecutor = (argv, stdin) =>
  new Promise((resolve, reject) => {
    const [program, ...args] = argv;
    if (program === undefined) return reject(new Error("没有要执行的命令"));
    const child = spawn(program, args, { stdio: ["pipe", "inherit", "inherit"], windowsHide: true });
    child.once("error", reject);
    child.once("close", (code) => resolve({ status: code ?? 1 }));
    child.stdin.end(stdin);
  });
