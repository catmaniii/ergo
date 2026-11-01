// 项目的服务报事件（357 号票，ADR-0043）：服务上线时拿到地址和专属凭证，发现要紧的事调 ergo notify 或本机接口报一个事件，叫醒自己项目里等它的任务。
// 这里是运营层这一边（等它的订阅、交出事件在内核的事件来源 event-sources/service.ts）：
// - 凭证按服务发：一个服务一个文件（密钥区 secrets/service-tokens/<应用名>.token），上线时没有就生成（ensureCredential），经 from: file 注入；
//   服务撤下、项目停用归档、删除时作废（revokeCredential，文件删掉），重新上线发新的。内存里只留它的摘要，比对时比摘要。
//   凭证只认"该在 LSM 上、项目使用中"的服务：撤下的要求一落盘就不认，不等 LSM 真撤完。不做别的 agent 的通道，也不发给手工托管在服务管家里的服务；
// - 报事件（report）按这个次序：限速（每个服务按最近一分钟数）→ 大小 → 事件名有没有人等。不过的回明确的错（code、message 交给网关回 HTTP），
//   不叫醒任何 agent，不花钱；服务发完就走，不等维护者做完；
// - 最近收到的事件（每个服务 SERVICE_EVENTS_KEPT 条，只有名字、时间、结局，不存数据）：项目页这一条、维护者的 recent_service_events 看它，
//   存在数据目录 event-sources/service-events.json（重启后还在），删项目时一起删。超了限速的一阵只记一条；
// - 服务报来的数据只进这次运行（JobRun.events，删项目时跟着删）：不是用户说的话，不进素材和记忆，不算用户授权，交给 agent 时写明是数据不是指令
//   （scheduled-jobs/texts.ts 的 eventsBlock）。
import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { forModel, nowIso, describeTime, type Project, SERVICE_EVENT_OUTCOME_LABEL, SERVICE_EVENTS_KEPT, SERVICE_TOKEN_ENV, type ServiceEventOutcome, type ServiceEventRecord, type ServiceEventReply, t, Type } from "@ergo/protocol";
import { defineHostTool, type HostTool } from "../agent-manager/host-tools.ts";
import type { EventSourceThresholds, ServiceDelivery, ServiceEventDesk } from "../event-sources/index.ts";
import type { EventStore } from "../events/event-store.ts";
import type { ServiceEventCaller, ServiceEventRefusal, ServiceEventsApi } from "../project-ops/api.ts";
import type { Clock } from "../scheduler/clock.ts";
import { writeFileAtomic } from "../util/atomic-file.ts";
import { oneLine } from "../util/text.ts";
import { eventsText } from "./texts.ts";
import { RECENT_SERVICE_EVENTS_TOOL } from "./tool-names.ts";
import { serviceRow, serviceRows } from "./views.ts";

/** 密钥区里放服务凭证的目录 */
export const SERVICE_TOKENS_DIR = "service-tokens";
const TOKEN_SUFFIX = ".token";
/** 限速按最近多久数 */
const RATE_WINDOW_MS = 60_000;
/** 请求体比数据上限多留多少（事件名、JSON 的壳） */
const BODY_OVERHEAD_BYTES = 4096;
/** 读到的请求体太大、事件名还不知道时记录里写的名字 */
const UNKNOWN_NAME = "-";

export interface ServiceEventsOptions {
  store: EventStore;
  /** 项目（删掉的是 undefined） */
  project: (projectId: string) => Project | undefined;
  /** 密钥区（真实路径）：凭证放在它下面的 service-tokens/ */
  secretsDir: string;
  /** 事件来源的状态目录（数据目录 event-sources/）：最近收到的记录放这里 */
  stateDir: string;
  desk: ServiceEventDesk;
  thresholds: Pick<EventSourceThresholds, "serviceReportsPerMinute" | "serviceDataMaxBytes">;
  clock: Clock;
  log: (line: string) => void;
}

export interface ServiceEvents extends ServiceEventsApi {
  /** 这个服务的凭证文件（交给 LSM 的定义里 from: file 写它） */
  credentialFile(app: string): string;
  /** 上线前：没有凭证就发一份；发了新的回 true（服务已经在跑的要重启才拿得到） */
  ensureCredential(app: string): boolean;
  /** 作废（服务撤下、项目停用归档时）：文件删掉，这份之后不认 */
  revokeCredential(app: string): void;
  /** 守护进程起来时：不该有凭证的（停机期间撤下了、项目删了）作废 */
  sweepCredentials(present: (app: string) => boolean): void;
  /** 这个服务最近报的事件（新的在前） */
  recent(app: string): ServiceEventRecord[];
  /** 删项目：这个项目的服务的凭证、记录都删掉 */
  forgetProject(projectId: string): void;
  /** 最近收到的变了时叫 fn（项目页的样子跟着推）；返回取消 */
  onChange(fn: () => void): () => void;
  /** 项目维护者查最近收到的事件的工具 */
  tool(projectId: string): HostTool;
}

const digest = (token: string) => createHash("sha256").update(token, "utf8").digest();

/** 现在能报的名字写成一句 */
const namesText = (names: readonly string[]) => (names.length > 0 ? names.map((n) => eventsText.quoted(n)).join(eventsText.sep()) : eventsText.noNames());

export function createServiceEvents(options: ServiceEventsOptions): ServiceEvents {
  const { store, desk, thresholds, clock, log } = options;
  const dir = path.join(options.secretsDir, SERVICE_TOKENS_DIR);
  const recentFile = path.join(options.stateDir, "service-events.json");
  /** 应用名 → 凭证的摘要 */
  const digests = new Map<string, Buffer>();
  /** 应用名 → 最近报的事件（新的在前） */
  let records = new Map<string, ServiceEventRecord[]>();
  /** 应用名 → 最近一分钟报过的时刻（毫秒） */
  const attempts = new Map<string, number[]>();
  const listeners = new Set<() => void>();

  const fileOf = (app: string) => path.join(dir, `${app}${TOKEN_SUFFIX}`);

  // 起来时读回凭证（服务拿着的还是这一份）和最近收到的
  try {
    for (const name of fs.readdirSync(dir)) {
      if (!name.endsWith(TOKEN_SUFFIX)) continue;
      const token = fs.readFileSync(path.join(dir, name), "utf8").trim();
      if (token) digests.set(name.slice(0, -TOKEN_SUFFIX.length), digest(token));
    }
  } catch {
    // 还没发过
  }
  try {
    records = new Map(Object.entries(JSON.parse(fs.readFileSync(recentFile, "utf8")) as Record<string, ServiceEventRecord[]>));
  } catch {
    // 还没收到过、文件坏了：从头记
  }

  const saveRecords = () => {
    try {
      writeFileAtomic(recentFile, JSON.stringify(Object.fromEntries(records)));
    } catch (err) {
      log(`存服务最近报的事件时出错：${err instanceof Error ? err.message : String(err)}`); // @i18n-ignore log
    }
    for (const fn of listeners) fn();
  };

  const record = (app: string, name: string, outcome: ServiceEventOutcome, runIds: readonly string[] = []) => {
    const list = records.get(app) ?? [];
    // 超了限速的一阵只记一条（一直猛发时也不用一直写文件）
    if (outcome === "rate_limited" && list[0]?.outcome === "rate_limited" && list[0].name === name) return;
    const item: ServiceEventRecord = { name: oneLine(name, 80), at: nowIso(new Date(clock.now())), outcome, ...(runIds.length > 0 ? { runIds: [...runIds] } : {}) };
    records.set(app, [item, ...list].slice(0, SERVICE_EVENTS_KEPT));
    saveRecords();
  };

  /** 这一次算不算超了限速（不超的记下这一次） */
  const overLimit = (app: string): { over: boolean; waitSeconds: number } => {
    const now = clock.now();
    const recent = (attempts.get(app) ?? []).filter((at) => at > now - RATE_WINDOW_MS);
    if (recent.length >= thresholds.serviceReportsPerMinute) {
      attempts.set(app, recent);
      return { over: true, waitSeconds: Math.max(1, Math.ceil((recent[0]! + RATE_WINDOW_MS - now) / 1000)) };
    }
    recent.push(now);
    attempts.set(app, recent);
    return { over: false, waitSeconds: 0 };
  };

  const ownerOf = (token: string): string | undefined => {
    const wanted = digest(token);
    for (const [app, known] of digests) if (timingSafeEqual(known, wanted)) return app;
    return undefined;
  };

  /** 没叫醒的说法（记下这一次、记一行日志） */
  const refused = (caller: ServiceEventCaller, name: string, outcome: ServiceEventOutcome, code: ServiceEventRefusal["code"], message: string): ServiceEventRefusal => {
    record(caller.app, name, outcome);
    log(`服务 ${caller.app} 报事件「${oneLine(name, 80)}」没叫醒：${message}`); // @i18n-ignore log
    return { ok: false, code, message };
  };

  return {
    maxBodyBytes: thresholds.serviceDataMaxBytes + BODY_OVERHEAD_BYTES,

    authenticate(credential) {
      if (credential === undefined) return { ok: false, code: "unauthorized", message: eventsText.noCredential(SERVICE_TOKEN_ENV) };
      const app = ownerOf(credential);
      const row = app === undefined ? undefined : serviceRow(store.reader, app);
      const project = row && options.project(row.projectId);
      if (!app || !row || !row.desired.present || project?.state !== "in_use") return { ok: false, code: "unauthorized", message: eventsText.badCredential(SERVICE_TOKEN_ENV) };
      return { ok: true, caller: { app, projectId: row.projectId, service: row.desired.service.name, title: row.desired.title } };
    },

    report(caller, input) {
      const name = input.event ?? UNKNOWN_NAME;
      const limit = overLimit(caller.app);
      if (limit.over) {
        const message = eventsText.rateLimited(caller.title, thresholds.serviceReportsPerMinute, limit.waitSeconds);
        const first = records.get(caller.app)?.[0]?.outcome !== "rate_limited";
        record(caller.app, name, "rate_limited");
        // 超了限速的一阵只记一行日志
        if (first) log(`服务 ${caller.app} 报事件超了限速（每分钟 ${thresholds.serviceReportsPerMinute} 次）：这一阵报的都没算`); // @i18n-ignore log
        return { ok: false, code: "too_many_requests", message };
      }
      if (input.oversized) return refused(caller, name, "too_large", "too_large", eventsText.tooLarge(thresholds.serviceDataMaxBytes));
      if (input.data !== undefined && Buffer.byteLength(JSON.stringify(input.data), "utf8") > thresholds.serviceDataMaxBytes) return refused(caller, name, "too_large", "too_large", eventsText.tooLarge(thresholds.serviceDataMaxBytes));
      const delivery: ServiceDelivery = desk.deliver({
        projectId: caller.projectId,
        service: caller.service,
        title: caller.title,
        name,
        ...(input.data === undefined ? {} : { data: input.data }),
        at: nowIso(new Date(clock.now())),
        key: randomUUID(),
      });
      if (delivery.outcome === "no_waiter") return refused(caller, name, "no_waiter", "not_found", eventsText.noWaiter(name, namesText(delivery.names)));
      if (delivery.outcome === "paused") return refused(caller, name, "paused", "busy", eventsText.paused(name));
      if (delivery.runs.length === 0) return refused(caller, name, "ignored", "busy", eventsText.ignored(name, delivery.reasons.join(eventsText.sep())));
      record(caller.app, name, delivery.runs.every((r) => r.merged) ? "merged" : "woke", delivery.runs.map((r) => r.runId));
      const reply: ServiceEventReply = { ok: true, event: name, runs: delivery.runs };
      return { ok: true, reply };
    },

    credentialFile: fileOf,

    ensureCredential(app) {
      if (digests.has(app) && fs.existsSync(fileOf(app))) return false;
      const token = randomBytes(32).toString("base64url");
      fs.mkdirSync(dir, { recursive: true });
      writeFileAtomic(fileOf(app), token);
      digests.set(app, digest(token));
      return true;
    },

    revokeCredential(app) {
      digests.delete(app);
      try {
        fs.rmSync(fileOf(app), { force: true });
      } catch (err) {
        // 删不掉（被占着）：内存里已经不认了，下次起来 sweepCredentials 再删
        log(`删服务 ${app} 的凭证文件时出错：${err instanceof Error ? err.message : String(err)}`); // @i18n-ignore log
      }
    },

    sweepCredentials(present) {
      for (const app of digests.keys()) if (!present(app)) this.revokeCredential(app);
    },

    recent: (app) => records.get(app) ?? [],

    forgetProject(projectId) {
      const prefix = `${projectId}-`;
      for (const app of digests.keys()) if (app.startsWith(prefix)) this.revokeCredential(app);
      let changed = false;
      for (const app of records.keys()) {
        if (!app.startsWith(prefix)) continue;
        records.delete(app);
        changed = true;
      }
      if (changed) saveRecords();
    },

    onChange(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },

    tool(projectId) {
      return defineHostTool({
        name: RECENT_SERVICE_EVENTS_TOOL,
        title: t("projectServices.tool.recentEvents"),
        description: eventsText.toolDescription,
        parameters: Type.Object({}, { additionalProperties: false }),
        readOnlyOrIdempotent: true,
        run: async () => {
          const rows = serviceRows(store.reader).filter((r) => r.projectId === projectId && r.desired.present);
          const lines = rows.flatMap((r) => {
            const list = records.get(r.app) ?? [];
            return [
              eventsText.toolService(r.desired.title, r.app, list.length),
              ...list.map((e) => forModel(() => eventsText.toolLine(describeTime(new Date(e.at)), e.name, SERVICE_EVENT_OUTCOME_LABEL[e.outcome], e.runIds ?? []))),
            ];
          });
          return { text: [eventsText.toolNames(forModel(() => namesText(desk.names(projectId)))), ...(rows.length > 0 ? lines : [eventsText.toolNoService])].join("\n") };
        },
      });
    },
  };
}
