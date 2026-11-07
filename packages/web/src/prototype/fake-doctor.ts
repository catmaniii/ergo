// 原型里的设置 · 体检（409、410）：编的一份体检结果，五种结果都有——
// - 二狗本身：八项（组件缺记忆的向量模型是注意；外网入口登记了 tailnet，可服务管家从外面打不通，是坏了；句子由协议包的八项拼句按当前语言拼），
//   加上内核登记的几项（410），照 2026-11-07 那天的样子编：主对话在线在干活；模型近况坏了（最近 5 轮服务商报 503 / 500）；
//   对话长度要注意（93.5 万 token，过了自动压缩点 70 万，带"现在压缩"）；托管的服务坏了（8090 的语音合成停着，带"打开服务管家"）；
//   插件、网页文件正常。句子照守护进程的文案键拼（和真的一样）；
// - 插件块：每个在跑的插件一块（插件本身在跑）；记忆多两项（推理库正常、记忆简报这次没查出来），Looki 的数据源过期（跳到数据源详情），
//   语音合成服务坏了（跳到设置 · 语音），Codex 要的外部程序没装（插件本身和运行时都是不适用），手机、Google 的数据源正常，
//   Claude Code 的运行时正常；
// - 停用、移除了的插件（地址带 ?demo-plugins-off=…）不成块，只列名字。
// 二狗替插件生成的那几项照守护进程的文案键拼（doctorItemText，和真的一样）；插件自己的检查项（412、413 才做）是编好的中文，
// 英文在 en/fake-doctor.ts（假 HTTP 照表换）。
import {
  coreDoctorItem,
  defaultAssistantName,
  DOCTOR_CHECKS,
  DOCTOR_CORE_GROUP,
  type DoctorAction,
  type DoctorCheckDataById,
  type DoctorCheckId,
  doctorCounts,
  type DoctorDeepItemView,
  type DoctorDeepView,
  type DoctorGroupView,
  type DoctorItemView,
  doctorItemText,
  type DoctorLevel,
  type DoctorMessage,
  type DoctorView,
  formatDate,
  formatList,
  formatNumber,
  type PluginsView,
  sortDoctorGroups,
  sortDoctorItems,
  t,
  worstLevel,
} from "../state/index.ts";
import { fakeText } from "./fake-content.ts";

/** 八项编的事实：六项好的，组件缺记忆的向量模型；外网入口登记了 tailnet，服务管家从外面打不通（入口不通的原因是编的，按语言换） */
function coreData(): { [Id in DoctorCheckId]: DoctorCheckDataById[Id] } {
  return {
    ports: { local: 8810, external: 8811, localUp: true, externalUp: true },
    node: { running: "22.23.4", expected: "22" },
    pi: { version: "1.0.4" },
    supervisor: { running: true, port: 7420, link: "connected" },
    model: { configured: true },
    components: { missing: ["memory.semantic"] },
    disk: { freeGb: 42.3, totalGb: 476.8, path: "C:\\Users\\demo\\.ergo" },
    external: { configured: true, kind: "tailscale", entries: [{ kind: "tailnet", url: "https://ergo.demo-tailnet.ts.net/", reachable: false, why: fakeText("tailnet 节点离线") }] },
  };
}

/** 坏的那两项：组件是注意，外网入口唯一的入口打不通是坏了 */
const CORE_BAD: Partial<Record<DoctorCheckId, { level: DoctorLevel; fix: string }>> = {
  components: { level: "warn", fix: "doctor.fix.components" },
  external: { level: "error", fix: "doctor.fix.externalUnreachable" },
};

/** 查的时刻 */
const AT = "2026-11-07T07:30:00.000Z";

/** 照文案键拼的一项（二狗替插件生成的那几项和真的一样，用守护进程的文案） */
function keyed(id: string, level: DoctorLevel, title: DoctorMessage, fact: DoctorMessage, extra: { fix?: DoctorMessage; since?: string; action?: DoctorAction } = {}): DoctorItemView {
  const shape = { title, fact, ...(extra.fix ? { fix: extra.fix } : {}) };
  return { id, level, ...shape, ...(extra.since ? { since: extra.since } : {}), ...(extra.action ? { action: extra.action } : {}), text: doctorItemText(shape) };
}

/** 编好句子的一项（插件自己的检查项：文案键在插件的语言文件里，412、413 才有，这里直接写句子） */
function said(id: string, level: DoctorLevel, title: string, fact: string, extra: { fix?: string; action?: DoctorAction } = {}): DoctorItemView {
  const demo: DoctorMessage = { key: "demo" };
  return { id, level, title: demo, fact: demo, ...(extra.fix ? { fix: demo } : {}), ...(extra.action ? { action: extra.action } : {}), text: { title, fact, ...(extra.fix ? { fix: extra.fix } : {}) } };
}

/** 时间写成"11/7 14:30"这样（和守护进程一样） */
const time = (iso: string) => formatDate(iso, { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });

const running = () => keyed("plugin", "ok", { key: "doctor.plugin.title" }, { key: "doctor.plugin.running" });
const source = (title: string): DoctorMessage => ({ key: "doctor.source.title", params: { name: fakeText(title) } });

/** 每个插件那一块除了"插件本身"之外的几项 */
function extras(name: string): DoctorItemView[] {
  switch (name) {
    case "memory":
      // 记忆简报这次没查出来：事实和修法是体检自己的那两句
      return [said("graph", "ok", "推理库", "能打开；昨晚 03:12 整理过"), said("brief", "unknown", "记忆简报", t("doctor.unknown.timeout", { seconds: 1.5 }), { fix: t("doctor.fix.retry") })];
    case "voice":
      return [
        said("speech", "error", "语音合成服务", "连不上 127.0.0.1:8090（从 15:42 起），语音回复都没合成", { fix: "在服务管家里把语音合成服务开起来，再查一遍", action: { kind: "open", route: "#/more/voice" } }),
        said("recognizer", "ok", "语音识别服务", "在听（127.0.0.1:8091）"),
      ];
    case "looki":
      return [
        keyed("source:looki", "warn", source("Looki"), { key: "doctor.source.stale", params: { hours: 85, schedule: fakeText("每天 02:30") } }, {
          fix: { key: "doctor.fix.sourceSync" },
          since: "2026-11-04T02:30:00+08:00",
          action: { kind: "open", route: "#/more/data-sources/looki" },
        }),
      ];
    case "google":
      return [
        keyed("source:google-calendar", "ok", source("Google · 日历"), { key: "doctor.source.synced", params: { time: time("2026-11-07T15:00:00+08:00") } }),
        keyed("source:google-gmail", "ok", source("Google · Gmail"), { key: "doctor.source.query" }),
      ];
    case "phone":
      return [keyed("source:phone-calendar", "ok", source("手机 · 日历"), { key: "doctor.source.synced", params: { time: time("2026-11-07T14:12:00+08:00") } })];
    case "claude-code":
      return [keyed("runtime:claude-code", "ok", { key: "doctor.runtime.title", params: { name: "Claude Code" } }, { key: "doctor.runtime.ok" })];
    default:
      return [];
  }
}

/** Codex：要的外部程序没装、也没有任务用它（只是提示） */
function codexItems(): DoctorItemView[] {
  const reason = fakeText("没装 Codex：在终端里跑 npm i -g @openai/codex，装好后在设置 · 插件里启用");
  return [
    keyed("plugin", "na", { key: "doctor.plugin.title" }, { key: "doctor.plugin.missing", params: { reason } }),
    keyed("runtime:codex", "na", { key: "doctor.runtime.title", params: { name: "Codex" } }, { key: "doctor.runtime.missing", params: { reason } }),
  ];
}

/** token 数写成"93.5 万"（和守护进程一样） */
const tokens = (n: number) => t("doctor.tokens.n", { n: formatNumber(n / (Number(t("doctor.tokens.unit")) || 10_000), { maximumFractionDigits: 1 }) });

/** 内核登记的几项（410），照 11-07 那天的样子：模型近况坏了、对话长度要注意、托管的服务坏了，别的正常 */
function kernelItems(): DoctorItemView[] {
  const name = defaultAssistantName();
  const gists = formatList([t("doctor.modelCalls.gist.busy"), t("doctor.modelCalls.gist.server", { code: "500" })]);
  const stopped = t("doctor.services.stateWithError", { state: t("doctor.services.state.stopped"), error: fakeText("进程退出（代码 3221225477）") });
  const services = t("doctor.services.one", { uses: t("doctor.services.use.speech"), name: "audiocpp", state: stopped });
  return [
    keyed("assistant", "ok", { key: "doctor.check.assistant.title" }, { key: "doctor.assistant.busy", params: { name } }),
    keyed(
      "model-calls",
      "error",
      { key: "doctor.check.modelCalls.title" },
      { key: "doctor.modelCalls.allFailed", params: { n: 5, gists, time: time("2026-11-07T15:26:00+08:00"), model: "deepseek/deepseek-chat" } },
      { fix: { key: "doctor.fix.modelCalls" }, since: "2026-11-07T15:02:00+08:00", action: { kind: "open", route: "#/more/models" } },
    ),
    keyed(
      "context",
      "warn",
      { key: "doctor.check.context.title" },
      { key: "doctor.context.over", params: { name, used: tokens(935_000), at: tokens(700_000), window: tokens(1_048_576) } },
      { fix: { key: "doctor.fix.context" }, action: { kind: "compact", agentId: "secretary" } },
    ),
    keyed(
      "services",
      "error",
      { key: "doctor.check.services.title" },
      { key: "doctor.services.badSome", params: { list: services, fine: 2 } },
      { fix: { key: "doctor.fix.services" }, action: { kind: "open", route: "http://127.0.0.1:7420/" } },
    ),
    keyed("plugins", "ok", { key: "doctor.check.plugins.title" }, { key: "doctor.plugins.fine", params: { running: 9 } }),
    keyed("web", "ok", { key: "doctor.check.web.title" }, { key: "doctor.web.fine" }),
  ];
}

/** 一块：项排好（不适用的放最后），块的结果取最差的 */
function group(id: string, kind: DoctorGroupView["kind"], title: string, items: readonly DoctorItemView[]): DoctorGroupView {
  const sorted = sortDoctorItems(items);
  return { id, kind, title, level: worstLevel(sorted.map((item) => item.level)), items: sorted };
}

/**
 * 编的体检结果：plugins 是原型的插件清单（停用、移除了的进"停用的插件"）；不给是全部在跑
 */
export function fakeDoctorView(plugins?: PluginsView): DoctorView {
  const data = coreData();
  const checks = DOCTOR_CHECKS.map((id) => {
    const bad = CORE_BAD[id];
    return { id, ok: bad === undefined, data: data[id], ...(bad === undefined ? {} : { fix: bad.fix }) };
  });
  const core = group(DOCTOR_CORE_GROUP, "core", t("doctor.group.core"), [...checks.map((check) => coreDoctorItem(check, CORE_BAD[check.id]?.level ?? "ok")), ...kernelItems()]);
  const list = plugins?.plugins ?? [];
  const groups: DoctorGroupView[] = [core];
  const off: DoctorView["off"] = [];
  for (const plugin of list) {
    if (plugin.state === "disabled" || plugin.state === "removed") {
      off.push({ plugin: plugin.name, title: plugin.title, state: plugin.state });
      continue;
    }
    groups.push(group(plugin.name, "plugin", plugin.title, plugin.name === "codex" ? codexItems() : [running(), ...extras(plugin.name)]));
  }
  const sorted = sortDoctorGroups(groups);
  const counts = doctorCounts(sorted);
  const level: DoctorLevel = counts.error > 0 ? "error" : counts.warn > 0 ? "warn" : "ok";
  return { checks, groups: sorted, off, level, counts, at: AT };
}

// ───────── 深度体检（415）：编的一份，照 11-07 那天的样子——测模型时 DeepSeek 回 503（服务商忙），数据库完整，Looki 认得 Key，
// Claude Code 登录着（Codex 在原型里没装，没有它那一项）。打开时是"3 分钟前测的"那一份；点"再测一遍"在原型里逐项出结果（每项隔一会儿），
// 测完一分钟内再点说"刚测过"。句子照守护进程的文案键拼（doctorItemText，和真的一样，换语言跟着换）。─────────

/** 秒数写成"0.6"这样（和守护进程一样） */
const secs = (ms: number) => formatNumber(ms / 1000, { maximumFractionDigits: 1 });

/** 深度体检测完的一项 */
function deepDone(groupId: string, groupTitle: string, item: DoctorItemView, ms: number): DoctorDeepItemView {
  return { group: groupId, groupTitle, id: item.id, title: item.text.title, state: "done", item, ms };
}

/** 编的深度体检各项（停用、移除了的插件没有它那一项） */
export function fakeDoctorDeepItems(plugins?: PluginsView): DoctorDeepItemView[] {
  const core = t("doctor.group.core");
  /** 插件在跑时它的名字（没有插件清单时用 fallback）；停用、移除了的是 undefined */
  const titleIfRunning = (name: string, fallback: string) => {
    if (plugins === undefined) return fallback;
    const found = plugins.plugins.find((plugin) => plugin.name === name);
    return found?.state === "running" ? found.title : undefined;
  };
  const items: DoctorDeepItemView[] = [
    deepDone(
      DOCTOR_CORE_GROUP,
      core,
      keyed(
        "model-probe",
        "error",
        { key: "doctor.check.modelProbe.title" },
        { key: "doctor.modelProbe.failed", params: { model: "deepseek-flash", why: t("doctor.modelProbe.why.busy", { code: "503" }), seconds: secs(640) } },
        { fix: { key: "doctor.fix.modelProbe.busy" }, action: { kind: "open", route: "#/more/models" } },
      ),
      2_400,
    ),
    deepDone(
      DOCTOR_CORE_GROUP,
      core,
      keyed("database", "ok", { key: "doctor.check.database.title" }, { key: "doctor.database.ok", params: { size: t("doctor.size.mb", { n: formatNumber(312) }), seconds: secs(2_400) } }),
      2_400,
    ),
  ];
  const claude = titleIfRunning("claude-code", "Claude Code");
  // 插件自己的文案键（claudeCode.doctor.*）网页的词典里没有：真的由守护进程拼好，这里直接写句子（英文在 en/fake-doctor.ts）
  if (claude !== undefined) items.push(deepDone("claude-code", claude, said("login", "ok", "登录", "登录了（Claude Max 订阅）"), 1_100));
  const looki = titleIfRunning("looki", "Looki");
  if (looki !== undefined) {
    items.push(
      deepDone(
        "looki",
        looki,
        keyed("probe:looki", "ok", { key: "doctor.check.sourceProbe.title", params: { name: "Looki" } }, { key: "doctor.sourceProbe.okAccount", params: { account: "d***@example.com", seconds: secs(720) } }),
        720,
      ),
    );
  }
  return items;
}

/** 测完的里坏了、要注意、没查出来的各几项 */
function deepCounts(items: readonly DoctorDeepItemView[]): DoctorDeepView["counts"] {
  const counts = { error: 0, warn: 0, unknown: 0 };
  for (const entry of items) {
    const level = entry.item?.level;
    if (level === "error" || level === "warn" || level === "unknown") counts[level] += 1;
  }
  return counts;
}

/** 原型里两次之间至少隔多久（和守护进程一样一分钟） */
const DEEP_GAP_MS = 60_000;
/** 原型里每项测多久才出结果 */
const DEEP_STEP_MS = 700;

/** 原型里的深度体检：打开是 3 分钟前测完的那一份；点了逐项出结果 */
export class FakeDoctorDeep {
  private readonly plugins: () => PluginsView | undefined;
  private startedAt: number;
  private finishedAt: number | undefined;
  /** 正在测时已经出了结果的有几项 */
  private shown: number;

  constructor(plugins: () => PluginsView | undefined) {
    this.plugins = plugins;
    this.finishedAt = Date.now() - 3 * 60_000;
    this.startedAt = this.finishedAt - 4_000;
    this.shown = Number.POSITIVE_INFINITY;
  }

  view(): Promise<DoctorDeepView> {
    return attemptView(() => this.current());
  }

  start(): Promise<DoctorDeepView> {
    const now = Date.now();
    if (this.finishedAt === undefined) return this.view();
    if (now - this.finishedAt < DEEP_GAP_MS) return Promise.reject(new Error(t("doctor.deep.tooSoon", { seconds: Math.ceil((this.finishedAt + DEEP_GAP_MS - now) / 1000) })));
    this.startedAt = now;
    this.finishedAt = undefined;
    this.shown = 0;
    const total = fakeDoctorDeepItems(this.plugins()).length;
    for (let i = 1; i <= total; i += 1) {
      setTimeout(() => {
        this.shown = i;
        if (i === total) this.finishedAt = Date.now();
      }, i * DEEP_STEP_MS);
    }
    return this.view();
  }

  private current(): DoctorDeepView {
    const now = Date.now();
    const items = fakeDoctorDeepItems(this.plugins()).map((entry, at): DoctorDeepItemView => (at < this.shown ? entry : { group: entry.group, groupTitle: entry.groupTitle, id: entry.id, title: entry.title, state: "pending" }));
    const done = this.finishedAt;
    return {
      state: done === undefined ? "running" : "done",
      startedAt: new Date(this.startedAt).toISOString(),
      ...(done === undefined ? {} : { finishedAt: new Date(done).toISOString() }),
      ...(done !== undefined && now - done < DEEP_GAP_MS ? { nextAt: new Date(done + DEEP_GAP_MS).toISOString() } : {}),
      items,
      counts: deepCounts(items),
      now: new Date(now).toISOString(),
    };
  }
}

/** 同步算出来的交成 Promise（算的时候抛错就是拒绝） */
function attemptView<T>(fn: () => T): Promise<T> {
  try {
    return Promise.resolve(fn());
  } catch (err) {
    return Promise.reject(err instanceof Error ? err : new Error(String(err)));
  }
}
