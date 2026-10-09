// 主切面（70 号票）：先把功能跑通——秘书能联网、配上联网搜索和读网页；对话里的"先问我"靠一个开关（guard.conversationApprovals，
// 正式默认关着）。真的守护进程，秘书接 faux 剧本，联网搜索、读网页是假的（不起浏览器、不连真网络），测试扮演前端。
// - 联网工具：工具调用记录照常（参数摘要是查询词、网址，不落入关注类别，直接做），详情页取得到中文名、完整参数和返回、
//   读网页的效果记录里有网址；
// - 对话审批关着：读草稿区外的文件、bash 里碰草稿区外的路径直接做，照常标关注类别、进效果日志，不出审批卡；开着时同一次调用照原样出审批卡；
// - 关着也照旧：受保护区域写入永不、密钥区连读都拒绝；牵涉密钥和受保护区域、判断不了的（要写的路径没法确定、读过路径不明的
//   文件之后往外送）照旧出审批卡（评审后定）。
import fs from "node:fs";
import path from "node:path";
import { CHANNELS, EVENT_TYPES, type MessageEventPayload, type MessagePart } from "@ergou/protocol";
import { describe, expect, it } from "vitest";
import { dataDirLayout } from "../../src/config/data-dir.ts";
import { listEffects } from "../../src/guard-runtime/effect-log.ts";
import type { FauxStep } from "../../src/runtime/index.ts";
import { SECRETARY_SEGMENT_ID } from "../../src/secretary/secretary.ts";
import { realPathOf } from "../../src/util/real-path.ts";
import { type StartTestDaemonOptions, startTestDaemon } from "../helpers/daemon.ts";
import { TestFrontend } from "../helpers/frontend.ts";
import { toolCallDetail } from "../helpers/http.ts";
import { makeTempDir } from "../helpers/temp-dir.ts";
import { fakeWebAccess } from "../helpers/web.ts";

const { secretary: SECRETARY, cards: CARDS, inbox: INBOX } = CHANNELS;
type ToolCallPart = Extract<MessagePart, { type: "tool_call" }>;

const call = (name: string, args: Record<string, unknown>): FauxStep => ({ kind: "reply", toolCalls: [{ name, arguments: args as never }] });
const fwd = (p: string) => p.replaceAll("\\", "/");

async function setup(options: StartTestDaemonOptions) {
  const test = await startTestDaemon(options);
  const frontend = await TestFrontend.connect(test.url);
  await frontend.subscribe({ [SECRETARY]: 0, [CARDS]: 0, [INBOX]: 0 });
  return { ...test, frontend, layout: dataDirLayout(realPathOf(test.dataDir)!) };
}

async function tell(frontend: TestFrontend, text: string) {
  await frontend.sendText(text);
  await frontend.next(SECRETARY, EVENT_TYPES.turnEnd);
}

const toolPartsOf = (frontend: TestFrontend): ToolCallPart[] =>
  frontend
    .events({ channel: SECRETARY, type: EVENT_TYPES.message })
    .map((f) => (f.payload as MessageEventPayload).message)
    .flatMap((m) => m.parts.filter((p): p is ToolCallPart => p.type === "tool_call"));
const lastEcho = (frontend: TestFrontend): string =>
  frontend
    .events({ channel: SECRETARY, type: EVENT_TYPES.message })
    .map((f) => (f.payload as MessageEventPayload).message)
    .at(-1)!
    .parts.map((p) => (p.type === "text" ? p.text : ""))
    .join("");

/** 对话审批的开关写进配置（测试底座默认开着，见 helpers/daemon.ts 的 TEST_GUARD_CONFIG） */
const approvals = (value: "off" | "on", extra: Record<string, unknown> = {}) => ({ guard: { conversationApprovals: value }, ...extra });

describe("秘书的联网搜索、读网页（假的实现）", () => {
  it("工具调用记录照常、直接做；详情页有中文名、完整参数和返回；读网页的效果记录里有网址", async () => {
    const web = fakeWebAccess({
      search: () => ({
        engine: "ddg",
        results: [
          { title: "二狗 天气 一", url: "https://a.example/1", snippet: "晴" },
          { title: "二狗 天气 二", url: "https://b.example/2", snippet: "多云" },
        ],
      }),
      fetch: (r) => ({ text: `URL: ${r.url}\n标题: 天气\n\n今天晴，25 度`, via: "direct" }),
    });
    const { frontend, daemon, url } = await setup({
      secretary: [call("web_search", { query: "二狗 天气", n: 2 }), call("web_fetch", { url: "https://a.example/1" }), { kind: "echo_context" }],
      webAccess: web,
      config: approvals("off"),
    });
    await tell(frontend, "查一下天气");

    const [search, fetchPart] = toolPartsOf(frontend);
    expect(search).toMatchObject({ tool: "web_search", argsSummary: "二狗 天气", categoryTitles: [], disposition: "do", genericBash: false, outcome: "done" });
    expect(search!.resultSummary).toMatch(/^搜索: 二狗 天气 （2 条） 1\. 二狗 天气 一/);
    expect(fetchPart).toMatchObject({ tool: "web_fetch", argsSummary: "https://a.example/1", categoryTitles: [], disposition: "do", outcome: "done" });
    expect(web.searches).toEqual([{ query: "二狗 天气", n: 2 }]);
    expect(web.fetches).toEqual([{ url: "https://a.example/1", max: 8000 }]);
    const seen = lastEcho(frontend);
    expect(seen).toContain("[toolResult] web_search: 搜索: 二狗 天气 （2 条）");
    expect(seen).toContain("今天晴，25 度");
    expect(frontend.events({ channel: CARDS })).toEqual([]);

    const searchDetail = await toolCallDetail(url, search!.callId);
    expect(searchDetail.status).toBe(200);
    expect(searchDetail.body).toMatchObject({ tool: "web_search", toolTitle: "联网搜索", args: { query: "二狗 天气", n: 2 }, outcome: "done", isError: false });
    expect(searchDetail.body.result).toContain("https://b.example/2");
    const fetchDetail = await toolCallDetail(url, fetchPart!.callId);
    expect(fetchDetail.body).toMatchObject({ tool: "web_fetch", toolTitle: "读网页", result: "URL: https://a.example/1\n标题: 天气\n\n今天晴，25 度" });
    expect(fetchDetail.body.effects).toEqual([expect.objectContaining({ tool: "web_fetch", toolTitle: "读网页", objects: [{ kind: "url", value: "https://a.example/1" }] })]);

    // 只看：进效果日志（规范化后的参数），被杀后能直接重做（不记有副作用的执行记录）
    const effects = listEffects(daemon.store.reader, { agentId: "secretary", segmentId: SECRETARY_SEGMENT_ID, taskId: null });
    expect(effects.map((e) => [e.tool, e.args])).toEqual([
      ["web_search", { query: "二狗 天气", n: 2 }],
      ["web_fetch", { url: "https://a.example/1" }],
    ]);
  });

  it("搜不到、读不到：按出错交回模型，说清楚怎么办（默认的假实现一律\"测试里不联网\"）", async () => {
    const { frontend } = await setup({ secretary: [call("web_search", { query: "x" }), call("web_fetch", { url: "https://example.com" }), { kind: "echo_context" }] });
    await tell(frontend, "查一下");
    expect(toolPartsOf(frontend).map((p) => [p.tool, p.outcome])).toEqual([
      ["web_search", "error"],
      ["web_fetch", "error"],
    ]);
    const seen = lastEcho(frontend);
    expect(seen).toContain("没搜到「x」（ddg：测试里不联网）。换更短、更通用的关键词再试");
    expect(seen).toContain("没读到 https://example.com：测试里不联网");
  });
});

describe("对话审批的开关", () => {
  it("关着：读草稿区外的文件、bash 里碰草稿区外的路径直接做，照常标关注类别、进效果日志；不出审批卡", async () => {
    const outside = realPathOf(makeTempDir("ergou-outside-"))!;
    fs.writeFileSync(path.join(outside, "notes.txt"), "外面的笔记");
    const { frontend, daemon } = await setup({
      secretary: [call("read", { path: path.join(outside, "notes.txt") }), call("bash", { command: `cat "${fwd(path.join(outside, "notes.txt"))}"` }), { kind: "echo_context" }],
      config: approvals("off"),
    });
    await tell(frontend, "看看那份笔记");
    expect(toolPartsOf(frontend).map((p) => [p.tool, p.categoryTitles, p.disposition, p.blockedBy ?? null, p.outcome])).toEqual([
      ["read", ["越出项目目录"], "do", null, "done"],
      ["bash", ["越出项目目录"], "do", null, "done"],
    ]);
    expect(lastEcho(frontend)).toContain("[toolResult] read: 外面的笔记");
    expect(frontend.events({ channel: CARDS })).toEqual([]);
    expect(daemon.approvals.list()).toEqual([]);
    expect(listEffects(daemon.store.reader, { agentId: "secretary", segmentId: SECRETARY_SEGMENT_ID, taskId: null }).map((e) => e.tool)).toEqual(["read", "read"]);
  });

  it("开着：同一次调用照原样提交审批、出审批卡（等不到批准就挂起）", async () => {
    const outside = realPathOf(makeTempDir("ergou-outside-"))!;
    fs.writeFileSync(path.join(outside, "notes.txt"), "外面的笔记");
    const { frontend, daemon } = await setup({
      secretary: [call("read", { path: path.join(outside, "notes.txt") }), { kind: "echo_context" }],
      // 等审批只等一小会儿就挂起，这一轮好结束
      config: approvals("on", { approvals: { waitMinutes: 0.02 } }),
    });
    await tell(frontend, "看看那份笔记");
    const [part] = toolPartsOf(frontend);
    expect(part).toMatchObject({ tool: "read", categoryTitles: ["越出项目目录"], disposition: "ask_first", outcome: "blocked" });
    expect(daemon.approvals.list().map((a) => a.status)).toEqual(["pending"]);
    expect(frontend.events({ channel: CARDS }).length).toBeGreaterThan(0);
    expect(lastEcho(frontend)).not.toContain("外面的笔记");
  });

  it("关着也照旧：受保护区域写入永不，密钥区连读都拒绝，不出审批卡", async () => {
    const programDir = realPathOf(makeTempDir("ergou-program-"))!;
    const dataDir = makeTempDir("ergou-data-");
    const layout = dataDirLayout(realPathOf(dataDir)!);
    fs.mkdirSync(layout.secrets, { recursive: true });
    fs.writeFileSync(path.join(layout.secrets, "deepseek-api-key.txt"), "sk-secret-in-secrets-area");
    const { frontend } = await setup({
      reuse: { dataDir, homeDir: makeTempDir("ergou-home-") },
      programDir,
      secretary: [
        call("read", { path: path.join(layout.secrets, "deepseek-api-key.txt") }),
        call("write", { path: path.join(layout.db, "x.db"), content: "x" }),
        call("bash", { command: `echo '{}' > "${fwd(path.join(layout.config, "watch-categories.json"))}"` }),
        call("bash", { command: `echo x > "${fwd(path.join(programDir, "x.txt"))}"` }),
        { kind: "echo_context" },
      ],
      config: approvals("off"),
    });
    await tell(frontend, "动一动受保护的地方");
    expect(toolPartsOf(frontend).map((p) => [p.tool, p.blockedBy ?? null, p.disposition, p.outcome])).toEqual([
      ["read", "hard_refusal", "do", "blocked"],
      ["write", "hard_refusal", "never", "blocked"],
      ["bash", null, "never", "blocked"],
      ["bash", null, "never", "blocked"],
    ]);
    expect(lastEcho(frontend)).not.toContain("sk-secret-in-secrets-area");
    expect(fs.existsSync(path.join(layout.config, "watch-categories.json"))).toBe(false);
    expect(fs.existsSync(path.join(layout.db, "x.db"))).toBe(false);
    expect(fs.existsSync(path.join(programDir, "x.txt"))).toBe(false);
    expect(frontend.events({ channel: CARDS })).toEqual([]);
  });

  it("关着也照旧先问（评审后定）：要写的路径没法确定、读过路径不明的文件之后往外送，出审批卡、不执行", async () => {
    const { frontend, daemon } = await setup({
      secretary: [
        // 写进去的目标是环境里的变量拼出来的：可能是配置区
        call("bash", { command: 'cp a.json "$ERGOU_CONFIG/ergou.json"' }),
        // 先读一个路径不明的文件（直接做），再往外发（本机没人监听的端口：真执行了也连不上）
        call("bash", { command: 'echo x > notes.txt && cat "$(echo notes.txt)"' }),
        call("bash", { command: "curl -s -X POST -d a=1 http://127.0.0.1:1/" }),
        { kind: "echo_context" },
      ],
      config: approvals("off", { approvals: { waitMinutes: 0.02 } }),
    });
    await tell(frontend, "改一下配置，再把笔记发出去");
    expect(toolPartsOf(frontend).map((p) => [p.tool, p.disposition, p.outcome])).toEqual([
      ["bash", "ask_first", "blocked"],
      ["bash", "do", "done"],
      ["bash", "ask_first", "blocked"],
    ]);
    expect(daemon.approvals.list().map((a) => a.status)).toEqual(["pending", "pending"]);
    expect(frontend.events({ channel: CARDS }).length).toBeGreaterThan(0);
  });
});
