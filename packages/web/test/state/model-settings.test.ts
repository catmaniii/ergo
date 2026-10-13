// 设置 · 模型（73 号票）的状态层：改一处存整份、API key 只说状态、看图能力和思考档位的说法、连通测试的结果；
// 120 号票：单独配了模型的维护者（设置页那一行下面的一句、⚙ 上"模型"那一块的话）。
import { describe, expect, test } from "vitest";
import {
  agentModelLines,
  apiKeyText,
  maintainerFollowLabel,
  maintainerOverrideLine,
  MODEL_SWITCH_NOTE,
  ASSISTANT_NAME_MARK,
  effectiveThinking,
  MODEL_AGENTS,
  MODEL_AGENTS_NOTE,
  MODEL_SETTINGS_FILE_BROKEN_NOTE,
  modelOptionLabel,
  modelTestText,
  agentSummary,
  sessionModelText,
  thinkingNote,
  visionChoiceOf,
  visionFollowLabel,
  visionText,
  withDefault,
  withAgent,
  withVision,
  type ModelOptionView,
  type ModelSettings,
  type ModelSettingsView,
} from "../../src/state/index.ts";

const SETTINGS: ModelSettings = {
  provider: "deepseek",
  default: { modelId: "deepseek-flash", thinkingLevel: "high" },
  agents: { reviewer: { thinkingLevel: "off" } },
  vision: { "deepseek/deepseek-v4-pro": true },
};

const FLASH: ModelOptionView = { modelId: "deepseek-flash", name: "DeepSeek V4.1 Flash", inCatalog: true, vision: true, visionSource: "catalog", catalogVision: true, thinkingLevels: ["off", "low", "high"] };
const PRO: ModelOptionView = { modelId: "deepseek-v4-pro", name: "DeepSeek V4 Pro", inCatalog: true, vision: true, visionSource: "settings", catalogVision: false, thinkingLevels: ["off", "high"] };

describe("改一处、存整份", () => {
  test("改默认、改 agent（给 null 改回跟随默认，两项都跟随就去掉这个 agent）、改看图能力；原来的不动", () => {
    expect(withDefault(SETTINGS, { modelId: "deepseek-v4-pro" }).default).toEqual({ modelId: "deepseek-v4-pro", thinkingLevel: "high" });
    expect(withAgent(SETTINGS, "secretary", { modelId: "deepseek-v4-pro" }).agents).toEqual({ reviewer: { thinkingLevel: "off" }, secretary: { modelId: "deepseek-v4-pro" } });
    expect(withAgent(SETTINGS, "reviewer", { modelId: "deepseek-v4-pro" }).agents.reviewer).toEqual({ modelId: "deepseek-v4-pro", thinkingLevel: "off" });
    expect(withAgent(SETTINGS, "reviewer", { thinkingLevel: null }).agents).toEqual({});
    expect(withVision(SETTINGS, "deepseek/deepseek-v4-pro", "follow").vision).toEqual({});
    expect(withVision(SETTINGS, "deepseek/deepseek-flash", "off").vision).toEqual({ "deepseek/deepseek-v4-pro": true, "deepseek/deepseek-flash": false });
    expect(SETTINGS.agents).toEqual({ reviewer: { thinkingLevel: "off" } });
    expect(SETTINGS.vision).toEqual({ "deepseek/deepseek-v4-pro": true });
    expect(visionChoiceOf(SETTINGS, "deepseek/deepseek-v4-pro")).toBe("on");
    expect(visionChoiceOf(SETTINGS, "deepseek/deepseek-flash")).toBe("follow");
  });
});

describe("API key 只说状态", () => {
  test("配了：已配置、来自哪个环境变量、LSM 从哪个文件注入；没配：去 LSM 里配；都说这里不能输入", () => {
    const on = apiKeyText({ configured: true, envVar: "DEEPSEEK_API_KEY", secretFile: "secrets/deepseek-api-key.txt", lsm: true });
    expect(on).toMatchObject({ label: "已配置", ok: true });
    expect(on.detail).toMatch(/DEEPSEEK_API_KEY.*secrets\/deepseek-api-key\.txt.*不能在这里输入/);
    const off = apiKeyText({ configured: false, envVar: "DEEPSEEK_API_KEY", secretFile: "secrets/deepseek-api-key.txt", lsm: false });
    expect(off).toMatchObject({ label: "没配置", ok: false });
    expect(off.detail).toMatch(/LSM 的 ergou-daemon 条目.*重启.*不是经 LSM 启动的.*不能输入 key/);
  });
});

describe("看图能力和思考档位的说法", () => {
  test("看图能力按什么定的；跟随那一项写配置文件的或模型目录的", () => {
    expect(visionText(FLASH)).toBe("能看图（按模型目录）");
    expect(visionText(PRO)).toBe("能看图（这里改的）");
    expect(visionText({ modelId: "x", inCatalog: false })).toBe("不知道能不能看图（模型目录里没有）");
    expect(visionFollowLabel(PRO)).toBe("跟随模型目录（看不了）");
    expect(visionFollowLabel({ ...PRO, configVision: true })).toBe("跟随配置文件（能看图）");
    expect(modelOptionLabel(FLASH)).toBe("DeepSeek V4.1 Flash（deepseek-flash）");
    expect(modelOptionLabel({ modelId: "deepseek-old", inCatalog: false })).toBe("deepseek-old（模型目录里没有）");
  });

  test("模型不分的档：先往高找、再往低找（和 pi 一样）；分的不说", () => {
    expect(effectiveThinking("medium", FLASH.thinkingLevels)).toBe("high");
    expect(effectiveThinking("low", PRO.thinkingLevels)).toBe("high");
    expect(effectiveThinking("high", ["off", "low"])).toBe("low");
    expect(effectiveThinking("low", undefined)).toBe("low");
    expect(thinkingNote(PRO, "low")).toBe("deepseek-v4-pro 不分「低」，实际按「高」");
    expect(thinkingNote(FLASH, "low")).toBeUndefined();
  });

  test("agent 下一个新会话用的（跟随默认的注明）；秘书主线会话现在用的", () => {
    const view = {
      settings: SETTINGS,
      effective: Object.fromEntries(MODEL_AGENTS.map((r) => [r, r === "reviewer" ? { modelId: "deepseek-flash", thinkingLevel: "off" } : SETTINGS.default])),
    } as unknown as ModelSettingsView;
    expect(agentSummary(view, "reviewer")).toBe("下一个新会话用 deepseek-flash · 思考关");
    expect(agentSummary(view, "secretary")).toBe("下一个新会话用 deepseek-flash · 思考高（跟随默认）");
    // 范围审视不进会话：每次审视时现取
    expect(agentSummary(view, "scope_review")).toBe("下一次审视用 deepseek-flash · 思考高（跟随默认）");
    expect(sessionModelText({ modelId: "deepseek-flash", thinkingLevel: "high", vision: true })).toBe("主线会话现在用 deepseek-flash · 思考高 · 能看图");
  });

  test("\"各个 agent\"那一节的说明列出各个 agent（秘书写名字占位）；设置文件读不出来时的提示", () => {
    expect(MODEL_AGENTS_NOTE).toBe(`${ASSISTANT_NAME_MARK}、任务维护者、项目维护者、子 agent、评审、范围审视各自用什么模型：跟随默认，或者选定模型和思考档位。`);
    expect(MODEL_AGENTS_NOTE).not.toContain("角色");
    expect(MODEL_SETTINGS_FILE_BROKEN_NOTE).toBe("设置文件读不出来，正在用默认；保存会覆盖它");
  });
});

describe("连通测试的结果（超时）", () => {
  test("超时写明等了多久", () => {
    expect(modelTestText({ ok: false, modelId: "deepseek-flash", totalMs: 60_000, error: "连通测试超时（60 秒），结束了子进程" }).text).toBe("不通：deepseek-flash：连通测试超时（60 秒），结束了子进程");
  });
});

describe("连通测试的结果", () => {
  test("通了写首 token 和整次的时间；不通写原因", () => {
    expect(modelTestText({ ok: true, modelId: "deepseek-flash", firstTokenMs: 820, totalMs: 1340 })).toEqual({ ok: true, text: "通了：deepseek-flash 首 token 820 毫秒，整次 1.3 秒" });
    expect(modelTestText({ ok: false, modelId: "deepseek-flash", totalMs: 0, error: "没配置 DeepSeek 的 API key" })).toEqual({ ok: false, text: "不通：deepseek-flash：没配置 DeepSeek 的 API key" });
  });
});

describe("单独配了模型的维护者（120 号票）", () => {
  const PRO_HIGH = { modelId: "deepseek-v4-pro", thinkingLevel: "high" } as const;
  const FLASH_HIGH = { modelId: "deepseek-flash", thinkingLevel: "high" } as const;

  test("设置页上项目维护者、任务维护者那一行下面一句：单独配了的有哪些（项目写名字，任务写编号和标题），用不了的写明跟随这一行；别的行、没有的不写", () => {
    const view = {
      maintainers: [
        { agentId: "pm-1", agent: "project_maintainer", owner: { kind: "project", id: "p-1", title: "记账本" }, choice: PRO_HIGH },
        { agentId: "pm-2", agent: "project_maintainer", owner: { kind: "project", id: "p-2", title: "家庭网盘" }, choice: { modelId: "deepseek-old", thinkingLevel: "off" }, unavailable: "单独配的 deepseek-old 在 DeepSeek 的模型目录里没有了" },
        { agentId: "tm-3", agent: "task_maintainer", owner: { kind: "task", id: "t-3", title: "整理发票" }, choice: FLASH_HIGH },
      ],
    } as const;
    const projects = maintainerOverrideLine(view as unknown as Pick<ModelSettingsView, "maintainers">, "project_maintainer")!;
    expect(projects.lead).toBe("单独配了模型的项目：");
    expect(projects.items.map((i) => [i.agentId, i.name, i.text, i.unavailable])).toEqual([
      ["pm-1", "记账本", "deepseek-v4-pro · 思考高", undefined],
      ["pm-2", "家庭网盘", "deepseek-old · 思考关，用不了了，现在跟随这一行", "单独配的 deepseek-old 在 DeepSeek 的模型目录里没有了"],
    ]);
    const tasks = maintainerOverrideLine(view as unknown as Pick<ModelSettingsView, "maintainers">, "task_maintainer")!;
    expect(tasks.lead).toBe("单独配了模型的任务：");
    expect(tasks.items.map((i) => [i.name, i.owner])).toEqual([["t-3「整理发票」", { kind: "task", id: "t-3", title: "整理发票" }]]);
    expect(maintainerOverrideLine(view as unknown as Pick<ModelSettingsView, "maintainers">, "reviewer")).toBeUndefined();
    expect(maintainerOverrideLine({ maintainers: [] }, "project_maintainer")).toBeUndefined();
  });

  test("⚙ 上的\"模型\"：下拉第一项写跟随哪一行和它现在用的；下一个新会话用的、按什么定的；最近在跑的会话实际用的；什么时候换（照 83 号票）", () => {
    const follow = { agent: "project_maintainer", role: FLASH_HIGH, next: FLASH_HIGH, switchAt: "next_segment" } as const;
    expect(maintainerFollowLabel(follow)).toBe("跟随“项目维护者”的设置（现在是 deepseek-flash · 思考高）");
    expect(agentModelLines(follow)).toEqual({ next: "下一个新会话用 deepseek-flash · 思考高（跟随“项目维护者”的设置）", session: undefined, unavailable: undefined, switchNote: MODEL_SWITCH_NOTE.next_segment });

    const own = agentModelLines({ ...follow, own: PRO_HIGH, next: PRO_HIGH, session: { modelId: "deepseek-flash", thinkingLevel: "high", vision: true } });
    expect(own.next).toBe("下一个新会话用 deepseek-v4-pro · 思考高（单独配的）");
    expect(own.session).toBe("最近在跑的会话实际用 deepseek-flash · 思考高 · 能看图");

    // 配的模型用不了了：跟随那一行，写明原因
    const gone = agentModelLines({ ...follow, own: { modelId: "deepseek-old", thinkingLevel: "high" }, unavailable: "单独配的 deepseek-old 在 DeepSeek 的模型目录里没有了" });
    expect(gone.next).toBe("下一个新会话用 deepseek-flash · 思考高（跟随“项目维护者”的设置）");
    expect(gone.unavailable).toBe("单独配的 deepseek-old 在 DeepSeek 的模型目录里没有了，现在跟随“项目维护者”的设置。重新选一个，或者改回跟随。");

    // 任务：一次性的执行中途不换，定时触发的下一次运行开头换
    expect(agentModelLines({ agent: "task_maintainer", role: FLASH_HIGH, next: FLASH_HIGH, switchAt: "new_session" }).switchNote).toMatch(/任务执行中途不换.*清空当前对话后新开的一段用新的/);
    expect(MODEL_SWITCH_NOTE.next_run).toMatch(/下一次运行开头换/);
    expect(MODEL_SWITCH_NOTE.next_segment).toMatch(/下一张工单、下一个对话段.*工单做到一半不换/);
  });
});
