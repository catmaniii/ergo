// 聊天区精简：对话层里每一条长什么样（state/chat-look.ts 的 chatLook）。
// 过程条目收成一行（ChatLine）：思考、工具调用组、调用记忆、来信、卡片、时间线记录、系统说明、分支摘要——标题、一句话、
// 句子后面的小签和时间、行尾 ›（整行点开）；用户气泡整条可点，回复切出第一段、有后文才给"展开 / 详情"，语音在长按菜单里。
// 先回放主切面录下的真实事件流（任务的负责人会话、秘书会话、项目的负责人会话），再按共享协议的 schema 构造录像覆盖不到的
// （正在想、执行中、等你批准、MCP 工具、各种卡片的状态、分支摘要……），每种写什么、工具调用挑哪一步都在这里。
import fs from "node:fs";
import path from "node:path";
import { MessageEventPayload as MessageEventPayloadSchema, schemaChecker } from "@ergo/protocol";
import { describe, expect, test } from "vitest";
import {
  type Card,
  cardAskOf,
  cardSentence,
  cardStatus,
  type ChatItem,
  type ChatLine,
  type ChatLook,
  chatItems,
  chatLook,
  type EventFrame,
  locateChatItem,
  type MessageEnvelope,
  type MessagePart,
  pickToolStep,
  recallLineTitled,
  REPLY_OPEN_BY_DEFAULT,
  replay,
  replyCut,
  thinkingLine,
  thinkingSentence,
  type UiInput,
  type ZoomBlock,
  zoomBlocks,
} from "../../src/state/index.ts";
import { card as cardOf, frame } from "./events.ts";

function load(name: string): UiInput[] {
  return JSON.parse(fs.readFileSync(path.join(import.meta.dirname, "recordings", `${name}.json`), "utf8")) as UiInput[];
}

const looks = (items: readonly ChatItem[]) => items.map(chatLook);

/**
 * 一条的样子写成一个短串：收成一行的写"种类｜标题｜一句话"，不止一步的写"｜N步"，后面是小签，醒目的标 !stopped / !you，
 * 正在进行的标 …；回复写有没有后文；别的写形态
 */
function brief(look: ChatLook): string {
  if (look.form === "line")
    return `${look.kind}｜${look.title}｜${look.text}${look.steps ? `｜${look.steps}步` : ""}${look.tags.map((t) => ` · ${t.text}`).join("")}${look.alert ? ` !${look.alert}` : ""}${look.live ? " …" : ""}`;
  if (look.form === "reply") return look.more ? "reply+" : "reply";
  return look.form;
}

/** 收成一行的那一条 */
function asLine(look: ChatLook): ChatLine {
  if (look.form !== "line") throw new Error(`不是一行：${look.form}`);
  return look;
}

/** 各种条目怎么打开详情：种类 → 打开方式（同一种出现几次都一样才对） */
function openWays(items: readonly ChatItem[]): Record<string, string> {
  const out: Record<string, Set<string>> = {};
  for (const item of items) {
    const look = chatLook(item);
    const key = look.form === "line" ? `line:${look.kind}` : look.form === "reply" ? (look.more ? "reply（有后文）" : "reply（只有一段）") : look.form;
    (out[key] ??= new Set()).add(look.open ?? "-");
  }
  return Object.fromEntries(Object.entries(out).map(([k, v]) => [k, [...v].join("|")]));
}

describe("回放：任务的负责人会话", () => {
  test("timeline-zoom：过程条目各一行——工具调用写挑出的那一步、等 N 步和小签；卡片写种类、标题那一句和状态；交给负责人的长通知标题写通知", () => {
    const items = chatItems(replay(load("timeline-zoom")), "maintainer:tm-1");
    expect(looks(items).map(brief).map((b) => b.replace(/<临时目录>\\ergo-home-\w+\\/, "…\\"))).toEqual([
      "letter｜通知｜任务书：任务 t-1「整理笔记和报告」",
      // 计划卡的纯文本开头"计划："是种类的简称，去掉；处理过的写结果，平和
      "card｜计划确认｜整理笔记和报告（第 1 版，2 个阶段，约 320000 token） · 已确认",
      "reply",
      "letter｜通知｜接着做第 1 阶段：整理笔记",
      // 都做完了：写最后一步，不止一步加"等 N 步"
      "tool｜工具调用｜把改动提交：整理笔记｜4步 · 1 次做完告诉你 · 1 次授权内",
      // 审批卡开头的"审批（来源）："去掉
      "card｜审批｜读文件「…\\readme.txt」 · 越出项目目录 · 已批准",
      "tool｜工具调用｜读 …\\readme.txt · 1 次问过你 !you",
      "note｜说明｜负责人宣布阶段 s1「整理笔记」完成（第 1 次）：笔记在 notes.md",
      // 进度卡没点"知道了"：等你过目，跟你有关的颜色
      "card｜进度｜验收通过（脚本检查）：任务「整理笔记和报告」第 1 阶段「整理笔记」。验收通过。 · 等你过目 !you",
      // 有出状况的：写出状况的那一步（被拦下的写文件），不写最后一步
      "tool｜工具调用｜写 …\\outside.md｜2步 · 1 次被拦下 !stopped",
      "note｜说明｜负责人宣布阶段 s2「写报告」完成（第 1 次）：报告在 report.md",
      "card｜进度｜验收通过（脚本检查）：任务「整理笔记和报告」第 2 阶段「写报告」。验收通过。 · 等你过目 !you",
      "note｜说明｜全部阶段验收通过，任务完成。",
      "reply",
    ]);
    // 小签的颜色档：做完告诉你平和（op）、授权内（ok）；问过你跟你有关（you）；被拦下醒目（stopped）
    expect(looks(items).flatMap((l) => (l.form === "line" && l.kind === "tool" ? [l.tags.map((t) => `${t.key}:${t.level}`)] : []))).toEqual([["notify:op", "granted:ok"], ["asked:you"], ["blocked:stopped"]]);
  });

  test("task-rejections：被你拒绝的那次调用一组一行，写那一步、标“1 次你拒绝了”、醒目；审批卡写已拒绝；偏离的记录写种类和摘要", () => {
    const items = chatItems(replay(load("task-rejections")), "maintainer:tm-1");
    const shown = looks(items)
      .map(brief)
      .map((b) => b.replace(/<临时目录>\/ergo-out-\w+\//, "…/"));
    expect(shown.filter((b) => b.startsWith("tool"))).toEqual(["tool｜工具调用｜建目录 …/s1 · 1 次授权内", ...[1, 2, 3, 4, 5].map((n) => `tool｜工具调用｜建目录 …/other${n} · 1 次你拒绝了 !stopped`)]);
    const approvals = shown.filter((b) => b.startsWith("card｜审批"));
    expect(approvals).toHaveLength(5);
    for (const b of approvals) expect(b.endsWith(" · 已拒绝")).toBe(true);
    expect(shown).toContain("record｜偏离｜你累计拒绝了 5 次（审批、计划变更），任务先暂停：看过之后可以继续，或者取消任务");
    expect(shown.at(-1)).toBe("note｜说明｜用户让任务继续了。接着做。");
  });

  test("typed-shell-tools：出了状况的小签排在前面（被拦下、出错、问过你，按状况的固定先后）；那一句写最前那种状况的最后一次", () => {
    const items = chatItems(replay(load("typed-shell-tools")), "maintainer:tm-1");
    expect(looks(items).map(brief)).toEqual([
      "note｜说明｜开始干活：给 demo 加一个 hello，测过再推送",
      "tool｜工具调用｜把改动提交：加上 hello.txt｜2步 · 1 次做完告诉你",
      "card｜审批｜建远端仓库「name=demo description=演示仓库」 · 以我的名义对外发送或发布 · 已批准",
      "tool｜工具调用｜推送当前分支到 origin｜5步 · 2 次被拦下 · 1 次出错 · 1 次问过你 !stopped",
      "card｜审批｜git 推送「remote=origin」 · 以我的名义对外发送或发布 · 已批准",
      "tool｜工具调用｜强推 main 到 origin｜7步 · 2 次被拦下 · 1 次出错 · 1 次问过你 · 2 次做完告诉你 !stopped",
      "reply+",
    ]);
  });
});

describe("回放：秘书会话", () => {
  test("secretary-chat：思考一行，写原文的第一句；只有一段的回复不给展开和详情；用户气泡整条可点", () => {
    const items = chatItems(replay(load("secretary-chat")), "secretary");
    expect(looks(items).map(brief)).toEqual(["user", "thinking｜思考｜用户在打招呼，先回应，再问有什么事", "reply", "user", "reply"]);
    expect(looks(items).map((l) => l.open)).toEqual(["whole", "row", undefined, "whole", undefined]);
  });

  test("secretary-approval：审批卡收成一行（写结果），批准后执行的那次读文件一行“1 次问过你”，跟你有关的醒目", () => {
    const items = chatItems(replay(load("secretary-approval")), "secretary");
    expect(looks(items).map(brief)).toEqual(["user", "card｜审批｜读文件「~/notes.txt」 · 越出项目目录 · 已批准", "tool｜工具调用｜读 ~/notes.txt · 1 次问过你 !you", "reply"]);
    expect(chatLook(items[1]!).open).toBe("row");
  });

  test("voice-message：语音照旧（同框），详情在长按菜单里", () => {
    const items = chatItems(replay(load("voice-message")), "secretary");
    expect(looks(items).map((l) => `${l.form}/${l.open ?? "-"}`)).toEqual(["voice/menu", "reply/-", "voice/menu", "reply/-"]);
  });

  test("memory-purge：被彻底删除的只剩“已删除”，没有详情；调用记忆、记忆删除卡、操作记录各一行", () => {
    const items = chatItems(replay(load("memory-purge")), "secretary");
    const shown = looks(items);
    expect(shown.filter((l) => l.form === "deleted")).toEqual([{ form: "deleted", open: undefined }]);
    expect(shown.filter((l) => l.form === "line").map(brief)).toEqual([
      // 检索素材是调用记忆，单独一行，不算进调用了几个工具
      "recall｜记忆｜查了 1 次记忆",
      "card｜记忆删除｜已彻底删除 1 条素材 · 已删除",
      "tool｜工具调用｜彻底删除 1 条素材",
      "record｜操作记录｜彻底删除 1 条素材：已彻底删除 1 条素材",
    ]);
  });
});

describe("回放：项目的负责人会话（work-orders-queue）", () => {
  test("工单分隔线没有详情；别的过程条目一行、整行点开；交给负责人的长通知标题写通知", () => {
    const items = chatItems(replay(load("work-orders-queue")), "maintainer:pm-1");
    expect(openWays(items)).toEqual({ divider: "-", "line:letter": "row", "line:card": "row", "reply（只有一段）": "-", "line:tool": "row", "line:note": "row" });
    expect(looks(items).flatMap((l) => (l.form === "line" && l.kind === "letter" ? [l.title] : []))).toEqual(["通知", "通知", "通知", "通知"]);
  });
});

describe("有详情的条目怎么打开（用户气泡整条可点；多段回复“详情 ›”；收成一行的都是整行加 ›；语音在长按菜单里）", () => {
  test("几段录像合起来，每种条目的打开方式都是一样的", () => {
    const all = [
      ...chatItems(replay(load("timeline-zoom")), "maintainer:tm-1"),
      ...chatItems(replay(load("secretary-chat")), "secretary"),
      ...chatItems(replay(load("voice-message")), "secretary"),
      ...chatItems(replay(load("memory-purge")), "secretary"),
      ...chatItems(replay(load("work-orders-queue")), "maintainer:pm-1"),
      ...chatItems(replay(load("task-rejections")), "maintainer:tm-1"),
    ];
    expect(openWays(all)).toEqual({
      "line:letter": "row",
      "line:card": "row",
      "reply（只有一段）": "-",
      "reply（有后文）": "link",
      "line:tool": "row",
      "line:note": "row",
      "line:thinking": "row",
      "line:recall": "row",
      "line:record": "row",
      user: "whole",
      voice: "menu",
      deleted: "-",
      divider: "-",
    });
  });
});

describe("缩小后逐次画（组只存在于对话层，要点层、全局层每次调用各一块）", () => {
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

  test("组里的思考也是一块（思考各是一条）；顺利执行的内部工具不画；你拒绝了 ✕、等你批准 ⏸；出错的标出错", () => {
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
      // 是说人话的那一句；出错不加前缀
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
  test("按第一个空行切：有后文才算多段；空行后面只有空白的不算；没有空行的整段是第一段", () => {
    expect(replyCut("先说结论。\n\n- 细节一\n- 细节二")).toEqual({ head: "先说结论。", rest: "- 细节一\n- 细节二" });
    expect(replyCut("只有一段。\n\n   ")).toEqual({ head: "只有一段。", rest: "" });
    expect(replyCut("第一行\n第二行")).toEqual({ head: "第一行\n第二行", rest: "" });
    // 开头就是空行的不切（cut > 0 才切）
    expect(replyCut("\n\n正文")).toEqual({ head: "\n\n正文", rest: "" });
  });

  test("多段的回复给“收起 / 展开细节”和“详情 ›”；默认整段展开", () => {
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
  test("正在想：一行“思考 正在想…”（字轻轻明暗）；定稿后换成原文的第一句", () => {
    const live = chatItems(replay([stream(1, "a1", [{ part: 0, type: "reasoning", offset: 0, text: "先查一下" }])]), S);
    expect(looks(live).map(brief)).toEqual(["thinking｜思考｜正在想… …"]);
    expect(chatLook(live[0]!).open).toBe("row");
    const done = chatItems(replay([messageFrame(1, "a1", "agent", [{ type: "reasoning", text: "先查一下。再动手" }, text("查到了")])]), S);
    expect(brief(looks(done)[0]!)).toBe("thinking｜思考｜先查一下");
  });

  test.each([
    ["按句号切，句号不留", "账单在记账本项目里。我这边看不到项目内部", "账单在记账本项目里"],
    ["问号、叹号留着", "要不要先问用户？还是直接做", "要不要先问用户？"],
    ["换行也切，取第一个非空行", "\n\n先看看目录\n再动手", "先看看目录"],
    ["英文句号后面是空白才切，文件名、小数里的点不算", "Read t-3.md and v2.5 first. Then edit it", "Read t-3.md and v2.5 first"],
    ["英文问号", "Should I ask? Probably not", "Should I ask?"],
    ["去掉 Markdown 记号", "**先**看 `notes.md`", "先 看 notes.md"],
    ["没有句末标点的整行", "先查一下记忆", "先查一下记忆"],
    ["太长的截到 120 字加“…”", "很长".repeat(80), `${"很长".repeat(60)}…`],
    ["空的是空串", "  \n ", ""],
  ])("思考原文的第一句：%s", (_name, raw, sentence) => {
    expect(thinkingSentence(raw)).toBe(sentence);
  });

  test("原文是空的写一句说明；不给打开方式的没有 ›", () => {
    expect(thinkingLine("", false)).toMatchObject({ kind: "thinking", title: "思考", text: "没留下想法的原文", live: false, open: undefined });
    const empty = chatItems(replay([messageFrame(1, "a1", "agent", [{ type: "reasoning", text: "" }, text("好")])]), S);
    expect(empty.filter((it) => it.kind === "thinking").map((it) => brief(chatLook(it)))).toEqual(["thinking｜思考｜没留下想法的原文"]);
  });
});

describe("录像覆盖不到的：工具调用那一行", () => {
  test("还有调用在执行：写正在执行的那一步，圆点一闪一闪；命中关注类别、直接做只记录的标“直接做只记录”（平和）；没命中、没处置可说的不标", () => {
    const items = chatItems(
      replay([
        messageFrame(1, "m1", "agent", [tool("c1")]),
        messageFrame(2, "m2", "agent", [tool("c2", { categoryTitles: ["删除或覆盖"], disposition: "do" })]),
        messageFrame(3, "m3", "agent", [tool("c3", { outcome: "running" })]),
        messageFrame(4, "m4", "agent", [tool("c4")]),
      ]),
      S,
    );
    expect(looks(items)).toHaveLength(1);
    expect(looks(items)[0]).toMatchObject({
      form: "line",
      kind: "tool",
      title: "工具调用",
      text: "写 c3.md",
      steps: 4,
      tags: [{ key: "logged", count: 1, text: "1 次直接做只记录", level: "quiet" }],
      alert: undefined,
      live: true,
      open: "row",
    });
  });

  test("只有一步：不写“等 N 步”", () => {
    const items = chatItems(replay([messageFrame(1, "m1", "agent", [tool("c1")])]), S);
    expect(asLine(chatLook(items[0]!)).steps).toBeUndefined();
    expect(brief(chatLook(items[0]!))).toBe("tool｜工具调用｜写 c1.md");
  });

  test("等你批准（先问我、挂起没执行）：写那一步，跟你有关的醒目；和出错的放在一组时整行按被拦下一类醒目，那一句写先后在前的那种状况", () => {
    const waiting = { categoryTitles: ["越出项目目录"], disposition: "ask_first" as const, outcome: "blocked" as const };
    const alone = looks(chatItems(replay([messageFrame(1, "m1", "agent", [tool("c1"), tool("c2", waiting)])]), S));
    expect(alone.map(brief)).toEqual(["tool｜工具调用｜写 c2.md｜2步 · 1 次等你批准 !you"]);
    const mixed = looks(chatItems(replay([messageFrame(1, "m1", "agent", [tool("c1", { outcome: "error" }), tool("c2", waiting), tool("c3")])]), S));
    expect(mixed.map(brief)).toEqual(["tool｜工具调用｜写 c2.md｜3步 · 1 次等你批准 · 1 次出错 !stopped"]);
  });

  test("做完告诉我、同时在授权内的算“做完告诉你”，不再算一次授权内（和要点的说法一致）", () => {
    const items = chatItems(
      replay([
        messageFrame(1, "m1", "agent", [
          tool("c1", { categoryTitles: ["以我的名义对外发送或发布"], disposition: "do_then_tell", withinGrant: true }),
          tool("c2", { categoryTitles: ["以我的名义对外发送或发布"], disposition: "planned_only", withinGrant: true }),
        ]),
      ]),
      S,
    );
    expect(looks(items).map(brief)).toEqual(["tool｜工具调用｜写 c2.md｜2步 · 1 次做完告诉你 · 1 次授权内"]);
  });

  test("挑哪一步：有出状况的按状况的固定先后挑最前那种的最后一次，否则正在执行的最后一次，否则最后一步", () => {
    const items = chatItems(
      replay([
        messageFrame(1, "m1", "agent", [
          tool("c1", { disposition: "ask_first", categoryTitles: ["越出项目目录"] }),
          tool("c2", { outcome: "error" }),
          tool("c3", { outcome: "blocked", disposition: "never", categoryTitles: ["删除或覆盖"] }),
          tool("c4", { outcome: "error" }),
          tool("c5", { outcome: "blocked", disposition: "never", categoryTitles: ["删除或覆盖"] }),
          tool("c6", { outcome: "running" }),
          tool("c7"),
        ]),
      ]),
      S,
    );
    const group = items[0]!;
    if (group.kind !== "tool_group") throw new Error("应该是一组");
    expect(pickToolStep(group.calls).part.callId).toBe("c5");
    expect(pickToolStep(group.calls.filter((c) => c.issue !== "blocked")).part.callId).toBe("c4");
    expect(pickToolStep(group.calls.filter((c) => c.issue === undefined)).part.callId).toBe("c6");
    expect(pickToolStep(group.calls.filter((c) => c.issue === undefined && c.part.outcome !== "running")).part.callId).toBe("c7");
    expect(brief(chatLook(group))).toBe("tool｜工具调用｜写 c5.md｜7步 · 2 次被拦下 · 2 次出错 · 1 次问过你 !stopped …");
  });

  test("MCP 工具不单开一行：照样是“工具调用”，那一句写出是哪个 MCP 的哪个工具", () => {
    const items = chatItems(replay([messageFrame(1, "m1", "agent", [tool("c1"), tool("c2", { tool: "mcp__demo-mail__search_messages", argsSummary: "query=月结单", outcome: "running" })])]), S);
    expect(looks(items).map(brief)).toEqual(["tool｜工具调用｜MCP demo-mail：search_messages · 月结单｜2步 …"]);
  });
});

/** 一张卡（没处理的、纯文本是空的，按种类起 id） */
const card = (type: string, o: Partial<Card> = {}): Card => cardOf(`c-${type}`, 1, { type, text: "", ...o });
/** 这张卡收到了、对话里引了它：那一行的样子 */
const lineOf = (c: Card) => {
  const items = chatItems(replay([frame("cards", 1, "card", { card: c }), messageFrame(2, "m1", "agent", [{ type: "card_ref", cardId: c.id }])]), S);
  return chatLook(items.find((it) => it.kind === "card")!);
};

describe("录像覆盖不到的：卡片", () => {
  test("收到了的卡收成一行：种类、标题那一句、没处理的等你做什么（跟你有关的颜色），整行点开；还没收到的照旧整张画、打不开", () => {
    const skill = card("skill_change", { text: "秘书要把「写周报」加进 skill 库（下次照做）\n说明……" });
    const items = chatItems(replay([frame("cards", 1, "card", { card: skill }), messageFrame(2, "m1", "agent", [text("交给你批准："), { type: "card_ref", cardId: skill.id }, { type: "card_ref", cardId: "c-missing" }])]), S);
    const cards = looks(items.filter((it) => it.kind === "card"));
    expect(cards.map(brief)).toEqual(["card｜skill 变更｜秘书要把「写周报」加进 skill 库（下次照做） · 等你批准 !you", "card"]);
    expect(cards.map((l) => l.open)).toEqual(["row", undefined]);
    expect(asLine(cards[0]!).cardType).toBe("skill_change");
  });

  test("卡片状态变了那一行跟着变：处理了写结果（平和），关掉的、过期的照写", () => {
    const approval = card("approval", { text: "审批（秘书）：读文件「~/a.txt」 · 越出项目目录" });
    const said = "card｜审批｜读文件「~/a.txt」 · 越出项目目录";
    expect(brief(lineOf(approval))).toBe(`${said} · 等你批准 !you`);
    expect(brief(lineOf({ ...approval, status: "handled", outcome: { action: "approve" } }))).toBe(`${said} · 已批准`);
    expect(brief(lineOf({ ...approval, status: "handled", outcome: { action: "deny", note: "别读" } }))).toBe(`${said} · 已拒绝`);
    expect(brief(lineOf({ ...approval, status: "dismissed" }))).toBe(`${said} · 已关闭`);
    expect(brief(lineOf({ ...approval, status: "expired", expiredNote: "用户撤回了会话，这张卡作废了" }))).toBe(`${said} · 已过期`);
  });

  test.each([
    ["approval", "approve", "等你批准"],
    ["mcp_change", "approve", "等你批准"],
    ["skill_change", "approve", "等你批准"],
    ["pairing", "approve", "等你批准"],
    ["questions", "answer", "等你回答"],
    ["runtime_question", "answer", "等你回答"],
    ["suggest_task", "decide", "等你决定"],
    ["build_done", "decide", "等你决定"],
    ["memory_delete", "check", "等你核对"],
    ["personal_file", "check", "等你核对"],
    ["browse_pick", "pick", "等你挑"],
    ["progress", "review", "等你过目"],
    ["plan", "confirm", "等你确认"],
    ["quick_action", "confirm", "等你确认"],
    ["a_plugin_card_from_a_later_version", "confirm", "等你确认"],
  ])("没处理的 %s 卡：%s（%s）", (type, ask, said) => {
    expect(cardAskOf(type)).toBe(ask);
    expect(cardStatus(card(type))).toEqual({ key: "pending", text: said, level: "you" });
  });

  test("简单提醒、服务入口不用你做决定：没处理也不醒目、不写状态", () => {
    expect([cardAskOf("reminder"), cardAskOf("service_entry")]).toEqual([null, null]);
    const reminder = card("reminder", { text: "简单提醒：交房租 · 每月 8 日 09:00" });
    expect(cardStatus(reminder)).toBeUndefined();
    expect(brief(lineOf(reminder))).toBe("card｜简单提醒｜交房租 · 每月 8 日 09:00");
  });

  test("标题那一句：纯文本的第一行，开头的“<种类>：”“<种类>（…）：”去掉（种类的简称也算）；别的开头照留", () => {
    expect(cardSentence(card("plan", { text: "计划：整理发票（第 2 版，3 个阶段）\n第二行" }))).toBe("整理发票（第 2 版，3 个阶段）");
    expect(cardSentence(card("questions", { text: "提问（2 个问题）：去几天？；住哪？" }))).toBe("去几天？；住哪？");
    expect(cardSentence(card("progress", { text: "验收通过（脚本检查）：第 1 阶段" }))).toBe("验收通过（脚本检查）：第 1 阶段");
    expect(cardSentence(card("a_plugin_card", { text: "插件的卡：一句话" }))).toBe("插件的卡：一句话");
    expect(cardSentence(card("approval", { text: "审批：" }))).toBe("审批：");
  });

  test("不认识的卡（插件登记的、新版本的）照样一行：标题写“卡片”，没处理的等你确认", () => {
    expect(brief(lineOf(card("a_plugin_card", { text: "插件的卡：一句话" })))).toBe("card｜卡片｜插件的卡：一句话 · 等你确认 !you");
  });
});

/** 秘书会话上的一条时间线记录 */
const record = (seq: number, kind: string, summary: string) => frame(S, seq, "timeline_record", { record: { id: `r${seq}`, kind, summary, detail: "第二行说明", time: at(String(seq).padStart(2, "0")) } });

describe("录像覆盖不到的：时间线记录、系统说明、分支摘要、调用记忆的标题", () => {
  test("记录：标题是种类，一句话是摘要，带时间；越界这类警示的醒目；第二行说明不在这一行里", () => {
    const items = chatItems(replay([record(1, "out_of_scope", "读了别的项目的文件"), record(2, "scope_change", "加了一个范围"), record(3, "never_heard_of", "新种类")]), S);
    expect(looks(items).map(brief)).toEqual(["record｜越界｜读了别的项目的文件 !stopped", "record｜范围变更｜加了一个范围", "record｜记录｜新种类"]);
    expect(looks(items).map((l) => asLine(l).time)).toEqual([at("01"), at("02"), at("03")]);
  });

  test("系统说明：标题“说明”，第一行；分支摘要：标题“回退”，摘要的第一句，恢复了哪些文件不在这一行里", () => {
    const items = chatItems(
      replay([
        messageFrame(1, "s1", "system", [text("\n计划已确认，开始执行。\n第二行")]),
        messageFrame(2, "s2", "system", [{ type: "branch_summary", branchId: "b1", summary: "做到第 2 步，改了 a.ts。没有对外发东西。", files: { restored: ["a.ts"] } }]),
      ]),
      S,
    );
    expect(looks(items).map(brief)).toEqual(["note｜说明｜计划已确认，开始执行。", "branch｜回退｜做到第 2 步，改了 a.ts"]);
    expect(looks(items).map((l) => l.open)).toEqual(["row", "row"]);
  });

  test("调用记忆：取到第一条记忆的标题写“回忆了 N 条：<标题>”，取不到的照旧", () => {
    const summary = { count: 3, known: true, calls: 2 };
    expect(recallLineTitled(summary, "SQ828 航班提醒")).toBe("回忆了 3 条：SQ828 航班提醒");
    expect(recallLineTitled(summary, undefined)).toBe(recallLineTitled(summary, "  "));
    expect(recallLineTitled(summary, undefined)).not.toContain("：");
  });
});
