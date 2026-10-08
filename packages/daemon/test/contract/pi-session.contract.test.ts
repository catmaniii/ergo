// pi 契约测试（规格 Testing Decisions 切面 3，ADR-0001 的升级闸门）。
// 每条用例单独拉起一个 agent 子进程、接 faux provider，只验二狗依赖的 pi 行为。
// 升级 pi 之前先跑：npm run test:contract
//
// 守卫转发和插话的用例在 guard-and-interject.contract.test.ts。
// 后面的票往这里加用例：工具白名单与只注入指定 skill（27）、守卫接上之后按判定不执行的完整流程（07）、
// 压缩后注入（13，在 context-block.contract.test.ts）、用量（24，在 usage.contract.test.ts）、压缩钩子与 appendEntry（18）……；被杀后从会话文件恢复（23）在 session-recovery.contract.test.ts。
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { fauxModel, spawnTestAgent, startTestDaemon } from "../helpers/daemon.ts";
import { REVIEWER_PI_TOOLS } from "../../src/tasks/review.ts";
import { SUBMIT_REVIEW_TOOL } from "../../src/tasks/tool-names.ts";
import { makeTempDir } from "../helpers/temp-dir.ts";

describe("pi 契约", () => {
  it("一条输入 → 推理和正文的流式增量 → 一条定稿消息（带用量）", async () => {
    const { daemon } = await startTestDaemon();
    const thinking = "用户想知道今天的安排，我先看看日程。";
    const text = "今天下午三点有一个会，其余时间空着。";
    const { agent, log } = spawnTestAgent(daemon, {
      agentId: "contract-stream",
      model: fauxModel([{ kind: "reply", thinking, text }]),
      tools: [],
    });
    await log.next("ready");
    agent.send({ type: "user_input", inputId: "in-1", text: "今天有什么安排" });

    const final = await log.next("message_final");
    expect((await log.next("turn_end")).outcome).toBe("completed");

    const deltas = log.ofType("stream_delta").filter((d) => d.messageId === final.messageId);
    expect(deltas.filter((d) => d.part === "thinking").map((d) => d.delta).join("")).toBe(thinking);
    expect(deltas.filter((d) => d.part === "text").map((d) => d.delta).join("")).toBe(text);
    expect(final.message).toEqual({
      role: "assistant",
      parts: [
        { type: "thinking", text: thinking },
        { type: "text", text },
      ],
      stopReason: "done",
    });
    const [usage] = log.ofType("usage");
    expect(usage?.messageId).toBe(final.messageId);
    expect(usage?.input).toBeGreaterThan(0);
    expect(usage?.output).toBeGreaterThan(0);
  });

  it("会话只装配指定的资源：不读用户目录和工作目录里的配置、skill、上下文文件和 CLI 认证", async () => {
    // 测试守护进程给子进程的用户主目录是临时目录，往里面埋标记
    const { daemon, homeDir } = await startTestDaemon();
    const cwd = makeTempDir("ergou-cwd-");
    const extensionMarker = path.join(homeDir, "EXTENSION_LOADED");
    plantUserAndWorkdirConfig({ home: homeDir, cwd, extensionMarker });

    // 对照：装配参数里显式列出的 skill 能被加载、被模型看到，说明下面"看不到"的断言不是空话
    const explicitSkills = makeTempDir("ergou-skills-");
    writeSkill(path.join(explicitSkills, "explicit-skill"), "explicit-skill", "EXPLICIT_SKILL_DESCRIPTION");

    const { agent, log } = spawnTestAgent(daemon, {
      agentId: "contract-isolation",
      cwd,
      model: fauxModel([{ kind: "echo_context" }]),
      tools: ["read"],
      skillPaths: [path.join(explicitSkills, "explicit-skill")],
      credentials: { deepseek: "sk-test-not-a-real-key" },
    });

    const ready = await log.next("ready");
    expect(ready.loaded).toEqual({
      tools: ["read"],
      skills: ["explicit-skill"],
      contextFiles: [],
      extensions: [],
      credentialProviders: ["deepseek"],
    });

    agent.send({ type: "user_input", inputId: "in-1", text: "把你看到的系统提示念一遍" });
    const final = await log.next("message_final");
    const seen = final.message.parts.map((p) => (p.type === "text" ? p.text : "")).join("\n");
    expect(seen).toContain("EXPLICIT_SKILL_DESCRIPTION");
    expect(seen).toContain("[tool] read");
    for (const marker of PLANTED_MARKERS) expect(seen).not.toContain(marker);
    expect(fs.existsSync(extensionMarker)).toBe(false);
  });

  it("固定的系统提示：模型看到的系统提示是装配参数给的那段，不带 pi 默认的编程助手提示", async () => {
    const { daemon } = await startTestDaemon();
    const systemPrompt = "你是二狗的秘书。MARKER_FIXED_SYSTEM_PROMPT";
    const { agent, log } = spawnTestAgent(daemon, {
      agentId: "contract-system-prompt",
      model: fauxModel([{ kind: "echo_context" }]),
      tools: [],
      systemPrompt,
    });
    await log.next("ready");
    agent.send({ type: "user_input", inputId: "in-1", text: "念一遍系统提示" });
    const seen = textOf(await log.next("message_final"));
    expect(seen.startsWith(`[system] ${systemPrompt}`)).toBe(true);
    expect(seen).not.toContain("coding assistant");
  });

  it("接着上次的会话：同一个 agent 再次拉起时选了 continueSession，模型看到上次的对话", async () => {
    const { daemon } = await startTestDaemon();
    const first = spawnTestAgent(daemon, {
      agentId: "contract-continue",
      model: fauxModel([{ kind: "reply", text: "记住了，暗号是青蛙" }]),
      tools: [],
      continueSession: true,
    });
    const firstReady = await first.log.next("ready");
    first.agent.send({ type: "user_input", inputId: "in-1", text: "暗号是什么？" });
    await first.log.next("turn_end");
    first.agent.send({ type: "exit" });
    await first.agent.exited;

    const second = spawnTestAgent(daemon, {
      agentId: "contract-continue",
      model: fauxModel([{ kind: "echo_context" }]),
      tools: [],
      continueSession: true,
    });
    const ready = await second.log.next("ready");
    expect(ready.sessionFile).toBe(firstReady.sessionFile);
    second.agent.send({ type: "user_input", inputId: "in-2", text: "刚才说了什么？" });
    const seen = textOf(await second.log.next("message_final"));
    expect(seen).toContain("[user] 暗号是什么？");
    expect(seen).toContain("[assistant] 记住了，暗号是青蛙");
    expect(seen).toContain("[user] 刚才说了什么？");
  });

  it("换了工作目录也接着会话目录里最近的会话（任务转为项目、绑定外部工作目录时维护者的工作目录会变），之后的工具按新的工作目录", async () => {
    const { daemon } = await startTestDaemon();
    const before = makeTempDir("ergou-cwd-a-");
    const after = makeTempDir("ergou-cwd-b-");
    fs.writeFileSync(path.join(after, "here.txt"), "新的工作目录");
    const first = spawnTestAgent(daemon, { agentId: "contract-moved", cwd: before, model: fauxModel([{ kind: "reply", text: "记住了，暗号是青蛙" }]), tools: [], continueSession: true });
    const firstReady = await first.log.next("ready");
    first.agent.send({ type: "user_input", inputId: "in-1", text: "暗号是什么？" });
    await first.log.next("turn_end");
    first.agent.send({ type: "exit" });
    await first.agent.exited;

    const second = spawnTestAgent(daemon, {
      agentId: "contract-moved",
      cwd: after,
      model: fauxModel([{ kind: "reply", toolCalls: [{ name: "read", arguments: { path: "here.txt" } }] }, { kind: "echo_context" }]),
      tools: ["read"],
      continueSession: true,
    });
    expect((await second.log.next("ready")).sessionFile).toBe(firstReady.sessionFile);
    second.agent.send({ type: "user_input", inputId: "in-2", text: "刚才说了什么？" });
    await second.log.next("turn_end");
    const seen = textOf(second.log.ofType("message_final").at(-1)!);
    expect(seen).toContain("[assistant] 记住了，暗号是青蛙");
    expect(seen).toContain("[toolResult] read: 新的工作目录");
  });

  it("指定会话的名字（16 号票：维护者会话分段，接哪一段由守护进程明确指定）：还没有时新开、用这个名字存；再次拉起打开的是它，不是会话目录里修改时间最近的那个；ready 报回会话的名字", async () => {
    const { daemon, dataDir } = await startTestDaemon();
    const agentId = "contract-segments";
    const dir = path.join(dataDir, "sessions", agentId);
    // 第一段：新开，用指定的名字存
    const first = spawnTestAgent(daemon, { agentId, model: fauxModel([{ kind: "reply", text: "第一段收到" }]), tools: [], session: "seg-1" });
    expect(await first.log.next("ready")).toMatchObject({ session: "seg-1" });
    first.agent.send({ type: "user_input", inputId: "in-1", text: "MARKER_SEGMENT_ONE" });
    await first.log.next("turn_end");
    first.agent.send({ type: "exit" });
    await first.agent.exited;
    // 第二段：另一个会话（修改时间更近）
    const second = spawnTestAgent(daemon, { agentId, model: fauxModel([{ kind: "echo_context" }]), tools: [], session: "seg-2" });
    expect(await second.log.next("ready")).toMatchObject({ session: "seg-2" });
    second.agent.send({ type: "user_input", inputId: "in-2", text: "MARKER_SEGMENT_TWO" });
    expect(textOf(await second.log.next("message_final"))).not.toContain("MARKER_SEGMENT_ONE");
    second.agent.send({ type: "exit" });
    await second.agent.exited;
    expect(fs.readdirSync(dir).toSorted()).toEqual(["seg-1.jsonl", "seg-2.jsonl"]);
    // 再打开第一段：接着的是它（虽然第二段更近）
    const again = spawnTestAgent(daemon, { agentId, model: fauxModel([{ kind: "echo_context" }]), tools: [], session: "seg-1" });
    expect(await again.log.next("ready")).toMatchObject({ session: "seg-1" });
    again.agent.send({ type: "user_input", inputId: "in-3", text: "接着第一段" });
    const seen = textOf(await again.log.next("message_final"));
    expect(seen).toContain("[user] MARKER_SEGMENT_ONE");
    expect(seen).not.toContain("MARKER_SEGMENT_TWO");
  });

  it("指定的名字还没有会话、又选了 continueSession（项目维护者的第一段对话段）：接着会话目录里最近的那个（以前的会话），ready 报回它的名字；目录里没有会话时用指定的名字新开", async () => {
    const { daemon } = await startTestDaemon();
    // 以前的会话（任务的维护者留下的，名字由 pi 起）
    const before = spawnTestAgent(daemon, { agentId: "contract-legacy", model: fauxModel([{ kind: "reply", text: "立项问答记下了" }]), tools: [], continueSession: true });
    const legacy = await before.log.next("ready");
    before.agent.send({ type: "user_input", inputId: "in-1", text: "MARKER_LEGACY" });
    await before.log.next("turn_end");
    before.agent.send({ type: "exit" });
    await before.agent.exited;
    const segment = spawnTestAgent(daemon, { agentId: "contract-legacy", model: fauxModel([{ kind: "echo_context" }]), tools: [], continueSession: true, session: "pm-9-s1" });
    expect(await segment.log.next("ready")).toMatchObject({ sessionFile: legacy.sessionFile, session: legacy.session });
    segment.agent.send({ type: "user_input", inputId: "in-2", text: "接着说" });
    expect(textOf(await segment.log.next("message_final"))).toContain("[user] MARKER_LEGACY");
    // 没有以前的会话：用指定的名字新开
    const fresh = spawnTestAgent(daemon, { agentId: "contract-legacy-none", model: fauxModel([{ kind: "reply", text: "好" }]), tools: [], continueSession: true, session: "pm-8-s1" });
    expect(await fresh.log.next("ready")).toMatchObject({ session: "pm-8-s1" });
  });

  it("不选 continueSession 时每次拉起都是新会话", async () => {
    const { daemon } = await startTestDaemon();
    const first = spawnTestAgent(daemon, { agentId: "contract-fresh", model: fauxModel([{ kind: "reply", text: "好" }]), tools: [] });
    await first.log.next("ready");
    first.agent.send({ type: "user_input", inputId: "in-1", text: "MARKER_OLD_TURN" });
    await first.log.next("turn_end");
    first.agent.send({ type: "exit" });
    await first.agent.exited;

    const second = spawnTestAgent(daemon, { agentId: "contract-fresh", model: fauxModel([{ kind: "echo_context" }]), tools: [] });
    await second.log.next("ready");
    second.agent.send({ type: "user_input", inputId: "in-2", text: "在吗" });
    expect(textOf(await second.log.next("message_final"))).not.toContain("MARKER_OLD_TURN");
  });

  it("工具白名单之外的工具用不了：只给 read、ls（起草计划的维护者）时模型调用 write、bash，都以“没有这个工具”出错，什么也没做", async () => {
    const { daemon } = await startTestDaemon();
    const cwd = makeTempDir("ergou-cwd-");
    const { agent, log } = spawnTestAgent(daemon, {
      agentId: "contract-read-only",
      cwd,
      model: fauxModel([
        { kind: "reply", toolCalls: [{ name: "write", arguments: { path: "out.txt", content: "不该出现" } }] },
        { kind: "reply", toolCalls: [{ name: "bash", arguments: { command: "echo hi > bash.txt" } }] },
        { kind: "echo_context" },
      ]),
      tools: ["read", "ls"],
    });
    await log.next("ready");
    agent.send({ type: "user_input", inputId: "in-1", text: "写个文件" });
    expect((await log.next("turn_end")).outcome).toBe("completed");
    const echo = log.ofType("message_final").at(-1)!;
    const seen = textOf(echo);
    const lines = seen.split("\n");
    expect(lines.filter((l) => l.startsWith("[tool]"))).toEqual(["[tool] read", "[tool] ls"]);
    expect(lines.filter((l) => l.startsWith("[toolResult]"))).toEqual([expect.stringMatching(/^\[toolResult\] write: .*write.*not found/i), expect.stringMatching(/^\[toolResult\] bash: .*bash.*not found/i)]);
    expect(fs.readdirSync(cwd)).toEqual([]);
  });

  it("评审子 agent 的固定只读工具包（13）：pi 工具只有 read、ls，外加代为执行的“提交评审结论”；调用 write、edit、bash 都以“没有这个工具”出错，什么也没改", async () => {
    const { daemon } = await startTestDaemon();
    const cwd = makeTempDir("ergou-cwd-");
    fs.writeFileSync(path.join(cwd, "report.md"), "# 报告\n");
    const { agent, log } = spawnTestAgent(daemon, {
      agentId: "contract-reviewer",
      cwd,
      model: fauxModel([
        { kind: "reply", toolCalls: [{ name: "write", arguments: { path: "report.md", content: "评审改了报告" } }] },
        { kind: "reply", toolCalls: [{ name: "edit", arguments: { path: "report.md", edits: [{ oldText: "报告", newText: "改过的报告" }] } }] },
        { kind: "reply", toolCalls: [{ name: "bash", arguments: { command: "echo hi > bash.txt" } }] },
        { kind: "echo_context" },
      ]),
      tools: [...REVIEWER_PI_TOOLS],
      hostTools: [{ name: SUBMIT_REVIEW_TOOL, description: "交出评审结论", parameters: { type: "object", properties: {} } }],
    });
    await log.next("ready");
    agent.send({ type: "user_input", inputId: "in-1", text: "评审 report.md" });
    expect((await log.next("turn_end")).outcome).toBe("completed");
    const lines = textOf(log.ofType("message_final").at(-1)!).split("\n");
    expect(lines.filter((l) => l.startsWith("[tool]"))).toEqual(["[tool] read", "[tool] ls", `[tool] ${SUBMIT_REVIEW_TOOL}`]);
    expect(lines.filter((l) => l.startsWith("[toolResult]"))).toEqual([
      expect.stringMatching(/^\[toolResult\] write: .*write.*not found/i),
      expect.stringMatching(/^\[toolResult\] edit: .*edit.*not found/i),
      expect.stringMatching(/^\[toolResult\] bash: .*bash.*not found/i),
    ]);
    expect(fs.readdirSync(cwd)).toEqual(["report.md"]);
    expect(fs.readFileSync(path.join(cwd, "report.md"), "utf8")).toBe("# 报告\n");
  });
});

function textOf(final: { message: { parts: Array<{ type: string; text?: string }> } }): string {
  return final.message.parts.map((p) => (p.type === "text" ? (p.text ?? "") : "")).join("\n");
}

/** 埋在用户主目录和工作目录里的标记；任何一个出现在模型看到的上下文里，就说明多读了 */
const PLANTED_MARKERS = [
  "MARKER_PI_HOME_SKILL",
  "MARKER_AGENTS_HOME_SKILL",
  "MARKER_CLAUDE_HOME_SKILL",
  "MARKER_SETTINGS_SKILL",
  "MARKER_WORKDIR_PI_SKILL",
  "MARKER_WORKDIR_AGENTS_SKILL",
  "MARKER_WORKDIR_CLAUDE_SKILL",
  "MARKER_PI_HOME_AGENTS_MD",
  "MARKER_HOME_CLAUDE_MD",
  "MARKER_WORKDIR_AGENTS_MD",
  "MARKER_WORKDIR_CLAUDE_MD",
];

function writeSkill(dir: string, name: string, description: string): void {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "SKILL.md"), `---\nname: ${name}\ndescription: ${description}\n---\n\n按说明做事。\n`);
}

function writeFile(file: string, content: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

function plantUserAndWorkdirConfig({ home, cwd, extensionMarker }: { home: string; cwd: string; extensionMarker: string }): void {
  // 一个被加载就会留下标记文件的扩展
  const extension = path.join(home, "marker-extension.ts");
  writeFile(
    extension,
    `import fs from "node:fs";\nfs.writeFileSync(${JSON.stringify(extensionMarker)}, "loaded");\nexport default function () {}\n`,
  );

  // 用户主目录：~/.pi/agent 的设置（引用扩展和 skill）、skill、上下文文件、CLI 认证
  writeSkill(path.join(home, "settings-skill", "settings-skill"), "settings-skill", "MARKER_SETTINGS_SKILL");
  writeFile(
    path.join(home, ".pi", "agent", "settings.json"),
    JSON.stringify({ extensions: [extension], skills: [path.join(home, "settings-skill")] }),
  );
  writeSkill(path.join(home, ".pi", "agent", "skills", "pi-home-skill"), "pi-home-skill", "MARKER_PI_HOME_SKILL");
  writeSkill(path.join(home, ".agents", "skills", "agents-home-skill"), "agents-home-skill", "MARKER_AGENTS_HOME_SKILL");
  writeSkill(path.join(home, ".claude", "skills", "claude-home-skill"), "claude-home-skill", "MARKER_CLAUDE_HOME_SKILL");
  writeFile(path.join(home, ".pi", "agent", "AGENTS.md"), "MARKER_PI_HOME_AGENTS_MD\n");
  writeFile(path.join(home, ".claude", "CLAUDE.md"), "MARKER_HOME_CLAUDE_MD\n");
  writeFile(path.join(home, ".pi", "agent", "auth.json"), JSON.stringify({ anthropic: { type: "api_key", key: "sk-ant-planted" } }));

  // agent 的工作目录：.pi 设置与 skill、.agents / .claude 的 skill、AGENTS.md、CLAUDE.md
  writeFile(path.join(cwd, ".pi", "settings.json"), JSON.stringify({ extensions: [extension] }));
  writeSkill(path.join(cwd, ".pi", "skills", "workdir-pi-skill"), "workdir-pi-skill", "MARKER_WORKDIR_PI_SKILL");
  writeSkill(path.join(cwd, ".agents", "skills", "workdir-agents-skill"), "workdir-agents-skill", "MARKER_WORKDIR_AGENTS_SKILL");
  writeSkill(path.join(cwd, ".claude", "skills", "workdir-claude-skill"), "workdir-claude-skill", "MARKER_WORKDIR_CLAUDE_SKILL");
  writeFile(path.join(cwd, "AGENTS.md"), "MARKER_WORKDIR_AGENTS_MD\n");
  writeFile(path.join(cwd, "CLAUDE.md"), "MARKER_WORKDIR_CLAUDE_MD\n");
}
