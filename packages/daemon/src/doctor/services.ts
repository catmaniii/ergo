// 体检"二狗本身"里的"托管的服务"（410）：服务管家托管的、和二狗有关的服务现在什么样。
// 不另连服务管家：服务管家那一项本来就跑了 `lsm status --json`（doctor.ts 的 supervisorStatus，同一次体检里两项共用一份快照），
// 这里解析那份快照。只列和二狗有关的，判定和设置 · 服务一页（428）是同一份：协议包的 ergoRelated（ergo-related.ts），
// 体检里不列二狗自己（self），别的用途对应成：
// - 二狗要用的：配置里在用的语音合成、语音识别（端口由 lsm/voice-ports.ts 的 voicePortsInUse 从配置算，组合根交进来）；
//   给二狗通外网的隧道（exposure.via）；开了 tailnet 入口时服务管家的 tailnet 网关；二狗登记里 dependsOn 的服务，
//   和这些硬依赖的（dependency）；
// - 二狗名下的（id 是 ergo-daemon--<名字>：项目上线的服务、组件装的语音合成）记成"项目服务"；登记里标了 ergo: true 的（marked）
//   按名下的判。
// 判法（票 410）：二狗要用的停着或失败 → 坏了；名下的、标了的失败 → 坏了，开了开机自启却停着 → 注意（关着的项目服务停着是正常的）；
// 不太健康（DEGRADED）、端口被不归服务管家管的进程占着（ORPHAN）→ 注意。事实写服务名、状态、服务管家记的最后一次出错。
// 动作（418 + 428）：最要紧的那个停着、失败了给"开起来"（start，设置 · 服务一页同一个接口）；不太健康、端口被占着的
// "去看看"跳设置 · 服务里它那一块（#/more/services/<id>）。没接入服务管家不给（修法写 lsm start）。
// 快照拿不到（服务管家没回应）算"没查出来"；一个和二狗有关的都没有算"不适用"。纯函数，句子由 doctor.ts 拼。
import { DOCTOR_FIX_UNKNOWN, type DoctorAction, type DoctorMessage, doctorServiceRoute, type ErgoRelatedService, type ErgoUse, ergoRelated, formatList, t, tTable } from "@ergo/protocol";
import { DAEMON_SERVICE_ID } from "../cli/service.ts";
import type { VoicePortsInUse } from "../lsm/voice-ports.ts";
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
  /** 它依赖谁（服务管家登记的 dependsOn：id 和 hard / soft） */
  dependsOn?: { id: string; type?: string }[];
  /** 服务管家登记里标了 ergo: true（428；老的服务管家没有这个字段） */
  ergo?: boolean;
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
    const dependsOn = Array.isArray(s.dependsOn)
      ? s.dependsOn.flatMap((d): { id: string; type?: string }[] => {
          const dep = record(d);
          const depId = str(dep?.id);
          const type = str(dep?.type);
          return depId === undefined ? [] : [{ id: depId, ...(type === undefined ? {} : { type }) }];
        })
      : undefined;
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
        ...(dependsOn === undefined || dependsOn.length === 0 ? {} : { dependsOn }),
        ...(s.ergo === true ? { ergo: true } : {}),
      },
    ];
  });
  const gateway = record(record(top.tailnet)?.gateway);
  const gatewayId = str(gateway?.id);
  return { services, ...(gateway && gatewayId ? { tailnetGateway: { id: gatewayId, state: str(gateway.state) ?? "UNKNOWN", autostart: gateway.autostart === true } } : {}) };
}

/** 二狗在用的本机服务的端口（语音合成、语音识别；组合根用 voicePortsInUse 从配置算）；不在用的不给 */
export type ServicesInUse = VoicePortsInUse;

/** 和二狗有关的一个服务：它是干什么的（几种用途可以叠）、二狗要不要用它 */
type Use = "speech" | "recognizer" | "tunnel" | "gateway" | "dependency" | "project" | "marked";
interface Related {
  service: Pick<SupervisorService, "id" | "name" | "state" | "autostart" | "lastError">;
  uses: Use[];
}

/** ergoRelated 的用途在体检里怎么叫：二狗自己不列；名下的就是"项目服务" */
const USE_OF: Readonly<Record<ErgoUse, Use | undefined>> = {
  self: undefined,
  speech: "speech",
  recognizer: "recognizer",
  tunnel: "tunnel",
  gateway: "gateway",
  dependency: "dependency",
  owned: "project",
  marked: "marked",
};

/** 挑出和二狗有关的（协议包的 ergoRelated，和设置 · 服务一页同一份判定；先后照它排） */
function relatedOf(snapshot: SupervisorSnapshot, inUse: ServicesInUse): Related[] {
  const services: ErgoRelatedService[] = snapshot.services.map((s) => ({
    id: s.id,
    port: s.port ?? null,
    role: s.role ?? null,
    state: s.state,
    via: s.via ?? null,
    tailnet: s.tailnet,
    ...(s.dependsOn ? { dependsOn: s.dependsOn } : {}),
    ...(s.ergo ? { ergo: true } : {}),
  }));
  const byId = new Map(snapshot.services.map((s) => [s.id, s]));
  const related = ergoRelated(services, { self: DAEMON_SERVICE_ID, ...inUse, tailnetGateway: snapshot.tailnetGateway?.id });
  return [...related].flatMap(([id, ergoUses]) => {
    const uses = ergoUses.flatMap((use) => USE_OF[use] ?? []);
    const service = byId.get(id);
    return service === undefined || uses.length === 0 ? [] : [{ service, uses }];
  });
}

/** 二狗要用的（语音、隧道、网关、它依赖的）：不在跑就用不了；名下的、标了的不一定要一直开着 */
const needed = (related: Related) => related.uses.some((use) => use !== "project" && use !== "marked");

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
  dependency: "doctor.services.use.dependency",
  project: "doctor.services.use.project",
  marked: "doctor.services.use.marked",
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

/** 一个有问题的服务的动作：停着、失败了是"开起来"；别的（不太健康、端口被别的进程占着）跳设置 · 服务里它那一块看 */
export function serviceAction(service: Pick<SupervisorService, "id" | "state">): DoctorAction {
  return service.state === "STOPPED" || service.state === "FAILED" ? { kind: "start", service: service.id } : { kind: "open", route: doctorServiceRoute(service.id) };
}

/**
 * 判一次：snapshot 是服务管家那一项拿到的快照（没回应是 undefined），inUse 是二狗在用的语音服务的端口，
 * linked 是接入了服务管家（没接入不给动作：设置 · 服务一页、"开起来"都走接入层）
 */
export function judgeServices(snapshot: SupervisorSnapshot | undefined, inUse: ServicesInUse, linked: boolean): DoctorFinding {
  if (!snapshot) return { level: "unknown", fact: { key: "doctor.services.noSnapshot" }, fix: { key: DOCTOR_FIX_UNKNOWN } };
  const related = relatedOf(snapshot, inUse);
  if (related.length === 0) return { level: "na", fact: { key: "doctor.services.none" } };
  const judged = related.map((r) => ({ r, level: levelOf(r) }));
  const bad = judged.filter((j) => j.level !== "ok");
  if (bad.length === 0) return { level: "ok", fact: { key: "doctor.services.fine", params: { list: formatList(related.map((r) => serviceText(r, false))) } } };
  const level = bad.some((j) => j.level === "error") ? "error" : "warn";
  const sorted = bad.toSorted((a, b) => (a.level === b.level ? 0 : a.level === "error" ? -1 : 1));
  const problems = sorted.map((j) => serviceText(j.r, true));
  const fine = judged.filter((j) => j.level === "ok").length;
  const fact: DoctorMessage = fine === 0 ? { key: "doctor.services.bad", params: { list: formatList(problems) } } : { key: "doctor.services.badSome", params: { list: formatList(problems), fine } };
  return {
    level,
    fact,
    fix: { key: linked ? "doctor.fix.services" : "doctor.fix.servicesNoLink" },
    // 一项只放一个按钮：给最要紧的那个（坏了的在前）
    ...(linked ? { action: serviceAction(sorted[0]!.r.service) } : {}),
  };
}
