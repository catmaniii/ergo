// 环境注入：拉起子进程时显式给出环境变量，不继承守护进程的环境。
// 从 agent 的 bash 工具里看（bash 是子进程起的孙进程，看到的就是子进程的环境）。
import path from "node:path";
import { describe, expect, it } from "vitest";
import { fauxModel, spawnTestAgent, startTestDaemon } from "./helpers/daemon.ts";

function bashEcho(command: string) {
  return fauxModel([
    { kind: "reply", toolCalls: [{ name: "bash", arguments: { command } }] },
    { kind: "reply", text: "看过了" },
  ]);
}

describe("agent 子进程的环境", () => {
  it("守护进程环境里的哨兵变量子进程看不到，显式给出的变量看得到", async () => {
    const { daemon } = await startTestDaemon({
      env: { ERGOU_TEST_SENTINEL: "daemon-only-value", DEEPSEEK_API_KEY: "sk-daemon-secret" },
    });
    const { agent, log } = spawnTestAgent(daemon, {
      agentId: "maintainer-env",
      model: bashEcho('echo "S=${ERGOU_TEST_SENTINEL:-absent} K=${DEEPSEEK_API_KEY:-absent} E=${ERGOU_EXPLICIT:-absent} P=${PATH:+present}"'),
      tools: ["bash"],
      env: { ERGOU_EXPLICIT: "given-explicitly" },
    });
    await log.next("ready");
    agent.send({ type: "user_input", inputId: "in-1", text: "看看环境变量" });

    const end = await log.next("tool_call_end");
    expect(end.isError).toBe(false);
    expect(end.resultText).toContain("S=absent K=absent E=given-explicitly P=present");
    expect((await log.next("turn_end")).outcome).toBe("completed");
  });

  it("测试里起的子进程，用户目录类变量都指向临时主目录", async () => {
    const { daemon, homeDir } = await startTestDaemon();
    const { agent, log } = spawnTestAgent(daemon, {
      agentId: "maintainer-home",
      model: bashEcho('echo "$USERPROFILE|$APPDATA|$LOCALAPPDATA"'),
      tools: ["bash"],
    });
    await log.next("ready");
    agent.send({ type: "user_input", inputId: "in-1", text: "看看用户目录" });

    const end = await log.next("tool_call_end");
    expect(end.resultText.trim().split("|")).toEqual([
      homeDir,
      path.join(homeDir, "AppData", "Roaming"),
      path.join(homeDir, "AppData", "Local"),
    ]);
  });
});
