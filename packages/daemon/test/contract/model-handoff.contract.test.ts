// pi 契约测试：换模型就新开会话、附一份交接摘要（83 号票，规格第 1 节"模型"）。
// - 接着的会话开始时的模型和装配参数里的不一样、装配参数给了 handoff：先用原来的模型写交接摘要——pi 的压缩摘要的写法
//   （pi 的结构化摘要提示，守护进程给的写法接在后面 "Additional focus"，对话转成文字放在 <conversation> 里）——再新开一个会话
//   （用装配参数里的模型），第一条就是这份摘要；新会话一开始就在盘上，之后接着最近的会话接的是它；
//   ready 报回换成了什么（handoff），写摘要那次的用量（purpose: handoff，原来的模型）在 ready 之后报；
// - 思考档位按模型支持的档换算之后一样的（v4-pro 的"低"就是"高"），不算不一样，不换；
// - 没给 handoff：照旧接着，ready.model.differs 说明和装配参数不一样；
// - 交接摘要没写成（模型出错）：不换，照旧接着原来的会话，ready.handoff.error 写原因；
// - 彻底删除：原来的会话里有被删的内容，新会话开头的交接摘要整段换成删除说明（跨文件，换了两次也一层层往后推）。
// 目录模型的请求都发到本机的假 DeepSeek（helpers/fake-deepseek.ts），不联网。
import fs from "node:fs";
import path from "node:path";
import { PURGED_SUMMARY_TEXT, PURGED_TEXT } from "@ergo/protocol";
import { describe, expect, it } from "vitest";
import type { Daemon } from "../../src/daemon.ts";
import { HANDOFF_SUMMARY_TYPE, type ModelSpec } from "../../src/runtime/index.ts";
import { FAKE_DEEPSEEK_REPLY, requestText, startFakeDeepSeek } from "../helpers/fake-deepseek.ts";
import { spawnTestAgent, startTestDaemon } from "../helpers/daemon.ts";
import { fakeSecret } from "../helpers/fake-secrets.ts";

const KEY = fakeSecret("sk-", "test-83-not-a-real-key-Q7wd");
const INSTRUCTIONS = "交接摘要的测试写法：写清在做什么、做到哪了。";
const deepseek = (modelId: string, thinkingLevel: "off" | "low" | "high", baseUrl: string): ModelSpec => ({ kind: "catalog", provider: "deepseek", modelId, thinkingLevel, baseUrl });

/** 拉起（接着最近的会话），说一句话（不给就不说），等这一轮结束；返回 ready、用量和子进程报的全部 */
async function talk(daemon: Daemon, agentId: string, model: ModelSpec, text: string | undefined, options: { handoff?: boolean } = {}) {
  const { agent, log } = spawnTestAgent(daemon, {
    agentId,
    model,
    credentials: { deepseek: KEY },
    tools: [],
    continueSession: true,
    ...(options.handoff ? { handoff: { instructions: INSTRUCTIONS } } : {}),
  });
  const ready = await log.next("ready", 60_000);
  // 新会话一开始就在盘上（还没说话就能看到它的文件和开头的交接摘要）
  const fileRightAfterReady = fs.existsSync(ready.sessionFile) ? fs.readFileSync(ready.sessionFile, "utf8") : undefined;
  if (text !== undefined) {
    agent.send({ type: "user_input", inputId: `in-${Date.now()}`, text });
    const end = await log.next("turn_end");
    if (end.outcome !== "completed") throw new Error(`这一轮没有正常结束：${end.outcome} ${end.errorMessage ?? ""}`);
  }
  const usage = log.ofType("usage");
  agent.kill();
  await agent.exited;
  return { ready, usage, reports: log.reports, fileRightAfterReady };
}

/** 会话文件里的条目 */
function entriesOf(file: string): Array<Record<string, unknown>> {
  return fs
    .readFileSync(file, "utf8")
    .split("\n")
    .filter((l) => l.trim() !== "")
    .map((l) => JSON.parse(l) as Record<string, unknown>);
}

const handoffEntry = (file: string) => entriesOf(file).find((e) => e.type === "custom_message" && e.customType === HANDOFF_SUMMARY_TYPE) as { content: unknown; details: { fromSession: string; fromModel: string } } | undefined;

describe("pi 契约：换模型就新开会话、附交接摘要", () => {
  it("用原来的模型照 pi 的压缩摘要写交接摘要（守护进程的写法接在后面），新开会话、第一条就是它；新会话马上在盘上，之后接着的就是它；用量在 ready 之后报", async () => {
    const provider = await startFakeDeepSeek();
    const { daemon } = await startTestDaemon();
    const first = await talk(daemon, "contract-handoff", deepseek("deepseek-flash", "off", provider.baseUrl), "我在整理十月的发票，按月份分文件夹");
    expect(provider.requests).toHaveLength(1);

    // 设置改成 v4-pro、思考高，带上 handoff 拉起：先用原来的 flash（不开思考）写交接摘要
    const switched = await talk(daemon, "contract-handoff", deepseek("deepseek-v4-pro", "high", provider.baseUrl), "接着来", { handoff: true });
    const summaryRequest = provider.requests[1]!;
    expect(summaryRequest.body).toMatchObject({ model: "deepseek-flash", thinking: { type: "disabled" } });
    const prompt = requestText(summaryRequest);
    // pi 的压缩摘要的写法：对话转成文字放在 <conversation> 里、结构化的摘要提示，守护进程给的写法接在后面
    expect(prompt).toContain("<conversation>");
    expect(prompt).toContain("我在整理十月的发票");
    expect(prompt).toContain("## Goal");
    expect(prompt).toContain(`Additional focus: ${INSTRUCTIONS}`);

    // ready：新会话，用新的模型；报回换成了什么
    const { ready } = switched;
    expect(ready.session).not.toBe(first.ready.session);
    expect(ready.model).toEqual({ provider: "deepseek", modelId: "deepseek-v4-pro", thinkingLevel: "high", pinned: false });
    expect(ready.handoff).toEqual({
      from: { session: first.ready.session, model: { provider: "deepseek", modelId: "deepseek-flash", name: "DeepSeek V4.1 Flash", thinkingLevel: "off" } },
      to: { provider: "deepseek", modelId: "deepseek-v4-pro", name: "DeepSeek V4 Pro", thinkingLevel: "high" },
    });
    // 新会话一开始就在盘上，开头是交接摘要（数据里记着从哪个会话换过来的）
    expect(switched.fileRightAfterReady).toContain(HANDOFF_SUMMARY_TYPE);
    const entry = handoffEntry(ready.sessionFile)!;
    expect(entry.details).toEqual({ fromSession: first.ready.session, fromModel: "deepseek/deepseek-flash" });
    expect(String(entry.content)).toContain("【交接摘要】");
    expect(String(entry.content)).toContain(FAKE_DEEPSEEK_REPLY);

    // 接着说的那一句交给新会话、用新的模型，上下文里有交接摘要，没有原来的对话原文
    const next = provider.requests[2]!;
    expect(next.body).toMatchObject({ model: "deepseek-v4-pro", thinking: { type: "enabled" } });
    expect(requestText(next)).toContain("【交接摘要】");
    expect(requestText(next)).not.toContain("按月份分文件夹");

    // 用量：写摘要那次在 ready 之后报，记在原来的模型名下；之后是新会话里的一次
    const types = switched.reports.map((r) => r.type);
    expect(types.indexOf("usage")).toBeGreaterThan(types.indexOf("ready"));
    expect(switched.usage.map((u) => [u.purpose ?? "work", `${u.provider}/${u.modelId}`])).toEqual([
      ["handoff", "deepseek/deepseek-flash"],
      ["work", "deepseek/deepseek-v4-pro"],
    ]);

    // 之后接着最近的会话：就是新会话，照它开始时的 v4-pro，不再换
    const again = await talk(daemon, "contract-handoff", deepseek("deepseek-v4-pro", "high", provider.baseUrl), "还在吗", { handoff: true });
    expect(again.ready.session).toBe(ready.session);
    expect(again.ready.model).toEqual({ provider: "deepseek", modelId: "deepseek-v4-pro", thinkingLevel: "high", pinned: true });
    expect(again.ready.handoff).toBeUndefined();
    expect(provider.requests.map((r) => r.body.model)).toEqual(["deepseek-flash", "deepseek-flash", "deepseek-v4-pro", "deepseek-v4-pro"]);
  });

  it("思考档位按模型支持的档换算之后一样（v4-pro 的低就是高）的不换；没给 handoff 时照旧接着、报 differs", async () => {
    const provider = await startFakeDeepSeek();
    const { daemon } = await startTestDaemon();
    const first = await talk(daemon, "contract-handoff-same", deepseek("deepseek-v4-pro", "high", provider.baseUrl), "在吗");

    const same = await talk(daemon, "contract-handoff-same", deepseek("deepseek-v4-pro", "low", provider.baseUrl), undefined, { handoff: true });
    expect(same.ready.session).toBe(first.ready.session);
    expect(same.ready.model).toEqual({ provider: "deepseek", modelId: "deepseek-v4-pro", thinkingLevel: "high", pinned: true });
    expect(same.ready.handoff).toBeUndefined();

    const noHandoff = await talk(daemon, "contract-handoff-same", deepseek("deepseek-flash", "high", provider.baseUrl), undefined);
    expect(noHandoff.ready.session).toBe(first.ready.session);
    expect(noHandoff.ready.model).toEqual({ provider: "deepseek", modelId: "deepseek-v4-pro", thinkingLevel: "high", pinned: true, differs: true });
    expect(noHandoff.ready.handoff).toBeUndefined();
    // 都没写交接摘要
    expect(provider.requests).toHaveLength(1);
  });

  it("交接摘要没写成（模型出错）：不换，照旧接着原来的会话、照它开始时的模型，原因报回（不带 key）", async () => {
    const provider = await startFakeDeepSeek();
    const { daemon } = await startTestDaemon();
    const first = await talk(daemon, "contract-handoff-fail", deepseek("deepseek-flash", "high", provider.baseUrl), "在吗");
    provider.failNext(`摘要写不出来 ****${KEY.slice(-4)}`);
    const failed = await talk(daemon, "contract-handoff-fail", deepseek("deepseek-v4-pro", "high", provider.baseUrl), "还在吗", { handoff: true });
    expect(failed.ready.session).toBe(first.ready.session);
    expect(failed.ready.model).toEqual({ provider: "deepseek", modelId: "deepseek-flash", thinkingLevel: "high", pinned: true, differs: true });
    expect(failed.ready.handoff).toMatchObject({ from: { session: first.ready.session }, to: { modelId: "deepseek-v4-pro" }, error: expect.stringContaining("摘要写不出来") });
    expect(failed.ready.handoff!.error).not.toContain(KEY.slice(-4));
    // 这一句照旧交给原来的会话、用 flash；没有写摘要的用量
    expect(provider.requests.at(-1)!.body.model).toBe("deepseek-flash");
    expect(failed.usage.map((u) => u.purpose ?? "work")).toEqual(["work"]);
    expect(fs.readdirSync(path.dirname(first.ready.sessionFile)).filter((f) => f.endsWith(".jsonl"))).toHaveLength(1);
  });

  it("彻底删除：原来的会话里有被删的话，换过来的新会话开头的交接摘要整段换成删除说明；换了两次的一层层往后推；别的会话不动", async () => {
    const provider = await startFakeDeepSeek();
    const { daemon } = await startTestDaemon();
    const AGENT = "contract-handoff-purge";
    const flash = deepseek("deepseek-flash", "high", provider.baseUrl);
    const pro = deepseek("deepseek-v4-pro", "high", provider.baseUrl);
    // A（flash）里说了要删的话 → 换到 B（v4-pro）→ 换到 C（flash）
    const spawnAndSay = async (model: ModelSpec, inputId: string, text: string, handoff: boolean) => {
      const { agent, log } = spawnTestAgent(daemon, { agentId: AGENT, model, credentials: { deepseek: KEY }, tools: [], continueSession: true, ...(handoff ? { handoff: { instructions: INSTRUCTIONS } } : {}) });
      const ready = await log.next("ready", 60_000);
      agent.send({ type: "user_input", inputId, text });
      await log.next("turn_end");
      agent.kill();
      await agent.exited;
      return ready;
    };
    const a = await spawnAndSay(flash, "in-secret", "暗号是青蛙", false);
    const b = await spawnAndSay(pro, "in-b", "接着说", true);
    const c = await spawnAndSay(flash, "in-c", "再接着说", true);
    expect(new Set([a.session, b.session, c.session]).size).toBe(3);
    expect(handoffEntry(b.sessionFile)!.details.fromSession).toBe(a.session);
    expect(handoffEntry(c.sessionFile)!.details.fromSession).toBe(b.session);
    // B 后来压缩过一次（手工接上）：保留的是最后一条，交接摘要在压缩覆盖的范围里，压缩摘要是连它一起写的
    const bEntries = entriesOf(b.sessionFile);
    const compaction = { type: "compaction", id: "cmp08301", parentId: bEntries.at(-1)!.id, timestamp: new Date().toISOString(), summary: "B 的压缩摘要：用户说过暗号", firstKeptEntryId: bEntries.at(-1)!.id, tokensBefore: 100 };
    fs.appendFileSync(b.sessionFile, `${JSON.stringify(compaction)}\n`);

    const request = { inputIds: ["in-secret"], toolCallIds: [], toolResultLines: [], marker: PURGED_TEXT, summaryMarker: PURGED_SUMMARY_TEXT, customTypes: [] };
    // A 里的用户消息一条；B、C 开头的交接摘要各一段，B 覆盖了交接摘要的压缩摘要一段
    expect(await daemon.agents.rewriteSessions(AGENT, request)).toEqual({ files: 3, entries: 1, summaries: 3 });
    expect(handoffEntry(b.sessionFile)!.content).toBe(PURGED_SUMMARY_TEXT);
    expect(handoffEntry(c.sessionFile)!.content).toBe(PURGED_SUMMARY_TEXT);
    expect(fs.readFileSync(b.sessionFile, "utf8")).not.toContain("暗号");
    // 从哪换过来的留着（后面再换过来的据此判断）
    expect(handoffEntry(c.sessionFile)!.details.fromSession).toBe(b.session);
    expect(fs.readFileSync(a.sessionFile, "utf8")).not.toContain("青蛙");
    // 再改一次没有变化
    expect(await daemon.agents.rewriteSessions(AGENT, request)).toEqual({ files: 0, entries: 0, summaries: 0 });

    // 只删 C 里的话：B 的摘要不动（它是从 A 写的），C 自己的摘要也不动（被删的在摘要之后）
    const later = { ...request, inputIds: ["in-c"] };
    const bBefore = fs.readFileSync(b.sessionFile, "utf8");
    expect(await daemon.agents.rewriteSessions(AGENT, later)).toEqual({ files: 1, entries: 1, summaries: 0 });
    expect(fs.readFileSync(b.sessionFile, "utf8")).toBe(bBefore);
  });
});
