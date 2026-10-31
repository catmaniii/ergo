// 模型的 key 在网页上填（319 号票）的状态层：请求体去掉 BOM、换行和首尾空白；草稿空 / 太短 / 太长时的说法；
// 存好之后说的一句（now：下一个新会话起用新的；restart：写明重启二狗后生效、怎么重启）。
// 2026-10-30 起请求体可以点名服务商（设置 · 模型的 API key 一块按服务商逐条列出）：给了就带上，不给就没有这一项
import { describe, expect, test } from "vitest";
import { MODEL_KEY_MAX_LENGTH, MODEL_KEY_MIN_LENGTH, modelKeyBody, modelKeyDraftNote, modelKeyDraftProblem, modelKeySavedText } from "../../src/state/index.ts";

const saved = (effective: "now" | "restart") => ({ configured: true as const, effective, apiKey: { configured: true, envVar: "DEEPSEEK_API_KEY", secretFile: "secrets/deepseek-api-key.txt", lsm: true } });

describe("填好的 key 怎么交给守护进程", () => {
  test("请求体只有 key：去掉 BOM、换行和首尾空白", () => {
    expect(modelKeyBody("  sk-web-319-abcdef \r\n")).toEqual({ key: "sk-web-319-abcdef" });
    expect(modelKeyBody("\uFEFFsk-web-319-abcdef")).toEqual({ key: "sk-web-319-abcdef" });
    expect(modelKeyBody("sk-web-\r\n319-abcdef")).toEqual({ key: "sk-web-319-abcdef" });
  });

  test("点名了服务商就带上 provider（不给时请求体里没有这一项，守护进程照选中的那个写）", () => {
    expect(modelKeyBody(" sk-web-319-abcdef ", "custom")).toEqual({ key: "sk-web-319-abcdef", provider: "custom" });
    expect(modelKeyBody("sk-web-319-abcdef", "deepseek")).toEqual({ key: "sk-web-319-abcdef", provider: "deepseek" });
    expect(modelKeyBody("sk-web-319-abcdef")).not.toHaveProperty("provider");
  });
});

describe("草稿存不了的时候说清楚", () => {
  test("空的什么都不说；太短、太长各说一句（数字和守护进程那一份一样）", () => {
    expect(modelKeyDraftProblem("")).toBe("empty");
    expect(modelKeyDraftProblem("  \r\n ")).toBe("empty");
    expect(modelKeyDraftProblem("sk-短")).toBe("short");
    expect(modelKeyDraftProblem("x".repeat(MODEL_KEY_MIN_LENGTH - 1))).toBe("short");
    expect(modelKeyDraftProblem("x".repeat(MODEL_KEY_MAX_LENGTH + 1))).toBe("long");
    expect(modelKeyDraftProblem("sk-web-319-abcdef")).toBeUndefined();
    expect(modelKeyDraftNote("")).toBeUndefined();
    expect(modelKeyDraftNote(` ${"x".repeat(MODEL_KEY_MIN_LENGTH - 1)} `)).toMatch(/太短.*至少.*8/);
    expect(modelKeyDraftNote("x".repeat(MODEL_KEY_MAX_LENGTH + 1))).toMatch(/太长.*最多 400/);
  });
});

describe("存好之后说的一句", () => {
  test("now：已配好、不用重启", () => {
    const text = modelKeySavedText(saved("now"));
    expect(text).toEqual({ effective: "now", text: expect.stringContaining("已配好") });
    expect(text.text).toMatch(/下一个新会话/);
    expect(text.how).toBeUndefined();
  });

  test("restart：写明重启二狗后生效，另有一句怎么重启（安装版是 ergo restart）", () => {
    const text = modelKeySavedText(saved("restart"));
    expect(text.effective).toBe("restart");
    expect(text.text).toBe("已保存：重启二狗后生效。");
    expect(text.how).toMatch(/ergo restart/);
  });
});
