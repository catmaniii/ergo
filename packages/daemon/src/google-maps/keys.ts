// 谷歌地图的两个 Key（446）：设置 · 数据源 · 谷歌地图里填，存在密钥区（data-sources/google-maps.json，一个值一格）：
// - browserKey 浏览器用的：给 Maps JavaScript API（地图页的谷歌底图）。谷歌的设计里它本来就在页面上——只能靠在 Google Cloud 里
//   给它加"网站限制"（写本机地址和二狗的外网地址）、"API 限制"（只勾 Maps JavaScript API）防别人拿去用；
// - serverKey 服务端用的：给 Places API (New)、Routes API、Geocoding API（守护进程直接调，不进页面）；在 Google Cloud 里加"IP 限制"
//   （这台电脑的出口 IP）、"API 限制"（只勾这三个）。
// 填了先测再存：
// - 服务端 Key：拿它调一次这三个 API（都是固定的东西，不是你的位置：新加坡鱼尾狮公园的逆地理编码、按名字搜它（只要编号，谷歌不收费）、
//   从它往旁边走几十米的步行路线），三个都过了才存；Key 不认、哪个 API 没开、Key 的限制不让、没开结算都写清哪一个；
//   新填的没过时原来存着的照用。用量到上限、一时太频繁算 Key 是认的（存上，写一句）；
// - 浏览器用的 Key：谷歌只让在网页里测它（守护进程拿它调接口不算数：网站限制按浏览器带的来源认），所以这里只看写法（像个 Key：
//   不带空白、长度对）就存；真不对时地图页加载谷歌底图会收到谷歌的 gm_authFailure，报给守护进程（POST /api/map/basemap），
//   这里记下：连接状态报出错（要重新填）、地图页不再拿这个 Key、退回 OpenStreetMap。它没法在后台再测，重新填（或断开）才清掉。
// 查地点、算路线时谷歌说服务端 Key 不对、没权限（client.ts 的 onReply），同样记下：连接状态报出错、秘书先不用谷歌查（退回 OpenStreetMap）；
// 内核每小时叫 recheck 拿存着的再测，好了就回来。Key 不进日志、不进事件、不进给页面的（除了浏览器用的那一个），出错的原因里碰到就换成 ***。
import { t } from "@ergo/protocol";
import type { DataSourceSecrets, DataSourceStatus } from "../data-sources/api.ts";
import { MapLookupError } from "../map/api.ts";
import type { GoogleClient, GoogleReply } from "./client.ts";

/** 密钥区里的名字（也是网页交来的值的名字） */
export const GOOGLE_MAPS_SECRET = { browserKey: "browserKey", serverKey: "serverKey" } as const;
/** 网页交来的"超了免费量还接着用"（不是密钥，存在插件自己的存储） */
export const ALLOW_OVERAGE_FIELD = "allowOverage";

/** 测服务端 Key 时问的地方（新加坡鱼尾狮公园）：固定的，不是你的位置 */
const PROBE = { lat: 1.2868, lon: 103.8545 };
const PROBE_NEAR = { lat: 1.2873, lon: 103.8549 };

/** 像不像一个 Key：不带空白、20～100 个字（谷歌的 Key 是 39 个字，AIza 开头；不卡死写法，换了格式也不至于填不进） */
const KEY_SHAPE = /^[A-Za-z0-9_\-.]{20,100}$/;

/** 记着的问题：key 要重新填（服务端 Key 不认、没权限；浏览器用的 Key 被谷歌拒了），limit 一时的（到上限），configure 新填的没测过 */
interface Problem {
  kind: "key" | "limit" | "configure";
  text: string;
}

type Part = "browser" | "server";

export interface GoogleMapsKeys {
  status(secrets: DataSourceSecrets): Omit<DataSourceStatus, "panel">;
  configure(values: Readonly<Record<string, string>>, secrets: DataSourceSecrets): Promise<void>;
  recheck(secrets: DataSourceSecrets, signal: AbortSignal): Promise<void>;
  /** 断开：忘掉记着的问题（密钥区那一格内核删） */
  reset(): void;
  /** 页面能拿的浏览器用的 Key：填了、谷歌没拒过才有 */
  browserKey(secrets: DataSourceSecrets): string | undefined;
  /** 谷歌拒了浏览器用的 Key 时给人看的一句 */
  browserProblem(secrets: DataSourceSecrets): string | undefined;
  /** 能用的服务端 Key：填了、谷歌没说它不对才有 */
  serverKey(secrets: DataSourceSecrets): string | undefined;
  /** 谷歌说服务端 Key 不对、没权限时的一句 */
  serverProblem(secrets: DataSourceSecrets): string | undefined;
  /** 地图页报来：谷歌拒了浏览器用的 Key（gm_authFailure） */
  browserRejected(): void;
  /** 查地点、算路线时谷歌的回应（client.ts 的 onReply） */
  serverReply(reply: GoogleReply): void;
}

/** 一次测服务端 Key 的结果 */
type ProbeResult = { ok: true; limit?: string } | { ok: false; failure: "key" | "denied" | "other"; text: string };

/** 一句话里出现的 Key 换成 *** */
function redact(text: string, keys: readonly (string | undefined)[]): string {
  let out = text;
  for (const v of keys) if (v && v.length >= 4) out = out.split(v).join("***");
  return out;
}

/** 一个 API 没过的那一句（哪个 API、为什么） */
function deniedText(api: string, err: MapLookupError): string {
  const why =
    err.code === "SERVICE_DISABLED"
      ? t("googleMaps.error.serviceDisabled")
      : err.code === "API_KEY_SERVICE_BLOCKED"
        ? t("googleMaps.error.apiRestricted")
        : err.code === "API_KEY_IP_ADDRESS_BLOCKED" || err.code === "API_KEY_HTTP_REFERRER_BLOCKED"
          ? t("googleMaps.error.appRestricted")
          : err.code === "BILLING_DISABLED"
            ? t("googleMaps.error.billing")
            : t("googleMaps.error.denied", { detail: err.detail });
  return t("googleMaps.error.apiFailed", { api, why });
}

/** 两个 Key 存了没有 */
const filled = (secrets: DataSourceSecrets) => ({ browser: secrets.has(GOOGLE_MAPS_SECRET.browserKey), server: secrets.has(GOOGLE_MAPS_SECRET.serverKey) });

export function createGoogleMapsKeys(options: { client: GoogleClient; log: (line: string) => void }): GoogleMapsKeys {
  const problems: Partial<Record<Part, Problem>> = {};

  /** 拿服务端 Key 调一次三个 API */
  const probe = async (key: string, signal?: AbortSignal): Promise<ProbeResult> => {
    const steps: Array<{ api: string; run: () => Promise<unknown> }> = [
      { api: "Geocoding API", run: () => options.client.geocode({ latlng: `${PROBE.lat},${PROBE.lon}` }, key, signal) },
      // 只要编号的搜索：谷歌的 Text Search Essentials (IDs Only)，不收费、不数
      { api: "Places API (New)", run: () => options.client.post("places", "/v1/places:searchText", { textQuery: "Merlion Park Singapore", pageSize: 1 }, "places.id", key, undefined, signal) },
      {
        api: "Routes API",
        run: () =>
          options.client.post(
            "routes",
            "/directions/v2:computeRoutes",
            { origin: { location: { latLng: { latitude: PROBE.lat, longitude: PROBE.lon } } }, destination: { location: { latLng: { latitude: PROBE_NEAR.lat, longitude: PROBE_NEAR.lon } } }, travelMode: "WALK" },
            "routes.distanceMeters",
            key,
            "routesEssentials",
            signal,
          ),
      },
    ];
    const failed: string[] = [];
    let limit: string | undefined;
    let other: string | undefined;
    for (const step of steps) {
      try {
        await step.run();
      } catch (err) {
        if (signal?.aborted) throw err;
        if (!(err instanceof MapLookupError)) throw err;
        if (err.failure === "key") return { ok: false, failure: "key", text: t("googleMaps.error.key") };
        if (err.failure === "denied") failed.push(deniedText(step.api, err));
        else if (err.failure === "quota" || err.failure === "rate") limit = t("googleMaps.error.limit", { detail: err.detail });
        else other ??= err.failure === "network" ? t("googleMaps.error.network", { reason: err.detail }) : t("googleMaps.error.other", { api: step.api, detail: err.detail });
      }
    }
    if (failed.length > 0) return { ok: false, failure: "denied", text: failed.join(t("googleMaps.problem.joiner")) };
    if (other !== undefined) return { ok: false, failure: "other", text: other };
    return limit === undefined ? { ok: true } : { ok: true, limit };
  };

  /** 一个 Key 的问题那一句 */
  const said = (p: Part) => t(p === "browser" ? "googleMaps.problem.browser" : "googleMaps.problem.server", { reason: problems[p]!.text });

  const status = (secrets: DataSourceSecrets): Omit<DataSourceStatus, "panel"> => {
    const f = filled(secrets);
    if (!f.browser && !f.server) {
      const tried = (["browser", "server"] as const).filter((p) => problems[p] !== undefined);
      return tried.length === 0 ? { connection: "not_connected" } : { connection: "error", problem: tried.map(said).join(t("googleMaps.problem.joiner")) };
    }
    const account = t("googleMaps.source.account", { browser: t(f.browser ? "googleMaps.source.filled" : "googleMaps.source.empty"), server: t(f.server ? "googleMaps.source.filled" : "googleMaps.source.empty") });
    const shown = (["browser", "server"] as const).filter((p) => problems[p] !== undefined && (f[p] || problems[p]!.kind === "configure"));
    const text = shown.map(said).join(t("googleMaps.problem.joiner"));
    if (shown.some((p) => problems[p]!.kind === "key")) return { connection: "error", problem: text, account, needsAuth: true };
    return { connection: "connected", ...(text === "" ? {} : { problem: text }), account };
  };

  /** 测完记下：过了清掉（到上限记成一时的），Key 不认、没权限记成要重新填的 */
  const note = (result: ProbeResult) => {
    if (result.ok) {
      if (result.limit) problems.server = { kind: "limit", text: result.limit };
      else delete problems.server;
      return;
    }
    problems.server = { kind: result.failure === "other" ? "configure" : "key", text: result.text };
  };

  return {
    status,

    async configure(values, secrets) {
      const typed = (name: string) => {
        const v = values[name]?.trim() ?? "";
        return v === "" ? undefined : v;
      };
      const browser = typed(GOOGLE_MAPS_SECRET.browserKey);
      const server = typed(GOOGLE_MAPS_SECRET.serverKey);
      const savedServer = secrets.get(GOOGLE_MAPS_SECRET.serverKey);
      if (browser !== undefined) {
        if (!KEY_SHAPE.test(browser)) problems.browser = { kind: "configure", text: t("googleMaps.configure.badKey") };
        else {
          secrets.set(GOOGLE_MAPS_SECRET.browserKey, browser);
          delete problems.browser;
          options.log("谷歌地图：浏览器用的 Key 存上了（谷歌只让在网页里测它，地图页用上时才知道对不对）"); // @i18n-ignore log
        }
      }
      if (server !== undefined && !KEY_SHAPE.test(server)) {
        problems.server = { kind: "configure", text: t("googleMaps.configure.badKey") };
        return;
      }
      // 只改了"超了还接着用"、或者只填了浏览器用的 Key：不再测服务端的
      if (server === undefined && (browser !== undefined || values[ALLOW_OVERAGE_FIELD] !== undefined)) return;
      const key = server ?? savedServer;
      if (key === undefined) {
        if (browser === undefined && !secrets.has(GOOGLE_MAPS_SECRET.browserKey)) problems.server = { kind: "configure", text: t("googleMaps.configure.nothing") };
        return;
      }
      const result = await probe(key);
      if (result.ok) {
        secrets.set(GOOGLE_MAPS_SECRET.serverKey, key);
        note(result);
        options.log(`谷歌地图：服务端 Key 测过了${result.limit ? "（谷歌说用量到上限了）" : ""}`); // @i18n-ignore log
        return;
      }
      options.log(`谷歌地图：服务端 Key 没测过（${result.failure}）`); // @i18n-ignore log
      const text = redact(result.text, [key, browser, secrets.get(GOOGLE_MAPS_SECRET.browserKey)]);
      if (server === undefined) note({ ...result, text });
      else problems.server = { kind: "configure", text: savedServer === undefined ? text : t("googleMaps.configure.keptOld", { reason: text }) };
    },

    async recheck(secrets, signal) {
      if (problems.server?.kind !== "key") return;
      const key = secrets.get(GOOGLE_MAPS_SECRET.serverKey);
      if (key === undefined) return;
      const result = await probe(key, signal);
      // 连不上不算好了也不算更糟：留着原来的问题
      if (result.ok || result.failure !== "other") note(result);
      if (result.ok) options.log("谷歌地图：服务端 Key 又能用了（出错后每小时再试一次时）"); // @i18n-ignore log
    },

    reset() {
      delete problems.browser;
      delete problems.server;
    },

    browserKey(secrets) {
      return problems.browser?.kind === "key" ? undefined : secrets.get(GOOGLE_MAPS_SECRET.browserKey);
    },

    browserProblem(secrets) {
      return problems.browser?.kind === "key" && filled(secrets).browser ? problems.browser.text : undefined;
    },

    serverKey(secrets) {
      return problems.server?.kind === "key" ? undefined : secrets.get(GOOGLE_MAPS_SECRET.serverKey);
    },

    serverProblem(secrets) {
      return problems.server?.kind === "key" && filled(secrets).server ? problems.server.text : undefined;
    },

    browserRejected() {
      if (problems.browser?.kind === "key") return;
      problems.browser = { kind: "key", text: t("googleMaps.error.browserRejected") };
      options.log("谷歌地图：地图页说谷歌拒了浏览器用的 Key（gm_authFailure），先不用谷歌底图"); // @i18n-ignore log
    },

    serverReply(reply) {
      if (reply.ok) {
        if (problems.server?.kind === "limit") delete problems.server;
        return;
      }
      const err = reply.error;
      if (err.failure === "key" || err.failure === "denied") {
        if (problems.server?.kind !== "key") options.log(`谷歌地图：查地点、路线时谷歌说服务端 Key 不对或没权限（${err.failure}${err.code ? ` ${err.code}` : ""}）`); // @i18n-ignore log
        problems.server = { kind: "key", text: err.failure === "key" ? t("googleMaps.error.key") : t("googleMaps.error.apiFailed", { api: "Google Maps Platform", why: t("googleMaps.error.denied", { detail: err.code ?? err.detail }) }) };
      } else if (err.failure === "quota") problems.server = { kind: "limit", text: t("googleMaps.error.limit", { detail: err.detail }) };
    },
  };
}
