// 详情页的内容（56 号票，照 AgentSense DetailPane 的 TextDetail / ToolDetail，按二狗的条目改写）：
// 回放主切面录下的真实事件流，拿会话条目层（52 号票）的条目 id 打开详情，断言详情里显示什么。
// 录像覆盖不到的（各种状况、思考并进组……）按共享协议的 schema 构造事件。
import fs from "node:fs";
import path from "node:path";
import { MessageEventPayload as MessageEventPayloadSchema, schemaChecker, ToolCallDetail as ToolCallDetailSchema } from "@ergou/protocol";
import { describe, expect, test } from "vitest";
import {
  callFullContent,
  type ChatItem,
  chatItems,
  type DetailContent,
  detailContent,
  type EventFrame,
  type HistoryPage,
  type MessageEnvelope,
  type MessageEventPayload,
  type MessagePart,
  replay,
  type ToolCallDetail,
  type UiInput,
  type UiState,
} from "../../src/state/index.ts";
import { frame } from "./events.ts";

function load(name: string): UiInput[] {
  return JSON.parse(fs.readFileSync(path.join(import.meta.dirname, "recordings", `${name}.json`), "utf8")) as UiInput[];
}

/** 打开某一条的详情 */
function open(state: UiState, items: readonly ChatItem[], id: string): DetailContent {
  return detailContent(state, items, { type: "item", id });
}

describe("文本详情：用户消息、思考、回复（secretary-chat）", () => {
  const state = replay(load("secretary-chat"));
  const items = chatItems(state, "secretary");

  test("种类标签、字数、完整内容；回复按 Markdown 渲染，别的按原文", () => {
    expect(items.map((it) => open(state, items, it.id)).map((d) => (d.kind === "text" ? [d.label, d.chars, d.text, d.markdown] : d.kind))).toEqual([
      ["用户输入", 2, "在吗", false],
      ["模型思考", 18, "用户在打招呼，先回应，再问有什么事。", false],
      ["模型回复", 14, "在的。今天有什么要我帮忙的？", true],
      ["用户输入", 11, "帮我记一下：周五交房租", false],
      ["模型回复", 36, "好，周五交房租，我记下了。不过现在我还不能建提醒，到时候需要你自己留意。", true],
    ]);
  });

  test("找不到的 id（比如那一条已经不在已加载的范围里）：说明不在了", () => {
    expect(open(state, items, "m-不存在")).toEqual({ kind: "missing", reason: "not_found" });
  });
});

describe("文本详情的其余几种", () => {
  test("任务里的回复写明所属任务；系统说明照原话（名字占位留着，界面画成名字标签）（timeline-zoom）", () => {
    const state = replay(load("timeline-zoom"));
    const items = chatItems(state, "maintainer:tm-1");
    const reply = open(state, items, items.at(-1)!.id);
    const system = open(state, items, items[0]!.id);
    expect([reply.kind === "text" && [reply.label, reply.task], system.kind === "text" && [system.label, system.markdown, system.task]]).toEqual([
      ["模型回复", "整理笔记和报告"],
      ["系统说明", false, "整理笔记和报告"],
    ]);
  });

  test("语音：用户的是识别出的文字（语音转写），带时长和识别状态（voice-message）", () => {
    const state = replay(load("voice-message"));
    const items = chatItems(state, "secretary");
    const voices = items.filter((it) => it.kind === "voice").map((it) => open(state, items, it.id));
    expect(voices.map((d) => d.kind === "text" && [d.label, d.text, d.voice])).toEqual([
      ["语音转写", "明天早上九点提醒我交报告", { speaker: "user", duration: "4″", status: "已识别" }],
      ["语音转写", "下午去买菜", { speaker: "user", duration: "2″", status: "已识别" }],
    ]);
  });

  test("agent 的语音：送进 TTS 的原文（语音回复）（voice-reply）", () => {
    const state = replay(load("voice-reply"));
    const items = chatItems(state, "secretary");
    const agent = items.filter((it) => it.kind === "voice" && it.speaker === "agent").map((it) => open(state, items, it.id));
    expect(agent.map((d) => d.kind === "text" && [d.label, d.text, d.voice?.speaker, d.voice?.status])).toEqual([
      ["语音回复", "好的，明早九点提醒你交报告。", "agent", undefined],
      ["语音回复", "周报整理好了，细节都在聊天里。", "agent", undefined],
    ]);
    // 口语总结的那段回复：写口语总结的调用挂在它上面，详情里列出来
    const summarized = items.find((it) => it.kind === "reply")!;
    const d = open(state, items, summarized.id);
    expect(d.kind === "text" && d.internalCalls.map((c) => [c.tool, c.internal])).toEqual([["spoken_summary", "它总结的那段回复"]]);
  });
});

const checkMessage = schemaChecker(MessageEventPayloadSchema);
const TM = "maintainer:tm-9";
/** 会话里的一条消息事件，按协议的 schema 构造 */
function messageFrame(seq: number, id: string, speaker: MessageEnvelope["speaker"], parts: MessagePart[]): EventFrame {
  const payload: MessageEventPayload = { message: { id, conversation: TM, speaker, time: `2026-10-09T10:00:${String(seq).padStart(2, "0")}.000+08:00`, parts } };
  const problem = checkMessage.firstError(payload);
  if (problem) throw new Error(`构造的事件不合 schema：${problem}`);
  return frame(TM, seq, "message", payload);
}
const call = (callId: string, extra: Partial<Extract<MessagePart, { type: "tool_call" }>> = {}): MessagePart => ({
  type: "tool_call",
  callId,
  tool: "read",
  argsSummary: `${callId}.md`,
  categoryTitles: [],
  disposition: "do",
  withinGrant: false,
  genericBash: false,
  outcome: "done",
  ...extra,
});

/** 一句话之后每个 part 各一条消息，再一段回复：打开中间那一组，看每一步怎么折 */
function runOf(parts: MessagePart[]): string[] {
  const state = replay([messageFrame(1, "u1", "user", [{ type: "text", text: "开始" }]), ...parts.map((p, i) => messageFrame(i + 2, `m${i}`, "agent", [p])), messageFrame(parts.length + 2, "r", "agent", [{ type: "text", text: "好了" }])]);
  const items = chatItems(state, TM);
  return runShape(open(state, items, items[1]!.id));
}

/** 同上，合起来的第一条上记的授权 */
function runGrantOf(parts: MessagePart[]): string | undefined {
  const state = replay([messageFrame(1, "u1", "user", [{ type: "text", text: "开始" }]), ...parts.map((p, i) => messageFrame(i + 2, `m${i}`, "agent", [p]))]);
  const items = chatItems(state, TM);
  const d = open(state, items, items[1]!.id);
  if (d.kind !== "tool_group") throw new Error(`应当是工具调用组的详情，实际是 ${d.kind}`);
  const head = d.steps.find((s) => s.kind === "call" && s.run?.kind === "head");
  return head?.kind === "call" && head.run?.kind === "head" ? head.run.grant : undefined;
}

describe("录像覆盖不到的", () => {
  test("两段话之间的思考并进组：详情里和调用按先后排；按思考的 id 打开的也是这一组", () => {
    const state = replay([
      messageFrame(1, "u1", "user", [{ type: "text", text: "看看笔记" }]),
      messageFrame(2, "a1", "agent", [{ type: "reasoning", text: "先读目录" }, call("c1", { tool: "ls", argsSummary: "." })]),
      messageFrame(3, "a2", "agent", [{ type: "reasoning", text: "再读笔记" }]),
      messageFrame(4, "a3", "agent", [call("c2", { outcome: "error", resultSummary: "没有这个文件" })]),
      messageFrame(5, "a4", "agent", [{ type: "text", text: "笔记不在" }]),
    ]);
    const items = chatItems(state, TM);
    const group = items[1]!;
    expect(stepLines(open(state, items, group.id))).toEqual(["思考：先读目录", "#1 ls . · 已执行", "思考：再读笔记", "#2 read c2.md · 出错 · 出错"]);
    expect(open(state, items, "a2:think")).toMatchObject({ kind: "tool_group", itemId: group.id });
  });

  test("连续 3 次以上、都顺利执行的同一个工具：只留第一条，挂上还有几次，其余折起来（照 AgentSense ZoomHistory 的 runs）", () => {
    expect(runOf([call("a"), call("b"), call("c"), call("d")])).toEqual(["a +3", "b 折", "c 折", "d 折"]);
    // 两次不折
    expect(runOf([call("a"), call("b"), call("x", { tool: "write" })])).toEqual(["a", "b", "x"]);
  });

  test("出了状况的、换了工具、中间有思考，都把连续断开；断开之后够 3 次的照样折", () => {
    expect(runOf([call("a"), call("b"), call("q", { disposition: "planned_only", categoryTitles: ["删除或覆盖"] }), call("c"), call("d"), call("e")])).toEqual(["a", "b", "q", "c +2", "d 折", "e 折"]);
    expect(runOf([call("a"), call("b"), { type: "reasoning", text: "再读一个" }, call("c")])).toEqual(["a", "b", "思考", "c"]);
    expect(runOf([call("a"), call("x", { outcome: "error" }), call("b"), call("c")])).toEqual(["a", "x", "b", "c"]);
  });

  test("有标注的不折（AgentSense：没有高危标注）：命中关注类别又不在授权内的、做完告诉我的、通用 bash；在授权内的照样折", () => {
    const granted = { categoryTitles: ["越出项目目录"], withinGrant: true };
    expect(runOf([call("a", granted), call("b", granted), call("c", granted)])).toEqual(["a +2", "b 折", "c 折"]);
    expect(runOf([call("a"), call("b", { categoryTitles: ["越出项目目录"] }), call("c")])).toEqual(["a", "b", "c"]);
    expect(runOf([call("a"), call("b", { disposition: "do_then_tell" }), call("c")])).toEqual(["a", "b", "c"]);
    const bash = { tool: "bash", genericBash: true };
    expect(runOf([call("a", bash), call("b", bash), call("c", bash)])).toEqual(["a", "b", "c"]);
  });

  test("合起来的那几次的授权（按钮上怎么说照它）：都在授权内、都不需要授权（没命中关注类别）、两样都有", () => {
    const granted = { categoryTitles: ["越出项目目录"], withinGrant: true };
    expect(runGrantOf([call("a", granted), call("b", granted), call("c", granted)])).toBe("within");
    expect(runGrantOf([call("a"), call("b"), call("c")])).toBe("not_needed");
    expect(runGrantOf([call("a", granted), call("b"), call("c")])).toBe("mixed");
  });

  test("往上翻：一组调用跨两页时组的 id 变了，按原来的 id 打开的还是这一组（并上更早的调用），第几次跟着重新数", () => {
    const live = [messageFrame(5, "m-c5", "agent", [call("c5")]), messageFrame(6, "m-c6", "agent", [call("c6")]), messageFrame(7, "r7", "agent", [{ type: "text", text: "都写好了" }])];
    const before = replay(live);
    const groupId = chatItems(before, TM)[0]!.id;
    const page: HistoryPage = {
      conversation: TM,
      messages: [
        { seq: 3, message: { id: "u3", conversation: TM, speaker: "user", time: "2026-10-09T10:00:03.000+08:00", parts: [{ type: "text", text: "读三个文件" }] } },
        { seq: 4, message: { id: "m-c4", conversation: TM, speaker: "agent", time: "2026-10-09T10:00:04.000+08:00", parts: [call("c4")] } },
      ],
      records: [],
      hasMore: true,
    };
    const after = replay([{ kind: "history_page", conversation: TM, page }], before);
    const items = chatItems(after, TM);
    expect(items[1]!.id).not.toBe(groupId);
    expect(stepLines(open(after, items, groupId))).toEqual(["#1 read c4.md · 已执行", "#2 read c5.md · 已执行", "#3 read c6.md · 已执行"]);
    expect(open(after, items, "m-c6#0")).toMatchObject({ kind: "tool_call", itemId: items[1]!.id, position: { number: 3, count: 3 } });
  });

  test("正在生成的回复：打开着的详情跟着变长，定稿后还是同一条", () => {
    const user = messageFrame(1, "u1", "user", [{ type: "text", text: "写首诗" }]);
    const delta = frame(TM, 1, "stream", { messageId: "a1", deltas: [{ part: 0, type: "text", offset: 0, text: "床前" }] });
    const streaming = replay([user, delta]);
    const id = chatItems(streaming, TM)[1]!.id;
    const before = open(streaming, chatItems(streaming, TM), id);
    const done = replay([user, delta, messageFrame(2, "a1", "agent", [{ type: "text", text: "床前明月光" }])]);
    const after = open(done, chatItems(done, TM), id);
    expect([before.kind === "text" && before.text, after.kind === "text" && after.text]).toEqual(["床前", "床前明月光"]);
  });
});

const checkDetail = schemaChecker(ToolCallDetailSchema);
/** 一次调用的完整参数和返回（53 号票的接口回的），按协议的 schema 构造 */
function full(overrides: Partial<ToolCallDetail> = {}): ToolCallDetail {
  const detail: ToolCallDetail = {
    callId: "tool:1",
    tool: "edit",
    toolTitle: "改文件",
    agentId: "tm-1",
    conversation: "maintainer:tm-1",
    taskId: "t-1",
    outcome: "done",
    startedAt: "2026-10-09T10:00:00.000+08:00",
    endedAt: "2026-10-09T10:00:01.250+08:00",
    args: { path: "notes.md", oldText: "a", newText: "b" },
    result: "Successfully replaced text in notes.md",
    isError: false,
    ...overrides,
  };
  const problem = checkDetail.firstError(detail);
  if (problem) throw new Error(`构造的完整内容不合 schema：${problem}`);
  return detail;
}

describe("单次调用的完整参数和返回（53 号票的接口取来的）", () => {
  test("工具的中文名、参数原样（按字段画）和原始 JSON、返回的文字、耗时", () => {
    expect(callFullContent(full())).toEqual({
      toolTitle: "改文件",
      args: { path: "notes.md", oldText: "a", newText: "b" },
      rawArgs: '{\n  "path": "notes.md",\n  "oldText": "a",\n  "newText": "b"\n}',
      result: "Successfully replaced text in notes.md",
      resultValue: undefined,
      truncated: [],
      withheld: false,
      purged: false,
      cleared: undefined,
      clearedNote: undefined,
      media: [],
      durationMs: 1250,
      agentId: "tm-1",
      effects: undefined,
    });
  });

  test("效果记录：摘要、涉及的对象（路径按怎么碰的写，收件人、网址，守卫没法确定的注明）；没有这个字段的是 undefined，空的是空数组", () => {
    const d = callFullContent(
      full({
        effects: [
          {
            seq: 7,
            tool: "copy",
            toolTitle: "复制",
            summary: "复制（bash「cp a.md b.md」）；改动 D:\\w\\b.md；成功，退出码 0",
            objects: [
              { kind: "path", access: "read", value: "D:\\w\\a.md" },
              { kind: "path", access: "write", value: "D:\\w\\b.md" },
            ],
          },
          {
            seq: 8,
            tool: "delete",
            summary: "删除；成功",
            objects: [
              { kind: "path", access: "delete", value: "$FILE", uncertain: true },
              { kind: "path", access: "unknown", value: "D:\\w\\c" },
            ],
          },
          {
            seq: 9,
            tool: "mcp__mail__send",
            summary: "发邮件；成功",
            objects: [
              { kind: "recipient", value: "me@example.com" },
              { kind: "url", value: "https://example.com/x" },
            ],
          },
        ],
      }),
    );
    expect(d.effects).toEqual([
      { seq: 7, title: "复制", summary: "复制（bash「cp a.md b.md」）；改动 D:\\w\\b.md；成功，退出码 0", objects: ["读 D:\\w\\a.md", "改动 D:\\w\\b.md"] },
      { seq: 8, title: "delete", summary: "删除；成功", objects: ["删除 $FILE（守卫当时没法确定）", "涉及 D:\\w\\c"] },
      { seq: 9, title: "mcp__mail__send", summary: "发邮件；成功", objects: ["发给 me@example.com", "网址 https://example.com/x"] },
    ]);
    expect(callFullContent(full({ effects: [] })).effects).toEqual([]);
  });

  test("效果记录写了多少（68 号票：效果日志里写入的全文只记长度和摘要哈希）：带着守护进程给的说明", () => {
    const d = callFullContent(
      full({ effects: [{ seq: 3, tool: "write", toolTitle: "写文件", summary: "写文件；改动 D:\\w\\a.md；成功", objects: [{ kind: "path", access: "write", value: "D:\\w\\a.md" }], content: "写入 1280 字" }] }),
    );
    expect(d.effects).toEqual([{ seq: 3, title: "写文件", summary: "写文件；改动 D:\\w\\a.md；成功", objects: ["改动 D:\\w\\a.md"], content: "写入 1280 字" }]);
  });

  test("返回是 JSON 的按结构给出（照 AgentSense 的 parseStructured），不是的照原文", () => {
    expect(callFullContent(full({ result: '{"commit":"1858cac","files":[{"path":"notes.md","status":"added"}]}' })).resultValue).toEqual({ commit: "1858cac", files: [{ path: "notes.md", status: "added" }] });
    expect(callFullContent(full({ result: "已提交 1858cac" })).resultValue).toBeUndefined();
    expect(callFullContent(full({ result: "[1, 2]" })).resultValue).toEqual([1, 2]);
  });

  test("截断了的注明在哪、原长多少：返回、参数里的某个字段", () => {
    const d = callFullContent(
      full({
        truncated: [
          { pointer: "/args/newText", bytes: 300_000 },
          { pointer: "/result", bytes: 1_048_576 },
        ],
      }),
    );
    expect(d.truncated).toEqual([
      { where: "args", path: ["newText"], bytes: 300_000 },
      { where: "result", path: [], bytes: 1_048_576 },
    ]);
  });

  test("读了密钥文件的不记返回；彻底删除过的注明；图片不内联，说明是什么、多大", () => {
    expect(callFullContent(full({ resultWithheld: "secret_file", result: "（密钥文件的内容不记录）" })).withheld).toBe(true);
    expect(callFullContent(full({ purged: true })).purged).toBe(true);
    expect(callFullContent(full({ result: "[image]", media: [{ type: "image", mimeType: "image/png", bytes: 12_800 }] })).media).toEqual(["图片（image/png，12.5 KB）"]);
  });

  test("过了保留期、超出总量上限清掉了的（65 号票）：注明为什么（详情页退回摘要时用这句）；效果记录照旧", () => {
    const effects = [{ seq: 3, tool: "edit", toolTitle: "改文件", summary: "改文件；成功", objects: [] }];
    const expired = callFullContent(full({ args: "notes.md", result: "Successfully replaced text in notes.md", cleared: { reason: "expired", at: "2027-01-08T04:15:00.000+08:00" }, effects }));
    expect(expired).toMatchObject({ cleared: "expired", clearedNote: "完整内容已过保留期，清掉了；上面是摘要。", effects: [{ seq: 3, title: "改文件", summary: "改文件；成功", objects: [] }] });
    const overLimit = callFullContent(full({ args: "notes.md", cleared: { reason: "over_limit", at: "2027-01-08T04:15:00.000+08:00" } }));
    expect(overLimit).toMatchObject({ cleared: "over_limit", clearedNote: "完整内容超出总量上限，从最旧的起清掉了；上面是摘要。" });
  });
});

describe("时间线记录的详情", () => {
  test("偏离：种类、一句话、详细说明、严重度（task-rejections）", () => {
    const state = replay(load("task-rejections"));
    const items = chatItems(state, "maintainer:tm-1");
    const d = open(state, items, items.find((it) => it.kind === "record")!.id);
    expect(d).toMatchObject({ kind: "record", label: "偏离", summary: "你累计拒绝了 5 次（审批、计划变更），任务先暂停：看过之后可以继续，或者取消任务", severity: "notice" });
  });

  test("操作记录：做了什么、凭什么执行的、结果、对应的卡片；被删的消息说明已彻底删除（memory-purge）", () => {
    const state = replay(load("memory-purge"));
    const items = chatItems(state, "secretary");
    const d = open(state, items, items.find((it) => it.kind === "record")!.id);
    expect(d).toMatchObject({ kind: "record", label: "操作记录", summary: "彻底删除 1 条素材", operation: { ok: true } });
    expect(d.kind === "record" && d.operation?.cardId).toBeTruthy();
    expect(open(state, items, items.find((it) => it.kind === "deleted")!.id)).toEqual({ kind: "missing", reason: "deleted" });
  });
});

/** 组的详情里每一步怎么折：调用写 callId，折起来的标"折"，第一条标"+N" */
function runShape(d: DetailContent): string[] {
  if (d.kind !== "tool_group") throw new Error(`应当是工具调用组的详情，实际是 ${d.kind}`);
  return d.steps.map((s) => (s.kind === "thinking" ? "思考" : `${s.call.callId}${s.run?.kind === "head" ? ` +${s.run.more}` : s.run?.kind === "tail" ? " 折" : ""}`));
}

/** 组详情里的每一步：思考写"思考"，调用写第几次、工具、参数摘要、结果的说法（出了状况的带上状况和原因） */
function stepLines(d: DetailContent): string[] {
  if (d.kind !== "tool_group") throw new Error(`应当是工具调用组的详情，实际是 ${d.kind}`);
  return d.steps.map((s) => {
    if (s.kind === "thinking") return `思考：${s.text}`;
    const c = s.call;
    const no = c.number === undefined ? "内部" : `#${c.number}`;
    return `${no} ${c.tool} ${c.args} · ${c.status}${c.issue ? ` · ${c.issueLabel}` : ""}${c.why ? `（${c.why}）` : ""}`;
  });
}

describe("工具调用组的详情：按先后列出每一步，出了状况的标清楚是第几次（typed-shell-tools）", () => {
  // 录制在 packages/daemon/test/main/typed-shell-tools.test.ts：维护者用带类型的 bash 工具干活，推送被时序规则退回、测试没过、
  // force push 被永不拦下、合并有冲突……
  const state = replay(load("typed-shell-tools"));
  const items = chatItems(state, "maintainer:tm-1");
  const groups = items.filter((it) => it.kind === "tool_group");

  test("逐个列出调了哪些工具、参数（摘要）、结果；第几次只数算进 N 的调用", () => {
    expect(stepLines(open(state, items, groups[1]!.id))).toEqual([
      "#1 create_remote_repo name=demo description=演示仓库 · 已执行 · 问过你",
      "#2 git_push remote=origin · 没有执行 · 被拦下（按规则退回）",
      "#3 run_tests args=[\"--fail\"] · 出错 · 出错",
      "#4 git_push remote=origin · 没有执行 · 被拦下（按规则退回）",
      "#5 run_tests  · 已执行",
    ]);
  });

  test("组的头上：调了几个、出了什么状况、各是第几次", () => {
    const d = open(state, items, groups[2]!.id);
    if (d.kind !== "tool_group") throw new Error("应当是组");
    expect([d.title, d.count, d.issues]).toEqual([
      "调用了 7 个工具：git_push ×2、bash、git_merge ×2、start_build、install_deps（2 次被拦下、1 次出错、1 次问过你）",
      7,
      [
        { issue: "blocked", label: "被拦下", count: 2, numbers: [2, 3] },
        { issue: "error", label: "出错", count: 1, numbers: [4] },
        { issue: "asked", label: "问过你", count: 1, numbers: [1] },
      ],
    ]);
  });

  test("每次调用：关注类别、守卫怎么判的、授权、通用 bash；结果摘要", () => {
    const d = open(state, items, groups[2]!.id);
    if (d.kind !== "tool_group") throw new Error("应当是组");
    const calls = d.steps.flatMap((s) => (s.kind === "call" ? [s.call] : []));
    expect(calls.slice(0, 3).map((c) => [c.categories, c.verdict, c.grant, c.grantLabel, c.genericBash, c.executed])).toEqual([
      [["以我的名义对外发送或发布"], "先问我", "outside", "不在授权内", false, true],
      [["以我的名义对外发送或发布"], "永不", "outside", "不在授权内", false, false],
      [["以我的名义对外发送或发布"], "永不", "outside", "不在授权内", true, false],
    ]);
    expect(calls[3]!.result).toMatch(/^合并 conflicting 有冲突/);
  });

  test("按调用的 id 打开单次调用：是组里第几次、共几次；\"在对话中定位\"定位到那一组", () => {
    const group = groups[1]!;
    if (group.kind !== "tool_group") throw new Error("应当是组");
    const pushed = group.calls[1]!;
    const d = open(state, items, pushed.id);
    if (d.kind !== "tool_call") throw new Error(`应当是单次调用的详情，实际是 ${d.kind}`);
    expect([d.itemId, d.position, d.call.tool, d.call.status, d.call.why, d.call.callId]).toEqual([group.id, { number: 2, count: 5 }, "git_push", "没有执行", "按规则退回", pushed.part.callId]);
    // 组的 id 打开的是组，不是第一次调用
    expect(open(state, items, group.id).kind).toBe("tool_group");
  });
});

describe("挂在别的条目上的内部工具调用（timeline-zoom）", () => {
  const state = replay(load("timeline-zoom"));
  const items = chatItems(state, "maintainer:tm-1");
  const planCard = items[1]!;

  test("卡片的详情列出挂在它上面的内部调用（提交计划），点进去是单次调用：写明由什么代表，不编号", () => {
    const d = open(state, items, planCard.id);
    if (d.kind !== "card") throw new Error(`应当是卡片的详情，实际是 ${d.kind}`);
    expect(d.internalCalls.map((c) => [c.tool, c.internal, c.number])).toEqual([["submit_plan", "计划卡", undefined]]);
    const opened = open(state, items, planCard.internalCalls[0]!.id);
    if (opened.kind !== "tool_call") throw new Error("应当是单次调用的详情");
    expect([opened.itemId, opened.position, opened.call.internal, opened.call.status]).toEqual([planCard.id, undefined, "计划卡", "已执行"]);
  });

  test("任务里的调用写明在做哪个阶段（AgentSense 的\"在做：「里程碑」\"）", () => {
    const groups = items.filter((it) => it.kind === "tool_group");
    const stages = groups.map((g) => (g.kind === "tool_group" ? open(state, items, g.calls[0]!.id) : g)).map((d) => (d.kind === "tool_call" ? d.stage : d.kind));
    expect(stages).toEqual(["第 1 阶段「整理笔记」", "第 1 阶段「整理笔记」", "第 2 阶段「写报告」"]);
  });

  test("要点层里点工具调用的要点：要点的 key 就是那次调用的 id，打开的是那一次", () => {
    const marks = items.flatMap((it) => it.marks).filter((m) => m.kind === "tool");
    expect(marks.length).toBeGreaterThan(0);
    const opened = marks.map((m) => open(state, items, m.key));
    expect(opened.map((d) => (d.kind === "tool_call" ? d.call.callId : d.kind))).toEqual(marks.map((m) => m.toolCall!.callId));
  });
});
