// 转发登记表（132 号票）：一个应用名对应本机的一个地址，网关只转发登记过的（/apps/<应用名>/… → 那个地址，见 proxy.ts），
// 没登记的回 404——不是开放代理。登记返回撤销函数（ADR-0027）：插件经插件宿主登记（ctx.apps.register，记在插件名下，停用时撤），
// 内核模块直接登记（133 号票服务上线时登记、停用时撤）。撤销以后这个应用开着的 WebSocket 一并断开（onRemoved）。
// 只认本机的地址（127.0.0.1、localhost、[::1]，只到端口）：登记表不会被拿去转发局域网、外网的地址。
import { appBasePath, isAppName } from "@ergo/protocol";

/** 前缀怎么交给服务：strip 转发时去掉前缀（服务当自己在根上，默认）；keep 原样带着（服务按 ERGO_BASE_PATH 把框架的 base 设成了它） */
export type AppPrefixMode = "strip" | "keep";

/** 登记一个应用 */
export interface AppRegistration {
  /** 应用名（协议包的 isAppName：小写字母、数字、连字符）：地址是 /apps/<应用名>/ */
  name: string;
  /** 本机服务的地址：http://127.0.0.1:<端口>（或 localhost、[::1]），只到端口 */
  target: string;
  /** 给人看的名字（"简报站"）：说明页里写它，内置浏览器取不到页面标题时也用它；不给用应用名 */
  title?: string;
  /** 前缀怎么交给服务，不给是 strip */
  prefix?: AppPrefixMode;
}

/** 登记着的应用 */
export interface RegisteredApp {
  readonly name: string;
  readonly title: string;
  /** 服务的源：http://127.0.0.1:<端口> */
  readonly origin: string;
  /** 连它用的主机（[::1] 写成 ::1）和端口 */
  readonly host: string;
  readonly port: number;
  /** 转发时的 Host 头（服务眼里自己的地址）："127.0.0.1:<端口>" */
  readonly hostHeader: string;
  readonly prefix: AppPrefixMode;
  /** 前缀："/apps/<应用名>" */
  readonly basePath: string;
}

export interface AppRegistry {
  /** 登记（应用名、地址不对，或者这个名字已经登记了，直接抛错）；返回撤销函数（只撤这一次登记，撤几次都只算一次） */
  register(app: AppRegistration): () => void;
  get(name: string): RegisteredApp | undefined;
  /** 登记着的全部，按登记的先后 */
  list(): RegisteredApp[];
  /** 撤销了一个应用时通知（转发据此断开它开着的 WebSocket）；返回退订 */
  onRemoved(listener: (name: string) => void): () => void;
}

/** 本机的主机名（URL 里的写法） */
const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]"]);

export function isLoopbackHost(hostname: string): boolean {
  return LOOPBACK.has(hostname.toLowerCase());
}

/** 地址 → 登记着的样子；不是本机的、不只到端口的抛错 */
function resolve(app: AppRegistration): RegisteredApp {
  // @i18n-ignore-start log：登记出错只进日志（编程错误）
  if (!isAppName(app.name)) throw new Error(`应用名 ${JSON.stringify(app.name)} 不对：只能用小写字母、数字、连字符，字母或数字开头结尾，最长 63`);
  let url: URL;
  try {
    url = new URL(app.target);
  } catch {
    throw new Error(`应用 ${app.name} 的地址 ${JSON.stringify(app.target)} 不是网址`);
  }
  const plain = url.pathname === "/" && url.search === "" && url.hash === "" && url.username === "" && url.password === "";
  if (url.protocol !== "http:" || !isLoopbackHost(url.hostname) || url.port === "" || !plain) {
    throw new Error(`应用 ${app.name} 的地址要是本机的 http://127.0.0.1:<端口>（或 localhost、[::1]），只到端口：${app.target}`);
  }
  // @i18n-ignore-end
  return {
    name: app.name,
    title: app.title?.trim() || app.name,
    origin: url.origin,
    host: url.hostname === "[::1]" ? "::1" : url.hostname,
    port: Number(url.port),
    hostHeader: url.host,
    prefix: app.prefix ?? "strip",
    basePath: appBasePath(app.name),
  };
}

export function createAppRegistry(): AppRegistry {
  const apps = new Map<string, RegisteredApp>();
  const listeners = new Set<(name: string) => void>();
  return {
    register(app) {
      const entry = resolve(app);
      if (apps.has(entry.name)) throw new Error(`应用 ${entry.name} 已经登记了（要换地址先撤掉原来的）`); // @i18n-ignore log：编程错误
      apps.set(entry.name, entry);
      return () => {
        if (apps.get(entry.name) !== entry) return;
        apps.delete(entry.name);
        for (const listener of listeners) listener(entry.name);
      };
    },
    get: (name) => apps.get(name),
    list: () => [...apps.values()],
    onRemoved(listener) {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
  };
}
