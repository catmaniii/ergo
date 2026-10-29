// 导入的"我发出的邮件"按每封写窄敏感类别（298 号票，主会话 2026-10-26 定，google/gmail-sensitive.ts）：简单关键词，
// 明显是财务、健康的标上，判不准的不标——单字（"病""药"）、人名（Bill）、"毛病""芍药"这类不算。
import { describe, expect, it } from "vitest";
import { sentMailSensitive } from "../../src/google/gmail-sensitive.ts";

describe("发出的邮件的敏感类别", () => {
  it.each([
    ["账单", "这个月的账单我看过了，没问题。", ["finance"]],
    ["转账", "钱已经转账给你了。", ["finance"]],
    ["工资", "下周三发工资，到时候再说。", ["finance"]],
    ["报价", "附件是这次的报价，请查收。", ["finance"]],
    ["英文 invoice", "Please find the invoice attached.", ["finance"]],
    ["英文 salary", "My salary review is next week.", ["finance"]],
    ["病了", "孩子病了，明天请假。", ["health"]],
    ["吃药", "记得按时吃药。", ["health"]],
    ["体检", "周五上午去体检，不用等我。", ["health"]],
    ["英文 doctor", "I have a doctor appointment at 3pm.", ["health"]],
    ["两类都有", "体检的费用我先付款了，回头报销。", ["finance", "health"]],
    ["都不是", "周五晚上我可以，地点就定在公司楼下那家火锅店吧。", []],
    ["人名 Bill 不算", "Hi Bill, see you on Friday.", []],
    ["单字不算：毛病、芍药", "电脑出了点毛病；阳台的芍药开了。", []],
    ["英文 quote 引用不算", "As quoted below, the meeting moved to 3pm.", []],
  ] as const)("%s", (_name, text, expected) => {
    expect(sentMailSensitive(text)).toEqual(expected);
  });
});
