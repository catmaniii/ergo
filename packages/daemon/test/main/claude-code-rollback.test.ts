// 主切面：Claude Code 会话的撤回和分支（293 号票，issue 24 第三节丙类）。真的守护进程走组合根和插件清单，清单里的 Claude Code 插件经 extraPlugins
// 换成子进程接假 SDK 的那个（helpers/fake-claude-code.ts：运行时、适配子进程、撤回的分叉和文件恢复都是真的代码；SDK 按 faux 剧本扮演 claude，
// 会话记录、forkSession、getSessionMessages、文件检查点是 helpers/fake-claude-sdk.ts 的 FakeClaudeStore），不启动真的 claude、不花额度、
// 不碰用户真实的 ~/.claude（守护进程的主目录是临时的）。测试扮演前端，项目「家庭网盘」的维护者用 Claude Code：
// - ↶ 撤回到"把照片目录整理一下"之前：对话从那条之前分叉出一个新的 Claude 会话接着用（下一轮 Claude 看到的主线里没有被放弃的那段、接着的是新会话），
//   那条之后 Claude 用 Write 写的文件按检查点恢复了（文件没了，分支摘要上记着恢复了哪个文件）；分支摘要是二狗用维护者的二狗模型（faux 扮演）
//   按自己记下的事件另起一次写的——写进时间线（新分支开头那条分支摘要）、记账（purpose: branch_summary）、交给了新会话的下一轮（钩子的 additionalContext）；
// - 切回废弃分支：接着撤回前的那个 Claude 会话（主线里又是被放弃的那段）；
// - 能力清单：撤回、切分支能做，分支摘要不是它自己写的，撤回时恢复文件。
import fs from "node:fs";
import path from "node:path";
import {
  type BranchSummaryPart,
  BRANCH_SUMMARY_INSTRUCTIONS,
  EVENT_TYPES,
  findBranch,
  HTTP_PATHS,
  maintainerChannel,
  type MessageEventPayload,
  type MessagePart,
  METHODS,
  type ResponseFrame,
  type RollbackPreview,
  type RollbackSessionResult,
  type SessionBranchEventPayload,
} from "@ergo/protocol";
import { describe, expect, it } from "vitest";
import { CLAUDE_CODE_RUNTIME_ID } from "../../src/claude-code/api.ts";
import { CLAUDE_CODE_CAPABILITIES } from "../../src/claude-code/runtime.ts";
import { dataDirLayout } from "../../src/config/data-dir.ts";
import { LEDGER_CHANNEL, TOKEN_USAGE_EVENT, type TokenUsagePayload } from "../../src/ledger/entry.ts";
import type { FauxStep } from "../../src/runtime/index.ts";
import { startTestDaemon, type TestDaemon } from "../helpers/daemon.ts";
import { fakeSdkClaudeCodePlugin } from "../helpers/fake-claude-code.ts";
import { FAKE_CLAUDE_STORE, type FakeClaudeEcho, FakeClaudeStore } from "../helpers/fake-claude-sdk.ts";
import { TestFrontend } from "../helpers/frontend.ts";
import { requestJson } from "../helpers/http.ts";
import { waitUntil } from "../helpers/process.ts";
import { seedProject } from "../helpers/projects.ts";
import { makeTempDir } from "../helpers/temp-dir.ts";

const PM = maintainerChannel("pm-1");
const SUMMARY = "摘要：整理了照片目录，写了一份照片索引，没有对外效果。";

const say = (text: string): FauxStep => ({ kind: "reply", text });
const call = (name: string, args: Record<string, unknown>): FauxStep => ({ kind: "reply", toolCalls: [{ name, arguments: args as never }] });
const echo: FauxStep = { kind: "echo_context" };

const messagesOf = (frontend: TestFrontend) => frontend.events({ channel: PM, type: EVENT_TYPES.message }).map((f) => f.payload as MessageEventPayload);
const textOf = (parts: readonly MessagePart[]) => parts.map((p) => ("text" in p ? p.text : "")).join("");
const turnEnds = (frontend: TestFrontend) => frontend.events({ channel: PM, type: EVENT_TYPES.turnEnd }).length;
const waitTurns = (frontend: TestFrontend, n: number) => waitUntil(() => turnEnds(frontend) >= n, { timeoutMs: 60_000, describe: () => `等维护者处理完 ${n} 条输入（现在 ${turnEnds(frontend)}）` });
/** 会话里最近一条 echo_context 的回显（agent 的回复是那段 JSON） */
const lastEcho = (frontend: TestFrontend): FakeClaudeEcho => {
  const text = messagesOf(frontend)
    .filter((m) => m.message.speaker === "agent")
    .map((m) => textOf(m.message.parts))
    .filter((t) => t.includes('"history"'))
    .at(-1);
  if (text === undefined) throw new Error("还没有 echo_context 的回显");
  return JSON.parse(text) as FakeClaudeEcho;
};
const latestBranchEvent = (frontend: TestFrontend) => frontend.events({ channel: PM, type: EVENT_TYPES.sessionBranch }).at(-1)?.payload as SessionBranchEventPayload | undefined;
const ok = <T>(r: ResponseFrame): T => {
  if (!r.ok) throw new Error(`请求失败：${r.error.code} ${r.error.message}`);
  return r.result as T;
};
/** 假 SDK 存在维护者会话目录里的会话记录（分叉、恢复过哪些） */
const storeOf = (td: TestDaemon) => FakeClaudeStore.load(path.join(dataDirLayout(td.dataDir).sessions, "pm-1", FAKE_CLAUDE_STORE));
const usageOf = (td: TestDaemon) => td.daemon.store.read(LEDGER_CHANNEL, 0, TOKEN_USAGE_EVENT).map((e) => e.payload as TokenUsagePayload);

describe("Claude Code 会话的撤回和分支（假 SDK）", () => {
  it("能力清单：撤回、切分支能做；分支摘要不是它自己写的（二狗写）；撤回时按文件检查点恢复文件", () => {
    expect(CLAUDE_CODE_CAPABILITIES).toMatchObject({ rollback: true, branch_switch: true, branch_summary: false, rewind_files: true });
  });

  it("撤回：对话从那条之前分叉出新会话接着、Write 写的文件恢复、二狗写的分支摘要进时间线和新会话；切回废弃分支接着撤回前的会话", async () => {
    const folder = makeTempDir("ergo-cc-rollback-");
    // 写真实路径（临时目录可能是 8.3 短名：守卫按写的路径和真实路径都核对）
    const index = path.join(fs.realpathSync.native(folder), "photos", "index.md");
    const td = await startTestDaemon({
      extraPlugins: [fakeSdkClaudeCodePlugin],
      // 第一步：Claude 那边是第一条输入的回复；二狗另起一次写分支摘要时（同一个模型、另一个子进程从头取）看到摘要要求，回摘要
      maintainer: (id) =>
        id === "pm-1"
          ? [
              { kind: "branch_on_context", contains: [BRANCH_SUMMARY_INSTRUCTIONS.slice(0, 10)], matched: say(SUMMARY), otherwise: say("网盘现在 2 TB，用了一半。") },
              call("Write", { file_path: index, content: "# 照片索引\n" }),
              say("照片目录整理好了。"),
              echo,
              echo,
            ]
          : [],
    });
    seedProject(td.daemon, "家庭网盘", {
      state: "in_use",
      charterConfirmed: true,
      kind: "other",
      runtime: CLAUDE_CODE_RUNTIME_ID,
      workdir: { external: true, path: folder },
      toolkit: { skills: [], mcp: [], bash: false, network: false },
    });
    const frontend = await TestFrontend.connect(td.url);
    await frontend.subscribe({ [PM]: 0 });

    await frontend.sendText("讲讲网盘现在的情况", { conversation: PM });
    await waitTurns(frontend, 1);
    const second = await frontend.sendText("把照片目录整理一下", { conversation: PM });
    await waitTurns(frontend, 2);
    expect(fs.readFileSync(index, "utf8")).toBe("# 照片索引\n");
    const before = storeOf(td);

    // 回退前的确认：这一段做了的事里有那次写文件（本机）
    const preview = (await requestJson<RollbackPreview>(td.url, HTTP_PATHS.rollbackPreview(PM, { messageId: second.messageId }))).body;
    expect(preview.effects.map((e) => [e.tool, e.scope])).toEqual([["write", "local"]]);

    const result = ok<RollbackSessionResult>(await frontend.request(METHODS.rollbackSession, { conversation: PM, before: { messageId: second.messageId } }, "k-rb"));
    expect(result.branchId).toBe("b1");

    // 代码：Write 写的文件按检查点恢复了（原来没有，撤回后没了）
    expect(fs.existsSync(index)).toBe(false);
    // 对话：从"把照片目录整理一下"之前（第一条回复那一条）分叉出一个新会话；会话树上新分支记着新会话、废弃分支记着撤回前的会话
    const after = storeOf(td);
    expect(after.forks).toHaveLength(1);
    const [fork] = after.forks;
    const branchEvent = latestBranchEvent(frontend)!;
    expect(branchEvent).toMatchObject({ change: "rollback", from: "b0", to: "b1" });
    expect(findBranch(branchEvent.branches, "b1")?.entry).toBe(fork!.to);
    expect(findBranch(branchEvent.branches, "b0")?.tip).toBe(fork!.from);
    expect(before.messages(fork!.from).find((m) => m.uuid === fork!.upTo)?.type).toBe("assistant");
    expect(after.rewinds.map((r) => [r.session, r.files])).toEqual([[fork!.from, [index]]]);

    // 分支摘要：二狗写的，写进时间线（新分支开头那一条），上面记着恢复了哪个文件；那次调用记账（purpose: branch_summary，记在维护者名下）
    const summary = messagesOf(frontend).find((m) => m.message.id === result.summaryMessageId)!;
    const part = summary.message.parts.find((p): p is BranchSummaryPart => p.type === "branch_summary")!;
    expect(part).toMatchObject({ branchId: "b1", summary: SUMMARY, files: { restored: [index] } });
    expect(usageOf(td).filter((u) => u.purpose === "branch_summary").map((u) => u.agentId)).toEqual(["pm-1"]);

    // 下一轮：接着新会话，Claude 看到的主线到第一条回复为止（被放弃的那段不在了），分支摘要随这条输入的钩子进了上下文
    await frontend.sendText("照片目录多大", { conversation: PM });
    await waitTurns(frontend, 3);
    const rolled = lastEcho(frontend);
    expect(rolled.options.resume).toBe(fork!.to);
    expect(rolled.history.join("\n")).toContain("讲讲网盘现在的情况");
    expect(rolled.history.join("\n")).toContain("网盘现在 2 TB，用了一半。");
    expect(rolled.history.join("\n")).not.toContain("把照片目录整理一下");
    expect(rolled.hookContext).toContain(SUMMARY);
    expect(rolled.hookContext).toContain("summary of a branch");

    // 切回废弃分支：接着撤回前的会话，主线里又是被放弃的那段；不写摘要、不动文件
    ok(await frontend.request(METHODS.switchBranch, { conversation: PM, branchId: "b0" }, "k-switch"));
    expect(latestBranchEvent(frontend)).toMatchObject({ change: "switch", from: "b1", to: "b0" });
    expect(findBranch(latestBranchEvent(frontend)!.branches, "b1")?.tip).toBe(fork!.to);
    await frontend.sendText("接着刚才的", { conversation: PM });
    await waitTurns(frontend, 4);
    const switched = lastEcho(frontend);
    expect(switched.options.resume).toBe(fork!.from);
    expect(switched.history.join("\n")).toContain("把照片目录整理一下");
    expect(switched.history.join("\n")).toContain("照片目录整理好了。");
    expect(switched.hookContext).not.toContain(SUMMARY);
    expect(storeOf(td).forks).toHaveLength(1);
    expect(usageOf(td).filter((u) => u.purpose === "branch_summary")).toHaveLength(1);
  }, 120_000);
});
