// 主切面：秘书和待我处理、承诺即任务（规格第 7 节，22 号票）。秘书接 faux 剧本：
// - 用户问到待我处理时，秘书用只读工具列出未处理的事项，用"放进聊天"把同一张卡放进聊天：聊天里显示的就是那张卡
//   （同一 id、同一状态），在聊天里点按钮后，待我处理里这张卡同步变为已处理；
// - 待我处理新增事项本身不进秘书的模型输入（不主动转述）；秘书的工具里没有任何对卡片做动作的工具；
// - 用户要秘书去做一件需要任务的事（"以后每天早上给我出一份简报"），秘书同一轮里直接建任务（规划中），不出建议卡；
//   秘书没有建定时作业的工具；固定的系统提示写明承诺即任务的三条。
import { type Card, type CardEventPayload, CHANNELS, EVENT_TYPES, type InboxItem, type InboxItemEventPayload, type MessageEventPayload, type PlanCardPayload } from "@ergou/protocol";
import { describe, expect, it } from "vitest";
import type { FauxStep } from "../../src/runtime/index.ts";
import { SECRETARY_SYSTEM_PROMPT } from "../../src/secretary/system-prompt.ts";
import { startTestDaemon } from "../helpers/daemon.ts";
import { stripTimeMarkers } from "../helpers/echo.ts";
import { TestFrontend } from "../helpers/frontend.ts";
import { eventually, maintainerScript, ok, tasksOf } from "../helpers/running-task.ts";

const { secretary: SECRETARY, cards: CARDS, board: BOARD, inbox: INBOX } = CHANNELS;
const ECHO: FauxStep = { kind: "echo_context" };
const call = (name: string, args: Record<string, unknown> = {}): FauxStep => ({ kind: "reply", toolCalls: [{ name, arguments: args as never }] });

async function connect(url: string) {
  const frontend = await TestFrontend.connect(url);
  await frontend.subscribe({ [SECRETARY]: 0, [CARDS]: 0, [BOARD]: 0, [INBOX]: 0 });
  return frontend;
}

const messages = (frontend: TestFrontend) => frontend.events({ channel: SECRETARY, type: EVENT_TYPES.message }).map((f) => (f.payload as MessageEventPayload).message);

/** 用户说一句话，等秘书这一轮结束，返回秘书最后一条文字回复（echo_context 回显时是它收到的模型输入，去掉时间标记） */
async function tell(frontend: TestFrontend, text: string): Promise<string> {
  await frontend.sendText(text);
  const n = messages(frontend).filter((m) => m.speaker === "user").length;
  await eventually(() => frontend.events({ channel: SECRETARY, type: EVENT_TYPES.turnEnd }), () => frontend.events({ channel: SECRETARY, type: EVENT_TYPES.turnEnd }).length >= n, `秘书处理完「${text}」`);
  const last = messages(frontend).filter((m) => m.speaker === "agent" && m.parts.some((p) => p.type === "text")).at(-1);
  return stripTimeMarkers(last?.parts.map((p) => (p.type === "text" ? p.text : "")).join("") ?? "");
}

const cardsOf = (frontend: TestFrontend): Card[] => frontend.events({ channel: CARDS, type: EVENT_TYPES.card }).map((f) => (f.payload as CardEventPayload).card);
const inboxOf = (frontend: TestFrontend): InboxItem[] => frontend.events({ channel: INBOX, type: EVENT_TYPES.inboxItem }).map((f) => (f.payload as InboxItemEventPayload).item);
const toolResultOf = (context: string, tool: string) => context.slice(context.lastIndexOf(`[toolResult] ${tool}: `) + `[toolResult] ${tool}: `.length).split("\n[")[0]!;

/** 秘书的全部工具（echo_context 回显的 [tool] 行）：没有任何对卡片做动作的，也没有建定时作业的 */
const SECRETARY_TOOLS = [
  "bash",
  "cancel_reminder",
  "create_reminder",
  "create_task",
  "edit",
  "list_inbox",
  "ls",
  "propose_quick_action",
  "read",
  "read_attachment",
  "read_project_records",
  "search_materials",
  "send_attachment",
  "show_card",
  "suggest_project",
  "suggest_task",
  "update_reminder",
  "view_board",
  "write",
  "write_task_brief",
  "ask_questions",
  // 32 号票：每个会话都有的口语总结（用户发语音时用）
  "spoken_summary",
].toSorted();

describe("待我处理", () => {
  it("问到待我处理：秘书列出未处理的事项，把同一张卡放进聊天；在聊天里点按钮后待我处理里同步变为已处理；新增事项不主动进秘书的模型输入", async () => {
    const td = await startTestDaemon({
      secretary: [
        ECHO,
        call("list_inbox"),
        { kind: "call_with_matches", toolCall: { name: "show_card", arguments: {} }, argument: "cardIds", pattern: "c-[0-9a-f-]{36}" },
        ECHO,
        call("list_inbox"),
        ECHO,
      ],
      maintainer: maintainerScript(),
    });
    const frontend = await connect(td.url);
    // 一张等用户确认的计划卡进了待我处理
    const task = td.daemon.tasks.createByRequest({ title: "整理发票", summary: "整理发票" });
    td.daemon.tasks.writeBrief(task.id, { goal: "整理发票", acceptanceCriteria: ["做完"], constraints: [], projects: [], memoryScope: "" });
    const plan = await eventually(() => cardsOf(frontend), (c) => c.type === "plan" && (c.payload as PlanCardPayload).taskId === task.id, "计划卡");
    const item = await eventually(() => inboxOf(frontend), (i) => i.kind === "card" && i.cardId === plan.id, "待我处理里的计划卡");

    // 不主动转述：秘书收到的模型输入里没有这条事项
    const first = await tell(frontend, "在吗");
    expect(first).not.toContain(item.title);
    expect(first).not.toContain(plan.id);
    // 秘书的工具：没有对卡片做动作的，没有建定时作业的
    expect(first.split("\n").filter((l) => l.startsWith("[tool] ")).map((l) => l.slice("[tool] ".length)).toSorted()).toEqual(SECRETARY_TOOLS);

    const second = await tell(frontend, "现在有什么等我处理的");
    const listed = toolResultOf(second, "list_inbox");
    expect(listed).toContain(`事项 ${item.id}：${item.title}`);
    expect(listed).toContain(`卡片 ${plan.id}`);
    expect(listed).toContain("卡住任务");
    // 聊天里出现的就是那张卡：同一 id、同一状态
    const refs = messages(frontend).flatMap((m) => m.parts.flatMap((p) => (p.type === "card_ref" ? [p.cardId] : [])));
    expect(refs).toEqual([plan.id]);
    expect(td.daemon.cards.get(plan.id)).toMatchObject({ id: plan.id, status: "pending", version: plan.version });
    expect(toolResultOf(second, "show_card")).toContain(plan.id);

    // 在聊天里点确认：待我处理里的同一张卡变为已处理
    ok(await frontend.cardAction({ cardId: plan.id, action: "confirm", expectedVersion: plan.version, input: {} }));
    await eventually(() => cardsOf(frontend), (c) => c.id === plan.id && c.status === "handled", "卡片已处理");
    expect(td.daemon.inbox.isProcessed(td.daemon.inbox.get(item.id)!)).toBe(true);
    await eventually(() => tasksOf(frontend), (e) => e.task.id === task.id && e.change === "plan_confirmed", "计划确认");

    // 再问：已经没有未处理的了
    const third = await tell(frontend, "还有吗");
    expect(toolResultOf(third, "list_inbox")).toBe("待我处理里没有还没处理的事项。");
  }, 90_000);
});

describe("承诺即任务", () => {
  it("用户要秘书去做一件需要任务的事：同一轮里直接建任务（规划中），看板频道推送，不出建议卡；系统提示写明承诺即任务的三条", async () => {
    const td = await startTestDaemon({
      secretary: [call("create_task", { title: "每日简报", summary: "以后每天早上给用户出一份简报" }), { kind: "reply", text: "建好了，先跟你对一下要点" }],
    });
    const frontend = await connect(td.url);
    await tell(frontend, "以后每天早上给我出一份简报");
    const created = await eventually(() => tasksOf(frontend), (e) => e.change === "created", "建出的任务");
    expect(created).toMatchObject({ by: "secretary", task: { title: "每日简报", state: "planning", origin: "request" } });
    expect(cardsOf(frontend).filter((c) => c.type === "suggest_task")).toEqual([]);

    // 承诺即任务的三条
    expect(SECRETARY_SYSTEM_PROMPT).toContain("只答应用户要你做的事");
    expect(SECRETARY_SYSTEM_PROMPT).toContain("答应了就当场建任务或简单提醒");
    expect(SECRETARY_SYSTEM_PROMPT).toContain("用户没要求的事只能给建议卡，不能口头答应");
  }, 60_000);
});
