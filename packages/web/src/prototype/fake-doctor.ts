// 原型里的设置 · 体检（409）：编的一份体检结果，五种结果都有——
// - 二狗本身：八项（组件缺记忆的向量模型、外网入口没查到依据，都是注意，各带修法；句子由协议包的八项拼句按当前语言拼），
//   加一项编的"对话长度"（主对话过了自动压缩点，带"现在压缩"按钮；410 做的那种）；
// - 插件块：每个在跑的插件一块（插件本身在跑）；记忆多两项（推理库正常、记忆简报这次没查出来），
//   Looki 的"存一份到本地"停下了（Looki 换了接口，注意；414），Google 的一个日历地址失效了（坏了，数据源那一项是上次同步出错的注意；414），
//   语音合成服务坏了（跳到设置 · 语音），Codex 要的外部程序没装（插件本身和运行时都是不适用），手机、提醒、日历、内置浏览器、
//   Claude Code 各自登记的那几项正常（414）；
// - 停用、移除了的插件（地址带 ?demo-plugins-off=…）不成块，只列名字。
// 二狗替插件生成的那几项照守护进程的文案键拼（doctorItemText，和真的一样）；插件自己的检查项（文案键在插件的语言文件里，网页没有）
// 是编好的中文，英文在 en/fake-doctor.ts（假 HTTP 照表换）。
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

/** 编好句子的一项（插件自己的检查项：文案键在插件的语言文件里，网页的词典里没有，这里直接写句子） */
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
      return [
        said("speech", "error", "语音合成服务", "连不上 127.0.0.1:8090（从 15:42 起），语音回复都没合成", { fix: "在服务管家里把语音合成服务开起来，再查一遍", action: { kind: "open", route: "#/more/voice" } }),
        said("recognizer", "ok", "语音识别服务", "在听（127.0.0.1:8091）"),
      ];
    case "looki":
      // 数据源那一项正常；"存一份到本地"停下了：列 vlog 时 Looki 回"接口停用了"（424 写在那一块上的原因，体检照抄）
      return [
        keyed("source:looki", "ok", source("Looki"), { key: "doctor.source.synced", params: { time: time("2026-11-07T02:31:00+08:00") } }),
        said("archive", "warn", "存一份到本地", "出了问题：vlog 没存：Looki 换了接口：这个接口停用了（HTTP 400：This endpoint is deprecated）。照片、日记照常存，二狗跟着改好之前 vlog 先存不了", {
          fix: "去设置 · 数据源 · Looki 的「存一份到本地」那一块看原因：位置、磁盘、权限的问题照它说的改；写着 Looki 回的不对（比如换了接口）的，等二狗更新，照片、日记照常存",
          action: { kind: "open", route: "#/more/data-sources/looki" },
        }),
      ];
    case "google":
      // "工作"那个日历的私密地址失效了：每个日历地址那一项坏了；数据源那一项是上次同步出错（注意）
      return [
        keyed("source:google-calendar", "warn", source("Google · 日历"), { key: "doctor.source.lastFailed", params: { time: time("2026-11-07T15:00:00+08:00"), error: fakeText("「工作」：地址失效了（Google 回了 404）") } }, {
          fix: { key: "doctor.fix.sourceSync" },
          action: { kind: "open", route: "#/more/data-sources/google-calendar" },
        }),
        keyed("source:google-gmail", "ok", source("Google · Gmail"), { key: "doctor.source.query" }),
        said("calendar-feeds", "error", "每个日历地址", "「工作」连着 2 次没拉到：地址失效了（Google 回了 404）：可能在 Google 日历里重置过私密地址，去 Google 日历的设置里重新复制「iCal 格式的私密地址」", {
          fix: "地址失效、没权限的要重新复制：Google 日历网页版 → 这个日历的设置 → 「iCal 格式的私密地址」，在设置 · 数据源 · Google · 日历里删掉旧的、加上新的",
          since: "2026-11-07T14:30:00+08:00",
          action: { kind: "open", route: "#/more/data-sources/google-calendar" },
        }),
      ];
    case "phone":
      return [
        keyed("source:phone-calendar", "ok", source("手机 · 日历"), { key: "doctor.source.synced", params: { time: time("2026-11-07T14:12:00+08:00") } }),
        said("app", "ok", "手机 App", "最近一次交来东西是 11/7 14:12"),
        said("calendar-empty", "ok", "手机日历交来 0 条", "最近没有交来 0 条"),
      ];
    case "reminders":
      return [said("timezone", "ok", "时区", "和这台电脑一样（Asia/Shanghai）")];
    case "calendar":
      return [said("external-events", "ok", "数据源交来的日程", "都拿得到")];
    case "browsing":
      return [said("thumbnails", "ok", "缩略图", "这次开机以来缩了 12 批图，都没出错")];
    case "claude-code":
      return [
        keyed("runtime:claude-code", "ok", { key: "doctor.runtime.title", params: { name: "Claude Code" } }, { key: "doctor.runtime.ok" }),
        said("sdk", "ok", "Agent SDK", "Agent SDK 0.3.296；本机装了 Claude Code（claude.exe），会话、接管、交给官方 App 都用它"),
      ];
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
