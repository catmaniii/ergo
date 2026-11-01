// 运行时交给负责人的长通知在会话里折成一行，只改显示。这里查守护进程这一边：交给 agent 的还是全文、不多存东西；
// 阶段说明那一行照协议包的写法写，界面认得出是哪一步；历史分页带着"交给了 agent"（往上翻出来的老消息也折）。折起来怎么画在网页的测试里。
import path from "node:path";
import { letterKindOf, maintainerChannel, type MessageEventPayload, stageBriefOf } from "@ergo/protocol";
import { describe, expect, it, onTestFinished } from "vitest";
import { type AgentInputContext, prepareAgentInput } from "../../src/conversation/agent-input.ts";
import { historyPage } from "../../src/conversation/history.ts";
import { buildAgentNotice, buildMessage, SYSTEM_NOTICE_TAG } from "../../src/conversation/messages.ts";
import { conversationViews } from "../../src/conversation/views.ts";
import { openEventStore } from "../../src/events/event-store.ts";
import type { MediaStore } from "../../src/media/media-store.ts";
import type { StageHandoff } from "../../src/tasks/execution.ts";
import { noticeText, stageText } from "../../src/tasks/execution-tools.ts";
import { voicesView } from "../../src/voice-records/index.ts";
import { samplePlan } from "../helpers/plans.ts";
import { makeTempDir } from "../helpers/temp-dir.ts";

const CONVERSATION = maintainerChannel("tm-long");

const handoff = (extra: Partial<StageHandoff> = {}): StageHandoff => ({ stageId: "s2", title: "第一波实现", code: "3", layers: 5, plan: samplePlan(), grantInfo: {}, cwd: "D:/work/ledger", ...extra });

function openStore() {
  const store = openEventStore({ file: path.join(makeTempDir("ergo-long-notice-"), "ergo.db"), views: [...conversationViews, voicesView] });
  onTestFinished(() => store.close());
  return store;
}

describe("阶段说明那一行", () => {
  it("照协议包的写法写，界面取得到第几阶段和标题；并行的阶段号（1a）也一样", () => {
    expect(stageText(handoff()).split("\n")[0]).toBe("现在是第 3/5 阶段 s2「第一波实现」：");
    expect(stageBriefOf(stageText(handoff()))).toEqual({ code: "3", title: "第一波实现" });
    expect(stageBriefOf(stageText(handoff({ code: "1a", title: "要点「一」和「二」" })))).toEqual({ code: "1a", title: "要点「一」和「二」" });
  });

  it("开始执行、用户让这一支接着做、验收通过换下一个阶段的通知里都有这一行；不交代阶段的通知没有", () => {
    const next = handoff();
    for (const text of [noticeText.started({ id: "t-1", title: "记账" }, next), noticeText.userAccepted({ stageId: "s1", title: "收集" }, next), `${noticeText.branchResumed([{ stageId: "s2", title: "第一波实现", waitNote: "用量超过预算" }])}\n${stageText(next)}`]) {
      expect(stageBriefOf(text)).toEqual({ code: "3", title: "第一波实现" });
    }
    expect(stageBriefOf(noticeText.resumed(false))).toBeUndefined();
  });
});

describe("只改显示", () => {
  it("交给 agent 的输入还是全文，消息上不多存总结，界面按长度认出它是要折的", async () => {
    const store = openStore();
    const text = `${noticeText.branchResumed([{ stageId: "s2", title: "第一波实现", waitNote: "用量超过预算" }])}\n${stageText(handoff())}`;
    const { message, event } = buildAgentNotice(CONVERSATION, text, "k-long");
    store.append(event);

    expect(message.parts).toEqual([{ type: "text", text }]);
    expect(message.summary).toBeUndefined();
    expect((event.payload as MessageEventPayload).agentInput).toBe(true);
    expect(letterKindOf(message, true)).toBe("notice");

    const ctx: AgentInputContext = { store, media: {} as MediaStore, timeZone: "Asia/Shanghai", vision: false };
    const input = await prepareAgentInput(ctx, message);
    // 开头是系统通知的标记和时间标记，后面一字不差是全文
    expect(input.text.startsWith(`${SYSTEM_NOTICE_TAG}\n`)).toBe(true);
    expect(input.text.endsWith(text)).toBe(true);
    for (const section of ["现在是第 3/5 阶段", "- 交付件：", "- 验收标准：", "授权（只在当前阶段内有效）：", "时序规则：", "边界：", "做完调用 complete_stage"]) expect(input.text).toContain(section);
  });
});

describe("历史分页", () => {
  it("交给 agent 的通知带着 agentInput（往上翻出来的老消息也折），只给人看的说明没有", () => {
    const store = openStore();
    store.append(buildAgentNotice(CONVERSATION, "交给 agent 的通知", "k-notice").event);
    store.append(buildMessage({ conversation: CONVERSATION, speaker: "system", parts: [{ type: "text", text: "只给人看的说明" }] }, { idempotencyKey: "k-note" }).event);
    const { messages } = historyPage(store, CONVERSATION, {});
    expect(messages.map((m) => ("agentInput" in m ? m.agentInput : undefined))).toEqual([true, undefined]);
  });
});
