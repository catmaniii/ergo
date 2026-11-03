// 秘书提交 skill（propose_skill）的单元测试：真的 skill 库、卡片、待办、事件存储、秘书用的 skill 名单，假的只有项目、任务的查询。
// 和负责人的 request_skill_change 是同一张卡、同一段校验和写入（skill-change.test.ts 测那一半），这里测秘书这一半：
// - 秘书调用后 skill 区没有新文件，只有一张卡（卡上是拼好的 SKILL.md 全文、触发说明、同名检查）；草稿区里也不留东西；
// - 批准后才进库，配进秘书用的 skill（不配进任何工具包）；内容以卡上的为准，秘书事后动草稿区不影响；
// - 同名：卡上带同名检查；覆盖（走"改"，旧版进 .history/）、改名（新名字也重名时这一下不算、卡留着）、放弃；框架自带的、集合成员不能覆盖；
// - 拒绝什么都不变，决定照记（skill_decided、秘书主线上的时间线、通知秘书、审批决定素材）。
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { ASSISTANT_NAME_MARK, CHANNELS, nowIso, type SkillChangeCardPayload, type SkillDecidedPayload } from "@ergo/protocol";
import { describe, expect, it, onTestFinished } from "vitest";
import { createCardService } from "../../src/cards/cards.ts";
import { CardTypeRegistry } from "../../src/cards/registry.ts";
import { cardsView } from "../../src/cards/views.ts";
import { createEphemeralBus } from "../../src/events/ephemeral.ts";
import { openEventStore } from "../../src/events/event-store.ts";
import { createInboxService } from "../../src/inbox/inbox.ts";
import { inboxView } from "../../src/inbox/views.ts";
import { composeSkillMd, createSkillChangeService, SKILL_DRAFTS_FOLDER, skillChangeCardType } from "../../src/skills/change.ts";
import { createSkillLibrary, frontmatter, HISTORY_DIR, SUBMISSION_FILE } from "../../src/skills/library.ts";
import { skillDecisionSource } from "../../src/skills/material-source.ts";
import { createSecretarySkills } from "../../src/skills/secretary-skills.ts";
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
      if (e.isDirectory()) walk(abs, relPath);
      else out[relPath] = createHash("sha256").update(fs.readFileSync(abs)).digest("hex");
    }
  };
  walk(root, "");
  return out;
}

const SECRETARY = CHANNELS.secretary;

function setup() {
  const dataDir = makeTempDir("ergo-propose-data-");
  const builtinDir = makeTempDir("ergo-propose-builtin-");
  const userDir = path.join(dataDir, "skills");
  // 秘书的草稿区在临时区里（和真的一样在数据目录里）
  const scratch = path.join(dataDir, "tmp", "scratch");
  fs.mkdirSync(scratch, { recursive: true });
  writeSkill(path.join(builtinDir, "framework-one"), "framework-one", "框架自带的");
  const logs: string[] = [];
  const skills = createSkillLibrary({ builtinDir, userDir, dataDir, now: nowIso, log: (l) => logs.push(l) });
  const secretaryFile = path.join(dataDir, "config", "secretary-skills.json");
  const secretarySkills = createSecretarySkills({ file: secretaryFile, library: skills, log: (l) => logs.push(l) });
  let secretaryChanges = 0;
  secretarySkills.onChange(() => (secretaryChanges += 1));
  const store = openEventStore({ file: path.join(makeTempDir("ergo-propose-db-"), "ergo.db"), views: [cardsView, inboxView] });
  onTestFinished(() => store.close());
  const registry = new CardTypeRegistry();
  const cards = createCardService({ store, registry, now: nowIso });
  const inbox = createInboxService({ store, notifications: createEphemeralBus(), now: nowIso });
  const toolkitAdds: string[] = [];
  const changed: { maintainerIds: readonly string[]; assistant: boolean; name: string }[] = [];
  const service = createSkillChangeService({
    store,
    cards,
    inbox,
    skills,
    projectOf: () => undefined,
    taskOf: () => undefined,
    sourceRoots: () => [],
    addToToolkit: (_submitter, name) => {
      toolkitAdds.push(name);
      return { changed: true, events: [] };
    },
    secretaryScratch: scratch,
    addToSecretary: (name) => secretarySkills.add(name),
    listProjects: () => [],
    listTasks: () => [],
    taskToolkit: () => undefined,
    assistantUses: (name) => secretarySkills.view().skills.includes(name),
    skillChanged: (change) => changed.push(change),
    now: nowIso,
    log: (l) => logs.push(l),
  });
  registry.register(skillChangeCardType(service));
  const tool = service.secretaryTool();
  const propose = async (args: Record<string, unknown>) => tool.run({ why: "用户让我记成 skill", ...args } as never, { toolCallId: "call-1" });
  const latestCards = () => {
    const byId = new Map<string, { id: string; payload: SkillChangeCardPayload; status: string; version: number; text: string; outcome?: { action: string; note?: string } }>();
    for (const event of store.read("cards", 0)) byId.set((event.payload as { card: { id: string } }).card.id, (event.payload as { card: never }).card);
    return [...byId.values()];
  };
  const pending = () => latestCards().find((c) => c.status === "pending")!;
  const act = async (cardId: string, action: "approve" | "deny" | "overwrite" | "rename", extra: { note?: string; input?: unknown } = {}) => {
    const card = cards.get(cardId)!;
    return cards.act({ cardId, action, expectedVersion: card.version, idempotencyKey: `k-${action}-${cardId}-${card.version}`, ...extra });
  };
  const decided = () => store.read("skills", 0).map((e) => e.payload as SkillDecidedPayload);
  const timeline = () => store.read(SECRETARY, 0).filter((e) => e.type === "timeline_record").map((e) => (e.payload as { record: { kind: string; summary: string } }).record);
  const notices = () => store.read(SECRETARY, 0).filter((e) => e.type === "message").map((e) => JSON.stringify(e.payload));
  const drafts = path.join(scratch, SKILL_DRAFTS_FOLDER);
  return {
    service, skills, secretarySkills, secretaryFile, store, cards, inbox, propose, latestCards, pending, act, decided, timeline, notices, logs, changed, toolkitAdds,
    secretaryChanges: () => secretaryChanges,
    dataDir, userDir, builtinDir, scratch, drafts,
  };
}

const NOTES = { name: "notes-style", description: "用户说「记一下」时用: 先查 # 标签，再写进笔记", body: "# 记笔记\n\n1. 先查标签\n2. 再写进去\n" };

describe("propose_skill：只校验、出卡", () => {
  it("秘书调用后 skill 区没有新文件，只有一张卡：卡上是拼好的 SKILL.md、触发说明、谁提的、同名检查；草稿区里也不留东西", async () => {
    const s = setup();
    const before = treeOf(s.dataDir);
    const result = await s.propose(NOTES);
    expect(result.isError).toBeFalsy();
    expect(result.cardIds).toHaveLength(1);
    expect(result.text).toContain("已提交“skill 变更”卡");
    const [card] = s.latestCards();
    expect(card!.payload).toMatchObject({
      action: "add",
      name: "notes-style",
      description: NOTES.description,
      why: "用户让我记成 skill",
      submitter: { kind: "secretary" },
      source: { dirName: "notes-style", fileCount: 1, scriptCount: 0, excluded: [], linked: [] },
    });
    expect(card!.payload).not.toHaveProperty("sameName");
    // SKILL.md 是运行时拼的：说明写成折叠块（冒号、# 照字面），正文原样
    expect(card!.payload.source!.skillMd).toBe(composeSkillMd("notes-style", NOTES.description, NOTES.body.trim()));
    expect(frontmatter(card!.payload.source!.skillMd)).toEqual({ name: "notes-style", description: NOTES.description });
    expect(card!.text).toContain("同名检查：库里没有同名的 skill");
    expect(card!.text).toContain(ASSISTANT_NAME_MARK);
    // 待办里有一条，来源写名字占位，去处是秘书的会话
    const item = s.inbox.list().find((i) => i.kind === "card" && i.cardId === card!.id)!;
    expect(item).toMatchObject({ source: ASSISTANT_NAME_MARK, origin: { conversation: SECRETARY } });
    expect(item.title).toContain("notes-style");
    // skill 区、秘书的名单一个字节都没动；草稿区里的那一格用完就删了
    expect(treeOf(s.dataDir)).toEqual(before);
    expect(fs.existsSync(s.drafts) ? fs.readdirSync(s.drafts) : []).toEqual([]);
  });

  it("说明压成一行；名字不合规矩、说明或正文只有空白：当场回原因、不出卡；同名的上一张卡还在等就不再出", async () => {
    const s = setup();
    expect(await s.propose({ ...NOTES, name: "Notes Style" })).toMatchObject({ isError: true, text: expect.stringContaining("参数不对") });
    expect(await s.propose({ ...NOTES, description: " \n\t " })).toMatchObject({ isError: true, text: expect.stringContaining("description") });
    expect(await s.propose({ ...NOTES, body: "\n\n  \n" })).toMatchObject({ isError: true, text: expect.stringContaining("body") });
    expect(s.latestCards()).toEqual([]);
    const multi = await s.propose({ ...NOTES, description: "第一行\n第二行\t第三行" });
    expect(multi.isError).toBeFalsy();
    expect(s.pending().payload.description).toBe("第一行 第二行 第三行");
    expect(await s.propose(NOTES)).toMatchObject({ isError: true, text: expect.stringContaining("还在等用户") });
    expect(s.latestCards()).toHaveLength(1);
  });
});

describe("批准、拒绝", () => {
  it("批准后才进库：SKILL.md 就是卡上那一份，记着是秘书提交的；配进秘书用的 skill（不配进工具包），名单变了秘书重新装配；时间线、通知、审批决定都在", async () => {
    const s = setup();
    await s.propose(NOTES);
    const card = s.pending();
    // 提交之后秘书在草稿区里乱写：卡上的才是真相
    fs.mkdirSync(path.join(s.drafts, "x", "notes-style"), { recursive: true });
    fs.writeFileSync(path.join(s.drafts, "x", "notes-style", "SKILL.md"), "---\nname: notes-style\ndescription: 偷偷改的\n---\n");
    expect(s.skills.find(["notes-style"])).toEqual([]);
    await s.act(card.id, "approve", { note: "可以" });
    const dir = path.join(s.userDir, "notes-style");
    expect(fs.readFileSync(path.join(dir, "SKILL.md"), "utf8")).toBe(card.payload.source!.skillMd);
    expect(s.skills.list().find((e) => e.name === "notes-style")).toMatchObject({ description: NOTES.description, origin: "imported", submittedBy: { kind: "secretary" } });
    expect(JSON.parse(fs.readFileSync(path.join(dir, SUBMISSION_FILE), "utf8"))).toMatchObject({ kind: "secretary" });
    // 秘书用的 skill：默认的两个照旧，加上它；名单变了叫一次重新装配
    expect(s.secretarySkills.view()).toMatchObject({ skills: ["agent-browser", "yt-dlp", "notes-style"], isDefault: false });
    expect(s.secretaryChanges()).toBe(1);
    expect(s.toolkitAdds).toEqual([]);
    expect(s.changed).toEqual([{ maintainerIds: [], assistant: false, name: "notes-style" }]);
    const updated = s.cards.get(card.id)!;
    expect(updated.status).toBe("handled");
    expect(updated.payload).toMatchObject({ applied: true, addedToToolkit: true, check: { ok: true } });
    expect(updated.outcome?.note).toMatch(/进库了/);
    expect(updated.text).toContain("下一轮起能用");
    expect(s.decided()).toMatchObject([{ decision: "approved", action: "add", name: "notes-style", submitter: { kind: "secretary" }, cardId: card.id, note: "可以", applied: true }]);
    expect(s.timeline()).toMatchObject([{ kind: "skill", summary: expect.stringContaining("自检通过") }]);
    expect(s.notices().join("\n")).toContain("用户批准了你提交的 skill");
    expect(s.notices().join("\n")).toContain("下一轮起就能用");
    // 审批决定素材：不归任何项目、任务
    const [draft] = skillDecisionSource.capture({ payload: s.decided()[0] } as never) as { project?: string; task?: string; context: string[] }[];
    expect(draft).toMatchObject({ context: ["decision:approved", "card:skill_change"] });
    expect(draft).not.toHaveProperty("project");
    expect(draft).not.toHaveProperty("task");
    // 草稿区里运行时那一格删了（秘书自己写的留着）
    expect(fs.readdirSync(s.drafts)).toEqual(["x"]);
  });

  it("拒绝：什么都不变；决定、时间线、通知秘书都有", async () => {
    const s = setup();
    await s.propose(NOTES);
    const card = s.pending();
    const before = treeOf(s.dataDir);
    await s.act(card.id, "deny", { note: "先不要" });
    expect(treeOf(s.dataDir)).toEqual(before);
    expect(s.skills.missing(["notes-style"])).toEqual(["notes-style"]);
    expect(s.decided()).toMatchObject([{ decision: "denied", action: "add", name: "notes-style", note: "先不要", applied: false, submitter: { kind: "secretary" } }]);
    expect(s.timeline()[0]!.summary).toContain("拒绝了");
    expect(s.notices().join("\n")).toContain("用户没要你提交的 skill");
    expect(s.changed).toEqual([]);
  });

  it("批准之前库里冒出了同名的（不是在卡上选的）：不进库，卡上写明，通知秘书重新提交", async () => {
    const s = setup();
    await s.propose(NOTES);
    const card = s.pending();
    writeSkill(path.join(s.userDir, "notes-style"), "notes-style", "用户刚导入的");
    await s.act(card.id, "approve");
    expect(s.cards.get(card.id)!.payload).toMatchObject({ applied: false, problem: expect.stringContaining("notes-style") });
    expect(s.skills.find(["notes-style"])[0]!.entry.description).toBe("用户刚导入的");
    expect(s.notices().join("\n")).toContain("propose_skill 重新提交");
  });
});

describe("同名", () => {
  it("和导入的同名：照样出卡，带同名检查（能覆盖）；skill 区不变；覆盖走\"改\"那条，旧版进 .history/，在用它的重新装配", async () => {
    const s = setup();
    writeSkill(path.join(s.userDir, "notes-style"), "notes-style", "旧的说明");
    // 秘书自己已经在用旧的那个
    s.secretarySkills.add("notes-style");
    const old = fs.readFileSync(path.join(s.userDir, "notes-style", "SKILL.md"), "utf8");
    const before = treeOf(s.userDir);
    const result = await s.propose(NOTES);
    expect(result.text).toContain("库里已经有同名的");
    const card = s.pending();
    expect(card.payload.sameName).toEqual({ owner: "你导入的 notes-style", overwritable: true });
    expect(card.payload.usedBy).toEqual([{ kind: "assistant" }]);
    expect(card.payload.source!.dirName).toBe("notes-style");
    expect(card.text).toContain("可以覆盖");
    expect(treeOf(s.userDir)).toEqual(before);
    await s.act(card.id, "overwrite", { note: "换掉" });
    // 名单里本来就有：不写文件，叫秘书按新的 skill 库重新装配
    expect(s.changed).toEqual([{ maintainerIds: [], assistant: true, name: "notes-style" }]);
    expect(s.skills.find(["notes-style"])[0]!.entry).toMatchObject({ description: NOTES.description, submittedBy: { kind: "secretary" } });
    const history = fs.readdirSync(path.join(s.userDir, HISTORY_DIR));
    expect(history).toHaveLength(1);
    expect(fs.readFileSync(path.join(s.userDir, HISTORY_DIR, history[0]!, "SKILL.md"), "utf8")).toBe(old);
    const updated = s.cards.get(card.id)!;
    expect(updated.status).toBe("handled");
    expect(updated.outcome).toMatchObject({ action: "overwrite" });
    expect(updated.payload).toMatchObject({ applied: true, resolution: "overwrite", check: { ok: true } });
    expect(updated.text).toContain("覆盖了库里同名的");
    expect(s.decided()).toMatchObject([{ decision: "approved", action: "update", resolution: "overwrite", name: "notes-style", applied: true, note: "换掉" }]);
    expect(s.timeline()[0]!.summary).toContain("覆盖了库里同名的");
  });

  it("改名：新名字也重名的这一下不算、卡留着；换个名字进库，SKILL.md 里的 name 跟着改，原来那个不动", async () => {
    const s = setup();
    writeSkill(path.join(s.userDir, "notes-style"), "notes-style", "旧的说明");
    writeSkill(path.join(s.userDir, "notes-two"), "notes-two", "另一个");
    const before = treeOf(path.join(s.userDir, "notes-style"));
    await s.propose(NOTES);
    const card = s.pending();
    await expect(async () => s.act(card.id, "rename", { input: { name: "notes-two" } })).rejects.toThrow(/进不了库/);
    await expect(async () => s.act(card.id, "rename", { input: { name: "Bad Name" } })).rejects.toThrow(/「rename」的输入不对/);
    expect(s.cards.get(card.id)!.status).toBe("pending");
    expect(s.decided()).toEqual([]);
    await s.act(card.id, "rename", { input: { name: "notes-mine" } });
    const mine = s.skills.find(["notes-mine"])[0]!;
    expect(path.basename(mine.dir)).toBe("notes-mine");
    expect(mine.entry).toMatchObject({ description: NOTES.description, submittedBy: { kind: "secretary" } });
    expect(fs.readFileSync(path.join(mine.dir, "SKILL.md"), "utf8")).toContain("name: notes-mine\n");
    expect(treeOf(path.join(s.userDir, "notes-style"))).toEqual(before);
    expect(s.secretarySkills.view().skills).toContain("notes-mine");
    expect(s.secretarySkills.view().skills).not.toContain("notes-style");
    const updated = s.cards.get(card.id)!;
    expect(updated.payload).toMatchObject({ applied: true, resolution: "rename", renamedTo: "notes-mine", name: "notes-style" });
    expect(updated.text).toContain("改名为 notes-mine 进库");
    expect(s.decided()).toMatchObject([{ decision: "approved", action: "add", name: "notes-mine", resolution: "rename", renamedFrom: "notes-style" }]);
    expect(s.notices().join("\n")).toContain("notes-mine");
  });

  it("框架自带的、集合成员同名：卡上写明不能覆盖，点覆盖被拒、卡留着；放弃什么都不变", async () => {
    const s = setup();
    fs.mkdirSync(path.join(s.userDir, "a-collection", "m1"), { recursive: true });
    writeSkill(path.join(s.userDir, "a-collection", "m1"), "member-one", "集合成员");
    fs.writeFileSync(path.join(s.userDir, "a-collection", "ergo-collection.json"), JSON.stringify({ format: 1, name: "a-collection", source: "x", version: "1", description: "d", members: ["m1"], importedFrom: "x", importedAt: nowIso() }));
    await s.propose({ ...NOTES, name: "framework-one" });
    const framework = s.pending();
    expect(framework.payload.sameName).toMatchObject({ owner: "框架自带的 framework-one", overwritable: false, problem: expect.stringContaining("框架自带") });
    await expect(async () => s.act(framework.id, "overwrite")).rejects.toThrow(/不能覆盖/);
    expect(s.cards.get(framework.id)!.status).toBe("pending");
    const before = treeOf(s.dataDir);
    await s.act(framework.id, "deny");
    expect(treeOf(s.dataDir)).toEqual(before);
    expect(s.decided()).toMatchObject([{ decision: "denied", name: "framework-one" }]);

    await s.propose({ ...NOTES, name: "member-one" });
    expect(s.pending().payload.sameName).toMatchObject({ owner: "集合 a-collection 里的 member-one", overwritable: false, problem: expect.stringContaining("集合 a-collection") });
    // 只是目录名（斜杠命令）撞上：也算同名，不能覆盖
    await s.propose({ ...NOTES, name: "a-collection" });
    expect(s.latestCards().find((c) => c.payload.name === "a-collection")!.payload.sameName).toMatchObject({ owner: "集合 a-collection", overwritable: false });
  });

  it("覆盖、改名只给秘书提交的卡：负责人的卡上点了被拒", async () => {
    const s = setup();
    const card = s.cards.create({
      type: "skill_change",
      payload: { action: "add", name: "x", description: "d", submitter: { kind: "project", projectId: "p-1", projectName: "记账本", maintainerId: "pm-1" } } satisfies SkillChangeCardPayload,
    });
    await expect(async () => s.act(card.id, "overwrite")).rejects.toThrow(/不能覆盖或改名/);
    await expect(async () => s.act(card.id, "rename", { input: { name: "y" } })).rejects.toThrow(/不能覆盖或改名/);
  });
});

describe("秘书用的 skill 名单：add", () => {
  it("只查这一个在库里，名单里别的照旧（被删了的名字也留着）；已经在的不写文件；设置文件写坏了不替用户覆盖", () => {
    const s = setup();
    expect(() => s.secretarySkills.add("nope")).toThrow(/skill 库里没有 nope/);
    writeSkill(path.join(s.userDir, "one"), "one", "一");
    fs.mkdirSync(path.dirname(s.secretaryFile), { recursive: true });
    fs.writeFileSync(s.secretaryFile, JSON.stringify({ format: 1, skills: ["gone-skill"] }));
    expect(s.secretarySkills.add("one")).toBe(true);
    expect(JSON.parse(fs.readFileSync(s.secretaryFile, "utf8"))).toEqual({ format: 1, skills: ["gone-skill", "one"] });
    expect(s.secretarySkills.add("one")).toBe(false);
    expect(s.secretaryChanges()).toBe(1);
    fs.writeFileSync(s.secretaryFile, "{坏的");
    expect(() => s.secretarySkills.add("one")).toThrow(/先按默认的装/);
    expect(fs.readFileSync(s.secretaryFile, "utf8")).toBe("{坏的");
  });
});
