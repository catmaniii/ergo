// 原型里删在用的角色（371）：报错和真的守护进程一样写 agent 的叫法（项目「记账本」的负责人），不写编号（project-ledger），秘书写名字不写占位。
import { describe, expect, test, vi } from "vitest";
import { FakeDaemonHttp } from "../../src/prototype/fake-http.ts";
import { ASSISTANT_NAME_MARK } from "../../src/state/index.ts";

vi.mock("../../src/app/build-info.ts", () => ({ APP_VERSION: "0.0.0-test", CHANGELOG: "", PAGE_WEB_VERSION: undefined }));

const refusal = async (run: Promise<unknown>): Promise<string> => {
  const err = await run.then(
    () => undefined,
    (e: unknown) => e as Error,
  );
  expect(err).toBeInstanceOf(Error);
  return err!.message;
};

describe("原型里删在用的角色", () => {
  test("负责人在用：写它的叫法，不写编号", async () => {
    const http = new FakeDaemonHttp();
    await http.assignAgentRole("project-ledger", "role-xiaoming");
    const message = await refusal(http.deleteAgentRole("role-xiaoming"));
    expect(message).toContain("项目「记账本」的负责人");
    expect(message).not.toContain("project-ledger");
  });

  test("秘书在用：写名字，不写占位，也不写 secretary", async () => {
    const http = new FakeDaemonHttp();
    await http.assignAgentRole("secretary", "role-xiaoming");
    const message = await refusal(http.deleteAgentRole("role-xiaoming"));
    expect(message).not.toContain(ASSISTANT_NAME_MARK);
    expect(message).not.toContain("secretary");
    expect(message).toContain("二狗");
  });
});
