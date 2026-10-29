// 彻底删除改写会话文件时，会话文件正被别的进程开着（255 号票）。Windows 上改名覆盖一个开着的文件会 EPERM（哪怕对方只是在读：
// 备份在复制、测试在轮询、杀毒在扫）；改写以前碰上一次就放弃，等下次守护进程启动才再改——这期间被删的原话还在会话文件里，
// 重新拉起的 agent 也照样看得到。现在改名碰上 EPERM / EBUSY / EACCES 先等一会儿重试，对方关掉文件后就改成了。
// （POSIX 上改名不受开着的文件影响，这条用例照样过。）
import { type ChildProcess, spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { PURGED_SUMMARY_TEXT, PURGED_TEXT } from "@ergo/protocol";
import { afterEach, describe, expect, it } from "vitest";
import { buildChildEnv } from "../src/process/child-env.ts";
import type { SessionRewriteRequest } from "../src/runtime/host-protocol.ts";
import { runSessionRewrite } from "../src/runtime/index.ts";
import { SESSION_INPUT_TAG } from "../src/runtime/index.ts";
import { makeTempDir } from "./helpers/temp-dir.ts";

/** 改写会话文件走守护进程那条路（拉起一次性子进程 rewrite-main），不越过 pi 的封装边界直接 import agent-child/ 里的模块 */
const rewriteViaChild = (req: SessionRewriteRequest) => runSessionRewrite(req, { env: buildChildEnv(process.env, {}) });

const line = (entry: unknown) => JSON.stringify(entry);
const at = "2026-10-24T08:00:00.000Z";

/** 一个会话文件：一条带输入标签的用户消息（要改的）和一条不改的 */
function writeSession(dir: string): string {
  const file = path.join(dir, `${at.replaceAll(":", "-")}_s1.jsonl`);
  const user = (id: string, parentId: string, text: string) => ({ type: "message", id, parentId, timestamp: at, message: { role: "user", content: [{ type: "text", text }], timestamp: 0 } });
  fs.writeFileSync(
    file,
    [
      line({ type: "session", version: 3, id: "s1", timestamp: at, cwd: dir }),
      line({ type: "custom", customType: SESSION_INPUT_TAG, data: { inputId: "in-secret" }, id: "c1", parentId: null, timestamp: at }),
      line(user("m1", "c1", "暗号是青蛙")),
      line(user("m2", "m1", "今天天气不错")),
      "",
    ].join("\n"),
  );
  return file;
}

/** 另一个进程打开这个文件（像 readFileSync 那样只读），开着 holdMs 毫秒再关；返回时它已经打开了 */
async function holdOpen(file: string, holdMs: number): Promise<ChildProcess> {
  const script = `const fs=require("node:fs");const fd=fs.openSync(${JSON.stringify(file)},"r");process.stdout.write("open");setTimeout(()=>{fs.closeSync(fd);process.exit(0)},${holdMs});`;
  const child = spawn(process.execPath, ["-e", script], { stdio: ["ignore", "pipe", "inherit"] });
  holders.push(child);
  await new Promise<void>((resolve, reject) => {
    child.stdout!.once("data", () => resolve());
    child.once("exit", (code) => reject(new Error(`占着文件的进程提前退出了（${code}）`)));
  });
  return child;
}

const holders: ChildProcess[] = [];
afterEach(() => {
  for (const child of holders.splice(0)) child.kill();
});

describe("改写会话文件时文件正被别的进程开着（255 号票）", () => {
  it("改名碰上文件被占着时等一会儿重试：对方关掉后改成了，被删的那句换成删除标记、别的不动；不留临时文件", async () => {
    const dir = makeTempDir("ergo-rewrite-busy-");
    const file = writeSession(dir);
    // 改写在一次性子进程里跑，拉起要一两秒：占得久一点，确保子进程改名时文件还被占着
    await holdOpen(file, 3000);

    const result = await rewriteViaChild({ sessionDir: dir, inputIds: ["in-secret"], toolCallIds: [], toolResultLines: [], marker: PURGED_TEXT, summaryMarker: PURGED_SUMMARY_TEXT, customTypes: [] });

    expect(result).toEqual({ files: 1, entries: 1, summaries: 0 });
    const text = fs.readFileSync(file, "utf8");
    expect(text).not.toContain("暗号是青蛙");
    expect(text).toContain(PURGED_TEXT);
    expect(text).toContain("今天天气不错");
    expect(fs.readdirSync(dir)).toEqual([path.basename(file)]);
  });
});
