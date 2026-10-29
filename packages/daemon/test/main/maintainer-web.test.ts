// 主切面（70 号票）：任务的维护者也配上联网搜索、读网页，grep、find 照给。联网搜索、读网页是假的（不起浏览器、不连真网络）。
// - 起草计划时（PLANNING_TOOLKIT：没有 bash，70 号票起联网开着）：能搜、能读网页、能用 grep、find（守卫不拦）；
// - 执行时照确认的计划的工具包：联网开着照常，联网关着守卫硬拒绝。
import { maintainerChannel, type Plan } from "@ergo/protocol";
import { describe, expect, it } from "vitest";
import type { FauxStep } from "../../src/runtime/index.ts";
import { startTestDaemon } from "../helpers/daemon.ts";
import { submitPlanStep } from "../helpers/plans.ts";
import { onePlan, runningTask } from "../helpers/running-task.ts";
import { connect, toolCallsOf, turnsOf } from "../helpers/task-flow.ts";
import { fakeWebAccess } from "../helpers/web.ts";

const call = (name: string, args: Record<string, unknown>): FauxStep => ({ kind: "reply", toolCalls: [{ name, arguments: args as never }] });
const say = (text: string): FauxStep => ({ kind: "reply", text });
const MAINTAINER = maintainerChannel("tm-1");

const web = () =>
  fakeWebAccess({
    search: (q) => ({ engine: "ddg", results: [{ title: `${q.query} 的结果`, url: "https://a.example/1", snippet: "摘要" }] }),
    fetch: (r) => ({ text: `URL: ${r.url}\n标题: 页\n\n正文`, via: "direct" }),
  });

/** 计划的工具包换一下联网开关 */
const planWithNetwork = (network: boolean): Plan => ({ ...onePlan(), toolkit: { skills: [], mcp: [], bash: false, network } });

describe("任务的维护者的联网工具", () => {
  it("起草计划时：联网搜索、读网页、grep、find 守卫都不拦（联网搜索、读网页直接做）", async () => {
    const td = await startTestDaemon({
      webAccess: web(),
      maintainer: (_id, spawn) =>
        spawn === 1
          ? [call("web_search", { query: "调研 X" }), call("web_fetch", { url: "https://a.example/1" }), call("grep", { pattern: "x" }), call("find", { pattern: "*.md" }), submitPlanStep(onePlan()), say("计划交上去了")]
          : [say("开始做了")],
    });
    const frontend = await connect(td.url);
    const task = td.daemon.tasks.createByRequest({ title: "调研 X", summary: "调研 X" });
    td.daemon.tasks.writeBrief(task.id, { goal: "调研 X", acceptanceCriteria: ["附来源"], constraints: [], projects: [], memoryScope: "" });
    await turnsOf(frontend, MAINTAINER, 1);
    const calls = toolCallsOf(frontend, MAINTAINER);
    expect(calls.slice(0, 4).map((c) => [c.tool, c.blockedBy ?? null])).toEqual([
      ["web_search", null],
      ["web_fetch", null],
      ["grep", null],
      ["find", null],
    ]);
    expect(calls.slice(0, 2).map((c) => [c.disposition, c.outcome])).toEqual([
      ["do", "done"],
      ["do", "done"],
    ]);
  });

  for (const network of [true, false]) {
    it(`执行时照计划的工具包：联网${network ? "开着照常做" : "关着守卫拒绝"}`, async () => {
      const td = await startTestDaemon({
        webAccess: web(),
        maintainer: (_id, spawn) =>
          spawn === 1 ? [submitPlanStep(planWithNetwork(network)), say("计划交上去了")] : [call("web_fetch", { url: "https://a.example/1" }), say("读完了"), say("接着做")],
      });
      const frontend = await connect(td.url);
      await runningTask(td, frontend, "读网页");
      await turnsOf(frontend, MAINTAINER, 2);
      const fetchCall = toolCallsOf(frontend, MAINTAINER).find((c) => c.tool === "web_fetch")!;
      expect([fetchCall.blockedBy ?? null, fetchCall.outcome]).toEqual(network ? [null, "done"] : ["hard_refusal", "blocked"]);
    });
  }
});
