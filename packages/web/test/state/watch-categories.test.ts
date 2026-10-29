// 前端状态层：设置里的关注类别（26 号票）。关注类别频道上的设置事件归并成设置页的样子；内置类别的下拉只给不比默认更松的档；
// 编辑框里写的规则变成请求；计划卡上加的类别、本任务的关注类别和用户的限制怎么列。
import { describe, expect, test } from "vitest";
import {
  builtinChoices,
  categoryDraftOf,
  categoryFormOf,
  CHANNELS,
  EVENT_TYPES,
  emptyCategoryForm,
  formUnregisteredTools,
  heldByTasksNotice,
  type Plan,
  type PlanCardPayload,
  planCategoryAdditionOf,
  planCategoryRows,
  planConfirmInput,
  replay,
  userLimitRows,
  type WatchCategoriesState,
  watchCategorySettings,
  type WatchCategorySettingsEventPayload,
} from "../../src/state/index.ts";
import { frame } from "./events.ts";

const state = (overrides: Partial<WatchCategoriesState> = {}): WatchCategoriesState => ({
  builtin: [
    { id: "delete_or_overwrite", title: "删除或覆盖", defaults: { chat: "ask_first", task: "do_then_tell" }, chat: "ask_first", task: "do_then_tell" },
    { id: "unplanned_work_order", title: "计划外工单", defaults: { chat: null, task: "ask_first" }, chat: null, task: "ask_first" },
  ],
  bottomLines: [{ id: "payment_account_auth", title: "付款转账", disposition: "hand_to_me" }],
  custom: [],
  tools: [{ name: "write", title: "写文件" }],
  problems: [],
  ...overrides,
});
const event = (seq: number, s: WatchCategoriesState, change: WatchCategorySettingsEventPayload["change"] = { op: "file" }) =>
  frame(CHANNELS.watchCategories, seq, EVENT_TYPES.watchCategorySettings, { state: s, change, by: "system", time: "2026-10-08T09:00:00+08:00" } satisfies WatchCategorySettingsEventPayload);

describe("关注类别频道", () => {
  test("还没收到是 undefined；之后是最后一条事件里的设置；重新同步就清掉", () => {
    expect(watchCategorySettings(replay([]))).toBeUndefined();
    const custom = [{ id: "c-1", title: "动迁移目录", match: { paths: ["D:\\app\\db"] }, chat: "never" as const, task: "ask_first" as const }];
    const s = replay([event(1, state()), event(2, state({ custom }), { op: "create_custom", categoryId: "c-1" })]);
    expect(watchCategorySettings(s)?.custom).toEqual(custom);
    expect(watchCategorySettings(replay([event(1, state()), { kind: "resync", channel: CHANNELS.watchCategories }]))).toBeUndefined();
  });

  test("删除或调松后还有进行中的任务按确认时的设置检查它：设置页说一声；下一次修改没有就不说", () => {
    const held = replay([event(1, state()), event(2, state(), { op: "delete_custom", categoryId: "c-1", heldByTasks: 2 })]);
    expect(heldByTasksNotice(held)).toBe("刚才的修改：2 个进行中的任务仍按确认时的设置检查");
    expect(heldByTasksNotice(replay([event(1, state()), event(2, state(), { op: "delete_custom", categoryId: "c-1" })]))).toBeUndefined();
  });

  test("内置类别的下拉只给不比默认更松的档；'—'的场景（计划外工单的对话里）没有下拉", () => {
    const [del, unplanned] = state().builtin;
    expect(builtinChoices(del!, "task")).toEqual(["do_then_tell", "planned_only", "ask_first", "hand_to_me", "never"]);
    expect(builtinChoices(del!, "chat")).toEqual(["ask_first", "hand_to_me", "never"]);
    expect(builtinChoices(unplanned!, "chat")).toEqual([]);
  });
});

describe("自定义类别的编辑框", () => {
  test("工具、收件人按逗号或空白分开，路径一行一个，金额是数字；空的条件不写", () => {
    const form = { ...emptyCategoryForm(), title: " 给房东发邮件 ", tools: "mcp_send_email， write", paths: "D:\\Program Files\\x\n\nE:\\docs ", recipients: "landlord@mail.com、Agent@x.com", amountOver: " 500 ", chat: "never" as const };
    expect(categoryDraftOf(form)).toEqual({
      draft: {
        title: "给房东发邮件",
        match: { tools: ["mcp_send_email", "write"], paths: ["D:\\Program Files\\x", "E:\\docs"], recipients: ["landlord@mail.com", "Agent@x.com"], amountOver: 500 },
        chat: "never",
        task: "ask_first",
      },
    });
  });

  test("名字空、一条规则都没写、金额不是数字：给出问题，不发请求", () => {
    expect(categoryDraftOf(emptyCategoryForm())).toEqual({ problems: ["写个名字", "规则至少写一条：匹配工具、路径、收件人或金额"] });
    expect(categoryDraftOf({ ...emptyCategoryForm(), title: "x", amountOver: "五百" })).toEqual({ problems: ["金额要写数字（大于它才算命中）"] });
  });

  test("计划卡上给本任务加类别：同一套名字和规则的检查，处置一档", () => {
    expect(planCategoryAdditionOf({ ...emptyCategoryForm(), title: " 动迁移目录 ", paths: "D:\\app\\db" }, "never")).toEqual({
      addition: { title: "动迁移目录", match: { paths: ["D:\\app\\db"] }, disposition: "never" },
    });
    expect(planCategoryAdditionOf(emptyCategoryForm(), "never")).toEqual({ problems: ["写个名字", "规则至少写一条：匹配工具、路径、收件人或金额"] });
  });

  test("还没登记的工具可以写，提示登记后生效", () => {
    const tools = [{ name: "write", title: "写文件" }];
    expect(formUnregisteredTools({ tools: "write, mcp_video_upload" }, tools)).toEqual(["mcp_video_upload"]);
    expect(categoryDraftOf({ ...emptyCategoryForm(), title: "x", tools: "mcp_video_upload" })).toEqual({ draft: expect.objectContaining({ match: { tools: ["mcp_video_upload"] } }) });
  });

  test("改规则时编辑框从现有的类别填好", () => {
    const form = categoryFormOf({ title: "动迁移目录", match: { paths: ["D:\\a", "D:\\b"], amountOver: 3 }, chat: "never", task: "do" });
    expect(form).toEqual({ title: "动迁移目录", tools: "", paths: "D:\\a\nD:\\b", recipients: "", amountOver: "3", chat: "never", task: "do" });
    expect(categoryDraftOf(form)).toEqual({ draft: { title: "动迁移目录", match: { paths: ["D:\\a", "D:\\b"], amountOver: 3 }, chat: "never", task: "do" } });
  });
});

const plan: Plan = {
  stages: [
    {
      stageId: "s1",
      title: "写报告",
      deliverables: ["report.md"],
      acceptance: [{ criterion: "你认可", method: "user" }],
      mode: "open",
      dependsOn: [],
      policy: { grants: [{ id: "push", tool: "git_push", title: "推送报告", scope: { remote: "origin", branch: ["main", "report"] }, maxUses: 1 }], temporalRules: [] },
      budget: { tokens: 1000, toolCalls: 10 },
    },
  ],
  stageGroups: [],
  toolkit: { skills: [], mcp: [], bash: true, network: true },
  projects: [],
  watchCategories: [
    { id: "spend_money", title: "花钱" },
    { id: "delete_or_overwrite", title: "删除或覆盖", disposition: "ask_first" },
    { id: "c-1", title: "动迁移目录" },
    { id: "photos", title: "动照片", disposition: "never", match: { paths: ["E:\\photos"] } },
    { id: "t-1-p1-c1", title: "推送都问我", disposition: "ask_first", match: { tools: ["git_push"] } },
  ],
  userLimits: [
    {
      id: "l1",
      quote: "别往 main 推，只推一次",
      temporalRules: [{ id: "no-main", trigger: { tool: "git_push", where: { eq: ["$current.args.branch", "main"] } }, on_violation: "block" }],
      grantNarrowings: [{ grantId: "push", maxUses: 1 }],
    },
  ],
  assumptions: [],
  stops: { count: 0, where: [] },
  tokenEstimate: 1000,
};
const payload = (overrides: Partial<PlanCardPayload> = {}): PlanCardPayload => ({
  taskId: "t-1",
  taskTitle: "X",
  revision: 1,
  planId: "t-1-p1",
  goal: "g",
  plan,
  globalCategories: ["spend_money", "delete_or_overwrite", "c-1"],
  grantInfo: {},
  addedCategories: ["t-1-p1-c1"],
  ...overrides,
});

describe("计划卡：本任务要提醒的关注类别、用户的限制", () => {
  test("每个类别标明来处：全局的（删不掉）、维护者调严了的、维护者为本任务加的、你在卡上加的；带处置和规则", () => {
    expect(planCategoryRows(payload()).map((r) => [r.id, r.origin, r.disposition ?? null, r.rule ?? null])).toEqual([
      ["spend_money", "global", null, null],
      ["delete_or_overwrite", "global_tightened", "ask_first", null],
      ["c-1", "global", null, null],
      ["photos", "maintainer_added", "never", "路径在 E:\\photos 之内"],
      ["t-1-p1-c1", "user_added", "ask_first", "工具是 git_push"],
    ]);
  });

  test("用户的限制：原话（核对得上的）或维护者转述，编译出的规则和授权收窄（由结构化数据生成的文字）", () => {
    const row = { id: "l1", quote: "别往 main 推，只推一次", rules: ["git_push 一律禁止（只在满足条件时检查）；违反就不做"], narrowings: ["「推送报告」（push）：最多 1 次"] };
    expect(userLimitRows(payload({ verifiedQuotes: ["l1"] }))).toEqual([{ ...row, verified: true }]);
    expect(userLimitRows(payload())).toEqual([{ ...row, verified: false }]);
  });

  test("在卡上加的类别随确认交出", () => {
    const added = [{ title: "动迁移目录", match: { paths: ["D:\\app\\db"] }, disposition: "ask_first" as const }];
    expect(planConfirmInput(plan, { removed: new Set(), drafts: {}, added })).toEqual({ addWatchCategories: added });
  });
});
