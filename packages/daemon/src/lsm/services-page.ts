// 设置 · 服务（428）：在二狗里看和开关服务管家里"和二狗有关的"服务（服务管家自己的网页只在电脑上开得了，手机上看不到、管不了）。
// 经二狗和服务管家之间那条带身份的连接（lsm/link.ts 的 manage，协议 §9），和秘书的服务管家工具（418，secretary-tools.ts）同一条通道、
// 同样的规矩：
// - 只给"和二狗有关的"（判定在 @ergo/protocol 的 ergo-related.ts，体检共用）：列表里不出现、操作和日志也只认这些，
//   别的服务的 id 回 not-related，不发任何指令；
// - 二狗离不开的（列表里 protected：二狗自己、它的外网隧道、tailnet 网关、它硬依赖的、标了 lifeline 的）停止、强制停止、重启、
//   关开机自启在本地先拒（不发指令），服务管家仍然最后裁决（回 protected 照实转）；
// - 用户亲手点的不出审批卡（这里不过守卫）；强制停有正常停止办法的、关开机自启，网页上先弹确认框；
// - 没有正常停止 / 重启办法的服务（服务管家回 no-capability），"停止""重启"直接改发强制的（用户 11-07 定的"直接停"，和 418 一样），
//   结果里 forced 写明；
// - 日志截短、擦掉像密钥的（log-lines.ts，和 lsm_logs 同一套）。
// 给人看的字由网页按当前语言拼，这里只回结构；服务管家写的原因（lastError、protectedWhy、失败的 message）原样带过去。
import {
  type ErgoRelatedService,
  type ErgoUse,
  ergoRelated,
  MANAGED_SERVICE_GUARDED_ACTIONS,
  type ManagedServiceAction,
  type ManagedServiceActionResult,
  type ManagedServiceLogsView,
  type ManagedServiceProtection,
  type ManagedServicesView,
  type ManagedServiceView,
} from "@ergo/protocol";
import { DAEMON_SERVICE_ID } from "../cli/service.ts";
import type { LsmManage, LsmManagedService, LsmManageReply } from "./link.ts";
import { logLinesWanted, tidyLogLines } from "./log-lines.ts";
import type { VoicePortsInUse } from "./voice-ports.ts";

export interface ManagedServicesDeps {
  /** 接入层的管理指令；接入层还没建好时是 undefined（守护进程里接入层比网关晚建） */
  manage(): LsmManage | undefined;
  /** 二狗在用的语音服务的本机端口（认"和二狗有关"的第 3 条） */
  voicePorts(): VoicePortsInUse;
  /** 服务管家的网页（只在这台电脑上打得开）；没接入是 undefined */
  managerUrl(): string | undefined;
  now?: () => number;
}

/** 设置 · 服务一页要的三件事（GET 列表、POST 一个操作、GET 日志） */
export interface ManagedServices {
  view(): Promise<ManagedServicesView>;
  act(id: string, action: ManagedServiceAction): Promise<ManagedServiceActionResult>;
  logs(id: string, options?: { lines?: number | undefined; source?: number | undefined }): Promise<ManagedServiceLogsView>;
}

/** 取到的列表：二狗自己是谁、全部服务、和二狗有关的（id → 用途）、tailnet 网关 */
interface Listed {
  self: string;
  services: readonly LsmManagedService[];
  related: ReadonlyMap<string, ErgoUse[]>;
  gateway: string | undefined;
}

type Failure = { code: string; message: string };

/** 服务管家列表里的一条换成判定要的样子 */
function relatedInput(s: LsmManagedService): ErgoRelatedService {
  return {
    id: s.id,
    port: s.port,
    role: typeof s.role === "string" ? s.role : null,
    state: s.state,
    via: s.exposure?.via ?? null,
    tailnet: s.tailnet !== null && s.tailnet !== undefined,
    dependsOn: s.dependsOn ?? [],
    ergo: s.ergo === true,
  };
}

/** 二狗为什么离不开它：二狗自己、二狗的外网隧道、tailnet 网关，别的照服务管家写的原因 */
function protectionOf(s: LsmManagedService, listed: Listed): ManagedServiceProtection {
  const why = [...s.protectedWhy];
  if (s.id === listed.self) return { kind: "self", why };
  const own = listed.services.find((x) => x.id === listed.self);
  if (own?.exposure?.via === s.id) return { kind: "tunnel", why };
  if (listed.gateway === s.id) return { kind: "gateway", why };
  return { kind: "other", why };
}

/** 页面上的一个服务 */
function viewOf(s: LsmManagedService, uses: ErgoUse[], listed: Listed): ManagedServiceView {
  const up = s.up === true;
  return {
    id: s.id,
    title: s.title || s.id,
    state: s.state,
    up,
    port: s.port ?? null,
    autostart: s.autostart === true,
    since: up && typeof s.since === "number" ? s.since : null,
    lastError: s.lastError || null,
    uses,
    canStop: s.capabilities.includes("stop"),
    canRestart: s.capabilities.includes("restart"),
    busy: s.busy === true,
    busyReason: s.busyReason || null,
    pendingStop: s.pendingStop === true,
    ...(s.protected ? { protection: protectionOf(s, listed) } : {}),
  };
}

/** 操作发给服务管家 */
function send(manage: LsmManage, action: ManagedServiceAction | "force_restart", id: string): Promise<LsmManageReply> {
  switch (action) {
    case "start":
      return manage.start(id);
    case "stop":
      return manage.stop(id);
    case "force_stop":
      return manage.stop(id, { force: true });
    case "restart":
      return manage.restart(id);
    case "force_restart":
      return manage.restart(id, { force: true });
    case "cancel_stop":
      return manage.cancelStop(id);
    case "autostart_on":
      return manage.autostart(id, true);
    case "autostart_off":
      return manage.autostart(id, false);
  }
}

/** 接入层能不能用：不能用的说清是哪种（没接入、还没连上、服务管家太老） */
function usable(manage: LsmManage | undefined): { manage: LsmManage } | { failure: Failure } {
  if (!manage || manage.support === "disabled") return { failure: { code: "not-linked", message: "" } };
  if (manage.support === "waiting") return { failure: { code: "not-connected", message: "" } };
  if (manage.support === "unsupported") return { failure: { code: "unsupported", message: "" } };
  return { manage };
}

export function createManagedServices(deps: ManagedServicesDeps): ManagedServices {
  const now = deps.now ?? Date.now;

  /** 取一次列表，挑出和二狗有关的 */
  const list = async (manage: LsmManage): Promise<{ listed: Listed } | { failure: Failure }> => {
    const reply = await manage.list();
    if (!reply.ok) return { failure: { code: reply.error.code, message: reply.error.message } };
    const self = reply.self ?? DAEMON_SERVICE_ID;
    const services = reply.services ?? [];
    const gateway = typeof reply.tailnetGateway === "string" && reply.tailnetGateway !== "" ? reply.tailnetGateway : undefined;
    const related = ergoRelated(services.map(relatedInput), { self, ...deps.voicePorts(), tailnetGateway: gateway });
    return { listed: { self, services, related, gateway } };
  };

  /** 认出要操作的那一个：不是和二狗有关的不认 */
  const target = async (id: string): Promise<{ manage: LsmManage; listed: Listed; s: LsmManagedService; uses: ErgoUse[] } | { failure: Failure }> => {
    const ready = usable(deps.manage());
    if ("failure" in ready) return ready;
    const got = await list(ready.manage);
    if ("failure" in got) return got;
    const uses = got.listed.related.get(id);
    const s = got.listed.services.find((x) => x.id === id);
    if (!uses || !s) return { failure: { code: "not-related", message: "" } };
    return { manage: ready.manage, listed: got.listed, s, uses };
  };

  return {
    async view() {
      const managerUrl = deps.managerUrl();
      const base = { at: now(), ...(managerUrl === undefined ? {} : { managerUrl }) };
      const manage = deps.manage();
      const support = manage?.support ?? "disabled";
      if (!manage || support !== "supported") return { support, services: [], ...base };
      const got = await list(manage);
      if ("failure" in got) return { support, services: [], error: got.failure, ...base };
      const { listed } = got;
      const byId = new Map(listed.services.map((s) => [s.id, s]));
      return { support, services: [...listed.related].map(([id, uses]) => viewOf(byId.get(id)!, uses, listed)), ...base };
    },

    async act(id, action) {
      const found = await target(id);
      if ("failure" in found) return { ok: false, action, ...found.failure };
      const { manage, listed, s, uses } = found;
      // 二狗离不开的：本地先拒，一条指令都不发（服务管家那边也会拒）
      if (s.protected && MANAGED_SERVICE_GUARDED_ACTIONS.includes(action)) return { ok: false, action, code: "protected", message: s.protectedWhy.join("; "), service: viewOf(s, uses, listed) };
      let reply = await send(manage, action, id);
      // 用户 2026-11-07 定的"直接停"：没有正常停止 / 重启办法的（服务管家回 no-capability），停就直接强制停、重启就直接强制重启
      const forced = !reply.ok && reply.error.code === "no-capability" && (action === "stop" || action === "restart");
      if (forced) reply = await send(manage, action === "stop" ? "force_stop" : "force_restart", id);
      if (!reply.ok) return { ok: false, action, code: reply.error.code, message: reply.error.message, service: viewOf(reply.service ?? s, uses, listed) };
      return {
        ok: true,
        action,
        ...(forced && !reply.already && !reply.pending ? { forced: true } : {}),
        ...(reply.already ? { already: true } : {}),
        ...(reply.pending ? { pending: true } : {}),
        ...(reply.note ? { note: reply.note } : {}),
        service: viewOf(reply.service ?? s, uses, listed),
      };
    },

    async logs(id, { lines, source } = {}) {
      const found = await target(id);
      if ("failure" in found) return { ok: false, id, ...found.failure };
      const reply = await found.manage.logs(id, { lines: logLinesWanted(lines), ...(source === undefined ? {} : { source }) });
      if (!reply.ok) return { ok: false, id, code: reply.error.code, message: reply.error.message };
      const tidy = tidyLogLines(reply.lines ?? "");
      return { ok: true, id, source: reply.source ?? source ?? 0, label: reply.label ?? "", lines: tidy.lines, cut: tidy.cut, sources: reply.sources ?? [] };
    },
  };
}
