// 主切面：自动压缩点（420）。真的守护进程、faux 模型（剧本给定用量，不连真的模型）：
// - 每轮结束（回复已经交出去）后比一下最近一次调用的上下文和这个 agent 的压缩点：超过了就压缩（和"现在压缩"同一条路，带秘书的压缩指令），
//   时间线上记一笔、⚙ 上写上次自动压缩压好了；没超过不压；
// - 压缩没成不连环重试：记下"上次自动压缩没成"、下次最早什么时候再试，之后几轮再过线也不再试（剧本的步数对得上）；
//   压缩那次模型调用超时被结束子进程，这一轮的回复照样已经交出去了，重新拉起后照常回话；
// - 设置接口：⚙ 里单独设（改了马上生效，不等新会话）、范围不对的拒收、恢复默认；设置 · 模型里改默认，跟随默认的一起变、单独设的不变；
//   旧的模型设置文件（没有这一项）照常读、按 70 万。
import fs from "node:fs";
import { type AgentSettingsView, CHANNELS, EVENT_TYPES, type MessageEventPayload, type TimelineRecordEventPayload } from "@ergo/protocol";
import { describe, expect, it } from "vitest";
import { dataDirLayout } from "../../src/config/data-dir.ts";
import type { FauxStep } from "../../src/runtime/index.ts";
import { startTestDaemon, type TestDaemon } from "../helpers/daemon.ts";
import { TestFrontend } from "../helpers/frontend.ts";
import { agentSettingsApi, modelSettingsApi } from "../helpers/http.ts";
import { waitUntil } from "../helpers/process.ts";
import { say } from "../helpers/task-flow.ts";
import { makeTempDir } from "../helpers/temp-dir.ts";

const { secretary: SECRETARY } = CHANNELS;
const ECHO: FauxStep = { kind: "echo_context" };
/** DeepSeek 那么大的窗口：100 万（上限是 100 万 − 16384 = 983616） */
const WINDOW = 1_000_000;

/** 一段约 2.5 万 token 的材料（比最近原样留着的约 2 万多，压缩时才有东西可压） */
const LONG = `材料：${"一段很长的材料。".repeat(12_500)}`;

/** 一次回复，照剧本报这么大的上下文（缓存命中 + 未命中 + 输出） */
const big = (text: string, tokens: number): FauxStep => ({ kind: "reply", text, usage: { cacheHit: tokens - 1_100, cacheMiss: 1_000, output: 100 } });

const textOf = (payload: MessageEventPayload) => payload.message.parts.map((p) => (p.type === "text" ? p.text : "")).join("");
const turnEnds = (frontend: TestFrontend) => frontend.events({ channel: SECRETARY, type: EVENT_TYPES.turnEnd }).length;
const compactions = (frontend: TestFrontend) =>
  frontend
    .events({ channel: SECRETARY, type: EVENT_TYPES.timelineRecord })
    .map((f) => (f.payload as TimelineRecordEventPayload).record)
    .filter((r) => r.kind === "compaction");

/** 说一句，等秘书处理完这一条，返回它最后说的 */
async function say1(frontend: TestFrontend, text: string): Promise<string> {
  const before = turnEnds(frontend);
  await frontend.sendText(text);
  await waitUntil(() => turnEnds(frontend) > before, { timeoutMs: 30_000, describe: () => `等秘书处理完「${text.slice(0, 10)}」` });
  const reply = frontend
    .events({ channel: SECRETARY, type: EVENT_TYPES.message })
    .map((f) => f.payload as MessageEventPayload)
    .findLast((m) => m.message.speaker === "agent");
  return reply ? textOf(reply) : "";
}

const panel = async (td: TestDaemon, agentId = "secretary"): Promise<AgentSettingsView> => (await agentSettingsApi.view(td.url, agentId)).body;

/** 等秘书不在压缩了（自动压缩做完、没做成），返回那时的面板 */
async function settled(td: TestDaemon): Promise<AgentSettingsView> {
  let last: AgentSettingsView | undefined;
  await expect
    .poll(
      async () => {
        last = await panel(td);
        return last.context.compaction === "idle" && last.context.busy === false;
      },
      { timeout: 30_000 },
    )
    .toBe(true);
  return last!;
}

describe("每轮结束后过了压缩点就压缩", () => {
  it("秘书：没超过不压；过了 70 万，这一轮的回复交出去之后压缩（带秘书的压缩指令），时间线上一笔、记账，⚙ 写上次自动压缩压好了", async () => {
    const td = await startTestDaemon({
      secretaryContextWindow: WINDOW,
      // 写摘要那次把收到的原样回成摘要（看得到秘书的压缩指令）；压缩之后那一轮把看到的上下文回显出来
      secretary: [say("好"), say("收到了一大段"), big("第二句的回复", 750_000), ECHO, ECHO],
    });
    const frontend = await TestFrontend.connect(td.url);
    await frontend.subscribe({ [SECRETARY]: 0 });
    await say1(frontend, "开头一句");
    await say1(frontend, LONG);
    // 没超过：不压
    expect(compactions(frontend)).toEqual([]);
    const before = (await panel(td)).context;
    expect(before).toMatchObject({ autoCompactAt: 700_000, autoCompact: { source: "default", defaultAt: 700_000, limit: WINDOW - 16_384 } });
    expect(before.autoCompact).not.toHaveProperty("last");

    // 过了 70 万：这一轮的回复先交出去（回复、turn_end 都在压缩那一笔前面），再压
    expect(await say1(frontend, "第二句")).toBe("第二句的回复");
    await waitUntil(() => compactions(frontend).length === 1, { timeoutMs: 30_000, describe: () => "等自动压缩" });
    const events = frontend.events({ channel: SECRETARY });
    const replyAt = events.findIndex((f) => f.type === EVENT_TYPES.message && textOf(f.payload as MessageEventPayload) === "第二句的回复");
    const turnEndAt = events.findLastIndex((f) => f.type === EVENT_TYPES.turnEnd);
    const compactAt = events.findIndex((f) => f.type === EVENT_TYPES.timelineRecord);
    expect(replyAt).toBeGreaterThan(-1);
    expect(replyAt).toBeLessThan(compactAt);
    expect(turnEndAt).toBeLessThan(compactAt);
    expect(compactions(frontend)[0]).toMatchObject({ summary: "这里压缩过一次", detail: expect.stringContaining("对话过了设的自动压缩点（70 万 token）") });

    const done = await settled(td);
    expect(done.context.autoCompact?.last).toMatchObject({ outcome: "done", by: "ergo" });
    expect(done.context.autoCompact).not.toHaveProperty("failures");
    expect(done.context.lastCompact).toBeUndefined();
    expect(done.context.lastCompactedAt).toEqual(expect.any(String));
    expect(td.daemon.ledger.entries(null).filter((e) => e.agentId === "secretary" && e.purpose === "compaction")).toHaveLength(1);

    // 摘要是按秘书的压缩指令写的，进了之后的上下文；开头那一句只在摘要里
    const after = await say1(frontend, "压缩之后");
    expect(after).toContain("这是二狗的秘书和用户的长期主线对话，写摘要时");
    expect(after).toContain("[User]: ");
    // 压缩之后这一轮的用量小了：不再压
    await settled(td);
    expect(compactions(frontend)).toHaveLength(1);
  }, 90_000);

  it("压缩没成：记下没成和下次什么时候再试，之后几轮再过线也不再试（不连环重试），回话照常", async () => {
    const td = await startTestDaemon({
      secretaryContextWindow: WINDOW,
      // 第 4、5 步是写摘要那次：模型报错（上下文溢出）——按秘书的压缩指令写的没成，pi 接着按它默认的写法再写一次也没成，压缩没成。
      // 之后两轮照样过线，剧本里没有给压缩留的步——再试就会吃掉回话
      secretary: [say("好"), say("收到了一大段"), big("第二句的回复", 750_000), { kind: "context_overflow" }, { kind: "context_overflow" }, big("还在", 760_000), big("还在呢", 770_000)],
    });
    const frontend = await TestFrontend.connect(td.url);
    await frontend.subscribe({ [SECRETARY]: 0 });
    await say1(frontend, "开头一句");
    await say1(frontend, LONG);
    expect(await say1(frontend, "第二句")).toBe("第二句的回复");
    let view: AgentSettingsView | undefined;
    await expect
      .poll(
        async () => {
          view = await panel(td);
          return view.context.autoCompact?.last?.outcome;
        },
        { timeout: 30_000 },
      )
      .toBe("failed");
    expect(view!.context.autoCompact).toMatchObject({ last: { by: "ergo", message: expect.any(String) }, failures: 1, retryAt: expect.any(String) });
    // 下次最早 15 分钟之后
    expect(Date.parse(view!.context.autoCompact!.retryAt!) - Date.now()).toBeGreaterThan(14 * 60_000);
    expect(compactions(frontend)).toEqual([]);

    // 之后两轮照样过线：不再试，回话照剧本来
    expect(await say1(frontend, "第三句")).toBe("还在");
    expect(await say1(frontend, "第四句")).toBe("还在呢");
    const last = await settled(td);
    expect(last.context.autoCompact).toMatchObject({ failures: 1, last: { outcome: "failed" } });
    expect(compactions(frontend)).toEqual([]);
    expect(td.daemon.ledger.entries(null).filter((e) => e.agentId === "secretary" && e.purpose === "compaction")).toEqual([]);
  }, 90_000);

  it("压缩那次模型调用超时：结束子进程、记一次没成；这一轮的回复早已交出去，重新拉起后照常回话", async () => {
    // 单次模型调用 0.6 秒；平常的回话很短（来得及），写摘要那次很长、按每秒 5 个 token 吐，超时
    const td = await startTestDaemon({
      config: { agents: { modelCallMinutes: 0.01 } },
      secretaryContextWindow: WINDOW,
      secretary: [say("好"), say("好"), big("第二句的回复", 750_000), say("摘要写得非常非常慢。".repeat(60))],
      secretaryTokensPerSecond: 5,
    });
    const frontend = await TestFrontend.connect(td.url);
    await frontend.subscribe({ [SECRETARY]: 0 });
    await say1(frontend, "开头一句");
    await say1(frontend, LONG);
    expect(await say1(frontend, "第二句")).toBe("第二句的回复");
    await expect.poll(async () => (await panel(td)).context.autoCompact?.last?.outcome, { timeout: 30_000 }).toBe("failed");
    const view = await panel(td);
    expect(view.context.autoCompact?.last?.message).toContain("超时");
    expect(view.context.autoCompact?.failures).toBe(1);
    // 重新拉起（接着原来的会话，剧本从头来），照常回话
    expect(await say1(frontend, "还在吗")).toBe("好");
    expect(compactions(frontend)).toEqual([]);
  }, 90_000);
});

describe("设置接口：⚙ 里单独设、恢复默认，设置 · 模型里改默认", () => {
  it("单独设了马上生效（不等新会话）；范围不对的拒收；恢复默认改回跟随；改默认时跟随的一起变、单独设的不变；写进模型设置文件", async () => {
    const td = await startTestDaemon({
      secretaryContextWindow: WINDOW,
      secretary: [say("好"), say("收到了一大段"), big("第二句的回复", 120_000), ECHO, ECHO, ECHO],
    });
    const frontend = await TestFrontend.connect(td.url);
    await frontend.subscribe({ [SECRETARY]: 0 });
    await say1(frontend, "开头一句");
    await say1(frontend, LONG);

    // 范围不对：少于 5 万、多于这个模型的上限（窗口 − 16384）、不是整数
    expect(await agentSettingsApi.autoCompact(td.url, "secretary", 40_000)).toMatchObject({ status: 400, body: { message: expect.stringContaining("最少 50,000 token") } });
    expect(await agentSettingsApi.autoCompact(td.url, "secretary", 990_000)).toMatchObject({ status: 400, body: { message: expect.stringContaining("最多设到 983,616 token") } });
    expect((await agentSettingsApi.autoCompact(td.url, "secretary", { at: "十万" })).status).toBe(400);
    expect((await agentSettingsApi.autoCompact(td.url, "nobody", 100_000)).status).toBe(404);

    // 单独设 10 万：面板上写单独设的、生效的点；这一段会话没换，下一轮说完（12 万）就压
    const set = await agentSettingsApi.autoCompact(td.url, "secretary", 100_000);
    expect(set.status).toBe(200);
    expect(set.body.context).toMatchObject({ autoCompactAt: 100_000, autoCompact: { source: "own", own: 100_000, defaultAt: 700_000 } });
    await say1(frontend, "第二句");
    await waitUntil(() => compactions(frontend).length === 1, { timeoutMs: 30_000, describe: () => "等自动压缩" });
    expect(compactions(frontend)[0]!.detail).toContain("（10 万 token）");
    await settled(td);

    // 改默认：跟随的跟着变（记忆管理员），单独设的不变（秘书）
    const current = (await modelSettingsApi.view(td.url)).body.settings;
    const changed = await modelSettingsApi.change(td.url, { ...current, autoCompactAt: 500_000 });
    expect(changed.status).toBe(200);
    expect(changed.body.autoCompact).toMatchObject({ defaultAt: 500_000, builtin: 700_000, ownCount: 1 });
    expect((await panel(td)).context).toMatchObject({ autoCompactAt: 100_000, autoCompact: { source: "own", own: 100_000, defaultAt: 500_000 } });
    expect((await panel(td, "memory-curator")).context).toMatchObject({ autoCompactAt: 500_000, autoCompact: { source: "default", defaultAt: 500_000 } });
    expect(JSON.parse(fs.readFileSync(dataDirLayout(td.dataDir).modelSettingsFile, "utf8"))).toMatchObject({ autoCompactAt: 500_000, agentAutoCompact: { secretary: 100_000 } });
    // 设置页的默认值范围不对：拒收
    expect((await modelSettingsApi.change(td.url, { ...current, autoCompactAt: 1_000 })).status).toBe(400);

    // 恢复默认：改回跟随
    const reset = await agentSettingsApi.autoCompact(td.url, "secretary", undefined);
    expect(reset.status).toBe(200);
    expect(reset.body.context).toMatchObject({ autoCompactAt: 500_000, autoCompact: { source: "default", defaultAt: 500_000 } });
    expect(reset.body.context.autoCompact).not.toHaveProperty("own");
    expect(JSON.parse(fs.readFileSync(dataDirLayout(td.dataDir).modelSettingsFile, "utf8"))).not.toHaveProperty("agentAutoCompact");
  }, 90_000);

  it("旧的模型设置文件（没有这一项）照常读，按 70 万", async () => {
    // 升级前留下的设置文件：只有服务商、默认模型、各 agent、看图能力
    const dataDir = makeTempDir("ergo-data-");
    const { config, modelSettingsFile } = dataDirLayout(dataDir);
    fs.mkdirSync(config, { recursive: true });
    fs.writeFileSync(modelSettingsFile, JSON.stringify({ format: 1, provider: "deepseek", default: { modelId: "deepseek-flash", thinkingLevel: "medium" }, agents: {}, vision: {} }));
    const td = await startTestDaemon({ secretary: [say("好")], reuse: { dataDir, homeDir: makeTempDir("ergo-home-") } });
    const view = (await modelSettingsApi.view(td.url)).body;
    expect(view.settingsFileError).toBeUndefined();
    expect(view.settings.default.thinkingLevel).toBe("medium");
    expect(view.autoCompact).toMatchObject({ defaultAt: 700_000, ownCount: 0 });
    expect((await panel(td)).context.autoCompact).toMatchObject({ source: "default", defaultAt: 700_000 });
  });
});
