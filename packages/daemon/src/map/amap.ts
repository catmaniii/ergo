// 高德地图（429）：设置 · 数据源里"高德地图"那一格的 Key，和高德 JS API 的安全密钥代理。
// 三样东西存在密钥区（data-sources/amap.json，一个值一格）：
// - jsKey：Web 端（JS API）的 Key。页面拿它加载高德的脚本（高德的设计里它本来就在页面上，能在高德控制台绑域名）；
// - securityCode：和它配对的安全密钥。**不进页面**：页面设 serviceHost 指向守护进程的 /_AMapService，守护进程转发时拼上
//   jscode=<安全密钥>（高德官方推荐的代理方式）；
// - serviceKey：Web 服务的 Key（432 查地点、算路线用，守护进程直接调高德，也不进页面）。可以不填。
// 填完先测再存：拿填的去调一次高德的逆地理编码（一个固定的点：北京天安门，不是你的位置），高德说过了才存；
// 新填的没过时原来存着的照用。Key、安全密钥不进日志、不进事件、不进给页面的（除了 jsKey），出错的原因里碰到就换成 ***。
// 转发时高德说 Key、安全密钥不对（INVALID_USER_KEY 这类），记在内存里：连接状态报出错（要重新填），地图页不再拿 Key、国内先用
// OpenStreetMap；内核每小时叫 recheck 再测一次，好了就回来。
// 高德那边的地址写死在这里（测试换成本机的假高德）：
// - /_AMapService/v4/map/styles → webapi.amap.com（自定义地图样式）
// - /_AMapService/v3/vectormap → fmap01.amap.com（海外地图）
// - /_AMapService/ 下别的 → restapi.amap.com（Web 服务）
import { t } from "@ergo/protocol";
import type { DataSourceSecrets, DataSourceStatus } from "../data-sources/api.ts";
import type { MapReply } from "./api.ts";

/** 高德的三个地址 */
export interface AmapHosts {
  readonly rest: string;
  readonly webapi: string;
  readonly vectormap: string;
}

export const AMAP_HOSTS: AmapHosts = { rest: "https://restapi.amap.com", webapi: "https://webapi.amap.com", vectormap: "https://fmap01.amap.com" };

/** 密钥区里的名字（也是网页交来的值的名字） */
export const AMAP_SECRET = { jsKey: "jsKey", securityCode: "securityCode", serviceKey: "serviceKey" } as const;

/** 测 Key 时问的点（北京天安门，高德坐标）：固定的，不是你的位置 */
const PROBE_LOCATION = "116.397428,39.90923";
/** 一次请求最多等多久 */
export const AMAP_TIMEOUT_MS = 15_000;
/** 转发的回应最大多少 */
const MAX_PROXY_BYTES = 16 * 1024 * 1024;
/** 只在这么大以内的文字回应里找"Key 不对" */
const SCAN_BYTES = 256 * 1024;

/** 高德说 Key、安全密钥、平台不对的那几种（infocode 或 info） */
const KEY_ERRORS: Readonly<Record<string, KeyFailure>> = {
  "10001": "key",
  INVALID_USER_KEY: "key",
  "10008": "securityCode",
  INVALID_USER_SCODE: "securityCode",
  "10009": "platform",
  USERKEY_PLAT_NOMATCH: "platform",
  "10005": "ip",
  INVALID_USER_IP: "ip",
  "10006": "domain",
  INVALID_USER_DOMAIN: "domain",
};
/** 用量、频率到上限的那几种：Key 是认的，只是一时不能用 */
const LIMIT_CODES = new Set(["10003", "10004", "10044", "10014", "10019", "10020", "10021", "10029"]);

type KeyFailure = "key" | "securityCode" | "platform" | "ip" | "domain";
/** 哪一组：地图（Web 端 Key + 安全密钥）还是查询（Web 服务 Key） */
type Part = "js" | "service";

/** 测出来的问题：key 是要重新填的，limit 是一时的 */
interface Problem {
  kind: "key" | "limit" | "configure";
  text: string;
}

export interface AmapOptions {
  hosts?: Partial<AmapHosts>;
  timeoutMs?: number;
  /** 转发时现取密钥区里这一格（插件经 KERNEL.dataSourceSecrets 取） */
  secrets: () => DataSourceSecrets;
  log: (line: string) => void;
}

export interface Amap {
  status(secrets: DataSourceSecrets): DataSourceStatus;
  configure(values: Readonly<Record<string, string>>, secrets: DataSourceSecrets): Promise<DataSourceStatus>;
  recheck(secrets: DataSourceSecrets, signal: AbortSignal): Promise<void>;
  /** 断开：忘掉记着的问题（密钥区那一格内核删） */
  reset(): void;
  /** 页面能拿的 Web 端 Key：填了 Key 和安全密钥、高德没说它们不对才有 */
  mapKey(): string | undefined;
  /** 高德说地图那一组不对时给人看的一句 */
  mapProblem(): string | undefined;
  /** 安全密钥代理 */
  proxy(path: string, search: string, signal: AbortSignal, userAgent?: string): Promise<MapReply>;
  /**
   * 查地点、算路线（432，amap-lookup.ts）时高德的回应：说 Web 服务 Key 不对就记下（连接状态报出错、要重新填，每小时再测），
   * 说用量到上限记成一时的问题（照样连着、写原因），查成了清掉；别的错（参数不对、找不到路）不记
   */
  serviceReply(body: unknown, httpStatus: number): void;
}

/** 一次测试的结果：过了、Key 不对（要重新填）、一时不能用（Key 是认的）、别的出错 */
type ProbeResult = { ok: true; limit?: string } | { ok: false; failure: KeyFailure | "other"; text: string };

export function createAmap(options: AmapOptions): Amap {
  const hosts: AmapHosts = { ...AMAP_HOSTS, ...options.hosts };
  const timeoutMs = options.timeoutMs ?? AMAP_TIMEOUT_MS;
  const problems: Partial<Record<Part, Problem>> = {};

  /** 一句话里出现的密钥换成 *** */
  const redact = (text: string, secrets: DataSourceSecrets): string => {
    let out = text;
    for (const name of Object.values(AMAP_SECRET)) {
      const v = secrets.get(name);
      if (v && v.length >= 4) out = out.split(v).join("***");
    }
    return out;
  };

  const failureText = (failure: KeyFailure, part: Part) => (failure === "platform" ? t(part === "js" ? "map.error.platformJs" : "map.error.platformService") : t(`map.error.${failure}`));

  /** 读高德回的 JSON：status 是 "1" 算过了 */
  const judge = (body: unknown, part: Part, httpStatus: number): ProbeResult => {
    if (typeof body !== "object" || body === null) return { ok: false, failure: "other", text: t("map.error.notJson", { status: httpStatus }) };
    const b = body as { status?: unknown; info?: unknown; infocode?: unknown };
    const info = typeof b.info === "string" ? b.info : "";
    const code = typeof b.infocode === "string" ? b.infocode : "";
    if (String(b.status) === "1") return { ok: true };
    const failure = KEY_ERRORS[code] ?? KEY_ERRORS[info];
    if (failure) return { ok: false, failure, text: failureText(failure, part) };
    if (LIMIT_CODES.has(code)) return { ok: true, limit: t("map.error.limit", { info }) };
    return { ok: false, failure: "other", text: t("map.error.other", { info: info || "?", code: code || String(httpStatus) }) };
  };

  /** 拿一组 Key 调一次逆地理编码 */
  const probe = async (part: Part, key: string, securityCode: string | undefined, signal?: AbortSignal): Promise<ProbeResult> => {
    const q = new URLSearchParams({ location: PROBE_LOCATION, extensions: "base", key });
    // Web 端的 Key 照高德的脚本经代理时那样带上安全密钥和平台
    if (part === "js" && securityCode !== undefined) for (const [k, v] of Object.entries({ jscode: securityCode, platform: "JS", s: "rsv3", sdkversion: "2.0", logversion: "2.0" })) q.set(k, v);
    const timeout = AbortSignal.timeout(timeoutMs);
    try {
      const res = await fetch(`${hosts.rest}/v3/geocode/regeo?${q}`, { signal: signal ? AbortSignal.any([timeout, signal]) : timeout });
      const text = await res.text();
      let body: unknown;
      try {
        body = JSON.parse(text);
      } catch {
        body = undefined;
      }
      return judge(body, part, res.status);
    } catch (err) {
      if (signal?.aborted) throw err;
      const reason = err instanceof Error && err.name === "TimeoutError" ? t("map.error.timeout") : err instanceof Error ? (causeOf(err) ?? err.message) : String(err);
      return { ok: false, failure: "other", text: t("map.error.network", { reason }) };
    }
  };

  const filled = (secrets: DataSourceSecrets) => ({
    js: secrets.has(AMAP_SECRET.jsKey) && secrets.has(AMAP_SECRET.securityCode),
    service: secrets.has(AMAP_SECRET.serviceKey),
  });

  const status = (secrets: DataSourceSecrets): DataSourceStatus => {
    const f = filled(secrets);
    const said = (p: Part) => t(p === "js" ? "map.problem.js" : "map.problem.service", { reason: problems[p]!.text });
    if (!f.js && !f.service) {
      // 什么都没存上：这次填了没过的写原因（出错），没填过的是没连
      const tried = (["js", "service"] as const).filter((p) => problems[p] !== undefined);
      return tried.length === 0 ? { connection: "not_connected" } : { connection: "error", problem: tried.map(said).join(t("map.problem.joiner")) };
    }
    const account = t("map.source.account", { map: t(f.js ? "map.source.filled" : "map.source.empty"), query: t(f.service ? "map.source.filled" : "map.source.empty") });
    // 存着的那一组的问题，和这次新填了没过的（没存过也写，告诉用户为什么没存上）
    const shown = (["js", "service"] as const).filter((p) => problems[p] !== undefined && (f[p] || problems[p]!.kind === "configure"));
    const text = shown.map(said).join(t("map.problem.joiner"));
    if (shown.some((p) => problems[p]!.kind === "key")) return { connection: "error", problem: text, account, needsAuth: true };
    return { connection: "connected", ...(text === "" ? {} : { problem: text }), account };
  };

  /** 记下测出来的：过了清掉，Key 不对记成要重新填的 */
  const note = (part: Part, result: ProbeResult) => {
    if (result.ok) {
      if (result.limit) problems[part] = { kind: "limit", text: result.limit };
      else delete problems[part];
      return;
    }
    problems[part] = { kind: result.failure === "other" ? "configure" : "key", text: result.text };
  };

  return {
    status,

    async configure(values, secrets) {
      const typed = (name: string) => {
        const v = values[name]?.trim() ?? "";
        return v === "" ? undefined : v;
      };
      const js = typed(AMAP_SECRET.jsKey);
      const code = typed(AMAP_SECRET.securityCode);
      const service = typed(AMAP_SECRET.serviceKey);
      if ([js, code, service].some((v) => v !== undefined && /\s/.test(v))) return { ...status(secrets), connection: "error", problem: t("map.configure.badValue") };
      const savedJs = secrets.get(AMAP_SECRET.jsKey);
      const savedCode = secrets.get(AMAP_SECRET.securityCode);
      const savedService = secrets.get(AMAP_SECRET.serviceKey);
      if (js === undefined && code === undefined && service === undefined && savedJs === undefined && savedService === undefined) return { connection: "error", problem: t("map.configure.nothing") };
      /** 测完记下：过了存进密钥区；新填的没过时，存过的照用（写一句"还在用原来的"），没存过的写原因；再测存着的没过，照测出来的记 */
      const settle = (part: Part, result: ProbeResult, fresh: boolean, hadSaved: boolean, save: () => void) => {
        const label = part === "js" ? "Web 端" : "Web 服务"; // @i18n-ignore log：日志里的说法
        if (result.ok) {
          save();
          note(part, result);
          options.log(`高德地图：${label} Key 测过了${result.limit ? "（高德说用量到上限了）" : ""}`); // @i18n-ignore log
          return;
        }
        options.log(`高德地图：${label} Key 没测过（${result.failure}）`);
        const text = redact(result.text, secrets);
        if (!fresh) note(part, result);
        else problems[part] = { kind: "configure", text: hadSaved ? t("map.configure.keptOld", { reason: text }) : text };
      };
      // 地图那一组：新填了其中一样就两样一起测（另一样沿用存着的）；只填了查询的 Key 时不动它；什么都没填就再测一次存着的
      if (js !== undefined || code !== undefined || (savedJs !== undefined && service === undefined)) {
        const pairJs = js ?? savedJs;
        const pairCode = code ?? savedCode;
        if (pairJs === undefined || pairCode === undefined) problems.js = { kind: "configure", text: t("map.configure.pairNeeded") };
        else {
          const result = await probe("js", pairJs, pairCode);
          settle("js", result, js !== undefined || code !== undefined, savedJs !== undefined, () => {
            secrets.set(AMAP_SECRET.jsKey, pairJs);
            secrets.set(AMAP_SECRET.securityCode, pairCode);
          });
        }
      }
      if (service !== undefined || (savedService !== undefined && js === undefined && code === undefined)) {
        const key = service ?? savedService!;
        const result = await probe("service", key, undefined);
        settle("service", result, service !== undefined, savedService !== undefined, () => secrets.set(AMAP_SECRET.serviceKey, key));
      }
      return status(secrets);
    },

    async recheck(secrets, signal) {
      for (const part of ["js", "service"] as const) {
        if (problems[part]?.kind !== "key") continue;
        const key = secrets.get(part === "js" ? AMAP_SECRET.jsKey : AMAP_SECRET.serviceKey);
        const code = secrets.get(AMAP_SECRET.securityCode);
        if (key === undefined || (part === "js" && code === undefined)) continue;
        const result = await probe(part, key, part === "js" ? code : undefined, signal);
        // 连不上不算好了也不算更糟：留着原来的问题
        if (result.ok || result.failure !== "other") note(part, result);
        if (result.ok) options.log(`高德地图：${part === "js" ? "Web 端" : "Web 服务"} Key 又能用了（出错后每小时再试一次时）`); // @i18n-ignore log
      }
    },

    reset() {
      delete problems.js;
      delete problems.service;
    },

    serviceReply(body, httpStatus) {
      const result = judge(body, "service", httpStatus);
      if (!result.ok && result.failure === "other") return;
      const before = problems.service?.kind;
      note("service", result);
      if (!result.ok && before !== "key") options.log(`高德地图：查地点、路线时高德说 Web 服务 Key 不对（${result.failure}）`); // @i18n-ignore log
    },

    mapKey() {
      const s = options.secrets();
      const key = s.get(AMAP_SECRET.jsKey);
      if (key === undefined || !s.has(AMAP_SECRET.securityCode) || problems.js?.kind === "key") return undefined;
      return key;
    },

    mapProblem() {
      return problems.js?.kind === "key" && filled(options.secrets()).js ? problems.js.text : undefined;
    },

    async proxy(subPath, search, signal, userAgent) {
      const secrets = options.secrets();
      const code = secrets.get(AMAP_SECRET.securityCode);
      if (code === undefined || !secrets.has(AMAP_SECRET.jsKey)) return plain(503, t("map.proxy.noKey"));
      if (!/^\/[A-Za-z0-9/_.-]*$/.test(subPath) || subPath.includes("..") || subPath.includes("//")) return plain(404, t("map.proxy.badPath"));
      const params = new URLSearchParams(search.startsWith("?") ? search.slice(1) : search);
      params.delete("jscode");
      params.append("jscode", code);
      const base = subPath.startsWith("/v4/map/styles") ? hosts.webapi : subPath.startsWith("/v3/vectormap") ? hosts.vectormap : hosts.rest;
      try {
        const res = await fetch(`${base}${subPath}?${params}`, {
          headers: { Accept: "*/*", ...(userAgent ? { "User-Agent": userAgent } : {}) },
          redirect: "manual",
          signal: AbortSignal.any([AbortSignal.timeout(timeoutMs), signal]),
        });
        const body = Buffer.from(await res.arrayBuffer());
        if (body.length > MAX_PROXY_BYTES) return plain(502, t("map.proxy.failed"));
        if (res.status >= 300 && res.status < 400) return plain(502, t("map.proxy.failed"));
        const type = res.headers.get("content-type") ?? "application/octet-stream";
        // 高德说 Key、安全密钥不对：记下（地图页下次不拿 Key、国内先用 OpenStreetMap；连接状态报出错）
        if (body.length <= SCAN_BYTES && /json|javascript|text/.test(type)) {
          const m = /"(?:infocode|info)"\s*:\s*"(10001|10008|10009|10006|INVALID_USER_KEY|INVALID_USER_SCODE|USERKEY_PLAT_NOMATCH|INVALID_USER_DOMAIN)"/.exec(body.toString("utf8"));
          const failure = m ? KEY_ERRORS[m[1]!] : undefined;
          if (failure && problems.js?.kind !== "key") {
            problems.js = { kind: "key", text: failureText(failure, "js") };
            options.log(`高德地图：转发时高德说 Web 端 Key 不对（${failure}），地图页国内先用 OpenStreetMap`);
          }
        }
        return { status: res.status, headers: { "Content-Type": type, "Cache-Control": "no-store" }, body };
      } catch (err) {
        if (signal.aborted) throw err;
        const reason = err instanceof Error && err.name === "TimeoutError" ? "timeout" : err instanceof Error ? (causeOf(err) ?? err.message) : String(err);
        options.log(`高德地图：转发 ${subPath} 没成：${redact(reason, secrets)}`);
        return plain(502, t("map.proxy.failed"));
      }
    },
  };
}

/** 给浏览器的一句纯文字 */
function plain(status: number, text: string): MapReply {
  return { status, headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" }, body: Buffer.from(`${text}\n`) };
}

/** fetch 出错时真正的原因（undici 把它放在 cause 里，外面只有 "fetch failed"） */
function causeOf(err: Error): string | undefined {
  const cause = (err as { cause?: unknown }).cause;
  if (cause instanceof Error) return (cause as { code?: string }).code ?? cause.message;
  return undefined;
}
