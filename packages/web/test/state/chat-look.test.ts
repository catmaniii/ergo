// 聊天区精简（57 号票）：对话层里每一条长什么样（state/chat-look.ts 的 chatLook）。
// 先回放主切面录下的真实事件流（任务的维护者会话、秘书会话、项目的维护者会话），覆盖各种条目的显示形态：
// 工具调用组是一行"调用了 N 个工具"加小签（出了状况的醒目），思考一行"💭 Agent 的想法（点开看）"，回复切出第一段、
// 有后文才给"展开 / 详情"，用户气泡和说明整条可点，语音在长按菜单里；录像覆盖不到的（多段的回复、正在想、执行中、
// 等你批准、命中关注类别但直接做只记录）按共享协议的 schema 构造事件。
import fs from "node:fs";
import path from "node:path";
import { MessageEventPayload as MessageEventPayloadSchema, schemaChecker } from "@ergou/protocol";
import { describe, expect, test } from "vitest";
import {
  type ChatItem,
  type ChatLook,
  chatItems,
  chatLook,
  type EventFrame,
  locateChatItem,
  type MessageEnvelope,
  type MessagePart,
  REPLY_OPEN_BY_DEFAULT,
  replay,
  replyCut,
  THINKING_LABEL,
  THINKING_LIVE_LABEL,
  type UiInput,
  type ZoomBlock,
  zoomBlocks,
} from "../../src/state/index.ts";
import { frame } from "./events.ts";

function load(name: string): UiInput[] {
  return JSON.parse(fs.readFileSync(path.join(import.meta.dirname, "recordings", `${name}.json`), "utf8")) as UiInput[];
}

const looks = (items: readonly ChatItem[]) => items.map(chatLook);

/** 一条的样子写成一个短串：种类，工具调用那一行写字和小签（出了状况的标 !），回复写有没有后文 */
function brief(look: ChatLook): string {
  switch (look.form) {
    case "tool_line":
      return `${look.text}${look.tags.map((t) => ` · ${t.text}`).join("")}${look.alert ? ` !${look.alert}` : ""}${look.running ? " …" : ""}`;
    case "reply":
      return look.more ? "reply+" : "reply";
    case "thinking":
      return look.live ? "thinking…" : "thinking";
    default:
      return look.form;
  }
}

/** 各种条目怎么打开详情：种类 → 打开方式（同一种出现几次都一样才对） */
function openWays(items: readonly ChatItem[]): Record<string, string> {
  const out: Record<string, Set<string>> = {};
  for (const item of items) {
    const look = chatLook(item);
    const key = look.form === "reply" ? (look.more ? "reply（有后文）" : "reply（只有一段）") : look.form;
    (out[key] ??= new Set()).add(look.open ?? "-");
  }
  return Object.fromEntries(Object.entries(out).map(([k, v]) => [k, [...v].join("|")]));
}

describe("回放：任务的维护者会话", () => {
  test("timeline-zoom：每组一行小字，顺利的标做完告诉你、授权内；问过你的那一组醒目（跟你有关），被拦下的那一组醒目（被拦下）", () => {
    const items = chatItems(replay(load("timeline-zoom")), "maintainer:tm-1");
    expect(looks(items).map(brief)).toEqual([
      "note",
      "card",
      "reply",
      "note",
      "调用了 4 个工具 · 1 次做完告诉你 · 1 次授权内",
      "card",
      "调用了 1 个工具 · 1 次问过你 !you",
      "note",
      "card",
      "调用了 2 个工具 · 1 次被拦下 !stopped",
      "note",
      "card",
      "note",
      "reply",
    ]);
    // 小签的颜色档：做完告诉你平和（op）、授权内（ok）；问过你跟你有关（you）；被拦下醒目（stopped）
    expect(looks(items).flatMap((l) => (l.form === "tool_line" ? [l.tags.map((t) => `${t.key}:${t.level}`)] : []))).toEqual([["notify:op", "granted:ok"], ["asked:you"], ["blocked:stopped"]]);
  });

  test("task-rejections：被你拒绝的那次调用一组一行，标“1 次你拒绝了”、醒目；授权内建目录的那一组平和", () => {
    const items = chatItems(replay(load("task-rejections")), "maintainer:tm-1");
    const lines = looks(items).filter((l) => l.form === "tool_line").map(brief);
    expect(lines).toEqual(["调用了 1 个工具 · 1 次授权内", ...Array.from({ length: 5 }, () => "调用了 1 个工具 · 1 次你拒绝了 !stopped")]);
  });

  test("typed-shell-tools：出了状况的小签排在前面（被拦下、出错、问过你，按状况的固定先后），然后才是做完告诉你；有被拦下的整行按被拦下醒目", () => {
    const items = chatItems(replay(load("typed-shell-tools")), "maintainer:tm-1");
    expect(looks(items).filter((l) => l.form === "tool_line").map(brief)).toEqual([
      "调用了 2 个工具 · 1 次做完告诉你",
      "调用了 5 个工具 · 2 次被拦下 · 1 次出错 · 1 次问过你 !stopped",
      "调用了 7 个工具 · 2 次被拦下 · 1 次出错 · 1 次问过你 · 2 次做完告诉你 !stopped",
    ]);
  });
});

describe("回放：秘书会话", () => {
  test("secretary-chat：思考一行“💭 Agent 的想法（点开看）”、旁边详情；只有一段的回复不给展开和详情；用户气泡整条可点", () => {
    const items = chatItems(replay(load("secretary-chat")), "secretary");
    expect(looks(items)).toEqual([
      { form: "user", open: "whole" },
      { form: "thinking", label: THINKING_LABEL, live: false, open: "link" },
      { form: "reply", head: "在的。今天有什么要我帮忙的？", more: false, open: undefined },
      { form: "user", open: "whole" },
      { form: "reply", head: "好，周五交房租，我记下了。不过现在我还不能建提醒，到时候需要你自己留意。", more: false, open: undefined },
    ]);
  });

  test("secretary-approval：批准后执行的那次读文件一行“1 次问过你”，跟你有关的醒目；审批卡单独一张，卡片下面“详情 ›”", () => {
    const items = chatItems(replay(load("secretary-approval")), "secretary");
    expect(looks(items).map(brief)).toEqual(["user", "card", "调用了 1 个工具 · 1 次问过你 !you", "reply"]);
    expect(chatLook(items[1]!).open).toBe("link");
  });

  test("voice-message：语音照旧（同框），详情在长按菜单里；系统说明整条可点", () => {
    const items = chatItems(replay(load("voice-message")), "secretary");
    expect(looks(items).map((l) => `${l.form}/${l.open ?? "-"}`)).toEqual(["voice/menu", "reply/-", "voice/menu", "reply/-", "note/whole", "reply/-"]);
  });

  test("memory-purge：被彻底删除的只剩“已删除”，没有详情；没有小签可标的组只写调用了几个工具", () => {
    const items = chatItems(replay(load("memory-purge")), "secretary");
    const shown = looks(items);
    expect(shown.filter((l) => l.form === "deleted")).toEqual([{ form: "deleted", open: undefined }]);
    expect(shown.filter((l) => l.form === "tool_line").map(brief)).toEqual(["调用了 1 个工具", "调用了 1 个工具"]);
  });
});

describe("回放：项目的维护者会话（work-orders-queue）", () => {
  test("工单分隔线没有详情；组一行；卡片“详情 ›”；说明整条可点", () => {
    const items = chatItems(replay(load("work-orders-queue")), "maintainer:pm-1");
    expect(openWays(items)).toEqual({ divider: "-", note: "whole", card: "link", "reply（只有一段）": "-", tool_line: "row" });
  });
});

describe("有详情的条目怎么打开（照 AgentSense：整条可点的用户气泡和说明不带记号；思考、多段回复、卡片是“详情 ›”；组是整行加 ›）", () => {
  test("几段录像合起来，每种条目的打开方式都是一样的", () => {
    const all = [
      ...chatItems(replay(load("timeline-zoom")), "maintainer:tm-1"),
      ...chatItems(replay(load("secretary-chat")), "secretary"),
      ...chatItems(replay(load("voice-message")), "secretary"),
      ...chatItems(replay(load("memory-purge")), "secretary"),
      ...chatItems(replay(load("work-orders-queue")), "maintainer:pm-1"),
    ];
    expect(openWays(all)).toEqual({
      note: "whole",
      card: "link",
      "reply（只有一段）": "-",
      "reply（有后文）": "link",
      tool_line: "row",
      user: "whole",
      thinking: "link",
      voice: "menu",
      deleted: "-",
      divider: "-",
    });
  });
});

describe("缩小后逐次画（用户 2026-10-10 定：组只存在于对话层，要点层、全局层照 AgentSense 每次调用各一块）", () => {
  test("timeline-zoom：只有组拆成块，每次调用一块；性质色、要点按这一次算，不取组里最重的；被拦下的前面加 ⛔；按块的 id 找得到组和那一次", () => {
    const items = chatItems(replay(load("timeline-zoom")), "maintainer:tm-1");
    expect(items.map((it) => zoomBlocks(it).length)).toEqual([0, 0, 0, 0, 4, 0, 1, 0, 0, 2, 0, 0, 0, 0]);
    const blocks = items.flatMap(zoomBlocks);
    const shape = (b: ZoomBlock) =>
      b.kind === "call" ? `${b.call.part.tool}${b.tone ? `[${b.tone}]` : ""}${b.marks.length ? `{${b.marks.length}}` : ""}${b.keyLine.startsWith("⛔ ") ? " ⛔" : ""}` : "思考";
    expect(blocks.map(shape)).toEqual(["write", "bash{1}", "bash[granted]{1}", "git_commit[notify]{1}", "read[stopped]{1}", "write", "write[stopped]{1} ⛔"]);
    // 组那一行的性质色取最重的（做完告诉我），组里的块各是各的
    expect(items[4]!.tone).toBe("notify");
    for (const b of blocks) {
      const found = locateChatItem(items, b.id);
      expect(found?.item.id).toBe(b.groupId);
      expect(b.kind === "call" && found?.call?.id).toBe(b.id);
    }
  });

  test("组里的思考也是一块（AgentSense 的思考各是一条）；顺利执行的内部工具不画；你拒绝了 ✕、等你批准 ⏸；出错的标出错", () => {
    const thought = { type: "reasoning" as const, text: "先看看目录\n再动手" };
    const items = chatItems(
      replay([
        messageFrame(1, "m1", "agent", [thought, tool("c1", { tool: "ls", argsSummary: "." })]),
        messageFrame(2, "m2", "agent", [tool("c2", { tool: "write_progress", argsSummary: "进展" })]),
        messageFrame(3, "m3", "agent", [tool("c3", { categoryTitles: ["删除或覆盖"], disposition: "ask_first", outcome: "denied" })]),
        messageFrame(4, "m4", "agent", [tool("c4", { categoryTitles: ["越出项目目录"], disposition: "ask_first", outcome: "blocked" })]),
        messageFrame(5, "m5", "agent", [tool("c5", { outcome: "error" })]),
      ]),
      S,
    );
    expect(items).toHaveLength(1);
    expect(zoomBlocks(items[0]!).map((b) => (b.kind === "thinking" ? b.keyLine : `${b.keyLine}${b.error ? "（出错）" : ""}`))).toEqual([
      "思考：先看看目录",
      // 67 号票起是说人话的那一句；出错不加前缀（照 AgentSense keyLine）
      "列出 .",
      "✕ 写 c3.md",
      "⏸ 写 c4.md",
      "写 c5.md（出错）",
    ]);
  });
});

// ───────────────────────── 录像覆盖不到的 ─────────────────────────

const S = "secretary";
const checkMessage = schemaChecker(MessageEventPayloadSchema);
const at = (s: string) => `2026-10-09T10:00:${s}.000+08:00`;
function messageFrame(seq: number, id: string, speaker: MessageEnvelope["speaker"], parts: MessagePart[]): EventFrame {
  const payload = { message: { id, conversation: S, speaker, time: at(String(seq).padStart(2, "0")), parts } };
  const problem = checkMessage.firstError(payload);
  if (problem) throw new Error(`构造的事件不合 schema：${problem}`);
  return frame(S, seq, "message", payload);
}
const text = (t: string): MessagePart => ({ type: "text", text: t });
type ToolCallPart = Extract<MessagePart, { type: "tool_call" }>;
const tool = (callId: string, o: Partial<ToolCallPart> = {}): MessagePart => ({
  type: "tool_call",
  callId,
  tool: "write",
  argsSummary: `${callId}.md`,
  categoryTitles: [],
  disposition: "do",
  withinGrant: false,
  genericBash: false,
  outcome: "done",
  ...o,
});
const stream = (seq: number, messageId: string, deltas: Array<{ part: number; type: "text" | "reasoning"; offset: number; text: string }>) => frame(S, seq, "stream", { messageId, deltas });

describe("录像覆盖不到的：回复", () => {
  test("按第一个空行切（AgentSense 的 AssistantBubble）：有后文才算多段；空行后面只有空白的不算；没有空行的整段是第一段", () => {
    expect(replyCut("先说结论。\n\n- 细节一\n- 细节二")).toEqual({ head: "先说结论。", rest: "- 细节一\n- 细节二" });
    expect(replyCut("只有一段。\n\n   ")).toEqual({ head: "只有一段。", rest: "" });
    expect(replyCut("第一行\n第二行")).toEqual({ head: "第一行\n第二行", rest: "" });
    // 开头就是空行的不切（照 AgentSense：cut > 0 才切）
    expect(replyCut("\n\n正文")).toEqual({ head: "\n\n正文", rest: "" });
  });

  test("多段的回复给“收起 / 展开细节”和“详情 ›”；默认整段展开（照 AgentSense bedf5a5，用户 2026-10-10 定）", () => {
    const items = chatItems(replay([messageFrame(1, "a1", "agent", [text("一共 ¥3,412.60。\n\n- 外卖 ¥1,286.00\n- 餐馆 ¥1,530.60")])]), S);
    expect(looks(items)).toEqual([{ form: "reply", head: "一共 ¥3,412.60。", more: true, open: "link" }]);
    expect(REPLY_OPEN_BY_DEFAULT).toBe(true);
  });

  test("漏了中间增量的回复：不拼残缺的文字，没有第一段、没有详情入口", () => {
    const items = chatItems(replay([stream(0, "a1", [{ part: 0, type: "text", offset: 5, text: "后半句\n\n还有" }])]), S);
    expect(looks(items)).toEqual([{ form: "reply", head: "", more: false, open: undefined }]);
  });
});

describe("录像覆盖不到的：思考", () => {
  test("正在想：一行“💭 Agent 正在想…”（字轻轻明暗）；定稿后换成“💭 Agent 的想法（点开看）”", () => {
    const live = chatItems(replay([stream(1, "a1", [{ part: 0, type: "reasoning", offset: 0, text: "先查一下" }])]), S);
    expect(looks(live)).toEqual([{ form: "thinking", label: THINKING_LIVE_LABEL, live: true, open: "link" }]);
    const done = chatItems(replay([messageFrame(1, "a1", "agent", [{ type: "reasoning", text: "先查一下" }, text("查到了")])]), S);
    expect(looks(done)[0]).toEqual({ form: "thinking", label: THINKING_LABEL, live: false, open: "link" });
  });
});

describe("录像覆盖不到的：工具调用那一行", () => {
  test("还有调用在执行：圆点一闪一闪；命中关注类别、直接做只记录的标“直接做只记录”（平和）；没命中、没处置可说的不标", () => {
    const items = chatItems(
      replay([
        messageFrame(1, "m1", "agent", [tool("c1")]),
        messageFrame(2, "m2", "agent", [tool("c2", { categoryTitles: ["删除或覆盖"], disposition: "do" })]),
        messageFrame(3, "m3", "agent", [tool("c3", { outcome: "running" })]),
      ]),
      S,
    );
    const [line] = looks(items);
    expect(line).toEqual({
      form: "tool_line",
      text: "调用了 3 个工具",
      tags: [{ key: "logged", count: 1, text: "1 次直接做只记录", level: "quiet" }],
      alert: undefined,
      running: true,
      open: "row",
    });
  });

  test("等你批准（先问我、挂起没执行）：跟你有关的醒目；和出错的放在一组时整行按被拦下一类醒目", () => {
    const waiting = { categoryTitles: ["越出项目目录"], disposition: "ask_first" as const, outcome: "blocked" as const };
    const alone = looks(chatItems(replay([messageFrame(1, "m1", "agent", [tool("c1", waiting)])]), S));
    expect(alone.map(brief)).toEqual(["调用了 1 个工具 · 1 次等你批准 !you"]);
    const mixed = looks(chatItems(replay([messageFrame(1, "m1", "agent", [tool("c1", { outcome: "error" }), tool("c2", waiting)])]), S));
    expect(mixed.map(brief)).toEqual(["调用了 2 个工具 · 1 次等你批准 · 1 次出错 !stopped"]);
  });

  test("做完告诉我、同时在授权内的算“做完告诉你”，不再算一次授权内（和要点的说法一致）", () => {
    const items = chatItems(replay([messageFrame(1, "m1", "agent", [tool("c1", { categoryTitles: ["以我的名义对外发送或发布"], disposition: "do_then_tell", withinGrant: true }), tool("c2", { categoryTitles: ["以我的名义对外发送或发布"], disposition: "planned_only", withinGrant: true })])]), S);
    expect(looks(items).map(brief)).toEqual(["调用了 2 个工具 · 1 次做完告诉你 · 1 次授权内"]);
  });
});
