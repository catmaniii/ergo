// 关注类别设置的纯函数（26 号票）：内置类别的下拉只给不比默认更松的档、确定规则写成一句话。守护进程和 Web 共用。
import { describe, expect, test } from "vitest";
import { categoryMatchText, dispositionsNotLooserThan, grantNarrowingText, isLooserDisposition, type PlanGrant } from "../src/index.ts";

describe("用户的限制里的授权收窄写成一句话（计划卡上和原话一起列出）", () => {
  const push: PlanGrant = { id: "push-report", tool: "git_push", title: "把报告推送到 origin", scope: { remote: "origin", branch: ["main", "report"] }, maxUses: 2 };
  test.each([
    [{ grantId: "push-report", maxUses: 1 }, "「把报告推送到 origin」（push-report）：最多 1 次"],
    [{ grantId: "push-report", scope: { branch: ["report"] } }, "「把报告推送到 origin」（push-report）：branch 只留 report"],
    [{ grantId: "push-report", maxUses: 1, scope: { branch: ["report"] } }, "「把报告推送到 origin」（push-report）：最多 1 次，branch 只留 report"],
  ])("%j", (narrowing, text) => {
    expect(grantNarrowingText(narrowing, push)).toBe(text);
  });
  test("计划里没有这个授权项：只写 id", () => {
    expect(grantNarrowingText({ grantId: "gone", maxUses: 1 }, undefined)).toBe("授权项 gone：最多 1 次");
  });
});

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
