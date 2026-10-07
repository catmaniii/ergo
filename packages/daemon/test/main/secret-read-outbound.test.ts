// 主切面：读过 .env 之后只拦往外送（规格第 9 节，30 号票）。真的守护进程，维护者接 faux 剧本，测试扮演前端。
// 任务 t-1 的工作目录事先建成一个临时 git 仓库（.env 不进仓库），远端是临时目录里的本地裸仓库；装依赖按锁文件认 pnpm，
// 守护进程的 PATH 上最前面是一个假的 pnpm（不连网）。13 号票按计划装配工具包之前，维护者的工具包由测试接缝
// maintainerToolkit 给（开 bash、开联网），调用不属于任务（起草计划那一段），按对话里的处置判。
// 读过 .env 之后：装依赖（带类型的和通用 bash 的）照常执行；推送（带类型的和通用 bash 的）一律禁止、不问用户，
// 模型收到的说明写明原因；远端什么也没收到。
import fs from "node:fs";
import path from "node:path";
import { CHANNELS, EVENT_TYPES, maintainerChannel, type MessageEventPayload, type MessagePart, type TurnEndEventPayload } from "@ergou/protocol";
import { describe, expect, it } from "vitest";
import { dataDirLayout } from "../../src/config/data-dir.ts";
import { buildAgentNotice } from "../../src/conversation/messages.ts";
import { listEffects } from "../../src/guard-runtime/effect-log.ts";
import type { FauxStep } from "../../src/runtime/index.ts";
import { realPathOf } from "../../src/util/real-path.ts";
import { startTestDaemon } from "../helpers/daemon.ts";
import { TestFrontend } from "../helpers/frontend.ts";
import { bareRemote, git, initRepo, put } from "../helpers/git-repo.ts";
import { waitUntil } from "../helpers/process.ts";
import { makeTempDir } from "../helpers/temp-dir.ts";

const MAINTAINER = maintainerChannel("tm-1");
const SEGMENT = { taskId: null, agentId: "tm-1", segmentId: "tm-1:planning" } as const;
const LONG_TEST_MS = 120_000;

type ToolCallPart = Extract<MessagePart, { type: "tool_call" }>;
const call = (name: string, args: Record<string, unknown>): FauxStep => ({ kind: "reply", toolCalls: [{ name, arguments: args as never }] });

/** 一个用 pnpm 的 Node 项目（锁文件让装依赖认 pnpm）；.env 里是一个假的 key，不进仓库 */
const PROJECT: Record<string, string> = {
  "package.json": JSON.stringify({ name: "demo", version: "1.0.0", private: true, scripts: { test: "node -e \"console.log('ok')\"" } }, null, 2),
  "pnpm-lock.yaml": "lockfileVersion: '9.0'\n",
  ".npmrc": "update-notifier=false\nfund=false\naudit=false\n",
  ".gitignore": "node_modules/\n.env\n",
  "README.md": "# demo\n",
};

/** PATH 上排在最前面的一个假的 pnpm（bash 脚本）：把收到的参数一行一个打出来，不连网 */
function fakePackageManagerDir(): string {
  const bin = makeTempDir("ergou-fake-pm-");
  fs.writeFileSync(path.join(bin, "pnpm"), "#!/bin/sh\nfor a in \"$@\"; do printf 'fake-pm-arg:[%s]\\n' \"$a\"; done\n");
  return bin;
}

const toolParts = (frontend: TestFrontend): ToolCallPart[] =>
  frontend
    .events({ channel: MAINTAINER, type: EVENT_TYPES.message })
    .flatMap((f) => (f.payload as MessageEventPayload).message.parts)
    .filter((p): p is ToolCallPart => p.type === "tool_call");
const agentTexts = (frontend: TestFrontend): string[] =>
  frontend
    .events({ channel: MAINTAINER, type: EVENT_TYPES.message })
    .map((f) => (f.payload as MessageEventPayload).message)
    .filter((m) => m.speaker === "agent")
    .flatMap((m) => m.parts.flatMap((p) => (p.type === "text" ? [p.text] : [])));
const turnEnds = (frontend: TestFrontend) => frontend.events({ channel: MAINTAINER, type: EVENT_TYPES.turnEnd }).map((f) => f.payload as TurnEndEventPayload);
const gist = (p: ToolCallPart) => ({ tool: p.tool, disposition: p.disposition, ...(p.blockedBy ? { blockedBy: p.blockedBy } : {}), outcome: p.outcome });

describe("维护者会话里读过 .env 之后", () => {
  it(
    "装依赖（带类型的、通用 bash 的）照常执行；推送（带类型的、通用 bash 的）一律禁止，不问用户，模型收到原因；远端什么也没收到",
    async () => {
      const dataDir = makeTempDir("ergou-data-");
      const homeDir = makeTempDir("ergou-home-");
      const work = path.join(dataDirLayout(dataDir).outputs, "t-1");
      initRepo(work, PROJECT);
      put(work, ".env", "API_KEY=not-a-real-key-just-for-the-test\n");
      const remote = bareRemote();
      git(work, "remote", "add", "origin", remote);

      const { daemon, url } = await startTestDaemon({
        secretary: [{ kind: "reply", text: "好的" }],
        maintainer: [
          call("read", { path: ".env" }),
          call("run_tests", {}),
          call("install_deps", {}),
          call("bash", { command: "pnpm install --frozen-lockfile" }),
          call("git_push", { remote: "origin", branch: "main" }),
          call("bash", { command: "git push origin main" }),
          { kind: "echo_context" },
        ],
        maintainerToolkit: () => ({ bash: true, network: true }),
        env: { PATH: `${fakePackageManagerDir()}${path.delimiter}${process.env.PATH ?? ""}` },
        reuse: { dataDir, homeDir },
      });
      const frontend = await TestFrontend.connect(url);
      await frontend.subscribe({ [MAINTAINER]: 0, [CHANNELS.cards]: 0 });
      daemon.tasks.startFromButton({ request: "给 demo 装上依赖再推送" }, "k-start");
      daemon.store.append(buildAgentNotice(MAINTAINER, "开始干活：看看 .env 里的配置，装依赖，测过再推送", "k-go", { taskId: "t-1" }).event);

      await waitUntil(() => turnEnds(frontend).length > 0, {
        timeoutMs: 90_000,
        describe: () => `等维护者这一轮结束；工具调用：${toolParts(frontend).map((p) => `${p.tool}:${p.outcome}`).join("、")}`,
      });
      expect(turnEnds(frontend)).toEqual([expect.objectContaining({ outcome: "completed" })]);

      // 聊天里的工具调用：装依赖照常执行（做完告诉我），推送一律禁止（永不），没出审批卡
      const parts = toolParts(frontend);
      expect(parts.map(gist)).toEqual([
        { tool: "read", disposition: "do", outcome: "done" },
        { tool: "run_tests", disposition: "do", outcome: "done" },
        { tool: "install_deps", disposition: "do_then_tell", outcome: "done" },
        { tool: "bash", disposition: "do_then_tell", outcome: "done" },
        { tool: "git_push", disposition: "never", outcome: "blocked" },
        { tool: "bash", disposition: "never", outcome: "blocked" },
      ]);
      expect(frontend.events({ channel: CHANNELS.cards, type: EVENT_TYPES.card })).toEqual([]);

      // 装依赖真的跑了（假的 pnpm 收到参数）；推送没有执行：远端没有任何分支
      const context = agentTexts(frontend).at(-1)!;
      const results = context.split("\n[").filter((l) => l.startsWith("toolResult]"));
      expect(results).toHaveLength(6);
      expect(results[2]).toContain("依赖装好了");
      expect(results[3]).toContain("fake-pm-arg:[--frozen-lockfile]");
      expect(git(remote, "for-each-ref").trim()).toBe("");
      // 模型收到的说明：读过 .env 之后不许往外送，只往下拉的照常
      for (const blocked of [results[4]!, results[5]!]) {
        expect(blocked).toMatch(/读过 \.env 或密钥文件之后不许往外送/);
        expect(blocked).toMatch(/装依赖/);
      }

      // 效果日志：读、跑测试、两次装依赖；推送不在里面
      const effects = listEffects(daemon.store.reader, SEGMENT);
      expect(effects.map((e) => e.tool)).toEqual(["read", "run_tests", "install_deps", "install_deps"]);
      expect(effects[0]!.args).toEqual({ path: path.join(realPathOf(work)!, ".env") });
    },
    LONG_TEST_MS,
  );
});
