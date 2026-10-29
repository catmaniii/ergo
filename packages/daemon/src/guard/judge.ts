// 守卫的判定函数（规格第 9 节）：纯函数，不读文件、不跑命令、不看时钟。同样的输入永远得到同样的判定。
//
// 判定的步骤：
// 1. 把这次调用展开成要判定的调用：真实工具调用就是它自己；通用 bash 拆成伪工具调用（拆不开的是一条"未知的写操作"）；
// 2. 对每一条按规则逐项找依据（CALL_RULES）：工具包、路径（围栏、受保护区域、密钥区、越出项目目录、删除或覆盖——
//    任务、项目自己的临时文件除外，111 号票，own-temp.ts）、脚本里写着的受保护区域路径、
//    注册表的类别标签、HTTP 方法（发往二狗自己的端口的不算发往本机，139 号票）、用浏览器打开二狗自己的页面、联网开关、
//    两条底线、自定义类别、"做完告诉我"；
// 3. "计划里列了才做"：对话里等同"先问我"；任务里每个类别各自看有没有授权项覆盖它（授权只在所属阶段内有效：
//    当前阶段没有、别的阶段有一条覆盖得了的，拉回当前阶段，13 号票）；
// 4. 时序规则（temporal-rules.ts：v1 模板、当前阶段和阶段组的规则；任务、项目自己的临时文件规则里看得到，111 号票）；
// 5. 任务里对外动作的对象之前被判过"永不"的，至少先问（neverObjects，13 号票控制器的硬检查）；
// 6. 对话审批关着时（70 号票，conversationApprovals: "off"；101 号票改了范围）：秘书的"先问我"除了特别敏感的都按"直接做"，
//    别的 agent（任务的 agent）超出授权的一律按"直接做"（都照常标关注类别）；
// 7. 处置依据取最严；有硬拒绝时直接拒绝（两条底线除外），写给模型的说明。
//
// 说明和依据的话走 t()，按判定时的语言写（173 号票）：守护进程判给 agent 的那一次在中文下判（model-language.ts 的 inModelLanguage），
// 审批卡、"交给我做"这些给用户看的在用户的语言下照同样的输入再判一遍（判定是纯函数，结论一样）。
import { t } from "@ergo/protocol";
import { DISPOSITION_INFO, executes, strictest, type Disposition } from "./disposition.ts";
import { findCoveringGrant, planConcernsCategory } from "./grants.ts";
import {
  agentShellEnv,
  agentScope,
  comparable,
  isGitControlPath,
  isWithin,
  isWithinAny,
  historyDirOf,
  projectHistoryOf,
  resolveAgentPath,
  type ResolvedPath,
  type ShellEnv,
} from "./paths.ts";
import { dataDirMentions, globCanReach, isLocalUrl, ownApiNote, ownPortsOf, related, sendsInText, urlsInText, wildcardPrefix } from "./bottom-line-risk.ts";
import { isSecretFile } from "./secret-files.ts";
import { outboundTextOf, readSecretTitle, secretsIn } from "./secrets.ts";
import { splitShellCommand } from "./shell/split.ts";
import { ownTempTest } from "./own-temp.ts";
import { ruleStep } from "./rule-steps.ts";
import { checkTemporalRules } from "./temporal-rules.ts";
import { V1_TEMPLATE_IDS } from "./rule-templates.ts";
import {
  argEntriesOf,
  describeCall,
  findTool,
  isReadOnlyMethod,
  pathReplacement,
  TOOL,
  type ArgKind,
  type ArgRule,
  type ToolDescriptor,
  type ToolRegistry,
} from "./tool-registry.ts";
import {
  type DispositionFinding,
  type FileFact,
  GRANT_OTHER_STAGE,
  type Grant,
  type GuardFinding,
  type GuardInput,
  type GuardPlaces,
  type GuardJudgement,
  type GuardTask,
  type HardRefusalFinding,
  type HardRefusalId,
  type JudgedCall,
  type PullBackFinding,
  SCRIPT_NOT_CHECKED,
  type ScriptFact,
} from "./types.ts";
import {
  BOTTOM_LINES,
  builtinCategory,
  builtinDisposition,
  type BuiltinCategoryId,
  type CategoryMatch,
  type Scene,
  type TaskWatchSettings,
  type WatchCategorySettings,
} from "./watch-categories.ts";

/** 说明里几句话之间的分隔（中文是"；"） */
const sep = () => t("guard.sep");

export function judgeToolCall(input: GuardInput): GuardJudgement {
  const ctx = new JudgeContext(input);
  const { calls, genericShell, findings } = expandCall(ctx);
  calls.forEach((call, index) => findings.push(...judgeOneCall(ctx, call, index)));
  settlePlanListed(ctx, calls, findings);
  findings.push(...neverObjectFindings(ctx, calls, findings));

  const temporalRules = checkTemporalRules({
    rules: input.temporalRules ?? [],
    calls,
    effectLog: input.effectLog,
    facts: input.facts,
    task: input.task,
    segmentId: input.segmentId,
    agent: input.agent,
    now: input.now,
    tools: input.tools,
    env: ctx.env,
    ownTemp: ctx.ownTemp,
  });
  for (const hit of temporalRules) {
    if (hit.outcome === "pull_back") findings.push({ kind: "pull_back", id: hit.ruleId, message: hit.message, call: hit.call });
    else {
      // 牵涉密钥的 v1 模板判断不了：依据标 keepAsking（70 号票评审后定；101 号票起对话审批关着时只作标记）；判断不了的都标 ruleUnknown
      const keepAsking = hit.status === "unknown" && SECRET_RULE_IDS.has(hit.ruleId);
      findings.push({
        kind: "temporal_rule",
        id: hit.ruleId,
        disposition: hit.outcome,
        message: hit.message,
        call: hit.call,
        ...(hit.status === "unknown" ? { ruleUnknown: true as const } : {}),
        ...(keepAsking ? { keepAsking } : {}),
        // 确实读过 .env 或密钥文件之后判断不了往不往外送：可能碰到硬底线，照旧问（101 号票评审后定）；没读过的这条规则就是满足的
        ...(keepAsking && ctx.secretRead ? { nearBottomLine: true as const } : {}),
      });
    }
  }
  secretReadThenOpaque(ctx, calls, findings);
  if (input.conversationApprovals === "off") {
    if (input.agent.kind === "secretary") relaxSecretaryAsks(findings);
    else letTaskAgentThrough(findings, input.task !== null);
  }

  const dispositionFindings = findings.filter(isDispositionFinding);
  const refusals = findings.filter((f): f is HardRefusalFinding => f.kind === "hard_refusal");
  const pullBacks = findings.filter((f): f is PullBackFinding => f.kind === "pull_back");
  const disposition = strictest(...dispositionFindings.map((f) => f.disposition));
  // 硬拒绝优先于一切处置，只有两条底线例外
  const bottomLine = dispositionFindings.some((f) => f.kind === "bottom_line");
  const hardRefusal = refusals.length > 0 && !bottomLine ? unique(refusals.map((f) => f.id)) : null;
  // 按规则退回：硬拒绝和"永不"更硬（补上前提也做不了），其余（包括要问用户的）都先退回，补上前提再说
  const pullBack = pullBacks.length > 0 && hardRefusal === null && disposition !== "never" ? unique(pullBacks.map((f) => f.id)) : null;
  return {
    hardRefusal,
    pullBack,
    disposition,
    categories: unique(dispositionFindings.filter((f) => f.kind === "category").map((f) => f.id)),
    genericShell,
    temporalRules,
    withinGrant: hardRefusal === null && pullBack === null && executes(disposition) && dispositionFindings.some((f) => f.grantId !== undefined),
    deviation: hardRefusal === null && pullBack === null && disposition === "ask_first" ? deviationOf(dispositionFindings) : null,
    explanation: explain({ disposition, refused: hardRefusal !== null, pulledBack: pullBack !== null, findings: dispositionFindings, refusals, pullBacks, genericShell }),
    findings,
    calls,
  };
}

/** 判定结果会不会让调用执行：没有硬拒绝、没有按规则退回，处置是"直接做只记录"或"做完告诉我" */
export function judgementExecutes(j: Pick<GuardJudgement, "hardRefusal" | "pullBack" | "disposition">): boolean {
  return j.hardRefusal === null && j.pullBack === null && executes(j.disposition);
}

/**
 * 这次调用算不算"只读或幂等"：注册表里标了的才算，没登记、没标的一律按有副作用算。bash 按判定拆出的伪工具调用算：
 * 拆出来的每一条都标了才算（cat、ls……），有一条不是（通用 bash 命令、写、删……）就不算。
 * 被杀后的恢复（23 号票：被中断时能不能直接重做、要不要记执行记录）和流程执行时的计划检查（59 号票：计划外的只读调用只记下）共用
 */
export function isReadOnlyOrIdempotentCall(tools: ToolRegistry, toolName: string, judgement: Pick<GuardJudgement, "calls"> | undefined): boolean {
  const marked = (name: string) => findTool(tools, name)?.readOnlyOrIdempotent === true;
  if (marked(toolName)) return true;
  const calls = judgement?.calls ?? [];
  return calls.length > 0 && calls.every((c) => c.origin === "shell" && marked(c.tool));
}

/** 牵涉密钥的 v1 模板：判断不了时依据标 keepAsking（70 号票评审后定；101 号票起只作标记） */
const SECRET_RULE_IDS: ReadonlySet<string> = new Set([V1_TEMPLATE_IDS.noSendAfterSecretRead, V1_TEMPLATE_IDS.noSecretInOutbound]);

/**
 * 秘书特别敏感的操作（101 号票，用户 2026-10-12 定"秘书稍微管一下特别敏感的操作，要我授权"）：对话审批关着也要用户授权的关注类别。
 * 另外写草稿区之外（依据标 writesOutsideScratch）也要；删除或覆盖草稿区之外的文件按"写"算在那一条里
 */
export const SECRETARY_ASKS: ReadonlySet<string> = new Set<BuiltinCategoryId>(["external_send", "account_security", "irreversible_commit", "delete_or_overwrite"]);

/** 对话审批关着时依据上加的说法（101 号票）：秘书照旧要授权的、任务的 agent 超出授权先不管的 */
export const secretaryAsksNote = () => t("guard.judge.secretaryAsksNote");
/** 可能碰到硬底线的（101 号票评审后定）：对话审批关着也照旧先问 */
export const nearBottomLineNote = () => t("guard.judge.nearBottomLineNote");
export const beyondGrantNote = () => t("guard.judge.beyondGrantNote");

/**
 * 对话审批关着时的秘书（70 号票用户定"先把功能跑通，安全机制后接"，101 号票改了范围）：处置为"先问我"的依据，除了特别敏感的
 * （SECRETARY_ASKS 里的类别、写草稿区之外），一律按"直接做只记录"（关注类别照常命中、照常记录，依据记 approvalsOff）——
 * 判断不了的（keepAsking：要写的路径没法确定、牵涉密钥的 v1 模板判断不了、脚本里写着受保护区域的路径）也是。
 * 硬拒绝、按规则退回不是依据的处置，不受影响；永不（含受保护区域写入、确定要把密钥往外送）、交给我做、做完告诉我不是"先问我"，也不变
 */
function relaxSecretaryAsks(findings: GuardFinding[]): void {
  for (const f of findings) {
    if (!isDispositionFinding(f) || f.disposition !== "ask_first") continue;
    if (f.nearBottomLine) {
      f.message += sep() + nearBottomLineNote();
      continue;
    }
    // 发往本机的请求不算对外（101 号票评审后定：合成语音时 curl -X POST http://127.0.0.1:… 不该弹卡）
    if (f.writesOutsideScratch || (f.kind === "category" && SECRETARY_ASKS.has(f.id) && !f.localTarget)) {
      f.message += sep() + secretaryAsksNote();
      continue;
    }
    f.disposition = "log_only";
    f.approvalsOff = true;
    f.message += sep() + t("guard.judge.approvalsOffNote");
  }
}

/**
 * 对话审批关着时秘书以外的 agent（101 号票，用户 2026-10-12 定"超出了授权范围内的，任务的 agent 先不管，因为他能访问到的数据有限"）：
 * 处置为"先问我"的依据一律按"直接做只记录"（关注类别照常命中、照常记录，依据记 beyondGrant）——"先问我"类别、"计划里列了才做"
 * 没被授权项覆盖的（超出授权、没预料到的类别）、判断不了的（keepAsking 那几种，和时序规则判断不了的 ruleUnknown）、对被判过"永不"的
 * 对象再做对外动作；用到别的阶段的授权项不拉回（settlePlanListed 里就不加）。任务里判断出来确实违反、要问的时序规则照旧问
 * （保证照计划做事，不是权限；主会话 2026-10-12 定）。硬拒绝、按规则退回、永不、交给我做、做完告诉我不变
 */
function letTaskAgentThrough(findings: GuardFinding[], inTask: boolean): void {
  for (const f of findings) {
    if (!isDispositionFinding(f) || f.disposition !== "ask_first") continue;
    if (f.nearBottomLine) {
      f.message += sep() + nearBottomLineNote();
      continue;
    }
    if (inTask && f.kind === "temporal_rule" && !f.ruleUnknown) continue;
    f.disposition = "log_only";
    f.beyondGrant = true;
    f.message += sep() + beyondGrantNote();
  }
}

/**
 * 这个范围里确实读过 .env 或密钥文件（101 号票评审后定）：效果日志里（和时序规则同一个范围：任务里同一个任务的，不属于任务的同一个
 * agent、同一段会话的）有一次调用的读（或看不出读写）的路径参数是密钥文件
 */
function secretReadIn(input: GuardInput): boolean {
  return input.effectLog.some((e) => inEffectScope(input, e) && readsSecretFile(input.tools, e.tool, e.args));
}

function inEffectScope(input: GuardInput, e: GuardInput["effectLog"][number]): boolean {
  if (input.task && !input.task.segmentScoped) return e.taskId === input.task.taskId;
  return e.taskId === null && e.agentId === input.agent.agentId && e.segmentId === input.segmentId;
}

/** 这次调用读（或看不出读写）的路径参数里有密钥文件 */
function readsSecretFile(tools: ToolRegistry, tool: string, args: Readonly<Record<string, unknown>>): boolean {
  const descriptor = findTool(tools, tool);
  if (!descriptor) return false;
  return Object.entries(descriptor.args).some(([name, rule]) => {
    if (rule.kind !== "path" || rule.access === "write" || rule.access === "delete") return false;
    const v = args[name];
    return (Array.isArray(v) ? v : [v]).some((x) => typeof x === "string" && isSecretFile(x));
  });
}

/**
 * 确实读过 .env 或密钥文件之后（之前的调用，或者同一条命令里前面那一段）又有看不透、可能往外送的调用（拆不开的命令、内联脚本、
 * 执行前没扫过的脚本）：可能把密钥往外送，对话审批关着也照旧先问（101 号票评审后定）。没读过的照常（这条规则就是满足的）
 */
function secretReadThenOpaque(ctx: JudgeContext, calls: readonly JudgedCall[], findings: GuardFinding[]): void {
  let read = ctx.secretRead;
  calls.forEach((call, index) => {
    if (read && opaqueCall(ctx, call)) {
      const message = t("guard.judge.secretReadOpaque");
      // 这次调用已有的依据（拆不开的操作、牵涉密钥的时序规则判断不了）标上；都没有的另加一条"未知的写操作"
      const same = findings.filter(
        (f): f is DispositionFinding => isDispositionFinding(f) && f.call === index && ((f.kind === "category" && f.id === "unknown_write") || (f.kind === "temporal_rule" && f.keepAsking === true)),
      );
      for (const f of same) {
        f.nearBottomLine = true;
        if (!f.message.includes(message)) f.message += sep() + message;
      }
      if (same.length === 0) {
        const out = new FindingCollector(ctx, index);
        out.category("unknown_write", message, [], { keepAsking: true, nearBottomLine: true });
        findings.push(...out.findings);
      }
    }
    if (readsSecretFile(ctx.input.tools, call.tool, call.args)) read = true;
  });
}

/** 看不透的调用：拆不开的命令（内联脚本也是）、执行前没扫过的脚本 */
function opaqueCall(ctx: JudgeContext, call: JudgedCall): boolean {
  if (call.tool === TOOL.opaque_shell) return true;
  if (call.tool !== TOOL.run_script) return false;
  const raw = call.args.path;
  if (typeof raw !== "string") return true;
  const resolved = resolveAgentPath(raw, ctx.env);
  return resolved.kind !== "absolute" || ctx.scriptFact(resolved.path) === undefined;
}

/** 对话审批关着、发起调用的不是秘书（101 号票）：超出授权的先不管。流程执行时计划检查要问的也照它放（guard-runtime/plan-check.ts） */
export function taskAgentLeeway(input: Pick<GuardInput, "agent" | "conversationApprovals">): boolean {
  return input.conversationApprovals === "off" && input.agent.kind !== "secretary";
}

/** 偏离的程度：有一处没预料到的类别就是它，否则有超出授权的就是超出授权 */
function deviationOf(findings: readonly DispositionFinding[]): GuardJudgement["deviation"] {
  if (findings.some((f) => f.deviation === "unanticipated")) return "unanticipated";
  return findings.some((f) => f.deviation === "exceeds_grant") ? "exceeds_grant" : null;
}

function isDispositionFinding(f: GuardFinding): f is DispositionFinding {
  return f.kind !== "hard_refusal" && f.kind !== "pull_back";
}

// ───────────────────────── 判定的上下文 ─────────────────────────

/** 一次判定里反复要用的东西：场景、设置、各区的路径，以及按 agent 定下的说法 */
class JudgeContext {
  readonly input: GuardInput;
  readonly scene: Scene;
  /** 全局的关注类别设置 */
  readonly settings: WatchCategorySettings[];
  /** 本任务的关注类别设置（确认计划时的快照）；对话里没有 */
  readonly taskSettings: TaskWatchSettings | undefined;
  readonly env: ShellEnv;
  /** 联网开关关着（70 号票起秘书也按工具包的开关判，秘书是开着的） */
  readonly networkOff: boolean;
  /** 文件工具可写的地方 */
  readonly writeRoots: string[];
  /** 文件工具读这些地方之外的，落入"越出项目目录" */
  readonly readRoots: string[];
  /** bash（和带类型的 bash 工具）碰到这些地方之外的路径，落入"越出项目目录" */
  readonly shellRoots: string[];
  /** 删除或覆盖这些地方里的东西，落入"删除或覆盖"（秘书没有：草稿区里的写、改、删不落入任何类别） */
  readonly projectScope: string[];
  /** 子 agent 不能写的项目档案（工作目录默认在项目档案里面，所以工作目录照常可写） */
  readonly readOnlyRecords: { records: string[]; workingDirs: string[] } | null;
  /** 受保护区域：写入一律永不（密钥区另外连读都拒绝） */
  readonly protectedAreas: ProtectedArea[];
  /** 这个 agent 自己的地方（秘书的草稿区，维护者的项目档案和工作目录）：看不透的文字里写着它们不算碰到数据目录 */
  readonly ownDirs: string[];
  /** 这个范围里确实读过 .env 或密钥文件（效果日志里有、或者守护进程收着读过的密钥值；101 号票评审后定） */
  readonly secretRead: boolean;
  /** 是不是任务、项目自己的临时文件（111 号票，own-temp.ts）：删除、整体重写它不落入"删除或覆盖"，v1 模板也不管 */
  readonly ownTemp: (path: string) => boolean;
  /** 按 agent 定下的说法 */
  readonly words: {
    /** 围栏叫什么（"草稿区"、"项目档案和工作目录"） */
    scope: string;
    /** 文件工具读的范围叫什么 */
    readScope: string;
    /** 文件工具写围栏外被拒时的原因和下一步 */
    fence: string;
    /** 联网开关关着时的原因和下一步 */
    networkOff: string;
  };
  private readonly files: Map<string, FileFact>;
  private readonly scripts: Map<string, ScriptFact>;
  private readonly wildcards: Map<string, readonly string[]>;

  constructor(input: GuardInput) {
    this.input = input;
    this.scene = input.task ? "task" : "chat";
    this.settings = [input.settings];
    this.taskSettings = input.task?.plan.watchCategories;
    const agent = input.agent;
    this.env = agentShellEnv(agent, input.places.homeDir);
    this.networkOff = !agent.toolkit.network;
    const scope = agentScope(agent);
    if (agent.kind === "secretary") {
      this.writeRoots = scope;
      this.readRoots = [...scope, input.places.dataDir.projects];
      this.shellRoots = scope;
      this.projectScope = [];
      this.readOnlyRecords = null;
      this.words = {
        scope: t("guard.judge.words.scratch"),
        readScope: t("guard.judge.words.scratchAndRecords"),
        fence: t("guard.judge.words.secretaryFence"),
        networkOff: t("guard.judge.words.secretaryNetworkOff"),
      };
    } else {
      this.writeRoots = scope;
      this.readRoots = scope;
      this.shellRoots = scope;
      this.projectScope = scope;
      this.readOnlyRecords = agent.kind === "sub_agent" ? { records: agent.projectRecords, workingDirs: agent.workingDirs } : null;
      const who = agent.kind === "maintainer" ? t("guard.judge.words.maintainer") : t("guard.judge.words.subAgent");
      this.words = {
        scope: t("guard.judge.words.project"),
        readScope: t("guard.judge.words.project"),
        fence: t("guard.judge.words.projectFence", { who }),
        networkOff: t("guard.judge.words.toolkitNetworkOff"),
      };
    }
    this.protectedAreas = protectedAreasOf(input.places);
    this.ownDirs = scope;
    this.secretRead = (input.facts.secretValues?.length ?? 0) > 0 || secretReadIn(input);
    this.files = new Map(Object.entries(input.facts.files ?? {}).map(([k, v]) => [comparable(k), v]));
    this.scripts = new Map(Object.entries(input.facts.scripts ?? {}).map(([k, v]) => [comparable(k), v]));
    this.wildcards = new Map(Object.entries(input.facts.wildcards ?? {}).map(([k, v]) => [comparable(k), v]));
    this.ownTemp = ownTempTest(input, this.env, (e) => inEffectScope(input, e));
  }

  fileFact(path: string): FileFact | undefined {
    return this.files.get(comparable(path));
  }

  /** 带通配符的路径展开成的现有路径（调用方给的环境事实）；没给是空的 */
  wildcardMatches(path: string): readonly string[] {
    return this.wildcards.get(comparable(path)) ?? [];
  }

  scriptFact(path: string): ScriptFact | undefined {
    return this.scripts.get(comparable(path));
  }
}

/** 一个受保护区域：目录、怎么称呼它、是不是密钥区 */
export interface ProtectedArea {
  dir: string;
  title: string;
  secrets: boolean;
}

/**
 * 受保护区域（写入一律永不，密钥区连读都拒绝）：数据目录的配置区、密钥区、数据库区和二狗程序目录。守卫判定、
 * 本机文件夹变化不许监视的地方（77 号票，event-sources/folder.ts 另加整个数据目录）都用这一份
 */
export function protectedAreasOf(places: Pick<GuardPlaces, "dataDir" | "programDir">): ProtectedArea[] {
  const d = places.dataDir;
  return [
    { dir: d.config, title: t("guard.judge.areas.config"), secrets: false },
    { dir: d.secrets, title: t("guard.judge.areas.secrets"), secrets: true },
    { dir: d.db, title: t("guard.judge.areas.db"), secrets: false },
    { dir: places.programDir, title: t("guard.judge.areas.program"), secrets: false },
  ];
}

/** 写受保护区域：永不，用户批准也不行（how 写明是怎么碰到的） */
function protectedAreaFinding(how: string, area: ProtectedArea): Omit<DispositionFinding, "call"> {
  return {
    kind: "protected_area",
    id: "protected_area",
    disposition: "never",
    message: t("guard.judge.protectedArea", { how, area: area.title }),
  };
}

// ───────────────────────── 展开：真实工具调用，或 bash 拆出的伪工具调用 ─────────────────────────

function expandCall(ctx: JudgeContext): { calls: JudgedCall[]; genericShell: boolean; findings: GuardFinding[] } {
  const { call, tools, agent } = ctx.input;
  const args = argsOf(call.args);
  if (call.toolName !== TOOL.bash || findTool(tools, call.toolName)?.source !== "builtin") {
    return { calls: [{ tool: call.toolName, args, origin: "tool" }], genericShell: false, findings: [] };
  }
  if (!agent.toolkit.bash) {
    return {
      calls: [{ tool: TOOL.bash, args, origin: "tool" }],
      genericShell: true,
      findings: [{ kind: "hard_refusal", id: "no_bash", message: t("guard.judge.noBash"), call: 0 }],
    };
  }
  const command = typeof args.command === "string" ? args.command : "";
  const calls: JudgedCall[] = splitShellCommand(command, ctx.env).map((s) => ({ ...s, origin: "shell" }));
  return { calls, genericShell: true, findings: [] };
}

// ───────────────────────── 一条调用 ─────────────────────────

/** 登记过的一次调用：调用本身、它的登记、说明里怎么称呼它 */
interface KnownCall {
  call: JudgedCall;
  tool: ToolDescriptor;
  what: string;
}

type CallRule = (ctx: JudgeContext, kc: KnownCall, out: FindingCollector) => void;

const CALL_RULES: readonly CallRule[] = [
  toolkitRule,
  opaqueShellRule,
  pathRule,
  scriptTextRule,
  categoryTagRule,
  httpMethodRule,
  ownPageRule,
  networkRule,
  bottomLineRule,
  customCategoryRule,
  notifyRule,
];

function judgeOneCall(ctx: JudgeContext, call: JudgedCall, index: number): GuardFinding[] {
  const out = new FindingCollector(ctx, index);
  const toolkitTools = ctx.input.agent.toolkit.tools;
  const tool = findTool(ctx.input.tools, call.tool);
  if (call.origin === "tool" && toolkitTools && !toolkitTools.includes(call.tool) && !isShellTool(ctx, call.tool) && !isRuntimeOwnTool(ctx, tool)) {
    out.refuse("not_in_toolkit", t("guard.judge.notInToolkit", { tool: call.tool }));
  }
  // 伪工具只能由守卫拆 bash 得到；模型直接调用同名工具时按没登记处理
  if (!tool || (tool.source === "pseudo" && call.origin === "tool")) {
    out.category("unknown_write", t("guard.judge.unregistered", { tool: call.tool }));
    return out.findings;
  }
  for (const rule of CALL_RULES) rule(ctx, { call, tool, what: describeCall(call, tool) }, out);
  return out.findings;
}

/**
 * 运行时自带、二狗没装配的工具（288 号票，GuardToolkit.runtimeTools）：会话跑在 Claude Code 这类运行时上时，登记表里来源是 runtime 的、
 * 没登记的都不看工具白名单（没登记的接着按未登记的写操作判）
 */
function isRuntimeOwnTool(ctx: JudgeContext, tool: ToolDescriptor | undefined): boolean {
  return ctx.input.agent.toolkit.runtimeTools === true && (tool === undefined || tool.source === "runtime");
}

/** bash 和带类型的 bash 工具由工具包的 bash 开关管，不看工具白名单 */
function isShellTool(ctx: JudgeContext, name: string): boolean {
  const source = findTool(ctx.input.tools, name)?.source;
  return name === TOOL.bash || source === "typed_shell";
}

/** 工具包：带类型的 bash 工具随 bash 开关 */
function toolkitRule(ctx: JudgeContext, { tool, what }: KnownCall, out: FindingCollector): void {
  if (tool.source === "typed_shell" && !ctx.input.agent.toolkit.bash) out.refuse("no_bash", t("guard.judge.typedShellNoBash", { what }));
}

/** 拆不开的 bash：未知的写操作 */
function opaqueShellRule(_ctx: JudgeContext, { call, what }: KnownCall, out: FindingCollector): void {
  if (call.tool === TOOL.opaque_shell) out.category("unknown_write", t("guard.judge.opaque", { what, reason: String(call.args.reason ?? "") }));
}

/** 路径：受保护区域、密钥区、子 agent 写项目档案、围栏、越出项目目录、删除或覆盖 */
function pathRule(ctx: JudgeContext, kc: KnownCall, out: FindingCollector): void {
  const { tool, what } = kc;
  const shellMode = kc.call.origin === "shell" || tool.source === "typed_shell";
  const deletes: string[] = [];
  const deleteArgs: string[] = [];
  for (const p of pathArgs(ctx, kc)) {
    if (p.resolved.kind === "device") continue;
    const access = p.rule.access ?? "unknown";
    const writes = access !== "read";
    const replacement = pathReplacement(tool, p.rule);
    // 带"删除或覆盖"标签的工具整个落入那个类别（categoryTagRule），这里只算删除和整体重写
    const replaces = replacement === "delete" || replacement === "overwrite";
    if (p.resolved.kind === "unknown") {
      // 要写（或看不出读写）的路径没法确定：也可能落在受保护区域里，依据标 keepAsking（70 号票评审后定）；可能碰到硬底线，
      // 对话审批关着时秘书和任务的 agent 也照旧问（nearBottomLine，101 号票评审后定）。只读的路径没法确定照常放开
      const scope = t(writes ? "guard.judge.unknownScopeWrite" : "guard.judge.unknownScope", { scope: ctx.words.scope });
      // 秘书删除或覆盖的路径没法确定（101 号票，主会话定）、看不出读写的程序的路径没法确定（评审后定）：可能落在草稿区外，
      // 算写草稿区之外（特别敏感，对话审批关着也要用户授权）
      const secretaryMayWrite = ctx.input.agent.kind === "secretary" && (replaces || access === "unknown");
      out.category(
        "outside_project",
        t("guard.judge.unknownPath", { what, path: p.raw, why: p.resolved.why, scope }),
        [p.name],
        writes ? { keepAsking: true, nearBottomLine: true, ...(secretaryMayWrite ? { writesOutsideScratch: true } : {}) } : {},
      );
      if (replaces && ctx.projectScope.length > 0) out.category("delete_or_overwrite", t("guard.judge.unknownReplace", { what, path: p.raw }), [p.name]);
      continue;
    }
    const targets = [p.resolved.path];
    const real = ctx.fileFact(p.resolved.path)?.realPath;
    if (real && comparable(real) !== comparable(p.resolved.path)) targets.push(real);
    // 带通配符的（101 号票评审后定）：展开成的现有路径逐个照样比；展不开的按通配符之前那段目录看会不会碰到受保护区域、密钥区
    const prefix = wildcardPrefix(p.resolved.path);
    const matches = prefix === undefined ? [] : ctx.wildcardMatches(p.resolved.path).filter((m) => comparable(m) !== comparable(prefix));
    if (prefix !== undefined && matches.length === 0 && wildcardUnexpanded(ctx, kc, p, prefix, writes, out)) continue;
    targets.push(...matches);

    for (const target of targets) {
      const verb = t(access === "read" ? "guard.judge.verb.read" : access === "delete" ? "guard.judge.verb.delete" : "guard.judge.verb.write");
      const area = ctx.protectedAreas.find((a) => isWithin(target, a.dir)) ?? historyArea(ctx, target);
      if (area && writes) out.push(protectedAreaFinding(t("guard.judge.touches", { what, verb, target }), area));
      // 删除一个目录连带删掉它里面的项目档案历史区（rm -rf 项目档案）：同样永不
      const history = access === "delete" ? historyInside(ctx, target) : undefined;
      if (history) {
        const how = t("guard.judge.touches", { what, verb: t("guard.judge.verb.delete"), target });
        out.push({ ...protectedAreaFinding(how, history), message: t("guard.judge.historyInside", { how, area: history.title, dir: history.dir }) });
      }
      if (isWithin(target, ctx.input.places.dataDir.secrets)) {
        out.refuse("secrets_area", t("guard.judge.secretsArea", { what, verb, target }));
        continue;
      }
      const records = ctx.readOnlyRecords;
      if (records && writes && isWithinAny(target, records.records) && !isWithinAny(target, records.workingDirs)) {
        out.refuse("sub_agent_records", t("guard.judge.subAgentRecords", { what, verb, target }));
        continue;
      }
      // git 的配置和钩子（28 号票）：在范围之内，但写它们等于让之后的 git 调用执行任意命令，文件工具和 bash 都按越出项目目录判
      if (writes && isGitControlPath(target) && isWithinAny(target, ctx.shellRoots)) {
        out.category("outside_project", t("guard.judge.gitControl", { what, verb, target, scope: ctx.words.scope }), [p.name]);
      }
      if (shellMode) {
        // 秘书要写、删草稿区之外的（101 号票）：对话审批关着也要用户授权；看不出读写的程序（robocopy 这类）也算（评审后定）
        const outsideWrite = ctx.input.agent.kind === "secretary" && access !== "read";
        if (!isWithinAny(target, ctx.shellRoots)) out.category("outside_project", t("guard.judge.shellOutside", { what, scope: ctx.words.scope, target }), [p.name], outsideWrite ? { writesOutsideScratch: true } : {});
      } else if (writes) {
        if (!isWithinAny(target, ctx.writeRoots)) {
          // 秘书的文件工具写草稿区之外（101 号票）：对话审批关着时不再硬拒绝，改成先问用户、批了才写（受保护区域照旧永不）
          if (ctx.input.agent.kind === "secretary" && ctx.input.conversationApprovals === "off") {
            out.category("outside_project", t("guard.judge.writeOutsideScratch", { what, target }), [p.name], { writesOutsideScratch: true });
          } else out.refuse("fence", t("guard.judge.fence", { what, target, fence: ctx.words.fence }));
        }
      } else if (!isWithinAny(target, ctx.readRoots)) {
        out.category("outside_project", t("guard.judge.readOutside", { what, scope: ctx.words.readScope, target }), [p.name]);
      }
    }

    const path = p.resolved.path;
    // 任务、项目自己的临时文件（111 号票）：删除、整体重写不算"删除或覆盖"
    if (replaces && isWithinAny(path, ctx.projectScope) && !ctx.ownTemp(path)) {
      if (access === "delete") deletes.push(t("guard.judge.deletePath", { path }));
      else {
        const fact = ctx.fileFact(path);
        if (fact === undefined || fact.exists) deletes.push(t(fact ? "guard.judge.overwriteExisting" : "guard.judge.mayOverwrite", { path }));
        else continue;
      }
      deleteArgs.push(p.name);
    }
  }
  if (deletes.length > 0) out.category("delete_or_overwrite", t("guard.judge.deletes", { what, deletes: deletes.join(t("pages.common.listSep")) }), deleteArgs);
}

/**
 * 脚本里写着受保护区域的路径（尽力而为，26 号票）：拆不开的内联脚本看命令原文，跑脚本文件看调用方扫描报上来的 mentionedPaths。
 * 看不出是读还是写，按拆不开算：写着密钥区里的路径判"永不"（密钥区连读都拒绝）；写着配置区、数据库区、程序目录里的路径
 * 落入"未知的写操作"（先问用户）——真写进去的那一步，文件工具和 bash 拆出的写入照样判永不。
 * 不看环境事实里的真实路径（realPath）：写在文字里的路径不是调用的参数，调用方不为它们现取事实；
 * 拼出来的、经符号链接绕过去的本来就认不出，这里只是尽力而为
 */
function scriptTextRule(ctx: JudgeContext, kc: KnownCall, out: FindingCollector): void {
  const mentioned: string[] = [];
  // 看不透的命令的原文（拆不开的、内联脚本）：101 号票评审后定，`~`、`$HOME` 拼出来的、数据目录的目录名和短名也认
  const opaqueText = kc.call.tool === TOOL.opaque_shell && typeof kc.call.args.command === "string" ? kc.call.args.command : undefined;
  if (opaqueText !== undefined) {
    const found = dataDirMentions(opaqueText, mentionContext(ctx));
    mentioned.push(...found.paths);
    if (found.dataDir && found.areas.length === 0) {
      out.category("unknown_write", t("guard.judge.dataDirMention", { what: kc.what }), [], { keepAsking: true, nearBottomLine: true });
    }
    secretaryOpaqueText(ctx, kc, opaqueText, found.paths, out);
  }
  if (kc.call.tool === TOOL.run_script) {
    for (const p of pathArgs(ctx, kc)) {
      if (p.resolved.kind === "absolute") mentioned.push(...(ctx.scriptFact(p.resolved.path)?.mentionedPaths ?? []));
    }
  }
  for (const target of mentioned) {
    const area = ctx.protectedAreas.find((a) => isWithin(target, a.dir)) ?? historyArea(ctx, target);
    if (!area) continue;
    const how = t("guard.judge.scriptMentions", { what: kc.what, target });
    if (area.secrets) out.push({ ...protectedAreaFinding(how, area), message: t("guard.judge.scriptSecrets", { how, area: area.title }) });
    // 可能碰到硬底线（101 号票评审后定）：对话审批关着也照旧先问；真写进去的那一步照样判永不
    else out.category("unknown_write", t("guard.judge.scriptProtected", { how, area: area.title }), [], { keepAsking: true, nearBottomLine: true });
  }
}

/**
 * 秘书看不透的命令（101 号票评审后定，特别敏感的漏网写法）：原文里写着草稿区之外的路径——可能写、删到草稿区外——和要往外送的
 * （往外 POST、发信；目标都是本机的不算，二狗自己的端口不算本机，139 号票），对话审批关着也要用户授权。开着时本来就先问，不另加
 */
function secretaryOpaqueText(ctx: JudgeContext, kc: KnownCall, text: string, paths: readonly string[], out: FindingCollector): void {
  if (ctx.input.agent.kind !== "secretary" || ctx.input.conversationApprovals !== "off") return;
  const outside = paths.filter((p) => !isWithinAny(p, ctx.shellRoots));
  if (outside.length > 0) {
    out.category("unknown_write", t("guard.judge.outsideScratch", { what: kc.what, paths: outside.join(t("pages.common.listSep")) }), [], { writesOutsideScratch: true });
  }
  const ownPorts = ctx.input.places.ownPorts;
  if (sendsInText(text, ownPorts)) {
    const own = ownPortsOf(urlsInText(text), ownPorts);
    out.category("external_send", t("guard.judge.looksLikeSend", { what: kc.what }) + (own.length > 0 ? sep() + ownApiNote(own) : ""));
  }
}

/** 看不透的文字里写着的数据目录、受保护区域按这个 agent 来认（自己的地方不算） */
function mentionContext(ctx: JudgeContext) {
  return { dataDir: ctx.input.places.dataDir.root, areas: ctx.protectedAreas, homeDir: ctx.input.places.homeDir, ownDirs: ctx.ownDirs };
}

/**
 * 带通配符、展不开的路径（101 号票评审后定：调用方没给展开的结果，或者只展开成了通配符之前那段目录）。通配符之前那段目录：
 * - 要读的：和密钥区有包含关系（任一方向）、通配符能匹配到密钥区里的（比如 `secret*` 这一段能匹配到密钥区的目录名），直接拒绝（密钥区连读都拒绝）；
 *   有包含关系但匹配不到的，先问；
 * - 要写的：和受保护区域（含密钥区）有包含关系（任一方向），先问。
 * 先问的标 nearBottomLine：可能碰到硬底线，对话审批关着也照旧问。拒绝了返回 true，这个路径不再往下比
 */
function wildcardUnexpanded(ctx: JudgeContext, kc: KnownCall, p: PathArg, prefix: string, writes: boolean, out: FindingCollector): boolean {
  if (p.resolved.kind !== "absolute") return false;
  const how = t("guard.judge.wildcard", { what: kc.what, path: p.raw, prefix });
  const areas = ctx.protectedAreas.filter((a) => (writes || a.secrets) && related(prefix, a.dir));
  if (areas.length === 0) return false;
  const secrets = ctx.input.places.dataDir.secrets;
  if (!writes && globCanReach(p.resolved.path, secrets)) {
    out.refuse("secrets_area", t("guard.judge.wildcardSecrets", { how }));
    return true;
  }
  const verb = t(writes ? "guard.judge.wildcardWrite" : "guard.judge.wildcardRead");
  out.category("outside_project", t("guard.judge.wildcardProtected", { how, areas: areas.map((a) => a.title).join(t("pages.common.listSep")), verb }), [p.name], { keepAsking: true, nearBottomLine: true });
  return false;
}

const historyTitle = () => t("guard.judge.areas.history");

/** 落在某个项目档案的历史区里（不论是哪个 agent、哪个项目） */
function historyArea(ctx: JudgeContext, target: string): ProtectedArea | undefined {
  const dir = projectHistoryOf(target, ctx.input.places.dataDir.projects);
  return dir === undefined ? undefined : { dir, title: historyTitle(), secrets: false };
}

/** 要删除的目录里面有这个 agent 的项目档案的历史区 */
function historyInside(ctx: JudgeContext, target: string): ProtectedArea | undefined {
  const agent = ctx.input.agent;
  if (agent.kind === "secretary") return undefined;
  const dir = agent.projectRecords.map(historyDirOf).find((h) => isWithin(h, target));
  return dir === undefined ? undefined : { dir, title: historyTitle(), secrets: false };
}

/** 注册表里的类别标签（"删除或覆盖"只算项目档案和工作目录里的） */
function categoryTagRule(ctx: JudgeContext, kc: KnownCall, out: FindingCollector): void {
  for (const category of kc.tool.categories) {
    if (category === "delete_or_overwrite" && !touchesProject(ctx, kc)) continue;
    out.category(category, kc.what);
  }
}

/** HTTP：非 GET 的请求算"以我的名义对外发送或发布" */
function httpMethodRule(ctx: JudgeContext, kc: KnownCall, out: FindingCollector): void {
  // 发往本机的请求（101 号票评审后定）：照常命中，但秘书的特别敏感不算它。发往二狗自己的端口的不算本机（139 号票）
  const urls = argValues(kc, "url");
  const own = ownPortsOf(urls, ctx.input.places.ownPorts);
  const local = own.length === 0 && urls.length > 0 && urls.every((u) => typeof u === "string" && isLocalUrl(u));
  const note = own.length > 0 ? sep() + ownApiNote(own) : "";
  for (const m of argValues(kc, "http_method")) {
    if (!isReadOnlyMethod(m)) {
      const method = typeof m === "string" && m !== "" ? m.toUpperCase() : t("guard.judge.unknownMethod");
      out.category("external_send", t("guard.judge.httpMethod", { what: kc.what, method }) + note, [], local ? { localTarget: true } : {});
    }
  }
}

/**
 * 用浏览器工具打开二狗自己的页面（139 号票）：算"以我的名义对外发送或发布"（防的是打开二狗的页面去点卡片上的按钮），不算发往本机
 * 的例外。只看命令里写着的网址（shell/programs.ts 拆出的"用浏览器打开网页"）；别的网址照原来的规则，不落入任何类别
 */
function ownPageRule(ctx: JudgeContext, kc: KnownCall, out: FindingCollector): void {
  if (kc.call.tool !== TOOL.browse) return;
  const own = ownPortsOf(argValues(kc, "url"), ctx.input.places.ownPorts);
  if (own.length > 0) out.category("external_send", t("guard.judge.ownPage", { what: kc.what }) + sep() + ownApiNote(own));
}

/** 联网开关：联网的工具，以及（调用方扫描后报上来的）用到联网库或函数的脚本 */
function networkRule(ctx: JudgeContext, kc: KnownCall, out: FindingCollector): void {
  if (!ctx.networkOff) return;
  if (kc.tool.network) out.refuse("network_off", t("guard.judge.network", { what: kc.what, networkOff: ctx.words.networkOff }));
  if (kc.call.tool !== TOOL.run_script) return;
  for (const p of pathArgs(ctx, kc)) {
    if (p.resolved.kind === "device") continue;
    // 没扫到不等于没联网（rule-steps.ts 的 sends 同样算"判断不了"）：退回，让 agent 先写好脚本再跑
    const fact = p.resolved.kind === "absolute" ? ctx.scriptFact(p.resolved.path) : undefined;
    if (!fact) {
      const message =
        p.resolved.kind === "absolute" ? t("guard.judge.scriptMissing", { what: kc.what, path: p.resolved.path }) : t("guard.judge.scriptUnknownPath", { what: kc.what, path: p.raw });
      out.pullBack(SCRIPT_NOT_CHECKED, message);
      continue;
    }
    if (fact.networkUsage.length > 0) {
      out.refuse("network_off", t("guard.judge.scriptNetwork", { what: kc.what, usage: fact.networkUsage.join(t("pages.common.listSep")), networkOff: ctx.words.networkOff }));
    }
  }
}

/** 两条底线：付款转账、创建账户、改密码或两步验证（交给我做）；对外内容里有密钥形态（永不） */
function bottomLineRule(ctx: JudgeContext, kc: KnownCall, out: FindingCollector): void {
  for (const id of kc.tool.bottomLines ?? []) {
    const line = BOTTOM_LINES[id];
    out.push({ kind: "bottom_line", id, disposition: line.disposition, message: t("guard.judge.bottomLine", { what: kc.what, title: line.title, disposition: DISPOSITION_INFO[line.disposition].label }) });
  }
  // 只查会联网的工具（outboundTextOf 对别的工具是空的）；读过的密钥值只说"有"，不带值本身
  const secrets = secretsIn(outboundText(kc), ctx.input.facts.secretValues);
  if (secrets.length === 0) return;
  const readTitle = readSecretTitle();
  const shapes = secrets.filter((s) => s !== readTitle);
  const found = [...(shapes.length > 0 ? [t("guard.judge.secretShapes", { shapes: shapes.join(t("pages.common.listSep")) })] : []), ...(shapes.length < secrets.length ? [readTitle] : [])];
  out.push({
    kind: "bottom_line",
    id: "secret_in_outbound",
    disposition: BOTTOM_LINES.secret_in_outbound.disposition,
    message: t("guard.judge.secretOutbound", { what: kc.what, found: found.join(t("guard.judge.and")) }),
  });
}

/**
 * 自定义类别：确定规则命中就按设置里它的处置。全局的按场景取处置；本任务的（确认计划时的快照）按它在本任务里的处置。
 * 各按各的规则匹配：全局同 id 的类别后来改了规则，两份都命中时取最严（FindingCollector 合并同一类别时取最严）
 */
function customCategoryRule(ctx: JudgeContext, kc: KnownCall, out: FindingCollector): void {
  const categories = [
    ...ctx.settings.flatMap((s) => s.custom ?? []).map((c) => ({ id: c.id, title: c.title, match: c.match, disposition: c[ctx.scene], where: sceneLabel(ctx.scene) })),
    ...(ctx.taskSettings?.custom ?? []).map((c) => ({ ...c, where: t("guard.judge.scene.taskPlan") })),
  ];
  for (const custom of categories) {
    const objectArgs = matchCustomCategory(ctx, custom.match, kc);
    if (!objectArgs) continue;
    out.push({
      kind: "category",
      id: custom.id,
      disposition: custom.disposition,
      objectArgs,
      message: t("guard.judge.customHit", { what: kc.what, title: custom.title, where: custom.where, disposition: DISPOSITION_INFO[custom.disposition].label }),
    });
  }
}

/** "做完告诉我"标记 */
function notifyRule(_ctx: JudgeContext, kc: KnownCall, out: FindingCollector): void {
  if (kc.tool.notifyWhenDone) out.push({ kind: "notify", id: kc.call.tool, disposition: "notify_after", message: t("guard.judge.notify", { what: kc.what }) });
}

/** 一条调用的依据：同一类别、同一硬拒绝原因只记一条，理由合在一起 */
class FindingCollector {
  readonly findings: GuardFinding[] = [];
  private readonly ctx: JudgeContext;
  private readonly index: number;

  constructor(ctx: JudgeContext, index: number) {
    this.ctx = ctx;
    this.index = index;
  }

  push(f: Omit<DispositionFinding, "call"> | Omit<HardRefusalFinding, "call">): void {
    const same = this.findings.find((x) => x.kind === f.kind && x.id === f.id);
    if (!same) {
      this.findings.push({ ...f, call: this.index } as GuardFinding);
      return;
    }
    if (!same.message.includes(f.message)) same.message += sep() + f.message;
    if (isDispositionFinding(same) && f.kind !== "hard_refusal" && f.keepAsking) same.keepAsking = true;
    if (isDispositionFinding(same) && f.kind !== "hard_refusal" && f.writesOutsideScratch) same.writesOutsideScratch = true;
    if (isDispositionFinding(same) && f.kind !== "hard_refusal" && f.nearBottomLine) same.nearBottomLine = true;
    // 发往本机：合起来的每一处都是发往本机的才算
    if (isDispositionFinding(same) && f.kind !== "hard_refusal" && same.localTarget && !f.localTarget) delete same.localTarget;
    // 同一个类别从两处命中（全局的和本任务快照下来的自定义类别）：取最严
    if (isDispositionFinding(same) && f.kind !== "hard_refusal") same.disposition = strictest(same.disposition, f.disposition);
    if (isDispositionFinding(same) && f.kind !== "hard_refusal" && f.objectArgs) {
      same.objectArgs = unique([...(same.objectArgs ?? []), ...f.objectArgs]);
    }
  }

  /** 命中内置类别；objectArgs 是让它命中的参数（授权项的对象范围要管到它们）；extra 是另加的标记（判断不了的、秘书写草稿区之外） */
  category(
    category: BuiltinCategoryId,
    reason: string,
    objectArgs: string[] = [],
    extra: Pick<DispositionFinding, "keepAsking" | "writesOutsideScratch" | "nearBottomLine" | "localTarget"> = {},
  ): void {
    const disposition = builtinDisposition(category, this.ctx.scene, this.ctx.settings, this.ctx.taskSettings);
    const title = builtinCategory(category).title;
    this.push({
      kind: "category",
      id: category,
      disposition,
      objectArgs,
      message: t("guard.judge.categoryHit", { reason, title, scene: sceneLabel(this.ctx.scene), disposition: DISPOSITION_INFO[disposition].label }),
      ...extra,
    });
  }

  refuse(id: HardRefusalId, message: string): void {
    this.push({ kind: "hard_refusal", id, message });
  }

  /** 按规则退回：agent 自己能补救的前提没满足 */
  pullBack(id: string, message: string): void {
    const same = this.findings.find((x) => x.kind === "pull_back" && x.id === id);
    if (same) {
      if (!same.message.includes(message)) same.message += sep() + message;
      return;
    }
    this.findings.push({ kind: "pull_back", id, message, call: this.index });
  }
}

/** 带"删除或覆盖"标签的工具（如 git_discard）：路径参数落在项目里才算；没有路径参数的照标签算 */
function touchesProject(ctx: JudgeContext, kc: KnownCall): boolean {
  const writes = pathArgs(ctx, kc)
    .filter((p) => p.rule.access !== "read")
    .map((p) => p.resolved)
    .filter((r) => r.kind !== "device");
  if (writes.length === 0) return true;
  return writes.some((r) => r.kind === "unknown" || (r.kind === "absolute" && isWithinAny(r.path, ctx.projectScope)));
}

// ───────────────────────── "计划里列了才做" ─────────────────────────

/** 对话里没有计划：等同"先问我"。任务里每个类别各自找授权项：工具对得上、对象范围管到让它命中的参数 */
function settlePlanListed(ctx: JudgeContext, calls: readonly JudgedCall[], findings: GuardFinding[]): void {
  const task = ctx.input.task;
  for (const f of findings) {
    if (!isDispositionFinding(f) || f.disposition !== "plan_listed") continue;
    f.categoryDisposition = "plan_listed";
    if (!task) {
      f.disposition = "ask_first";
      f.message += sep() + t("guard.judge.noPlanInChat");
      continue;
    }
    const call = calls[f.call]!;
    const check = findCoveringGrant(call.tool, call.args, f.objectArgs ?? [], {
      task,
      effectLog: ctx.input.effectLog,
      now: ctx.input.now,
      tools: ctx.input.tools,
      env: ctx.env,
      ...shellCommandOf(ctx, call),
      realPathOf: (p) => ctx.fileFact(p)?.realPath,
      origin: call.origin,
    });
    if (check.grant) {
      f.disposition = "log_only";
      f.grantId = check.grant.grantId;
      f.message += sep() + t("guard.judge.withinGrant", { grant: check.grant.grantId });
      continue;
    }
    f.disposition = "ask_first";
    // 偏离的程度（14 号票）：计划对这个类别有授权项（只是这次超出了）是超出授权；完全没涉及是没预料到的类别
    const custom = [...ctx.settings.flatMap((s) => s.custom ?? []), ...(ctx.taskSettings?.custom ?? [])].find((c) => c.id === f.id);
    const concerned = planConcernsCategory(task.plan, f.id, call.tool, ctx.input.tools, custom?.match.tools) || grantsFallInCategory(ctx, task, f.id);
    f.deviation = concerned ? "exceeds_grant" : "unanticipated";
    f.message += sep() + t(concerned ? "guard.judge.exceedsGrant" : "guard.judge.unanticipated", { reasons: check.reasons.join(sep()) });
    // 授权只在所属阶段内有效：别的阶段有一条换到它自己的阶段就覆盖得了的，拉回当前阶段（不问用户）。
    // 对话审批关着时任务的 agent 超出授权先不管（101 号票）：不拉回，这一条随后按直接做
    if (taskAgentLeeway(ctx.input)) continue;
    const other = otherStageGrant(ctx, task, call, f.objectArgs ?? []);
    if (other) {
      findings.push({
        kind: "pull_back",
        id: GRANT_OTHER_STAGE,
        message: t("guard.judge.otherStage", { grant: other.grantId, stage: other.stageId, current: task.currentStageId }),
        call: f.call,
      });
    }
  }
}

/**
 * 计划里有没有一条授权项本身就落在这个类别里（14 号票）：把授权项当成一次调用（它的工具，对象范围当参数；一项给了几个值的取第一个）
 * 判一遍。按路径判的类别靠它认，比如在主目录建目录的授权项落在"越出项目目录"，同一类别里读主目录的别的文件就是超出授权
 */
function grantsFallInCategory(ctx: JudgeContext, task: GuardTask, categoryId: string): boolean {
  return task.plan.grants.some((grant) => {
    const tool = findTool(ctx.input.tools, grant.tool);
    if (!tool) return false;
    const args = Object.fromEntries(Object.entries(grant.scope).map(([k, v]) => [k, Array.isArray(v) ? v[0] : v]));
    // 伪工具只在拆 bash 时出现：按拆出来的调用判
    const call: JudgedCall = { tool: grant.tool, args, origin: tool.source === "pseudo" ? "shell" : "tool" };
    try {
      return judgeOneCall(ctx, call, 0).some((f) => isDispositionFinding(f) && f.id === categoryId);
    } catch {
      return false;
    }
  });
}

/** 从通用 bash 拆出来的调用：那条命令（限定了命令的授权项按它比，58 号票） */
function shellCommandOf(ctx: JudgeContext, call: JudgedCall): { shellCommand?: string } {
  if (call.origin !== "shell") return {};
  const command = (ctx.input.call.args as { command?: unknown } | null)?.command;
  return typeof command === "string" ? { shellCommand: command } : {};
}

/** 别的阶段里一条覆盖得了这次调用的授权项（换到它自己的阶段判一遍） */
function otherStageGrant(ctx: JudgeContext, task: GuardTask, call: JudgedCall, objectArgs: readonly string[]): Grant | undefined {
  const stages = [...new Set(task.plan.grants.filter((g) => g.tool === call.tool && g.stageId !== task.currentStageId).map((g) => g.stageId))];
  for (const stageId of stages) {
    const check = findCoveringGrant(call.tool, call.args, objectArgs, {
      task: { ...task, currentStageId: stageId },
      effectLog: ctx.input.effectLog,
      now: ctx.input.now,
      tools: ctx.input.tools,
      env: ctx.env,
      ...shellCommandOf(ctx, call),
      realPathOf: (p) => ctx.fileFact(p)?.realPath,
      origin: call.origin,
    });
    if (check.grant) return check.grant;
  }
  return undefined;
}

// ───────────────────────── 被判过"永不"的对象（13 号票） ─────────────────────────

/** 对外动作：会把东西发出去、以用户名义发布的（带类型的工具登记了 outbound，或这一条命中了"以我的名义对外发送或发布"） */
function isOutbound(ctx: JudgeContext, call: JudgedCall, index: number, findings: readonly GuardFinding[]): boolean {
  if (findTool(ctx.input.tools, call.tool)?.outbound === true) return true;
  return findings.some((f) => f.call === index && f.kind === "category" && f.id === "external_send");
}

/** 一次对外动作的对象：收件人（没有收件人参数的发送用目标对象：推送是仓库、远端和分支），只取确定的值 */
function objectsOf(input: GuardInput, env: ShellEnv, call: JudgedCall): string[] {
  const step = ruleStep({ tools: input.tools, env, agent: input.agent, facts: input.facts }, { id: "object", tool: call.tool, args: call.args });
  return unique((step.recipients as unknown[]).filter((r): r is string => typeof r === "string" && r.length > 0));
}

/** 对外动作的对象在这个任务里被判过"永不"：先问用户 */
function neverObjectFindings(ctx: JudgeContext, calls: readonly JudgedCall[], findings: readonly GuardFinding[]): DispositionFinding[] {
  const never = new Set(ctx.input.neverObjects ?? []);
  if (never.size === 0) return [];
  const out: DispositionFinding[] = [];
  calls.forEach((call, index) => {
    if (!isOutbound(ctx, call, index, findings)) return;
    const hit = objectsOf(ctx.input, ctx.env, call).filter((o) => never.has(o));
    if (hit.length === 0) return;
    const tool = findTool(ctx.input.tools, call.tool);
    out.push({
      kind: "never_object",
      id: "never_object",
      disposition: "ask_first",
      message: t("guard.judge.neverObject", { what: tool ? describeCall(call, tool) : call.tool, objects: hit.join(t("pages.common.listSep")) }),
      call: index,
    });
  });
  return out;
}

/**
 * 这次判定里被判"永不"的对象（控制器记下，之后交给判定函数的 neverObjects）：只算处置为"永不"的依据
 * （关注类别、底线、受保护区域、一律禁止类时序规则），按规则退回、判断不了的不算；只记对外动作的对象（收件人或目标对象）
 */
export function neverObjectsOf(input: GuardInput, judgement: GuardJudgement): string[] {
  const env: ShellEnv = agentShellEnv(input.agent, input.places.homeDir);
  const objects: string[] = [];
  for (const f of judgement.findings) {
    if (!isDispositionFinding(f) || f.disposition !== "never") continue;
    const call = judgement.calls[f.call];
    if (!call) continue;
    const outbound = findTool(input.tools, call.tool)?.outbound === true || judgement.findings.some((x) => x.call === f.call && x.kind === "category" && x.id === "external_send");
    if (outbound) objects.push(...objectsOf(input, env, call));
  }
  return unique(objects);
}

// ───────────────────────── 参数 ─────────────────────────

/** 要发出去的内容：会联网发东西的工具除路径以外的参数；从 bash 拆出的再加上那段命令原文（v1 模板"对外内容不许含密钥"用同一个口径，见 secrets.ts） */
function outboundText(kc: KnownCall): string {
  return outboundTextOf(kc.tool, kc.call.args, kc.call.text);
}

/** 自定义类别的确定规则：写了的条件都要满足。命中时返回让它命中的参数，没命中返回 undefined */
function matchCustomCategory(ctx: JudgeContext, match: CategoryMatch, kc: KnownCall): string[] | undefined {
  const objectArgs: string[] = [];
  if (match.tools && !match.tools.includes(kc.call.tool)) return undefined;
  if (match.paths) {
    const dirs = match.paths;
    const hits = pathArgs(ctx, kc).filter((p) => {
      const r = p.resolved;
      return r.kind === "absolute" && dirs.some((dir) => isWithin(r.path, dir));
    });
    if (hits.length === 0) return undefined;
    objectArgs.push(...hits.map((p) => p.name));
  }
  if (match.recipients) {
    const wanted = new Set(match.recipients.map(normalizeRecipient));
    const hits = argEntries(kc, "recipient").filter(([, v]) => typeof v === "string" && wanted.has(normalizeRecipient(v)));
    if (hits.length === 0) return undefined;
    objectArgs.push(...hits.map(([name]) => name));
  }
  if (match.amountOver !== undefined) {
    const over = match.amountOver;
    const hits = argEntries(kc, "amount").filter(([, v]) => (toNumber(v) ?? -Infinity) > over);
    if (hits.length === 0) return undefined;
    objectArgs.push(...hits.map(([name]) => name));
  }
  return unique(objectArgs);
}

function normalizeRecipient(value: string): string {
  return value.trim().toLowerCase();
}

function toNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "" && Number.isFinite(Number(value))) return Number(value);
  return undefined;
}

/** 某一种参数的全部 [参数名, 值]（数组参数展开） */
function argEntries(kc: KnownCall, kind: ArgKind): [string, unknown][] {
  return argEntriesOf(kc.tool, kc.call.args, [kind]);
}

function argValues(kc: KnownCall, kind: ArgKind): unknown[] {
  return argEntries(kc, kind).map(([, v]) => v);
}

interface PathArg {
  name: string;
  rule: ArgRule;
  raw: string;
  resolved: ResolvedPath;
}

/** 调用里的全部路径参数，解析成绝对路径（不填且登记为默认取工作目录的，取工作目录） */
function pathArgs(ctx: JudgeContext, kc: KnownCall): PathArg[] {
  const out: PathArg[] = [];
  for (const [name, rule] of Object.entries(kc.tool.args)) {
    if (rule.kind !== "path") continue;
    const v = kc.call.args[name];
    const raws = Array.isArray(v) ? v : v === undefined || v === null || v === "" ? (rule.defaultsToCwd ? ["."] : []) : [v];
    for (const raw of raws) {
      if (typeof raw !== "string") continue;
      out.push({ name, rule, raw, resolved: resolveAgentPath(raw, ctx.env) });
    }
  }
  return out;
}

function sceneLabel(scene: Scene): string {
  return t(scene === "chat" ? "guard.judge.scene.chat" : "guard.judge.scene.task");
}

// ───────────────────────── 给模型的说明 ─────────────────────────


interface ExplainInput {
  disposition: Disposition;
  refused: boolean;
  pulledBack: boolean;
  findings: readonly DispositionFinding[];
  refusals: readonly HardRefusalFinding[];
  pullBacks: readonly PullBackFinding[];
  genericShell: boolean;
}

function explain({ disposition, refused, pulledBack, findings, refusals, pullBacks, genericShell }: ExplainInput): string {
  const shell = genericShell ? t("guard.judge.explain.shellNote") : "";
  const refusalText = unique(refusals.map((f) => f.message)).join(sep());
  const decisive = unique(findings.filter((f) => f.disposition === disposition).map((f) => f.message)).join(sep());
  // 处置上也拦着的（比如受保护区域、要问用户），作为另外的原因一并告诉模型
  const also = !executes(disposition) && decisive ? t("guard.judge.explain.also", { text: decisive }) : "";
  if (refused) return t("guard.judge.explain.refused", { text: refusalText, also, shell });
  if (pulledBack) {
    const pullBackText = unique(pullBacks.map((f) => f.message)).join(sep());
    return t("guard.judge.explain.pulledBack", { text: pullBackText, also, shell });
  }
  const { headline, nextStep } = DISPOSITION_INFO[disposition].explain!;
  const reasons = decisive ? t("guard.judge.explain.reasons", { text: decisive }) : t("guard.judge.explain.noCategory");
  // 底线压过了硬拒绝：按底线说，硬拒绝的原因附带一提
  const incidental = refusalText ? t("guard.judge.explain.incidental", { text: refusalText }) : "";
  return t("guard.judge.explain.final", { headline, reasons, nextStep, incidental, shell });
}

// ───────────────────────── 小工具 ─────────────────────────

function argsOf(args: unknown): Record<string, unknown> {
  return typeof args === "object" && args !== null && !Array.isArray(args) ? (args as Record<string, unknown>) : {};
}

function unique<T>(values: readonly T[]): T[] {
  return [...new Set(values)];
}
