// 运营接口清单的验收（268 号票，草稿："清单按 112 号票的自动验收（格式对、每个操作一条能跑通的测试、只读的真不写）"）：
// - 格式对：读得通（manifest.ts），每个操作写全了——中文标题、什么时候用（description）、用户可能怎么说（userSays）、种类（kind，
//   旧清单的 readOnlyHint 也算写了）、一条测试（test）；参数说明写得对（args.ts 的 schemaProblems：枚举有中文名、默认值合乎 schema……），
//   测试的参数合乎参数说明；实现方式落得下来——http 的调用口对得上服务（使用中看 LSM 上的、建设中看运营方案里的），script 的脚本
//   在工作目录里，ergo / maintainer 引用的 "{{参数名}}" 都是这个操作的参数，maintainer 的项目收得了内部任务。
//   参数太多、嵌套的对象、可选参数没写默认值只提醒（warnings），不挡。
// - 每个操作一条能跑通的测试：格式对了才跑——照 test.args 调一次（带测试标记：http 请求体的 _meta、脚本的 ERGO_OPS_TEST；
//   ergo、maintainer 的有副作用的只看做不做得了），要做成、要有实现自己给的能念的那句 say（sayIncludes 写了的要包含它）；
// - 只读的真不写：只读查询的测试前后比一比项目档案和工作目录（snapshot.ts），新建、改过、删掉了文件的不过。
// http 的测试要服务在跑：服务还没起来（建设中服务还没交给 LSM、关着、还在上线、连不上）的记成 waiting——别的都过了就是"等服务上线后再跑"，
// 不算没过（照 259 号票清单里"确认后交给 LSM 登记"的写法）；服务起来以后再验一次才算全过。
import { type Project, t } from "@ergo/protocol";
import { placeholdersIn, prepareArgs, propertiesOf, schemaProblems, schemaWarnings } from "./args.ts";
import type { OpsManifestRead, ProjectOp } from "./manifest.ts";
import { type OpsMsg, problem } from "./problems.ts";
import { runOp, type RunContext } from "./runner.ts";
import { scriptPath } from "./script.ts";
import { changedFiles, snapshotDirs } from "./snapshot.ts";

/** 一个操作的测试结果 */
export interface OpsCheckOp {
  name: string;
  result: "passed" | "failed" | "waiting";
  /** 测试调用回的能念的那句 */
  say?: string;
  /** 没过、等着的原因 */
  note?: OpsMsg;
}

/** 一次验收的结论 */
export interface OpsCheckResult {
  /** passed 全过；failed 没过（problems 里写着）；waiting 别的都过了，http 的测试等服务上线后再跑 */
  outcome: "passed" | "failed" | "waiting";
  problems: OpsMsg[];
  warnings: OpsMsg[];
  /** 每个操作的测试（格式不对没跑测试的是空的） */
  ops: OpsCheckOp[];
}

export interface AcceptanceInput {
  project: Project;
  read: Extract<OpsManifestRead, { kind: "ok" }>;
  run: RunContext;
  /** 只读的真不写：比哪几个目录（项目档案、工作目录），路径相对哪里写 */
  watchDirs: readonly string[];
  base: string;
  /** 测试调用的幂等键前缀（同一份清单的同一个操作同一个键） */
  key: string;
}

const firstLine = (text: string) => (text.trim().split(/\r?\n/)[0] ?? "").slice(0, 200);

/** 格式对：每个操作写全了、参数说明写对了、实现方式落得下来（见文件开头） */
export function formatProblems(input: Pick<AcceptanceInput, "project" | "read" | "run">): { problems: OpsMsg[]; warnings: OpsMsg[] } {
  const problems: OpsMsg[] = [];
  const warnings: OpsMsg[] = [];
  const { read, run } = input;
  for (const op of read.ops) {
    const name = op.name;
    if (!op.title) problems.push(problem("missingTitle", { name }));
    if (!op.description.trim()) problems.push(problem("missingDescription", { name }));
    if (op.userSays.length === 0) problems.push(problem("missingUserSays", { name }));
    if (op.kindFrom === "default") problems.push(problem("missingKind", { name }));
    problems.push(...schemaProblems(name, op.inputSchema));
    warnings.push(...schemaWarnings(name, op.inputSchema));
    if (!op.test) problems.push(problem("missingTest", { name }));
    else {
      const prepared = prepareArgs(op.inputSchema, op.test.args);
      if (!prepared.ok) problems.push(problem("testArgsInvalid", { name, reason: prepared.problems.join(t("protocol.common.semiSep")) }));
    }
    const known = new Set(propertiesOf(op.inputSchema).map(([p]) => p));
    const placeholders = op.impl.type === "ergo" ? placeholdersIn(op.impl.params) : op.impl.type === "maintainer" ? placeholdersIn(op.impl.instructions ?? "") : [];
    for (const p of new Set(placeholders)) if (!known.has(p)) problems.push(problem("placeholderUnknown", { name, placeholder: p }));
    if (op.impl.type === "script") {
      const located = scriptPath(run.workdir, op.impl.file);
      if (!located.ok) problems.push(problem("scriptMissing", { name, file: op.impl.file }));
    }
    if (op.impl.type === "maintainer") {
      try {
        run.delegate({ project: input.project, title: op.title ?? name, instructions: "check", check: true });
      } catch (err) {
        problems.push(problem("maintainerUnavailable", { name, reason: err instanceof Error ? err.message : String(err) }));
      }
    }
  }
  // http 的操作：调用口对得上服务（对不上的说一次）
  if (read.ops.some((op) => op.impl.type === "http")) {
    const target = run.endpointTarget(read.endpoint);
    if (target.kind === "unmatched") problems.push(target.msg ?? problem("endpointNoService"));
  }
  return { problems, warnings };
}

/** 验收一份读得通的清单（见文件开头） */
export async function runAcceptance(input: AcceptanceInput): Promise<OpsCheckResult> {
  const { problems, warnings } = formatProblems(input);
  if (problems.length > 0) return { outcome: "failed", problems, warnings, ops: [] };
  const ops: OpsCheckOp[] = [];
  const run: RunContext = { ...input.run, endpoint: input.read.endpoint };
  for (const op of input.read.ops) ops.push(await testOne(input, run, op));
  const failed = ops.flatMap((o) => (o.result === "failed" && o.note ? [o.note] : []));
  return { outcome: failed.length > 0 ? "failed" : ops.some((o) => o.result === "waiting") ? "waiting" : "passed", problems: failed, warnings, ops };
}

async function testOne(input: AcceptanceInput, run: RunContext, op: ProjectOp): Promise<OpsCheckOp> {
  const name = op.name;
  const test = op.test!;
  const prepared = prepareArgs(op.inputSchema, test.args);
  if (!prepared.ok) return { name, result: "failed", note: problem("testArgsInvalid", { name, reason: prepared.problems.join(t("protocol.common.semiSep")) }) };
  const before = op.kind === "query" ? snapshotDirs(input.watchDirs) : undefined;
  const outcome = await runOp(run, op, prepared.args, { test: true, key: `${input.key}:${name}` });
  // http 的服务还没起来（没交给 LSM、关着、还在上线、端口没人听）：等服务上线后再跑
  if (op.impl.type === "http" && (outcome.reach === "blocked" || outcome.reach === "refused")) {
    return { name, result: "waiting", note: problem("testWaiting", { name, reason: firstLine(outcome.blocked ?? outcome.detail) }) };
  }
  if (!outcome.ok) return { name, result: "failed", note: problem("testFailed", { name, reason: firstLine(outcome.blocked ?? outcome.detail) || String(outcome.status ?? "") }) };
  if (outcome.say === undefined) return { name, result: "failed", note: problem("testNoSay", { name }) };
  if (test.sayIncludes && !outcome.say.includes(test.sayIncludes)) return { name, result: "failed", say: outcome.say, note: problem("testSayMismatch", { name, expected: test.sayIncludes, say: outcome.say }) };
  if (before) {
    const changed = changedFiles(before, snapshotDirs(input.watchDirs), input.base);
    if (changed.length > 0) return { name, result: "failed", say: outcome.say, note: problem("testWrote", { name, files: changed.slice(0, 5).join(", ") + (changed.length > 5 ? ` (+${changed.length - 5})` : "") }) };
  }
  return { name, result: "passed", say: outcome.say };
}
