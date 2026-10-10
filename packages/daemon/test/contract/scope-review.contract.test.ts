// pi 契约测试：范围审视（规格第 10 节、Testing Decisions 切面 3，18 号票）。二狗依赖的 pi 行为：
// - 子进程里能在会话之外另开一次模型调用（审视用的模型，faux 扮演便宜模型）并拿到用量：守护进程要的审视（scope_review）
//   审视会话里的对话，结果报回；那次调用不进维护者的会话（会话的剧本也没被它吃掉）；
// - 压缩前钩子（session_before_compact）能拿到待压缩的消息：转成文本送审，结果 appendEntry 进会话（不进模型的上下文），
//   同时报给守护进程；
// - before_agent_start 能改系统提示：近期范围记录拼到系统提示末尾，守护进程用 scope_context 换成最新的。
import fs from "node:fs";
import { describe, expect, it } from "vitest";
import { SCOPE_REVIEW_ENTRY } from "../../src/runtime/index.ts";
import { defaultPromptLibrary } from "../../src/prompts/index.ts";
import { RECENT_SCOPE_RECORDS_TITLE, scopeReviewInstructions } from "../../src/scope-review/index.ts";
import { fauxModel, spawnTestAgent, startTestDaemon } from "../helpers/daemon.ts";

const SYSTEM_PROMPT = "你是测试用的维护者。";
/** 审视的说明：默认的那份（71 号票起在 prompts/scope-review.md） */
const SCOPE_REVIEW_INSTRUCTIONS = scopeReviewInstructions(defaultPromptLibrary());

/** 审视模型的回复：一条记录，说明里放着它这次收到的全部输入（核对审视的输入） */
const findingWithInput = (kind: "scope_change" | "out_of_scope", summary: string, extra: Record<string, string> = {}) =>
  ({ kind: "reply_with_context", text: `{"records":[{"kind":"${kind}","summary":"${summary}","detail":"{{context}}"${Object.entries(extra).map(([k, v]) => `,"${k}":"${v}"`).join("")}}]}` }) as const;

/** 守护进程写好的一段近期范围记录 */
const records = (line: string) => `## ${RECENT_SCOPE_RECORDS_TITLE}\n\n${line}`;

const textOf = (final: { message: { parts: Array<{ type: string; text?: string }> } }) => final.message.parts.map((p) => (p.type === "text" ? (p.text ?? "") : "")).join("\n");

/** 会话文件里的自定义条目（appendEntry 记下的） */
function customEntries(file: string, customType: string): unknown[] {
  return fs
    .readFileSync(file, "utf8")
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as { type: string; customType?: string; data?: unknown })
    .filter((e) => e.type === "custom" && e.customType === customType)
    .map((e) => e.data);
}

describe("pi 契约：范围审视", () => {
  it("子进程里能在会话之外另开一次模型调用审视这段对话：结果按约定的 JSON 报回，用量另报一条（scope_review）；那次调用不出现在维护者的会话里", async () => {
    const { daemon } = await startTestDaemon();
    const { agent, log } = spawnTestAgent(daemon, {
      agentId: "contract-scope-review",
      model: fauxModel([{ kind: "reply", text: "README 也顺手改了" }, { kind: "echo_context" }]),
      tools: [],
      systemPrompt: SYSTEM_PROMPT,
      scopeReview: {
        model: fauxModel([findingWithInput("out_of_scope", "改了立项书范围外的 README")]),
        instructions: "【审视说明】找出范围外的事",
        reference: "【对照物 v1】立项书：只做记账",
      },
    });
    await log.next("ready");
    agent.send({ type: "user_input", inputId: "in-1", text: "把记账的分类整理一下" });
    await log.next("turn_end");

    // 守护进程要审视（带最新的对照物）
    agent.send({ type: "scope_review", requestId: "rv-1", reference: "【对照物 v2】立项书：只做记账；计划：整理分类" });
    const result = await log.next("scope_review_result");
    // 结果带上会话里交给它的输入（输入标记里的 id）
    expect(result).toMatchObject({ requestId: "rv-1", findings: [{ kind: "out_of_scope", summary: "改了立项书范围外的 README" }], inputIds: ["in-1"] });
    expect(result.error).toBeUndefined();
    // 审视的输入：这段对话（用户说的、维护者回的）和守护进程给的最新对照物
    const input = result.findings[0]!.detail!;
    expect(input).toContain("把记账的分类整理一下");
    expect(input).toContain("README 也顺手改了");
    expect(input).toContain("【对照物 v2】立项书：只做记账；计划：整理分类");
    expect(input).not.toContain("【对照物 v1】");
    // 审视那次调用的系统提示是装配里守护进程给的审视说明
    expect(input).toContain("【审视说明】找出范围外的事");
    // 审视那次调用的用量：用途标成范围审视，模型是审视用的那个
    const usage = log.ofType("usage").find((u) => u.purpose === "scope_review");
    expect(usage).toMatchObject({ messageId: "scope-review-1", provider: "faux-review" });
    expect(usage!.output).toBeGreaterThan(0);
    // 结果作为副本记进了会话文件（不进模型的上下文）
    const ready = log.ofType("ready")[0]!;
    expect(customEntries(ready.sessionFile, SCOPE_REVIEW_ENTRY)).toEqual([{ requestId: "rv-1", findings: result.findings }]);

    // 维护者的会话里没有审视那次调用：下一轮看到的上下文里没有审视的提示和结果，会话的剧本接着走第二步
    agent.send({ type: "user_input", inputId: "in-2", text: "接着" });
    const seen = textOf(await log.next("message_final"));
    expect(seen).toContain("[user] 把记账的分类整理一下");
    expect(seen).toContain("[user] 接着");
    expect(seen).not.toContain("对照物");
    expect(seen).not.toContain("改了立项书范围外的 README");
  });

  it("审视模型的回复不是约定的 JSON：报回原因（error），findings 为空，子进程照常", async () => {
    const { daemon } = await startTestDaemon();
    const { agent, log } = spawnTestAgent(daemon, {
      agentId: "contract-scope-review-bad",
      model: fauxModel([{ kind: "reply", text: "好" }]),
      tools: [],
      scopeReview: { model: fauxModel([{ kind: "reply", text: "这段工作都在范围里，没什么要记的。" }]), instructions: SCOPE_REVIEW_INSTRUCTIONS, reference: "立项书" },
    });
    await log.next("ready");
    agent.send({ type: "user_input", inputId: "in-1", text: "做点事" });
    await log.next("turn_end");
    agent.send({ type: "scope_review", requestId: "rv-1", reference: "立项书" });
    const result = await log.next("scope_review_result");
    expect(result).toMatchObject({ requestId: "rv-1", findings: [] });
    expect(result.error).toContain("这段工作都在范围里");
  });

  it("压缩前钩子能拿到待压缩的消息：转成文本送审（留下的不送），结果 appendEntry 进会话、同时报回；压缩照常完成", async () => {
    const { daemon } = await startTestDaemon();
    const { agent, log } = spawnTestAgent(daemon, {
      agentId: "contract-scope-review-compaction",
      model: fauxModel([
        { kind: "reply", text: "好，先做 X" },
        { kind: "reply", text: "收到了一大段" },
        { kind: "reply", text: "好" },
        // 压缩时写摘要的那次模型调用
        { kind: "reply", text: "摘要：用户让先做 X，又发过一大段材料" },
        { kind: "echo_context" },
      ]),
      tools: [],
      systemPrompt: SYSTEM_PROMPT,
      scopeReview: {
        model: fauxModel([findingWithInput("scope_change", "按用户说的先做了 X", { basis: "用户说先帮我做下 X" })]),
        instructions: SCOPE_REVIEW_INSTRUCTIONS,
        reference: "【对照物】立项书：只做记账",
      },
    });
    await log.next("ready");
    // 开头一轮短的（压缩时写进摘要），然后很长的一轮（约 2.5 万 token，pi 留最近约 2 万 token：从它起留着），最后一轮短的
    agent.send({ type: "user_input", inputId: "in-0", text: "先帮我做下 X" });
    await log.next("turn_end");
    agent.send({ type: "user_input", inputId: "in-1", text: `材料：${"一段很长的材料。".repeat(12_500)}` });
    await log.next("turn_end");
    agent.send({ type: "user_input", inputId: "in-2", text: "第二句" });
    await log.next("turn_end");
    agent.send({ type: "compact" });

    const result = await log.next("scope_review_result");
    // 结果带上会话里交给它的输入（这时会话里的全部）
    expect(result).toMatchObject({ findings: [{ kind: "scope_change", summary: "按用户说的先做了 X", basis: "用户说先帮我做下 X" }], inputIds: ["in-0", "in-1", "in-2"] });
    expect(result.requestId).toBeUndefined();
    const input = result.findings[0]!.detail!;
    expect(input).toContain("先帮我做下 X");
    expect(input).toContain("【对照物】立项书：只做记账");
    expect(input).not.toContain("第二句");
    expect(log.ofType("usage").some((u) => u.purpose === "scope_review")).toBe(true);

    // 压缩照常完成：之后的上下文里是摘要和留下的那轮；审视的结果只在会话文件里（appendEntry），不进上下文
    agent.send({ type: "user_input", inputId: "in-3", text: "压缩之后" });
    const seen = textOf(await log.next("message_final"));
    expect(seen).toContain("摘要：用户让先做 X，又发过一大段材料");
    expect(seen).not.toContain("[user] 先帮我做下 X");
    expect(seen).toContain("[user] 第二句");
    expect(seen).not.toContain("按用户说的先做了 X");
    const file = log.ofType("ready")[0]!.sessionFile;
    expect(customEntries(file, SCOPE_REVIEW_ENTRY)).toEqual([{ findings: result.findings }]);
  });

  it("before_agent_start 能改系统提示：近期范围记录拼到系统提示末尾；scope_context 换成最新的之后，下一条输入看到的是新的", async () => {
    const { daemon } = await startTestDaemon();
    const { agent, log } = spawnTestAgent(daemon, {
      agentId: "contract-scope-records",
      model: fauxModel([{ kind: "echo_context" }, { kind: "echo_context" }, { kind: "echo_context" }]),
      tools: [],
      systemPrompt: SYSTEM_PROMPT,
      scopeReview: { model: fauxModel([]), instructions: SCOPE_REVIEW_INSTRUCTIONS, reference: "立项书", recentRecords: records("- 越界：改了 README") },
    });
    await log.next("ready");
    agent.send({ type: "user_input", inputId: "in-1", text: "第一句" });
    const first = textOf(await log.next("message_final"));
    await log.next("turn_end");
    const system1 = first.slice(0, first.indexOf("[user]"));
    expect(system1).toContain(`[system] ${SYSTEM_PROMPT}`);
    expect(system1.indexOf(records("- 越界：改了 README"))).toBeGreaterThan(system1.indexOf(SYSTEM_PROMPT));

    agent.send({ type: "scope_context", reference: "立项书", recentRecords: records("- 越界：改了 README\n- 范围变更：先做了 X") });
    agent.send({ type: "user_input", inputId: "in-2", text: "第二句" });
    const second = textOf(await log.next("message_final"));
    await log.next("turn_end");
    const system2 = second.slice(0, second.indexOf("[user]"));
    expect(system2).toContain(records("- 越界：改了 README\n- 范围变更：先做了 X"));
    // 不是一轮轮叠上去的：标题只出现一次
    expect(system2.split(RECENT_SCOPE_RECORDS_TITLE)).toHaveLength(2);

    // 没有记录了：系统提示回到原样
    agent.send({ type: "scope_context", reference: "立项书" });
    agent.send({ type: "user_input", inputId: "in-3", text: "第三句" });
    const third = textOf(await log.next("message_final"));
    expect(third.slice(0, third.indexOf("[user]"))).not.toContain(RECENT_SCOPE_RECORDS_TITLE);
  });
});
