// 115 号票：agent 之间的来信（秘书会话里的任务做完、维护者来信，维护者会话里的秘书转达，运行时补给维护者的计划检查）在会话里
// 只显示一行——图标、种类、一句话总结、时间、"详情 ›"——点开看全文（照 Markdown 画）；交给 agent 的照旧是全文（守护进程测）。
// 先回放主切面录下的真实事件流：task-done-voice（定时任务跑完自动播报，通知后面跟着运行时放的日报附件）、
// secretary-letter（普通任务的 agent 做到一半给秘书发一条、接着做完）；旧消息（没存总结）、秘书转达、不折的那些按共享协议的 schema 构造。
// 367 号票：运行时交给 agent 的长通知没有标记也折；用户截图里那一段做测试数据，再回放一遍 task-execution 看真的阶段说明。
import fs from "node:fs";
import path from "node:path";
import { MessageEventPayload as MessageEventPayloadSchema, schemaChecker } from "@ergo/protocol";
import { describe, expect, test } from "vitest";
import {
  type ChatItem,
  chatItems,
  type ConversationId,
  chatLook,
  detailContent,
  type EventFrame,
  fileCards,
  LETTER_LOOK,
  LETTER_TAGS,
  letterMarkdown,
  locateChatItem,
  type MessageEnvelope,
  type MessageEventPayload,
  type MessagePart,
  relayLabel,
  replay,
  stageChatShown,
  type UiInput,
} from "../../src/state/index.ts";
import { frame } from "./events.ts";

const SECRETARY = "secretary";
const TM: ConversationId = "maintainer:tm-9";
const TM1: ConversationId = "maintainer:tm-1";

function load(name: string): UiInput[] {
  return JSON.parse(fs.readFileSync(path.join(import.meta.dirname, "recordings", `${name}.json`), "utf8")) as UiInput[];
}

const checkMessage = schemaChecker(MessageEventPayloadSchema);
/** 一条消息事件（按共享协议的 schema 构造，不合就让测试先红） */
function messageFrame(conversation: ConversationId, seq: number, message: Omit<MessageEnvelope, "conversation" | "time">, extra: Omit<MessageEventPayload, "message"> = {}): EventFrame {
  const payload: MessageEventPayload = { message: { ...message, conversation, time: `2026-10-13T08:0${seq}:00.000+08:00` }, ...extra };
  const problem = checkMessage.firstError(payload);
  if (problem) throw new Error(`构造的事件不合 schema：${problem}`);
  return frame(conversation, seq, "message", payload);
}
const text = (t: string): MessagePart => ({ type: "text", text: t });
/** 条目的种类、要点那一行、来信的种类（不是来信的写 -） */
const lines = (items: readonly ChatItem[]) => items.map((it) => [it.kind, it.keyLine, letterOf(it)?.kind ?? "-"]);
const letterOf = (it: ChatItem) => (it.kind === "system" || it.kind === "user" ? it.letter : undefined);

describe("回放：定时任务跑完自动播报，通知后面跟着日报附件（task-done-voice）", () => {
  const inputs = load("task-done-voice");
  const state = replay(inputs);
  const items = chatItems(state, SECRETARY);
  const notice = items.find((it) => letterOf(it) !== undefined)!;
  const SUMMARY = "t-1「每天出 AI 新闻日报」第 1 次运行做完了，交了 1 个文件";

  test("任务做完的通知折成一行：图标、种类、运行时拼的一句话总结，整行点开详情；要点层那一行写种类和总结，底色照旧是说明和记录", () => {
    expect(letterOf(notice)).toEqual({ kind: "task_done", ...LETTER_LOOK.task_done, summary: SUMMARY });
    expect(LETTER_LOOK.task_done).toEqual({ label: "任务做完", icon: "✅" });
    expect(notice).toMatchObject({ kind: "system", keyLine: `任务做完：${SUMMARY}`, content: "context", detail: "text" });
    expect(chatLook(notice)).toEqual({ form: "letter", letter: letterOf(notice), open: "row" });
    // 秘书的会话：通知、语音气泡（回复收进了气泡，工具调用不算）、附件（118 号票起挪到秘书这一轮的回复后面）
    expect(lines(items).map(([kind, , letter]) => `${kind} ${letter}`)).toEqual(["system task_done", "voice -", "system -"]);
  });

  test("紧跟在通知后面的附件（运行时放的，不是来信，不折；显示在秘书的回复后面）：日报是一张能预览的 MD 卡，点图标去报告页", () => {
    const attached = items[2]!;
    expect(attached).toMatchObject({ kind: "system", keyLine: "系统：[附件：ai-news.md]" });
    if (attached.kind !== "system") throw new Error("不是系统消息");
    expect(attached.letter).toBeUndefined();
    expect(chatLook(attached)).toEqual({ form: "note", open: "whole" });
    const files = attached.parts.flatMap((p) => (p.type === "file" ? [p] : []));
    expect(fileCards(files)).toMatchObject([{ label: "MD", category: "doc", title: "ai-news.md", preview: "text/markdown", iconAction: "preview" }]);
  });

  test("点详情：全文就是交给秘书的那段（照 Markdown 画），种类写“任务做完”，上面一行是总结", () => {
    const content = detailContent(state, items, { type: "item", id: notice.id });
    expect(content).toMatchObject({ kind: "text", tag: "system", label: "任务做完", letter: "task_done", summary: SUMMARY, markdown: true });
    if (content.kind !== "text") throw new Error("不是文本详情");
    expect(content.text.startsWith(`${LETTER_TAGS.task_done}【跑完自动播报】后台有一件事做完了`)).toBe(true);
    expect(content.text).toContain("它最后说：\n日报写好了：ai-news.md，三条要闻\n");
    expect(content.chars).toBe(content.text.length);
  });

  test("旧消息（115 号票之前交的，没存总结）照样折：总结取正文去掉标记、跳过引子之后的第一句，截到 30 字", () => {
    const old = replay(
      inputs.map((input) => {
        if (input.kind !== "frame" || input.frame.channel !== SECRETARY || input.frame.type !== "message") return input;
        const { summary: _dropped, ...message } = (input.frame.payload as MessageEventPayload).message;
        return { ...input, frame: { ...input.frame, payload: { ...(input.frame.payload as MessageEventPayload), message } } };
      }),
    );
    const oldNotice = chatItems(old, SECRETARY)[0]!;
    expect(letterOf(oldNotice)).toMatchObject({ kind: "task_done", summary: "定时触发的普通任务 t-1「每天出 AI 新闻日报」的第…" });
    expect(oldNotice.keyLine).toBe("任务做完：定时触发的普通任务 t-1「每天出 AI 新闻日报」的第…");
  });
});

describe("回放：普通任务的 agent 做到一半给秘书发一条、接着做完（secretary-letter）", () => {
  const state = replay(load("secretary-letter"));
  const items = chatItems(state, SECRETARY);

  test("两条各折成一行：维护者来信显示它给的总结，任务做完显示运行时拼的；秘书的两段回复照常", () => {
    expect(lines(items)).toEqual([
      ["system", "维护者来信：先下了 mp3", "maintainer_letter"],
      ["system", "任务做完：t-1「去把《晴天》的音频下下来」做完了", "task_done"],
      ["reply", "回复：它说先下了 mp3，问你要不要 flac。要我念给你听吗？", "-"],
      ["reply", "回复：《晴天》下好了，要我念给你听吗？", "-"],
    ]);
    expect(letterOf(items[0]!)).toEqual({ kind: "maintainer_letter", label: "维护者来信", icon: "✉️", summary: "先下了 mp3" });
    expect(items.slice(0, 2).map((it) => chatLook(it).form)).toEqual(["letter", "letter"]);
  });

  test("点开维护者来信：全文是谁说的、原话，和要秘书怎么做", () => {
    const content = detailContent(state, items, { type: "item", id: items[0]!.id });
    expect(content).toMatchObject({ kind: "text", label: "维护者来信", summary: "先下了 mp3", markdown: true });
    if (content.kind !== "text") throw new Error("不是文本详情");
    expect(content.text).toContain("普通任务 t-1「去把《晴天》的音频下下来」的维护者说：\n先下了 mp3；要 flac 的话在任务里跟我说一声。");
  });
});

/** 秘书转达进维护者会话的一句（发言方是用户、标着 relayedBy；summary 是守护进程存的总结，旧消息没有） */
const relayed = (seq: number, id: string, said: string, summary?: string) =>
  messageFrame(TM, seq, { id, speaker: "user", parts: [text(said)], relayedBy: "secretary", ...(summary === undefined ? {} : { summary }) }, { taskId: "t-9" });

describe("秘书转达的话（103 号票的那一句）", () => {
  test("维护者会话里折成一行，种类写“<名字>转达”：总结是守护进程存的（转达的话的第一句）；旧的没存的取第一句", () => {
    const state = replay([
      { kind: "frame", frame: messageFrame(TM, 1, { id: "u1", speaker: "user", parts: [text("先写结论部分")] }, { taskId: "t-9" }) },
      { kind: "frame", frame: relayed(2, "r1", "以后把 GitHub 热门也加上。每天放在最后", "以后把 GitHub 热门也加上") },
      { kind: "frame", frame: relayed(3, "r2", "早报里的天气\n换成北京的") },
    ]);
    const items = chatItems(state, TM);
    expect(lines(items)).toEqual([
      ["user", "你：先写结论部分", "-"],
      ["user", `${relayLabel()}：以后把 GitHub 热门也加上`, "secretary_relay"],
      ["user", `${relayLabel()}：早报里的天气`, "secretary_relay"],
    ]);
    expect(letterOf(items[1]!)).toEqual({ kind: "secretary_relay", label: relayLabel(), icon: "📨", summary: "以后把 GitHub 热门也加上" });
    expect(chatLook(items[0]!)).toEqual({ form: "user", open: "whole" });
    expect(chatLook(items[1]!)).toMatchObject({ form: "letter", open: "row" });
    // 底色照旧是用户输入（是用户的意思，经秘书转来）
    expect(items[1]!.content).toBe("user");
    expect(detailContent(state, items, { type: "item", id: "r2" })).toMatchObject({ kind: "text", tag: "user", label: relayLabel(), letter: "secretary_relay", summary: "早报里的天气", text: "早报里的天气\n换成北京的" });
    // 用户自己打的照旧：详情里没有总结
    expect(detailContent(state, items, { type: "item", id: "u1" })).toMatchObject({ kind: "text", label: "用户输入", letter: undefined, summary: undefined, markdown: false });
  });
});

describe("哪些折、哪些照旧整段显示", () => {
  test("写给 agent 看、开头带标记的运行时通知折（计划检查）；给用户看的说明、没有标记的通知、agent 说的、工单分隔线照旧", () => {
    const state = replay(
      [
        messageFrame(TM, 1, { id: "s1", speaker: "system", parts: [text("计划已确认，开始执行。")] }),
        messageFrame(TM, 2, { id: "s2", speaker: "system", parts: [{ type: "work_order_divider", workOrderId: "wo-1", title: "整理照片", from: "任务 t-9" }] }),
        messageFrame(TM, 3, { id: "s3", speaker: "system", parts: [text(`${LETTER_TAGS.plan_check}已授权的计划里还有 s3「发周报」既没有执行，也没有报告跳过。请继续按计划执行`)] }, { agentInput: true }),
        messageFrame(TM, 4, { id: "s4", speaker: "system", parts: [text("项目「记账本」里交出去的一件事（项目内部的普通任务）做完了。你看不到它的细节")] }, { agentInput: true }),
        messageFrame(TM, 5, { id: "a1", speaker: "agent", parts: [text(`${LETTER_TAGS.maintainer_letter}这是 agent 自己说的`)] }),
        messageFrame(TM, 6, { id: "s5", speaker: "system", parts: [{ type: "card_ref", cardId: "c-1" }, text(`${LETTER_TAGS.task_done}卡片后面的字`)] }),
      ].map((f): UiInput => ({ kind: "frame", frame: f })),
    );
    expect(lines(chatItems(state, TM))).toEqual([
      ["system", "系统：计划已确认，开始执行。", "-"],
      ["divider", "工单 wo-1「整理照片」", "-"],
      ["system", "计划检查：已授权的计划里还有 s3「发周报」既没有执行，也没有报告跳过", "plan_check"],
      ["system", "系统：项目「记账本」里交出去的一件事（项目内部的普通任务）做完了。你看不到它的细节", "-"],
      ["reply", `回复：${LETTER_TAGS.maintainer_letter}这是 agent 自己说的`, "-"],
      ["card", "卡片", "-"],
      ["system", `系统：${LETTER_TAGS.task_done}卡片后面的字`, "-"],
    ]);
    expect(LETTER_LOOK.plan_check).toEqual({ label: "计划检查", icon: "📋" });
  });
});

describe("详情里全文照 Markdown 画（letterMarkdown）", () => {
  test("运行时写的单个换行照样分行（行尾加硬换行）；空行、代码块里的不动", () => {
    expect(letterMarkdown("普通任务 t-1「下歌」在后台做完了。\n它最后说：\n下好了")).toBe("普通任务 t-1「下歌」在后台做完了。  \n它最后说：  \n下好了");
    expect(letterMarkdown("第一段\n\n第二段")).toBe("第一段\n\n第二段");
    expect(letterMarkdown("看这段：\n```\nls -l\ncat a.md\n```\n完")).toBe("看这段：  \n```\nls -l\ncat a.md\n```\n完");
  });

  test("列表后面紧跟不缩进的一行（367 号票）：隔一个空行，免得并进上一项；缩进的续行、项与项之间不动", () => {
    expect(letterMarkdown("授权：\n- （没有）\n时序规则：\n- 一条\n- 两条\n完")).toBe("授权：  \n- （没有）\n\n时序规则：  \n- 一条  \n- 两条\n\n完");
    expect(letterMarkdown("- 一条\n  接着写\n- 两条")).toBe("- 一条  \n  接着写  \n- 两条");
    expect(letterMarkdown("1. 一条\n2. 两条\n完")).toBe("1. 一条  \n2. 两条\n\n完");
  });
});

/** 用户截图里那一段（2026-11-01）：运行时让负责人接着做第 3 阶段时交给它的阶段说明，占满一屏 */
const STAGE_NOTICE = [
  "用户让阶段 s3「第一波实现」接着做（之前停下是因为：用量超过预算）。看看用户在会话里说了什么，换个做法接着做；计数已经清零。",
  "现在是第 3/5 阶段 s3「第一波实现」：",
  "- 交付件：导入脚本 import.py；单元测试 tests/test_import.py",
  "- 验收标准：三家银行的账单都能导入（脚本：pytest tests/test_import.py）；重复的流水不入账（评审）",
  "- 模式：开放",
  "授权（只在当前阶段内有效）：",
  "- （没有）",
  "时序规则：",
  "- 先备份再改账目：写 ledger.db 之前先有当天的备份",
  "边界：",
  "- 工作目录 projects/ledger：文件工具只能写这里；工具包：bash 开，联网关",
  "- 一个阶段做完调用 complete_stage 宣布完成，由运行时验收（脚本、评审、用户），你自检不算验收",
  "做完调用 complete_stage 宣布阶段完成，由运行时验收。",
].join("\n");

const LONG = "字".repeat(121);
const frames = (...list: EventFrame[]) => replay(list.map((f): UiInput => ({ kind: "frame", frame: f })));

describe("交给 agent 的长通知折成一行（367 号票）", () => {
  const state = frames(messageFrame(TM, 1, { id: "n1", speaker: "system", parts: [text(STAGE_NOTICE)] }, { agentInput: true, taskId: "t-9", stageId: "s3" }));
  const items = chatItems(state, TM);
  const notice = items[0]!;

  test("截图那一段：对话层一行，总结写清楚是哪一步，整行点开", () => {
    expect(letterOf(notice)).toEqual({ kind: "notice", label: "系统说明", icon: LETTER_LOOK.notice.icon, summary: "接着做第 3 阶段：第一波实现" });
    expect(chatLook(notice)).toEqual({ form: "letter", letter: letterOf(notice), open: "row" });
  });

  test("点详情：全文原样，种类写系统说明，上面一行是总结，照 Markdown 画", () => {
    const content = detailContent(state, items, { type: "item", id: notice.id });
    expect(content).toMatchObject({ kind: "text", tag: "system", label: "系统说明", letter: "notice", summary: "接着做第 3 阶段：第一波实现", markdown: true, text: STAGE_NOTICE, chars: STAGE_NOTICE.length });
  });

  test("缩放的要点层、全局层不受影响：要点那一行照旧是第一行，底色还是说明和记录", () => {
    expect(notice.keyLine.startsWith("系统：用户让阶段 s3「第一波实现」接着做（之前停下是因为：用量超过预算）")).toBe(true);
    expect(notice.keyLine).not.toContain("交付件");
    expect(notice.content).toBe("context");
  });

  test("定位跳转照常：按消息 id 找得到折起来的那条；任务的会话里照旧收进阶段框", () => {
    expect(locateChatItem(items, "n1")?.item).toBe(notice);
    expect(stageChatShown(state, notice)).toBe(false);
  });

  test("认不出是哪一步的取第一句；守护进程存了总结的用存的", () => {
    const other = frames(
      messageFrame(TM, 1, { id: "n1", speaker: "system", parts: [text(`项目服务挂了，上一次心跳是 10 分钟前。\n${LONG}`)] }, { agentInput: true }),
      messageFrame(TM, 2, { id: "n2", speaker: "system", parts: [text(STAGE_NOTICE)], summary: "存着的总结" }, { agentInput: true }),
    );
    expect(chatItems(other, TM).map((it) => letterOf(it)?.summary)).toEqual(["项目服务挂了，上一次心跳是 10 分钟前", "存着的总结"]);
  });

  test("短通知不折；用户的话、agent 的回复、没交给 agent 的说明再长也不折", () => {
    const other = frames(
      messageFrame(TM, 1, { id: "s1", speaker: "system", parts: [text("用户让任务继续了。接着做。")] }, { agentInput: true }),
      messageFrame(TM, 2, { id: "u1", speaker: "user", parts: [text(LONG)] }),
      messageFrame(TM, 3, { id: "a1", speaker: "agent", parts: [text(LONG)] }),
      messageFrame(TM, 4, { id: "s2", speaker: "system", parts: [text(LONG)] }),
    );
    const list = chatItems(other, TM);
    expect(list.map((it) => [it.kind, letterOf(it)?.kind ?? "-", chatLook(it).form])).toEqual([
      ["system", "-", "note"],
      ["user", "-", "user"],
      ["reply", "-", "reply"],
      ["system", "-", "note"],
    ]);
  });

  test("老消息：往上翻取回来的那一页按 agentInput 和长度一样折", () => {
    const paged = replay([
      {
        kind: "history_page",
        conversation: TM,
        page: {
          conversation: TM,
          hasMore: false,
          records: [],
          messages: [
            { seq: 1, message: { id: "old-1", conversation: TM, speaker: "system", time: "2026-09-01T08:00:00.000+08:00", parts: [text(STAGE_NOTICE)] }, agentInput: true, taskId: "t-9" },
            { seq: 2, message: { id: "old-2", conversation: TM, speaker: "system", time: "2026-09-01T08:01:00.000+08:00", parts: [text(LONG)] }, taskId: "t-9" },
          ],
        },
      },
    ]);
    expect(chatItems(paged, TM).map((it) => letterOf(it)?.kind ?? "-")).toEqual(["notice", "-"]);
  });

  test("秘书的会话一样", () => {
    const own = frames(messageFrame(SECRETARY, 1, { id: "n1", speaker: "system", parts: [text(LONG)] }, { agentInput: true }));
    expect(chatLook(chatItems(own, SECRETARY)[0]!).form).toBe("letter");
  });

});

describe("回放：长程任务开始执行、验收通过换下一个阶段（task-execution）", () => {
  const state = replay(load("task-execution"));
  const items = chatItems(state, TM1);
  const notices = items.filter((it) => letterOf(it)?.kind === "notice");

  test("真的阶段说明折起来，总结是哪一步；短的通知不折；要点那一行照旧", () => {
    expect(notices.length).toBeGreaterThan(0);
    // 任务书也是交给负责人的长通知：总结取第一句，还留在对话层（不收进阶段框）
    const brief = notices[0]!;
    expect(letterOf(brief)?.summary).toBe("任务书：任务 t-1「X 的调研」");
    expect(stageChatShown(state, brief)).toBe(true);
    const first = notices[1]!;
    expect(letterOf(first)?.summary).toBe("接着做第 1 阶段：收集资料");
    expect(first.keyLine).toContain("系统：计划已确认，开始执行任务 t-1「X 的调研」");
    const content = detailContent(state, items, { type: "item", id: first.id });
    if (content.kind !== "text") throw new Error("不是文本详情");
    expect(content.text).toContain("现在是第 1/2 阶段 s1「收集资料」：\n- 交付件：资料清单 sources.md");
    expect(content.text).toContain("边界：\n- 工作目录");
  });
});
