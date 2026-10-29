// pi 契约：按二狗自己的事件记录另起一次生成（293 号票，一次性子进程 agent-child/recorded-generation-main.ts）。真的拉起子进程，模型接 faux：
// - 给被放弃的那段写分支摘要：二狗记下的会话（用户的话、回复、工具调用和结果、之前的分支摘要）摆成 pi 的会话条目（工具结果 pi 写分支摘要时不带），用 pi 撤回时同一个
//   generateBranchSummary——模型看到的是 pi 的分支摘要提示，会话转成 pi 的文字写法，摘要要求接在后面；交回给人看的摘要（不带 pi 的
//   开头和文件清单）、进新分支上下文的那段（pi 放进上下文的样子，带上改过的文件）、那次调用的用量（purpose: branch_summary）；
// - 模型出错时抛出原因（凭据的内容去掉）；没有可写的不调用模型。
import { describe, expect, it } from "vitest";
import { buildChildEnv } from "../../src/process/child-env.ts";
import { type RecordedGenerationRequest, type RecordedTurn, runRecordedGeneration } from "../../src/runtime/index.ts";
import { fauxModel } from "../helpers/daemon.ts";

const TURNS: RecordedTurn[] = [
  { role: "user", text: "把照片目录整理一下" },
  { role: "assistant", text: "我先建一个索引。", thinking: "看看目录结构", calls: [{ id: "c-1", tool: "write", args: { file_path: "D:/photos/index.md", path: "D:/photos/index.md", content: "# 照片" } }] },
  { role: "tool_result", callId: "c-1", tool: "write", text: "写好了", isError: false },
  { role: "branch_summary", text: "更早撤回过一次：试过按年份分" },
];

const request = (script: Parameters<typeof fauxModel>[0], turns: RecordedTurn[] = TURNS): RecordedGenerationRequest => ({
  task: { kind: "branch_summary", instructions: "用中文写 3~5 行：测试的要求" },
  model: fauxModel(script),
  credentials: {},
  turns,
  usageId: "branch-summary-b1",
});

const run = (r: RecordedGenerationRequest) => runRecordedGeneration(r, { env: buildChildEnv(process.env), timeoutMs: 25_000 });

describe("pi 契约：按二狗的事件记录另起一次生成（293 号票）", () => {
  it("写分支摘要：pi 的提示和会话写法、摘要要求接在后面；交回给人看的、进上下文的、用量", async () => {
    // 回复里带上看到的上下文：核对模型看到的输入
    const result = await run(request([{ kind: "reply_with_context", text: "摘要：建了照片索引。\n\n看到的：{{context}}" }]));
    if (result.kind !== "branch_summary") throw new Error(`不是分支摘要：${result.kind}`);
    expect(result.text.startsWith("摘要：建了照片索引。")).toBe(true);
    // 会话按 pi 的写法转成文字：用户的话、思考、回复、工具调用（参数）、之前的分支摘要；工具结果 pi 写分支摘要时本来就不带（看调用就够）
    expect(result.text).toContain("[User]: 把照片目录整理一下");
    expect(result.text).toContain("[Assistant thinking]: 看看目录结构");
    expect(result.text).toContain("[Assistant]: 我先建一个索引。");
    expect(result.text).toContain('[Assistant tool calls]: write(file_path=\\"D:/photos/index.md\\"');
    expect(result.text).not.toContain("写好了");
    expect(result.text).toContain("更早撤回过一次");
    expect(result.text).toContain("Additional focus: 用中文写 3~5 行：测试的要求");
    // 给人看的不带 pi 加的开头、文件清单；进上下文的是 pi 放进新分支的样子（开头那句、改过的文件）
    expect(result.text).not.toContain("The user explored a different conversation branch");
    expect(result.context).toContain("summary of a branch that this conversation came back from");
    expect(result.context).toContain("摘要：建了照片索引。");
    expect(result.context).toContain("D:/photos/index.md");
    expect(result.usage).toMatchObject({ type: "usage", messageId: "branch-summary-b1", purpose: "branch_summary" });
  }, 30_000);

  it("模型出错抛出原因；没有可写的不调用模型", async () => {
    await expect(run(request([{ kind: "context_overflow" }]))).rejects.toThrow("写分支摘要出错");
    const empty = await run(request([], []));
    expect(empty).toEqual({ kind: "branch_summary", text: "", context: "" });
  }, 30_000);
});

const reviewRequest = (script: Parameters<typeof fauxModel>[0], turns: RecordedTurn[] = TURNS): RecordedGenerationRequest => ({
  task: { kind: "scope_review", instructions: "你是二狗的范围审视员（测试）", reference: "立项书：只整理照片" },
  model: fauxModel(script),
  credentials: {},
  turns,
  usageId: "scope-review-pm-1-1",
});

describe("pi 契约：按二狗的事件记录另起一次范围审视（309 号票）", () => {
  it("审视：pi 子进程里审视的同一套——审视的说明作系统提示，对照物在前、按 pi 的写法转成文字的工作记录在后（之前的分支摘要不算）；回复按约定的 JSON 解析，用量 purpose 是 scope_review", async () => {
    const reply = JSON.stringify({ records: [{ kind: "out_of_scope", summary: "建了索引", detail: "@@" }, { kind: "bogus", summary: "不认得的种类不记" }] }).replace('"@@"', '"看到的：{{context}}"');
    const result = await run(reviewRequest([{ kind: "reply_with_context", text: reply }]));
    if (result.kind !== "scope_review") throw new Error(`不是范围审视：${result.kind}`);
    expect(result.error).toBeUndefined();
    expect(result.findings).toHaveLength(1);
    const [finding] = result.findings;
    expect(finding).toMatchObject({ kind: "out_of_scope", summary: "建了索引" });
    expect(finding!.detail).toContain("[system] 你是二狗的范围审视员（测试）");
    expect(finding!.detail).toContain("<scope-reference>\n立项书：只整理照片\n</scope-reference>");
    expect(finding!.detail).toContain("[User]: 把照片目录整理一下");
    expect(finding!.detail).toContain("[Assistant]: 我先建一个索引。");
    expect(finding!.detail).toContain("[Tool result]: 写好了");
    expect(finding!.detail).not.toContain("更早撤回过一次");
    expect(result.usage).toMatchObject({ type: "usage", messageId: "scope-review-pm-1-1", purpose: "scope_review" });
  }, 30_000);

  it("回复不合约定、模型出错：不抛，结果里写原因（调用过的照样带用量）；没有要审视的不调用模型", async () => {
    const bad = await run(reviewRequest([{ kind: "reply", text: "都在范围之内" }]));
    expect(bad).toMatchObject({ kind: "scope_review", findings: [], error: expect.stringContaining("没有约定的 JSON"), usage: { purpose: "scope_review" } });
    const failed = await run(reviewRequest([{ kind: "context_overflow" }]));
    expect(failed).toMatchObject({ kind: "scope_review", findings: [], error: expect.stringContaining("审视的模型调用没成") });
    const empty = await run(reviewRequest([], [{ role: "branch_summary", text: "只有之前的分支摘要" }]));
    expect(empty).toEqual({ kind: "scope_review", findings: [] });
  }, 30_000);
});
