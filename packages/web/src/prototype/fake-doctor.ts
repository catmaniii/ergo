// 原型里的设置 · 体检（409–414）：编的一份体检结果，五种结果都有——
// - 二狗本身：八项（组件缺记忆的向量模型是注意；外网入口登记了 tailnet，可服务管家从外面打不通，是坏了；句子由协议包的八项拼句按当前语言拼），
//   加上内核登记的几项（410），照 2026-11-07 那天的样子编：主对话在线在干活；模型近况坏了（最近 5 轮服务商报 503 / 500）；
//   对话长度要注意（93.5 万 token，过了自动压缩点 70 万，带"现在压缩"）；托管的服务坏了（8090 的语音合成 audiocpp 停着，带"打开服务管家"）；
//   插件、网页文件正常。句子照守护进程的文案键拼（和真的一样）；再加 411 的十项（备份 EBUSY、日志 265 MB、
//   合集缺两个 skill 是注意，待办、旧手机、预写日志是提示，别的正常；文案键和守护进程的一样）；
// - 插件块：每个在跑的插件一块（插件本身在跑）；记忆是 412 的六项（句子照守护进程 memory.doctor.* 的中文写：向量索引、推理库、
//   记忆系统、整理前导入数据源正常，记忆简报超时多是注意，每晚整理 60 小时没跑成是坏了、跳记忆管理员），
//   Looki 的"存一份到本地"出了问题（Looki 换了接口，注意；414），Google 的一个日历地址失效了（坏了，数据源那一项是上次同步出错的注意；414），
//   语音那一块是 413 的五项（合成服务连不上、从 15:42 起，修法写到服务管家把 audiocpp 开起来——和"托管的服务"说的是同一个服务，
//   那边从服务管家看它停着、记的出错，这边从语音看回复合成不了——"打开服务管家"跳服务管家的网页；识别、参考音色、ffmpeg 正常，
//   N 卡这次没查出来（第一次问要跑 nvidia-smi，1.5 秒没查完）），Codex 要的外部程序没装（插件本身和运行时都是不适用），
//   手机、提醒、日历、内置浏览器、Claude Code 各自登记的那几项正常（414）；
// - 停用、移除了的插件（地址带 ?demo-plugins-off=…）不成块，只列名字。
// 二狗替插件生成的那几项照守护进程的文案键拼（doctorItemText，和真的一样）；插件自己的检查项是编好的中文（文案键在插件自己的
// 语言文件里，网页取不到；记忆那几句照 412 守护进程拼出来的样子写，语音那几句照 voice.json 的 voice.doctor.* 抄），
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
  type DoctorWatchKey,
  type DoctorWatchView,
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

/** 编好句子的一项（插件自己的检查项：文案键在插件的语言文件里，网页取不到，这里直接写句子） */
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

/** 记忆上次整理跑成的时间（每晚整理那一项坏了：60 小时前） */
const LAST_NIGHTLY = "2026-11-05T03:14:00+08:00";
const source = (title: string): DoctorMessage => ({ key: "doctor.source.title", params: { name: fakeText(title) } });

/** 每个插件那一块除了"插件本身"之外的几项 */
function extras(name: string): DoctorItemView[] {
  switch (name) {
    case "memory":
      // 412 的六项：记忆简报超时多（注意），每晚整理 60 小时没跑成（坏了，跳记忆管理员那页看整理记录），别的正常
      return [
        said("index", "ok", "向量索引", "1284 条素材都算好了向量"),
        said("graph", "ok", "推理库", "能用，问记忆和记忆简报在用（12.4 MB）"),
        said("system", "ok", "记忆系统", `会意在跑：523 条有效证据，上次整理完是 ${time(LAST_NIGHTLY)}，占 12.4 MB`),
        said("brief", "warn", "记忆简报", `${time("2026-11-06T15:30:00+08:00")} 以来问了 30 次，超时 12 次、出错 0 次（占 40%）；最近一次用了 3 秒`, {
          fix: "超过 3 秒的那一轮就不带记忆了。多半是向量模型算得慢、推理库太大：重启二狗后再看；一直这样就把这句反馈给我们",
        }),
        said("nightly", "error", "每晚整理", `上次跑成是 60 小时前（${time(LAST_NIGHTLY)}），之后一直没跑成`, {
          fix: "夜里 03:00 二狗要开着；去记忆管理员那页看整理记录，找没跑成的原因",
          since: LAST_NIGHTLY,
          action: { kind: "open", route: "#/more/memory/curator" },
        }),
        said("presync", "ok", "整理前导入数据源", `${time("2026-11-07T03:01:00+08:00")} 整理之前都导好了：Google · 日历（新进来 3 条）`),
      ];
    case "voice":
      // 413 的五项：合成服务停了（手工登记在 8090 上的 audiocpp，和"托管的服务"那一项同一个），去看看跳服务管家的网页；N 卡这次没查出来
      return [
        said("speech", "error", "语音合成", "语音合成服务没开（http://127.0.0.1:8090）：你发语音时的回复都合成不了，退回只发文字", {
          fix: "在装二狗的那台电脑上打开服务管家，把「audiocpp」开起来，再查一遍",
          since: "2026-11-07T15:42:00+08:00",
          action: { kind: "open", route: "http://127.0.0.1:7420/" },
        }),
        said("recognizer", "ok", "语音识别", "服务管家托管的识别服务（127.0.0.1:8091）：模型加载好了（large-v3）"),
        said("references", "ok", "参考音色", "有 2 条，语音回复用「示例音色」"),
        said("ffmpeg", "ok", "ffmpeg", "找到了：C:\\Tools\\ffmpeg\\bin\\ffmpeg.exe"),
        // 没查出来：事实和修法是体检自己的那两句
        said("gpu", "unknown", "N 卡", t("doctor.unknown.timeout", { seconds: 1.5 }), { fix: t("doctor.fix.retry") }),
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

/** 大小写成"265 MB"（和守护进程一样按当前语言） */
const mb = (n: number) => t("doctor.size.mb", { n: formatNumber(n) });

/** 体检项名字的文案键（和守护进程的一样） */
const checkTitle = (id: string): DoctorMessage => ({ key: `doctor.check.${id}.title` });
/** "去看看"跳到某一页 */
const openRoute = (route: string): DoctorAction => ({ kind: "open", route });

/**
 * "二狗本身"的新检查（二）（411，守护进程 doctor/housekeeping.ts 的那十项），照今天的样子编：备份最近一次因为 EBUSY 没做成、
 * 服务管家的日志 265 MB、matt-pocock 合集缺两个 skill（都是注意）；别的正常；待办、旧手机、预写日志是提示（正常，带事实）
 */

function housekeepingItems(): DoctorItemView[] {
  const cookie = "EBUSY: resource busy or locked, open 'C:\\Users\\demo\\.ergo\\outputs\\t-47\\.ergo-tmp\\sgac-profile\\Default\\Network\\Cookies'";
  const log = "C:\\Users\\demo\\AppData\\Local\\ergo\\supervisor\\logs\\ergo-daemon.out.log";
  return [
    keyed("backup", "warn", checkTitle("backup"), { key: "doctor.backup.failedLatest", params: { time: time("2026-11-07T06:37:00+08:00"), error: cookie, date: "2026-11-06" } }, {
      fix: { key: "doctor.fix.backupFailed" },
      action: openRoute("#/more/backup"),
    }),
    keyed("triggers", "ok", checkTitle("triggers"), { key: "doctor.triggers.ok" }),
    keyed("internal-jobs", "ok", checkTitle("internalJobs"), { key: "doctor.internalJobs.ok", params: { count: 9 } }),
    keyed("stuck-agents", "ok", checkTitle("stuckAgents"), { key: "doctor.stuckAgents.ok", params: { live: 3, max: 8 } }),
    keyed(
      "log-size",
      "warn",
      checkTitle("logSize"),
      { key: "doctor.logSize.bad", params: { limit: mb(200), items: t("doctor.logSize.file", { file: log, where: t("doctor.logSize.supervisor"), size: mb(265) }) } },
      { fix: { key: "doctor.fix.logSize" } },
    ),
    keyed("config-files", "ok", checkTitle("configFiles"), { key: "doctor.configFiles.ok" }),
    keyed(
      "missing-skills",
      "warn",
      checkTitle("missingSkills"),
      { key: "doctor.missingSkills.bad", params: { items: t("doctor.missingSkills.collection", { collection: "matt-pocock", names: formatList(["handoff", "to-questionnaire"]) }) } },
      { fix: { key: "doctor.fix.steps", params: { steps: t("doctor.missingSkills.fixCollection") } }, action: openRoute("#/more/skills") },
    ),
    keyed("pending", "ok", checkTitle("pending"), { key: "doctor.pending.withApprovals", params: { count: 6, approvals: 2 } }, { action: openRoute("#/inbox") }),
    keyed(
      "app-version",
      "ok",
      checkTitle("appVersion"),
      { key: "doctor.appVersion.old", params: { count: 1, min: "0.4.1", devices: t("doctor.appVersion.device", { name: fakeText("家里的平板"), version: "0.3.9" }) } },
      { fix: { key: "doctor.fix.appVersion" }, action: openRoute("#/more/devices") },
    ),
    keyed("db-wal", "ok", checkTitle("dbWal"), { key: "doctor.dbWal.ok", params: { size: mb(18) } }),
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
  const core = group(DOCTOR_CORE_GROUP, "core", t("doctor.group.core"), [...checks.map((check) => coreDoctorItem(check, CORE_BAD[check.id]?.level ?? "ok")), ...kernelItems(), ...housekeepingItems()]);
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

/**
 * 后台盯着（416）的那一段：每 5 分钟；编的一项"不再提醒"——对话长度（体检页上它是注意，用户嫌它天天提醒点了不再提醒）。
 * 名字用守护进程同一个文案键按当前语言拼（真的守护进程也这样拼）；"恢复提醒"了就拿掉（刷新页面回到编好的样子）
 */
export class FakeDoctorWatch {
  private muted: Array<DoctorWatchKey & { titleKey: string; at: string }> = [{ group: DOCTOR_CORE_GROUP, id: "context", titleKey: "doctor.check.context.title", at: "2026-11-06T13:40:00.000Z" }];

  view(): DoctorWatchView {
    return { everyMinutes: 5, muted: this.muted.map((entry) => ({ group: entry.group, id: entry.id, title: t(entry.titleKey), at: entry.at })) };
  }

  unmute(key: DoctorWatchKey): DoctorWatchView {
    this.muted = this.muted.filter((entry) => entry.group !== key.group || entry.id !== key.id);
    return this.view();
  }
}
