// 主切面：斜杠候选的说明看得懂（310 号票）。真的守护进程走组合根和插件清单；Claude Code 插件经 extraPlugins 换成子进程接假 SDK 的那个
// （不启动真的 claude、不读 ~/.claude），翻译用 faux 剧本（不连真的模型）：
// - Claude Code 报回英文说明的命令：内置的（/compact、/review）直接给中文、原文留着、参数提示换成中文的；不在表里的（/deploy-notes）
//   第一次给原文、标 translating，二狗的模型翻好后缓存进数据目录，再取直接是译文；用量记成二狗的系统开销（purpose: translation）；
// - 模型出错：显示原文、不再标 translating；
// - 记忆管理员的会话（含了解你访谈）有 /interview、/consolidate（310 号票：命令一律英文）。
import fs from "node:fs";
import { HTTP_PATHS, maintainerChannel, MEMORY_CURATOR_CONVERSATION, type SlashCommandEntry, type SlashCommandList, type Task } from "@ergo/protocol";
import { describe, expect, it } from "vitest";
import { CLAUDE_CODE_RUNTIME_ID } from "../../src/claude-code/api.ts";
import { dataDirLayout } from "../../src/config/data-dir.ts";
import { startTestDaemon, type TestDaemon } from "../helpers/daemon.ts";
import { fakeSdkClaudeCodePlugin } from "../helpers/fake-claude-code.ts";
import { TestFrontend } from "../helpers/frontend.ts";
import { requestJson } from "../helpers/http.ts";
import { waitUntil } from "../helpers/process.ts";

const slashCommands = async (url: string, conversation: string) => (await requestJson<SlashCommandList>(url, HTTP_PATHS.slashCommands(conversation))).body.commands;
const byText = (list: readonly SlashCommandEntry[]) => Object.fromEntries(list.map((c) => [c.text, c]));
const taskNow = (td: TestDaemon, taskId: string): Task => td.daemon.tasks.get(taskId)!;

/** 起一个用 Claude Code 的任务、等它做完（Claude Code 报过命令）；返回维护者的会话 */
async function claudeTask(td: TestDaemon): Promise<string> {
  const frontend = await TestFrontend.connect(td.url);
  const started = await frontend.startTask("整理下载目录", undefined, undefined, "plain", undefined, { runtime: CLAUDE_CODE_RUNTIME_ID });
  expect(started.ok).toBe(true);
  const taskId = (started as { result: { taskId: string } }).result.taskId;
  await waitUntil(() => taskNow(td, taskId).state === "done", { timeoutMs: 30_000, describe: () => `等 ${taskId} 做完：${JSON.stringify(taskNow(td, taskId))}` });
  return maintainerChannel(taskNow(td, taskId).maintainerId);
}

/** 隔一会儿再取，直到没有在翻的 */
async function untilTranslated(url: string, conversation: string): Promise<SlashCommandEntry[]> {
  const deadline = Date.now() + 30_000;
  for (;;) {
    const list = await slashCommands(url, conversation);
    if (!list.some((c) => c.translating)) return list;
    if (Date.now() > deadline) throw new Error(`等翻译超时：${JSON.stringify(list)}`);
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
}

describe("斜杠候选的说明（310 号票）", () => {
  it("Claude Code 报回英文：内置的直接给中文，不在表里的翻好后缓存、再弹直接用缓存；记忆管理员的会话有 /interview、/consolidate", async () => {
    const td = await startTestDaemon({ extraPlugins: [fakeSdkClaudeCodePlugin], maintainer: [{ kind: "reply", text: "整理好了。" }], translator: [{ kind: "reply", text: "给当前分支写发布说明" }] });
    const channel = await claudeTask(td);

    const first = byText(await slashCommands(td.url, channel));
    expect(first["/compact"]).toEqual({
      kind: "runtime",
      text: "/compact",
      name: "compact",
      description: expect.stringMatching(/^压缩对话/),
      originalDescription: "Clear conversation history but keep a summary in context",
      argumentHint: "[摘要时要特别留意的]",
      collection: "Claude Code",
    });
    expect(first["/review"]).toMatchObject({ description: "评审一个拉取请求（PR）", originalDescription: "Review a pull request" });
    expect(first["/review"]).not.toHaveProperty("argumentHint");
    // 不在表里：先给原文，标着在翻
    expect(first["/deploy-notes"]).toEqual({
      kind: "runtime",
      text: "/deploy-notes",
      name: "deploy-notes",
      description: "Write release notes for the current branch",
      argumentHint: "[version]",
      collection: "Claude Code",
      translating: true,
    });

    const translated = byText(await untilTranslated(td.url, channel));
    expect(translated["/deploy-notes"]).toEqual({
      kind: "runtime",
      text: "/deploy-notes",
      name: "deploy-notes",
      description: "给当前分支写发布说明",
      originalDescription: "Write release notes for the current branch",
      argumentHint: "[version]",
      collection: "Claude Code",
    });
    // 缓存在数据目录的缓存区；再取还是译文（剧本只有一步：再翻就会出错显示原文）
    const cacheFile = dataDirLayout(td.dataDir).slashTranslationsFile;
    expect(fs.readFileSync(cacheFile, "utf8")).toContain("给当前分支写发布说明");
    expect(byText(await slashCommands(td.url, channel))["/deploy-notes"]).toMatchObject({ description: "给当前分支写发布说明" });
    // 用量记成二狗的系统开销
    const translations = td.daemon.ledger.entries(null).filter((e) => e.purpose === "translation");
    expect(translations).toHaveLength(1);
    expect(translations[0]).toMatchObject({ role: "secretary", agentId: "secretary", model: "faux" });

    // 记忆管理员（记忆插件在跑、访谈服务在）
    expect((await slashCommands(td.url, MEMORY_CURATOR_CONVERSATION)).map((c) => [c.text, c.argumentHint])).toEqual([
      ["/interview", "[主题]"],
      ["/consolidate", undefined],
    ]);
  }, 90_000);

  it("模型出错：不在表里的显示原文，不再标 translating；内置的照旧是中文", async () => {
    // 剧本是空的：一调用就出错
    const td = await startTestDaemon({ extraPlugins: [fakeSdkClaudeCodePlugin], maintainer: [{ kind: "reply", text: "整理好了。" }], translator: [] });
    const channel = await claudeTask(td);
    expect(byText(await slashCommands(td.url, channel))["/deploy-notes"]).toMatchObject({ translating: true });
    const after = byText(await untilTranslated(td.url, channel));
    expect(after["/deploy-notes"]).toEqual({
      kind: "runtime",
      text: "/deploy-notes",
      name: "deploy-notes",
      description: "Write release notes for the current branch",
      argumentHint: "[version]",
      collection: "Claude Code",
    });
    expect(after["/compact"]).toMatchObject({ description: expect.stringMatching(/^压缩对话/) });
  }, 90_000);
});
