// 守卫的判定函数（规格第 9 节）：纯函数，不读文件、不跑命令、不看时钟。同样的输入永远得到同样的判定。
//
// 判定的步骤：
// 1. 把这次调用展开成要判定的调用：真实工具调用就是它自己；通用 bash 拆成伪工具调用（拆不开的是一条"未知的写操作"）；
// 2. 对每一条按规则逐项找依据（CALL_RULES）：工具包、路径（围栏、受保护区域、密钥区、越出项目目录、删除或覆盖）、
//    脚本里写着的受保护区域路径、
//    注册表的类别标签、HTTP 方法、联网开关、两条底线、自定义类别、"做完告诉我"；
// 3. "计划里列了才做"：对话里等同"先问我"；任务里每个类别各自看有没有授权项覆盖它；
// 4. 时序规则（temporal-rules.ts：v1 模板、当前阶段和阶段组的规则）；
// 5. 处置依据取最严；有硬拒绝时直接拒绝（两条底线除外），写给模型的说明。
import { DISPOSITION_INFO, executes, strictest, type Disposition } from "./disposition.ts";
import { findCoveringGrant } from "./grants.ts";
import { absolutePathsIn, agentScope, comparable, isGitControlPath, isWithin, isWithinAny, resolveAgentPath, type ResolvedPath, type ShellEnv } from "./paths.ts";
import { findSecretShapes, outboundTextOf } from "./secrets.ts";
import { splitShellCommand } from "./shell/split.ts";
import { checkTemporalRules } from "./temporal-rules.ts";
import {
  argEntriesOf,
  describeCall,
  findTool,
  READ_ONLY_HTTP_METHODS,
  TOOL,
  type ArgKind,
  type ArgRule,
  type ToolDescriptor,
} from "./tool-registry.ts";
import {
  type DispositionFinding,
  type FileFact,
  type GuardFinding,
  type GuardInput,
  type GuardJudgement,
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
  customDisposition,
  type Scene,
  type WatchCategorySettings,
} from "./watch-categories.ts";

export function judgeToolCall(input: GuardInput): GuardJudgement {
  const ctx = new JudgeContext(input);
  const { calls, genericShell, findings } = expandCall(ctx);
  calls.forEach((call, index) => findings.push(...judgeOneCall(ctx, call, index)));
  settlePlanListed(ctx, calls, findings);

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
  });
  for (const hit of temporalRules) {
    if (hit.outcome === "pull_back") findings.push({ kind: "pull_back", id: hit.ruleId, message: hit.message, call: hit.call });
    else findings.push({ kind: "temporal_rule", id: hit.ruleId, disposition: hit.outcome, message: hit.message, call: hit.call });
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
    explanation: explain({ disposition, refused: hardRefusal !== null, pulledBack: pullBack !== null, findings: dispositionFindings, refusals, pullBacks, genericShell }),
    findings,
    calls,
  };
}

/** 判定结果会不会让调用执行：没有硬拒绝、没有按规则退回，处置是"直接做只记录"或"做完告诉我" */
export function judgementExecutes(j: Pick<GuardJudgement, "hardRefusal" | "pullBack" | "disposition">): boolean {
  return j.hardRefusal === null && j.pullBack === null && executes(j.disposition);
}

function isDispositionFinding(f: GuardFinding): f is DispositionFinding {
  return f.kind !== "hard_refusal" && f.kind !== "pull_back";
}

// ───────────────────────── 判定的上下文 ─────────────────────────

/** 一次判定里反复要用的东西：场景、设置、各区的路径，以及按 agent 定下的说法 */
class JudgeContext {
  readonly input: GuardInput;
  readonly scene: Scene;
  readonly settings: WatchCategorySettings[];
  readonly env: ShellEnv;
  /** 联网开关：秘书一律按关着判 */
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
  /** 受保护区域：写入一律永不 */
  readonly protectedAreas: { dir: string; title: string }[];
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

  constructor(input: GuardInput) {
    this.input = input;
    this.scene = input.task ? "task" : "chat";
    this.settings = [input.settings];
    if (input.task?.plan.watchCategories) this.settings.push(input.task.plan.watchCategories);
    const agent = input.agent;
    this.env = { cwd: agent.cwd, homeDir: input.places.homeDir };
    this.networkOff = agent.kind === "secretary" || !agent.toolkit.network;
    const scope = agentScope(agent);
    if (agent.kind === "secretary") {
      this.writeRoots = scope;
      this.readRoots = [...scope, input.places.dataDir.projects];
      this.shellRoots = scope;
      this.projectScope = [];
      this.readOnlyRecords = null;
      this.words = {
        scope: "草稿区",
        readScope: "草稿区和项目档案",
        fence: "秘书的文件工具只能写草稿区（项目档案对秘书只读）。在草稿区里写；要动项目或别处的文件，请建议发起任务",
        networkOff: "但秘书不能联网。联网请发起任务（或给用户一张\"建议发起任务\"卡）",
      };
    } else {
      this.writeRoots = scope;
      this.readRoots = scope;
      this.shellRoots = scope;
      this.projectScope = scope;
      this.readOnlyRecords = agent.kind === "sub_agent" ? { records: agent.projectRecords, workingDirs: agent.workingDirs } : null;
      const who = agent.kind === "maintainer" ? "维护者" : "子 agent";
      this.words = {
        scope: "项目档案和工作目录",
        readScope: "项目档案和工作目录",
        fence: `它在项目档案和工作目录之外：${who}的文件工具只能写项目档案和工作目录，越界写入一律拒绝。改写到工作目录里`,
        networkOff: "但工具包的联网开关关着。联网请发起任务，或提交工具包变更申请开联网",
      };
    }
    const d = input.places.dataDir;
    this.protectedAreas = [
      { dir: d.config, title: "数据目录的配置区" },
      { dir: d.secrets, title: "数据目录的密钥区" },
      { dir: d.db, title: "数据目录的数据库区" },
      { dir: input.places.programDir, title: "二狗程序目录" },
    ];
    this.files = new Map(Object.entries(input.facts.files ?? {}).map(([k, v]) => [comparable(k), v]));
    this.scripts = new Map(Object.entries(input.facts.scripts ?? {}).map(([k, v]) => [comparable(k), v]));
  }

  fileFact(path: string): FileFact | undefined {
    return this.files.get(comparable(path));
  }

  scriptFact(path: string): ScriptFact | undefined {
    return this.scripts.get(comparable(path));
  }
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
      findings: [{ kind: "hard_refusal", id: "no_bash", message: "工具包里没有开 bash", call: 0 }],
    };
  }
  const command = typeof args.command === "string" ? args.command : "";
  const calls: JudgedCall[] = splitShellCommand(command, ctx.env).map((s) => ({ tool: s.tool, args: s.args, origin: "shell", text: s.text, order: s.order }));
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
  networkRule,
  bottomLineRule,
  customCategoryRule,
  notifyRule,
];

function judgeOneCall(ctx: JudgeContext, call: JudgedCall, index: number): GuardFinding[] {
  const out = new FindingCollector(ctx, index);
  const toolkitTools = ctx.input.agent.toolkit.tools;
  if (call.origin === "tool" && toolkitTools && !toolkitTools.includes(call.tool) && !isShellTool(ctx, call.tool)) {
    out.refuse("not_in_toolkit", `工具包没有给 ${call.tool} 这个工具`);
  }
  const tool = findTool(ctx.input.tools, call.tool);
  // 伪工具只能由守卫拆 bash 得到；模型直接调用同名工具时按没登记处理
  if (!tool || (tool.source === "pseudo" && call.origin === "tool")) {
    out.category("unknown_write", `工具 ${call.tool} 没有登记，不知道它会做什么`);
    return out.findings;
  }
  for (const rule of CALL_RULES) rule(ctx, { call, tool, what: describeCall(call, tool) }, out);
  return out.findings;
}

/** bash 和带类型的 bash 工具由工具包的 bash 开关管，不看工具白名单 */
function isShellTool(ctx: JudgeContext, name: string): boolean {
  const source = findTool(ctx.input.tools, name)?.source;
  return name === TOOL.bash || source === "typed_shell";
}

/** 工具包：带类型的 bash 工具随 bash 开关 */
function toolkitRule(ctx: JudgeContext, { tool, what }: KnownCall, out: FindingCollector): void {
  if (tool.source === "typed_shell" && !ctx.input.agent.toolkit.bash) out.refuse("no_bash", `${what}是 bash 工具，工具包里没有开 bash`);
}

/** 拆不开的 bash：未知的写操作 */
function opaqueShellRule(_ctx: JudgeContext, { call, what }: KnownCall, out: FindingCollector): void {
  if (call.tool === TOOL.opaque_shell) out.category("unknown_write", `${what}拆不开：${String(call.args.reason ?? "")}`);
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
    const replaces = access === "delete" || (access === "write" && p.rule.replaces === true);
    if (p.resolved.kind === "unknown") {
      out.category("outside_project", `${what}的路径 ${p.raw} 没法确定（${p.resolved.why}），不能确认在${ctx.words.scope}之内`, [p.name]);
      if (replaces && ctx.projectScope.length > 0) out.category("delete_or_overwrite", `${what}要删除或覆盖的 ${p.raw} 没法确定`, [p.name]);
      continue;
    }
    const targets = [p.resolved.path];
    const real = ctx.fileFact(p.resolved.path)?.realPath;
    if (real && comparable(real) !== comparable(p.resolved.path)) targets.push(real);

    for (const target of targets) {
      const verb = access === "read" ? "读" : access === "delete" ? "删除" : "写";
      const area = ctx.protectedAreas.find((a) => isWithin(target, a.dir));
      if (area && writes) {
        out.push({
          kind: "protected_area",
          id: "protected_area",
          disposition: "never",
          message: `${what}要${verb} ${target}，它在受保护区域（${area.title}）里，任何 agent 用任何方式写入都是永不，用户批准也不行`,
        });
      }
      if (isWithin(target, ctx.input.places.dataDir.secrets)) {
        out.refuse("secrets_area", `${what}要${verb} ${target}，它在数据目录的密钥区里，密钥区连读都拒绝`);
        continue;
      }
      const records = ctx.readOnlyRecords;
      if (records && writes && isWithinAny(target, records.records) && !isWithinAny(target, records.workingDirs)) {
        out.refuse("sub_agent_records", `${what}要${verb} ${target}：子 agent 不能写项目档案。把结果写在工作目录里，交回维护者`);
        continue;
      }
      // git 的配置和钩子（28 号票）：在范围之内，但写它们等于让之后的 git 调用执行任意命令，文件工具和 bash 都按越出项目目录判
      if (writes && isGitControlPath(target) && isWithinAny(target, ctx.shellRoots)) {
        out.category("outside_project", `${what}要${verb} ${target}：这是 git 的配置或钩子，git 会照着它执行命令，按越出${ctx.words.scope}判`, [p.name]);
      }
      if (shellMode) {
        if (!isWithinAny(target, ctx.shellRoots)) out.category("outside_project", `${what}碰到了${ctx.words.scope}之外的路径 ${target}`, [p.name]);
      } else if (writes) {
        if (!isWithinAny(target, ctx.writeRoots)) out.refuse("fence", `${what}要写 ${target}，${ctx.words.fence}`);
      } else if (!isWithinAny(target, ctx.readRoots)) {
        out.category("outside_project", `${what}要读${ctx.words.readScope}之外的 ${target}`, [p.name]);
      }
    }

    const path = p.resolved.path;
    if (replaces && isWithinAny(path, ctx.projectScope)) {
      if (access === "delete") deletes.push(`删除 ${path}`);
      else {
        const fact = ctx.fileFact(path);
        if (fact === undefined || fact.exists) deletes.push(fact ? `覆盖已有的 ${path}` : `可能覆盖 ${path}（不知道它在不在）`);
        else continue;
      }
      deleteArgs.push(p.name);
    }
  }
  if (deletes.length > 0) out.category("delete_or_overwrite", `${what}要${deletes.join("、")}`, deleteArgs);
}

/**
 * 脚本里写着受保护区域的路径（尽力而为，26 号票：关注类别注册表在配置区，agent 用脚本也写不进去）：
 * 拆不开的内联脚本看命令原文，跑脚本文件看调用方扫描报上来的 mentionedPaths。看不出是读还是写，按写入算"永不"
 */
function scriptTextRule(ctx: JudgeContext, kc: KnownCall, out: FindingCollector): void {
  const mentioned: string[] = [];
  if (kc.call.tool === TOOL.opaque_shell && typeof kc.call.args.command === "string") mentioned.push(...absolutePathsIn(kc.call.args.command));
  if (kc.call.tool === TOOL.run_script) {
    for (const p of pathArgs(ctx, kc)) {
      if (p.resolved.kind === "absolute") mentioned.push(...(ctx.scriptFact(p.resolved.path)?.mentionedPaths ?? []));
    }
  }
  for (const target of mentioned) {
    const area = ctx.protectedAreas.find((a) => isWithin(target, a.dir));
    if (!area) continue;
    out.push({
      kind: "protected_area",
      id: "protected_area",
      disposition: "never",
      message: `${kc.what}的脚本里写着 ${target}，它在受保护区域（${area.title}）里；看不出是读还是写，按写入算：任何 agent 用任何方式写入都是永不，用户批准也不行`,
    });
  }
}

/** 注册表里的类别标签（"删除或覆盖"只算项目档案和工作目录里的） */
function categoryTagRule(ctx: JudgeContext, kc: KnownCall, out: FindingCollector): void {
  for (const category of kc.tool.categories) {
    if (category === "delete_or_overwrite" && !touchesProject(ctx, kc)) continue;
    out.category(category, kc.what);
  }
}

/** HTTP：非 GET 的请求算"以我的名义对外发送或发布" */
function httpMethodRule(_ctx: JudgeContext, kc: KnownCall, out: FindingCollector): void {
  for (const m of argValues(kc, "http_method")) {
    const method = typeof m === "string" ? m.toUpperCase() : "";
    if (!READ_ONLY_HTTP_METHODS.includes(method)) out.category("external_send", `${kc.what}是 ${method || "未知方法的"} 请求，不是只读的 GET`);
  }
}

/** 联网开关：联网的工具，以及（调用方扫描后报上来的）用到联网库或函数的脚本 */
function networkRule(ctx: JudgeContext, kc: KnownCall, out: FindingCollector): void {
  if (!ctx.networkOff) return;
  if (kc.tool.network) out.refuse("network_off", `${kc.what}要联网，${ctx.words.networkOff}`);
  if (kc.call.tool !== TOOL.run_script) return;
  for (const p of pathArgs(ctx, kc)) {
    if (p.resolved.kind === "device") continue;
    // 没扫到不等于没联网（rule-steps.ts 的 sends 同样算"判断不了"）：退回，让 agent 先写好脚本再跑
    const fact = p.resolved.kind === "absolute" ? ctx.scriptFact(p.resolved.path) : undefined;
    if (!fact) {
      const why = p.resolved.kind === "absolute" ? `判定时还不存在或读不了（${p.resolved.path}）` : `的路径 ${p.raw} 没法确定`;
      out.pullBack(SCRIPT_NOT_CHECKED, `${kc.what}要跑的脚本${why}，执行前没法检查它联不联网。先用 write 写好脚本再运行，以便执行前检查`);
      continue;
    }
    if (fact.networkUsage.length > 0) out.refuse("network_off", `${kc.what}要跑的脚本用到了联网的库或函数（${fact.networkUsage.join("、")}），${ctx.words.networkOff}`);
  }
}

/** 两条底线：付款转账、创建账户、改密码或两步验证（交给我做）；对外内容里有密钥形态（永不） */
function bottomLineRule(_ctx: JudgeContext, kc: KnownCall, out: FindingCollector): void {
  for (const id of kc.tool.bottomLines ?? []) {
    const line = BOTTOM_LINES[id];
    out.push({ kind: "bottom_line", id, disposition: line.disposition, message: `${kc.what}属于"${line.title}"，这条底线固定为"${DISPOSITION_INFO[line.disposition].label}"` });
  }
  if (!kc.tool.outbound) return;
  const shapes = findSecretShapes(outboundText(kc));
  if (shapes.length === 0) return;
  out.push({
    kind: "bottom_line",
    id: "secret_in_outbound",
    disposition: BOTTOM_LINES.secret_in_outbound.disposition,
    message: `${kc.what}要发出去的内容里有密钥形态（${shapes.map((s) => s.title).join("、")}），把凭据写进对外内容是底线，固定为"永不"`,
  });
}

/** 自定义类别：确定规则命中就按设置里它的处置（同一个 id 的几份和本任务对它的调严取最严） */
function customCategoryRule(ctx: JudgeContext, kc: KnownCall, out: FindingCollector): void {
  for (const custom of ctx.settings.flatMap((s) => s.custom ?? [])) {
    const objectArgs = matchCustomCategory(ctx, custom.match, kc);
    if (!objectArgs) continue;
    const disposition = customDisposition(custom, ctx.scene, ctx.settings);
    out.push({
      kind: "category",
      id: custom.id,
      disposition,
      objectArgs,
      message: `${kc.what}命中自定义关注类别「${custom.title}」，${sceneLabel(ctx.scene)}为"${DISPOSITION_INFO[disposition].label}"`,
    });
  }
}

/** "做完告诉我"标记 */
function notifyRule(_ctx: JudgeContext, kc: KnownCall, out: FindingCollector): void {
  if (kc.tool.notifyWhenDone) out.push({ kind: "notify", id: kc.call.tool, disposition: "notify_after", message: `${kc.what}做完要告诉用户` });
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
    if (!same.message.includes(f.message)) same.message += `；${f.message}`;
    if (isDispositionFinding(same) && f.kind !== "hard_refusal" && f.objectArgs) {
      same.objectArgs = unique([...(same.objectArgs ?? []), ...f.objectArgs]);
    }
  }

  /** 命中内置类别；objectArgs 是让它命中的参数（授权项的对象范围要管到它们） */
  category(category: BuiltinCategoryId, reason: string, objectArgs: string[] = []): void {
    const disposition = builtinDisposition(category, this.ctx.scene, this.ctx.settings);
    const title = builtinCategory(category).title;
    this.push({
      kind: "category",
      id: category,
      disposition,
      objectArgs,
      message: `${reason}，命中关注类别「${title}」（${sceneLabel(this.ctx.scene)}为"${DISPOSITION_INFO[disposition].label}"）`,
    });
  }

  refuse(id: HardRefusalId, message: string): void {
    this.push({ kind: "hard_refusal", id, message });
  }

  /** 按规则退回：agent 自己能补救的前提没满足 */
  pullBack(id: string, message: string): void {
    const same = this.findings.find((x) => x.kind === "pull_back" && x.id === id);
    if (same) {
      if (!same.message.includes(message)) same.message += `；${message}`;
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
      f.message += "；对话里没有计划，按先问我";
      continue;
    }
    const call = calls[f.call]!;
    const check = findCoveringGrant(call.tool, call.args, f.objectArgs ?? [], {
      task,
      effectLog: ctx.input.effectLog,
      now: ctx.input.now,
      tools: ctx.input.tools,
      env: ctx.env,
    });
    if (check.grant) {
      f.disposition = "log_only";
      f.grantId = check.grant.grantId;
      f.message += `；属于授权项 ${check.grant.grantId} 的范围，放行`;
    } else {
      f.disposition = "ask_first";
      f.message += `；${check.reasons.join("；")}，改为先问用户`;
    }
  }
}

// ───────────────────────── 参数 ─────────────────────────

/** 要发出去的内容：对外内容、收件人、网址类参数；从 bash 拆出的再加上那段命令原文（v1 模板"对外内容不许含密钥"用同一个口径） */
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
  return scene === "chat" ? "对话里" : "任务里";
}

// ───────────────────────── 给模型的说明 ─────────────────────────

const SHELL_NOTE = "（通用 bash：已拆开逐条判定，时间线上会单独标出）";

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
  const shellNote = genericShell ? SHELL_NOTE : "";
  const refusalText = unique(refusals.map((f) => f.message)).join("；");
  const decisive = unique(findings.filter((f) => f.disposition === disposition).map((f) => f.message)).join("；");
  // 处置上也拦着的（比如受保护区域、要问用户），作为另外的原因一并告诉模型
  const also = !executes(disposition) && decisive ? `另外：${decisive}。` : "";
  if (refused) {
    return `拒绝：${refusalText}。这次调用不会执行，不问用户，批准和授权项都改变不了。${also}${shellNote}`;
  }
  if (pulledBack) {
    const pullBackText = unique(pullBacks.map((f) => f.message)).join("；");
    return `退回：${pullBackText}。这次调用不会执行，也不问用户：先照说明补上前提，再重新调用。${also}${shellNote}`;
  }
  const { headline, nextStep } = DISPOSITION_INFO[disposition].explain!;
  const reasons = decisive ? `${decisive}。` : "没有命中任何关注类别，";
  // 底线压过了硬拒绝：按底线说，硬拒绝的原因附带一提
  const incidental = refusalText ? `（另外：${refusalText}）` : "";
  return `${headline}：${reasons}${nextStep}${incidental}${shellNote}`;
}

// ───────────────────────── 小工具 ─────────────────────────

function argsOf(args: unknown): Record<string, unknown> {
  return typeof args === "object" && args !== null && !Array.isArray(args) ? (args as Record<string, unknown>) : {};
}

function unique<T>(values: readonly T[]): T[] {
  return [...new Set(values)];
}
