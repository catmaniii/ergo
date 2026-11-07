// "和二狗有关"的服务（428）：服务管家里托管着各种服务，二狗里只给人看和二狗有关的那些——跟二狗无关的不在二狗里出现，
// 免得困惑（用户 2026-11-07）。设置 · 服务一页（428）和体检的"托管的服务"（410）共用这一份判定，规则只写在这里。
// 一个服务可以同时占几条（几种用途），一条都不占的就不算：
//   1. 二狗自己（self：服务管家列表回的 self，就是 ergo-daemon）；
//   2. 二狗名下的（<self>--*：项目上线的服务、组件装的语音合成）；
//   3. 二狗配置里在用的：语音合成、语音识别的本机地址按端口对上服务管家里的服务（用户手工登记的 audiocpp、ergo-asr 靠这条认出来）；
//      同一个端口登记了几个时挑在跑的那个；二狗自己、隧道不算；
//   4. 二狗离不开的：二狗那条登记的 exposure.via 隧道、开了 tailnet 入口时服务管家的 tailnet 网关、二狗登记里 dependsOn 的服务
//      （软硬都算）；再加上这些服务硬依赖的，一层层往下（和服务管家算命脉一样：它们停了，上面那些也跟着停）；
//   5. 后门：服务管家登记里写了 ergo: true 的（二狗认不出用途、又想在二狗里看的）。
// 纯函数，不连服务管家：输入是服务管家的列表（接入层的 manage.list）或 `lsm status --json` 的快照，调用方各自换成这里的形状。
// 语音的端口怎么从配置里算在守护进程（packages/daemon/src/lsm/voice-ports.ts）。

/** 为什么和二狗有关（排列顺序也是页面上的先后：二狗自己最前，语音、隧道这些二狗要用的其次，名下的、标了的最后） */
export const ERGO_USES = ["self", "speech", "recognizer", "tunnel", "gateway", "dependency", "owned", "marked"] as const;
export type ErgoUse = (typeof ERGO_USES)[number];

/** 判的时候用得到的一个服务的样子（manage.list 的服务条目、lsm status --json 的快照各自换成这个） */
export interface ErgoRelatedService {
  id: string;
  /** 探活端口（服务管家认服务的身份） */
  port?: number | null;
  /** 纯隧道是 "tunnel" */
  role?: string | null;
  /** RUNNING / STOPPED……（同一个端口有几个时挑在跑的用） */
  state?: string;
  /** 公网入口经哪条隧道（exposure.via） */
  via?: string | null;
  /** 开着 tailnet 入口 */
  tailnet?: boolean;
  dependsOn?: readonly { id: string; type?: string }[];
  /** 服务管家登记里标了 ergo: true */
  ergo?: boolean;
}

export interface ErgoRelatedContext {
  /** 二狗自己在服务管家里的 id（ergo-daemon） */
  self: string;
  /** 二狗在用的语音合成的本机端口（不在用、不是本机地址的不给） */
  speechPort?: number | undefined;
  /** 二狗在用的语音识别的本机端口（同上；二狗自己拉起的 Python 不归服务管家，不给） */
  recognizerPort?: number | undefined;
  /** 服务管家的 tailnet 网关是哪个服务（manage.list 的 tailnetGateway；没开 tailnet 不给） */
  tailnetGateway?: string | undefined;
}

/**
 * 挑出和二狗有关的：服务 id → 用途（按 ERGO_USES 的先后）。Map 的先后按最要紧的那条用途排（二狗自己最前），
 * 同一档里照服务管家列表的先后。没列在 services 里的（隧道、网关、依赖写了却没登记）不算
 */
export function ergoRelated(services: readonly ErgoRelatedService[], ctx: ErgoRelatedContext): Map<string, ErgoUse[]> {
  const byId = new Map(services.map((s) => [s.id, s]));
  const uses = new Map<string, Set<ErgoUse>>();
  const add = (id: string | null | undefined, use: ErgoUse) => {
    if (id === null || id === undefined || !byId.has(id)) return;
    let set = uses.get(id);
    if (!set) uses.set(id, (set = new Set()));
    set.add(use);
  };
  const self = byId.get(ctx.self);
  // 1. 二狗自己
  add(self?.id, "self");
  // 2. 二狗名下的
  const ownedPrefix = `${ctx.self}--`;
  for (const s of services) if (s.id.startsWith(ownedPrefix)) add(s.id, "owned");
  // 3. 语音按端口对上：二狗自己、隧道不算；同一个端口有几个时挑在跑的
  const byPort = (port: number | undefined) => {
    if (port === undefined) return undefined;
    const candidates = services.filter((s) => s.port === port && s.id !== ctx.self && s.role !== "tunnel");
    return (candidates.find((s) => s.state === "RUNNING") ?? candidates[0])?.id;
  };
  add(byPort(ctx.speechPort), "speech");
  add(byPort(ctx.recognizerPort), "recognizer");
  // 4. 二狗离不开的：隧道、tailnet 网关、二狗登记的依赖（软硬都算），再加上它们硬依赖的
  const roots: string[] = [];
  if (self?.via && byId.has(self.via)) {
    add(self.via, "tunnel");
    roots.push(self.via);
  }
  if (self?.tailnet && ctx.tailnetGateway !== undefined && byId.has(ctx.tailnetGateway)) {
    add(ctx.tailnetGateway, "gateway");
    roots.push(ctx.tailnetGateway);
  }
  for (const dep of self?.dependsOn ?? []) {
    if (!byId.has(dep.id) || dep.id === ctx.self) continue;
    add(dep.id, "dependency");
    roots.push(dep.id);
  }
  const seen = new Set<string>([ctx.self]);
  const walk = (id: string) => {
    if (seen.has(id)) return;
    seen.add(id);
    for (const dep of byId.get(id)?.dependsOn ?? []) {
      if ((dep.type ?? "hard") !== "hard" || !byId.has(dep.id) || dep.id === ctx.self) continue;
      add(dep.id, "dependency");
      walk(dep.id);
    }
  };
  roots.forEach(walk);
  // 5. 标了 ergo: true 的
  for (const s of services) if (s.ergo === true) add(s.id, "marked");

  const rank = (set: ReadonlySet<ErgoUse>) => Math.min(...[...set].map((use) => ERGO_USES.indexOf(use)));
  const order = new Map(services.map((s, i) => [s.id, i]));
  return new Map(
    [...uses]
      .toSorted(([a, sa], [b, sb]) => rank(sa) - rank(sb) || order.get(a)! - order.get(b)!)
      .map(([id, set]) => [id, ERGO_USES.filter((use) => set.has(use))]),
  );
}

/** 浏览器和 Node 都有的网址解析；网页状态层的 tsconfig 不带 DOM，不能直接写全局的 URL（同 connection-addresses.ts） */
const parseUrl = (text: string): { protocol: string; hostname: string; port: string } =>
  new (globalThis as unknown as { URL: new (input: string) => { protocol: string; hostname: string; port: string } }).URL(text);

/** 地址是本机的才算（127.0.0.1、localhost、::1），交回端口（没写按协议的默认端口）；别的（局域网、外网、写错的）是 undefined */
export function localPortOf(url: string): number | undefined {
  try {
    const parsed = parseUrl(url);
    const host = parsed.hostname.replace(/^\[|\]$/g, "");
    if (host !== "127.0.0.1" && host !== "localhost" && host !== "::1") return undefined;
    const port = parsed.port === "" ? (parsed.protocol === "https:" ? 443 : 80) : Number(parsed.port);
    return Number.isInteger(port) && port > 0 ? port : undefined;
  } catch {
    return undefined;
  }
}
