// 主切面（101 号票）：对话审批关着（正式的默认）时，任务的 agent 超出授权先不管。真的守护进程，维护者接 faux 剧本，测试扮演前端。
// 长程任务执行时（阶段开始的通知引起的一轮，后台执行）：
// - 用到别的阶段的授权项、超出授权的调用都直接做：不出审批卡、不拉回，工具调用记录照常标关注类别、记上 beyondGrant
//   （详情里写明"超出授权，先不管"），任务不转等我；
// - 照旧的：写受保护区域永不、读密钥区硬拒绝。
// 对话审批开着时的原样（超出授权的先问、用到别的阶段的授权项拉回）在 deviation.test.ts；计划外的工单在 multi-project.test.ts。
import fs from "node:fs";
import path from "node:path";
import { maintainerChannel, type Plan } from "@ergou/protocol";
import { describe, expect, it } from "vitest";
import { dataDirLayout } from "../../src/config/data-dir.ts";
import { realPathOf } from "../../src/util/real-path.ts";
import { startTestDaemon } from "../helpers/daemon.ts";
import { call, cardsOf, confirmTask, connect, eventually, fwd, maintainerScript, real, say, tasksOf, twoStagePlan } from "../helpers/task-flow.ts";
import { makeTempDir } from "../helpers/temp-dir.ts";

const M1 = maintainerChannel("tm-1");

/** s1 能在 outside/s1 建目录，s2 能在 outside/s2 建目录（越出项目目录，"计划里列了才做"） */
function grantPlan(outside: string): Plan {
  const base = twoStagePlan();
  return {
    ...base,
    stages: [
      { ...base.stages[0]!, policy: { grants: [{ id: "dir1", tool: "make_dir", title: "建 s1 目录", scope: { path: path.join(outside, "s1") } }], temporalRules: [] } },
      { ...base.stages[1]!, policy: { grants: [{ id: "dir2", tool: "make_dir", title: "建 s2 目录", scope: { path: path.join(outside, "s2") } }], temporalRules: [] } },
    ],
  };
}

const bash = (command: string) => call("bash", { command });
type ToolCallLine = { tool: string; disposition?: string; blockedBy?: string; outcome: string; categoryTitles: string[]; withinGrant: boolean; beyondGrant?: true };
const bashCalls = (frontend: Awaited<ReturnType<typeof connect>>) =>
  frontend
    .events({ channel: M1, type: "message" })
    .flatMap((f) => (f.payload as { message: { parts: Array<{ type: string }> } }).message.parts)
    .filter((p) => p.type === "tool_call")
    .map((p) => p as unknown as ToolCallLine)
    .filter((p) => p.tool === "bash");

describe("长程任务：对话审批关着时维护者超出授权先不管", () => {
  it("用到别的阶段的授权项、超出授权的直接做、照常标出，不出审批卡、不拉回；写受保护区域、读密钥区照旧拦下", async () => {
    const outside = real(makeTempDir("ergou-out-"));
    const dataDir = makeTempDir("ergou-data-");
    const layout = dataDirLayout(realPathOf(dataDir)!);
    fs.mkdirSync(layout.secrets, { recursive: true });
    fs.writeFileSync(path.join(layout.secrets, "api-key.txt"), "sk-secret-in-secrets-area");
    const td = await startTestDaemon({
      reuse: { dataDir, homeDir: makeTempDir("ergou-home-") },
      config: { guard: { conversationApprovals: "off" }, approvals: { waitMinutes: 30 } },
      maintainer: maintainerScript(grantPlan(outside), [
        // 授权内
        bash(`mkdir -p "${fwd(path.join(outside, "s1"))}"`),
        // 用 s2 的授权在 s1 建目录（开着时拉回）
        bash(`mkdir -p "${fwd(path.join(outside, "s2"))}"`),
        // 超出授权（计划对"越出项目目录"有授权项，对象不对；开着时出审批卡等用户）
        bash(`mkdir -p "${fwd(path.join(outside, "other"))}"`),
        // 三条硬底线不变
        bash(`echo '{}' > "${fwd(path.join(layout.config, "watch-categories.json"))}"`),
        bash(`cat "${fwd(path.join(layout.secrets, "api-key.txt"))}"`),
        say("建好了"),
      ]),
    });
    const frontend = await connect(td.url);
    const taskId = await confirmTask(td, frontend, "超出授权");

    const calls = await eventually(() => [bashCalls(frontend)], (l) => l.length === 5, "五次调用的记录");
    expect(calls.map((c) => [c.disposition, c.blockedBy ?? null, c.outcome, c.categoryTitles, c.withinGrant, c.beyondGrant ?? false])).toEqual([
      ["do", null, "done", ["越出项目目录"], true, false],
      ["do", null, "done", ["越出项目目录"], false, true],
      ["do", null, "done", ["越出项目目录"], false, true],
      ["never", null, "blocked", ["越出项目目录"], false, false],
      ["do", "hard_refusal", "blocked", [], false, false],
    ]);
    for (const dir of ["s1", "s2", "other"]) expect({ dir, exists: fs.existsSync(path.join(outside, dir)) }).toEqual({ dir, exists: true });
    expect(fs.existsSync(path.join(layout.config, "watch-categories.json"))).toBe(false);
    // 不出审批卡，任务没转等我，阶段上没记拉回
    expect(cardsOf(frontend).filter((c) => c.type === "approval")).toEqual([]);
    const events = tasksOf(frontend).filter((e) => e.task.id === taskId);
    expect(events.some((e) => e.change === "pulled_back" || e.task.state === "waiting_for_user")).toBe(false);
    expect(td.daemon.approvals.list()).toEqual([]);
  }, 90_000);
});
