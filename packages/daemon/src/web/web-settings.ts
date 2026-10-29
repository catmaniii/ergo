// 设置里 agent 的联网搜索、读网页（154 号票起；162 号票改成三种方式的队列，用户 2026-10-18 定；182 号票加第四种"鸿蒙 App 的内置浏览器"，
// 162 号票存的三项读的时候把它加在最后、认不得的方式跳过）：DeepSeek 付费搜索、二狗自带的浏览器搜索、
// agent-browser 排成一个队列，排前面的先用，能停用（至少留一个）。数据目录配置区的 web-settings.json 是真相，只由设置接口写，所有设备一样；
// 没有文件按默认（protocol 的 DEFAULT_WEB_SETTINGS：DeepSeek → 浏览器 → agent-browser → 鸿蒙 App 的内置浏览器，都启用——DeepSeek 配了 key 时才实际用上）。
// 154 号票的旧文件（format 1：默认的搜索方式、读网页用不用 DeepSeek）读成队列（migrateWebSettingsV1），记一条日志，存一次写成 format 2。
// 启动时读一次，之后只经设置接口改（手改要重启）；文件读不出来按默认用、记一条日志、设置页上写明原因，存一次就覆盖（照模型设置的做法）。
// 存之前查合规（webSettingsProblem：四种各一项、至少留一个启用而且用得上的）。联网工具每次现取（access.ts 的 settings），改了下一次
// 搜索、读网页就按新的；工具说明跟着队列写（tools.ts），所以改了通知听的人（onChange）：常驻的秘书手头这一条处理完按新的重新装配。
import fs from "node:fs";
import {
  copyWebSettings,
  DEFAULT_WEB_SETTINGS,
  effectiveWebQueue,
  migrateWebSettingsV1,
  normalizeWebQueue,
  schemaChecker,
  t,
  WEB_METHOD_LABEL,
  type WebSettings,
  type WebSettingsBody,
  WebSettingsFile,
  WebSettingsFileV1,
  type WebSettingsView,
  webQueueShapeProblem,
  webSettingsProblem,
} from "@ergo/protocol";
import { providerOf } from "../model-settings/providers.ts";
import { writeJsonAtomic } from "../util/json-file.ts";

export interface WebSettingsService {
  /** 存着的（没有文件、文件坏了是默认） */
  current(): WebSettings;
  /** 设置页要的：存着的、实际用的顺序、DeepSeek 的 key 配没配、最近一次余额不足、文件读不出来的原因 */
  view(): WebSettingsView;
  /** 要存的合不合规（四种各一项、至少留一个启用而且用得上的）：合规是 undefined，不然是原因（设置接口回 400） */
  problem(body: WebSettingsBody): string | undefined;
  /** 整份存（请求体已经按 schema 查过、problem 查过） */
  change(body: WebSettingsBody): WebSettingsView;
  /** 存了以后叫一次（工具说明跟着变：秘书重新装配）；回一个取消的函数 */
  onChange(listener: () => void): () => void;
}

export interface WebSettingsOptions {
  /** config/web-settings.json（DataDirLayout.webSettingsFile） */
  file: string;
  /** 配了 DeepSeek 的 key 没有（现取，和模型共用同一份） */
  deepseekKey: () => boolean;
  /** 守护进程是不是经 LSM 拉起的（key 只有经 LSM 才注入） */
  lsm: () => boolean;
  /** 最近一次 DeepSeek 回余额不足的时间（DeepSeek 客户端记的） */
  balanceLowAt: () => string | undefined;
  log: (line: string) => void;
}

const fileChecker = schemaChecker(WebSettingsFile);
const v1Checker = schemaChecker(WebSettingsFileV1);
const DEEPSEEK = providerOf("deepseek");

/** 一行说法：启用的按顺序，停用的另写（日志里用） */
function describeQueue(settings: WebSettings): string {
  const on = settings.queue.filter((e) => e.enabled).map((e) => WEB_METHOD_LABEL[e.method]);
  const off = settings.queue.filter((e) => !e.enabled).map((e) => WEB_METHOD_LABEL[e.method]);
  return `${on.join(" → ")}${off.length > 0 ? `（停用：${off.join("、")}）` : ""}`; // @i18n-ignore log
}

/** 读设置文件：没有是默认；旧格式读成队列；读不了、不合规时 error 是原因，按默认用、记一条日志（先不覆盖：设置页上提示，存一次才覆盖） */
function readSettings(file: string, log: (line: string) => void): { settings: WebSettings; error?: string } {
  const broken = (error: string) => {
    log(`联网设置的文件读不出来：${file}：${error}；正在用默认，设置页保存会覆盖它`);
    return { settings: copyWebSettings(DEFAULT_WEB_SETTINGS), error };
  };
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return { settings: copyWebSettings(DEFAULT_WEB_SETTINGS) };
    return broken(err instanceof Error ? err.message : String(err));
  }
  if (v1Checker.check(parsed)) {
    const settings = migrateWebSettingsV1(parsed);
    log(`联网设置是 154 号票的旧格式（默认的搜索方式 ${parsed.search === "deepseek" ? "DeepSeek" : "浏览器"}，读网页${parsed.deepseekFetch ? "用" : "不用"} DeepSeek），按队列读：${describeQueue(settings)}；设置页保存后写成新格式`);
    return { settings };
  }
  if (!fileChecker.check(parsed)) return broken(t("web.settings.badFormat", { detail: fileChecker.firstError(parsed) ?? t("web.settings.invalid") }));
  // 182 号票：认不得的方式跳过，缺的（162 号票存的三项里没有鸿蒙 App 的内置浏览器）加在最后、启用；不立刻改写，设置页存一次才写进去
  const { settings, skipped, added } = normalizeWebQueue(parsed.queue);
  const shape = webQueueShapeProblem(settings);
  if (shape) return broken(shape);
  if (skipped.length > 0) log(`联网设置的文件里认不得的方式跳过：${skipped.join("、")}`);
  if (added.length > 0) log(`联网设置的文件里没有${added.map((m) => WEB_METHOD_LABEL[m]).join("、")}（182 号票新加的），加在最后、启用；设置页保存后写进文件`);
  return { settings };
}

export function createWebSettings(options: WebSettingsOptions): WebSettingsService {
  let { settings, error } = readSettings(options.file, options.log);
  const listeners = new Set<() => void>();
  const view = (): WebSettingsView => {
    const configured = options.deepseekKey();
    const balanceLowAt = options.balanceLowAt();
    return {
      settings: copyWebSettings(settings),
      effective: effectiveWebQueue(settings, configured),
      deepseekKey: { configured, envVar: DEEPSEEK?.keyEnv ?? "DEEPSEEK_API_KEY", secretFile: DEEPSEEK?.secretFile ?? "secrets/deepseek-api-key.txt", lsm: options.lsm() },
      ...(balanceLowAt === undefined ? {} : { deepseekBalanceLowAt: balanceLowAt }),
      ...(error === undefined ? {} : { settingsFileError: error }),
    };
  };
  return {
    current: () => copyWebSettings(settings),
    view,
    problem: (body) => webSettingsProblem(body, options.deepseekKey()),
    change(body) {
      const next = copyWebSettings(body);
      writeJsonAtomic(options.file, { format: 2, ...next } satisfies WebSettingsFile);
      settings = next;
      error = undefined;
      options.log(`联网设置改了：${describeQueue(next)}`);
      for (const listener of listeners) listener();
      return view();
    },
    onChange(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}
