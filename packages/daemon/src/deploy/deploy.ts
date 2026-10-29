// @i18n-ignore-file log：部署命令（命令行工具）的输出和 VPS 上跑的脚本
// 部署公网入口的 nginx 站点（规格第 6 节、第 21 节）：一次 ssh 上 VPS 的动作，"对外发送或发布"一类。
// 落实为用户在本机亲手运行部署命令（src/deploy-nginx.ts），运行即确认，不另出卡；守护进程和任何 agent 都不会自己
// 发起部署（只有部署命令的入口引用这个模块，test/deploy/deploy.test.ts 扫源码检查）。部署不是 agent 的工具调用，不经守卫。
//
// 做法：一条 ssh，VPS 上跑 `sh -s`，脚本和生成的配置都从 stdin 送过去（不在命令行上拼引号）：
// 写进 sites-available/ergo.conf（旧的留一份 .bak）、链接到 sites-enabled、nginx -t 通过才 reload，
// 没通过就恢复原来的配置并以非零退出。证书沿用 VPS 上现有的 Let's Encrypt 做法，这里不签证书。
// 312 号票：站点文件以前叫 ergou.conf——部署时把旧名字的站点从 sites-enabled 拿掉（文件留着），免得两份站点抢同一个域名；
// nginx -t 没通过时连它一起恢复。
import { spawn } from "node:child_process";
import { oldNameOf } from "@ergo/protocol";
import { loadConfig } from "../config/config.ts";
import { dataDirLayout } from "../config/data-dir.ts";
import { nginxSiteConfig } from "./nginx.ts";
import { loadPublicAccess, type PublicAccess } from "./public-access.ts";

/** 执行一条命令（argv[0] 是程序），stdin 送进去；输出直接给用户看。测试换成假的 */
export type CommandExecutor = (argv: readonly string[], stdin: string) => Promise<{ status: number }>;

const SITE = "/etc/nginx/sites-available/ergo.conf";
const ENABLED = "/etc/nginx/sites-enabled/ergo.conf";
const HEREDOC = "ERGO_NGINX_SITE_EOF";
/** 312 号票之前的站点文件（旧名字） */
const OLD_SITE = oldNameOf(SITE);
const OLD_ENABLED = oldNameOf(ENABLED);

/** ssh 的命令行：不问密码（BatchMode）、第一次连接记下主机指纹；远端跑 sh -s，读 stdin 里的脚本 */
export function sshArgv(access: PublicAccess): string[] {
  return ["ssh", "-i", access.sshKey, "-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=accept-new", `${access.sshUser}@${access.vpsHost}`, "sh -s"];
}

/** VPS 上执行的脚本（配置原样夹在里面） */
export function remoteScript(config: string): string {
  if (config.split("\n").includes(HEREDOC)) throw new Error("站点配置里出现了脚本的分隔行");
  return `set -eu
tmp=$(mktemp)
cat > "$tmp" <<'${HEREDOC}'
${config}${HEREDOC}
if [ -f ${SITE} ]; then cp ${SITE} ${SITE}.bak; fi
install -m 644 "$tmp" ${SITE}
rm -f "$tmp"
ln -sf ${SITE} ${ENABLED}
old_enabled=0
if [ -e ${OLD_ENABLED} ] || [ -L ${OLD_ENABLED} ]; then rm -f ${OLD_ENABLED}; old_enabled=1; fi
if nginx -t; then
  systemctl reload nginx
  echo "nginx 已加载新的站点配置"
  if [ "$old_enabled" = 1 ]; then echo "旧名字的站点 ${OLD_SITE} 已从 sites-enabled 拿掉（文件留着）"; fi
else
  if [ -f ${SITE}.bak ]; then mv ${SITE}.bak ${SITE}; else rm -f ${SITE} ${ENABLED}; fi
  if [ "$old_enabled" = 1 ]; then ln -sf ${OLD_SITE} ${OLD_ENABLED}; fi
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
  try {
    const config = loadConfig({ env: options.env, homeDir: options.homeDir });
    access = loadPublicAccess(dataDirLayout(config.dataDir).configFile);
  } catch (err) {
    log(`没有部署：${err instanceof Error ? err.message : String(err)}`);
    return 2;
  }
  const site = nginxSiteConfig(access);
  if (options.argv.includes("--print")) {
    log(site);
    return 0;
  }
  log(`部署公网入口 https://${access.domain}/ ：ssh 到 ${access.sshUser}@${access.vpsHost}，写入 ${SITE}，nginx -t 通过后 reload`);
  const { status } = await options.exec(sshArgv(access), remoteScript(site));
  if (status !== 0) {
    log(`部署没有完成：ssh 或 VPS 上的脚本以 ${status} 退出（看上面的输出）。VPS 上原来的配置没动或已恢复`);
    return 1;
  }
  log(`部署完成：https://${access.domain}/ → VPS 127.0.0.1:${access.tunnelPort} → ergo-tunnel → 守护进程的外网端口`);
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
