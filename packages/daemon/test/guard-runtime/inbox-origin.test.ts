// 105 号票：一次调用引出的待我处理事项（审批卡、交给我做、中断不确定）记下调用实际所在的会话。任务号记的是调用归属的任务，
// 不一定是会话的主人——多项目任务（17 号票）派到项目的工单由项目维护者做，调用记着那个多项目任务，却在项目维护者的会话里；
// 待我处理里"去看看 ›"按会话去（Web 的 state/inbox-jump.ts），这里只管记全、记对。
import { CHANNELS, maintainerChannel } from "@ergou/protocol";
import { describe, expect, test } from "vitest";
import { type CallOrigin, callInboxOrigin } from "../../src/guard-runtime/events.ts";

const base = { agentId: "a-1", source: "测试" };

describe("调用引出的事项记下会话", () => {
  test("秘书对话里的：秘书会话和那次调用，没有任务", () => {
    const origin: CallOrigin = { ...base, conversation: CHANNELS.secretary, taskId: null, stageId: null };
    expect(callInboxOrigin(origin, "call-1")).toEqual({ origin: { conversation: CHANNELS.secretary, toolCallId: "call-1" } });
  });

  test("任务自己的维护者做的：任务、它的会话、阶段", () => {
    const origin: CallOrigin = { ...base, conversation: maintainerChannel("tm-1"), taskId: "t-1", stageId: "2" };
    expect(callInboxOrigin(origin, "call-2")).toEqual({ origin: { taskId: "t-1", conversation: "maintainer:tm-1", toolCallId: "call-2", stageId: "2" } });
  });

  test("多项目任务派到项目的工单（项目维护者做）：记着那个多项目任务，会话是项目维护者的，归属里的项目也记上", () => {
    const origin: CallOrigin = {
      ...base,
      conversation: maintainerChannel("pm-1"),
      taskId: "t-multi",
      stageId: "3",
      messageScope: { taskId: "t-multi", stageId: "3", projectId: "p-1" },
    };
    expect(callInboxOrigin(origin, "call-3")).toEqual({ origin: { taskId: "t-multi", projectId: "p-1", conversation: "maintainer:pm-1", toolCallId: "call-3", stageId: "3" } });
  });

  test("项目维护者自己会话里的（不属于任务）：项目和会话", () => {
    const origin: CallOrigin = { ...base, conversation: maintainerChannel("pm-1"), taskId: null, stageId: null, messageScope: { projectId: "p-1" } };
    expect(callInboxOrigin(origin, "call-4")).toEqual({ origin: { projectId: "p-1", conversation: "maintainer:pm-1", toolCallId: "call-4" } });
  });
});
