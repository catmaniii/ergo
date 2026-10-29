// 主切面：每个负责人能单独配模型（120 号票）。真的守护进程，目录模型（DeepSeek）的请求一律发到本机的假 DeepSeek
// （helpers/fake-deepseek.ts），从不连真的；key 是假的。
// - 项目维护者的 ⚙ 里选定模型和思考档位，盖过设置 · 模型里项目维护者那一行；别的项目的维护者照那一行；
// - 照 83 号票生效：对话段里下一条消息时用原来的模型写交接摘要、新开会话，聊天里记一条"已换成 X 模型"；账本照实际调用的模型记；
// - 设置 · 模型页上列出哪些项目、任务单独配了；
// - 模型目录里没有的、秘书、只读的不让配；项目归档、任务归档时这一条一起清掉；
// - 任务的维护者：⚙ 上写明一次性的任务执行中途不换（改了以后清空当前对话、新开的一段才用它）。
// 它派出的子 agent、评审、范围审视照各自那一行：拉起它们时不带维护者的 id（模块层 test/model-settings.test.ts 锁着）。
import fs from "node:fs";
import { EVENT_TYPES, maintainerChannel, type MessageEventPayload, METHODS } from "@ergo/protocol";
import { describe, expect, it } from "vitest";
import { startTestDaemon, type TestDaemon } from "../helpers/daemon.ts";
import { type FakeDeepSeek, type FakeDeepSeekRequest, requestText, startFakeDeepSeek } from "../helpers/fake-deepseek.ts";
import { TestFrontend } from "../helpers/frontend.ts";
import { agentSettingsApi, modelSettingsApi } from "../helpers/http.ts";
import { waitUntil } from "../helpers/process.ts";
import { seedProject } from "../helpers/projects.ts";
import { ok } from "../helpers/running-task.ts";
import { fakeSecret } from "../helpers/fake-secrets.ts";

/** 假的 key（守护进程环境里的 DEEPSEEK_API_KEY） */
const KEY = fakeSecret("sk-", "main-120-fake-key-Pq61Wd");
const FLASH = { modelId: "deepseek-flash", thinkingLevel: "high" } as const;
const PRO = { modelId: "deepseek-v4-pro", thinkingLevel: "high" } as const;

const seedInUse = (td: TestDaemon, name: string) => seedProject(td.daemon, name, { state: "in_use", charterConfirmed: true, kind: "other", toolkit: { skills: [], mcp: [], bash: false, network: false } });

/** 写交接摘要的那次请求：pi 的压缩摘要提示，二狗的写法接在后面 */
const isSummary = (r: FakeDeepSeekRequest) => requestText(r).includes("Additional focus:");

const requests = (fake: FakeDeepSeek, n: number) =>
  waitUntil(() => fake.requests.length >= n, { timeoutMs: 60_000, describe: () => `等第 ${n} 个请求，现在：${JSON.stringify(fake.requests.map((r) => r.body.model))}` });

const turnsDone = (td: TestDaemon, channel: string) => td.daemon.store.read(channel, 0, EVENT_TYPES.turnEnd).length;

/** 会话频道里的系统说明（不是交给 agent 的通知） */
const notesIn = (td: TestDaemon, channel: string) =>
  td.daemon.store
    .read(channel, 0, EVENT_TYPES.message)
    .map((e) => e.payload as MessageEventPayload)
    .filter((p) => p.message.speaker === "system" && p.agentInput !== true)
    .map((p) => p.message.parts.map((part) => ("text" in part ? part.text : "")).join(""));

const fileOf = (td: TestDaemon) => JSON.parse(fs.readFileSync(td.daemon.layout.modelSettingsFile, "utf8")) as { maintainers?: Record<string, unknown> };

describe("每个负责人单独配模型", () => {
  it("项目维护者的 ⚙ 里单独配 v4-pro：对话段里下一条消息时写交接摘要、换成它，聊天里记一条；别的项目照那一行；设置页上列出来；账本照实际调用的模型记；改回跟随", async () => {
    const fake = await startFakeDeepSeek();
    const td = await startTestDaemon({ modelsFromSettings: ["maintainer"], catalogBaseUrl: fake.baseUrl, env: { DEEPSEEK_API_KEY: KEY } });
    seedInUse(td, "家庭网盘");
    seedInUse(td, "记账本");
    const PM1 = maintainerChannel("pm-1");
    const PM2 = maintainerChannel("pm-2");
    const frontend = await TestFrontend.connect(td.url);

    // 还没单独配：跟随项目维护者那一行，下一段起改了才换
    expect((await agentSettingsApi.view(td.url, "pm-1")).body.model).toEqual({ agent: "project_maintainer", role: FLASH, next: FLASH, switchAt: "next_segment" });
    await frontend.sendText("网盘最近满了吗", { conversation: PM1 });
    await requests(fake, 1);
    await waitUntil(() => turnsDone(td, PM1) === 1);
    expect(fake.requests[0]!.body.model).toBe("deepseek-flash");

    // ⚙ 里单独配：面板上写那一行的、单独配的、下一个新会话用的、这段会话实际用的
    const set = await agentSettingsApi.model(td.url, "pm-1", PRO);
    expect(set.status).toBe(200);
    expect(set.body.model).toEqual({ agent: "project_maintainer", role: FLASH, own: PRO, next: PRO, session: { modelId: "deepseek-flash", thinkingLevel: "high", vision: true }, switchAt: "next_segment" });
    expect(fileOf(td).maintainers).toEqual({ "pm-1": PRO });
    // 设置 · 模型页：项目维护者那一行照旧，下面列出单独配了的
    const page = (await modelSettingsApi.view(td.url)).body;
    expect(page.effective.project_maintainer).toEqual(FLASH);
    expect(page.maintainers).toEqual([{ agentId: "pm-1", agent: "project_maintainer", owner: { kind: "project", id: "p-1", title: "家庭网盘" }, choice: PRO }]);

    // 对话段里的下一条：先用 flash 写交接摘要，再用 v4-pro 回复；聊天里记一条"已换成"
    await frontend.sendText("那清理一下旧照片", { conversation: PM1 });
    await requests(fake, 3);
    expect(fake.requests.slice(1, 3).map((r) => [r.body.model, isSummary(r)])).toEqual([
      ["deepseek-flash", true],
      ["deepseek-v4-pro", false],
    ]);
    expect(requestText(fake.requests[2]!)).toContain("【交接摘要】");
    await waitUntil(() => turnsDone(td, PM1) === 2);
    expect(notesIn(td, PM1)).toContain("已换成 DeepSeek V4 Pro 模型（思考：高），接着之前的对话。");

    // 别的项目的维护者：照项目维护者那一行
    await frontend.sendText("这个月花了多少", { conversation: PM2 });
    await requests(fake, 4);
    expect(fake.requests[3]!.body.model).toBe("deepseek-flash");
    await waitUntil(() => turnsDone(td, PM2) === 1);

    // 账本照实际调用的模型记（交接摘要记在原来的模型名下）
    const calls = () => td.daemon.ledger.entries().filter((e) => e.agentId.startsWith("pm-") && (e.purpose === "work" || e.purpose === "handoff"));
    await waitUntil(() => calls().length === 4, { timeoutMs: 20_000, describe: () => JSON.stringify(calls()) });
    const of = (agentId: string) => calls().filter((e) => e.agentId === agentId).map((e) => [e.purpose, e.model]);
    expect(of("pm-1")).toEqual([
      ["work", "deepseek/deepseek-flash"],
      ["handoff", "deepseek/deepseek-flash"],
      ["work", "deepseek/deepseek-v4-pro"],
    ]);
    expect(of("pm-2")).toEqual([["work", "deepseek/deepseek-flash"]]);
    expect((await agentSettingsApi.view(td.url, "pm-1")).body.model?.session).toEqual({ modelId: "deepseek-v4-pro", thinkingLevel: "high", vision: false });

    // 改回跟随：去掉这一条，下一个新会话起照那一行
    const back = await agentSettingsApi.model(td.url, "pm-1", undefined);
    expect(back.status).toBe(200);
    expect(back.body.model).toMatchObject({ role: FLASH, next: FLASH });
    expect(back.body.model?.own).toBeUndefined();
    expect(fileOf(td).maintainers).toBeUndefined();
    expect((await modelSettingsApi.view(td.url)).body.maintainers).toEqual([]);
  }, 180_000);

  it("不让配的：模型目录里没有的、秘书（它在设置 · 模型里单独一行）、不认得的 agent、只读的；项目归档、任务归档时单独配的一起清掉", async () => {
    const td = await startTestDaemon({ env: { DEEPSEEK_API_KEY: KEY } });
    seedInUse(td, "家庭网盘");
    const frontend = await TestFrontend.connect(td.url);

    const nope = await agentSettingsApi.model(td.url, "pm-1", { modelId: "deepseek-nope", thinkingLevel: "high" });
    expect(nope.status).toBe(400);
    expect(nope.body.message).toMatch(/DeepSeek 的模型目录里没有 deepseek-nope/);
    expect((await agentSettingsApi.model(td.url, "pm-1", { modelId: "deepseek-v4-pro" })).status).toBe(400);
    const secretary = await agentSettingsApi.model(td.url, "secretary", PRO);
    expect(secretary.status).toBe(400);
    expect(secretary.body.message).toMatch(/秘书的模型在设置 · 模型里改/);
    expect((await agentSettingsApi.view(td.url, "secretary")).body.model).toBeUndefined();
    expect((await agentSettingsApi.model(td.url, "pm-9", PRO)).status).toBe(404);

    // 项目归档：清掉；之后 ⚙ 只读，配不了
    expect((await agentSettingsApi.model(td.url, "pm-1", PRO)).status).toBe(200);
    ok(await frontend.request(METHODS.projectAction, { projectId: "p-1", action: "archive" }, "k-archive-p1"));
    expect(fileOf(td).maintainers).toBeUndefined();
    const archived = (await agentSettingsApi.view(td.url, "pm-1")).body;
    expect(archived.readOnly).toBeTruthy();
    expect(archived.model).toMatchObject({ role: FLASH, next: FLASH });
    expect(archived.model?.own).toBeUndefined();
    expect((await agentSettingsApi.model(td.url, "pm-1", PRO)).status).toBe(400);

    // 任务的维护者：一次性的任务执行中途不换；归档时清掉
    const task = td.daemon.tasks.createByRequest({ title: "整理发票", summary: "整理发票" });
    const set = await agentSettingsApi.model(td.url, task.maintainerId, { modelId: "deepseek-v4-pro", thinkingLevel: "off" });
    expect(set.status).toBe(200);
    expect(set.body.model).toMatchObject({ agent: "task_maintainer", own: { modelId: "deepseek-v4-pro", thinkingLevel: "off" }, switchAt: "new_session" });
    expect((await modelSettingsApi.view(td.url)).body.maintainers).toEqual([
      { agentId: task.maintainerId, agent: "task_maintainer", owner: { kind: "task", id: task.id, title: "整理发票" }, choice: { modelId: "deepseek-v4-pro", thinkingLevel: "off" } },
    ]);
    ok(await frontend.taskAction({ taskId: task.id, action: "cancel" }));
    expect(fileOf(td).maintainers).toEqual({ [task.maintainerId]: { modelId: "deepseek-v4-pro", thinkingLevel: "off" } });
    ok(await frontend.taskAction({ taskId: task.id, action: "archive" }));
    expect(fileOf(td).maintainers).toBeUndefined();
    expect((await modelSettingsApi.view(td.url)).body.maintainers).toEqual([]);
  }, 90_000);
});
