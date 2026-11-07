// 原型里的设置 · 体检（409）：编的一份体检结果，五种结果都有——
// - 二狗本身：八项（组件缺记忆的向量模型、外网入口没查到依据，都是注意，各带修法；句子由协议包的八项拼句按当前语言拼），
//   加一项编的"对话长度"（主对话过了自动压缩点，带"现在压缩"按钮；410 做的那种）；
// - 插件块：每个在跑的插件一块（插件本身在跑）；记忆多两项（推理库正常、记忆简报这次没查出来），Looki 的数据源过期（跳到数据源详情），
//   语音那一块是 413 的五项（合成服务连不上、从 15:42 起，修法写到服务管家把组件装的那一条开起来，"去看看"跳服务管家的网页；
//   识别、参考音色、ffmpeg、N 卡正常），Codex 要的外部程序没装（插件本身和运行时都是不适用），手机、Google 的数据源正常，
//   Claude Code 的运行时正常；
// - 停用、移除了的插件（地址带 ?demo-plugins-off=…）不成块，只列名字。
// 二狗替插件生成的那几项照守护进程的文案键拼（doctorItemText，和真的一样）；插件自己的检查项是编好的中文（插件的文案键在插件自己的
// 语言文件里，网页的词典里没有；语音那几句照 voice.json 的 voice.doctor.* 抄），英文在 en/fake-doctor.ts（假 HTTP 照表换）。
import {
  coreDoctorItem,
  DOCTOR_CHECKS,
  DOCTOR_CORE_GROUP,
  type DoctorAction,
  type DoctorCheckDataById,
  type DoctorCheckId,
  doctorCounts,
  type DoctorGroupView,
  type DoctorItemView,
  doctorItemText,
  type DoctorLevel,
  type DoctorMessage,
  type DoctorView,
  formatDate,
  type PluginsView,
  sortDoctorGroups,
  sortDoctorItems,
  t,
  worstLevel,
} from "../state/index.ts";
import { fakeText } from "./fake-content.ts";

/** 八项编的事实：六项好的，组件缺记忆的向量模型、外网入口没查到依据 */
const CORE_DATA: { [Id in DoctorCheckId]: DoctorCheckDataById[Id] } = {
  ports: { local: 8810, external: 8811, localUp: true, externalUp: true },
  node: { running: "22.23.4", expected: "22" },
  pi: { version: "1.0.4" },
  supervisor: { running: true, port: 7420 },
  model: { configured: true },
  components: { missing: ["memory.semantic"] },
  disk: { freeGb: 42.3, totalGb: 476.8, path: "C:\\Users\\demo\\.ergo" },
  external: { configured: false },
};

/** 坏的那两项算注意 */
const CORE_BAD: Partial<Record<DoctorCheckId, DoctorLevel>> = { components: "warn", external: "warn" };

/** 查的时刻 */
const AT = "2026-11-07T07:30:00.000Z";

/** 照文案键拼的一项（二狗替插件生成的那几项和真的一样，用守护进程的文案） */
function keyed(id: string, level: DoctorLevel, title: DoctorMessage, fact: DoctorMessage, extra: { fix?: DoctorMessage; since?: string; action?: DoctorAction } = {}): DoctorItemView {
  const shape = { title, fact, ...(extra.fix ? { fix: extra.fix } : {}) };
  return { id, level, ...shape, ...(extra.since ? { since: extra.since } : {}), ...(extra.action ? { action: extra.action } : {}), text: doctorItemText(shape) };
}

/** 编好句子的一项（插件自己的检查项：文案键在插件的语言文件里，网页拿不到，这里直接写句子） */
function said(id: string, level: DoctorLevel, title: string, fact: string, extra: { fix?: string; since?: string; action?: DoctorAction } = {}): DoctorItemView {
  const demo: DoctorMessage = { key: "demo" };
  return {
    id,
    level,
    title: demo,
    fact: demo,
    ...(extra.fix ? { fix: demo } : {}),
    ...(extra.since ? { since: extra.since } : {}),
    ...(extra.action ? { action: extra.action } : {}),
    text: { title, fact, ...(extra.fix ? { fix: extra.fix } : {}) },
  };
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
      // 413 的五项：合成服务停了（组件装的那一条），去看看跳服务管家的网页
      return [
        said("speech", "error", "语音合成", "语音合成服务没开（http://127.0.0.1:8090）：你发语音时的回复都合成不了，退回只发文字", {
          fix: "在装二狗的那台电脑上打开服务管家，把「语音合成服务（audio.cpp）」（ergo-daemon--audiocpp）开起来，再查一遍",
          since: "2026-11-07T15:42:00+08:00",
          action: { kind: "open", route: "http://127.0.0.1:7420/" },
        }),
        said("recognizer", "ok", "语音识别", "服务管家托管的识别服务（127.0.0.1:8091）：模型加载好了（large-v3）"),
        said("references", "ok", "参考音色", "有 2 条，语音回复用「示例音色」"),
        said("ffmpeg", "ok", "ffmpeg", "找到了：C:\\Tools\\ffmpeg\\bin\\ffmpeg.exe"),
        said("gpu", "ok", "N 卡", "有 N 卡：语音合成、识别跑在显卡上"),
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

/** 编的"对话长度"（410 做的那种）：主对话过了自动压缩点，带"现在压缩" */
const contextItem = () =>
  said("context", "warn", "对话长度", "主对话已经用了 935k token，过了自动压缩点 700k 还没压下去", { fix: "点「现在压缩」；压完再查一遍", action: { kind: "compact", agentId: "secretary" } });

/** 一块：项排好（不适用的放最后），块的结果取最差的 */
function group(id: string, kind: DoctorGroupView["kind"], title: string, items: readonly DoctorItemView[]): DoctorGroupView {
  const sorted = sortDoctorItems(items);
  return { id, kind, title, level: worstLevel(sorted.map((item) => item.level)), items: sorted };
}

/**
 * 编的体检结果：plugins 是原型的插件清单（停用、移除了的进"停用的插件"）；不给是全部在跑
 */
export function fakeDoctorView(plugins?: PluginsView): DoctorView {
  const checks = DOCTOR_CHECKS.map((id) => {
    const ok = CORE_BAD[id] === undefined;
    return { id, ok, data: CORE_DATA[id], ...(ok ? {} : { fix: `doctor.fix.${id}` }) };
  });
  const core = group(DOCTOR_CORE_GROUP, "core", t("doctor.group.core"), [...checks.map((check) => coreDoctorItem(check, CORE_BAD[check.id] ?? "ok")), contextItem()]);
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
