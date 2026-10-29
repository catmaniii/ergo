// 守卫接入里给人看的写法和调用指纹（guard-runtime/describe.ts）。
// 调用指纹决定事后批准的一次性授权放行哪次重试：同一个 agent、同一个任务的同一个阶段、同一个工作目录里一模一样的调用才算同一个。
import { describe, expect, it } from "vitest";
import { BUILTIN_TOOL_REGISTRY, maskSecretArgValues, registerTools, type ToolDescriptor } from "../../src/guard/index.ts";
import { callFingerprint, summarizeArgs } from "../../src/guard-runtime/describe.ts";
import { fakeSecret } from "../helpers/fake-secrets.ts";

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

/** 一个守护进程代为执行的工具的登记（maskArgs：参数要打码） */
const host = (name: string, maskArgs?: true): ToolDescriptor => ({ name, title: name, source: "host", categories: [], args: {}, readOnlyOrIdempotent: false, ...(maskArgs ? { maskArgs } : {}) });

describe("参数摘要", () => {
  const tools = BUILTIN_TOOL_REGISTRY;

  it("bash 是命令原文压成一行；文件工具是路径；搜索带上模式；别的按参数名=值", () => {
    expect(summarizeArgs(tools, "bash", { command: "ls\n  -la" })).toBe("ls -la");
    expect(summarizeArgs(tools, "read", { path: "notes/a.md" })).toBe("notes/a.md");
    expect(summarizeArgs(tools, "grep", { pattern: "TODO", path: "src" })).toBe("TODO · src");
    expect(summarizeArgs(tools, "pay_bill", { payee: "电力公司", amount: 230 })).toBe("payee=电力公司 amount=230");
  });

  it("参数要打码看工具自己的登记（280 号票，maskArgs）：标了的先擦掉名字看着是密钥的、像密钥的值，没标的照原样；不按工具名认", () => {
    const registry = registerTools(tools, host("wrap_call", true), host("plain_call"), host("mcp_call"));
    const args = { tool: "crm/contact.update", args: { id: "c-7", api_key: "abc-123-xyz", note: `token=${fakeSecret("sk-", "abcdefghijklmnopqrstuv")}` } };
    const masked = summarizeArgs(registry, "wrap_call", args);
    expect(masked).not.toContain("abc-123-xyz");
    expect(masked).not.toContain(fakeSecret("sk-", "abcdefghijklmnopqrstuv"));
    expect(masked).toContain('"id":"c-7"');
    // 打码的结果就是"先擦掉再照常列"（240、260 号票原来按名字认时的写法）
    expect(masked).toBe(summarizeArgs(registry, "plain_call", maskSecretArgValues(args)));
    // 没标的照原样（名字叫 mcp_call 也不算：认的是登记，不是名字）；登记里没有的也照原样
    expect(summarizeArgs(registry, "plain_call", args)).toContain("abc-123-xyz");
    expect(summarizeArgs(registry, "mcp_call", args)).toContain("abc-123-xyz");
    expect(summarizeArgs(tools, "wrap_call", args)).toContain("abc-123-xyz");
  });
});
