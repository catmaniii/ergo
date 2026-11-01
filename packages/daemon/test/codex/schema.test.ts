// 校验器本身（helpers/codex-schema.ts）和生成的 schema（fixtures/codex-app-server.schema.json）：假 app-server 说的话靠它和真的协议对得上，校验器得真的能发现错。
// 不起真的 codex：fixture 由 fixtures/trim-codex-schema.mjs 从 `codex app-server generate-json-schema --experimental` 的输出裁出。
import { describe, expect, it } from "vitest";
import { CODEX_MIN_VERSION } from "../../src/codex/install.ts";
import { codexSchema } from "../helpers/codex-schema.ts";

describe("Codex 协议 schema", () => {
  it("fixture 是最低版本那一版生成的", () => {
    expect(codexSchema.version).toBe(CODEX_MIN_VERSION);
  });

  it("请求：缺字段、类型不对、协议里没有的字段都算错；对的不报", () => {
    expect(codexSchema.requestParams("turn/interrupt", { threadId: "a", turnId: "b" })).toEqual([]);
    expect(codexSchema.requestParams("turn/interrupt", { threadId: "a" })).toEqual(["turn/interrupt.turnId：缺了"]);
    expect(codexSchema.requestParams("turn/interrupt", { threadId: 1, turnId: "b" })[0]).toContain("要 string");
    expect(codexSchema.requestParams("thread/fork", { threadId: "a", beforeTurnIdd: "b" })).toEqual(["thread/fork.beforeTurnIdd：协议里没有这个字段"]);
    expect(codexSchema.requestParams("thread/rollback", {})[0]).toContain("不在用到的方法表里");
  });

  it("二狗依赖的实验字段都在这份 schema 里：beforeTurnId、additionalContext、developerInstructions、excludeTurns、ephemeral", () => {
    expect(codexSchema.requestParams("thread/fork", { threadId: "a", beforeTurnId: "b", ephemeral: true, excludeTurns: true, developerInstructions: "x", approvalPolicy: "untrusted", approvalsReviewer: "user" })).toEqual([]);
    expect(codexSchema.requestParams("turn/start", { threadId: "a", input: [{ type: "text", text: "x", text_elements: [] }], additionalContext: { ergo: { value: "y", kind: "application" } } })).toEqual([]);
    expect(codexSchema.requestParams("turn/start", { threadId: "a", input: [], additionalContext: { ergo: { value: "y", kind: "什么" } } })).not.toEqual([]);
  });

  it("通知：条目的形状按 schema（命令条目缺字段、status 不认得都算错）", () => {
    const item = { type: "commandExecution", id: "c", command: "ls", commandActions: [], cwd: "D:\\", status: "inProgress" };
    expect(codexSchema.notification("item/started", { threadId: "t", turnId: "u", item, startedAtMs: 1 })).toEqual([]);
    expect(codexSchema.notification("item/started", { threadId: "t", turnId: "u", item: { ...item, status: "乱写" }, startedAtMs: 1 })).not.toEqual([]);
    expect(codexSchema.notification("item/started", { threadId: "t", turnId: "u", item: { type: "commandExecution", id: "c" }, startedAtMs: 1 })).not.toEqual([]);
    expect(codexSchema.notification("没有这个通知", {})).not.toEqual([]);
  });

  it("审批的回复：只有协议认的决定（accept、decline）", () => {
    expect(codexSchema.serverRequestResult("item/commandExecution/requestApproval", { decision: "accept" })).toEqual([]);
    expect(codexSchema.serverRequestResult("item/fileChange/requestApproval", { decision: "decline" })).toEqual([]);
    expect(codexSchema.serverRequestResult("item/fileChange/requestApproval", { decision: "乱写" })).not.toEqual([]);
  });
});
