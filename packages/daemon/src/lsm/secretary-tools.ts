// 秘书指挥服务管家的工具（418）：经二狗自己那条带身份的连接（lsm/link.ts 的 manage，协议 §9）看、启停、重启服务管家里的服务。
// 做成二狗自带的宿主工具、不做 MCP（理由：只有守护进程拿得到接入身份；秘书调 MCP 时守卫看不到风险；重启自己要和忙闲、
// 接入层在进程里配合），经 agent 的贡献清单只给秘书（daemon.ts 登记，排在内核的工具之后）。
//
// 按风险拆成六个工具，守卫的类别整个工具固定（不按参数变）：
// - 只读（只看，不落入类别）：lsm_status 看列表和某个服务的详情，lsm_logs 看某个服务最后几行日志（截短、擦掉像密钥的）；
// - 普通（不落入类别，用户说了就做）：lsm_control——启动、停止、等空闲再停、取消等空闲再停、立刻重启、开机自启开、按场景启动；
//   停止、重启遇到没有正常办法的服务（服务管家回 no-capability）自动改成强制的、结果里说明（用户 11-07 定的"直接停"）；
//   有正常办法的服务，用户点名要强制停、强制重启的走 lsm_force；
// - 要审批（落在秘书特别敏感的类别 SECRETARY_ASKS 里，对话审批关着也出审批卡）：
//   lsm_force（不可逆的提交）——强制停止、强制重启、开机自启关、按场景停止、撤销、裁决孤儿（认领 / 杀掉）；
//   lsm_entries（账户与安全：改的是外面谁连得上这个服务）——公网入口开关、tailnet 入口开关；
//   lsm_restart_self（不可逆的提交）——重启二狗自己，只能"等空闲再重启"。
// 动之前先取一次列表：按名字认出是哪个服务（全名、名下的短名、标题，不分大小写；对不上、不止一个都照实说），再按列表里的
// "受保护"（对二狗是命脉）在本地先拒一遍——说清是二狗自己 / 二狗的外网隧道 / 二狗离不开的；服务管家仍然最后裁决（回 protected）。
// 重启自己：服务管家收下就回"已排队"，工具拿到就返回（等结果会和自己的忙死锁：这次调用本身就算忙）；排上之后、秘书这一轮说完之前
// 也报忙（restart-hold.ts），免得二狗在秘书回话的半截停掉。
// 工具结果按当前语言写人话（服务名、状态、做了什么），给用户看的工具卡片上就是它；工具的说明给模型看，照旧中文。
// 服务管家的事一律用这几个工具，不用 bash 敲命令行或端口（工具说明里写明；守卫那边的拦截在 419）。
import { t, Type } from "@ergo/protocol";
import { defineHostTool, type HostTool, type HostToolOutput } from "../agent-manager/host-tools.ts";
import { redactSecretShapes } from "../guard/index.ts";
import { type LsmManage, type LsmManagedService, type LsmManageReply, type LsmProfileResult, MANAGE_REQUEST_TIMEOUT_MS } from "./link.ts";
import type { RestartSelfHold } from "./restart-hold.ts";
import { lsmToolDescriptions as d } from "./secretary-texts.ts";

/** 六个工具的名字（网页的工具调用说法按它认） */
export const LSM_TOOL = Object.freeze({
  status: "lsm_status",
  logs: "lsm_logs",
  control: "lsm_control",
  force: "lsm_force",
  entries: "lsm_entries",
  restartSelf: "lsm_restart_self",
} as const);

/** 日志默认给几行、最多几行（服务管家那边最多 500：给 agent 看的不用那么多） */
export const LOG_LINES_DEFAULT = 60;
export const LOG_LINES_MAX = 200;
/** 日志一行最长多少字、一共最多多少字（多了只留最后的） */
const LOG_LINE_MAX_CHARS = 400;
const LOG_TOTAL_MAX_CHARS = 6_000;
/** 会等服务管家回话的工具：比接入层的请求超时多一分钟，免得 agent 管家先把这次调用掐了 */
const SLOW_TOOL_TIMEOUT_MS = MANAGE_REQUEST_TIMEOUT_MS + 60_000;

export interface LsmToolDeps {
  /** 接入层的管理指令；接入层还没建好时是 undefined（守护进程里接入层比秘书晚建） */
  manage(): LsmManage | undefined;
  /** 重启自己排上之后、秘书这一轮说完之前算忙 */
  restartHold: RestartSelfHold;
}

type ControlAction = "start" | "stop" | "stop_when_idle" | "cancel_stop" | "restart" | "autostart_on" | "profile_start";
type ForceAction = "force_stop" | "force_restart" | "autostart_off" | "profile_stop" | "remove" | "orphan_adopt" | "orphan_kill";
type EntriesAction = "expose_on" | "expose_off" | "tailnet_open" | "tailnet_close";
type AnyAction = ControlAction | ForceAction | EntriesAction;

const literals = <T extends string>(values: readonly T[], description: string) => Type.Union(values.map((v) => Type.Literal(v)), { description });

const CONTROL_ACTIONS = ["start", "stop", "stop_when_idle", "cancel_stop", "restart", "autostart_on", "profile_start"] as const satisfies readonly ControlAction[];
const FORCE_ACTIONS = ["force_stop", "force_restart", "autostart_off", "profile_stop", "remove", "orphan_adopt", "orphan_kill"] as const satisfies readonly ForceAction[];
const ENTRIES_ACTIONS = ["expose_on", "expose_off", "tailnet_open", "tailnet_close"] as const satisfies readonly EntriesAction[];
/** 写 profile（场景名）的；别的写 service */
const PROFILE_ACTIONS: ReadonlySet<AnyAction> = new Set(["profile_start", "profile_stop"]);

/** 动作在语言文件里的名字（key 的段用小驼峰） */
const ACTION_KEY: Readonly<Record<AnyAction, string>> = {
  start: "start",
  stop: "stop",
  stop_when_idle: "stopWhenIdle",
  cancel_stop: "cancelStop",
  restart: "restart",
  autostart_on: "autostartOn",
  profile_start: "profileStart",
  force_stop: "forceStop",
  force_restart: "forceRestart",
  autostart_off: "autostartOff",
  profile_stop: "profileStop",
  remove: "remove",
  orphan_adopt: "orphanAdopt",
  orphan_kill: "orphanKill",
  expose_on: "exposeOn",
  expose_off: "exposeOff",
  tailnet_open: "tailnetOpen",
  tailnet_close: "tailnetClose",
};

const serviceParam = () => Type.String({ minLength: 1, maxLength: 80, description: d.serviceParam });
const profileParam = () => Type.String({ minLength: 1, maxLength: 80, description: d.profileParam });

// ───────────────────────── 说法（按当前语言） ─────────────────────────

const STATES = ["RUNNING", "DEGRADED", "STARTING", "STOPPING", "STOPPED", "FAILED", "ORPHAN"] as const;

/** 状态说成人话（不认识的照原样） */
function stateText(state: string): string {
  return (STATES as readonly string[]).includes(state) ? t(`lsm.tools.state.${state}`) : state;
}

/** 服务的称呼：全名，有不一样的标题时带上 */
function nameOf(s: Pick<LsmManagedService, "id" | "title">): string {
  return s.title && s.title !== s.id ? t("lsm.tools.named", { id: s.id, title: s.title }) : t("lsm.tools.quoted", { id: s.id });
}

const sep = () => t("lsm.tools.sep");
const listSep = () => t("lsm.tools.listSep");

/** 列表里的一行：名字、状态、端口、开机自启、二狗离不开、忙、等空闲再停、没在跑时最后一次出错 */
function serviceLine(s: LsmManagedService): string {
  const flags = [
    t("lsm.tools.line.state", { state: stateText(s.state) }),
    ...(s.port === null ? [] : [t("lsm.tools.line.port", { port: s.port })]),
    ...(s.autostart ? [t("lsm.tools.line.autostart")] : []),
    ...(s.protected ? [t("lsm.tools.line.protected")] : []),
    ...(s.busy ? [s.busyReason ? t("lsm.tools.line.busyWhy", { why: s.busyReason }) : t("lsm.tools.line.busy")] : []),
    ...(s.pendingStop ? [t("lsm.tools.line.pendingStop")] : []),
    ...(!s.up && s.lastError ? [t("lsm.tools.line.lastError", { error: s.lastError })] : []),
  ];
  return `${nameOf(s)}${t("lsm.tools.colon")}${flags.join(sep())}`;
}

/** 一个服务的详情（lsm_status 给了 service 时） */
function serviceDetail(s: LsmManagedService, list: readonly LsmManagedService[], self: string | undefined): string {
  const canStop = s.capabilities.includes("stop");
  const lines = [
    serviceLine(s),
    ...(s.project ? [t("lsm.tools.detail.project", { project: s.project })] : []),
    ...(s.owner ? [t("lsm.tools.detail.owner", { owner: s.owner })] : []),
    ...(s.pid ? [t("lsm.tools.detail.pid", { pid: s.pid })] : []),
    t(s.autostart ? "lsm.tools.detail.autostartOn" : "lsm.tools.detail.autostartOff"),
    t(canStop ? "lsm.tools.detail.canStop" : "lsm.tools.detail.noStop"),
    ...(s.dependsOn?.length ? [t("lsm.tools.detail.dependsOn", { list: s.dependsOn.map((x) => x.id).join(listSep()) })] : []),
    ...(s.profiles?.length ? [t("lsm.tools.detail.profiles", { list: s.profiles.join(listSep()) })] : []),
    ...(s.exposure ? [t("lsm.tools.detail.exposure", { tunnel: s.exposure.via, url: s.exposure.publicUrl ?? "—" })] : []),
    ...(s.tailnet ? [t("lsm.tools.detail.tailnet", { url: s.tailnet.url })] : []),
    ...(s.detail ? [t("lsm.tools.detail.detail", { detail: s.detail })] : []),
    ...(s.lastError ? [t("lsm.tools.detail.lastError", { error: s.lastError })] : []),
    ...(s.protected ? [t("lsm.tools.detail.protected", { why: protectedWhy(s, list, self) })] : []),
  ];
  return lines.join("\n");
}

/** 为什么二狗离不开它：二狗自己、二狗的外网隧道，别的照服务管家写的原因 */
function protectedWhy(s: LsmManagedService, list: readonly LsmManagedService[], self: string | undefined): string {
  if (self !== undefined && s.id === self) return t("lsm.tools.why.self");
  const own = list.find((x) => x.id === self);
  if (own?.exposure?.via === s.id) return t("lsm.tools.why.tunnel");
  return t("lsm.tools.why.other", { why: s.protectedWhy.join(listSep()) || "—" });
}

/** 动作说成动词（拒绝的话里用） */
function verbOf(action: AnyAction): string {
  return t(`lsm.tools.verb.${ACTION_KEY[action]}`);
}

/** 本地先拒：说清是谁、为什么、该怎么办 */
function refuse(action: AnyAction, s: LsmManagedService, list: readonly LsmManagedService[], self: string | undefined): HostToolOutput {
  const lines = [t("lsm.tools.refuse", { verb: verbOf(action), name: nameOf(s), why: protectedWhy(s, list, self) })];
  if (s.id === self && (action === "restart" || action === "force_restart")) lines.push(t("lsm.tools.refuseUseRestartSelf", { tool: LSM_TOOL.restartSelf }));
  lines.push(t("lsm.tools.refuseByHand"));
  return { text: lines.join(" "), isError: true };
}

/** 管理器、接入层回的失败说成人话 */
function failText(reply: Extract<LsmManageReply, { ok: false }>, action?: AnyAction, s?: LsmManagedService): string {
  const { code, message } = reply.error;
  const name = s ? nameOf(s) : "";
  switch (code) {
    case "not-linked":
      return t("lsm.tools.err.notLinked");
    case "not-connected":
    case "closed":
      return t("lsm.tools.err.notConnected");
    case "unsupported":
      return t("lsm.tools.err.unsupported");
    case "disconnected":
      return t("lsm.tools.err.disconnected", { tool: LSM_TOOL.status });
    case "timeout":
      return t("lsm.tools.err.timeout", { tool: LSM_TOOL.status });
    case "protected":
      return t("lsm.tools.err.protected", { message });
    case "no-capability":
      // 等空闲再停只对接入了忙闲的服务有意义；停、重启遇到它会自动改成强制的（act），走不到这里
      if (action === "stop_when_idle") return t("lsm.tools.err.noIdleStop", { name });
      return t("lsm.tools.err.failed", { message });
    case "not-found":
      return t("lsm.tools.err.notFound", { message });
    case "in-use":
      return t("lsm.tools.err.inUse", { message });
    case "not-owner":
      return t("lsm.tools.err.notOwner", { message });
    case "not-allowed":
      return t("lsm.tools.err.notAllowed", { message });
    default:
      return t("lsm.tools.err.failed", { message });
  }
}

/** 失败的工具结果：原因、现在的样子（管理器带了的话）、照实说 */
function failed(reply: Extract<LsmManageReply, { ok: false }>, action?: AnyAction, s?: LsmManagedService): HostToolOutput {
  const now = reply.service ? [t("lsm.tools.nowIs", { line: serviceLine(reply.service) })] : [];
  const results = reply.results?.length ? [profileResults(reply.results, action === "profile_stop")] : [];
  return { text: [failText(reply, action, s), ...results, ...now, t("lsm.tools.tellTruth")].join("\n"), isError: true };
}

/** 场景里每个服务的结果，一行一个 */
function profileResults(results: readonly LsmProfileResult[], stopping: boolean): string {
  return results
    .map((r) => {
      const what = r.ok
        ? r.pending
          ? t("lsm.tools.profile.pending")
          : r.already
            ? t(stopping ? "lsm.tools.profile.alreadyStopped" : "lsm.tools.profile.alreadyUp")
            : t(stopping ? "lsm.tools.profile.stopped" : "lsm.tools.profile.started")
        : t(stopping ? "lsm.tools.profile.notStopped" : "lsm.tools.profile.notStarted", { why: r.why ?? "—" });
      return `- ${r.id}${t("lsm.tools.colon")}${what}`;
    })
    .join("\n");
}

// ───────────────────────── 找服务、找场景 ─────────────────────────

/** 比的时候不看大小写和空白 */
const norm = (text: string) => text.toLowerCase().replace(/\s+/g, "");

/** 名下的服务的短名（<登记方>--<名字> 的后半段） */
const shortOf = (id: string) => (id.includes("--") ? id.slice(id.indexOf("--") + 2) : undefined);

/** 按名字找：全名、名下的短名、标题完全对得上的优先，其次是互相包含的 */
export function findManaged(services: readonly LsmManagedService[], query: string): LsmManagedService[] {
  const q = norm(query);
  if (!q) return [];
  const names = (s: LsmManagedService) => [s.id, shortOf(s.id) ?? "", s.title ?? ""].map(norm).filter(Boolean);
  const byId = services.filter((s) => norm(s.id) === q);
  if (byId.length > 0) return byId;
  const exact = services.filter((s) => names(s).includes(q));
  if (exact.length > 0) return exact;
  return services.filter((s) => names(s).some((n) => n.includes(q) || q.includes(n)));
}

type Listed = { ok: true; services: LsmManagedService[]; self: string | undefined; profiles: Record<string, string[]> } | { ok: false; out: HostToolOutput };

/** 取一次列表（失败的已经说成人话） */
async function listOf(manage: LsmManage | undefined): Promise<Listed> {
  if (!manage) return { ok: false, out: { text: t("lsm.tools.err.notLinked"), isError: true } };
  const reply = await manage.list();
  if (!reply.ok) return { ok: false, out: failed(reply) };
  return { ok: true, services: reply.services ?? [], self: reply.self, profiles: reply.profiles ?? {} };
}

/** 按名字认出一个服务；对不上、不止一个的照实说 */
function pick(listed: Extract<Listed, { ok: true }>, query: string | undefined): { s: LsmManagedService } | { out: HostToolOutput } {
  if (!query) return { out: { text: t("lsm.tools.find.needService"), isError: true } };
  const found = findManaged(listed.services, query);
  if (found.length === 1) return { s: found[0]! };
  const all = listed.services.map(nameOf).join(listSep());
  if (found.length === 0) return { out: { text: t("lsm.tools.find.none", { query, list: all || "—" }), isError: true } };
  return { out: { text: t("lsm.tools.find.ambiguous", { query, list: found.map(nameOf).join(listSep()) }), isError: true } };
}

/** 按名字认出一个场景（不看大小写） */
function pickProfile(listed: Extract<Listed, { ok: true }>, query: string | undefined): { profile: string; members: string[] } | { out: HostToolOutput } {
  if (!query) return { out: { text: t("lsm.tools.find.needProfile"), isError: true } };
  const names = Object.keys(listed.profiles);
  const hit = names.find((n) => n === query) ?? names.find((n) => norm(n) === norm(query));
  if (hit !== undefined) return { profile: hit, members: listed.profiles[hit] ?? [] };
  return { out: { text: names.length > 0 ? t("lsm.tools.find.noProfile", { profile: query, list: names.join(listSep()) }) : t("lsm.tools.find.noProfiles", { profile: query }), isError: true } };
}

/** 场景停止真正会停到的：成员和它们依赖的（不分软硬，和服务管家按依赖分层停的一样） */
function profileTouches(services: readonly LsmManagedService[], members: readonly string[]): LsmManagedService[] {
  const byId = new Map(services.map((s) => [s.id, s]));
  const seen = new Set<string>();
  const walk = (id: string) => {
    if (seen.has(id) || !byId.has(id)) return;
    seen.add(id);
    for (const dep of byId.get(id)!.dependsOn ?? []) walk(dep.id);
  };
  members.forEach(walk);
  return [...seen].map((id) => byId.get(id)!);
}

/** 这个动作会碰到的、对二狗是命脉的服务（本地先拒用）；没有是 undefined */
function protectedHit(action: AnyAction, s: LsmManagedService, services: readonly LsmManagedService[]): LsmManagedService | undefined {
  switch (action) {
    case "stop":
    case "stop_when_idle":
    case "restart":
    case "force_stop":
    case "force_restart":
    case "autostart_off":
    case "remove":
    case "orphan_kill":
    case "tailnet_close":
      return s.protected ? s : undefined;
    case "expose_off": {
      // 关公网入口 = 强制停它的隧道：目标或隧道是命脉都不行
      if (s.protected) return s;
      const tunnel = services.find((x) => x.id === s.exposure?.via);
      return tunnel?.protected ? tunnel : undefined;
    }
    default:
      return undefined;
  }
}

// ───────────────────────── 做 ─────────────────────────

/** 单个服务的一个动作发给服务管家 */
function send(manage: LsmManage, action: AnyAction, s: LsmManagedService, tailnetName: string | undefined): Promise<LsmManageReply> {
  switch (action) {
    case "start":
      return manage.start(s.id);
    case "stop":
      return manage.stop(s.id);
    case "stop_when_idle":
      return manage.stop(s.id, { mode: "when-idle" });
    case "cancel_stop":
      return manage.cancelStop(s.id);
    case "restart":
      return manage.restart(s.id);
    case "autostart_on":
      return manage.autostart(s.id, true);
    case "force_stop":
      return manage.stop(s.id, { force: true });
    case "force_restart":
      return manage.restart(s.id, { force: true });
    case "autostart_off":
      return manage.autostart(s.id, false);
    case "remove":
      return manage.remove(s.id);
    case "orphan_adopt":
      return manage.orphan(s.id, "adopt");
    case "orphan_kill":
      return manage.orphan(s.id, "kill");
    case "expose_on":
      return manage.exposeOn(s.id);
    case "expose_off":
      return manage.exposeOff(s.id);
    case "tailnet_open":
      return manage.tailnetOpen(s.id, tailnetName);
    case "tailnet_close":
      return manage.tailnetClose(s.id);
    case "profile_start":
    case "profile_stop":
      throw new Error(`${action} 不是单个服务的动作`); // @i18n-ignore log：编程错误
  }
}

/** 做成了：做了什么、现在的样子。forced：用户说的是停 / 重启，它没有正常的办法，自动改成了强制的 */
function doneText(action: AnyAction, s: LsmManagedService, reply: Extract<LsmManageReply, { ok: true }>, forced = false): string {
  const name = nameOf(s);
  const now = reply.service ?? s;
  const state = stateText(now.state);
  let said: string;
  if (forced && !reply.already && !reply.pending) said = t(action === "stop" ? "lsm.tools.done.forcedStop" : "lsm.tools.done.forcedRestart", { name });
  else if (reply.pending) said = t("lsm.tools.done.pending", { name });
  else if (reply.already) said = t(action === "start" || action === "expose_on" ? "lsm.tools.done.alreadyUp" : action === "stop" || action === "force_stop" || action === "expose_off" ? "lsm.tools.done.alreadyStopped" : "lsm.tools.done.already", { name });
  else {
    switch (action) {
      case "expose_on":
        said = t(now.exposure?.publicUrl ? "lsm.tools.done.exposeOnUrl" : "lsm.tools.done.exposeOn", { name, tunnel: reply.tunnel ?? now.exposure?.via ?? "—", url: now.exposure?.publicUrl ?? "" });
        break;
      case "expose_off":
        said = t("lsm.tools.done.exposeOff", { name, tunnel: reply.tunnel ?? "—" });
        break;
      case "tailnet_open":
        said = t("lsm.tools.done.tailnetOpen", { name, url: reply.url ?? now.tailnet?.url ?? "—" });
        break;
      case "orphan_kill":
        said = t("lsm.tools.done.orphanKill", { name, pids: (reply.killed ?? []).join(listSep()) || "—" });
        break;
      default:
        said = t(`lsm.tools.done.${ACTION_KEY[action]}`, { name, state });
    }
  }
  // 服务管家另外交代的（tailnet 入口要等 DNS 生效这类）
  const note = !reply.pending && reply.note ? [t("lsm.tools.managerNote", { note: reply.note })] : [];
  return [said, ...note, ...(reply.service ? [t("lsm.tools.nowIs", { line: serviceLine(reply.service) })] : [])].join("\n");
}

/** 一个动作走完：先认服务、本地先拒命脉，再发给服务管家、说结果 */
async function act(deps: LsmToolDeps, action: AnyAction, args: { service?: string; profile?: string; tailnetName?: string }): Promise<HostToolOutput> {
  const manage = deps.manage();
  const listed = await listOf(manage);
  if (!listed.ok) return listed.out;
  if (PROFILE_ACTIONS.has(action)) {
    const found = pickProfile(listed, args.profile);
    if ("out" in found) return found.out;
    const stopping = action === "profile_stop";
    if (stopping) {
      const hit = profileTouches(listed.services, found.members).find((s) => s.protected);
      if (hit) return refuse(action, hit, listed.services, listed.self);
    }
    const reply = stopping ? await manage!.profileStop(found.profile, { force: true }) : await manage!.profileStart(found.profile);
    if (!reply.ok) return failed(reply, action);
    const head = t(stopping ? "lsm.tools.done.profileStop" : "lsm.tools.done.profileStart", { profile: found.profile });
    return { text: [head, profileResults(reply.results ?? [], stopping)].join("\n") };
  }
  const found = pick(listed, args.service);
  if ("out" in found) return found.out;
  const hit = protectedHit(action, found.s, listed.services);
  if (hit) return refuse(action, hit, listed.services, listed.self);
  let reply = await send(manage!, action, found.s, args.tailnetName);
  // 用户 2026-11-07 定的"直接停"：没有正常停止 / 重启办法的服务（服务管家回 no-capability，命脉在上面已经拒了），
  // 说停就直接强制停、说重启就直接强制重启，不出审批卡；有正常办法的服务要强制停仍走 lsm_force
  const forced = !reply.ok && reply.error.code === "no-capability" && (action === "stop" || action === "restart");
  if (forced) reply = await send(manage!, action === "stop" ? "force_stop" : "force_restart", found.s, undefined);
  if (!reply.ok) return failed(reply, action, found.s);
  return { text: doneText(action, found.s, reply, forced) };
}

// ───────────────────────── 工具 ─────────────────────────

/** 秘书指挥服务管家的六个工具 */
export function lsmSecretaryTools(deps: LsmToolDeps): HostTool[] {
  const status = defineHostTool({
    name: LSM_TOOL.status,
    title: t("lsm.tools.title.status"),
    description: d.status,
    parameters: Type.Object({ service: Type.Optional(serviceParam()) }, { additionalProperties: false }),
    readOnlyOrIdempotent: true,
    nature: "look",
    run: async ({ service }) => {
      const listed = await listOf(deps.manage());
      if (!listed.ok) return listed.out;
      if (service !== undefined) {
        const found = pick(listed, service);
        if ("out" in found) return found.out;
        return { text: serviceDetail(found.s, listed.services, listed.self) };
      }
      if (listed.services.length === 0) return { text: t("lsm.tools.status.empty") };
      const profiles = Object.entries(listed.profiles).map(([name, members]) => t("lsm.tools.status.profile", { name, list: members.join(listSep()) || "—" }));
      return {
        text: [
          t("lsm.tools.status.head", { count: listed.services.length, n: listed.services.length }),
          ...listed.services.map((s) => `- ${serviceLine(s)}`),
          ...(profiles.length > 0 ? [t("lsm.tools.status.profiles", { list: profiles.join(t("lsm.tools.clauseSep")) })] : []),
          ...(listed.services.some((s) => s.protected) ? [t("lsm.tools.status.protectedNote")] : []),
        ].join("\n"),
      };
    },
  });

  const logs = defineHostTool({
    name: LSM_TOOL.logs,
    title: t("lsm.tools.title.logs"),
    description: d.logs,
    parameters: Type.Object(
      {
        service: serviceParam(),
        lines: Type.Optional(Type.Integer({ minimum: 1, maximum: LOG_LINES_MAX, description: d.linesParam(LOG_LINES_DEFAULT, LOG_LINES_MAX) })),
        source: Type.Optional(Type.Integer({ minimum: 0, maximum: 50, description: d.sourceParam })),
      },
      { additionalProperties: false },
    ),
    readOnlyOrIdempotent: true,
    nature: "look",
    run: async ({ service, lines, source }) => {
      const manage = deps.manage();
      const listed = await listOf(manage);
      if (!listed.ok) return listed.out;
      const found = pick(listed, service);
      if ("out" in found) return found.out;
      const reply = await manage!.logs(found.s.id, { lines: lines ?? LOG_LINES_DEFAULT, ...(source === undefined ? {} : { source }) });
      if (!reply.ok) return failed(reply, undefined, found.s);
      return { text: logsText(found.s, reply) };
    },
  });

  const control = defineHostTool({
    name: LSM_TOOL.control,
    title: t("lsm.tools.title.control"),
    description: d.control,
    parameters: Type.Object(
      { action: literals(CONTROL_ACTIONS, d.controlAction), service: Type.Optional(serviceParam()), profile: Type.Optional(profileParam()) },
      { additionalProperties: false },
    ),
    // 立刻重启再做一次又是一次重启
    readOnlyOrIdempotent: false,
    timeoutMs: SLOW_TOOL_TIMEOUT_MS,
    run: (args) => act(deps, args.action, args),
  });

  const force = defineHostTool({
    name: LSM_TOOL.force,
    title: t("lsm.tools.title.force"),
    description: d.force,
    parameters: Type.Object(
      { action: literals(FORCE_ACTIONS, d.forceAction), service: Type.Optional(serviceParam()), profile: Type.Optional(profileParam()) },
      { additionalProperties: false },
    ),
    // 强制停、撤销、杀进程：做了就收不回，对话审批关着也要用户批准（SECRETARY_ASKS）
    categories: ["irreversible_commit"],
    readOnlyOrIdempotent: false,
    nature: "modify",
    timeoutMs: SLOW_TOOL_TIMEOUT_MS,
    run: (args) => act(deps, args.action, args),
  });

  const entries = defineHostTool({
    name: LSM_TOOL.entries,
    title: t("lsm.tools.title.entries"),
    description: d.entries,
    parameters: Type.Object(
      {
        action: literals(ENTRIES_ACTIONS, d.entriesAction),
        service: serviceParam(),
        tailnetName: Type.Optional(Type.String({ minLength: 1, maxLength: 48, pattern: "^[a-z0-9-]+$", description: d.tailnetNameParam })),
      },
      { additionalProperties: false },
    ),
    // 改的是外面谁连得上这个服务：落在"账户与安全"（权限），对话审批关着也要用户批准
    categories: ["account_security"],
    readOnlyOrIdempotent: false,
    timeoutMs: SLOW_TOOL_TIMEOUT_MS,
    run: (args) => act(deps, args.action, args),
  });

  const restartSelf = defineHostTool({
    name: LSM_TOOL.restartSelf,
    title: t("lsm.tools.title.restartSelf"),
    description: d.restartSelf,
    parameters: Type.Object({ reason: Type.Optional(Type.String({ minLength: 1, maxLength: 120, description: d.reasonParam })) }, { additionalProperties: false }),
    // 重启了就停了手上的一切：对话审批关着也要用户批准。排着时再排一次服务管家回 already，没有额外效果
    categories: ["irreversible_commit"],
    readOnlyOrIdempotent: true,
    run: async () => {
      const manage = deps.manage();
      if (!manage) return { text: t("lsm.tools.err.notLinked"), isError: true };
      // 先算忙再发：服务管家收下就会发 restart（when-idle），那时这一轮还没说完
      deps.restartHold.begin();
      const reply = await manage.restartSelf();
      if (!reply.ok) {
        deps.restartHold.cancel();
        return failed(reply);
      }
      return { text: t(reply.already ? "lsm.tools.done.restartSelfAlready" : "lsm.tools.done.restartSelf") };
    },
  });

  return [status, logs, control, force, entries, restartSelf];
}

/** 日志：每行截短、擦掉像密钥的，太长只留最后的 */
function logsText(s: LsmManagedService, reply: Extract<LsmManageReply, { ok: true }>): string {
  const all = (reply.lines ?? "")
    .split(/\r?\n/)
    .filter((line, i, arr) => !(i === arr.length - 1 && line === ""))
    .map((line) => {
      const clean = redactSecretShapes(line);
      return clean.length > LOG_LINE_MAX_CHARS ? `${clean.slice(0, LOG_LINE_MAX_CHARS)}…` : clean;
    });
  const kept: string[] = [];
  let size = 0;
  for (let i = all.length - 1; i >= 0; i -= 1) {
    size += all[i]!.length + 1;
    if (size > LOG_TOTAL_MAX_CHARS) break;
    kept.unshift(all[i]!);
  }
  const label = reply.label ?? "";
  const others = (reply.sources ?? []).filter((x) => x.source !== reply.source).map((x) => t("lsm.tools.logs.source", { source: x.source, label: x.label }));
  return [
    kept.length === 0 ? t("lsm.tools.logs.empty", { name: nameOf(s), label }) : t("lsm.tools.logs.head", { name: nameOf(s), label, count: kept.length, n: kept.length }),
    ...(kept.length < all.length ? [t("lsm.tools.logs.cut", { count: kept.length, n: kept.length })] : []),
    ...kept,
    ...(others.length > 0 ? [t("lsm.tools.logs.others", { list: others.join(listSep()) })] : []),
  ].join("\n");
}
