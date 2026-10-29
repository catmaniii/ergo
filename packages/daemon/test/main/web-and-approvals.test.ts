// 主切面（70 号票）：先把功能跑通——秘书能联网、配上联网搜索和读网页；对话里的"先问我"靠一个开关（guard.conversationApprovals，
// 正式默认关着；101 号票改了关着时秘书的范围）。真的守护进程，秘书接 faux 剧本，联网搜索、读网页是假的（不起浏览器、不连真网络），
// 测试扮演前端。
// - 联网工具：工具调用记录照常（参数摘要是查询词、网址，不落入关注类别，直接做），详情页取得到中文名、完整参数和返回、
//   读网页的效果记录里有网址；
// - 对话审批关着：读草稿区外的文件、bash 里碰草稿区外的路径直接做，照常标关注类别、进效果日志，不出审批卡；开着时同一次调用照原样出审批卡；
// - 关着时判断不了的（没写着数据目录的内联脚本、读路径不明的文件）也直接做、照常标出（101 号票；要写的路径没法确定的照旧问，评审后定）；
// - 关着时秘书特别敏感的照旧出审批卡、批了才做（101 号票）：以我的名义对外发送、删草稿区外的文件、覆盖路径没法确定的文件
//   （可能在草稿区外）、文件工具写草稿区外（原来硬拒绝）；可能碰到硬底线的（跑写着配置区路径的脚本）也照旧问；发往本机的 POST
//   不算对外（评审后定）；
// - 关着也照旧：受保护区域写入永不、密钥区连读都拒绝。
import fs from "node:fs";
import path from "node:path";
import { type ApprovalCardPayload, type Card, type CardEventPayload, CHANNELS, EVENT_TYPES, type MessageEventPayload, type MessagePart } from "@ergo/protocol";
import { describe, expect, it } from "vitest";
import { dataDirLayout } from "../../src/config/data-dir.ts";
import { listEffects } from "../../src/guard-runtime/effect-log.ts";
import type { FauxStep } from "../../src/runtime/index.ts";
import { SECRETARY_SEGMENT_ID } from "../../src/secretary/secretary.ts";
import { realPathOf } from "../../src/util/real-path.ts";
import { type StartTestDaemonOptions, startTestDaemon } from "../helpers/daemon.ts";
import { TestFrontend } from "../helpers/frontend.ts";
import { toolCallDetail } from "../helpers/http.ts";
import { waitUntil } from "../helpers/process.ts";
import { makeTempDir } from "../helpers/temp-dir.ts";
import { fakeWebAccess } from "../helpers/web.ts";
import { fakeSecret } from "../helpers/fake-secrets.ts";

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

/** 每张卡片的最新版本 */
const latestCards = (frontend: TestFrontend): Card[] => [
  ...new Map(frontend.events({ channel: CARDS, type: EVENT_TYPES.card }).map((f) => [(f.payload as CardEventPayload).card.id, (f.payload as CardEventPayload).card])).values(),
];
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
    expect(search!.resultSummary).toMatch(/^搜索: 二狗 天气 （浏览器 ddg，2 条） 1\. 二狗 天气 一/);
    expect(fetchPart).toMatchObject({ tool: "web_fetch", argsSummary: "https://a.example/1", categoryTitles: [], disposition: "do", outcome: "done" });
    // 秘书有 bash：联网工具交给实现"这个 agent 能用 agent-browser"（162 号票）；秘书有 browse_* 工具，交给实现这一轮（秘书页签里发的）用不了内置浏览器（182 号票）
    expect(web.searches).toEqual([{ query: "二狗 天气", n: 2, agentBrowser: true, appBrowser: false }]);
    expect(web.fetches).toEqual([{ url: "https://a.example/1", max: 8000, agentBrowser: true, appBrowser: false }]);
    const seen = lastEcho(frontend);
    expect(seen).toContain("[toolResult] web_search: 搜索: 二狗 天气 （浏览器 ddg，2 条）");
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
    const outside = realPathOf(makeTempDir("ergo-outside-"))!;
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
    const outside = realPathOf(makeTempDir("ergo-outside-"))!;
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
    const programDir = realPathOf(makeTempDir("ergo-program-"))!;
    const dataDir = makeTempDir("ergo-data-");
    const layout = dataDirLayout(realPathOf(dataDir)!);
    fs.mkdirSync(layout.secrets, { recursive: true });
    fs.writeFileSync(path.join(layout.secrets, "deepseek-api-key.txt"), fakeSecret("sk-", "secret-in-secrets-area"));
    const { frontend } = await setup({
      reuse: { dataDir, homeDir: makeTempDir("ergo-home-") },
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
    // 文件工具写草稿区外关着时不再是硬拒绝（101 号票），写进数据库区照旧永不
    expect(toolPartsOf(frontend).map((p) => [p.tool, p.blockedBy ?? null, p.disposition, p.outcome])).toEqual([
      ["read", "hard_refusal", "do", "blocked"],
      ["write", null, "never", "blocked"],
      ["bash", null, "never", "blocked"],
      ["bash", null, "never", "blocked"],
    ]);
    expect(lastEcho(frontend)).not.toContain(fakeSecret("sk-", "secret-in-secrets-area"));
    expect(fs.existsSync(path.join(layout.config, "watch-categories.json"))).toBe(false);
    expect(fs.existsSync(path.join(layout.db, "x.db"))).toBe(false);
    expect(fs.existsSync(path.join(programDir, "x.txt"))).toBe(false);
    expect(frontend.events({ channel: CARDS })).toEqual([]);
  });

  it("关着时判断不了的直接做、照常标出（101 号票）：没写着数据目录的内联脚本、只读的路径没法确定、发往本机的 POST；不出审批卡", async () => {
    const dataDir = makeTempDir("ergo-data-");
    const layout = dataDirLayout(realPathOf(dataDir)!);
    const { frontend, daemon } = await setup({
      reuse: { dataDir, homeDir: makeTempDir("ergo-home-") },
      secretary: [
        call("bash", { command: `node -e "console.log('平台：' + require('os').platform())"` }),
        call("bash", { command: "mkdir -p out && echo x > out/notes.txt" }),
        // 读的路径是命令替换拼出来的（守卫看不出落在哪）：只读的照放开
        call("bash", { command: 'cat "$(echo out/notes.txt)"' }),
        // 发往本机的 POST 不算对外（合成语音时 curl -X POST http://127.0.0.1:… 这样的）；本机没人监听的端口，连不上
        call("bash", { command: "curl -s -m 5 -X POST -d a=1 http://127.0.0.1:1/" }),
        { kind: "echo_context" },
      ],
      config: approvals("off"),
    });
    await tell(frontend, "看看是什么系统，建个 out 目录，再把要合成的发给本机的服务");
    expect(toolPartsOf(frontend).map((p) => [p.tool, p.categoryTitles, p.disposition, p.blockedBy ?? null, p.outcome === "blocked" ? "blocked" : "ran"])).toEqual([
      ["bash", ["未知的写操作"], "do", null, "ran"],
      ["bash", [], "do", null, "ran"],
      ["bash", ["越出项目目录"], "do", null, "ran"],
      ["bash", ["以我的名义对外发送或发布"], "do", null, "ran"],
    ]);
    expect(lastEcho(frontend)).toContain("平台：win32");
    expect(fs.readFileSync(path.join(layout.scratch, "out", "notes.txt"), "utf8").trim()).toBe("x");
    expect(daemon.approvals.list()).toEqual([]);
    expect(frontend.events({ channel: CARDS })).toEqual([]);
  });

  it("关着时秘书特别敏感的、可能碰到硬底线的照旧出审批卡，批了才做（101 号票）：对外发送、删草稿区外的文件、覆盖路径没法确定的文件、跑写着配置区路径的脚本、文件工具写草稿区外（原来硬拒绝）", async () => {
    const outside = realPathOf(makeTempDir("ergo-outside-"))!;
    fs.writeFileSync(path.join(outside, "keep.txt"), "留着");
    const dataDir = makeTempDir("ergo-data-");
    const layout = dataDirLayout(realPathOf(dataDir)!);
    const { frontend, daemon } = await setup({
      reuse: { dataDir, homeDir: makeTempDir("ergo-home-") },
      secretary: [
        // 往外 POST（.invalid 的域名：真执行了也解析不到；这里不批准，不会执行）
        call("bash", { command: "curl -s -X POST -d a=1 https://example.invalid/api" }),
        call("bash", { command: `rm "${fwd(path.join(outside, "keep.txt"))}"` }),
        // 写进去的目标是命令替换拼出来的：守卫看不出落在哪，可能在草稿区外
        call("bash", { command: 'echo x > "$(echo out.txt)"' }),
        // 脚本里写着配置区里的路径（只是打印出来）：守卫看不出它是读还是写，可能碰到硬底线
        call("write", { path: "tweak.js", content: `console.log(${JSON.stringify(path.join(layout.config, "ergo.json"))});\n` }),
        call("bash", { command: "node tweak.js" }),
        // 写在草稿区外：用户批准了才写
        call("write", { path: path.join(outside, "new.txt"), content: "写在外面" }),
        { kind: "echo_context" },
      ],
      config: approvals("off", { approvals: { waitMinutes: 30 } }),
    });
    await frontend.sendText("把笔记发出去，删掉外面那个文件，写个 out.txt，跑一下脚本，再在外面写一个");
    // 一张张审批卡：写草稿区外的那张批准，别的拒绝
    const decided = new Set<string>();
    while (decided.size < 5) {
      let card: Card | undefined;
      await waitUntil(
        () => {
          card = latestCards(frontend).find((c) => c.type === "approval" && c.status === "pending" && !decided.has(c.id));
          return card !== undefined;
        },
        { timeoutMs: 30_000, describe: () => `等第 ${decided.size + 1} 张审批卡` },
      );
      const approve = (card!.payload as ApprovalCardPayload).tool === "write";
      const r = await frontend.cardAction({ cardId: card!.id, action: approve ? "approve" : "deny", expectedVersion: card!.version });
      if (!r.ok) throw new Error(`审批卡没处理成：${r.error.message}`);
      decided.add(card!.id);
    }
    await frontend.next(SECRETARY, EVENT_TYPES.turnEnd);
    expect(toolPartsOf(frontend).map((p) => [p.tool, p.categoryTitles, p.disposition, p.outcome])).toEqual([
      ["bash", ["以我的名义对外发送或发布"], "ask_first", "denied"],
      ["bash", ["越出项目目录"], "ask_first", "denied"],
      ["bash", ["越出项目目录"], "ask_first", "denied"],
      ["write", [], "do", "done"],
      ["bash", ["未知的写操作"], "ask_first", "denied"],
      ["write", ["越出项目目录"], "ask_first", "done"],
    ]);
    expect(fs.existsSync(path.join(outside, "keep.txt"))).toBe(true);
    expect(fs.existsSync(path.join(layout.scratch, "out.txt"))).toBe(false);
    // 批了才写：写进去了
    expect(fs.readFileSync(path.join(outside, "new.txt"), "utf8")).toBe("写在外面");
    expect(daemon.approvals.list().map((a) => a.status).toSorted()).toEqual(["approved", "denied", "denied", "denied", "denied"]);
  });
});
