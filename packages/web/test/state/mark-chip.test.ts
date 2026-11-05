// 缩小后右侧标注写的字（state/mark-chip.ts）：每种要点都是"种类或样式 + 一句具体的"，关注类别写短名，
// MCP 调用、项目接口以前的那一句改写成现在的（不再出现"秘书用 MCP"），英文同样短；
// 连着几块的合成一条（zoom-decor.ts 的 rightMarks）：整句一样的 ×N，那句话不一样的"…等 N 次"，审批批没批不同的不合并。
import { afterEach, describe, expect, test } from "vitest";
import {
  activeLocaleFrom,
  type Card,
  categoryShort,
  chatItems,
  DEFAULT_LANGUAGE,
  type EventFrame,
  type MessagePart,
  markChip,
  markChipText,
  recordGist,
  replay,
  setActiveLocale,
  type TimelineMark,
  type UiState,
  zoomDecor,
  zoomRects,
} from "../../src/state/index.ts";
import { TEST_LOCALES } from "../setup-locales.ts";
import { card, frame } from "./events.ts";

const english = () => setActiveLocale(activeLocaleFrom(TEST_LOCALES, "en"));
afterEach(() => setActiveLocale(activeLocaleFrom(TEST_LOCALES, DEFAULT_LANGUAGE)));

const EMPTY: UiState = replay([]);
const DELETE_FULL = "删除或覆盖（项目档案和工作目录内）";

type ToolCallPart = Extract<MessagePart, { type: "tool_call" }>;
function call(callId: string, tool: string, argsSummary: string, o: Partial<ToolCallPart> = {}): ToolCallPart {
  return { type: "tool_call", callId, tool, argsSummary, categoryTitles: [], disposition: "do", withinGrant: false, genericBash: false, outcome: "done", ...o };
}

/** 一次工具调用的要点（样式、结果照 timeline.ts 的推法写好） */
function toolMark(part: ToolCallPart, o: Partial<TimelineMark> = {}): TimelineMark {
  return { key: part.callId, itemKey: "m", kind: "tool", short: part.tool, title: `${part.tool} ${part.argsSummary}`, categories: part.categoryTitles, genericBash: part.genericBash, toolCall: part, ...o };
}

function recordMark(kind: TimelineMark["kind"], summary: string, note?: string): TimelineMark {
  return { key: `r#${kind}`, itemKey: "r", kind, short: kind, title: summary, categories: [], genericBash: false, ...(note ? { note } : {}) };
}

const text = (m: TimelineMark, state: UiState = EMPTY) => markChipText(markChip(state, m));

const APPROVED = { action: "approve", by: "user", at: "2026-10-07T09:01:00+08:00" } as Card["outcome"];
const DENIED = { action: "deny", by: "user", at: "2026-10-07T09:01:00+08:00" } as Card["outcome"];

/** 一张写文件的审批卡（cards 频道） */
function approvalFrame(seq: number, id: string, args: string, status: Card["status"], outcome?: Card["outcome"], categoryTitles: string[] = []): EventFrame {
  return frame("cards", seq, "card", {
    card: card(id, 1, { type: "approval", status, ...(outcome ? { outcome } : {}), payload: { approvalId: `a-${id}`, source: "项目「记账本」", tool: "write", toolTitle: "写文件", argsSummary: args, categoryTitles, reason: "要先问你" } }),
  });
}
const cardRef = (cardId: string): MessagePart => ({ type: "card_ref", cardId });

describe("每种要点：种类或样式 + 一句具体的", () => {
  test("工具调用：样式和结果在前（和样式一个说法的不重复），⚠类别写短名，后面是这次调用说人话的那一句（MCP 写得出是哪个 MCP 的哪个工具）", () => {
    // 被拦下（按处置没执行）：结果也叫"被拦下"，只写一次
    const blocked = call("c1", "write", "D:\\work\\logs\\2026\\october\\archive\\old-report-final.log", { categoryTitles: [DELETE_FULL], disposition: "never", outcome: "blocked" });
    expect(text(toolMark(blocked, { style: "stopped", reason: "blocked", outcome: "被拦下" }))).toBe("被拦下 · ⚠删除或覆盖 · 写 …\\october\\archive\\old-report-final.log");
    // 等你批准：结果在类别前面（两行放不下时先截类别）
    const waiting = call("c2", "write", "ledger.db", { categoryTitles: [DELETE_FULL], disposition: "ask_first", outcome: "blocked" });
    expect(text(toolMark(waiting, { style: "stopped", reason: "blocked", outcome: "等你批准" }))).toBe("被拦下 · 等你批准 · ⚠删除或覆盖 · 写 ledger.db");
    // 做完告诉我的 MCP 工具：写"MCP <名>：<工具>"（和对话层那一行同一句）
    const mcp = call("c3", "mcp__calendar__create_event", "title=周会 at=15:00", { disposition: "do_then_tell" });
    expect(text(toolMark(mcp, { style: "notify", reason: "notify" }))).toBe("做完告诉我 · MCP calendar：create_event · 周会 · 15:00");
    // 只是通用 bash：后面是拆出来的命令
    const bash = call("c4", "bash", "python import.py --month 2026-10", { genericBash: true });
    expect(text(toolMark(bash))).toMatch(/^通用 bash · .*import\.py/);
    // 悬停：工具名和参数摘要、结果
    expect(markChip(EMPTY, toolMark(waiting, { outcome: "等你批准" })).hover).toBe("write ledger.db · 等你批准");
  });

  test("工具调用参数里的编号按状态层写成可读的（和对话层一样）", () => {
    const pause = call("c5", "propose_quick_action", 'type=pause_task params={"task":"t-3"}', { disposition: "do_then_tell" });
    expect(text(toolMark(pause, { style: "notify", reason: "notify" }))).toBe("做完告诉我 · 暂停任务 t-3");
  });

  test("操作记录：名字、样式、类别，后面是执行结果的摘要", () => {
    const op: TimelineMark = { key: "o", itemKey: "o", kind: "operation", short: "改工作日历", title: "改工作日历：10 月 8 日休息", categories: [], genericBash: false, style: "stopped", reason: "explicit", outcome: "改好了：10 月 8 日标成休息日" };
    expect(text(op)).toBe("操作记录：改工作日历 · 你点明的 · 改好了：10 月 8 日标成休息日");
  });

  test("审批：要批的事（有模板的说成人话，没有的写工具中文名「参数」），最后接批了没有；一批一拒写得出来", () => {
    const mark: TimelineMark = { key: "a1", itemKey: "a1", kind: "approval", short: "审批", title: "写文件「ledger.db」", categories: [DELETE_FULL], genericBash: false, cardId: "a1" };
    expect(text(mark, replay([approvalFrame(1, "a1", "ledger.db", "pending", undefined, [DELETE_FULL])]))).toBe("审批 · ⚠删除或覆盖 · 写 ledger.db · 待你处理");
    expect(text(mark, replay([approvalFrame(1, "a1", "ledger.db", "handled", APPROVED, [DELETE_FULL])]))).toBe("审批 · ⚠删除或覆盖 · 写 ledger.db · 已批准");
    // 拆开：批了没有单独放（界面两行放不下时截的是那句话，不是它）
    expect(markChip(replay([approvalFrame(1, "a1", "ledger.db", "pending")]), mark)).toMatchObject({ head: "审批 · ⚠删除或覆盖", lead: "审批", said: "写 ledger.db", tail: "待你处理" });
    // 没有模板的工具、没收到卡：写要点那一句（工具中文名「参数」），不写批没批
    expect(text({ ...mark, cardId: "a3", title: "发邮件「to=你 subject=月报」" })).toBe("审批 · ⚠删除或覆盖 · 发邮件「to=你 subject=月报」");
  });

  test("验收：结论；秘书转达：名字转达 + 那句话的开头", () => {
    expect(text({ key: "v", itemKey: "v", kind: "acceptance", short: "验收", title: "第 1 阶段「把账单导进来」验收没通过（脚本检查）", categories: [], genericBash: false, passed: false })).toBe("第 1 阶段「把账单导进来」验收没通过（脚本检查）");
    expect(text({ key: "y", itemKey: "y", kind: "relay", short: "转达", title: "下个月起信用卡账单也要导入", categories: [], genericBash: false })).toBe("⟦个人助理⟧转达 · 下个月起信用卡账单也要导入");
  });

  test("时间线记录：种类 + 摘要（第一行）；摘要开头又写了一遍种类的去掉；太长的截到 60 字", () => {
    expect(text(recordMark("deviation", "自动纠偏：写 ledger.db 之前没先备份，先备份再写"))).toBe("偏离 · 自动纠偏：写 ledger.db 之前没先备份，先备份再写");
    expect(text(recordMark("scope_change", "范围变更：多了导出 CSV\n第二行的说明"))).toBe("范围变更 · 多了导出 CSV");
    const long = "往项目外的「示例目录/下载」写了一个临时文件，没有授权；".repeat(3);
    const said = markChip(EMPTY, recordMark("out_of_scope", long)).said;
    expect(said).toHaveLength(60);
    expect(said.endsWith("…")).toBe(true);
    // 悬停是完整的，带着详细说明
    expect(markChip(EMPTY, recordMark("out_of_scope", long, "范围审视：记为越界。")).hover).toBe(`${long} · 范围审视：记为越界。`);
  });
});

describe("MCP 调用、项目接口：新记的一句话就是短的，以前那句改写成一样的，不出现“秘书用 MCP”", () => {
  const NOW = "「旅行相册」person.rename：已把 p2 改名成 爸爸";
  test("新记录照原样接上；以前的中文、英文写法（做成的、没做成的）都改写成现在的", () => {
    expect(text(recordMark("mcp_call", NOW))).toBe(`MCP 调用 · ${NOW}`);
    expect(recordGist("mcp_call", "秘书用 MCP「旅行相册」调了 person.rename（已把 p2 改名成 爸爸）")).toBe(NOW);
    expect(recordGist("mcp_call", "秘书用 MCP「旅行相册」调 person.rename 没做成（改名字要写 name（必填））")).toBe("「旅行相册」person.rename 没做成：改名字要写 name（必填）");
    expect(recordGist("mcp_call", 'The assistant called person.rename on MCP "旅行相册" (已把 p2 改名成 爸爸)')).toBe(NOW);
    expect(recordGist("mcp_call", "The assistant's call to filter.set on MCP \"Album\" didn't work (no such person)")).toBe("「Album」filter.set 没做成：no such person");
    // 悬停也是现在的说法
    const old = markChip(EMPTY, recordMark("mcp_call", "秘书用 MCP「旅行相册」调了 person.rename（已把 p2 改名成 爸爸）", '参数：{"id":"p2"}'));
    expect(old.hover).toBe(`${NOW} · 参数：{"id":"p2"}`);
    expect(`${markChipText(old)} ${old.hover}`).not.toMatch(/秘书|个人助理/);
  });

  test("项目接口：秘书调的不写是谁调的，别的 agent 调的写明", () => {
    expect(recordGist("project_op", "秘书调了项目「记账本」的操作 add_expense（记好了：午饭 32 元）")).toBe("「记账本」add_expense：记好了：午饭 32 元");
    expect(recordGist("project_op", "秘书调项目「记账本」的操作 add_expense 没做成（账本被锁着）")).toBe("「记账本」add_expense 没做成：账本被锁着");
    expect(recordGist("project_op", "项目「周报」的负责人调了项目「记账本」的操作 month_report（9 月花了 320 元）")).toBe("项目「周报」的负责人调了「记账本」month_report：9 月花了 320 元");
    expect(recordGist("project_op", 'Called by the owner of project "Weekly": month_report on project "Ledger" (spent 320)')).toBe("the owner of project \"Weekly\"调了「Ledger」month_report：spent 320");
    expect(recordGist("project_op", 'The assistant called add_expense on project "Ledger" (logged)')).toBe("「Ledger」add_expense：logged");
    // 新记录（已经是现在的写法）照原样
    expect(recordGist("project_op", "「记账本」add_expense：记好了")).toBe("「记账本」add_expense：记好了");
  });

  test("认不出的写法照原样（界面截到两行）", () => {
    expect(recordGist("mcp_call", "MCP 调了点别的")).toBe("MCP 调了点别的");
  });
});

describe("关注类别的短名", () => {
  test("末尾括号里的补充说明去掉，中英文括号都认；没有括号、去完是空的照原样", () => {
    expect(categoryShort("账户与安全（凭据、权限、全局装软件）")).toBe("账户与安全");
    expect(categoryShort("Accounts and security (credentials, permissions, global installs)")).toBe("Accounts and security");
    expect(categoryShort("以我的名义对外发送或发布")).toBe("以我的名义对外发送或发布");
    expect(categoryShort("（只有括号）")).toBe("（只有括号）");
  });
});

describe("英文", () => {
  test("同样是种类或样式 + 一句短的；以前的中文记录改写成英文的句式", () => {
    english();
    const waiting = call("c2", "write", "ledger.db", { categoryTitles: ["Deleting or overwriting (in project records and working folders)"], disposition: "ask_first", outcome: "blocked" });
    expect(text(toolMark(waiting, { style: "stopped", reason: "blocked", outcome: "Awaiting your approval" }))).toBe("Blocked · Awaiting your approval · ⚠Deleting or overwriting · Write ledger.db");
    const mcp = call("c3", "mcp__calendar__create_event", "title=Standup at=15:00", { disposition: "do_then_tell" });
    expect(text(toolMark(mcp, { style: "notify", reason: "notify" }))).toBe("Tell me when done · MCP calendar: create_event · Standup · 15:00");
    expect(text(recordMark("mcp_call", 'The assistant called person.rename on MCP "Album" (renamed p2 to Dad)'))).toBe("MCP call · “Album” person.rename: renamed p2 to Dad");
    expect(text({ key: "y", itemKey: "y", kind: "relay", short: "relay", title: "Add credit card statements too", categories: [], genericBash: false })).toBe("Relayed by ⟦个人助理⟧ · Add credit card statements too");
  });
});

// ───────────────────────── 连着几块合成一条 ─────────────────────────

const at = (s: number) => `2026-10-09T09:00:${String(s).padStart(2, "0")}+08:00`;
function secretaryMessage(seq: number, parts: MessagePart[], speaker: "user" | "agent" = "agent"): EventFrame {
  return frame("secretary", seq, "message", { message: { id: `s${seq}`, conversation: "secretary", speaker, time: at(seq), parts } });
}
function recordFrame(seq: number, kind: string, summary: string): EventFrame {
  return frame("secretary", seq, "timeline_record", { record: { id: `r${seq}`, kind, summary, time: at(seq) } });
}
/** 每一块右侧标的：不标的写 -，×N 写在后面 */
function shown(state: UiState): string[] {
  const items = chatItems(state, "secretary");
  const decor = zoomDecor(state, "secretary", items);
  return zoomRects(items).flatMap((r) => {
    if (r.marks.length === 0) return [];
    const n = decor.repeats.get(r.id);
    if (n === 0) return ["-"];
    return [`${r.marks.map((m) => markChipText(decor.chips.get(m.key)!)).join(" | ")}${n ? ` ×${n}` : ""}`];
  });
}

describe("连着几块的标注合成一条", () => {
  test("连着两次 MCP 调用（摘要不一样）合成一条：第一块的那句话加“等 2 次”，第二块不标；隔着回复就断开", () => {
    const state = replay([
      secretaryMessage(1, [{ type: "text", text: "第二个人改名叫爸爸，再只看他" }], "user"),
      recordFrame(2, "mcp_call", "「旅行相册」person.rename：已把 p2 改名成 爸爸"),
      recordFrame(3, "mcp_call", "秘书用 MCP「旅行相册」调了 filter.set（只显示 p2）"),
      secretaryMessage(4, [{ type: "text", text: "改好了" }]),
      recordFrame(5, "mcp_call", "「旅行相册」filter.set：只显示 p2"),
    ]);
    expect(shown(state)).toEqual(["MCP 调用 · 「旅行相册」person.rename：已把 p2 改名成 爸爸 等 2 次", "-", "MCP 调用 · 「旅行相册」filter.set：只显示 p2"]);
  });

  test("工具调用：样式、结果、类别一样的连着几块合成“等 N 次”（中间一段思考不打断）；整句一字不差的照旧 ×N；样式不一样的断开", () => {
    const tell = (id: string, path: string) => call(id, "write", path, { disposition: "do_then_tell" });
    const state = replay([
      secretaryMessage(1, [tell("a", "notes/a.md"), tell("b", "notes/b.md")]),
      secretaryMessage(2, [{ type: "reasoning", text: "再写一份" }]),
      secretaryMessage(3, [tell("c", "notes/c.md")]),
      secretaryMessage(4, [{ type: "text", text: "写好了" }]),
      secretaryMessage(5, [tell("d", "notes/d.md"), tell("e", "notes/d.md"), call("f", "bash", "ls", { genericBash: true })]),
    ]);
    expect(shown(state)).toEqual(["做完告诉我 · 写 notes/a.md 等 3 次", "-", "-", "做完告诉我 · 写 notes/d.md ×2", "-", expect.stringMatching(/^通用 bash · /)]);
  });

  test("审批：批没批不同的不合并；都还没批、要批的事不一样的合成“…等 2 次”，批没批照旧钉在最后", () => {
    const asked = [secretaryMessage(1, [cardRef("p1")]), secretaryMessage(2, [cardRef("p2")])];
    const mixed = replay([approvalFrame(1, "p1", "a.db", "handled", APPROVED), approvalFrame(2, "p2", "b.db", "handled", DENIED), ...asked]);
    expect(shown(mixed)).toEqual(["审批 · 写 a.db · 已批准", "审批 · 写 b.db · 已拒绝"]);
    const pending = replay([approvalFrame(1, "p1", "a.db", "pending"), approvalFrame(2, "p2", "b.db", "pending"), ...asked]);
    expect(shown(pending)).toEqual(["审批 · 写 a.db 等 2 次 · 待你处理", "-"]);
  });

  test("英文的“等 N 次”照语言文件写", () => {
    english();
    const state = replay([recordFrame(1, "mcp_call", "“Album” person.rename: renamed p2"), recordFrame(2, "mcp_call", "“Album” filter.set: only p2")]);
    expect(shown(state)).toEqual(["MCP call · “Album” person.rename: renamed p2 (2 times)", "-"]);
  });
});
