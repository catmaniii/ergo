// 关注类别设置的纯函数（26 号票）：内置类别的下拉只给不比默认更松的档、确定规则写成一句话。守护进程和 Web 共用。
import { describe, expect, test } from "vitest";
import { categoryMatchText, dispositionsNotLooserThan, isLooserDisposition } from "../src/index.ts";

describe("内置类别只能往严里调", () => {
  test.each([
    ["do", ["do", "do_then_tell", "planned_only", "ask_first", "hand_to_me", "never"]],
    ["planned_only", ["planned_only", "ask_first", "hand_to_me", "never"]],
    ["do_then_tell", ["do_then_tell", "planned_only", "ask_first", "hand_to_me", "never"]],
    ["ask_first", ["ask_first", "hand_to_me", "never"]],
    ["never", ["never"]],
  ] as const)("默认 %s 时下拉给 %j", (base, options) => {
    expect(dispositionsNotLooserThan(base)).toEqual(options);
  });

  test("比默认松才算松，一样的不算", () => {
    expect(isLooserDisposition("do_then_tell", "ask_first")).toBe(true);
    expect(isLooserDisposition("ask_first", "ask_first")).toBe(false);
    expect(isLooserDisposition("never", "ask_first")).toBe(false);
  });
});

describe("确定规则写成一句话", () => {
  test.each([
    [{ tools: ["write", "edit"] }, "工具是 write 或 edit"],
    [{ paths: ["D:\\app\\db\\migrations"] }, "路径在 D:\\app\\db\\migrations 之内"],
    [{ recipients: ["landlord@mail.com"] }, "收件人是 landlord@mail.com"],
    [{ amountOver: 500 }, "金额大于 500"],
    [{ tools: ["mcp_send_email"], recipients: ["a@b.c", "d@e.f"] }, "工具是 mcp_send_email，并且收件人是 a@b.c 或 d@e.f"],
  ])("%j", (match, text) => {
    expect(categoryMatchText(match)).toBe(text);
  });
});
