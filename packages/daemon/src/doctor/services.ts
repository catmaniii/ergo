// 体检"二狗本身"里的"托管的服务"（410）：服务管家托管的、和二狗有关的服务现在什么样。
// 不另连服务管家：服务管家那一项本来就跑了 `lsm status --json`（doctor.ts 的 supervisorStatus，同一次体检里两项共用一份快照），
// 这里解析那份快照。只列和二狗有关的：
// - 二狗要用的：配置里在用的语音合成、语音识别（地址是本机的、按端口对上服务管家里的服务；语音插件没启用、识别是二狗自己拉起的
//   Python 时不算）；给二狗通外网的隧道（二狗那条登记的 exposure.via）；开了 tailnet 入口时服务管家的 tailnet 网关；
// - 二狗名下的项目服务（id 是 ergo-daemon--<名字>，二狗经接入协议登记的）。
// 判法（票 410）：二狗要用的停着或失败 → 坏了；名下的服务失败 → 坏了，开了开机自启却停着 → 注意（关着的项目服务停着是正常的）；
// 不太健康（DEGRADED）、端口被不归服务管家管的进程占着（ORPHAN）→ 注意。事实写服务名、状态、服务管家记的最后一次出错。
// 动作：跳到服务管家的网页（只在这台电脑上打得开；418 做好后换成"开起来"）。
// 快照拿不到（服务管家没回应）算"没查出来"；一个和二狗有关的都没有算"不适用"。纯函数，句子由 doctor.ts 拼。
import { DOCTOR_FIX_UNKNOWN, type DoctorMessage, doctorOpensUrl, formatList, t, tTable } from "@ergo/protocol";
import { DAEMON_SERVICE_ID } from "../cli/service.ts";
import type { DoctorFinding } from "./checks.ts";

/** 快照里一个服务（只取用得到的字段） */
export interface SupervisorService {
  id: string;
  name: string;
  port: number | undefined;
  state: string;
  autostart: boolean;
  lastError?: string;
  role?: string;
  /** 二狗那条登记的：经哪条隧道出网（exposure.via） */
  via?: string;
  /** 二狗那条登记的：开了 tailnet 入口 */
  tailnet: boolean;
}

/** `lsm status --json` 的快照里用得到的部分 */
export interface SupervisorSnapshot {
  services: SupervisorService[];
  /** tailnet 网关（服务管家设置里开了 tailnet 才有） */
  tailnetGateway?: { id: string; state: string; autostart: boolean };
}

const str = (value: unknown): string | undefined => (typeof value === "string" && value !== "" ? value : undefined);
const record = (value: unknown): Record<string, unknown> | undefined => (typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined);

/** 解析快照：形状不对的服务丢掉；整份不像快照（没有 services 数组）是 undefined */
export function parseSupervisorSnapshot(raw: unknown): SupervisorSnapshot | undefined {
  const top = record(raw);
  if (!top || !Array.isArray(top.services)) return undefined;
  const services = top.services.flatMap((item): SupervisorService[] => {
    const s = record(item);
    const id = str(s?.id);
    if (!s || id === undefined) return [];
    const via = str(record(s.exposure)?.via);
    const lastError = str(s.lastError);
    const role = str(s.role);
    return [
      {
        id,
        name: str(s.name) ?? id,
        port: typeof s.port === "number" ? s.port : undefined,
        state: str(s.state) ?? "UNKNOWN",
        autostart: s.autostart === true,
        ...(lastError === undefined ? {} : { lastError }),
        ...(role === undefined ? {} : { role }),
        ...(via === undefined ? {} : { via }),
        tailnet: record(s.tailnet) !== undefined,
      },
    ];
  });
  const gateway = record(record(top.tailnet)?.gateway);
  const gatewayId = str(gateway?.id);
  return { services, ...(gateway && gatewayId ? { tailnetGateway: { id: gatewayId, state: str(gateway.state) ?? "UNKNOWN", autostart: gateway.autostart === true } } : {}) };
}

/** 二狗在用的本机服务的端口（语音合成、语音识别）；不在用的不给 */
export interface ServicesInUse {
  speechPort?: number;
  recognizerPort?: number;
}

/** 地址是本机的才算（127.0.0.1、localhost、::1），交回端口；别的（局域网、外网）是 undefined */
export function localPortOf(url: string): number | undefined {
  try {
    const parsed = new URL(url);
    const host = parsed.hostname.replace(/^\[|\]$/g, "");
    if (host !== "127.0.0.1" && host !== "localhost" && host !== "::1") return undefined;
    const port = parsed.port === "" ? (parsed.protocol === "https:" ? 443 : 80) : Number(parsed.port);
    return Number.isInteger(port) && port > 0 ? port : undefined;
  } catch {
    return undefined;
  }
}

/** 和二狗有关的一个服务：它是干什么的（几种用途可以叠）、二狗要不要用它 */
type Use = "speech" | "recognizer" | "tunnel" | "gateway" | "project";
interface Related {
  service: Pick<SupervisorService, "id" | "name" | "state" | "autostart" | "lastError">;
  uses: Use[];
}

/** 二狗名下的服务的 id 前缀 */
const OWNED_PREFIX = `${DAEMON_SERVICE_ID}--`;

/** 挑出和二狗有关的（按用途合并同一个服务） */
function relatedOf(snapshot: SupervisorSnapshot, inUse: ServicesInUse): Related[] {
  const out = new Map<string, Related>();
  const add = (service: Related["service"], use: Use) => {
    const known = out.get(service.id);
    if (known) {
      if (!known.uses.includes(use)) known.uses.push(use);
    } else out.set(service.id, { service, uses: [use] });
  };
  // 按端口对上的：二狗自己、隧道不算；同一个端口有几个时挑在跑的
  const byPort = (port: number | undefined) => {
    if (port === undefined) return undefined;
    const candidates = snapshot.services.filter((s) => s.port === port && s.id !== DAEMON_SERVICE_ID && s.role !== "tunnel");
    return candidates.find((s) => s.state === "RUNNING") ?? candidates[0];
  };
  const speech = byPort(inUse.speechPort);
  if (speech) add(speech, "speech");
  const recognizer = byPort(inUse.recognizerPort);
  if (recognizer) add(recognizer, "recognizer");
  const daemon = snapshot.services.find((s) => s.id === DAEMON_SERVICE_ID);
  const tunnel = daemon?.via === undefined ? undefined : snapshot.services.find((s) => s.id === daemon.via);
  if (tunnel) add(tunnel, "tunnel");
  if (daemon?.tailnet && snapshot.tailnetGateway) add({ ...snapshot.tailnetGateway, name: snapshot.tailnetGateway.id }, "gateway");
  for (const s of snapshot.services) if (s.id.startsWith(OWNED_PREFIX)) add(s, "project");
  return [...out.values()];
}

/** 二狗要用的（语音、隧道、网关）：不在跑就用不了 */
const needed = (related: Related) => related.uses.some((use) => use !== "project");

/** 一个服务算几级 */
function levelOf(related: Related): "ok" | "warn" | "error" {
  const { state, autostart } = related.service;
  if (state === "RUNNING" || state === "STARTING" || state === "STOPPING") return "ok";
  if (state === "DEGRADED" || state === "ORPHAN") return "warn";
  if (needed(related)) return "error";
  if (state === "FAILED") return "error";
  if (state === "STOPPED") return autostart ? "warn" : "ok";
  return "warn";
}

/** 状态的叫法（认不得的照原样） */
const STATE_TEXT: Readonly<Record<string, string>> = tTable({
  RUNNING: "doctor.services.state.running",
  STARTING: "doctor.services.state.starting",
  STOPPING: "doctor.services.state.stopping",
  STOPPED: "doctor.services.state.stopped",
  FAILED: "doctor.services.state.failed",
  DEGRADED: "doctor.services.state.degraded",
  ORPHAN: "doctor.services.state.orphan",
});
const stateText = (state: string): string => (Object.hasOwn(STATE_TEXT, state) ? STATE_TEXT[state]! : state);

/** 用途的叫法 */
const USE_TEXT: Readonly<Record<Use, string>> = tTable({
  speech: "doctor.services.use.speech",
  recognizer: "doctor.services.use.recognizer",
  tunnel: "doctor.services.use.tunnel",
  gateway: "doctor.services.use.gateway",
  project: "doctor.services.use.project",
});

/** 一个服务写成"语音合成 audiocpp（停着；上次出错：…）" */
function serviceText(related: Related, withError: boolean): string {
  const uses = formatList(related.uses.map((use) => USE_TEXT[use]));
  const error = withError && related.service.lastError ? related.service.lastError : undefined;
  const autostart = related.service.state === "STOPPED" && related.service.autostart && !needed(related);
  const state = error
    ? t("doctor.services.stateWithError", { state: stateText(related.service.state), error })
    : autostart
      ? t("doctor.services.stateAutostart", { state: stateText(related.service.state) })
      : stateText(related.service.state);
  return t("doctor.services.one", { uses, name: related.service.name, state });
}

/**
 * 判一次：snapshot 是服务管家那一项拿到的快照（没回应是 undefined），inUse 是二狗在用的语音服务的端口，
 * managerPage 是服务管家的网页（没接入是 undefined，就不给动作；不是本机的网址也不给——体检的 open 只认本机，doctorOpensUrl）
 */
export function judgeServices(snapshot: SupervisorSnapshot | undefined, inUse: ServicesInUse, managerPage: string | undefined): DoctorFinding {
  const managerUrl = managerPage !== undefined && doctorOpensUrl(managerPage) ? managerPage : undefined;
  if (!snapshot) return { level: "unknown", fact: { key: "doctor.services.noSnapshot" }, fix: { key: DOCTOR_FIX_UNKNOWN } };
  const related = relatedOf(snapshot, inUse);
  if (related.length === 0) return { level: "na", fact: { key: "doctor.services.none" } };
  const judged = related.map((r) => ({ r, level: levelOf(r) }));
  const bad = judged.filter((j) => j.level !== "ok");
  if (bad.length === 0) return { level: "ok", fact: { key: "doctor.services.fine", params: { list: formatList(related.map((r) => serviceText(r, false))) } } };
  const level = bad.some((j) => j.level === "error") ? "error" : "warn";
  const problems = bad.toSorted((a, b) => (a.level === b.level ? 0 : a.level === "error" ? -1 : 1)).map((j) => serviceText(j.r, true));
  const fine = judged.filter((j) => j.level === "ok").length;
  const fact: DoctorMessage = fine === 0 ? { key: "doctor.services.bad", params: { list: formatList(problems) } } : { key: "doctor.services.badSome", params: { list: formatList(problems), fine } };
  return {
    level,
    fact,
    fix: { key: managerUrl === undefined ? "doctor.fix.servicesNoLink" : "doctor.fix.services" },
    ...(managerUrl === undefined ? {} : { action: { kind: "open" as const, route: managerUrl } }),
  };
}
