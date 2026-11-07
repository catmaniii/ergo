// 体检里二狗替插件生成的几项（409）：插件不用写代码，每个插件块里自动有——
// - 插件本身（id "plugin"）：在跑 → 正常；没装上 → 坏了（附原因，动作跳设置 · 插件）；没装上是因为它要的外部组件没装
//   （用户没选用，PluginInfo.missing）→ 不适用（只是提示）。停用、移除了的插件没有这一块（doctor.ts 只列一下名字）。
// - 它的每个数据源（id "source:<数据源 id>"）：读设置 · 数据源整页视图的现成状态（DataSourceDoctorFacts），不联网——
//   插件没装上、没连、两种用法都关着 → 不适用；要重新授权 → 坏了；连接出错 → 坏了（原因原文）；导入开着、定期导入的
//   超过间隔 3 倍（数据源自己定了 usages.import.staleAfterMs 的按它，414：Looki 是 26 小时）没同步成功 → 注意（"过期"，从上次成功起）；
//   最近一次同步出错 → 注意（时间和原因）；别的正常（写上次成功的时间）。
// - 它的每个 agent 运行时（id "runtime:<运行时 id>"，Claude Code、Codex）：读运行时登记表——能用 → 正常；外部程序没装、没有任务
//   和项目用它 → 不适用（提示怎么装）；没装、可有任务或项目用着它 → 坏了；插件没装上（别的原因）→ 不适用（插件本身那一行已经是红的）。
// 都是纯函数：交回一项的草稿（没拼句子），句子由 doctor.ts 按当前语言拼。时间按当前语言先写好放进参数（formatDate）。
import { type AgentRuntimeView, type DataSourceView, type DoctorItemView, type DoctorMessage, formatDate, type PluginInfo } from "@ergo/protocol";
import type { DataSourceDoctorFacts } from "../data-sources/service.ts";

/** 一项的草稿：句子还没拼（DoctorItemView 去掉 text） */
export type DoctorItemDraft = Omit<DoctorItemView, "text">;

/** 定期导入超过间隔的几倍没同步成功算过期 */
export const SOURCE_STALE_FACTOR = 3;

/** 设置 · 插件、设置 · 数据源（某一个）的地址 */
const PLUGINS_ROUTE = "#/more/plugins";
const sourceRoute = (id: string) => `#/more/data-sources/${id}`;

/** 时间写成"11/7 14:30"这样（按当前语言） */
export function doctorTime(iso: string): string {
  return formatDate(iso, { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

/** 插件本身那一行；停用、移除了的没有（undefined） */
export function pluginItem(info: PluginInfo): DoctorItemDraft | undefined {
  const title: DoctorMessage = { key: "doctor.plugin.title" };
  if (info.state === "running") return { id: "plugin", level: "ok", title, fact: { key: "doctor.plugin.running" } };
  if (info.state !== "skipped") return undefined;
  const reason = info.problem ?? "";
  if (info.missing) return { id: "plugin", level: "na", title, fact: { key: "doctor.plugin.missing", params: { reason } } };
  return { id: "plugin", level: "error", title, fact: { key: "doctor.plugin.skipped", params: { reason } }, fix: { key: "doctor.fix.pluginSkipped" }, action: { kind: "open", route: PLUGINS_ROUTE } };
}

/** 导入这种用法开着没有 */
const usageOn = (view: DataSourceView, usage: "query" | "import") => view.usages.some((u) => u.usage === usage && u.on);

/** 一个数据源那一项（now：此刻的毫秒时间戳） */
export function sourceItem(facts: DataSourceDoctorFacts, now: number): DoctorItemDraft {
  const { view, lastOkAt, everyMs, staleMs } = facts;
  const id = `source:${view.id}`;
  const title: DoctorMessage = { key: "doctor.source.title", params: { name: view.title } };
  const open = { kind: "open" as const, route: sourceRoute(view.id) };
  const na = (fact: DoctorMessage): DoctorItemDraft => ({ id, level: "na", title, fact });
  if (!view.available) return na({ key: "doctor.pluginOff" });
  const last = view.lastSync;
  if (view.connection === "manual") return last ? { id, level: "ok", title, fact: { key: "doctor.source.manual", params: { time: doctorTime(last.at) } } } : na({ key: "doctor.source.manualNever" });
  if (view.connection === "not_connected") return na({ key: "doctor.source.notConnected" });
  if (view.needsAuth) {
    const fact: DoctorMessage = view.problem ? { key: "doctor.source.needsAuthWhy", params: { problem: view.problem } } : { key: "doctor.source.needsAuth" };
    return { id, level: "error", title, fact, fix: { key: "doctor.fix.sourceAuth" }, action: open };
  }
  if (view.connection === "error") {
    const fact: DoctorMessage = view.problem ? { key: "doctor.source.error", params: { problem: view.problem } } : { key: "doctor.source.errorNoReason" };
    return { id, level: "error", title, fact, fix: { key: "doctor.fix.sourceError" }, action: open };
  }
  // 连着
  if (!usageOn(view, "import")) return usageOn(view, "query") ? { id, level: "ok", title, fact: { key: "doctor.source.query" } } : na({ key: "doctor.source.off" });
  const failed = last?.error !== undefined && last.trigger !== "file" ? last : undefined;
  const sync = { key: "doctor.fix.sourceSync" };
  // 定期导入的：超过间隔 3 倍（数据源自己定了过期时长的按它）没同步成功算过期（从上次成功起）
  if (everyMs !== undefined && lastOkAt !== undefined && now - Date.parse(lastOkAt) > (staleMs ?? SOURCE_STALE_FACTOR * everyMs)) {
    const hours = Math.floor((now - Date.parse(lastOkAt)) / 3_600_000);
    const schedule = view.schedule ?? "";
    const fact: DoctorMessage = failed
      ? { key: "doctor.source.staleFailed", params: { hours, schedule, error: failed.error! } }
      : { key: "doctor.source.stale", params: { hours, schedule } };
    return { id, level: "warn", title, fact, fix: sync, since: lastOkAt, action: open };
  }
  if (failed) return { id, level: "warn", title, fact: { key: "doctor.source.lastFailed", params: { time: doctorTime(failed.at), error: failed.error! } }, fix: sync, action: open };
  if (lastOkAt !== undefined) return { id, level: "ok", title, fact: { key: "doctor.source.synced", params: { time: doctorTime(lastOkAt) } } };
  return { id, level: "ok", title, fact: { key: "doctor.source.never" } };
}

/** 一个运行时那一项（users：用着它的、没结束的任务和项目有几个） */
export function runtimeItem(view: AgentRuntimeView, users: number): DoctorItemDraft {
  const id = `runtime:${view.id}`;
  const title: DoctorMessage = { key: "doctor.runtime.title", params: { name: view.title } };
  if (view.available) return { id, level: "ok", title, fact: { key: "doctor.runtime.ok" } };
  const reason = view.unavailable ?? "";
  if (!view.missing) return { id, level: "na", title, fact: { key: "doctor.pluginOff" } };
  if (users === 0) return { id, level: "na", title, fact: { key: "doctor.runtime.missing", params: { reason } } };
  return { id, level: "error", title, fact: { key: "doctor.runtime.missingUsed", params: { count: users, reason } }, fix: { key: "doctor.fix.runtimeMissing" }, action: { kind: "open", route: PLUGINS_ROUTE } };
}
