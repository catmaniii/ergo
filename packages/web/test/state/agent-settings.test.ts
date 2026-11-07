// 每个 agent 的会话里的 ⚙的状态层：单独的提示词两种写法（编辑框的初始内容、边改边查，和守护进程同一个检查）、
// 上下文用量写成的话（"8.2 万 / 12.8 万 token"、离自动压缩还有多少、上次压缩、"现在压缩"的样子）、清空那一块的话；
// 会话里清空的分隔线（"以下是新对话 · 10-13 14:02 清空"）；自动压缩点那一小块（420）。
import { MessageEventPayload as MessageEventPayloadSchema, schemaChecker } from "@ergo/protocol";
import { describe, expect, it } from "vitest";
import {
  AGENT_CLEAR_COPY,
  agentAutoCompactLines,
  agentClearText,
  type AgentContextView,
  agentContextLines,
  agentPromptDraft,
  agentPromptStateText,
  agentSettingsBusy,
  type AgentSettingsView,
  chatItems,
  checkAgentPromptDraft,
  checkAutoCompactDraft,
  type MessageEventPayload,
  replay,
  tokensText,
} from "../../src/state/index.ts";
import { frame } from "./events.ts";

const TEMPLATE = "你是「{{名字}}」。\n{{#对话审批开着}}\n开着\n{{/对话审批开着}}";

function view(overrides: { prompt?: Partial<AgentSettingsView["prompt"]>; clear?: Partial<AgentSettingsView["clear"]>; context?: Partial<AgentContextView>; readOnly?: string } = {}): AgentSettingsView {
  return {
    agentId: "secretary",
    kind: "secretary",
    label: "⟦个人助理⟧",
    ...(overrides.readOnly ? { readOnly: overrides.readOnly } : {}),
    identity: { roleId: "role-default", name: "二狗", defaultName: "二狗", nameSource: "default", voiceSource: "none" },
    roles: [{ id: "role-default", name: "二狗", isDefault: true }],
    prompt: {
      state: "template",
      content: "",
      template: {
        id: "secretary",
        title: "⟦个人助理⟧",
        content: TEMPLATE,
        placeholders: [
          { name: "名字", kind: "value", description: "用户起的名字" },
          { name: "对话审批开着", kind: "flag", description: "配置里开着时成立" },
        ],
        allowEmpty: false,
      },
      effective: "你是「二狗」。",
      ...overrides.prompt,
    },
    clear: { how: "new_session", pending: false, ...overrides.clear },
    context: { running: true, busy: false, compaction: "idle", ...overrides.context },
  };
}

describe("单独的提示词：两种写法", () => {
  it("编辑框的初始内容：正在用这种写法的是它；整份自己写从通用模板复制一份；追加从空的开始", () => {
    expect(agentPromptDraft(view(), "append")).toBe("");
    expect(agentPromptDraft(view(), "replace")).toBe(TEMPLATE);
    const appended = view({ prompt: { state: "append", content: "只说要点。" } });
    expect(agentPromptDraft(appended, "append")).toBe("只说要点。");
    expect(agentPromptDraft(appended, "replace")).toBe(TEMPLATE);
    expect(agentPromptDraft(view({ prompt: { state: "replace", content: "我自己的。" } }), "replace")).toBe("我自己的。");
  });

  it("边改边查：占位符照通用模板查（写明第几行），整份的不能是空的，追加空的可以；和现在用的一样算没改", () => {
    expect(checkAgentPromptDraft(view(), "append", "回答短一点，{{名字}}")).toEqual({ ok: true, problem: undefined, changed: true });
    const bad = checkAgentPromptDraft(view(), "append", "第一行\n叫我{{老板}}");
    expect(bad.ok).toBe(false);
    expect(bad.problem).toContain("第 2 行：不认得的占位符 {{老板}}");
    expect(checkAgentPromptDraft(view(), "replace", "  ").problem).toContain("不能是空的");
    // 追加空着、现在也没有单独的：没有可存的
    expect(checkAgentPromptDraft(view(), "append", "")).toMatchObject({ ok: true, changed: false });
    // 原来追加了一段，清空了再存：等于恢复用通用模板，算改了
    const appended = view({ prompt: { state: "append", content: "只说要点。" } });
    expect(checkAgentPromptDraft(appended, "append", "")).toMatchObject({ ok: true, changed: true });
    expect(checkAgentPromptDraft(appended, "append", "只说要点。\r\n")).toMatchObject({ changed: false });
    // 整份自己写：从模板复制过来没改也能存（这就是"整份自己写"），条件写对了照样过
    expect(checkAgentPromptDraft(appended, "replace", TEMPLATE)).toMatchObject({ ok: true, changed: true });
  });

  it("面板顶上一句：现在用的是哪种；自己写的那份有错时说在用通用模板", () => {
    expect(agentPromptStateText(view())).toContain("用通用模板");
    expect(agentPromptStateText(view({ prompt: { state: "append", content: "x" } }))).toBe("通用模板 + 追加的一段");
    expect(agentPromptStateText(view({ prompt: { state: "replace", content: "x" } }))).toContain("通用模板改了不影响它");
    expect(agentPromptStateText(view({ prompt: { state: "replace", content: "x", problem: "第 1 行：……" } }))).toContain("现在用的是通用模板");
  });
});

describe("上下文用量和现在压缩", () => {
  it("用了多少 / 窗口多大、进度条、离自动压缩还有多少（窗口减 16384）", () => {
    const lines = agentContextLines({ running: true, busy: false, compaction: "idle", usedTokens: 82_000, window: 128_000, autoCompactAt: 128_000 - 16_384, keepRecentTokens: 20_000 }, undefined);
    expect(lines.usage).toBe("8.2 万 / 12.8 万 token");
    expect(lines.ratio).toBeCloseTo(82_000 / 128_000);
    expect(lines.overLine).toBe(false);
    expect(lines.autoCompact).toBe("离自动压缩还有 3 万 token（用量超过 11.2 万 token 时自动压缩，最近约 2 万 token 原样保留）");
    expect(lines.lastCompacted).toBe("这段对话还没压缩过");
    expect(lines).toMatchObject({ canCompact: true, cannotCompact: undefined, compaction: undefined });
  });

  it("过了自动压缩的线；还不知道窗口；压缩之后还没调用过模型；对话还没调用过模型", () => {
    expect(agentContextLines({ running: true, busy: false, compaction: "idle", usedTokens: 120_000, window: 128_000, autoCompactAt: 111_616 }, undefined)).toMatchObject({
      overLine: true,
      autoCompact: expect.stringContaining("已经过了自动压缩的线"),
    });
    expect(agentContextLines({ running: false, busy: false, compaction: "idle", usedTokens: 5_000 }, undefined)).toMatchObject({ usage: "5000 token（窗口多大要等它下次运行时报上来）", ratio: undefined });
    expect(agentContextLines({ running: true, busy: false, compaction: "idle", lastCompactedAt: "2026-10-13T14:02:00+08:00", measuredAt: "2026-10-13T14:00:00+08:00" }, undefined)).toMatchObject({
      usage: "刚压缩过，下一次调用模型后更新",
      lastCompacted: "上次压缩：10-13 14:02",
    });
    expect(agentContextLines({ running: false, busy: false, compaction: "idle" }, undefined).usage).toBe("这段对话还没调用过模型");
  });

  it("现在压缩：在等、正在压、上次的结果；只读的、没有在进行的一段的不能点", () => {
    const base: AgentContextView = { running: true, busy: true, compaction: "waiting" };
    expect(agentContextLines(base, undefined)).toMatchObject({ compaction: "它正在说，说完这一条就压缩", canCompact: false });
    expect(agentContextLines({ ...base, running: false }, undefined).compaction).toBe("先把它拉起来，再压缩");
    expect(agentContextLines({ ...base, compaction: "running" }, undefined).compaction).toBe("正在压缩……");
    const idle: AgentContextView = { running: true, busy: false, compaction: "idle" };
    expect(agentContextLines({ ...idle, lastCompact: { outcome: "done", at: "2026-10-13T14:02:00+08:00" } }, undefined).compaction).toBe("压缩好了（10-13 14:02）");
    expect(agentContextLines({ ...idle, lastCompact: { outcome: "nothing", at: "2026-10-13T14:02:00+08:00" } }, undefined).compaction).toContain("没什么可压的");
    expect(agentContextLines({ ...idle, lastCompact: { outcome: "failed", at: "2026-10-13T14:02:00+08:00", message: "模型出错了" } }, undefined).compaction).toBe("没压成（10-13 14:02）：模型出错了");
    expect(agentContextLines(idle, "任务已取消，这里只能看")).toMatchObject({ canCompact: false, cannotCompact: "任务已取消，这里只能看" });
    expect(agentContextLines({ ...idle, cannotCompact: "现在没有在进行的一段会话" }, undefined)).toMatchObject({ canCompact: false, cannotCompact: "现在没有在进行的一段会话" });
  });

  it("token 数一万以上写几万", () => {
    expect(tokensText(9_999)).toBe("9999");
    expect(tokensText(82_000)).toBe("8.2 万");
    expect(tokensText(128_000)).toBe("12.8 万");
    expect(tokensText(1_000_000)).toBe("100 万");
  });
});

describe("清空当前对话", () => {
  it("确认框的话：秘书、任务新开一段；项目负责人是重置负责人", () => {
    expect(AGENT_CLEAR_COPY.new_session.body).toContain("清空后它不记得之前聊过什么，记录照样能看");
    expect(AGENT_CLEAR_COPY.reset_maintainer.title).toBe("重置负责人？");
  });

  it("在等它说完、上次清空（重置）的时间；面板开着时在等清空、在压缩要再取", () => {
    expect(agentClearText(view())).toBeUndefined();
    expect(agentClearText(view({ clear: { pending: true } }))).toBe("它正在说，说完这一条就清空");
    expect(agentClearText(view({ clear: { lastAt: "2026-10-13T14:02:00+08:00" } }))).toBe("上次清空：10-13 14:02");
    expect(agentClearText(view({ clear: { how: "reset_maintainer", lastAt: "2026-10-13T14:02:00+08:00" } }))).toBe("上次重置：10-13 14:02");
    expect(agentSettingsBusy(view())).toBe(false);
    expect(agentSettingsBusy(view({ clear: { pending: true } }))).toBe(true);
    expect(agentSettingsBusy(view({ context: { compaction: "running" } }))).toBe(true);
  });

  it("会话里的分隔线：一条单独的分隔线条目，\"以下是新对话 · 10-13 14:02 清空\"，前后的消息照常", () => {
    const check = schemaChecker(MessageEventPayloadSchema);
    const message = (seq: number, id: string, speaker: "user" | "system", parts: MessageEventPayload["message"]["parts"], time: string): ReturnType<typeof frame> => {
      const payload: MessageEventPayload = { message: { id, conversation: "secretary", speaker, time, parts } };
      expect(check.firstError(payload)).toBeUndefined();
      return frame("secretary", seq, "message", payload);
    };
    const items = chatItems(
      replay([
        message(1, "m-1", "user", [{ type: "text", text: "暗号是蓝鲸" }], "2026-10-13T14:00:00+08:00"),
        message(2, "m-2", "system", [{ type: "conversation_cleared" }], "2026-10-13T14:02:00+08:00"),
        message(3, "m-3", "user", [{ type: "text", text: "新的一句" }], "2026-10-13T14:03:00+08:00"),
      ]),
      "secretary",
    );
    expect(items.map((item) => item.kind)).toEqual(["user", "divider", "user"]);
    expect(items[1]).toMatchObject({ kind: "divider", keyLine: "以下是新对话 · 10-13 14:02 清空", divider: { type: "conversation_cleared" } });
  });
});

// 420：⚙ 里的自动压缩点——跟随默认还是单独设的、设的比这个模型的上限大时按上限算（写明为什么）、自己管压缩的灰掉、
// 上次自动压缩没压成写什么时候再试；改的时候边改边查（和守护进程同一个函数）
describe("自动压缩点", () => {
  const WINDOW = 1_000_000;
  const auto = (over: Partial<NonNullable<AgentContextView["autoCompact"]>> = {}) =>
    view({ context: { window: WINDOW, autoCompactAt: 700_000, autoCompact: { source: "default", defaultAt: 700_000, limit: WINDOW - 16_384, ...over } } });

  it("跟随默认：输入框是默认值，能改不能恢复默认；单独设的：写默认是多少，能恢复默认", () => {
    expect(agentAutoCompactLines(auto())).toEqual({ value: 700_000, source: "跟随设置 · 模型里的默认：70 万 token", clamped: undefined, managed: undefined, failed: undefined, canEdit: true, canReset: false });
    expect(agentAutoCompactLines(auto({ source: "own", own: 300_000 }))).toMatchObject({ value: 300_000, source: "单独设的：30 万 token（默认是 70 万）", canEdit: true, canReset: true });
    // 没接模型设置（没有这一块）
    expect(agentAutoCompactLines(view())).toBeUndefined();
  });

  it("设的比这个模型的上限大：写按多少算、为什么；只读的、自己管压缩的（Claude Code）不能改", () => {
    const clamped = view({ context: { window: 128_000, autoCompactAt: 111_616, autoCompact: { source: "own", own: 900_000, defaultAt: 700_000, limit: 111_616, clamped: true } } });
    expect(agentAutoCompactLines(clamped)?.clamped).toBe("设的 90 万 比这个模型的上限大（窗口 12.8 万 减 16384，到那里 pi 自己就压了），现在按 11.2 万 算");
    expect(agentAutoCompactLines(view({ readOnly: "任务已经结束", context: { autoCompact: { source: "own", own: 300_000, defaultAt: 700_000 } } }))).toMatchObject({ canEdit: false, canReset: false });
    expect(agentAutoCompactLines(view({ context: { autoCompact: { source: "default", defaultAt: 700_000, managedBy: "Claude Code" } } }))).toMatchObject({
      managed: "由 Claude Code 自己管压缩，这里设的压缩点对它不起作用",
      canEdit: false,
    });
  });

  it("上次自动压缩没压成：什么时候、为什么、什么时候再试；压好了的不写", () => {
    const failed = auto({ last: { outcome: "failed", by: "ergo", at: "2026-11-07T14:02:00.000+08:00", message: "服务商忙（500）" }, failures: 1, retryAt: "2026-11-07T14:17:00.000+08:00" });
    expect(agentAutoCompactLines(failed)?.failed).toBe("上次自动压缩没压成（11-07 14:02）：服务商忙（500）。11-07 14:17 之前不再试，之后过了压缩点、说完一轮再试");
    expect(agentAutoCompactLines(auto({ last: { outcome: "done", by: "ergo", at: "2026-11-07T14:02:00.000+08:00" } }))?.failed).toBeUndefined();
  });

  it("边改边查：认整数（可以带空格、逗号）、最少 5 万、不超过这个模型的上限；和现在设的一样算没改", () => {
    expect(checkAutoCompactDraft("500000", 700_000)).toEqual({ at: 500_000, problem: undefined, changed: true });
    expect(checkAutoCompactDraft("500,000", 700_000).at).toBe(500_000);
    expect(checkAutoCompactDraft("700000", 700_000).changed).toBe(false);
    expect(checkAutoCompactDraft("40000", 700_000).problem).toBe("最少 50,000 token：再小压完马上又满");
    expect(checkAutoCompactDraft("990000", 700_000, { window: WINDOW, limit: WINDOW - 16_384 }).problem).toBe("这个模型最多设到 983,616 token（窗口 1,000,000 减 16,384，再往上就是 pi 自己压缩的点了）");
    expect(checkAutoCompactDraft("七十万", 700_000)).toMatchObject({ at: undefined, problem: "要填一个整数（token 数）", changed: true });
    expect(checkAutoCompactDraft("", 700_000).changed).toBe(false);
  });
});
