// 设置 · 模型（73 号票）的状态层：改一处存整份、API key 只说状态、看图能力和思考档位的说法、连通测试的结果。
import { describe, expect, test } from "vitest";
import {
  apiKeyText,
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
