// 守卫切面：关注类别 × 对话 / 任务的默认处置（规格第 9 节的表）、取最严、设置只会更严、自定义类别。
import { describe, expect, it } from "vitest";
import { judgeToolCall, type BuiltinCategoryId, type Disposition, type GuardInput } from "../../src/guard/index.ts";
import { call, dispositionFinding, inChat, inTask, maintainer, task } from "./helpers/guard-input.ts";
import { categoryTool, TEST_TOOLS } from "./helpers/test-tools.ts";

/** 规格第 9 节的默认处置表（"—" 的那一格万一命中，按先问我） */
const DEFAULT_TABLE: [BuiltinCategoryId, Disposition, Disposition][] = [
  ["spend_money", "hand_over", "hand_over"],
  ["external_send", "ask_first", "ask_first"], // 任务里"计划里列了才做"，没有授权项 → 先问
  ["delete_or_overwrite", "ask_first", "notify_after"],
  ["irreversible_commit", "ask_first", "ask_first"], // 同上
  ["account_security", "ask_first", "ask_first"],
  ["outside_project", "ask_first", "ask_first"], // 同上
  ["memory_out_of_scope", "ask_first", "ask_first"],
  ["unplanned_work_order", "ask_first", "ask_first"],
  ["unknown_write", "ask_first", "ask_first"],
];

/** 任务里登记为"计划里列了才做"的类别 */
const PLAN_LISTED_IN_TASK: BuiltinCategoryId[] = ["external_send", "irreversible_commit", "outside_project"];

const withTools = (input: GuardInput): GuardInput => ({ ...input, tools: TEST_TOOLS });

describe("关注类别 × 对话或任务的默认处置", () => {
  for (const [category, chat, inTaskDisposition] of DEFAULT_TABLE) {
    it(`${category}：对话里 ${chat}，任务里 ${inTaskDisposition}`, () => {
      const c = call(categoryTool(category), { target: "x" });
      const chatJ = judgeToolCall(withTools(inChat(maintainer(), c)));
      expect(chatJ.disposition).toBe(chat);
      expect(chatJ.categories).toEqual([category]);

      const taskJ = judgeToolCall(withTools(inTask(maintainer(), c)));
      expect(taskJ.disposition).toBe(inTaskDisposition);
      expect(taskJ.categories).toEqual([category]);
    });
  }

  it("任务里登记为'计划里列了才做'的三类，判定依据里记着类别本身的处置", () => {
    for (const category of PLAN_LISTED_IN_TASK) {
      const j = judgeToolCall(withTools(inTask(maintainer(), call(categoryTool(category), { target: "x" }))));
      const finding = dispositionFinding(j, category);
      expect(finding?.categoryDisposition).toBe("plan_listed");
      expect(finding?.disposition).toBe("ask_first");
      expect(j.explanation).toMatch(/计划里列了才做/);
    }
  });

  it("对话里没有计划，'计划里列了才做'等同'先问我'", () => {
    const j = judgeToolCall(withTools(inChat(maintainer(), call(categoryTool("external_send"), { target: "x" }))));
    expect(j.disposition).toBe("ask_first");
  });

  it("不落在任何类别：直接做只记录；带'做完告诉我'标记：做完告诉我", () => {
    for (const input of [inChat, inTask]) {
      expect(judgeToolCall(withTools(input(maintainer(), call("mcp_plain", { target: "x" })))).disposition).toBe("log_only");
      expect(judgeToolCall(withTools(input(maintainer(), call("mcp_notify", { target: "x" })))).disposition).toBe("notify_after");
    }
  });

  it("一次调用落在多个类别时取最严", () => {
    // 付款工具同时带"花钱"（交给我做）和底线；发邮件带"对外发送"（先问我）
    const j = judgeToolCall(withTools(inChat(maintainer(), call("mcp_send_email", { to: "a@b.c", subject: "s", body: "b" }), {
      settings: { custom: [{ id: "mail-a", title: "发给 a", match: { recipients: ["A@B.C"] }, chat: "hand_over", task: "hand_over" }] },
    })));
    expect(j.categories).toEqual(["external_send", "mail-a"]);
    expect(j.disposition).toBe("hand_over");
  });

  it("没登记的工具按'未知的写操作'先问用户", () => {
    const j = judgeToolCall(inTask(maintainer(), call("mystery_tool", { a: 1 })));
    expect(j.disposition).toBe("ask_first");
    expect(j.categories).toEqual(["unknown_write"]);
    expect(j.explanation).toMatch(/mystery_tool/);
  });
});

describe("关注类别设置", () => {
  const sendEmail = call("mcp_send_email", { to: "boss@corp.com", subject: "周报", body: "本周完成了……" });
  const deleteTool = call(categoryTool("delete_or_overwrite"), { target: "x" });

  it("内置类别设得比默认严：判定随之变严", () => {
    const settings = { builtin: { delete_or_overwrite: { task: "ask_first" as const } } };
    expect(judgeToolCall(withTools(inTask(maintainer(), deleteTool, { settings }))).disposition).toBe("ask_first");
  });

  it("内置类别设得比默认松：不起作用，仍按默认", () => {
    const settings = { builtin: { spend_money: { chat: "log_only" as const, task: "log_only" as const } } };
    for (const input of [inChat, inTask]) {
      const j = judgeToolCall(withTools(input(maintainer(), call(categoryTool("spend_money"), { target: "x" }), { settings })));
      expect(j.disposition).toBe("hand_over");
    }
  });

  it("自定义类别没有默认，按设置里它的处置判；没命中不影响判定", () => {
    const settings = {
      custom: [
        {
          id: "mail-boss",
          title: "给老板发邮件",
          match: { tools: ["mcp_send_email"], recipients: ["boss@corp.com"] },
          chat: "never" as const,
          task: "notify_after" as const,
        },
      ],
    };
    const chatJ = judgeToolCall(withTools(inChat(maintainer(), sendEmail, { settings })));
    expect(chatJ.categories).toEqual(["external_send", "mail-boss"]);
    expect(chatJ.disposition).toBe("never");
    expect(chatJ.explanation).toMatch(/给老板发邮件/);

    const other = call("mcp_send_email", { to: "friend@corp.com", subject: "s", body: "b" });
    const otherJ = judgeToolCall(withTools(inChat(maintainer(), other, { settings })));
    expect(otherJ.categories).toEqual(["external_send"]);
    expect(otherJ.disposition).toBe("ask_first");
  });

  it("自定义类别设成'直接做只记录'，放宽不了一同命中的内置类别", () => {
    const settings = {
      custom: [{ id: "mail-any", title: "发邮件", match: { tools: ["mcp_send_email"] }, chat: "log_only" as const, task: "log_only" as const }],
    };
    expect(judgeToolCall(withTools(inChat(maintainer(), sendEmail, { settings }))).disposition).toBe("ask_first");
  });

  it("自定义类别改了处置或删掉后，下一次判定按新设置走", () => {
    const category = {
      id: "mail-boss",
      title: "给老板发邮件",
      match: { recipients: ["boss@corp.com"] },
      chat: "never" as const,
      task: "never" as const,
    };
    expect(judgeToolCall(withTools(inChat(maintainer(), sendEmail, { settings: { custom: [category] } }))).disposition).toBe("never");
    const relaxed = { ...category, chat: "log_only" as const };
    expect(judgeToolCall(withTools(inChat(maintainer(), sendEmail, { settings: { custom: [relaxed] } }))).disposition).toBe("ask_first");
    expect(judgeToolCall(withTools(inChat(maintainer(), sendEmail, { settings: { custom: [] } }))).categories).toEqual(["external_send"]);
  });

  it("金额规则：付款金额大于阈值才命中", () => {
    const settings = {
      custom: [{ id: "big-pay", title: "大额付款", match: { amountOver: 1000 }, chat: "never" as const, task: "never" as const }],
    };
    const small = judgeToolCall(withTools(inTask(maintainer(), call("mcp_pay", { payee: "shop", amount: 20 }), { settings })));
    expect(small.categories).not.toContain("big-pay");
    const big = judgeToolCall(withTools(inTask(maintainer(), call("mcp_pay", { payee: "shop", amount: 5000 }), { settings })));
    expect(big.categories).toContain("big-pay");
    expect(big.disposition).toBe("never");
  });

  it("本任务的关注类别只在全局之上增加：同一调用在这个任务和另一个任务里判定不同", () => {
    const withExtra = task({
      plan: {
        grants: [],
        watchCategories: {
          custom: [
            { id: "task-plain", title: "本任务：动测试工具", match: { tools: ["mcp_plain"] }, chat: "ask_first", task: "ask_first" },
          ],
          builtin: { delete_or_overwrite: { task: "ask_first" } },
        },
      },
    });
    const plainHere = judgeToolCall(withTools(inTask(maintainer(), call("mcp_plain", { target: "x" }), { task: withExtra })));
    expect(plainHere.disposition).toBe("ask_first");
    expect(plainHere.categories).toEqual(["task-plain"]);
    const plainElsewhere = judgeToolCall(withTools(inTask(maintainer(), call("mcp_plain", { target: "x" }))));
    expect(plainElsewhere.disposition).toBe("log_only");

    expect(judgeToolCall(withTools(inTask(maintainer(), deleteTool, { task: withExtra }))).disposition).toBe("ask_first");
  });

  it("本任务的设置往松里调内置类别也不起作用", () => {
    const loosen = task({ plan: { grants: [], watchCategories: { builtin: { account_security: { task: "log_only" } } } } });
    const j = judgeToolCall(withTools(inTask(maintainer(), call(categoryTool("account_security"), { target: "x" }), { task: loosen })));
    expect(j.disposition).toBe("ask_first");
  });
});
