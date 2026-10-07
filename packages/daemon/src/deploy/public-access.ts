// 公网入口的配置（规格第 6 节）：VPS 在哪、怎么 ssh 上去、隧道在 VPS 上占哪个端口、nginx 站点怎么写。
// 放在数据目录的 config/ergou.json 的 publicAccess 里（个人数据，不进仓库；仓库里只有 config/ergou.example.json）。
// 只有部署命令（src/deploy-nginx.ts）读它，守护进程不读。
//
// 这些值会被写进 nginx 配置和 VPS 上执行的脚本，所以每一项都按严格的字符集校验，占位符（<…>）一律不收。
import fs from "node:fs";

/** 隧道在 VPS 上的端口（ergou-tunnel 的 -R 127.0.0.1:18811:127.0.0.1:8811，只绑 VPS 的本机地址） */
export const DEFAULT_TUNNEL_PORT = 18811;

/**
 * nginx 默认的 listen：站在本机前门后面。VPS 的 443 由一个按 SNI 分流的前门（nginx stream）占着，
 * 二狗的站点和别的站点一样只听本机地址的 8443，由前门按域名转进来。VPS 上没有前门、nginx 直接听 443 的，写 "443 ssl"
 */
export const DEFAULT_NGINX_LISTEN = "127.0.0.1:8443 ssl";

export interface PublicAccess {
  /** VPS 的公网 IP（或主机名） */
  vpsHost: string;
  sshUser: string;
  /** ssh 私钥的路径（本机上的；只交给 ssh 的 -i，二狗不读它） */
  sshKey: string;
  /** 隧道在 VPS 上的端口 */
  tunnelPort: number;
  /** 公网域名，默认 ergou.<VPS>.sslip.io */
  domain: string;
  nginx: {
    /** listen 指令的参数，默认 DEFAULT_NGINX_LISTEN（本机前门后面）；直接听 443 的写 "443 ssl" */
    listen: string;
    /** 证书目录（里面有 fullchain.pem、privkey.pem），默认 Let's Encrypt 的 /etc/letsencrypt/live/<域名> */
    certificateDir: string;
    /**
     * 客户端的真实地址用哪个 nginx 变量，默认 $remote_addr。站在前门（stream 转发）后面时 $remote_addr 都是 127.0.0.1：
     * 卡片上的来源显示"经前门转发，无法识别"，配对请求的限频实际上是全局的。前门开了 proxy_protocol 的，
     * listen 加上 proxy_protocol，这里写 $proxy_protocol_addr，就按真实来源显示和限频（开不开由用户决定）
     */
    clientAddress: string;
  };
}

/** 配置文件里的写法：除了 VPS、ssh 私钥，其余都可以不写 */
export interface PublicAccessInput {
  vpsHost: string;
  sshUser?: string;
  sshKey: string;
  tunnelPort?: number;
  domain?: string;
  nginx?: { listen?: string; certificateDir?: string; clientAddress?: string };
}

export function publicAccessDefaults(input: PublicAccessInput): PublicAccess {
  const domain = input.domain ?? `ergou.${input.vpsHost}.sslip.io`;
  return {
    vpsHost: input.vpsHost,
    sshUser: input.sshUser ?? "root",
    sshKey: input.sshKey,
    tunnelPort: input.tunnelPort ?? DEFAULT_TUNNEL_PORT,
    domain,
    nginx: {
      listen: input.nginx?.listen ?? DEFAULT_NGINX_LISTEN,
      certificateDir: input.nginx?.certificateDir ?? `/etc/letsencrypt/live/${domain}`,
      clientAddress: input.nginx?.clientAddress ?? "$remote_addr",
    },
  };
}

const HOST = /^[A-Za-z0-9](?:[A-Za-z0-9.-]{0,251}[A-Za-z0-9])?$/;
const USER = /^[a-z_][a-z0-9_-]{0,31}$/i;
const LISTEN = /^[A-Za-z0-9.:[\]_ ]{1,64}$/;
const NGINX_VARIABLE = /^\$[a-z_]{1,64}$/;
const REMOTE_DIR = /^\/[A-Za-z0-9._/-]{1,200}$/;

/** 从配置文件读 publicAccess；没写、写错、还是占位符时抛错，写明是哪一项 */
export function loadPublicAccess(configFile: string): PublicAccess {
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(configFile, "utf8"));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") throw new Error(`没有配置文件 ${configFile}：从仓库的 config/ergou.example.json 复制一份，填好 publicAccess`, { cause: err });
    throw new Error(`配置文件 ${configFile} 读不了：${err instanceof Error ? err.message : String(err)}`, { cause: err });
  }
  const section = isRecord(raw) ? raw.publicAccess : undefined;
  if (!isRecord(section)) throw new Error(`配置文件 ${configFile} 里没有 publicAccess：填上 VPS 地址和 ssh 私钥（见 config/ergou.example.json）`);
  const bad = (key: string, why: string): never => {
    throw new Error(`配置文件 ${configFile}：publicAccess.${key} ${why}`);
  };
  const text = (key: string, value: unknown, pattern?: RegExp): string => {
    if (typeof value !== "string" || value.trim() === "") return bad(key, "必须是非空的字符串");
    if (/[<>]/.test(value)) return bad(key, `还是占位符：${value}`);
    if (pattern && !pattern.test(value)) return bad(key, `写法不对：${value}`);
    return value;
  };
  const optionalText = (key: string, value: unknown, pattern: RegExp) => (value === undefined ? undefined : text(key, value, pattern));
  const nginx = section.nginx;
  if (nginx !== undefined && !isRecord(nginx)) bad("nginx", "必须是一个对象");
  const tunnelPort = section.tunnelPort;
  if (tunnelPort !== undefined && (typeof tunnelPort !== "number" || !Number.isInteger(tunnelPort) || tunnelPort < 1024 || tunnelPort > 65535)) {
    bad("tunnelPort", `必须是 1024–65535 之间的整数，实际是 ${JSON.stringify(tunnelPort)}`);
  }
  const input: PublicAccessInput = {
    vpsHost: text("vpsHost", section.vpsHost, HOST),
    sshKey: text("sshKey", section.sshKey, /^[^\r\n"]+$/),
  };
  const sshUser = optionalText("sshUser", section.sshUser, USER);
  if (sshUser !== undefined) input.sshUser = sshUser;
  if (typeof tunnelPort === "number") input.tunnelPort = tunnelPort;
  const domain = optionalText("domain", section.domain, HOST);
  if (domain !== undefined) input.domain = domain;
  if (isRecord(nginx)) {
    const listen = optionalText("nginx.listen", nginx.listen, LISTEN);
    const certificateDir = optionalText("nginx.certificateDir", nginx.certificateDir, REMOTE_DIR);
    const clientAddress = optionalText("nginx.clientAddress", nginx.clientAddress, NGINX_VARIABLE);
    input.nginx = {
      ...(listen === undefined ? {} : { listen }),
      ...(certificateDir === undefined ? {} : { certificateDir }),
      ...(clientAddress === undefined ? {} : { clientAddress }),
    };
  }
  return publicAccessDefaults(input);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
