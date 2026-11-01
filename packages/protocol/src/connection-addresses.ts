// 连接地址（364 号票）：手机从外面连到这台二狗用的地址。二狗自己只听 127.0.0.1，不知道外面怎么连到它：
// 公网和 tailnet 的入口问服务管家（link 协议 §8），服务管家不知道的（自己搭的反代、frp）用户手填一个。不做局域网。
// - GET /api/connection-addresses 回 ConnectionAddressesView（排好序，第一个就是二维码默认用的）；POST 改手填的那个。
// - 这里的校验、排序不碰网络，守护进程、网页、测试用同一份。
// 不引用 TypeBox：网页只用常量和类型（请求体的 schema 在 connection-addresses-schema.ts）。

/** 地址的种类，也是没测过时的先后：公网 → tailnet → 用户手填 */
export const CONNECTION_ADDRESS_KINDS = ["public", "tailnet", "manual"] as const;
export type ConnectionAddressKind = (typeof CONNECTION_ADDRESS_KINDS)[number];

export interface ConnectionAddress {
  kind: ConnectionAddressKind;
  /** 就是二维码里放的东西：普通网址，不带口令 */
  url: string;
  /** 服务管家最近一次从外面打的结果：true 通、false 不通、null 没测过（手填的永远是 null）。不通只是"服务管家这边打不通"，仍然列出 */
  reachable: boolean | null;
}

/** 服务管家给了、但手机用不了的入口：wrong_port 接到了别的端口（8810 这种对本机请求自动信任的端口绝不能接到外面）；not_https 不是 https */
export interface RejectedConnectionAddress {
  kind: "public" | "tailnet";
  url: string;
  reason: "wrong_port" | "not_https";
  /** 实际接到本机哪个端口；管理器说不清是 null */
  port: number | null;
}

/** 服务管家这边：disabled 二狗不是它拉起的；waiting 还没连上；supported 问得到；unsupported 版本太老，没有这项能力 */
export type ConnectionManagerState = "disabled" | "waiting" | "supported" | "unsupported";

export interface ConnectionAddressesView {
  /** 能给手机的地址，排好序（orderConnectionAddresses）；空的就是"二狗现在从外面连不上" */
  addresses: ConnectionAddress[];
  /** 用户手填的那个（也在 addresses 里）；没填没有 */
  manual?: string;
  manager: ConnectionManagerState;
  /** 服务管家的网页（只在这台电脑上打得开）；二狗不是它拉起的时候不知道，没有 */
  managerUrl?: string;
  /** 给了但用不了的（写进日志和体检） */
  rejected: RejectedConnectionAddress[];
}

/** POST 的请求体：manual 给 null 是去掉 */
export interface ConnectionAddressesBodyShape {
  manual: string | null;
}

/** 手填地址的上限（够长的网址；不让人塞一大段字进配置文件） */
export const CONNECTION_ADDRESS_MAX_LENGTH = 512;

/** 校验不过的原因，locales/<语言>/pairing.json 的 pairing.address.invalid.<原因> */
export type ConnectionAddressProblem = "empty" | "tooLong" | "malformed" | "noHost" | "credentials" | "httpsOnly" | "lan";

export type ConnectionAddressCheck = { ok: true; url: string } | { ok: false; problem: ConnectionAddressProblem };

/** 这两个主机可以用 http（本机调试），和两个 App 的 checkServerAddress 一字不差 */
const LOCAL_HOSTS: ReadonlySet<string> = new Set(["127.0.0.1", "localhost"]);

/** 浏览器和 Node 都有的网址解析；状态层的 tsconfig 不带 DOM，不能直接写全局的 URL */
interface ParsedUrl {
  protocol: string;
  hostname: string;
  username: string;
  password: string;
  hash: string;
  href: string;
}
const parseUrl = (text: string): ParsedUrl => new (globalThis as unknown as { URL: new (input: string) => ParsedUrl }).URL(text);

/**
 * 手机 App 认不认这个地址：规矩和 frontend/android 的 ServerAddress.kt、frontend/harmony 的 ServerAddress.ets 一字不差
 * （必须 https，127.0.0.1、localhost 才能 http；不带用户名密码；没写 scheme 的按 https 补）。frontend/test 拿同一批例子核对三边。
 */
export function checkAppAddress(input: string): ConnectionAddressCheck {
  const text = input.trim();
  if (text.length === 0) return { ok: false, problem: "empty" };
  if (text.length > CONNECTION_ADDRESS_MAX_LENGTH) return { ok: false, problem: "tooLong" };
  // 空白和反斜杠：WHATWG 的解析会替你改掉，两个 App 不认，这里也不认
  if (/[\s\\]/.test(text)) return { ok: false, problem: "malformed" };
  let parsed: ParsedUrl;
  try {
    parsed = parseUrl(text.includes("://") ? text : `https://${text}`);
  } catch {
    return { ok: false, problem: "malformed" };
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return { ok: false, problem: "malformed" };
  if (parsed.hostname.length === 0) return { ok: false, problem: "noHost" };
  if (parsed.username.length > 0 || parsed.password.length > 0) return { ok: false, problem: "credentials" };
  if (parsed.protocol === "http:" && !LOCAL_HOSTS.has(parsed.hostname)) return { ok: false, problem: "httpsOnly" };
  parsed.hash = "";
  return { ok: true, url: parsed.href };
}

/** 主机是不是只有这台电脑、局域网里才连得到：用户定了不做局域网（tailnet 的 100.64.0.0/10 不算，它是另一条路） */
export function isLanHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (host === "localhost" || host.endsWith(".localhost")) return true;
  if (host.includes(":")) return host === "::1" || /^f[cd]/.test(host) || /^fe[89ab]/.test(host);
  const v4 = /^(\d{1,3})\.(\d{1,3})\.\d{1,3}\.\d{1,3}$/.exec(host);
  if (v4) {
    const a = Number(v4[1]);
    const b = Number(v4[2]);
    return a === 127 || a === 10 || (a === 192 && b === 168) || (a === 172 && b >= 16 && b <= 31) || (a === 169 && b === 254);
  }
  // 不带点的主机名（nas、pc-01）和局域网专用的后缀
  return !host.includes(".") || /\.(local|lan|home|internal|intranet)$/.test(host);
}

/** 用户手填的固定地址：先是 App 认的（规矩一样），再不能是本机或局域网（手机在外面用不了，用户定了不做局域网） */
export function checkManualConnectionAddress(input: string): ConnectionAddressCheck {
  const checked = checkAppAddress(input);
  if (!checked.ok) return checked;
  return isLanHost(parseUrl(checked.url).hostname) ? { ok: false, problem: "lan" } : checked;
}

const reachRank = (reachable: boolean | null) => (reachable === true ? 0 : reachable === null ? 1 : 2);

/**
 * 排序：打通过的在前，没测过的（手填的、服务管家没测的）其次，打不通的最后（标明但仍然列出，可能只是服务管家这边打不通）；
 * 同一档里按 公网 → tailnet → 手填。排第一个的就是二维码默认用的。同一个地址只留一条（靠前的那条）
 */
export function orderConnectionAddresses(addresses: readonly ConnectionAddress[]): ConnectionAddress[] {
  const sorted = addresses.toSorted((a, b) => reachRank(a.reachable) - reachRank(b.reachable) || CONNECTION_ADDRESS_KINDS.indexOf(a.kind) - CONNECTION_ADDRESS_KINDS.indexOf(b.kind));
  const seen = new Set<string>();
  return sorted.filter((address) => {
    if (seen.has(address.url)) return false;
    seen.add(address.url);
    return true;
  });
}
