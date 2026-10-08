// 读过的密钥值（规格第 9 节，30 号票）：执行成功的调用读到 .env 或密钥文件，守护进程把里面的值收进这个任务
// （不属于任务的是这一段会话）的内存里，之后判定时作为环境事实交给守卫。这里直接调 read-secrets.ts，文件是临时目录里真的文件。
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { BUILTIN_TOOL_REGISTRY, judgeToolCall, type GuardAgent, type GuardInput, type GuardTask } from "../../src/guard/index.ts";
import { createReadSecrets, scopeOf } from "../../src/guard-runtime/read-secrets.ts";
import { makeTempDir } from "../helpers/temp-dir.ts";

function maintainer(cwd: string): GuardAgent {
  return { kind: "maintainer", agentId: "m-1", cwd, toolkit: { bash: true, network: true }, projectRecords: [], workingDirs: [cwd] };
}

const task = (taskId: string): GuardTask => ({ taskId, currentStageId: "s1", plan: { grants: [] } });

/** 一次判定的输入（不属于任务时给 segmentId） */
function input(dir: string, toolName: string, args: Record<string, unknown>, where: { task?: GuardTask; segmentId?: string }): GuardInput {
  return {
    call: { toolName, args },
    agent: maintainer(dir),
    places: { dataDir: { root: "D:\\ergou-data", config: "D:\\ergou-data\\config", secrets: "D:\\ergou-data\\secrets", db: "D:\\ergou-data\\db", projects: "D:\\ergou-data\\projects" }, programDir: "D:\\ergou-app", homeDir: dir },
    task: where.task ?? null,
    ...(where.segmentId === undefined ? {} : { segmentId: where.segmentId }),
    effectLog: [],
    settings: {},
    facts: {},
    tools: BUILTIN_TOOL_REGISTRY,
    now: 0,
  };
}

/** 一个有 .env、私钥和普通文件的工作目录 */
function makeWorkDir(): string {
  const dir = fs.realpathSync.native(makeTempDir("ergou-work-"));
  fs.writeFileSync(path.join(dir, ".env"), "API_KEY=Zq81mWp4vX2c\nPORT=8080\n");
  fs.mkdirSync(path.join(dir, "keys"));
  fs.writeFileSync(path.join(dir, "keys", "deploy.pem"), "-----BEGIN KEY-----\nAAAA BBBB CCCC\n-----END KEY-----\n");
  fs.writeFileSync(path.join(dir, "notes.txt"), "TOKEN=notASecretFile123\n");
  return dir;
}

/** 判定一次，当它执行成功了，收进读过的值 */
function run(store: ReturnType<typeof createReadSecrets>, i: GuardInput): void {
  store.capture(i, judgeToolCall(i));
}

describe("读过的密钥值", () => {
  it("文件工具和 bash 读到的 .env、密钥文件的值都收进这个任务；读普通文件不收", () => {
    const dir = makeWorkDir();
    const store = createReadSecrets();
    const where = { task: task("t-1") };
    run(store, input(dir, "read", { path: "notes.txt" }, where));
    expect(store.valuesFor({ taskId: "t-1" })).toEqual([]);
    run(store, input(dir, "read", { path: ".env" }, where));
    run(store, input(dir, "bash", { command: "cat keys/deploy.pem | head -1" }, where));
    expect(store.valuesFor({ taskId: "t-1" })).toEqual(["Zq81mWp4vX2c", "-----BEGINKEY-----AAAABBBBCCCC-----ENDKEY-----"]);
  });

  it("按范围分开：别的任务、别的会话段看不到", () => {
    const dir = makeWorkDir();
    const store = createReadSecrets();
    run(store, input(dir, "bash", { command: "source .env" }, { segmentId: "seg-1" }));
    const seg1 = scopeOf({ task: null, agent: maintainer(dir), segmentId: "seg-1" });
    expect(store.valuesFor(seg1)).toEqual(["Zq81mWp4vX2c"]);
    expect(store.valuesFor({ taskId: null, agentId: "m-1", segmentId: "seg-2" })).toEqual([]);
    expect(store.valuesFor({ taskId: null, agentId: "m-2", segmentId: "seg-1" })).toEqual([]);
    expect(store.valuesFor({ taskId: "t-1" })).toEqual([]);
  });

  it("写 .env 不算读；文件不在了也不出错", () => {
    const dir = makeWorkDir();
    const store = createReadSecrets();
    run(store, input(dir, "write", { path: ".env", content: "API_KEY=Zq81mWp4vX2c" }, { task: task("t-1") }));
    run(store, input(dir, "read", { path: "config/.env.production" }, { task: task("t-1") }));
    expect(store.valuesFor({ taskId: "t-1" })).toEqual([]);
  });
});
