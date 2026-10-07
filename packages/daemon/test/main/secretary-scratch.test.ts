// 主切面：秘书的草稿区（规格第 7、9 节）。秘书接 faux 剧本，在草稿区里写脚本、用 Git Bash 跑出结果再回答；
// 草稿区里的写、改、删不落入任何关注类别，直接做、只记录；聊天里每次工具调用都有一条记录（工具名、参数摘要、
// 命中的关注类别、判定、是否授权内、是否通用 bash），执行成功的进效果日志。
// 秘书的围栏：草稿区外写被拒、项目档案只读、碰密钥区拒绝、写受保护区域永不；联网的命令和用到联网库的脚本拒绝。
import fs from "node:fs";
import path from "node:path";
import { CHANNELS, EVENT_TYPES, type MessageEnvelope, type MessageEventPayload, type MessagePart } from "@ergou/protocol";
import { describe, expect, it } from "vitest";
import { dataDirLayout } from "../../src/config/data-dir.ts";
import { realPathOf } from "../../src/guard-runtime/facts.ts";
import { listEffects } from "../../src/guard-runtime/effect-log.ts";
import { PROGRAM_DIR } from "../../src/daemon.ts";
import { OFFLINE_PROXY } from "../../src/process/child-env.ts";
import type { FauxStep } from "../../src/runtime/index.ts";
import { startTestDaemon } from "../helpers/daemon.ts";
import { TestFrontend } from "../helpers/frontend.ts";
import { makeTempDir } from "../helpers/temp-dir.ts";

const { secretary: SECRETARY, cards: CARDS, inbox: INBOX } = CHANNELS;

type ToolCallPart = Extract<MessagePart, { type: "tool_call" }>;

const call = (name: string, args: Record<string, unknown>): FauxStep => ({ kind: "reply", toolCalls: [{ name, arguments: args as never }] });
const bash = (command: string) => call("bash", { command });

/** 先定下数据目录和主目录（剧本里要写数据目录各区的路径时用），再交给 setup */
function dirs() {
  const dataDir = makeTempDir("ergou-data-");
  return { dataDir, homeDir: makeTempDir("ergou-home-"), layout: dataDirLayout(realPathOf(dataDir)!) };
}

async function setup(script: FauxStep[], env: Record<string, string> = {}, reuse?: { dataDir: string; homeDir: string }) {
  const test = await startTestDaemon({ secretary: script, env, ...(reuse ? { reuse } : {}) });
  const frontend = await TestFrontend.connect(test.url);
  await frontend.subscribe({ [SECRETARY]: 0, [CARDS]: 0, [INBOX]: 0 });
  const layout = dataDirLayout(realPathOf(test.dataDir)!);
  return { ...test, frontend, layout, scratch: layout.scratch };
}

async function tell(frontend: TestFrontend, text: string) {
  await frontend.sendText(text);
  await frontend.next(SECRETARY, EVENT_TYPES.turnEnd);
}

const messagesOf = (frontend: TestFrontend): MessageEnvelope[] =>
  frontend.events({ channel: SECRETARY, type: EVENT_TYPES.message }).map((f) => (f.payload as MessageEventPayload).message);
const toolPartsOf = (frontend: TestFrontend): ToolCallPart[] =>
  messagesOf(frontend).flatMap((m) => m.parts.filter((p): p is ToolCallPart => p.type === "tool_call"));
/** 秘书最后一次模型调用看到的上下文（剧本最后一步是 echo_context） */
const lastEcho = (frontend: TestFrontend): string =>
  messagesOf(frontend)
    .at(-1)!
    .parts.map((p) => (p.type === "text" ? p.text : ""))
    .join("");

describe("草稿区里干活", () => {
  it("写一个脚本、用 Git Bash 跑出结果、回答用户：不落入任何关注类别、直接执行；聊天里有记录，bash 标通用 bash；进效果日志", async () => {
    const { frontend, daemon, scratch } = await setup([
      call("write", { path: "calc.js", content: "console.log([1, 2, 3].reduce((a, b) => a + b, 0));\n" }),
      bash("node calc.js"),
      { kind: "echo_context" },
    ]);
    await tell(frontend, "算一下 1+2+3");

    expect(fs.readFileSync(path.join(scratch, "calc.js"), "utf8")).toContain("reduce");
    expect(messagesOf(frontend).map((m) => `${m.speaker}:${m.parts.map((p) => p.type).join(",")}`)).toEqual([
      "user:text",
      "agent:tool_call",
      "agent:tool_call",
      "agent:text",
    ]);
    const [write, run] = toolPartsOf(frontend);
    expect(write).toMatchObject({ tool: "write", argsSummary: "calc.js", watchCategories: [], disposition: "do", withinGrant: false, genericBash: false, outcome: "done" });
    expect(run).toMatchObject({ tool: "bash", argsSummary: "node calc.js", watchCategories: [], disposition: "do", withinGrant: false, genericBash: true, outcome: "done", resultSummary: "6" });
    expect(lastEcho(frontend)).toContain("[toolResult] bash: 6");

    // 效果日志：写文件一条；bash 记拆出来的伪工具调用（跑脚本）
    const effects = listEffects(daemon.store.reader, { agentId: "secretary", segmentId: "secretary", taskId: null });
    expect(effects.map((e) => [e.seq, e.tool, e.taskId, e.stageId, e.agentId, e.segmentId])).toEqual([
      [1, "write", null, null, "secretary", "secretary"],
      [2, "run_script", null, null, "secretary", "secretary"],
    ]);
    expect(effects[0]!.args).toMatchObject({ path: path.join(scratch, "calc.js") });
    expect(effects[1]!.args).toEqual({ interpreter: "node", path: path.join(scratch, "calc.js") });
  });

  it("删除、覆盖草稿区里的文件同样直接做（不受'删除前须已备份或已提交'约束）", async () => {
    const { frontend, scratch } = await setup([
      call("write", { path: "report.md", content: "第一版" }),
      call("write", { path: "report.md", content: "整篇重写" }),
      bash("cp report.md old.md && rm report.md"),
      { kind: "reply", text: "好了" },
    ]);
    await tell(frontend, "写个报告再删掉");
    expect(toolPartsOf(frontend).map((p) => [p.tool, p.disposition, p.outcome, p.watchCategories])).toEqual([
      ["write", "do", "done", []],
      ["write", "do", "done", []],
      ["bash", "do", "done", []],
    ]);
    expect(fs.existsSync(path.join(scratch, "report.md"))).toBe(false);
    expect(fs.readFileSync(path.join(scratch, "old.md"), "utf8")).toBe("整篇重写");
  });

  it("执行失败的调用不进效果日志", async () => {
    const { frontend, daemon } = await setup([bash("node missing.js"), { kind: "reply", text: "没跑成" }]);
    await tell(frontend, "跑一下");
    expect(toolPartsOf(frontend)[0]).toMatchObject({ tool: "bash", disposition: "do", outcome: "error" });
    expect(listEffects(daemon.store.reader, { agentId: "secretary", segmentId: "secretary", taskId: null })).toEqual([]);
  });
});

/** bash 里用正斜杠写 Windows 路径（Git Bash 认 C:/x/y） */
const fwd = (p: string) => p.replaceAll("\\", "/");

describe("秘书的围栏", () => {
  it("文件工具写草稿区以外（含经目录联接写到外面）：直接拒绝，不出审批卡；项目档案只读", async () => {
    const outside = realPathOf(makeTempDir("ergou-outside-"))!;
    const { layout, ...reuse } = dirs();
    fs.mkdirSync(layout.scratch, { recursive: true });
    fs.symlinkSync(outside, path.join(layout.scratch, "link"), "junction");
    fs.mkdirSync(path.join(layout.projects, "notes"), { recursive: true });
    fs.writeFileSync(path.join(layout.projects, "notes", "charter.md"), "立项书：记账");
    const { frontend } = await setup(
      [
        call("write", { path: path.join(outside, "x.txt"), content: "不该写出去" }),
        call("write", { path: "link/escaped.txt", content: "不该写出去" }),
        call("write", { path: path.join(layout.projects, "notes", "spec.md"), content: "改档案" }),
        call("read", { path: path.join(layout.projects, "notes", "charter.md") }),
        { kind: "echo_context" },
      ],
      {},
      reuse,
    );
    await tell(frontend, "写几个文件");

    const parts = toolPartsOf(frontend);
    expect(parts.slice(0, 3).map((p) => [p.tool, p.blockedBy, p.outcome])).toEqual([
      ["write", "hard_refusal", "blocked"],
      ["write", "hard_refusal", "blocked"],
      ["write", "hard_refusal", "blocked"],
    ]);
    expect(parts[3]).toMatchObject({ tool: "read", disposition: "do", outcome: "done", watchCategories: [] });
    expect(fs.readdirSync(outside)).toEqual([]);
    expect(fs.existsSync(path.join(layout.projects, "notes", "spec.md"))).toBe(false);
    expect(frontend.events({ channel: CARDS })).toEqual([]);
    const seen = lastEcho(frontend);
    expect(seen).toContain("秘书的文件工具只能写草稿区");
    expect(seen).toContain("[toolResult] read: 立项书：记账");
  });

  it("读密钥区一律拒绝；用文件工具或 bash 写受保护区域（配置区、密钥区、数据库区、二狗程序目录）判永不，不出审批卡", async () => {
    const programFile = path.join(realPathOf(PROGRAM_DIR)!, "packages", "ergou-guard-should-not-exist.txt");
    const { layout, ...reuse } = dirs();
    fs.mkdirSync(layout.secrets, { recursive: true });
    fs.writeFileSync(path.join(layout.secrets, "deepseek-api-key.txt"), "sk-secret-in-secrets-area");
    const { frontend } = await setup(
      [
        call("read", { path: path.join(layout.secrets, "deepseek-api-key.txt") }),
        call("write", { path: path.join(layout.db, "x.db"), content: "x" }),
        bash(`echo '{}' > "${fwd(path.join(layout.config, "watch-categories.json"))}"`),
        bash(`echo x > "${fwd(path.join(layout.secrets, "k.txt"))}"`),
        bash(`echo x > "${fwd(programFile)}"`),
        { kind: "echo_context" },
      ],
      {},
      reuse,
    );
    await tell(frontend, "动一动受保护的地方");

    const parts = toolPartsOf(frontend);
    expect(parts.map((p) => [p.tool, p.blockedBy ?? null, p.disposition, p.outcome])).toEqual([
      ["read", "hard_refusal", "do", "blocked"],
      ["write", "hard_refusal", "never", "blocked"],
      ["bash", null, "never", "blocked"],
      ["bash", "hard_refusal", "never", "blocked"],
      ["bash", null, "never", "blocked"],
    ]);
    expect(lastEcho(frontend)).toContain("密钥区连读都拒绝");
    expect(lastEcho(frontend)).not.toContain("sk-secret-in-secrets-area");
    expect(fs.existsSync(path.join(layout.config, "watch-categories.json"))).toBe(false);
    expect(fs.existsSync(path.join(layout.secrets, "k.txt"))).toBe(false);
    expect(fs.existsSync(path.join(layout.db, "x.db"))).toBe(false);
    expect(fs.existsSync(programFile)).toBe(false);
    expect(frontend.events({ channel: CARDS })).toEqual([]);
  });
});

describe("秘书不能联网", () => {
  it("bash 里发 HTTP 请求：直接拒绝，提示联网请发起任务", async () => {
    const { frontend } = await setup([bash("curl -s https://example.com"), { kind: "echo_context" }]);
    await tell(frontend, "看看 example.com");
    expect(toolPartsOf(frontend)[0]).toMatchObject({ tool: "bash", blockedBy: "hard_refusal", genericBash: true, outcome: "blocked" });
    expect(lastEcho(frontend)).toMatch(/\[toolResult\] bash: 拒绝：[^\n]*联网请发起任务/);
  });

  it("草稿区里的脚本执行前先扫：用到联网库或函数的拒绝（联网请发起任务），不用联网的照常跑", async () => {
    const { frontend } = await setup([
      call("write", { path: "fetch.py", content: "import requests\nprint(requests.get('https://example.com').status_code)\n" }),
      bash("python fetch.py"),
      call("write", { path: "net.js", content: "fetch('https://example.com').then((r) => console.log(r.status));\n" }),
      bash("node net.js"),
      call("write", { path: "sum.js", content: "console.log(40 + 2);\n" }),
      bash("node sum.js"),
      { kind: "echo_context" },
    ]);
    await tell(frontend, "跑几个脚本");
    const runs = toolPartsOf(frontend).filter((p) => p.tool === "bash");
    expect(runs.map((p) => [p.argsSummary, p.blockedBy ?? null, p.outcome])).toEqual([
      ["python fetch.py", "hard_refusal", "blocked"],
      ["node net.js", "hard_refusal", "blocked"],
      ["node sum.js", null, "done"],
    ]);
    const seen = lastEcho(frontend);
    expect(seen).toMatch(/\[toolResult\] bash: 拒绝：[^\n]*requests[^\n]*联网请发起任务/);
    expect(seen).toMatch(/\[toolResult\] bash: 拒绝：[^\n]*fetch[^\n]*联网请发起任务/);
    expect(seen).toContain("[toolResult] bash: 42");
  });

  it("bash 起的进程：代理地址是无效值，环境里没有任何密钥（子进程拿到的模型 key 在 bash 里看不到）", async () => {
    const key = "sk-main-surface-0123456789abcdef";
    const { frontend } = await setup([bash("env"), { kind: "echo_context" }], { DEEPSEEK_API_KEY: key });
    await tell(frontend, "看看环境变量");
    const seen = lastEcho(frontend);
    expect(seen).toContain(`HTTPS_PROXY=${OFFLINE_PROXY}`);
    expect(seen).toContain(`HTTP_PROXY=${OFFLINE_PROXY}`);
    expect(seen).not.toContain(key);
  });
});
