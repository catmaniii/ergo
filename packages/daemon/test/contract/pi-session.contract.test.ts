// pi 契约测试（规格 Testing Decisions 切面 3，ADR-0001 的升级闸门）。
// 每条用例单独拉起一个 agent 子进程、接 faux provider，只验二狗依赖的 pi 行为。
// 升级 pi 之前先跑：npm run test:contract
//
// 守卫转发和插话的用例在 guard-and-interject.contract.test.ts。
// 后面的票往这里加用例：工具白名单与只注入指定 skill（27）、守卫接上之后按判定不执行的完整流程（07）、
// 压缩后注入（13）、用量（24）、压缩钩子与 appendEntry（18）、被杀后从会话文件恢复（23）……
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { fauxModel, spawnTestAgent, startTestDaemon } from "../helpers/daemon.ts";
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
});

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
