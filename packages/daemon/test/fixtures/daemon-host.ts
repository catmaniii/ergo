// 测试用的守护进程宿主（job-object.test.ts 用）：在独立进程里起一个守护进程实例，
// 拉起一个 agent，让它用 bash 工具起孙进程（孙进程再留下一个父进程已退出的孤儿曾孙进程），
// 然后把各进程的 pid 和是否在 Job 里报到 stdout，挂着等测试来强杀。
//
// 用法：node daemon-host.ts '<JSON 参数>'，从 stdin 收到一行 "go" 才开始（测试可以先把本进程放进外层 Job）。
import fs from "node:fs";
import path from "node:path";
import { startDaemon } from "../../src/daemon.ts";
import { LineDecoder } from "../../src/runtime/line-channel.ts";

interface Args {
  dataDir: string;
  homeDir: string;
  pidDir: string;
}

const args = JSON.parse(process.argv[2] ?? "{}") as Args;
const grandchildScript = path.join(import.meta.dirname, "grandchild.mjs");

function out(message: unknown): void {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

async function waitForGo(): Promise<void> {
  const decoder = new LineDecoder();
  await new Promise<void>((resolve) => {
    process.stdin.on("data", (chunk: Buffer) => {
      if (decoder.push(chunk).includes("go")) resolve();
    });
  });
}

async function waitForFile(file: string): Promise<number> {
  for (let i = 0; i < 200; i++) {
    if (fs.existsSync(file)) {
      const text = fs.readFileSync(file, "utf8").trim();
      if (text) return Number(text);
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`等不到 ${file}`);
}

await waitForGo();
const daemon = await startDaemon({ env: { ...process.env, ERGOU_DATA_DIR: args.dataDir }, homeDir: args.homeDir });
const slash = (p: string) => p.replaceAll("\\", "/");
const agent = daemon.agents.spawn({
  agentId: "job-test",
  model: {
    kind: "faux",
    thinkingLevel: "off",
    script: [
      {
        kind: "reply",
        toolCalls: [
          { name: "bash", arguments: { command: `"${slash(process.execPath)}" "${slash(grandchildScript)}" "${slash(args.pidDir)}"` } },
        ],
      },
    ],
  },
  tools: ["bash"],
});

agent.onReport(async (report) => {
  if (report.type === "ready") {
    agent.send({ type: "user_input", inputId: "in-1", text: "起一个孙进程" });
  } else if (report.type === "tool_call_start") {
    const grandchildPid = await waitForFile(path.join(args.pidDir, "grandchild.pid"));
    const orphanPid = await waitForFile(path.join(args.pidDir, "orphan.pid"));
    const job = daemon.job!;
    out({
      daemonPid: process.pid,
      agentPid: agent.pid,
      grandchildPid,
      orphanPid,
      inJob: { agent: job.contains(agent.pid), grandchild: job.contains(grandchildPid), orphan: job.contains(orphanPid) },
      limits: job.limits(),
    });
  } else if (report.type === "error") {
    out({ error: report });
  }
});

// 一直挂着，等测试强杀
setInterval(() => {}, 60_000);
