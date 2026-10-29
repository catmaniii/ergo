// 主切面（139 号票）：守护进程把自己实际监听的端口传进守卫。"发往本机的请求不算对外"不包括二狗自己的端口，用浏览器工具打开二狗
// 自己的页面也算"以我的名义对外发送或发布"。真的守护进程（两个端口都由系统随机挑），维护者接 faux 剧本（剧本在维护者被拉起时才给，
// 那时端口已经知道了），测试扮演前端。
// 维护者起草计划那一段按对话里的处置判（测试底座对话审批开着）：非 GET 地调二狗本机端口的接口、用浏览器打开二狗外网端口的页面
// 都出审批卡，原因写着"发往二狗自己的接口（本机端口 N），不算本机例外"，N 是实际监听的端口；拒绝之后都没执行。
// 守卫的各种写法在守卫切面（test/guard/conversation-approvals.test.ts）。
import fs from "node:fs";
import path from "node:path";
import { type ApprovalCardPayload, type Card, type CardEventPayload, CHANNELS, EVENT_TYPES, maintainerChannel, type MessageEventPayload, type MessagePart, type TurnEndEventPayload } from "@ergo/protocol";
import { describe, expect, it } from "vitest";
import { buildAgentNotice } from "../../src/conversation/messages.ts";
import type { FauxStep } from "../../src/runtime/index.ts";
import { startTestDaemon } from "../helpers/daemon.ts";
import { TestFrontend } from "../helpers/frontend.ts";
import { waitUntil } from "../helpers/process.ts";
import { makeTempDir } from "../helpers/temp-dir.ts";

const MAINTAINER = maintainerChannel("tm-1");
const LONG_TEST_MS = 120_000;
type ToolCallPart = Extract<MessagePart, { type: "tool_call" }>;
const call = (name: string, args: Record<string, unknown>): FauxStep => ({ kind: "reply", toolCalls: [{ name, arguments: args as never }] });

/** PATH 上排在最前面的一个假的 agent-browser：只把参数打出来，不起浏览器（万一放行了也不会真开） */
function fakeBrowserDir(): string {
  const bin = makeTempDir("ergo-fake-browser-");
  fs.writeFileSync(path.join(bin, "agent-browser"), "#!/bin/sh\necho \"fake-agent-browser $*\"\n");
  return bin;
}

const latestCards = (frontend: TestFrontend): Card[] => [
  ...new Map(frontend.events({ channel: CHANNELS.cards, type: EVENT_TYPES.card }).map((f) => [(f.payload as CardEventPayload).card.id, (f.payload as CardEventPayload).card])).values(),
];
const toolParts = (frontend: TestFrontend): ToolCallPart[] =>
  frontend
    .events({ channel: MAINTAINER, type: EVENT_TYPES.message })
    .flatMap((f) => (f.payload as MessageEventPayload).message.parts)
    .filter((p): p is ToolCallPart => p.type === "tool_call");
const turnEnds = (frontend: TestFrontend) => frontend.events({ channel: MAINTAINER, type: EVENT_TYPES.turnEnd }).map((f) => f.payload as TurnEndEventPayload);

describe("二狗自己的端口（守护进程实际监听的）不算本机例外", () => {
  it(
    "非 GET 地调二狗本机端口的接口、用浏览器打开二狗外网端口的页面：出审批卡，原因里是实际监听的端口；拒绝后都没执行",
    async () => {
      // 端口在守护进程起来之后才知道（系统随机挑的）：维护者的剧本在它被拉起时才取
      let ports: { local: string; external: string } | undefined;
      const { daemon, url, externalUrl } = await startTestDaemon({
        secretary: [{ kind: "reply", text: "好的" }],
        maintainer: () => [
          call("bash", { command: `curl -s -m 5 -X POST -d a=1 http://127.0.0.1:${ports!.local}/api/nothing` }),
          call("bash", { command: `agent-browser open http://localhost:${ports!.external}/` }),
          { kind: "reply", text: "都没批，那就不弄了" },
        ],
        maintainerToolkit: () => ({ bash: true, network: true }),
        env: { PATH: `${fakeBrowserDir()}${path.delimiter}${process.env.PATH ?? ""}` },
      });
      ports = { local: new URL(url).port, external: new URL(externalUrl).port };
      expect(ports.local).not.toBe(ports.external);
      const frontend = await TestFrontend.connect(url);
      await frontend.subscribe({ [MAINTAINER]: 0, [CHANNELS.cards]: 0 });
      daemon.tasks.startFromButton({ request: "看看二狗自己的接口" }, "k-start");
      daemon.store.append(buildAgentNotice(MAINTAINER, "调一下二狗的接口，再打开它的页面看看", "k-go", { taskId: "t-1" }).event);

      // 审批卡来一张拒绝一张，直到这一轮结束
      const reasons: string[] = [];
      for (;;) {
        let card: Card | undefined;
        await waitUntil(
          () => {
            card = latestCards(frontend).find((c) => c.type === "approval" && c.status === "pending");
            return card !== undefined || turnEnds(frontend).length > 0;
          },
          { timeoutMs: 60_000, describe: () => `等第 ${reasons.length + 1} 张审批卡；工具调用：${toolParts(frontend).map((p) => `${p.tool}:${p.outcome}`).join("、")}` },
        );
        if (!card) break;
        reasons.push((card.payload as ApprovalCardPayload).reason);
        const r = await frontend.cardAction({ cardId: card.id, action: "deny", expectedVersion: card.version });
        if (!r.ok) throw new Error(`审批卡没处理成：${r.error.message}`);
      }
      await waitUntil(() => turnEnds(frontend).length > 0, { timeoutMs: 60_000, describe: () => "等维护者这一轮结束" });

      expect(reasons[0]).toContain(`发往二狗自己的接口（本机端口 ${ports.local}），不算本机例外`);
      expect(reasons[1]).toContain(`发往二狗自己的接口（本机端口 ${ports.external}），不算本机例外`);
      expect(toolParts(frontend).map((p) => [p.tool, p.categoryTitles, p.disposition, p.outcome])).toEqual([
        ["bash", ["以我的名义对外发送或发布"], "ask_first", "denied"],
        ["bash", ["以我的名义对外发送或发布"], "ask_first", "denied"],
      ]);
    },
    LONG_TEST_MS,
  );
});
