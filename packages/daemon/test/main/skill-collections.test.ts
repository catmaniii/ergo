// 主切面：skill 库的集合、导入并改名、秘书用的 skill（72 号票）。都用自己造的假 skill、假集合，不碰真的第三方 skill。
// - 经 HTTP 导入：单个导入并改名、把一个目录作为集合整套导入（记下集合名、来源、版本），工具包目录里集合显示成一项；
//   同名冲突被拒、说清和谁重名；带依赖目录（假 node_modules）的按原路径引用，node_modules 是指向密钥区的联接的拒绝；
// - 秘书也能用 skill：默认装 agent-browser、yt-dlp（库里有的），设置里改了（只能选库里有的），下一轮按新名单装配；
//   名字带空格的照原样用；只在用户点名时才用的 skill（disable-model-invocation）另起一段写进系统提示；用户打 /skill:目录名
//   在加时间标记之前展开（82 号票起命令名是目录名，/目录名 的各种情况在 slash-commands.test.ts）；
// - 维护者用 adjust_skills 写集合名整套加上（工具包里记的是成员的 skill 名）。
import fs from "node:fs";
import path from "node:path";
import { CHANNELS, EVENT_TYPES, maintainerChannel, type MessageEventPayload, type ProjectEventPayload } from "@ergou/protocol";
import { describe, expect, it } from "vitest";
import { dataDirLayout } from "../../src/config/data-dir.ts";
import { startTestDaemon } from "../helpers/daemon.ts";
import { stripTimeMarkers } from "../helpers/echo.ts";
import { TestFrontend } from "../helpers/frontend.ts";
import { waitUntil } from "../helpers/process.ts";
import { call, eventually, messagesOf, say, textOf as messageText } from "../helpers/task-flow.ts";
import { makeTempDir } from "../helpers/temp-dir.ts";
import { seedToolkitProject, toolkit, toolkitApi, writeSkill } from "../helpers/toolkit.ts";

const SECRETARY = CHANNELS.secretary;
const PM1 = maintainerChannel("pm-1");

function write(file: string, content: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

/** 假集合（三个成员在 skills/ 下面，根目录有 docs）：fake-gamma 只在用户点名时才用 */
function fakeSet(root: string): string {
  write(path.join(root, "docs", "guide.md"), "指南\n");
  writeSkill(path.join(root, "skills", "fake-alpha"), "fake-alpha", "MARKER_FAKE_ALPHA");
  writeSkill(path.join(root, "skills", "fake-beta"), "fake-beta", "MARKER_FAKE_BETA");
  write(path.join(root, "skills", "fake-gamma", "SKILL.md"), "---\nname: fake-gamma\ndescription: MARKER_FAKE_GAMMA_USER_INVOKED\ndisable-model-invocation: true\n---\n\n点名才用。\n");
  write(path.join(root, "skills", "tdd", "SKILL.md"), "---\nname: tdd\ndescription: MARKER_FAKE_SET_TDD\n---\n");
  return root;
}

const FAKE_SET = { name: "fake-set", source: "假插件仓库的 fake-set/", version: "0.1.0", description: "假的方法论", skillsDir: "skills" };

const textOf = (payload: MessageEventPayload) => payload.message.parts.map((p) => (p.type === "text" ? p.text : "")).join("");

/** 秘书这一轮的回复（echo_context：它看到的上下文） */
async function secretaryEcho(frontend: TestFrontend, text: string): Promise<string> {
  await frontend.sendText(text);
  await frontend.next(SECRETARY, EVENT_TYPES.message);
  const reply = textOf((await frontend.next(SECRETARY, EVENT_TYPES.message)).payload as MessageEventPayload);
  await frontend.next(SECRETARY, EVENT_TYPES.turnEnd);
  return reply;
}

/** 生效的系统提示：最后一条系统消息（换了装配接着会话时 pi 在中途记一条） */
const latestSystem = (seen: string) => seen.slice(seen.lastIndexOf("[system]"));

describe("经 HTTP 导入：集合、导入并改名、依赖目录", () => {
  it("整套导入一个集合：记下集合名、来源、版本、说明，工具包目录里集合显示成一项、成员带着集合名；单个导入并改名；重名的被拒、说清和谁重名", async () => {
    const td = await startTestDaemon();
    const set = fakeSet(makeTempDir("ergou-src-"));
    const imported = await toolkitApi.importSkill(td.url, { path: set, collection: FAKE_SET });
    expect(imported).toMatchObject({
      status: 200,
      body: {
        collection: { name: "fake-set", source: "假插件仓库的 fake-set/", version: "0.1.0", description: "假的方法论", skills: ["fake-alpha", "fake-beta", "fake-gamma", "tdd"] },
        report: [
          { name: "fake-alpha", ok: true },
          { name: "fake-beta", ok: true },
          { name: "fake-gamma", ok: true },
          { name: "tdd", ok: true },
        ],
      },
    });
    const catalog = (await toolkitApi.catalog(td.url)).body;
    expect(catalog.collections).toEqual([imported.body.collection]);
    expect(catalog.skills.filter((s) => s.collection === "fake-set").map((s) => s.name)).toEqual(["fake-alpha", "fake-beta", "fake-gamma", "tdd"]);
    expect(fs.existsSync(path.join(dataDirLayout(td.dataDir).skills, "fake-set", "docs", "guide.md"))).toBe(true);

    // 另一个叫 tdd 的单个 skill：被拒，说清和集合里的 tdd 重名；导入并改名就行
    const other = writeSkill(path.join(makeTempDir("ergou-src-"), "tdd"), "tdd", "另一个 tdd");
    expect(await toolkitApi.importSkill(td.url, other)).toMatchObject({ status: 400, body: { message: expect.stringContaining("tdd 和集合 fake-set 里的 tdd 重名") } });
    expect(await toolkitApi.importSkill(td.url, { path: other, rename: "mp-tdd" })).toMatchObject({
      status: 200,
      body: { skills: [{ name: "mp-tdd", origin: "imported" }], report: [{ name: "mp-tdd", ok: true, note: "改名导入：原来叫 tdd" }] },
    });
    expect(fs.readFileSync(path.join(dataDirLayout(td.dataDir).skills, "mp-tdd", "SKILL.md"), "utf8")).toContain("name: mp-tdd\n");
    // 改的名不合规矩：请求就不对
    expect(await toolkitApi.importSkill(td.url, { path: other, rename: "MP_TDD" })).toMatchObject({ status: 400 });

    // 带假 node_modules 的 skill：依赖目录按原路径引用
    const withDeps = writeSkill(path.join(makeTempDir("ergou-src-"), "fake-browser"), "fake-browser", "带依赖的");
    write(path.join(withDeps, "node_modules", "dep", "index.js"), "MARKER_DEP\n");
    const linked = await toolkitApi.importSkill(td.url, withDeps);
    expect(linked).toMatchObject({ status: 200, body: { linked: [{ dir: "fake-browser/node_modules", target: fs.realpathSync.native(path.join(withDeps, "node_modules")) }] } });
    expect(fs.readFileSync(path.join(dataDirLayout(td.dataDir).skills, "fake-browser", "node_modules", "dep", "index.js"), "utf8")).toContain("MARKER_DEP");

    // node_modules 是指向数据目录密钥区的联接：拒绝，skill 区里没有它
    const secrets = dataDirLayout(td.dataDir).secrets;
    fs.mkdirSync(secrets, { recursive: true });
    const evil = writeSkill(path.join(makeTempDir("ergou-src-"), "evil-deps"), "evil-deps", "偷密钥的");
    fs.symlinkSync(secrets, path.join(evil, "node_modules"), "junction");
    expect(await toolkitApi.importSkill(td.url, evil)).toMatchObject({ status: 400, body: { message: expect.stringContaining("导入不跟链接") } });
    expect(fs.existsSync(path.join(dataDirLayout(td.dataDir).skills, "evil-deps"))).toBe(false);
  });
});

describe("秘书也能用 skill", () => {
  it("默认装 agent-browser、yt-dlp（库里有的）；设置里改了（只能选库里有的），下一轮按新名单装配；名字带空格的照原样用；点名才用的 skill 另起一段写进系统提示；用户打 /skill:目录名 在加时间标记之前展开", async () => {
    // 数据目录里先放好：秘书一启动就装配
    const dataDir = makeTempDir("ergou-data-");
    const homeDir = makeTempDir("ergou-home-");
    const skillsDir = dataDirLayout(dataDir).skills;
    writeSkill(path.join(skillsDir, "agent-browser"), "agent-browser", "MARKER_SECRETARY_AGENT_BROWSER");
    writeSkill(path.join(skillsDir, "yt-dlp"), "yt-dlp", "MARKER_SECRETARY_YT_DLP");
    writeSkill(path.join(skillsDir, "notes-style"), "notes-style", "MARKER_NOT_FOR_SECRETARY");
    // 名字写成显示名的（照 pstack 的 "Poteto Mode"）：照原样认
    fs.mkdirSync(path.join(skillsDir, "fancy-mode"), { recursive: true });
    fs.writeFileSync(path.join(skillsDir, "fancy-mode", "SKILL.md"), "---\nname: Fancy Mode\ndescription: MARKER_FANCY_MODE\n---\n\nMARKER_FANCY_BODY 照着做。\n");
    const td = await startTestDaemon({ reuse: { dataDir, homeDir }, secretary: [{ kind: "echo_context" }, { kind: "echo_context" }] });
    const frontend = await TestFrontend.connect(td.url);
    await frontend.subscribe({ [SECRETARY]: 0 });

    expect((await toolkitApi.secretarySkills(td.url)).body).toMatchObject({ skills: ["agent-browser", "yt-dlp"], isDefault: true });
    const first = await secretaryEcho(frontend, "你有什么 skill");
    expect(first).toContain("MARKER_SECRETARY_AGENT_BROWSER");
    expect(first).toContain("MARKER_SECRETARY_YT_DLP");
    expect(first).not.toContain("MARKER_NOT_FOR_SECRETARY");
    expect(first).not.toContain("user_invoked_skills");

    // 改：库里没有的不行；整套加一个集合里的两个（其中一个点名才用），去掉 agent-browser
    await toolkitApi.importSkill(td.url, { path: fakeSet(makeTempDir("ergou-src-")), collection: FAKE_SET });
    expect(await toolkitApi.setSecretarySkills(td.url, ["yt-dlp", "nope"])).toMatchObject({ status: 400, body: { message: expect.stringContaining("skill 库里没有 nope") } });
    const picked = ["yt-dlp", "fake-alpha", "fake-gamma", "Fancy Mode"];
    const changed = await toolkitApi.setSecretarySkills(td.url, picked);
    expect(changed).toMatchObject({ status: 200, body: { skills: picked, isDefault: false } });
    expect(changed.body.promptBytes).toBeGreaterThan(0);
    expect(JSON.parse(fs.readFileSync(dataDirLayout(dataDir).secretarySkillsFile, "utf8"))).toEqual({ format: 1, skills: picked });

    // 下一轮：按新名单重新装配，接着同一条主线会话
    const second = await secretaryEcho(frontend, "现在呢");
    expect(stripTimeMarkers(second)).toContain("[user] 你有什么 skill");
    const now = latestSystem(second);
    expect(now).toContain("MARKER_SECRETARY_YT_DLP");
    expect(now).toContain("MARKER_FAKE_ALPHA");
    expect(now).not.toContain("MARKER_SECRETARY_AGENT_BROWSER");
    expect(now).not.toContain("MARKER_FAKE_BETA");
    // 点名才用的不在 pi 的 skill 清单里，在另起的一段里（写明只在用户点名时用）
    expect(now).toContain("只在用户点名时才用");
    expect(now).toMatch(/<user_invoked_skills>[\s\S]*MARKER_FAKE_GAMMA_USER_INVOKED[\s\S]*<\/user_invoked_skills>/);
    // 名字带空格的：pi 照原样加载（只告警），清单里就是原来的名字
    expect(now).toContain("<name>Fancy Mode</name>");

    // 用户打 /skill:目录名（名字带空格的写目录名，82 号票）：守护进程先展开成 skill 的全文，再加时间标记交给秘书
    const third = await secretaryEcho(frontend, "/skill:fancy-mode 照这个做");
    const lastUser = third.slice(third.lastIndexOf("[user]"));
    expect(lastUser).toMatch(/^\[user\] \[\d{4}-\d{2}-\d{2} [^\]]*\]\n<skill name="Fancy Mode" location="[^"]*fancy-mode[\\/]SKILL\.md">/);
    expect(lastUser).toContain("MARKER_FANCY_BODY 照着做。\n</skill>\n\n照这个做");
  });
});

describe("维护者整套加一个集合", () => {
  it("adjust_skills 写集合名：工具包里加上它的全部成员（记的是 skill 名），重新装配后会话里都有", async () => {
    const td = await startTestDaemon({
      maintainer: (_id, spawn) => (spawn === 1 ? [call("adjust_skills", { add: ["fake-set"], why: "整套用这套方法论" }), say("不该走到这一步")] : [{ kind: "echo_context" }]),
    });
    await toolkitApi.importSkill(td.url, { path: fakeSet(makeTempDir("ergou-src-")), collection: FAKE_SET });
    seedToolkitProject(td.daemon, "方法论", toolkit());
    const frontend = await TestFrontend.connect(td.url);
    await frontend.subscribe({ [CHANNELS.projects]: 0, [PM1]: 0 });

    await frontend.sendText("把那套方法论整套加上", { conversation: PM1 });
    expect(
      await eventually(
        () => frontend.events({ channel: CHANNELS.projects, type: EVENT_TYPES.project }).map((f) => f.payload as ProjectEventPayload),
        (e) => e.change === "toolkit_changed",
        "项目的工具包变了",
      ),
    ).toMatchObject({ by: "maintainer", project: { toolkit: toolkit({ skills: ["fake-alpha", "fake-beta", "fake-gamma", "tdd"] }) } });
    await waitUntil(() => messagesOf(frontend, PM1).some((m) => m.message.speaker === "agent" && messageText(m).includes("MARKER_FAKE_ALPHA")), {
      timeoutMs: 30_000,
      describe: () => messagesOf(frontend, PM1).map((m) => `${m.message.speaker}: ${messageText(m).slice(0, 200)}`).join("\n"),
    });
    const seen = messagesOf(frontend, PM1).map(messageText).find((t) => t.includes("MARKER_FAKE_ALPHA"))!;
    const now = latestSystem(seen);
    expect(now).toContain("MARKER_FAKE_BETA");
    expect(now).toContain("MARKER_FAKE_SET_TDD");
    expect(now).toContain("MARKER_FAKE_GAMMA_USER_INVOKED");
    expect(seen).toContain("[toolResult] adjust_skills: 已改：加上 skill fake-alpha、skill fake-beta、skill fake-gamma、skill tdd");
  });
});
