// pi 契约测试：find、grep 不靠 fd、rg 也能用。pi 自带的 find、grep 找不到 fd、rg 就报 "fd is not available and could not be downloaded"
// （二狗固定设了 PI_OFFLINE，不会去下载）。这里让子进程的 PATH 上没有它们，模型调用这两个工具照样有结果。
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { FauxStep } from "../../src/runtime/index.ts";
import { fauxModel, spawnTestAgent, startTestDaemon } from "../helpers/daemon.ts";
import { makeTempDir } from "../helpers/temp-dir.ts";

const call = (name: string, args: Record<string, unknown>): FauxStep => ({ kind: "reply", toolCalls: [{ name, arguments: args as never }] });

/** 工作目录：几个文件，node_modules 里的不该找到 */
function workdir() {
  const cwd = makeTempDir("ergo-search-");
  fs.mkdirSync(path.join(cwd, "src", "deep"), { recursive: true });
  fs.mkdirSync(path.join(cwd, "node_modules", "x"), { recursive: true });
  fs.writeFileSync(path.join(cwd, "notes.md"), "第一行\n留存掉半在这里\n第三行\n");
  fs.writeFileSync(path.join(cwd, "src", "a.ts"), "const a = 1;\n");
  fs.writeFileSync(path.join(cwd, "src", "deep", "b.ts"), "// 留存掉半\n");
  fs.writeFileSync(path.join(cwd, "node_modules", "x", "c.ts"), "// 留存掉半\n");
  return cwd;
}

/** 让模型按顺序调工具，交回每次的结果 */
async function results(steps: FauxStep[], tools: string[], cwd: string) {
  const { daemon } = await startTestDaemon();
  const { agent, log } = spawnTestAgent(daemon, {
    agentId: `contract-search-${tools.join("-")}`,
    cwd,
    model: fauxModel([...steps, { kind: "reply", text: "看完了" }]),
    tools,
    // PATH 上只留 Node 所在的目录和系统目录：没有 fd、rg（开发机上装了也不算）
    env: { PATH: [path.dirname(process.execPath), process.env["SystemRoot"] ?? "C:\\Windows", path.join(process.env["SystemRoot"] ?? "C:\\Windows", "System32")].join(path.delimiter) },
  });
  await log.next("ready");
  agent.send({ type: "user_input", inputId: "in-1", text: "找一下" });
  const out: Array<{ isError: boolean; text: string }> = [];
  for (let i = 0; i < steps.length; i += 1) {
    const end = await log.next("tool_call_end");
    out.push({ isError: end.isError, text: end.resultText });
  }
  await log.next("turn_end");
  return out;
}

describe("pi 契约：没有 fd、rg 时的 find、grep", () => {
  it("find：按 glob 找到文件（*.ts 一层层往下找），跳过 node_modules，路径用 / 分隔；没有的回没找到", async () => {
    const cwd = workdir();
    const [all, ts, none, sub] = await results(
      [call("find", { pattern: "**/*" }), call("find", { pattern: "*.ts" }), call("find", { pattern: "*.nothing" }), call("find", { pattern: "*.ts", path: "src/deep" })],
      ["find"],
      cwd,
    );
    expect(all!.isError).toBe(false);
    expect(all!.text).not.toContain("could not be downloaded");
    expect(all!.text).toContain("notes.md");
    expect(all!.text).not.toContain("node_modules");
    expect(ts!.text.split("\n").toSorted()).toEqual(["src/a.ts", "src/deep/b.ts"]);
    expect(none!.text).toContain("No files found");
    expect(sub!.text.trim()).toBe("b.ts");
  });

  it("grep：写法同 pi（文件:行号: 内容，上下文 文件-行号- 内容），跳过 node_modules；glob、忽略大小写、按字面、限量都认", async () => {
    const cwd = workdir();
    const [plain, context, globbed, literal, limited, none] = await results(
      [
        call("grep", { pattern: "留存掉半" }),
        call("grep", { pattern: "留存掉半", path: "notes.md", context: 1 }),
        call("grep", { pattern: "留存", glob: "*.ts" }),
        call("grep", { pattern: "A = 1;", ignoreCase: true, literal: true }),
        call("grep", { pattern: "留存掉半", limit: 1 }),
        call("grep", { pattern: "没有这句" }),
      ],
      ["grep"],
      cwd,
    );
    expect(plain!.isError).toBe(false);
    expect(plain!.text.split("\n").toSorted()).toEqual(["notes.md:2: 留存掉半在这里", "src/deep/b.ts:1: // 留存掉半"]);
    expect(context!.text.split("\n")).toEqual(["notes.md-1- 第一行", "notes.md:2: 留存掉半在这里", "notes.md-3- 第三行"]);
    expect(globbed!.text).toBe("src/deep/b.ts:1: // 留存掉半");
    expect(literal!.text).toBe("src/a.ts:1: const a = 1;");
    expect(limited!.text).toContain("1 matches limit reached");
    expect(none!.text).toBe("No matches found");
  });
});
