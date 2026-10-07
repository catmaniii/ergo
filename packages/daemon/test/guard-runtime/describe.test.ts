// 守卫接入里给人看的写法和调用指纹（guard-runtime/describe.ts）。
// 调用指纹决定事后批准的一次性授权放行哪次重试：同一个 agent、同一个任务的同一个阶段、同一个工作目录里一模一样的调用才算同一个。
import { describe, expect, it } from "vitest";
import { callFingerprint, summarizeArgs } from "../../src/guard-runtime/describe.ts";

const base = { agentId: "m-1", taskId: "t-1", stageId: "s-1", cwd: "D:\\work", tool: "bash", args: { command: "npm publish" } };

describe("调用指纹", () => {
  it("参数的键顺序不影响指纹", () => {
    expect(callFingerprint({ ...base, args: { b: 1, a: 2 } })).toBe(callFingerprint({ ...base, args: { a: 2, b: 1 } }));
  });

  it("阶段不同就不是同一个调用：授权只在所属阶段有效", () => {
    expect(callFingerprint({ ...base, stageId: "s-2" })).not.toBe(callFingerprint(base));
  });

  it("没有阶段时阶段为空（对话里）", () => {
    const chat = { ...base, taskId: null, stageId: null };
    expect(callFingerprint(chat)).toBe(callFingerprint({ ...chat, stageId: "" }));
    expect(callFingerprint(chat)).not.toBe(callFingerprint({ ...chat, stageId: "s-1" }));
  });

  it("agent、任务、工作目录、工具、参数任何一样不同都不是同一个", () => {
    const same = callFingerprint(base);
    for (const changed of [{ agentId: "m-2" }, { taskId: "t-2" }, { cwd: "D:\\other" }, { tool: "bash2" }, { args: { command: "npm publish --dry-run" } }]) {
      expect(callFingerprint({ ...base, ...changed })).not.toBe(same);
    }
  });
});

describe("参数摘要", () => {
  it("bash 是命令原文压成一行；文件工具是路径；搜索带上模式；别的按参数名=值", () => {
    expect(summarizeArgs("bash", { command: "ls\n  -la" })).toBe("ls -la");
    expect(summarizeArgs("read", { path: "notes/a.md" })).toBe("notes/a.md");
    expect(summarizeArgs("grep", { pattern: "TODO", path: "src" })).toBe("TODO · src");
    expect(summarizeArgs("pay_bill", { payee: "电力公司", amount: 230 })).toBe("payee=电力公司 amount=230");
  });
});
