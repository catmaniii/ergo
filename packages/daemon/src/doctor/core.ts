// 体检"二狗本身"里内核自己登记的几项（410）：组合根建好体检的登记表后调 registerCoreDoctorChecks，不带插件名登记，
// 排在原来八项后面。每项只读现成的状态，不联网、不调模型、不改东西：
// - assistant 主对话：秘书子进程在不在线（secretary.health()，和网关的健康检查、服务管家看到的同一份）。掉线超过阈值 → 坏了；
// - model-calls 模型近况：agent 管家记的最近各轮结局（model-calls.ts）；
// - context 对话长度：秘书和活着的负责人、任务 agent 的上下文用量（context.ts，带"现在压缩"）；
// - services 托管的服务：服务管家那一项拿到的快照里和二狗有关的服务（services.ts，cost local：等服务管家的命令行）；
// - plugins 插件：启用着却没装上的插件汇一句（详情在各插件自己那一块）→ 注意；
// - web 网页文件：网页的构建产物（index.html）在不在（网关的健康检查也看它）→ 不在算坏了。
// 句子里提到秘书用用户给它起的名字（参数 name），不写"秘书"。
import fs from "node:fs";
import { formatList, type PluginInfo, t } from "@ergo/protocol";
import type { TurnRecord } from "../agent-manager/turn-log.ts";
import type { SecretaryHealth } from "../secretary/secretary.ts";
import type { DoctorCheckRegistry, DoctorFinding } from "./checks.ts";
import { type ContextAgentView, judgeContext } from "./context.ts";
import { SUPERVISOR_PROBE_TIMEOUT_MS, type SupervisorStatus } from "./doctor.ts";
import { judgeModelCalls } from "./model-calls.ts";
import { judgeServices, type ServicesInUse } from "./services.ts";

/** 设置 · 插件 */
const PLUGINS_ROUTE = "#/more/plugins";

/** 内核这几项要读的现状（组合根接上，测试换成假的） */
export interface CoreDoctorSources {
  /** 用户给秘书起的名字 */
  assistantName(): string;
  /** 秘书子进程的健康（secretary.health()） */
  secretary(): Pick<SecretaryHealth, "ok" | "status" | "downMs">;
  /** agent 管家记的最近各轮结局 */
  turns(): readonly TurnRecord[];
  /** 要看上下文用量的 agent：秘书在前，然后是活着的负责人、任务 agent（会话 ⚙ 那一份；认不得的不给） */
  contextAgents(): readonly ContextAgentView[];
  /** 服务管家的快照（和服务管家那一项共用一份） */
  supervisor: SupervisorStatus;
  /** 二狗在用的本机语音服务的端口 */
  servicesInUse(): ServicesInUse;
  /** 服务管家的网页（没接入是 undefined） */
  managerUrl(): string | undefined;
  /** 插件清单里每个插件现在的样子 */
  plugins(): readonly PluginInfo[];
  /** 网页构建产物的入口（<网页目录>/index.html） */
  webIndex: string;
  /** 此刻（毫秒时间戳） */
  now(): number;
}

/** 时长写成"40 秒""3 分钟"（分钟那句和 411 的体检项共用一个键，参数叫 count，英文分单复数） */
function durationParams(ms: number): { key: string; params: Record<string, number> } {
  return ms >= 60_000 ? { key: "doctor.duration.minutes", params: { count: Math.round(ms / 60_000) } } : { key: "doctor.duration.seconds", params: { n: Math.max(1, Math.round(ms / 1000)) } };
}

/** 主对话：秘书子进程在不在线 */
export function judgeAssistant(health: Pick<SecretaryHealth, "ok" | "status" | "downMs">, name: string): DoctorFinding {
  if (health.ok) {
    const key = health.status === "busy" ? "doctor.assistant.busy" : health.status === "idle" ? "doctor.assistant.idle" : health.status === "restarting" ? "doctor.assistant.restarting" : "doctor.assistant.starting";
    return { level: "ok", fact: { key, params: { name } } };
  }
  if (health.status === "stopped") return { level: "error", fact: { key: "doctor.assistant.stopped", params: { name } }, fix: { key: "doctor.fix.assistant" } };
  const duration = durationParams(health.downMs ?? 0);
  const why = t(health.status === "restarting" ? "doctor.assistant.why.restarting" : "doctor.assistant.why.starting");
  return { level: "error", fact: { key: "doctor.assistant.down", params: { name, duration: t(duration.key, duration.params), why } }, fix: { key: "doctor.fix.assistant" } };
}

/** 插件：启用着却没装上的（外部组件没装的不算，那是提示）汇一句 */
export function judgePlugins(plugins: readonly PluginInfo[]): DoctorFinding {
  const skipped = plugins.filter((plugin) => plugin.state === "skipped" && plugin.missing !== true);
  const running = plugins.filter((plugin) => plugin.state === "running").length;
  if (skipped.length === 0) return { level: "ok", fact: { key: "doctor.plugins.fine", params: { running } } };
  return {
    level: "warn",
    fact: { key: "doctor.plugins.skipped", params: { names: formatList(skipped.map((plugin) => plugin.title)), n: skipped.length } },
    fix: { key: "doctor.fix.pluginSkipped" },
    action: { kind: "open", route: PLUGINS_ROUTE },
  };
}

/** 网页文件：构建产物的入口在不在 */
export function judgeWeb(indexFile: string, exists: (file: string) => boolean = fs.existsSync): DoctorFinding {
  return exists(indexFile) ? { level: "ok", fact: { key: "doctor.web.fine" } } : { level: "error", fact: { key: "doctor.web.missing", params: { path: indexFile } }, fix: { key: "doctor.fix.web" } };
}

/** 登记内核这几项（不带插件名，进"二狗本身"）；返回撤销 */
export function registerCoreDoctorChecks(registry: Pick<DoctorCheckRegistry, "register">, sources: CoreDoctorSources): () => void {
  const offs = [
    registry.register({ id: "assistant", title: "doctor.check.assistant.title", cost: "passive", run: () => judgeAssistant(sources.secretary(), sources.assistantName()) }),
    registry.register({ id: "model-calls", title: "doctor.check.modelCalls.title", cost: "passive", run: () => judgeModelCalls(sources.turns(), sources.now()) }),
    registry.register({ id: "context", title: "doctor.check.context.title", cost: "passive", run: () => judgeContext(sources.contextAgents(), sources.assistantName()) }),
    registry.register({
      id: "services",
      title: "doctor.check.services.title",
      cost: "local",
      // 等服务管家的命令行（和服务管家那一项同一次），比默认的 1.5 秒长
      timeoutMs: SUPERVISOR_PROBE_TIMEOUT_MS + 1_000,
      run: async () => judgeServices((await sources.supervisor.read()).snapshot, sources.servicesInUse(), sources.managerUrl() !== undefined),
    }),
    registry.register({ id: "plugins", title: "doctor.check.plugins.title", cost: "passive", run: () => judgePlugins(sources.plugins()) }),
    registry.register({ id: "web", title: "doctor.check.web.title", cost: "passive", run: () => judgeWeb(sources.webIndex) }),
  ];
  return () => {
    for (const off of offs) off();
  };
}
