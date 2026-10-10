// pi 契约测试：按工具包装配会话、换一套工具包接着同一个会话（27 号票，规格第 3、21 节）。
// - 按工具包装配：只加载工具包里列的 skill（经 additionalSkillPaths，noSkills: true），工具白名单和工具包一致、有 skill 时含 read；
//   测试机（临时的 HOME、USERPROFILE）的 ~/.pi 和 ~/.claude/skills 里预先放了配置和 skill，装配出的会话里一个都没有，也不用 CLI 认证；
// - 做完手头这一步就停下（宿主协议的 yield）：当前这一批工具调用结束、下一次模型调用之前回合以 yielded 结束，会话文件里没有做了一半的回合；
// - 同一个会话文件换一套工具包重新装配后，追加一条"工具包已变更"接着原来的对话：新加的 skill 和工具可用，去掉的不在；
// - 只在用户点名时才用的 skill（frontmatter 的 disable-model-invocation，72 号票）：pi 不放进 skill 清单，二狗另起一段追加在系统提示后面。
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { HostToolSpec } from "../../src/runtime/index.ts";
import { fauxModel, spawnTestAgent, startTestDaemon } from "../helpers/daemon.ts";
import { makeTempDir } from "../helpers/temp-dir.ts";

const WAIT_TOOL: HostToolSpec = {
  name: "slow_step",
  description: "做一步要一会儿的事（测试用）",
  parameters: { type: "object", properties: { what: { type: "string" } }, required: ["what"], additionalProperties: false },
};

function writeSkill(dir: string, name: string, description: string): string {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "SKILL.md"), `---\nname: ${name}\ndescription: ${description}\n---\n\n照着做。\n`);
  return dir;
}

function writeFile(file: string, content: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

/** 测试机的用户目录（临时的 HOME、USERPROFILE）里预先放好的 pi 配置、skill 和 CLI 认证 */
function plantHome(home: string): string[] {
  writeSkill(path.join(home, ".claude", "skills", "intent-mining"), "intent-mining", "MARKER_HOME_CLAUDE_INTENT_MINING");
  writeSkill(path.join(home, ".claude", "skills", "reasoning-graph"), "reasoning-graph", "MARKER_HOME_CLAUDE_REASONING_GRAPH");
  writeSkill(path.join(home, ".pi", "agent", "skills", "pi-own"), "pi-own", "MARKER_HOME_PI_SKILL");
  writeFile(path.join(home, ".pi", "agent", "settings.json"), JSON.stringify({ skills: [path.join(home, ".claude", "skills")] }));
  writeFile(path.join(home, ".pi", "agent", "auth.json"), JSON.stringify({ anthropic: { type: "api_key", key: "sk-ant-planted" } }));
  return ["MARKER_HOME_CLAUDE_INTENT_MINING", "MARKER_HOME_CLAUDE_REASONING_GRAPH", "MARKER_HOME_PI_SKILL"];
}

const textOf = (final: { message: { parts: Array<{ type: string; text?: string }> } }) =>
  final.message.parts
    .filter((p) => p.type === "text")
    .map((p) => p.text ?? "")
    .join("\n");
const lines = (seen: string, prefix: string) => seen.split("\n").filter((l) => l.startsWith(prefix));

describe("pi 契约：按工具包装配会话", () => {
  it("只含工具包列出的 skill（additionalSkillPaths，noSkills）；工具白名单与工具包一致、有 skill 时含 read；用户目录里的 ~/.pi、~/.claude/skills 和 CLI 认证一个都没有", async () => {
    const { daemon, homeDir } = await startTestDaemon();
    // 测试守护进程给子进程的 HOME、USERPROFILE 都是这个临时目录
    const markers = plantHome(homeDir);
    const library = makeTempDir("ergou-skill-library-");
    const notes = writeSkill(path.join(library, "notes-style"), "notes-style", "MARKER_TOOLKIT_NOTES_STYLE");
    writeSkill(path.join(library, "not-in-toolkit"), "not-in-toolkit", "MARKER_LIBRARY_NOT_IN_TOOLKIT");

    const { agent, log } = spawnTestAgent(daemon, {
      agentId: "contract-toolkit",
      model: fauxModel([{ kind: "echo_context" }]),
      // 工具包：一个 skill、不开 bash（白名单里因此有 read，没有 bash）
      tools: ["read", "write"],
      skillPaths: [notes],
    });
    const ready = await log.next("ready");
    expect(ready.loaded.skills).toEqual(["notes-style"]);
    expect(ready.loaded.tools.toSorted()).toEqual(["read", "write"]);
    expect(ready.loaded.credentialProviders).toEqual([]);

    agent.send({ type: "user_input", inputId: "in-1", text: "念一遍你看到的" });
    const seen = textOf(await log.next("message_final"));
    expect(seen).toContain("MARKER_TOOLKIT_NOTES_STYLE");
    expect(lines(seen, "[tool]").toSorted()).toEqual(["[tool] read", "[tool] write"]);
    expect(seen).not.toContain("MARKER_LIBRARY_NOT_IN_TOOLKIT");
    for (const marker of markers) expect(seen).not.toContain(marker);
  });

  it("做完手头这一步就停下（yield）：这一批工具调用结束后、下一次模型调用之前回合以 yielded 结束；同一个会话文件换一套工具包接着，模型看到原来的对话和“工具包已变更”，新加的 skill 和工具可用，去掉的不在", async () => {
    const { daemon, homeDir } = await startTestDaemon();
    const markers = plantHome(homeDir);
    const library = makeTempDir("ergou-skill-library-");
    const before = writeSkill(path.join(library, "old-skill"), "old-skill", "MARKER_OLD_SKILL");
    const added = writeSkill(path.join(library, "new-skill"), "new-skill", "MARKER_NEW_SKILL");
    const cwd = makeTempDir("ergou-cwd-");

    // 第一套工具包：old-skill，read + 代为执行的 slow_step
    const first = spawnTestAgent(daemon, {
      agentId: "contract-reassemble",
      cwd,
      model: fauxModel([
        { kind: "reply", text: "先做一步", toolCalls: [{ name: "slow_step", arguments: { what: "整理" } }] },
        // 不该走到这一步：回合在它之前就停下了
        { kind: "reply", text: "MARKER_SHOULD_NOT_RUN" },
      ]),
      tools: ["read"],
      hostTools: [WAIT_TOOL],
      skillPaths: [before],
      continueSession: true,
    });
    const firstReady = await first.log.next("ready");
    expect(firstReady.loaded.skills).toEqual(["old-skill"]);
    first.agent.send({ type: "user_input", inputId: "in-1", text: "把笔记整理一下" });
    const call = await first.log.next("host_tool_call");
    // 工具正在做的时候要求停下：这一步做完才停
    first.agent.send({ type: "yield" });
    await new Promise((r) => setTimeout(r, 200));
    expect(first.log.ofType("turn_end")).toEqual([]);
    first.agent.send({ type: "host_tool_result", requestId: call.requestId, result: { text: "整理好了第一部分", isError: false } });
    expect(await first.log.next("tool_call_end")).toMatchObject({ toolName: "slow_step", isError: false });
    expect((await first.log.next("turn_end")).outcome).toBe("yielded");
    // 没有下一次模型调用
    expect(first.log.ofType("message_final").map((m) => textOf(m))).toEqual(["先做一步"]);
    first.agent.send({ type: "exit" });
    await first.agent.exited;

    // 第二套工具包：去掉 old-skill 和 slow_step，加上 new-skill 和 write；接着同一个会话文件
    const second = spawnTestAgent(daemon, {
      agentId: "contract-reassemble",
      cwd,
      model: fauxModel([{ kind: "reply", toolCalls: [{ name: "write", arguments: { path: "notes.md", content: "第二部分" } }] }, { kind: "echo_context" }]),
      tools: ["read", "write"],
      skillPaths: [added],
      continueSession: true,
    });
    const ready = await second.log.next("ready");
    expect(ready.sessionFile).toBe(firstReady.sessionFile);
    expect(ready.loaded.skills).toEqual(["new-skill"]);
    second.agent.send({ type: "user_input", inputId: "toolkit-1", text: "工具包已变更：加上 skill new-skill、write；去掉 skill old-skill。接着干" });
    expect((await second.log.next("turn_end")).outcome).toBe("completed");
    const seen = textOf(second.log.ofType("message_final").at(-1)!);
    // 原来的对话（含停下前做完的那一步）都在，接着的是"工具包已变更"
    expect(seen).toContain("[user] 把笔记整理一下");
    expect(seen).toContain("[toolResult] slow_step: 整理好了第一部分");
    expect(seen).toContain("[user] 工具包已变更：加上 skill new-skill");
    expect(seen).not.toContain("MARKER_SHOULD_NOT_RUN");
    // 新的工具包：pi 把这次的系统提示和工具的变化记成接着的一条系统消息（skills 段换成新的名单，写明加了哪些工具、去掉了哪些）。
    // 发给模型时怎么摆看模型：faux 认会话中途的系统消息，就照这样追加；不认的（第一阶段的 deepseek-flash）pi 把更新后的系统提示放回开头、
    // 工具列表整份重发，那一次的提示词前缀缓存失效（规格说的代价）。这里只核对模型眼里现在的样子：new-skill 和 write 可用，old-skill、slow_step 不在
    const update = seen.slice(seen.indexOf("[toolResult] slow_step"));
    const skillsNow = update.slice(update.indexOf("<skills>"), update.indexOf("</skills>"));
    expect(skillsNow).toContain("MARKER_NEW_SKILL");
    expect(skillsNow).not.toContain("MARKER_OLD_SKILL");
    expect(lines(update, "[tool]")).toEqual(["[tool] write"]);
    expect(lines(update, "[tool-removed]")).toEqual(["[tool-removed] slow_step"]);
    expect(fs.readFileSync(path.join(cwd, "notes.md"), "utf8")).toBe("第二部分");
    for (const marker of markers) expect(seen).not.toContain(marker);
  });

  it("只在用户点名时才用的 skill（disable-model-invocation: true）：不在 pi 的 skill 清单里，在追加的一段里写明点名才用，带名字、说明和位置；没有这类 skill 时不加这一段", async () => {
    const { daemon } = await startTestDaemon();
    const library = makeTempDir("ergou-skill-library-");
    const normal = writeSkill(path.join(library, "normal-skill"), "normal-skill", "MARKER_NORMAL_SKILL");
    const named = path.join(library, "named-only");
    writeFile(path.join(named, "SKILL.md"), "---\nname: named-only\ndescription: MARKER_NAMED_ONLY\ndisable-model-invocation: true\n---\n\n点名才用。\n");
    const { agent, log } = spawnTestAgent(daemon, {
      agentId: "contract-user-invoked",
      model: fauxModel([{ kind: "echo_context" }]),
      tools: ["read"],
      skillPaths: [normal, named],
    });
    expect((await log.next("ready")).loaded.skills.toSorted()).toEqual(["named-only", "normal-skill"]);
    agent.send({ type: "user_input", inputId: "in-1", text: "念一遍你看到的" });
    const seen = textOf(await log.next("message_final"));
    const listed = seen.slice(seen.indexOf("<available_skills>"), seen.indexOf("</available_skills>"));
    expect(listed).toContain("MARKER_NORMAL_SKILL");
    expect(listed).not.toContain("MARKER_NAMED_ONLY");
    const block = seen.slice(seen.indexOf("<user_invoked_skills>"), seen.indexOf("</user_invoked_skills>"));
    expect(seen).toContain("只在用户点名时才用");
    expect(block).toContain("<name>named-only</name>");
    expect(block).toContain("MARKER_NAMED_ONLY");
    expect(block).toContain(path.join(named, "SKILL.md"));

    const plain = spawnTestAgent(daemon, { agentId: "contract-no-user-invoked", model: fauxModel([{ kind: "echo_context" }]), tools: ["read"], skillPaths: [normal] });
    await plain.log.next("ready");
    plain.agent.send({ type: "user_input", inputId: "in-1", text: "念一遍你看到的" });
    expect(textOf(await plain.log.next("message_final"))).not.toContain("user_invoked_skills");
  });

  it("yield 时模型已经不再调用工具（在写最后的回复）：照常结束（completed）；没有进行中的回合时 yield 什么都不做", async () => {
    const { daemon } = await startTestDaemon();
    const { agent, log } = spawnTestAgent(daemon, {
      agentId: "contract-yield-final",
      model: fauxModel([{ kind: "reply", text: "这是最后的回复，说得慢一点" }, { kind: "reply", text: "第二轮" }], { tokensPerSecond: 20 }),
      tools: [],
    });
    await log.next("ready");
    agent.send({ type: "yield" });
    agent.send({ type: "user_input", inputId: "in-1", text: "说一句" });
    await log.next("stream_delta");
    agent.send({ type: "yield" });
    expect((await log.next("turn_end")).outcome).toBe("completed");
    // 下一轮不受上一轮的 yield 影响
    agent.send({ type: "user_input", inputId: "in-2", text: "再说一句" });
    expect((await log.next("turn_end")).outcome).toBe("completed");
    expect(log.ofType("message_final").map((m) => textOf(m))).toEqual(["这是最后的回复，说得慢一点", "第二轮"]);
  });

  it("停下时还排着、没进上下文的插话不算收下（不列进 interjected，守护进程留着它们）；已经进了上下文的照常算收下", async () => {
    const { daemon } = await startTestDaemon();
    const { agent, log } = spawnTestAgent(daemon, {
      agentId: "contract-yield-interject",
      model: fauxModel([
        { kind: "reply", toolCalls: [{ name: "slow_step", arguments: { what: "第一步" } }] },
        { kind: "reply", toolCalls: [{ name: "slow_step", arguments: { what: "第二步" } }] },
      ]),
      tools: [],
      hostTools: [WAIT_TOOL],
    });
    await log.next("ready");
    agent.send({ type: "user_input", inputId: "in-1", text: "开始" });
    const firstCall = await log.next("host_tool_call");
    agent.send({ type: "interject", inputId: "in-2", text: "顺便看看第二部分" });
    agent.send({ type: "host_tool_result", requestId: firstCall.requestId, result: { text: "第一步好了", isError: false } });
    const secondCall = await log.next("host_tool_call");
    // 第一句插话已经在第二次模型调用之前进了上下文；第二句送来时要求停下
    agent.send({ type: "interject", inputId: "in-3", text: "再加一句" });
    agent.send({ type: "yield" });
    agent.send({ type: "host_tool_result", requestId: secondCall.requestId, result: { text: "第二步好了", isError: false } });
    const end = await log.next("turn_end");
    expect(end.outcome).toBe("yielded");
    expect(end.interjected).toEqual(["in-2"]);
  });
});
