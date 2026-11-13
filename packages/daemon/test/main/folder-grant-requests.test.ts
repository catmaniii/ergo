// 主切面：agent 自己申请目录授权（464）。真实装配路径（startTestDaemon），假模型；申请的目录是临时目录。
// - 个人助理调 request_folder_grant：卡出在它自己的会话里（只有卡片引用的一条）、进待办，这一轮不等结果接着说完；
//   用户收窄（只给读、改成长期有效）后同意：登记成"它申请、你同意的"，结果作为通知交回它、它接着做一轮；
// - 不同意：不登记，附的那句话交回它；
// - 负责人的会话里也有这个工具（起草计划的会话），子 agent 不在这里测（单元测试）。
import fs from "node:fs";
import path from "node:path";
import { CHANNELS, type FolderGrantRequestCardPayload, type FolderGrantsView, HTTP_PATHS, maintainerChannel } from "@ergo/protocol";
import { describe, expect, it } from "vitest";
import type { SpawnAgentRequest } from "../../src/agent-manager/agent-manager.ts";
import { startTestDaemon } from "../helpers/daemon.ts";
import { TestFrontend } from "../helpers/frontend.ts";
import { requestJson } from "../helpers/http.ts";
import { submitPlanStep } from "../helpers/plans.ts";
import { call, cardWhere, inboxOf, inputsDone, itemWhere, messagesOf, noticesOf, ok, real, say, textOf, turnsOf, twoStagePlan } from "../helpers/task-flow.ts";
import { makeTempDir } from "../helpers/temp-dir.ts";

const SECRETARY = CHANNELS.secretary;
const ALL = { [SECRETARY]: 0, [CHANNELS.cards]: 0, [CHANNELS.inbox]: 0 };

const grantsOf = async (url: string) => (await requestJson<FolderGrantsView>(url, HTTP_PATHS.folderGrants)).body;

describe("agent 申请目录授权", () => {
  it("个人助理申请：卡在它的会话里、进待办；收窄后同意只登记勾着的，结果交回它接着做", { timeout: 90_000 }, async () => {
    const notes = real(makeTempDir("ergo-grant-request-"));
    fs.writeFileSync(path.join(notes, "a.txt"), "笔记");
    const td = await startTestDaemon({
      secretary: [call("request_folder_grant", { path: notes, modes: ["read", "write"], days: 7, why: "整理读书笔记" }), say("申请卡发给你了，点同意我就开始"), say("好，开始整理")],
    });
    const frontend = await TestFrontend.connect(td.url);
    await frontend.subscribe(ALL);

    await frontend.sendText("把笔记整理一下");
    const card = await cardWhere(frontend, (c) => c.type === "folder_grant_request" && c.status === "pending", "目录授权申请卡");
    expect(card.payload).toMatchObject({ agentId: "secretary", path: notes, modes: ["read", "write"], days: 7, why: "整理读书笔记" } satisfies Partial<FolderGrantRequestCardPayload>);
    // 这一轮不等结果，接着说完
    await turnsOf(frontend, SECRETARY, 1);
    // 卡出在它自己的会话里，进待办
    expect(messagesOf(frontend, SECRETARY).some((m) => m.message.parts.some((p) => p.type === "card_ref" && p.cardId === card.id))).toBe(true);
    await itemWhere(frontend, (item) => item.kind === "card" && item.cardId === card.id, "待办里的申请卡");
    // 只是发卡：还没登记
    expect((await grantsOf(td.url)).grants).toEqual([]);

    ok(await frontend.cardAction({ cardId: card.id, action: "approve", expectedVersion: card.version, input: { modes: ["read"], days: null }, note: "先只看" }));
    const view = await grantsOf(td.url);
    expect(view.grants).toMatchObject([{ agentId: "secretary", path: notes, modes: ["read"], note: "整理读书笔记", addedBy: "request", state: "active" }]);
    expect(view.grants[0]!.expiresAt).toBeUndefined();
    // 结果作为通知交回它，它接着做一轮
    await turnsOf(frontend, SECRETARY, 2);
    const notice = noticesOf(frontend, SECRETARY).map(textOf).find((text) => text.includes("用户同意了你申请的目录授权"));
    expect(notice).toContain(notes);
    expect(notice).toContain("先只看");
    expect(inboxOf(frontend).some((item) => item.kind === "card" && item.cardId === card.id)).toBe(true);
  });

  it("不同意：不登记，附的那句话交回它", { timeout: 90_000 }, async () => {
    const notes = real(makeTempDir("ergo-grant-request-"));
    const td = await startTestDaemon({
      secretary: [call("request_folder_grant", { path: notes, modes: ["delete"], why: "删掉重复的笔记" }), say("申请了"), say("好，不删")],
    });
    const frontend = await TestFrontend.connect(td.url);
    await frontend.subscribe(ALL);
    await frontend.sendText("把重复的笔记删了");
    const card = await cardWhere(frontend, (c) => c.type === "folder_grant_request" && c.status === "pending", "目录授权申请卡");
    await turnsOf(frontend, SECRETARY, 1);
    ok(await frontend.cardAction({ cardId: card.id, action: "deny", expectedVersion: card.version, note: "重复的我自己看" }));
    await turnsOf(frontend, SECRETARY, 2);
    expect((await grantsOf(td.url)).grants).toEqual([]);
    const notice = noticesOf(frontend, SECRETARY).map(textOf).find((text) => text.includes("用户没同意"));
    expect(notice).toContain("重复的我自己看");
  });

  it("任务的负责人也有这个工具（起草计划的会话里）", { timeout: 90_000 }, async () => {
    const td = await startTestDaemon({ secretary: [], maintainer: (_id, spawn) => (spawn === 1 ? [submitPlanStep(twoStagePlan()), say("交了")] : [say("好")]) });
    const spawned: SpawnAgentRequest[] = [];
    const original = td.daemon.agents.spawn.bind(td.daemon.agents);
    td.daemon.agents.spawn = (request) => {
      spawned.push(request);
      return original(request);
    };
    const frontend = await TestFrontend.connect(td.url);
    await frontend.subscribe({ [CHANNELS.cards]: 0, [maintainerChannel("tm-1")]: 0 });
    const task = td.daemon.tasks.createByRequest({ title: "调研", summary: "调研" });
    td.daemon.tasks.writeBrief(task.id, { goal: "整理一份 X 的调研", acceptanceCriteria: ["附来源"], constraints: [], projects: [], memoryScope: "" });
    await cardWhere(frontend, (c) => c.type === "plan", "计划卡");
    await inputsDone(frontend, maintainerChannel("tm-1"));
    const tools = spawned.find((r) => r.agentId === "tm-1")?.hostTools?.map((t) => t.name) ?? [];
    expect(tools).toContain("request_folder_grant");
  });
});
