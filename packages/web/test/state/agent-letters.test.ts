// 115 号票：agent 之间的来信（秘书会话里的任务做完、维护者来信，维护者会话里的秘书转达，运行时补给维护者的计划检查）在会话里
// 只显示一行——图标、种类、一句话总结、时间、"详情 ›"——点开看全文（照 Markdown 画）；交给 agent 的照旧是全文（守护进程测）。
// 先回放主切面录下的真实事件流：task-done-voice（定时任务跑完自动播报，通知后面跟着运行时放的日报附件）、
// secretary-letter（普通任务的 agent 做到一半给秘书发一条、接着做完）；旧消息（没存总结）、秘书转达、不折的那些按共享协议的 schema 构造。
import fs from "node:fs";
import path from "node:path";
import { MessageEventPayload as MessageEventPayloadSchema, schemaChecker } from "@ergou/protocol";
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
  type MessageEnvelope,
  type MessageEventPayload,
  type MessagePart,
  RELAY_LABEL,
  replay,
  type UiInput,
} from "../../src/state/index.ts";
import { frame } from "./events.ts";

const SECRETARY = "secretary";
const TM: ConversationId = "maintainer:tm-9";

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
      ["user", `${RELAY_LABEL}：以后把 GitHub 热门也加上`, "secretary_relay"],
      ["user", `${RELAY_LABEL}：早报里的天气`, "secretary_relay"],
    ]);
    expect(letterOf(items[1]!)).toEqual({ kind: "secretary_relay", label: RELAY_LABEL, icon: "📨", summary: "以后把 GitHub 热门也加上" });
    expect(chatLook(items[0]!)).toEqual({ form: "user", open: "whole" });
    expect(chatLook(items[1]!)).toMatchObject({ form: "letter", open: "row" });
    // 底色照旧是用户输入（是用户的意思，经秘书转来）
    expect(items[1]!.content).toBe("user");
    expect(detailContent(state, items, { type: "item", id: "r2" })).toMatchObject({ kind: "text", tag: "user", label: RELAY_LABEL, letter: "secretary_relay", summary: "早报里的天气", text: "早报里的天气\n换成北京的" });
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
      ["divider", "工单 wo-1 · 整理照片", "-"],
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
});
