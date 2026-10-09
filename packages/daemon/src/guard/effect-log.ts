// 效果日志的记录（规格第 9 节）：只有执行成功的调用才追加。时序规则和授权项计次都只看它。
//
// 内容类的参数不存原文（68 号票）：注册表里标了 bulk 的参数（写入的全文、编辑的新旧片段）换成"长度 + 摘要哈希"
// （`{"$digest": {length, sha256}}`，数组参数每一项各换一个）。别的参数照原样留：路径、命令、远端和分支、收件人、网址这类对象，
// 能判断结果的字段，提交说明，以及对外发送的内容（"不重复发"比的就是它，会联网的工具都不标 bulk）。缩过之后：
// - 时序规则：规则校验不许 $prior 读它（rule-validation.ts），规划时就会发现；执行时读到它的那几步一律算判断不了
//   （temporal-rules.ts 的 checkRule，先问用户，不能当成满足）；
// - 授权项计次按哈希比（grants.ts）：哈希的原文和对象范围的写法一样（scopeValueText），比哈希和比原文结果相同；
// - 详情页的效果只认路径、收件人、网址，另外注明写了多少（guard-runtime/effect-log.ts 的 contentNote）。
// 缩过的值的样子见 content-digest.ts。
import { digestOfText, isDigested, scopeValueText } from "./content-digest.ts";
import { toJson } from "./planguard/expr.ts";
import { normalizeArgs } from "./rule-steps.ts";
import { findTool, type ToolRegistry } from "./tool-registry.ts";
import { attributedTask, type EffectRecord, type GuardInput, type GuardJudgement, type JudgedCall } from "./types.ts";

/**
 * 一次判定放行、执行成功之后，要追加进效果日志的记录。
 * 真实工具调用记它自己；通用 bash 记拆出来的每条伪工具调用。参数是规范化之后、能直接存成 JSON 的形式
 * （推送补上当时的 headCommit）。被拦下或执行失败的调用不追加——由调用方（07 号票的运行时）保证只在执行成功后调用。
 * 内容类的参数还是原文：调用方脱敏（读过的密钥值）之后再用 effectLogArgs 缩，哈希不按密钥原值算
 */
export function effectRecordsFor(
  input: Pick<GuardInput, "agent" | "task" | "segmentId" | "tools" | "places" | "facts">,
  judgement: Pick<GuardJudgement, "calls">,
  options: { firstSeq: number; at: number; summary?: (call: JudgedCall) => string },
): EffectRecord[] {
  const env = { cwd: input.agent.cwd, homeDir: input.places.homeDir };
  const task = attributedTask(input.task);
  return judgement.calls.map((call, i) => ({
    seq: options.firstSeq + i,
    taskId: task?.taskId ?? null,
    stageId: task?.currentStageId ?? null,
    agentId: input.agent.agentId,
    ...(input.segmentId !== undefined ? { segmentId: input.segmentId } : {}),
    tool: call.tool,
    args: toJson(normalizeArgs(call.tool, call.args, input.tools, env, input.facts)) as Record<string, unknown>,
    summary: options.summary?.(call) ?? call.text ?? findTool(input.tools, call.tool)?.title ?? call.tool,
    at: options.at,
    ...(call.unseenInput ? { unseenInput: true } : {}),
  }));
}

// ───────────────────────── 内容类参数只记长度和摘要哈希（68 号票） ─────────────────────────

/**
 * 效果日志里存的参数：标了 bulk 的参数换成长度 + 摘要哈希（数组每一项各换一个，已经缩过的不再动），别的照原样。
 * 哈希的原文是授权项对象范围里的写法（scopeValueText：字符串照原样，别的按 JSON），计次时按它比。
 * 幂等：缩过的再缩一遍不变（派生视图归并旧记录、整体重放都用它）。不改动传入的对象
 */
export function effectLogArgs(tool: string, args: Readonly<Record<string, unknown>>, tools: ToolRegistry): Record<string, unknown> {
  const descriptor = findTool(tools, tool);
  const out: Record<string, unknown> = { ...args };
  for (const [name, rule] of Object.entries(descriptor?.args ?? {})) {
    if (!rule.bulk || !Object.hasOwn(args, name)) continue;
    const value = args[name];
    if (value === undefined || value === null) continue;
    out[name] = Array.isArray(value) ? value.map(digestOnce) : digestOnce(value);
  }
  return out;
}

const digestOnce = (value: unknown): unknown => (isDigested(value) ? value : digestOfText(scopeValueText(value)));

/** 规则引擎里"未知"的原话：缩过的内容读不到原文 */
export const DIGESTED_UNKNOWN = "（效果日志里只记了长度和摘要哈希，读不到原文）";

/** 给时序规则看的参数：缩过的值换成"未知"（JSON 的样子，fromJson 之后是 Unknown），别的照原样。读没读到它另外记（checkRule） */
export function digestsAsUnknown(args: Readonly<Record<string, unknown>>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(args).map(([name, v]) => [name, Array.isArray(v) ? v.map(unknownIfDigested) : unknownIfDigested(v)]));
}

const unknownIfDigested = (v: unknown): unknown => (isDigested(v) ? { $unknown: DIGESTED_UNKNOWN } : v);
