// 主切面：斜杠命令直接写 skill 的目录名（82 号票，用户 2026-10-10 定）。都用自己造的假 skill，不碰真的第三方 skill。
// - 秘书：/mp-tdd、/fancy-mode（名字是 "Fancy Mode"，命令是目录名）展开；/Fancy Mode 这种带空格的不认、原样交过去；
//   目录名相同时集合里的写 /集合名:目录名；和二狗自己的命令同名的 skill：/流程 仍是发起流程（不展开），/skill:流程 才是那个 skill；
//   不认识的 /nope 原样交过去；
// - 候选列表（GET 会话的 slash-commands）：秘书、项目的会话先列 /流程、/任务，再列这个会话能用的 skill（显示的名字照原样、集合名作小标，
//   和命令同名的写成 /skill:目录名）；任务的会话没有发起任务的命令，起草计划时也没有 skill，执行时是计划里的；没有的会话 404；
// - 维护者（项目的、任务的）的会话里一样在加时间标记之前展开。
import fs from "node:fs";
import path from "node:path";
import { CHANNELS, EVENT_TYPES, HTTP_PATHS, maintainerChannel, type SlashCommandList, type TaskEventPayload } from "@ergou/protocol";
import { describe, expect, it } from "vitest";
import { dataDirLayout } from "../../src/config/data-dir.ts";
import type { FauxStep } from "../../src/runtime/index.ts";
import { startTestDaemon } from "../helpers/daemon.ts";
import { TestFrontend } from "../helpers/frontend.ts";
import { requestJson } from "../helpers/http.ts";
import { submitPlanStep } from "../helpers/plans.ts";
import { waitUntil } from "../helpers/process.ts";
import { call, confirmPlan, draftTask, eventually, inputsDone, messagesOf, say, textOf, twoStagePlan } from "../helpers/task-flow.ts";
import { makeTempDir } from "../helpers/temp-dir.ts";
import { seedToolkitProject, toolkit, writeSkill } from "../helpers/toolkit.ts";

const SECRETARY = CHANNELS.secretary;
const PM1 = maintainerChannel("pm-1");
const TM1 = maintainerChannel("tm-1");
const echo: FauxStep = { kind: "echo_context" };

function write(file: string, content: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

/**
 * 数据目录的 skill 区里放好：mp-tdd、fancy-mode（名字 "Fancy Mode"）、tdd、流程（和 /流程 同名），
 * 一个集合 fake-set（成员目录也叫 tdd，名字 "Set TDD"）
 */
function seedSkills(dataDir: string): void {
  const skills = dataDirLayout(dataDir).skills;
  writeSkill(path.join(skills, "mp-tdd"), "mp-tdd", "MARKER_MP_TDD 测试驱动");
  write(path.join(skills, "fancy-mode", "SKILL.md"), "---\nname: Fancy Mode\ndescription: MARKER_FANCY 入口\n---\n\nMARKER_FANCY_BODY 照着做。\n");
  write(path.join(skills, "tdd", "SKILL.md"), "---\nname: tdd\ndescription: 单个导入的 tdd\n---\n\nMARKER_SINGLE_TDD_BODY\n");
  write(path.join(skills, "流程", "SKILL.md"), "---\nname: 流程\ndescription: 和命令同名的 skill\n---\n\nMARKER_FLOW_SKILL_BODY\n");
  const set = path.join(skills, "fake-set");
  write(path.join(set, "skills", "tdd", "SKILL.md"), "---\nname: Set TDD\ndescription: 集合里的 tdd\n---\n\nMARKER_SET_TDD_BODY\n");
  write(
    path.join(set, "ergou-collection.json"),
    JSON.stringify({ format: 1, name: "fake-set", source: "假的", version: "0.1.0", description: "假集合", members: ["skills/tdd"], importedFrom: "假的来源", importedAt: "2026-10-10T12:00:00.000+08:00" }),
  );
}

const slashCommands = (url: string, conversation: string) => requestJson<SlashCommandList & { message?: string }>(url, HTTP_PATHS.slashCommands(conversation));

/** 会话里 agent 的文字回复 */
const repliesOf = (frontend: TestFrontend, channel: string) =>
  messagesOf(frontend, channel)
    .filter((m) => m.message.speaker === "agent" && m.message.parts.some((p) => p.type === "text"))
    .map(textOf);

/** 用户在秘书那里说一句，等这一轮结束 */
async function tell(frontend: TestFrontend, text: string): Promise<void> {
  await frontend.sendText(text);
  await frontend.next(SECRETARY, EVENT_TYPES.turnEnd);
}

/**
 * echo_context 回显的上下文里用户说的各条消息（交给模型时的样子：时间标记 + 展开后的文字），到下一个发言方为止；
 * 运行时附上的（看板变化这类，没有时间标记）不算
 */
const userTurns = (seen: string): string[] =>
  seen
    .split(/^\[user\] /m)
    .slice(1)
    .map((t) => `[user] ${t.split(/^\[(?:assistant|toolResult|system)\]/m)[0]!.trimEnd()}`)
    .filter((t) => /^\[user\] \[\d{4}-\d{2}-\d{2} /.test(t));

async function nthReply(frontend: TestFrontend, channel: string, n: number): Promise<string> {
  await waitUntil(() => repliesOf(frontend, channel).length >= n, {
    timeoutMs: 30_000,
    describe: () => `等 ${channel} 的第 ${n} 条回复；会话里现在是：\n${messagesOf(frontend, channel).map((m) => `${m.message.speaker}: ${textOf(m).slice(0, 300)}`).join("\n")}`,
  });
  return repliesOf(frontend, channel)[n - 1]!;
}

const COMMANDS = [
  { kind: "command", text: "/流程", name: "流程", description: expect.stringContaining("发起一个流程") },
  { kind: "command", text: "/任务", name: "任务", description: expect.stringContaining("发起一个长程任务") },
];

describe("秘书：/目录名 直接展开 skill", () => {
  it("/mp-tdd、/fancy-mode 展开（显示的名字照原样）；带空格的 /Fancy Mode 不认；目录名相同的集合成员写 /fake-set:tdd；/流程 仍是发起流程，/skill:流程 才是同名的 skill；不认识的原样；候选列表", async () => {
    const dataDir = makeTempDir("ergou-data-");
    const homeDir = makeTempDir("ergou-home-");
    seedSkills(dataDir);
    write(dataDirLayout(dataDir).secretarySkillsFile, JSON.stringify({ format: 1, skills: ["mp-tdd", "Fancy Mode", "tdd", "Set TDD", "流程"] }));
    const startWorkflow = call("start_workflow", { title: "整理下载目录", summary: "把下载目录按类型整理好" });
    // 每轮只回一句（每轮都回显上下文的话上下文翻倍长、触发压缩），最后一轮回显：看前面每条用户消息交给模型时的样子
    const td = await startTestDaemon({ reuse: { dataDir, homeDir }, secretary: [...["一", "二", "三", "四", "五", "六"].map(say), startWorkflow, say("建好了"), echo] });
    const frontend = await TestFrontend.connect(td.url);
    await frontend.subscribe({ [SECRETARY]: 0, [CHANNELS.board]: 0 });

    // 候选：先是二狗自己的命令，再是 skill（按命令名排）；和 /流程 同名的写 /skill:流程；目录名相同的集合成员写集合名
    expect((await slashCommands(td.url, SECRETARY)).body).toEqual({
      commands: [
        ...COMMANDS,
        { kind: "skill", text: "/fake-set:tdd", name: "Set TDD", description: "集合里的 tdd", collection: "fake-set" },
        { kind: "skill", text: "/fancy-mode", name: "Fancy Mode", description: "MARKER_FANCY 入口" },
        { kind: "skill", text: "/mp-tdd", name: "mp-tdd", description: "MARKER_MP_TDD 测试驱动" },
        { kind: "skill", text: "/tdd", name: "tdd", description: "单个导入的 tdd" },
        { kind: "skill", text: "/skill:流程", name: "流程", description: "和命令同名的 skill" },
      ],
    });

    for (const text of ["/mp-tdd 帮我写测试", "/fancy-mode 看看这个设计", "/Fancy Mode 看看这个设计", "/tdd 一", "/fake-set:tdd 二", "/skill:流程 三", "/流程 把下载目录按类型整理好", "/nope 原样"]) {
      await tell(frontend, text);
    }
    const seen = repliesOf(frontend, SECRETARY).at(-1)!;
    const users = userTurns(seen);
    expect(users).toHaveLength(8);
    const [mpTdd, fancy, spaced, tdd, setTdd, flowSkill, launch, unknown] = users as [string, string, string, string, string, string, string, string];
    // 展开发生在加时间标记之前：时间标记 + skill 全文 + 其余的话
    expect(mpTdd).toMatch(/^\[user\] \[\d{4}-\d{2}-\d{2} [^\]]*\]\n<skill name="mp-tdd" location="[^"]*mp-tdd[\\/]SKILL\.md">/);
    expect(mpTdd).toMatch(/照着做。\n<\/skill>\n\n帮我写测试$/);
    // 名字带空格的写目录名；显示的名字照原样
    expect(fancy).toMatch(/<skill name="Fancy Mode" location="[^"]*fancy-mode[\\/]SKILL\.md">/);
    expect(fancy).toMatch(/MARKER_FANCY_BODY 照着做。\n<\/skill>\n\n看看这个设计$/);
    // 带空格的名字不认（命令名是 / 后面到第一个空白）：原样交过去
    expect(spaced).toMatch(/^\[user\] \[[^\]]*\]\n\/Fancy Mode 看看这个设计$/);
    // 目录名相同：单个导入的是 /tdd，集合里的是 /fake-set:tdd
    expect(tdd).toMatch(/MARKER_SINGLE_TDD_BODY\n<\/skill>\n\n一$/);
    expect(setTdd).toMatch(/MARKER_SET_TDD_BODY\n<\/skill>\n\n二$/);
    // 和二狗的命令同名：/skill:流程 是那个 skill
    expect(flowSkill).toMatch(/MARKER_FLOW_SKILL_BODY\n<\/skill>\n\n三$/);
    // /流程 仍是发起流程：不展开，秘书照样能建流程
    expect(launch).toMatch(/^\[user\] \[[^\]]*\]\n\/流程 把下载目录按类型整理好$/);
    expect(seen).toContain("[toolResult] start_workflow: 已建好流程 t-1「整理下载目录」");
    const created = await eventually(
      () => frontend.events({ channel: CHANNELS.board, type: EVENT_TYPES.task }).map((f) => f.payload as TaskEventPayload),
      (e) => e.change === "created",
      "建出的流程",
    );
    expect(created.task.kind).toBe("workflow");
    // 不认识的原样交过去，不报错
    expect(unknown).toMatch(/^\[user\] \[[^\]]*\]\n\/nope 原样$/);
  }, 60_000);
});

describe("维护者的会话", () => {
  it("项目：候选里有 /流程、/任务 和这一段工具包里的 skill；用户打 /fancy-mode 在加时间标记之前展开；没有的会话 404", async () => {
    const dataDir = makeTempDir("ergou-data-");
    const homeDir = makeTempDir("ergou-home-");
    seedSkills(dataDir);
    const td = await startTestDaemon({ reuse: { dataDir, homeDir }, maintainer: () => [echo] });
    seedToolkitProject(td.daemon, "设计", toolkit({ skills: ["mp-tdd", "Fancy Mode", "流程"] }));
    const frontend = await TestFrontend.connect(td.url);
    await frontend.subscribe({ [PM1]: 0 });

    // 项目的会话里有 /流程：同名的 skill 写 /skill:流程
    expect((await slashCommands(td.url, PM1)).body).toEqual({
      commands: [
        ...COMMANDS,
        { kind: "skill", text: "/fancy-mode", name: "Fancy Mode", description: "MARKER_FANCY 入口" },
        { kind: "skill", text: "/mp-tdd", name: "mp-tdd", description: "MARKER_MP_TDD 测试驱动" },
        { kind: "skill", text: "/skill:流程", name: "流程", description: "和命令同名的 skill" },
      ],
    });
    await frontend.sendText("/fancy-mode 看看这个设计", { conversation: PM1 });
    const seen = await nthReply(frontend, PM1, 1);
    const lastUser = seen.slice(seen.lastIndexOf("[user]"));
    expect(lastUser).toMatch(/^\[user\] \[[^\]]*\]\n<skill name="Fancy Mode" location="[^"]*fancy-mode[\\/]SKILL\.md">/);
    expect(lastUser).toContain("MARKER_FANCY_BODY 照着做。\n</skill>\n\n看看这个设计");

    expect(await slashCommands(td.url, maintainerChannel("nobody"))).toMatchObject({ status: 404 });
    expect(await slashCommands(td.url, "board")).toMatchObject({ status: 404 });
  }, 60_000);

  it("任务：没有发起任务的命令；起草计划时没有 skill，执行时是计划里的；用户打 /mp-tdd 展开；没有 /流程 命令，同名的 skill 直接 /流程 就展开（候选里也写 /流程）", async () => {
    const dataDir = makeTempDir("ergou-data-");
    const homeDir = makeTempDir("ergou-home-");
    seedSkills(dataDir);
    const plan = twoStagePlan({ toolkit: toolkit({ skills: ["mp-tdd", "流程"] }) });
    const td = await startTestDaemon({
      reuse: { dataDir, homeDir },
      maintainer: (_id, spawn) => (spawn === 1 ? [submitPlanStep(plan), say("计划交上去了")] : [say("开始做"), say("好"), echo]),
    });
    const frontend = await TestFrontend.connect(td.url);
    await frontend.subscribe(Object.fromEntries([CHANNELS.board, CHANNELS.cards, CHANNELS.inbox, TM1].map((c) => [c, 0])));
    const draft = await draftTask(td, frontend, "写测试");
    // 起草计划时：没有命令（任务的会话里不能发起任务），也没有 skill
    expect((await slashCommands(td.url, TM1)).body).toEqual({ commands: [] });
    await inputsDone(frontend, TM1);
    await confirmPlan(frontend, draft);
    await eventually(() => repliesOf(frontend, TM1), (r) => r === "开始做", "维护者开始做");
    // 执行时：计划里的 skill；任务的会话里没有 /流程 命令，同名的 skill 写 /流程
    expect((await slashCommands(td.url, TM1)).body).toEqual({
      commands: [
        { kind: "skill", text: "/mp-tdd", name: "mp-tdd", description: "MARKER_MP_TDD 测试驱动" },
        { kind: "skill", text: "/流程", name: "流程", description: "和命令同名的 skill" },
      ],
    });
    await frontend.sendText("/mp-tdd 照着做", { conversation: TM1 });
    await nthReply(frontend, TM1, 3);
    await frontend.sendText("/流程 也照着做", { conversation: TM1 });
    const users = userTurns(await nthReply(frontend, TM1, 4));
    const [mpTdd, flow] = users.slice(-2) as [string, string];
    expect(mpTdd).toMatch(/^\[user\] \[[^\]]*\]\n<skill name="mp-tdd" location="[^"]*mp-tdd[\\/]SKILL\.md">/);
    expect(mpTdd).toMatch(/照着做。\n<\/skill>\n\n照着做$/);
    // 和展开一致：同名的 skill 直接展开
    expect(flow).toMatch(/^\[user\] \[[^\]]*\]\n<skill name="流程" location="[^"]*流程[\\/]SKILL\.md">/);
    expect(flow).toMatch(/MARKER_FLOW_SKILL_BODY\n<\/skill>\n\n也照着做$/);
  }, 60_000);
});
