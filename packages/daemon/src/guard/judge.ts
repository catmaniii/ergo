// 守卫的判定函数（规格第 9 节）：纯函数，不读文件、不跑命令、不看时钟。同样的输入永远得到同样的判定。
//
// 判定的步骤：
// 1. 把这次调用展开成要判定的调用：真实工具调用就是它自己；通用 bash 拆成伪工具调用（拆不开的是一条"未知的写操作"）；
// 2. 对每一条：
//    - 硬边界：受保护区域写入（永不）、密钥区读写（拒绝）、文件工具越过路径围栏写入（拒绝）、联网开关关着时联网（拒绝）；
//    - 关注类别：注册表里的类别标签，加上按路径和参数算出来的（越出项目目录、删除或覆盖、非 GET 请求），
//      再加上命中的自定义类别；处置按对话或任务取默认和设置里更严的；
//    - 底线：付款转账、创建账户、改密码或两步验证（交给我做）；对外内容里有密钥形态（永不）；
//    - "做完告诉我"标记；
// 3. "计划里列了才做"：对话里等同"先问我"；任务里看授权项能不能放行；
// 4. 时序规则（05 号票接上）；
// 5. 全部依据取最严，写给模型的说明。
import { DISPOSITION_LABELS, strictest, type GuardDisposition } from "./disposition.ts";
import { comparable, isWithin, isWithinAny, resolveAgentPath, type ResolvedPath } from "./paths.ts";
import { findSecretShapes } from "./secrets.ts";
import { splitShellCommand } from "./shell/split.ts";
import { checkTemporalRules } from "./temporal-rules.ts";
import type { ArgKind, ArgRule, ToolDescriptor } from "./tool-registry.ts";
import type { FileFact, GuardFinding, GuardInput, GuardJudgement, JudgedCall, ScriptFact } from "./types.ts";
import {
  BOTTOM_LINES,
  builtinCategory,
  builtinDisposition,
  type BuiltinCategoryId,
  type CategoryMatch,
  type Scene,
  type WatchCategorySettings,
} from "./watch-categories.ts";

export function judgeToolCall(input: GuardInput): GuardJudgement {
  const ctx = new JudgeContext(input);
  const { calls, genericShell, findings } = expandCall(ctx);
  calls.forEach((c, index) => findings.push(...judgeOneCall(ctx, c, index)));

  // 对话里没有计划："计划里列了才做"等同"先问我"；任务里先按没有授权项处理（授权项在后面接上）
  for (const f of findings) {
    if (f.disposition === "plan_listed") {
      f.tier = "plan_listed";
      f.disposition = "ask_first";
      f.message += ctx.scene === "chat" ? "；对话里没有计划，按先问我" : "；计划里没有覆盖它的授权项";
    }
  }

  const temporalRules = checkTemporalRules({
    rules: input.temporalRules ?? [],
    calls,
    effectLog: input.effectLog,
    facts: input.facts,
    task: input.task,
    agent: input.agent,
    now: input.now,
  });
  for (const hit of temporalRules) {
    findings.push({ kind: "temporal_rule", id: hit.ruleId, disposition: hit.disposition, message: hit.message, call: hit.call });
  }

  const disposition = strictest(...findings.map((f) => f.disposition));
  return {
    disposition,
    categories: unique(findings.filter((f) => f.kind === "category").map((f) => f.id)),
    genericShell,
    temporalRules,
    withinGrant: false,
    explanation: explain(disposition, findings, genericShell),
    findings,
    calls,
  };
}

// ───────────────────────── 判定的上下文 ─────────────────────────

/** 一次判定里反复要用的东西：场景、设置、各区的路径 */
class JudgeContext {
  readonly input: GuardInput;
  readonly scene: Scene;
  readonly settings: WatchCategorySettings[];
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
  /** 受保护区域：写入一律永不 */
  readonly protectedAreas: { dir: string; title: string }[];
  private readonly files: Map<string, FileFact>;
  private readonly scripts: Map<string, ScriptFact>;

  constructor(input: GuardInput) {
    this.input = input;
    this.scene = input.task ? "task" : "chat";
    this.settings = [input.settings];
    if (input.task?.plan.watchCategories) this.settings.push(input.task.plan.watchCategories);
    const agent = input.agent;
    this.networkOff = agent.kind === "secretary" || !agent.toolkit.network;
    if (agent.kind === "secretary") {
      this.writeRoots = [agent.scratchDir];
      this.readRoots = [agent.scratchDir, input.places.dataDir.projects];
      this.shellRoots = [agent.scratchDir];
      this.projectScope = [];
    } else {
      const scope = [...agent.projectRecords, ...agent.workingDirs];
      // 子 agent 不能写项目档案（工作目录默认在项目档案里面，所以按工作目录放行）
      this.writeRoots = agent.kind === "sub_agent" ? [...agent.workingDirs] : scope;
      this.readRoots = scope;
      this.shellRoots = scope;
      this.projectScope = scope;
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

  agentLabel(): string {
    return { secretary: "秘书", maintainer: "维护者", sub_agent: "子 agent" }[this.input.agent.kind];
  }
}

// ───────────────────────── 展开：真实工具调用，或 bash 拆出的伪工具调用 ─────────────────────────

function expandCall(ctx: JudgeContext): { calls: JudgedCall[]; genericShell: boolean; findings: GuardFinding[] } {
  const { call, tools, agent, places } = ctx.input;
  const args = argsOf(call.args);
  const descriptor = Object.hasOwn(tools, call.toolName) ? tools[call.toolName] : undefined;
  if (call.toolName !== "bash" || descriptor?.source !== "builtin") {
    return { calls: [{ tool: call.toolName, args, origin: "tool" }], genericShell: false, findings: [] };
  }
  if (!agent.toolkit.bash) {
    return {
      calls: [{ tool: "bash", args, origin: "tool" }],
      genericShell: true,
      findings: [{ kind: "boundary", id: "no_bash", disposition: "rejected", message: "工具包里没有开 bash", call: 0 }],
    };
  }
  const command = typeof args.command === "string" ? args.command : "";
  const calls: JudgedCall[] = splitShellCommand(command, { cwd: agent.cwd, homeDir: places.homeDir }).map((s) => ({
    tool: s.tool,
    args: s.args,
    origin: "shell",
    text: s.text,
  }));
  return { calls, genericShell: true, findings: [] };
}

// ───────────────────────── 一条调用 ─────────────────────────

function judgeOneCall(ctx: JudgeContext, c: JudgedCall, index: number): GuardFinding[] {
  const out = new FindingCollector(index);
  const descriptor = lookupTool(ctx.input, c);
  if (!descriptor) {
    out.category(ctx, "unknown_write", `工具 ${c.tool} 没有登记，不知道它会做什么`);
    return out.findings;
  }
  const what = c.origin === "shell" ? `bash 里的「${c.text ?? c.tool}」` : `${descriptor.title}（${c.tool}）`;
  if (c.tool === "opaque_shell") {
    out.category(ctx, "unknown_write", `${what}拆不开：${String(c.args.reason ?? "")}`);
  }

  // 路径：受保护区域、密钥区、围栏、越出项目目录、删除或覆盖
  const shellMode = c.origin === "shell" || descriptor.source === "typed_shell";
  const deletesInsideProject: string[] = [];
  for (const p of pathArgs(c, descriptor, ctx.input)) {
    if (p.resolved.kind === "device") continue;
    const access = p.rule.access ?? "unknown";
    const writes = access !== "read";
    if (p.resolved.kind === "unknown") {
      out.category(ctx, "outside_project", `${what}的路径 ${p.raw} 没法确定（${p.resolved.why}），不能确认在${scopeLabel(ctx)}之内`);
      if (access === "delete" || (access === "write" && p.rule.replaces)) {
        if (ctx.projectScope.length > 0) out.category(ctx, "delete_or_overwrite", `${what}要删除或覆盖的 ${p.raw} 没法确定`);
      }
      continue;
    }
    const targets = [p.resolved.path];
    const real = ctx.fileFact(p.resolved.path)?.realPath;
    if (real && comparable(real) !== comparable(p.resolved.path)) targets.push(real);

    for (const target of targets) {
      const verb = access === "read" ? "读" : access === "delete" ? "删除" : "写";
      const area = ctx.protectedAreas.find((a) => isWithin(target, a.dir));
      if (area && writes) {
        out.boundary("protected_area", "never", `${what}要${verb} ${target}，它在受保护区域（${area.title}）里，任何 agent 用任何方式写入都是永不，用户批准也不行`);
      }
      if (isWithin(target, ctx.input.places.dataDir.secrets)) {
        out.boundary("secrets_area", "rejected", `${what}要${verb} ${target}，它在数据目录的密钥区里，密钥区连读都拒绝`);
        continue;
      }
      if (shellMode) {
        if (!isWithinAny(target, ctx.shellRoots)) out.category(ctx, "outside_project", `${what}碰到了${scopeLabel(ctx)}之外的路径 ${target}`);
      } else if (writes) {
        if (!isWithinAny(target, ctx.writeRoots)) out.boundary("fence", "rejected", fenceMessage(ctx, what, target));
      } else if (!isWithinAny(target, ctx.readRoots)) {
        out.category(ctx, "outside_project", `${what}要读${readScopeLabel(ctx)}之外的 ${target}`);
      }
    }

    const path = p.resolved.path;
    if (isWithinAny(path, ctx.projectScope)) {
      if (access === "delete") deletesInsideProject.push(`删除 ${path}`);
      else if (access === "write" && p.rule.replaces) {
        const fact = ctx.fileFact(path);
        if (fact === undefined || fact.exists) deletesInsideProject.push(fact ? `覆盖已有的 ${path}` : `可能覆盖 ${path}（不知道它在不在）`);
      }
    }
  }
  if (deletesInsideProject.length > 0) out.category(ctx, "delete_or_overwrite", `${what}要${deletesInsideProject.join("、")}`);

  // 注册表里的类别标签（"删除或覆盖"只算项目档案和工作目录里的，由上面按路径算）
  for (const category of descriptor.categories) {
    if (category === "delete_or_overwrite" && !touchesProject(ctx, c, descriptor)) continue;
    out.category(ctx, category, what);
  }

  // HTTP：非 GET 的请求算"以我的名义对外发送或发布"
  for (const m of argValues(c, descriptor, "http_method")) {
    const method = typeof m === "string" ? m.toUpperCase() : "";
    if (!["GET", "HEAD", "OPTIONS"].includes(method)) out.category(ctx, "external_send", `${what}是 ${method || "未知方法的"} 请求，不是只读的 GET`);
  }

  // 联网开关
  if (ctx.networkOff) {
    if (descriptor.network) out.boundary("network_off", "rejected", networkMessage(ctx, `${what}要联网`));
    if (c.tool === "run_script") {
      for (const p of pathArgs(c, descriptor, ctx.input)) {
        if (p.resolved.kind !== "absolute") continue;
        const usage = ctx.scriptFact(p.resolved.path)?.networkUsage ?? [];
        if (usage.length > 0) out.boundary("network_off", "rejected", networkMessage(ctx, `${what}要跑的脚本用到了联网的库或函数（${usage.join("、")}）`));
      }
    }
  }

  // 底线
  for (const id of descriptor.bottomLines ?? []) {
    const line = BOTTOM_LINES[id];
    out.push({ kind: "bottom_line", id, disposition: line.disposition, message: `${what}属于"${line.title}"，这条底线固定为"${DISPOSITION_LABELS[line.disposition]}"` });
  }
  if (descriptor.outbound) {
    const shapes = findSecretShapes(outboundText(c, descriptor));
    if (shapes.length > 0) {
      out.push({
        kind: "bottom_line",
        id: "secret_in_outbound",
        disposition: BOTTOM_LINES.secret_in_outbound.disposition,
        message: `${what}要发出去的内容里有密钥形态（${shapes.map((s) => s.title).join("、")}），把凭据写进对外内容是底线，固定为"永不"`,
      });
    }
  }

  // 自定义类别
  for (const custom of ctx.settings.flatMap((s) => s.custom ?? [])) {
    if (!matchesCustomCategory(custom.match, c, descriptor, ctx.input)) continue;
    const disposition = custom[ctx.scene];
    out.push({
      kind: "category",
      id: custom.id,
      disposition,
      message: `${what}命中自定义关注类别「${custom.title}」，${sceneLabel(ctx.scene)}为"${DISPOSITION_LABELS[disposition]}"`,
    });
  }

  if (descriptor.notifyWhenDone) {
    out.push({ kind: "notify", id: c.tool, disposition: "notify_after", message: `${what}做完要告诉用户` });
  }
  return out.findings;
}

/** 一条调用的依据：同一类别、同一硬边界只记一条，理由合在一起 */
class FindingCollector {
  readonly findings: GuardFinding[] = [];
  private readonly index: number;

  constructor(index: number) {
    this.index = index;
  }

  push(f: Omit<GuardFinding, "call">): void {
    const same = this.findings.find((x) => x.kind === f.kind && x.id === f.id);
    if (same) {
      if (!same.message.includes(f.message)) same.message += `；${f.message}`;
      return;
    }
    this.findings.push({ ...f, call: this.index });
  }

  category(ctx: JudgeContext, category: BuiltinCategoryId, reason: string): void {
    const disposition = builtinDisposition(category, ctx.scene, ctx.settings);
    const title = builtinCategory(category).title;
    this.push({
      kind: "category",
      id: category,
      disposition,
      message: `${reason}，命中关注类别「${title}」（${sceneLabel(ctx.scene)}为"${DISPOSITION_LABELS[disposition]}"）`,
    });
  }

  boundary(id: string, disposition: GuardDisposition, message: string): void {
    this.push({ kind: "boundary", id, disposition, message });
  }
}

function lookupTool(input: GuardInput, c: JudgedCall): ToolDescriptor | undefined {
  const descriptor = Object.hasOwn(input.tools, c.tool) ? input.tools[c.tool] : undefined;
  // 伪工具只能由守卫拆 bash 得到；模型直接调用同名工具时按没登记处理
  if (descriptor?.source === "pseudo" && c.origin === "tool") return undefined;
  return descriptor;
}

/** 带"删除或覆盖"标签的工具（如 git_discard）：路径参数落在项目里才算；没有路径参数的照标签算 */
function touchesProject(ctx: JudgeContext, c: JudgedCall, descriptor: ToolDescriptor): boolean {
  const writes = pathArgs(c, descriptor, ctx.input)
    .filter((p) => p.rule.access !== "read")
    .map((p) => p.resolved)
    .filter((r) => r.kind !== "device");
  if (writes.length === 0) return true;
  return writes.some((r) => r.kind === "unknown" || (r.kind === "absolute" && isWithinAny(r.path, ctx.projectScope)));
}

function scopeLabel(ctx: JudgeContext): string {
  return ctx.input.agent.kind === "secretary" ? "草稿区" : "项目档案和工作目录";
}

function readScopeLabel(ctx: JudgeContext): string {
  return ctx.input.agent.kind === "secretary" ? "草稿区和项目档案" : "项目档案和工作目录";
}

function fenceMessage(ctx: JudgeContext, what: string, target: string): string {
  const agent = ctx.input.agent;
  if (agent.kind === "secretary") {
    return `${what}要写 ${target}：秘书的文件工具只能写草稿区（项目档案对秘书只读）。在草稿区里写；要动项目或别处的文件，请建议发起任务`;
  }
  if (agent.kind === "sub_agent" && isWithinAny(target, agent.projectRecords)) {
    return `${what}要写 ${target}：子 agent 不能写项目档案。把结果写在工作目录里，交回维护者`;
  }
  return `${what}要写 ${target}，它在项目档案和工作目录之外：${ctx.agentLabel()}的文件工具只能写项目档案和工作目录，越界写入一律拒绝。改写到工作目录里`;
}

function networkMessage(ctx: JudgeContext, what: string): string {
  if (ctx.input.agent.kind === "secretary") return `${what}，但秘书不能联网。联网请发起任务（或给用户一张"建议发起任务"卡）`;
  return `${what}，但工具包的联网开关关着。联网请发起任务，或提交工具包变更申请开联网`;
}

// ───────────────────────── 参数 ─────────────────────────

/** 要发出去的内容：对外内容、收件人、网址类参数；从 bash 拆出的再加上那段命令原文 */
function outboundText(c: JudgedCall, descriptor: ToolDescriptor): string {
  const parts: string[] = [];
  for (const kind of ["content", "recipient", "url"] as const) {
    for (const v of argValues(c, descriptor, kind)) parts.push(typeof v === "string" ? v : (JSON.stringify(v) ?? ""));
  }
  if (c.text) parts.push(c.text);
  return parts.join("\n");
}

/** 自定义类别的确定规则：写了的条件都要满足 */
function matchesCustomCategory(match: CategoryMatch, c: JudgedCall, descriptor: ToolDescriptor, input: GuardInput): boolean {
  if (match.tools && !match.tools.includes(c.tool)) return false;
  if (match.paths) {
    const paths = pathArgs(c, descriptor, input).flatMap((p) => (p.resolved.kind === "absolute" ? [p.resolved.path] : []));
    if (!paths.some((p) => match.paths!.some((dir) => isWithin(p, dir)))) return false;
  }
  if (match.recipients) {
    const wanted = new Set(match.recipients.map(normalizeRecipient));
    if (!argValues(c, descriptor, "recipient").some((v) => typeof v === "string" && wanted.has(normalizeRecipient(v)))) return false;
  }
  if (match.amountOver !== undefined) {
    const over = match.amountOver;
    if (!argValues(c, descriptor, "amount").some((v) => (toNumber(v) ?? -Infinity) > over)) return false;
  }
  return true;
}

function normalizeRecipient(value: string): string {
  return value.trim().toLowerCase();
}

function toNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "" && Number.isFinite(Number(value))) return Number(value);
  return undefined;
}

/** 某一种参数的全部值（数组参数展开） */
function argValues(c: JudgedCall, descriptor: ToolDescriptor, kind: ArgKind): unknown[] {
  const values: unknown[] = [];
  for (const [name, rule] of Object.entries(descriptor.args)) {
    if (rule.kind !== kind) continue;
    const v = c.args[name];
    if (Array.isArray(v)) values.push(...v);
    else if (v !== undefined && v !== null) values.push(v);
  }
  return values;
}

interface PathArg {
  name: string;
  rule: ArgRule;
  raw: string;
  resolved: ResolvedPath;
}

/** 调用里的全部路径参数，解析成绝对路径（不填且登记为默认取工作目录的，取工作目录） */
function pathArgs(c: JudgedCall, descriptor: ToolDescriptor, input: GuardInput): PathArg[] {
  const out: PathArg[] = [];
  for (const [name, rule] of Object.entries(descriptor.args)) {
    if (rule.kind !== "path") continue;
    const v = c.args[name];
    const raws = Array.isArray(v) ? v : v === undefined || v === null || v === "" ? (rule.defaultsToCwd ? ["."] : []) : [v];
    for (const raw of raws) {
      if (typeof raw !== "string") continue;
      out.push({ name, rule, raw, resolved: resolveAgentPath(raw, input.agent.cwd, input.places.homeDir) });
    }
  }
  return out;
}

function sceneLabel(scene: Scene): string {
  return scene === "chat" ? "对话里" : "任务里";
}

// ───────────────────────── 给模型的说明 ─────────────────────────

const NEXT_STEP: Readonly<Record<GuardDisposition, string>> = {
  log_only: "直接做，只记录。",
  notify_after: "直接做，做完会告诉用户。",
  plan_listed: "",
  ask_first: "守护进程会请用户审批，批准后才执行；不要换个写法绕过。",
  hand_over: "不要自己执行：把需要的信息整理好，交给用户亲手完成。",
  rejected: "这次调用不会执行。",
  never: "这次调用不会执行，任何设置、授权项和用户批准都放宽不了；换一种做法，或者放弃这一步。",
};

const HEADLINE: Readonly<Record<GuardDisposition, string>> = {
  log_only: "放行",
  notify_after: "放行",
  plan_listed: "计划里列了才做",
  ask_first: "先问用户",
  hand_over: "交给用户做",
  rejected: "拒绝",
  never: "永不",
};

function explain(disposition: GuardDisposition, findings: readonly GuardFinding[], genericShell: boolean): string {
  const decisive = findings.filter((f) => f.disposition === disposition).map((f) => f.message);
  const shellNote = genericShell ? "（通用 bash：已拆开逐条判定，时间线上会单独标出）" : "";
  if (decisive.length === 0) return `${HEADLINE[disposition]}：没有命中任何关注类别，${NEXT_STEP[disposition]}${shellNote}`;
  return `${HEADLINE[disposition]}：${unique(decisive).join("；")}。${NEXT_STEP[disposition]}${shellNote}`;
}

// ───────────────────────── 小工具 ─────────────────────────

function argsOf(args: unknown): Record<string, unknown> {
  return typeof args === "object" && args !== null && !Array.isArray(args) ? (args as Record<string, unknown>) : {};
}

function unique<T>(values: readonly T[]): T[] {
  return [...new Set(values)];
}
