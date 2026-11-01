// skill 变更（358 号票）的单元测试：真的 skill 库、卡片、待办、事件存储，假的只有项目、任务的查询和工具包。
// - 工具 request_skill_change：只校验、出卡，skill 区一个字节都不变；校验不过（没 SKILL.md、带链接、超大、重名、路径在工作目录外、经目录联接绕出去）
//   当场回明确原因、不出卡；校验和真导入是同一段逻辑；
// - 卡上：名字、说明、谁提的、文件清单和大小、脚本数、SKILL.md 全文；带 .env、私钥的不进 skill 区，列出来；
// - 批准：复制进 skill 区、自检、配进提交人的工具包、会话重新拉起；拒绝一个字节都不变；两种决定都记 skill_decided 和时间线；
// - 确认前来源改了（也包括复制的那一刻才变）：不进库，写明原因，要重新提交；
// - 改：旧版留在 .history/，失败旧版不动；框架自带的、集合成员拒绝；名字不能变；
// - 删：卡上列出在用的工具包，删后名字留着、装配时跳过。
// 端到端的（假模型走通闭环、守卫挡直接写、Claude Code）在主切面 test/main/skill-change.test.ts。
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { nowIso, type PlanToolkit, type Project, SKILL_CHANGE_FILES_SHOWN, type SkillChangeCardPayload, type SkillChangeSubmitter, type SkillDecidedPayload, type Task } from "@ergo/protocol";
import { describe, expect, it, onTestFinished } from "vitest";
import { createCardService } from "../../src/cards/cards.ts";
import { CardTypeRegistry } from "../../src/cards/registry.ts";
import { cardsView } from "../../src/cards/views.ts";
import { RequestRejected } from "../../src/errors.ts";
import { createEphemeralBus } from "../../src/events/ephemeral.ts";
import { protectedAreasOf } from "../../src/guard/index.ts";
import { openEventStore } from "../../src/events/event-store.ts";
import { createInboxService } from "../../src/inbox/inbox.ts";
import { inboxView } from "../../src/inbox/views.ts";
import { createSkillChangeService, skillChangeCardType, type SkillChangeTarget } from "../../src/skills/change.ts";
import { createSkillLibrary, HISTORY_DIR, IMPORT_MAX_BYTES, SUBMISSION_FILE } from "../../src/skills/library.ts";
import { skillDecisionPurge, skillDecisionSource } from "../../src/skills/material-source.ts";
import { makeTempDir } from "../helpers/temp-dir.ts";
import { writeSkill } from "../helpers/toolkit.ts";

/** 一个目录树的全部内容（相对路径 → 内容的哈希）：比"一个字节都不变"用 */
function treeOf(root: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (dir: string, rel: string) => {
    if (!fs.existsSync(dir)) return;
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const relPath = rel ? `${rel}/${e.name}` : e.name;
      const abs = path.join(dir, e.name);
      if (e.isSymbolicLink()) out[relPath] = `link:${fs.readlinkSync(abs)}`;
      else if (e.isDirectory()) walk(abs, relPath);
      else out[relPath] = createHash("sha256").update(fs.readFileSync(abs)).digest("hex");
    }
  };
  walk(root, "");
  return out;
}

const PROJECT: Partial<Project> = { id: "p-1", name: "记账本", maintainerId: "pm-1", state: "in_use", charterConfirmed: true, toolkit: { skills: [], mcp: [], bash: false, network: false } };
const projectTarget: SkillChangeTarget = { kind: "project", projectId: "p-1", maintainerId: "pm-1" };
const taskTarget: SkillChangeTarget = { kind: "task", taskId: "t-1", maintainerId: "tm-1" };

interface Options {
  /** 库里 find 换掉（试自检没过） */
  findNothing?: boolean;
  /** 目录改名换掉（试换的时候失败） */
  renameDir?: (from: string, to: string) => void;
  /** 配进工具包时抛这个错 */
  toolkitRefuses?: string;
  /** 现在的时间（试复制的那一刻来源才变） */
  now?: () => string;
}

function setup(opts: Options = {}) {
  const dataDir = makeTempDir("ergo-skill-data-");
  const builtinDir = makeTempDir("ergo-skill-builtin-");
  const userDir = path.join(dataDir, "skills");
  // 工作目录、项目档案在数据目录里（默认的就是这样），另一个工作目录在外面（绑定的外部路径）
  const workdir = path.join(dataDir, "projects", "p-1", "work");
  const records = path.join(dataDir, "projects", "p-1", "records");
  const taskDir = makeTempDir("ergo-skill-task-");
  fs.mkdirSync(workdir, { recursive: true });
  fs.mkdirSync(records, { recursive: true });
  const outside = makeTempDir("ergo-skill-outside-");
  writeSkill(path.join(builtinDir, "framework-one"), "framework-one", "框架自带的");
  const logs: string[] = [];
  const now = opts.now ?? nowIso;
  const skills = createSkillLibrary({ builtinDir, userDir, dataDir, now, ...(opts.renameDir ? { renameDir: opts.renameDir } : {}), log: (l) => logs.push(l) });
  const store = openEventStore({ file: path.join(makeTempDir("ergo-skill-db-"), "ergo.db"), views: [cardsView, inboxView] });
  onTestFinished(() => store.close());
  const registry = new CardTypeRegistry();
  const cards = createCardService({ store, registry, now: nowIso });
  const inbox = createInboxService({ store, notifications: createEphemeralBus(), now: nowIso });
  const added: { submitter: SkillChangeSubmitter; name: string }[] = [];
  const changed: { maintainerIds: readonly string[]; assistant: boolean; name: string }[] = [];
  const toolkits = { projects: new Map<string, PlanToolkit>(), tasks: new Map<string, PlanToolkit>() };
  const projects: Partial<Project>[] = [PROJECT];
  const tasks: Partial<Task>[] = [];
  let assistantSkills: string[] = [];
  const service = createSkillChangeService({
    store,
    cards,
    inbox,
    skills: opts.findNothing ? { ...skills, find: () => [] } : skills,
    projectOf: (id) => (id === "p-1" ? { id, name: "记账本" } : undefined),
    taskOf: (id) => (id === "t-1" ? { id, title: "整理发票", maintainerId: "tm-1", projectId: "p-1", projectName: "记账本" } : undefined),
    sourceRoots: (submitter) => (submitter.kind === "project" ? [workdir, records] : [taskDir]),
    addToToolkit: (submitter, name) => {
      if (opts.toolkitRefuses) throw new RequestRejected("not_allowed", opts.toolkitRefuses);
      added.push({ submitter, name });
      return { changed: false, events: [] };
    },
    listProjects: () => projects as Project[],
    listTasks: () => tasks as Task[],
    taskToolkit: (id) => toolkits.tasks.get(id),
    assistantUses: (name) => assistantSkills.includes(name),
    skillChanged: (change) => changed.push(change),
    now: nowIso,
    log: (l) => logs.push(l),
  });
  registry.register(skillChangeCardType(service));
  const run = async (target: SkillChangeTarget, args: Record<string, unknown>) => service.requestTool(target).run(args as never, { toolCallId: "call-1" });
  const latestCards = () => {
    const byId = new Map<string, { id: string; type: string; payload: SkillChangeCardPayload; status: string; version: number; text: string; outcome?: { note?: string } }>();
    for (const event of store.read("cards", 0)) byId.set((event.payload as { card: { id: string } }).card.id, (event.payload as { card: never }).card);
    return [...byId.values()].filter((c) => c.type === "skill_change");
  };
  const act = (cardId: string, action: "approve" | "deny", note?: string) => {
    const card = cards.get(cardId)!;
    return cards.act({ cardId, action, expectedVersion: card.version, idempotencyKey: `k-${action}-${cardId}`, ...(note === undefined ? {} : { note }) });
  };
  const decided = () => store.read("skills", 0).map((e) => e.payload as SkillDecidedPayload);
  const timeline = (channel: string) => store.read(channel, 0).filter((e) => e.type === "timeline_record").map((e) => (e.payload as { record: { kind: string; summary: string; detail?: string } }).record);
  const notices = (channel: string) => store.read(channel, 0).filter((e) => e.type === "message").map((e) => JSON.stringify(e.payload));
  return {
    service, skills, store, cards, inbox, run, act, latestCards, decided, timeline, notices, logs, added, changed, projects, tasks, toolkits,
    setAssistant: (names: string[]) => { assistantSkills = names; },
    dataDir, userDir, builtinDir, workdir, records, taskDir, outside,
  };
}

/** 在工作目录里写一个 skill（多带一个脚本、一个普通文件） */
function writeWorkSkill(dir: string, name = "notes-style", description = "写笔记的规矩") {
  writeSkill(dir, name, description);
  fs.writeFileSync(path.join(dir, "guide.md"), "# 细则\n");
  return dir;
}

describe("request_skill_change：校验不过当场回原因、不出卡", () => {
  it("没 SKILL.md、没 frontmatter、没说明、带链接、超大、重名、路径在工作目录外、经目录联接绕出去：明确原因，不出卡，skill 区不变", async () => {
    const s = setup();
    writeSkill(path.join(s.userDir, "imported-one"), "imported-one", "用户导入的");
    fs.mkdirSync(path.join(s.userDir, "a-collection", "m1"), { recursive: true });
    writeSkill(path.join(s.userDir, "a-collection", "m1"), "member-one", "集合成员");
    fs.writeFileSync(path.join(s.userDir, "a-collection", "ergo-collection.json"), JSON.stringify({ format: 1, name: "a-collection", source: "x", version: "1", description: "d", members: ["m1"], importedFrom: "x", importedAt: nowIso() }));
    const before = treeOf(s.userDir);
    const at = (name: string) => path.join(s.workdir, "src", name);

    fs.mkdirSync(at("empty"), { recursive: true });
    fs.mkdirSync(at("no-front"), { recursive: true });
    fs.writeFileSync(path.join(at("no-front"), "SKILL.md"), "# 没有 frontmatter\n");
    fs.mkdirSync(at("no-desc"), { recursive: true });
    fs.writeFileSync(path.join(at("no-desc"), "SKILL.md"), "---\nname: no-desc\n---\n");
    // 带目录联接（指到外面的密钥目录）
    writeWorkSkill(at("with-link"), "with-link");
    fs.symlinkSync(s.outside, path.join(at("with-link"), "secrets"), "junction");
    // 超大：复制的部分超过上限（稀疏的，不真的占地方）
    writeWorkSkill(at("too-big"), "too-big");
    const huge = fs.openSync(path.join(at("too-big"), "blob.bin"), "w");
    fs.ftruncateSync(huge, IMPORT_MAX_BYTES + 1);
    fs.closeSync(huge);
    // 重名：框架自带的、用户导入的、集合成员
    writeWorkSkill(at("dup-framework"), "framework-one");
    writeWorkSkill(at("dup-imported"), "imported-one");
    writeWorkSkill(at("dup-member"), "member-one");
    // 目录名和已有的撞了（名字不重）
    writeWorkSkill(at("imported-one"), "other-name");
    // 工作目录外
    writeWorkSkill(path.join(s.outside, "out-skill"), "out-skill");
    // 目录联接本身当来源、路径上一层是目录联接绕到外面
    writeWorkSkill(path.join(s.outside, "via-link"), "via-link");
    fs.symlinkSync(path.join(s.outside, "via-link"), at("self-link"), "junction");
    fs.symlinkSync(s.outside, at("door"), "junction");

    const cases: [string, Record<string, unknown>, RegExp][] = [
      ["没写 path", { action: "add" }, /path/],
      ["改没写 name", { action: "update", path: at("empty") }, /name/],
      ["删没写 name", { action: "remove" }, /name/],
      ["目录不在", { action: "add", path: at("nope") }, /找不到这个目录/],
      ["没 SKILL.md", { action: "add", path: at("empty") }, /没有 SKILL\.md/],
      ["没 frontmatter", { action: "add", path: at("no-front") }, /frontmatter/],
      ["没说明", { action: "add", path: at("no-desc") }, /description/],
      ["带链接", { action: "add", path: at("with-link") }, /链接|联接/],
      ["超大", { action: "add", path: at("too-big") }, /太大|超过|上限/],
      ["和框架自带的重名", { action: "add", path: at("dup-framework") }, /框架自带的 framework-one/],
      ["和导入的重名", { action: "add", path: at("dup-imported") }, /imported-one/],
      ["和集合成员重名", { action: "add", path: at("dup-member") }, /a-collection/],
      ["目录名撞了", { action: "add", path: at("imported-one") }, /imported-one/],
      ["工作目录外", { action: "add", path: path.join(s.outside, "out-skill") }, /只能是你自己的工作目录或项目档案/],
      ["工作目录本身", { action: "add", path: s.workdir }, /子目录/],
      ["来源本身是目录联接", { action: "add", path: at("self-link") }, /符号链接或目录联接/],
      ["经目录联接绕出去", { action: "add", path: path.join(at("door"), "via-link") }, /只能是你自己的工作目录或项目档案/],
      ["skill 区自己的（在别人的工作目录外）", { action: "add", path: path.join(s.userDir, "imported-one") }, /只能是你自己的工作目录或项目档案/],
    ];
    for (const [why, args, message] of cases) {
      const result = await s.run(projectTarget, args);
      expect({ why, isError: result.isError, text: result.text }).toMatchObject({ why, isError: true, text: expect.stringMatching(message) });
      expect({ why, cards: s.latestCards().length }).toEqual({ why, cards: 0 });
    }
    expect(treeOf(s.userDir)).toEqual(before);
    // 导入（用户走设置页）和提交是同一段校验：同一个带链接的来源、同一个重名的来源，说法一样
    expect(() => s.skills.importFrom({ path: writeWorkSkill(path.join(s.outside, "dup-imported"), "imported-one") })).toThrow(/imported-one/);
  });

  it("相对路径按工作目录解析；写了 name 要和 SKILL.md 一样；同名的上一张卡还在等就不再出", async () => {
    const s = setup();
    writeWorkSkill(path.join(s.workdir, "src", "notes-style"));
    const mismatch = await s.run(projectTarget, { action: "add", name: "another", path: "src/notes-style" });
    expect(mismatch).toMatchObject({ isError: true, text: expect.stringMatching(/another.*notes-style/) });
    const first = await s.run(projectTarget, { action: "add", path: "src/notes-style" });
    expect(first.isError).toBeFalsy();
    const again = await s.run(projectTarget, { action: "add", path: "src/notes-style" });
    expect(again).toMatchObject({ isError: true, text: expect.stringContaining("还在等用户") });
    expect(s.latestCards()).toHaveLength(1);
  });
});

describe("卡上给用户看的", () => {
  it("名字、说明、谁提的、文件清单和大小、脚本数、SKILL.md 全文；没脚本的写 0；进库之前 skill 区一个字节都不变", async () => {
    const s = setup();
    const plain = writeWorkSkill(path.join(s.records, "plain-skill"), "plain-skill", "没有脚本的");
    const scripted = writeWorkSkill(path.join(s.workdir, "scripted"), "scripted", "带脚本的");
    fs.mkdirSync(path.join(scripted, "bin"));
    fs.writeFileSync(path.join(scripted, "bin", "run.py"), "print('x')\n");
    fs.writeFileSync(path.join(scripted, "bin", "no-extension"), "#!/bin/sh\necho x\n");
    const before = treeOf(s.userDir);

    const none = await s.run(projectTarget, { action: "add", path: plain, why: "别的项目也要记笔记" });
    expect(none.cardIds).toHaveLength(1);
    const [card] = s.latestCards();
    expect(card!.payload).toMatchObject({
      action: "add",
      name: "plain-skill",
      description: "没有脚本的",
      why: "别的项目也要记笔记",
      submitter: { kind: "project", projectId: "p-1", projectName: "记账本", maintainerId: "pm-1" },
      source: { dirName: "plain-skill", fileCount: 2, scriptCount: 0, excluded: [], linked: [], files: [{ path: "guide.md", bytes: 9 }, { path: "SKILL.md" }] },
    });
    expect(card!.payload.source!.skillMd).toContain("name: plain-skill");
    expect(card!.payload.source!.fingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(card!.text).not.toContain("个脚本");
    // 待办里有一条
    expect(s.inbox.list().filter((i) => i.kind === "card" && i.cardId === card!.id)).toHaveLength(1);

    await s.run(taskTarget, { action: "add", path: (() => {
      const copy = path.join(s.taskDir, "scripted");
      fs.cpSync(scripted, copy, { recursive: true });
      return copy;
    })() });
    const second = s.latestCards().find((c) => c.payload.name === "scripted")!;
    // 脚本（扩展名、开头 #! 的都算）排在清单前面，纯文本里醒目写明
    expect(second.payload.source).toMatchObject({ scriptCount: 2, fileCount: 4, files: [{ path: "bin/no-extension", script: true }, { path: "bin/run.py", script: true }, { path: "guide.md" }, { path: "SKILL.md" }] });
    expect(second.payload.submitter).toMatchObject({ kind: "task", taskId: "t-1", taskTitle: "整理发票", projectName: "记账本" });
    expect(second.text).toContain("里面有 2 个脚本，用它的 agent 可能会运行");
    expect(second.text).toContain("项目「记账本」里任务「整理发票」的负责人");
    // 只校验、出卡：skill 区一个字节都没变
    expect(treeOf(s.userDir)).toEqual(before);
  });

  it("带 .env、私钥、隐藏目录的来源：不进 skill 区，卡上和报告里列出来；来源里伪造的提交记录也不带", async () => {
    const s = setup();
    const dir = writeWorkSkill(path.join(s.workdir, "with-secret"), "with-secret");
    fs.writeFileSync(path.join(dir, ".env"), "TOKEN=sk-不能带走\n");
    fs.writeFileSync(path.join(dir, "deploy.pem"), "PRIVATE\n");
    fs.writeFileSync(path.join(dir, "old.key"), "PRIVATE\n");
    fs.mkdirSync(path.join(dir, ".git"));
    fs.writeFileSync(path.join(dir, ".git", "config"), "x");
    fs.writeFileSync(path.join(dir, SUBMISSION_FILE), JSON.stringify({ kind: "project", title: "伪造的", at: "x" }));
    await s.run(projectTarget, { action: "add", path: dir });
    const [card] = s.latestCards();
    expect(card!.payload.source!.excluded).toEqual([".env", ".ergo-submission.json", ".git/", "deploy.pem", "old.key"].toSorted());
    expect(card!.text).toContain("没带进来");
    await s.act(card!.id, "approve");
    const copied = treeOf(path.join(s.userDir, "with-secret"));
    expect(Object.keys(copied).toSorted()).toEqual([SUBMISSION_FILE, "SKILL.md", "guide.md"].toSorted());
    expect(JSON.stringify(s.store.read("cards", 0))).not.toContain("sk-不能带走");
    expect(s.skills.list().find((e) => e.name === "with-secret")?.submittedBy).toMatchObject({ kind: "project", title: "记账本" });
  });
});

describe("卡上的量和守卫", () => {
  it("文件多的：清单只列前 200 行（脚本排前面），数字是全部的；SKILL.md 到上限内都带全文", async () => {
    const s = setup();
    const dir = writeWorkSkill(path.join(s.workdir, "many"), "many-files");
    fs.mkdirSync(path.join(dir, "data"));
    for (let i = 0; i < 205; i += 1) fs.writeFileSync(path.join(dir, "data", `n${String(i).padStart(3, "0")}.txt`), "x");
    fs.writeFileSync(path.join(dir, "zz-last.sh"), "echo x\n");
    const long = `---\nname: many-files\ndescription: 多\n---\n\n${"正文".repeat(60_000)}\n`;
    fs.writeFileSync(path.join(dir, "SKILL.md"), long);
    await s.run(projectTarget, { action: "add", path: dir });
    const { source } = s.latestCards()[0]!.payload;
    expect(source).toMatchObject({ fileCount: 208, scriptCount: 1 });
    expect(source!.files).toHaveLength(SKILL_CHANGE_FILES_SHOWN);
    expect(source!.files[0]).toMatchObject({ path: "zz-last.sh", script: true });
    expect(source!.skillMd).toBe(long);
  });

  it("skill 区是受保护区域（写入一律永不）；不给 skill 区的和原来一样", () => {
    const dataDir = { root: "D:\\d", config: "D:\\d\\config", secrets: "D:\\d\\secrets", db: "D:\\d\\db", projects: "D:\\d\\projects" };
    expect(protectedAreasOf({ dataDir, programDir: "D:\\p" }).map((a) => a.dir)).toEqual([dataDir.config, dataDir.secrets, dataDir.db, "D:\\p"]);
    const withSkills = protectedAreasOf({ dataDir: { ...dataDir, skills: "D:\\d\\skills" }, programDir: "D:\\p" });
    expect(withSkills.find((a) => a.dir === "D:\\d\\skills")).toMatchObject({ secrets: false, title: "skill 区" });
  });
});

describe("批准、拒绝", () => {
  it("批准：复制进 skill 区，自检，配进提交人的工具包，会话重新拉起；结果写进卡和时间线；审批决定是素材；来源之后再变不影响库里的", async () => {
    const s = setup();
    const dir = writeWorkSkill(path.join(s.workdir, "My Notes"), "notes-style");
    await s.run(projectTarget, { action: "add", path: dir, why: "沉淀下来" });
    const [card] = s.latestCards();
    await s.act(card!.id, "approve", "可以");
    // 目录名规范过（斜杠命令），SKILL.md 一字不动
    const target = path.join(s.userDir, "my-notes");
    expect(fs.readFileSync(path.join(target, "SKILL.md"), "utf8")).toBe(fs.readFileSync(path.join(dir, "SKILL.md"), "utf8"));
    expect(s.skills.list().find((e) => e.name === "notes-style")).toMatchObject({ description: "写笔记的规矩", origin: "imported", submittedBy: { kind: "project", title: "记账本" } });
    const updated = s.cards.get(card!.id)!;
    expect(updated.status).toBe("handled");
    expect(updated.payload).toMatchObject({ applied: true, addedToToolkit: true, check: { ok: true } });
    expect(updated.outcome?.note).toMatch(/进库了/);
    expect(updated.text).toContain("已配进提交人的工具包");
    expect(updated.text).toContain("自检通过");
    expect(s.added).toMatchObject([{ name: "notes-style", submitter: { kind: "project", projectId: "p-1" } }]);
    // 工具包没变（测试里假的 changed: false）：这里叫重新拉起
    expect(s.changed).toEqual([{ maintainerIds: ["pm-1"], assistant: false, name: "notes-style" }]);
    expect(s.timeline("maintainer:pm-1")).toMatchObject([{ kind: "skill", summary: expect.stringContaining("项目「记账本」的负责人") }]);
    expect(s.timeline("maintainer:pm-1")[0]!.summary).toContain("自检通过");
    const [event] = s.decided();
    expect(event).toMatchObject({ decision: "approved", action: "add", name: "notes-style", cardId: card!.id, note: "可以", applied: true, check: { ok: true }, submitter: { kind: "project", projectId: "p-1" } });
    expect(s.notices("maintainer:pm-1").join("\n")).toContain("用户批准了你的 skill 变更");
    // 素材：审批决定，带用户那句话；彻底删除只换用户写的话
    const [draft] = skillDecisionSource.capture({ payload: event } as never) as { context: string[]; segments?: unknown }[];
    expect(draft!.context).toEqual(["decision:approved", "card:skill_change"]);
    expect((skillDecisionPurge.rewrite({ payload: event } as never, {} as never) as SkillDecidedPayload).note).not.toBe("可以");
    // 来源之后再变：库里的不跟着变
    fs.writeFileSync(path.join(dir, "SKILL.md"), "---\nname: notes-style\ndescription: 改了\n---\n");
    expect(s.skills.find(["notes-style"])[0]!.entry.description).toBe("写笔记的规矩");
    // 再加同名的就是重名了
    const dup = await s.run(projectTarget, { action: "add", path: dir });
    expect(dup).toMatchObject({ isError: true, text: expect.stringContaining("notes-style") });
  });

  it("拒绝：一个字节都不变，记了决定和时间线，通知负责人", async () => {
    const s = setup();
    const dir = writeWorkSkill(path.join(s.workdir, "denied"), "denied-skill");
    await s.run(projectTarget, { action: "add", path: dir });
    const before = treeOf(s.dataDir);
    const [card] = s.latestCards();
    await s.act(card!.id, "deny", "先不要");
    expect(treeOf(s.dataDir)).toEqual(before);
    expect(s.skills.missing(["denied-skill"])).toEqual(["denied-skill"]);
    expect(s.decided()).toMatchObject([{ decision: "denied", action: "add", name: "denied-skill", cardId: card!.id, note: "先不要", applied: false }]);
    expect(s.timeline("maintainer:pm-1")[0]!.summary).toContain("拒绝了");
    expect(s.notices("maintainer:pm-1").join("\n")).toContain("用户拒绝了你提的 skill 变更");
    expect(s.added).toEqual([]);
    expect(s.changed).toEqual([]);
  });

  it("确认前来源改了：不进库，卡上写明要重新提交，skill 区不变，负责人接到通知；重新提交之后能进", async () => {
    const s = setup();
    const dir = writeWorkSkill(path.join(s.workdir, "changing"), "changing-skill");
    await s.run(projectTarget, { action: "add", path: dir });
    const [card] = s.latestCards();
    fs.appendFileSync(path.join(dir, "guide.md"), "提交之后偷偷改的\n");
    const before = treeOf(s.userDir);
    await s.act(card!.id, "approve");
    expect(treeOf(s.userDir)).toEqual(before);
    const updated = s.cards.get(card!.id)!;
    expect(updated.status).toBe("handled");
    expect(updated.payload).toMatchObject({ applied: false, problem: expect.stringContaining("重新提交") });
    expect(updated.outcome?.note).toMatch(/没改成/);
    expect(s.decided()).toMatchObject([{ decision: "approved", applied: false, problem: expect.stringContaining("变了") }]);
    expect(s.timeline("maintainer:pm-1")[0]!.summary).toContain("没改成");
    expect(s.notices("maintainer:pm-1").join("\n")).toContain("重新提交");
    expect(s.added).toEqual([]);
    // 重新提交一张就好了
    await s.run(projectTarget, { action: "add", path: dir });
    const fresh = s.latestCards().find((c) => c.status === "pending")!;
    await s.act(fresh.id, "approve");
    expect(s.skills.find(["changing-skill"])).toHaveLength(1);
  });

  it("来源多了个文件、少了个文件、来源被删了也一样不进库", async () => {
    for (const change of [
      (dir: string) => fs.writeFileSync(path.join(dir, "new.md"), "多的"),
      (dir: string) => fs.rmSync(path.join(dir, "guide.md")),
      (dir: string) => fs.rmSync(dir, { recursive: true }),
    ]) {
      const s = setup();
      const dir = writeWorkSkill(path.join(s.workdir, "changing"), "changing-skill");
      await s.run(projectTarget, { action: "add", path: dir });
      const [card] = s.latestCards();
      change(dir);
      await s.act(card!.id, "approve");
      expect(s.cards.get(card!.id)!.payload).toMatchObject({ applied: false });
      expect(treeOf(s.userDir)).toEqual({});
    }
  });

  it("复制的那一刻来源才变：真要进库的那一份也核了指纹，挡住，不留半个", async () => {
    let armed: (() => void) | undefined;
    const s = setup({
      now: () => {
        armed?.();
        armed = undefined;
        return nowIso();
      },
    });
    const dir = writeWorkSkill(path.join(s.workdir, "racing"), "racing-skill");
    await s.run(projectTarget, { action: "add", path: dir });
    const [card] = s.latestCards();
    // applySubmission 核完指纹之后取时间：这时候改来源，等于复制之前那一刻变了
    armed = () => fs.appendFileSync(path.join(dir, "guide.md"), "抢在复制之前改的\n");
    await s.act(card!.id, "approve");
    expect(s.cards.get(card!.id)!.payload).toMatchObject({ applied: false, problem: expect.stringContaining("变了") });
    expect(treeOf(s.userDir)).toEqual({});
  });

  it("进库了但没配进工具包（项目归档了）：skill 留着，卡上写明；自检对不上不回滚，卡上写明、不配进工具包", async () => {
    const refused = setup({ toolkitRefuses: "项目已归档" });
    await refused.run(projectTarget, { action: "add", path: writeWorkSkill(path.join(refused.workdir, "s1"), "s-one") });
    const [card] = refused.latestCards();
    await refused.act(card!.id, "approve");
    expect(refused.skills.find(["s-one"])).toHaveLength(1);
    expect(refused.cards.get(card!.id)!.payload).toMatchObject({ applied: true, addedToToolkit: false, toolkitProblem: "项目已归档" });
    expect(refused.cards.get(card!.id)!.text).toContain("没配进提交人的工具包");

    const blind = setup({ findNothing: true });
    await blind.run(projectTarget, { action: "add", path: writeWorkSkill(path.join(blind.workdir, "s2"), "s-two") });
    const [second] = blind.latestCards();
    await blind.act(second!.id, "approve");
    expect(blind.cards.get(second!.id)!.payload).toMatchObject({ applied: true, check: { ok: false, problem: expect.stringContaining("读不到") } });
    expect(blind.added).toEqual([]);
    expect(fs.existsSync(path.join(blind.userDir, "s2", "SKILL.md"))).toBe(true);
  });
});

const seedImported = (s: ReturnType<typeof setup>) => writeSkill(path.join(s.userDir, "notes-style"), "notes-style", "旧的说明");

describe("改", () => {
  it("旧版留在 .history/，新内容到位（目录名不变），在用它的都重新拉起；提交人的工具包里没有的配进去", async () => {
    const s = setup();
    seedImported(s);
    const old = fs.readFileSync(path.join(s.userDir, "notes-style", "SKILL.md"), "utf8");
    s.projects.push({ id: "p-2", name: "别的项目", maintainerId: "pm-2", charterConfirmed: true, toolkit: { skills: ["notes-style"], mcp: [], bash: false, network: false } });
    s.setAssistant(["notes-style"]);
    const dir = writeWorkSkill(path.join(s.workdir, "whatever-dir"), "notes-style", "新的说明");
    const result = await s.run(projectTarget, { action: "update", name: "notes-style", path: dir });
    expect(result.isError).toBeFalsy();
    const [card] = s.latestCards();
    expect(card!.payload).toMatchObject({ action: "update", source: { dirName: "notes-style" }, usedBy: [{ kind: "project", title: "别的项目" }, { kind: "assistant" }] });
    expect(fs.readFileSync(path.join(s.userDir, "notes-style", "SKILL.md"), "utf8")).toBe(old);
    await s.act(card!.id, "approve");
    expect(s.skills.find(["notes-style"])[0]!.entry).toMatchObject({ description: "新的说明", submittedBy: { kind: "project" } });
    expect(path.basename(s.skills.find(["notes-style"])[0]!.dir)).toBe("notes-style");
    const history = fs.readdirSync(path.join(s.userDir, HISTORY_DIR));
    expect(history).toHaveLength(1);
    expect(history[0]).toMatch(/^notes-style@\d+$/);
    expect(fs.readFileSync(path.join(s.userDir, HISTORY_DIR, history[0]!, "SKILL.md"), "utf8")).toBe(old);
    expect(s.cards.get(card!.id)!.outcome?.note).toMatch(/旧版留着/);
    expect(s.changed).toEqual([{ maintainerIds: ["pm-1", "pm-2"], assistant: true, name: "notes-style" }]);
    expect(s.added).toHaveLength(1);
    // .history 不算 skill
    expect(s.skills.list().filter((e) => e.name === "notes-style")).toHaveLength(1);
  });

  it("换的时候失败：旧版原样挪回去、新的不留半个，抛错，卡片留在待办（可以再点一次）", async () => {
    let failing = true;
    const s = setup({
      renameDir: (from, to) => {
        // 第一步（旧版挪进历史区）照常，第二步（新的就位）失败
        if (failing && path.basename(from).startsWith(".importing-")) throw new Error("被占着");
        fs.renameSync(from, to);
      },
    });
    seedImported(s);
    const before = treeOf(path.join(s.userDir, "notes-style"));
    const dir = writeWorkSkill(path.join(s.workdir, "new-version"), "notes-style", "新的说明");
    await s.run(projectTarget, { action: "update", name: "notes-style", path: dir });
    const [card] = s.latestCards();
    await expect(async () => s.act(card!.id, "approve")).rejects.toThrow(/被占着/);
    expect(treeOf(path.join(s.userDir, "notes-style"))).toEqual(before);
    expect(fs.readdirSync(s.userDir).filter((n) => n.startsWith(".importing-"))).toEqual([]);
    expect(fs.readdirSync(path.join(s.userDir, HISTORY_DIR))).toEqual([]);
    expect(s.cards.get(card!.id)!.status).toBe("pending");
    expect(s.decided()).toEqual([]);
    // 不占着了再点一次
    failing = false;
    await s.act(card!.id, "approve");
    expect(s.skills.find(["notes-style"])[0]!.entry.description).toBe("新的说明");
  });

  it("框架自带的、集合成员拒绝；没有这个 skill 的拒绝；名字不能变；每个 skill 只留最近 5 份旧版", async () => {
    const s = setup();
    seedImported(s);
    fs.mkdirSync(path.join(s.userDir, "a-collection", "m1"), { recursive: true });
    writeSkill(path.join(s.userDir, "a-collection", "m1"), "member-one", "集合成员");
    fs.writeFileSync(path.join(s.userDir, "a-collection", "ergo-collection.json"), JSON.stringify({ format: 1, name: "a-collection", source: "x", version: "1", description: "d", members: ["m1"], importedFrom: "x", importedAt: nowIso() }));
    const dirOf = (name: string) => writeWorkSkill(path.join(s.workdir, `src-${name}`), name);
    const cases: [string, Record<string, unknown>, RegExp][] = [
      ["框架自带的", { action: "update", name: "framework-one", path: dirOf("framework-one") }, /框架自带/],
      ["集合成员", { action: "update", name: "member-one", path: dirOf("member-one") }, /集合 a-collection/],
      ["没有这个", { action: "update", name: "nope", path: dirOf("nope") }, /skill 库里没有 nope/],
      ["改名", { action: "update", name: "notes-style", path: dirOf("renamed") }, /不能改名/],
      ["删框架自带的", { action: "remove", name: "framework-one" }, /框架自带/],
      ["删集合成员", { action: "remove", name: "member-one" }, /集合 a-collection/],
      ["删没有的", { action: "remove", name: "nope" }, /skill 库里没有 nope/],
    ];
    for (const [why, args, message] of cases) {
      const result = await s.run(projectTarget, args);
      expect({ why, isError: result.isError, text: result.text }).toMatchObject({ why, isError: true, text: expect.stringMatching(message) });
    }
    expect(s.latestCards()).toEqual([]);

    const dir = dirOf("notes-style");
    for (let i = 0; i < 7; i += 1) {
      fs.writeFileSync(path.join(dir, "version.txt"), String(i));
      await s.run(projectTarget, { action: "update", name: "notes-style", path: dir });
      const pending = s.latestCards().find((c) => c.status === "pending")!;
      await s.act(pending.id, "approve");
    }
    expect(fs.readFileSync(path.join(s.userDir, "notes-style", "version.txt"), "utf8")).toBe("6");
    expect(fs.readdirSync(path.join(s.userDir, HISTORY_DIR))).toHaveLength(5);
  });
});

describe("删", () => {
  it("卡上列出在用的工具包；删后 skill 进 .history/，工具包里的名字留着、装配时跳过并记日志，不动别人的工具包；同名再进库又能用", async () => {
    const s = setup();
    writeSkill(path.join(s.userDir, "notes-style"), "notes-style", "写笔记的规矩");
    s.projects.push({ id: "p-2", name: "在用的项目", maintainerId: "pm-2", charterConfirmed: true, toolkit: { skills: ["notes-style"], mcp: [], bash: false, network: false } });
    s.projects.push({ id: "p-3", name: "没用的项目", maintainerId: "pm-3", charterConfirmed: true, toolkit: { skills: [], mcp: [], bash: false, network: false } });
    s.tasks.push({ id: "t-5", title: "在跑的任务", maintainerId: "tm-5", state: "running" } as Partial<Task>, { id: "t-6", title: "结束了的任务", maintainerId: "tm-6", state: "done" } as Partial<Task>);
    s.toolkits.tasks.set("t-5", { skills: ["notes-style"], mcp: [], bash: false, network: false });
    s.toolkits.tasks.set("t-6", { skills: ["notes-style"], mcp: [], bash: false, network: false });
    s.setAssistant(["notes-style"]);
    await s.run(projectTarget, { action: "remove", name: "notes-style", why: "过时了" });
    const [card] = s.latestCards();
    expect(card!.payload).toMatchObject({ action: "remove", description: "写笔记的规矩", usedBy: [{ kind: "project", title: "在用的项目" }, { kind: "task", title: "在跑的任务" }, { kind: "assistant" }] });
    expect(card!.payload).not.toHaveProperty("source");
    expect(card!.text).toContain("项目「在用的项目」");
    expect(card!.text).toContain("任务「在跑的任务」");
    expect(card!.text).not.toContain("结束了的任务");
    expect(card!.text).toContain("名字留着");
    // 没确认之前还在
    expect(s.skills.find(["notes-style"])).toHaveLength(1);
    await s.act(card!.id, "approve");
    expect(s.skills.find(["notes-style"])).toEqual([]);
    expect(fs.existsSync(path.join(s.userDir, "notes-style"))).toBe(false);
    expect(fs.readdirSync(path.join(s.userDir, HISTORY_DIR))[0]).toMatch(/^notes-style@/);
    const updated = s.cards.get(card!.id)!;
    expect(updated.payload).toMatchObject({ applied: true, check: { ok: true } });
    expect(updated.payload).not.toHaveProperty("addedToToolkit");
    expect(updated.outcome?.note).toMatch(/删了/);
    // 工具包不动（不配也不去）；装配时跳过、记日志
    expect(s.added).toEqual([]);
    expect(s.skills.pathsOf(["notes-style"])).toEqual([]);
    expect(s.logs.some((l) => l.includes("notes-style") && l.includes("不在 skill 库里"))).toBe(true);
    // 在用它的都重新拉起（提交人、别的项目、任务；个人助理也换）
    expect(s.changed).toEqual([{ maintainerIds: ["pm-1", "pm-2", "tm-5"], assistant: true, name: "notes-style" }]);
    expect(s.notices("maintainer:pm-1").join("\n")).toContain("装配时跳过");
    // 同名的再进库：留着的名字又能用了
    const dir = writeWorkSkill(path.join(s.workdir, "again"), "notes-style", "新的");
    await s.run(projectTarget, { action: "add", path: dir });
    const again = s.latestCards().find((c) => c.status === "pending")!;
    await s.act(again.id, "approve");
    expect(s.skills.pathsOf(["notes-style"])).toHaveLength(1);
  });

  it("带依赖目录的 skill 删掉：只拆链接，来源里的依赖不动；依赖目录的名字列在卡上", async () => {
    const s = setup();
    const dir = writeWorkSkill(path.join(s.workdir, "with-deps"), "with-deps");
    fs.mkdirSync(path.join(dir, "node_modules", "left-pad"), { recursive: true });
    fs.writeFileSync(path.join(dir, "node_modules", "left-pad", "index.js"), "module.exports = 1;\n");
    await s.run(projectTarget, { action: "add", path: dir });
    const [card] = s.latestCards();
    expect(card!.payload.source).toMatchObject({ linked: ["node_modules"], fileCount: 2, scriptCount: 0 });
    await s.act(card!.id, "approve");
    expect(fs.lstatSync(path.join(s.userDir, "with-deps", "node_modules")).isSymbolicLink()).toBe(true);
    // 删 6 次之后旧版被清掉：来源里的依赖还在
    await s.run(projectTarget, { action: "remove", name: "with-deps" });
    await s.act(s.latestCards().find((c) => c.status === "pending")!.id, "approve");
    for (let i = 0; i < 6; i += 1) {
      await s.run(projectTarget, { action: "add", path: dir });
      await s.act(s.latestCards().find((c) => c.status === "pending")!.id, "approve");
      await s.run(projectTarget, { action: "remove", name: "with-deps" });
      await s.act(s.latestCards().find((c) => c.status === "pending")!.id, "approve");
    }
    expect(fs.readdirSync(path.join(s.userDir, HISTORY_DIR))).toHaveLength(5);
    expect(fs.existsSync(path.join(dir, "node_modules", "left-pad", "index.js"))).toBe(true);
  });
});
