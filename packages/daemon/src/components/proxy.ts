// 下载走系统代理（323 号票）：先看环境变量（HTTPS_PROXY / HTTP_PROXY / ALL_PROXY，NO_PROXY 列出的不走），没设就看
// Windows 的系统代理（"设置 · 网络 · 代理"里手动设的那个：注册表 Internet Settings 的 ProxyEnable / ProxyServer / ProxyOverride）。
// 本机回环（127.0.0.1、localhost、::1）一律不走代理。自动配置脚本（PAC，AutoConfigURL）不认：用 PAC 的请设 HTTPS_PROXY。
// 每次开始下载时现取一遍（用户中途改了代理，下一次下载就跟着变）。
import { spawnSync } from "node:child_process";

/** 一个地址走哪个代理；不走是 undefined */
export type ProxyFor = (url: URL) => URL | undefined;

/** Windows 的系统代理（手动设的那个） */
export interface SystemProxy {
  /** ProxyServer：host:port，或者 http=host:port;https=host:port */
  server: string;
  /** ProxyOverride：不走代理的（分号隔开，<local> 是不带点的主机名） */
  override?: string;
}

const LOOPBACK = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);

/** 读 Windows 注册表里的系统代理；没开、读不到、不是 Windows 是 undefined */
export function readWindowsProxy(): SystemProxy | undefined {
  if (process.platform !== "win32") return undefined;
  const result = spawnSync("reg", ["query", "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings"], { encoding: "utf8", windowsHide: true, timeout: 5000 });
  if (result.status !== 0 || typeof result.stdout !== "string") return undefined;
  return parseRegQuery(result.stdout);
}

/** 拆 reg query 的输出（"    ProxyEnable    REG_DWORD    0x1"） */
export function parseRegQuery(output: string): SystemProxy | undefined {
  const values = new Map<string, string>();
  for (const line of output.split(/\r?\n/)) {
    const m = /^\s+(\S+)\s+REG_\w+\s*(.*)$/.exec(line);
    if (m) values.set(m[1]!.toLowerCase(), m[2]!.trim());
  }
  const enabled = values.get("proxyenable");
  const server = values.get("proxyserver");
  if (!enabled || Number.parseInt(enabled, enabled.startsWith("0x") ? 16 : 10) === 0 || !server) return undefined;
  const override = values.get("proxyoverride");
  return { server, ...(override ? { override } : {}) };
}

/** 环境变量里的值（大小写都认，小写优先，和 curl 一样） */
function envValue(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const value = env[name.toLowerCase()] ?? env[name.toUpperCase()];
  return value && value.trim() !== "" ? value.trim() : undefined;
}

/** 代理的写法补上协议（host:port → http://host:port） */
function proxyUrl(value: string): URL | undefined {
  try {
    return new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(value) ? value : `http://${value}`);
  } catch {
    return undefined;
  }
}

/** 主机名对不对得上一条不走代理的规则（NO_PROXY 的写法：*、域名后缀、.域名、host:port；系统代理的 *.lan、<local>） */
function bypassed(url: URL, rules: readonly string[]): boolean {
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  const port = url.port || (url.protocol === "https:" ? "443" : "80");
  return rules.some((raw) => {
    const rule = raw.trim().toLowerCase();
    if (rule === "") return false;
    if (rule === "*") return true;
    if (rule === "<local>") return !host.includes(".") && !host.includes(":");
    const [ruleHost, rulePort] = rule.startsWith("[") ? [rule, undefined] : (rule.split(":") as [string, string | undefined]);
    if (rulePort !== undefined && rulePort !== port) return false;
    if (ruleHost.includes("*")) {
      const pattern = new RegExp(`^${ruleHost.split("*").map((s) => s.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".*")}$`);
      return pattern.test(host);
    }
    const bare = ruleHost.replace(/^\./, "");
    return host === bare || host.endsWith(`.${bare}`);
  });
}

/**
 * 按环境变量和系统代理定一个地址走哪个代理。env 是守护进程的环境；system 是读系统代理的（测试换成假的，不给就不看系统代理）
 */
export function proxyResolver(options: { env: NodeJS.ProcessEnv; system?: (() => SystemProxy | undefined) | undefined }): ProxyFor {
  const noProxy = (envValue(options.env, "no_proxy") ?? "").split(",");
  const fromEnv = (url: URL): URL | undefined => {
    const value = url.protocol === "https:" ? (envValue(options.env, "https_proxy") ?? envValue(options.env, "all_proxy")) : (envValue(options.env, "http_proxy") ?? envValue(options.env, "all_proxy"));
    return value === undefined ? undefined : proxyUrl(value);
  };
  const anyEnv = ["https_proxy", "http_proxy", "all_proxy"].some((name) => envValue(options.env, name) !== undefined);
  const system = anyEnv ? undefined : options.system?.();
  const systemRules = system?.override?.split(";") ?? [];
  const fromSystem = (url: URL): URL | undefined => {
    if (!system) return undefined;
    const entries = system.server.split(";").map((s) => s.trim()).filter(Boolean);
    const scheme = url.protocol.replace(":", "");
    const tagged = entries.find((e) => e.toLowerCase().startsWith(`${scheme}=`));
    const plain = entries.find((e) => !e.includes("="));
    const value = tagged?.slice(scheme.length + 1) ?? plain;
    return value === undefined ? undefined : proxyUrl(value);
  };
  return (url) => {
    if (LOOPBACK.has(url.hostname.toLowerCase())) return undefined;
    if (anyEnv) return bypassed(url, noProxy) ? undefined : fromEnv(url);
    return bypassed(url, systemRules) ? undefined : fromSystem(url);
  };
}
