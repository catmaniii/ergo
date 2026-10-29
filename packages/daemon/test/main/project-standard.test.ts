// 主切面：项目规范（258 号票，issue 19 第 1、4、6、11 条）。真的守护进程，测试扮演前端（维护者交立项书直接调项目模块，不走剧本）。
// - 新项目立项时记下建档用的规范模板版本，档案里的规格、进展、决策记录照模板生成（类型还没定，按其他类那三份）；
// - 立项书确认成开发类：补上架构图、tickets/、ops.json；其他类不补；
// - 只读接口 GET /api/projects/<id>/standard：模板版本、每份文档在不在和最近修改时间（必须有的标出来、还是模板原样的标出来）、
//   当前状态的检查清单（"进展已写回"）、规范改写（空的）；文档缺了照实说；规范上线之前建的项目版本是 null；没有的项目 404。
// 261 号票（issue 19 第 5 条）：本项目的规范改写——维护者引用用户的话提（propose_standard_change，faux 剧本），"规范改写"卡上逐处对照、
// 附原话、进待办，用户确认才生效（接口、档案里的 standard-overrides.md、检查清单、重启不补回不要的那份），拒绝的不变；模板出了新版只提示，
// 跟新版也要确认。
import fs from "node:fs";
import path from "node:path";
import {
  type Card,
  type CardEventPayload,
  CHANNELS,
  EVENT_TYPES,
  HTTP_PATHS,
  maintainerChannel,
  PROJECT_STANDARD_LATEST,
  type ProjectEventPayload,
  type ProjectStandardView,
  type StandardChangeCardPayload,
  standardDocState,
} from "@ergo/protocol";
import { describe, expect, it } from "vitest";
import type { FauxStep } from "../../src/runtime/index.ts";
import { startTestDaemon, type TestDaemon } from "../helpers/daemon.ts";
import { TestFrontend } from "../helpers/frontend.ts";
import { requestJson } from "../helpers/http.ts";
import { waitUntil } from "../helpers/process.ts";
import { seedProject } from "../helpers/projects.ts";
import { cardWhere, eventually, inputsDone, itemWhere, messagesOf, noticesOf, ok, recordsOf, say, textOf } from "../helpers/task-flow.ts";
import { makeTempDir } from "../helpers/temp-dir.ts";

const { cards: CARDS, projects: PROJECTS, inbox: INBOX } = CHANNELS;
const PM1 = maintainerChannel("pm-1");

async function connect(url: string, channels: string[]) {
  const frontend = await TestFrontend.connect(url);
  await frontend.subscribe(Object.fromEntries(channels.map((c) => [c, 0])));
  return frontend;
}

const projectEventsOf = (frontend: TestFrontend) => frontend.events({ channel: PROJECTS, type: EVENT_TYPES.project }).map((f) => f.payload as ProjectEventPayload);
const cardsOf = (frontend: TestFrontend): Card[] => frontend.events({ channel: CARDS, type: EVENT_TYPES.card }).map((f) => (f.payload as CardEventPayload).card);

async function standardOf(td: TestDaemon, projectId: string): Promise<ProjectStandardView> {
  const res = await requestJson<ProjectStandardView>(td.url, HTTP_PATHS.projectStandard(projectId));
  expect(res.status).toBe(200);
  return res.body;
}

/** 用户在聊天里点"立项"：直接放一张建议立项卡再点 */
async function kickoff(td: TestDaemon, frontend: TestFrontend, name: string) {
  const card = td.daemon.cards.create({ type: "suggest_project", payload: { name, goal: `${name}的目标` } });
  const r = await frontend.cardAction({ cardId: card.id, action: "kickoff", expectedVersion: 1 });
  expect(r.ok).toBe(true);
  await waitUntil(() => projectEventsOf(frontend).some((e) => e.change === "created" && e.project.name === name), { describe: () => `项目「${name}」诞生` });
  return projectEventsOf(frontend).find((e) => e.change === "created" && e.project.name === name)!.project;
}

/** 维护者交立项书（直接调项目模块），用户在立项书卡上点"只确认，稍后开工" */
async function confirmCharter(td: TestDaemon, frontend: TestFrontend, projectId: string, kind: "dev" | "other") {
  const project = td.daemon.projects.get(projectId)!;
  const { cardId } = td.daemon.projects.submitCharter(projectId, project.maintainerId, {
    charter: { goal: "把家里的账管起来", scope: ["导入流水"], firstVersion: "能导入一家银行的 CSV", kind, bindExternal: false },
  });
  await waitUntil(() => cardsOf(frontend).some((c) => c.id === cardId), { describe: () => "立项书卡" });
  const r = await frontend.cardAction({ cardId, action: "confirm_later", expectedVersion: 1 });
  expect(r.ok).toBe(true);
  await waitUntil(() => projectEventsOf(frontend).some((e) => e.change === "charter_confirmed" && e.project.id === projectId), { describe: () => "立项书确认" });
}

describe("项目规范", () => {
  it("立项记下模板版本、档案照模板生成；确认成开发类补上架构图、tickets/、ops.json，其他类不补；只读接口的形状；文档缺了照实说；旧项目版本是 null；没有的项目 404", async () => {
    const td = await startTestDaemon();
    const frontend = await TestFrontend.connect(td.url);
    await frontend.subscribe({ [PROJECTS]: 0, [CARDS]: 0 });

    // 立项：项目上记着建档用的模板版本；档案里规格、进展、决策记录照模板（其他类那三份），辅助的照旧
    const ledger = await kickoff(td, frontend, "记账本");
    expect(ledger.standardVersion).toBe(PROJECT_STANDARD_LATEST);
    const root = path.join(td.dataDir, "projects", ledger.id);
    expect(fs.readdirSync(root).toSorted()).toEqual(["adr", "charter.md", "glossary.md", "manifest.md", "progress.md", "scope-records.md", "spec.md", "workdir"]);
    expect(fs.readFileSync(path.join(root, "spec.md"), "utf8")).toContain(`> 项目规范 ${PROJECT_STANDARD_LATEST} · 必须有（会检查）`);

    // 只读接口：筹备中，类型还没定（按其他类三份）；都还是模板原样；检查清单是筹备中 → 建设中，进展还没写回；改写是空的
    const preparing = await standardOf(td, ledger.id);
    expect(preparing).toMatchObject({ projectId: ledger.id, version: PROJECT_STANDARD_LATEST, latest: PROJECT_STANDARD_LATEST, kind: null, overrides: [] });
    expect(preparing.docs.filter((d) => d.role === "required").map((d) => [d.key, d.path, standardDocState(d)])).toEqual([
      ["spec", "spec.md", "template"],
      ["progress", "progress.md", "template"],
      ["adr", "adr/", "template"],
    ]);
    expect(preparing.docs.filter((d) => d.role === "auxiliary").map((d) => d.key)).toEqual(["charter", "glossary", "manifest", "scopeRecords"]);
    for (const d of preparing.docs) expect(d.modifiedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}[+-]\d{2}:\d{2}$/);
    expect(preparing.checklist).toEqual({ from: "preparing", to: "building", items: [{ id: "progress_written", label: "进展已写回", done: false, detail: "progress.md 还是模板原样" }] });

    // 维护者写了规格、进展：不再是模板原样，进展已写回
    fs.appendFileSync(path.join(root, "spec.md"), "\n导入招行的 CSV。\n");
    fs.writeFileSync(path.join(root, "progress.md"), "# 进展\n\n立项问答问完了。\n");
    const written = await standardOf(td, ledger.id);
    expect(written.docs.filter((d) => d.role === "required").map((d) => [d.key, standardDocState(d)])).toEqual([
      ["spec", "written"],
      ["progress", "written"],
      ["adr", "template"],
    ]);
    expect(written.checklist.items).toEqual([{ id: "progress_written", label: "进展已写回", done: true }]);

    // 立项书确认成开发类：补上架构图、tickets/、ops.json（已经写了的规格不动）；四份必须有
    await confirmCharter(td, frontend, ledger.id, "dev");
    await waitUntil(() => fs.existsSync(path.join(root, "ops.json")), { describe: () => "开发类的规范文档" });
    expect(fs.readFileSync(path.join(root, "spec.md"), "utf8")).toContain("导入招行的 CSV。");
    expect(fs.readdirSync(path.join(root, "tickets"))).toEqual(["README.md"]);
    const dev = await standardOf(td, ledger.id);
    expect(dev.kind).toBe("dev");
    expect(dev.docs.map((d) => [d.key, d.role, standardDocState(d)])).toEqual([
      ["spec", "required", "written"],
      ["architecture", "required", "template"],
      ["progress", "required", "written"],
      ["adr", "required", "template"],
      ["tickets", "kind", "template"],
      ["ops", "before_in_use", "template"],
      ["charter", "auxiliary", "written"],
      ["glossary", "auxiliary", "written"],
      ["manifest", "auxiliary", "written"],
      ["scopeRecords", "auxiliary", "written"],
    ]);

    // 文档缺了：照实说（不在、没有修改时间）
    fs.rmSync(path.join(root, "architecture.md"));
    const missing = await standardOf(td, ledger.id);
    expect(missing.docs.find((d) => d.key === "architecture")).toEqual({ key: "architecture", path: "architecture.md", role: "required", exists: false });

    // 其他类：不要架构图和票
    const fridge = await kickoff(td, frontend, "家电档案");
    await confirmCharter(td, frontend, fridge.id, "other");
    const other = await standardOf(td, fridge.id);
    expect(other.kind).toBe("other");
    expect(other.docs.filter((d) => d.role !== "auxiliary").map((d) => d.key)).toEqual(["spec", "progress", "adr"]);
    expect(fs.existsSync(path.join(td.dataDir, "projects", fridge.id, "architecture.md"))).toBe(false);

    // 规范上线之前建的项目（没记模板版本）：版本是 null；开发类缺架构图
    const old = seedProject(td.daemon, "旧项目", { state: "in_use", kind: "dev", charterConfirmed: true });
    await waitUntil(() => fs.existsSync(path.join(td.dataDir, "projects", old.id, "spec.md")), { describe: () => "旧项目的档案" });
    const legacy = await standardOf(td, old.id);
    expect(legacy).toMatchObject({ version: null, latest: PROJECT_STANDARD_LATEST, kind: "dev" });
    expect(legacy.docs.filter((d) => d.role === "required").map((d) => [d.key, standardDocState(d)])).toEqual([
      ["spec", "written"],
      ["architecture", "missing"],
      ["progress", "written"],
      ["adr", "template"],
    ]);
    expect(legacy.checklist).toMatchObject({ from: "in_use", to: "retired" });

    // 没有的项目：404
    const none = await requestJson<{ code: string; message: string }>(td.url, HTTP_PATHS.projectStandard("p-99"));
    expect(none.status).toBe(404);
    expect(none.body).toMatchObject({ code: "not_found", message: "没有这个项目：p-99（可能已经删了）" });
  }, 60_000);
});

/** 消息 id 的样子（m-<uuid>） */
const MESSAGE_ID = "m-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
/** 维护者从最近一条用户消息末尾抄出 id，调用工具（参数 userWords） */
const citing = (name: string, args: Record<string, unknown>): FauxStep => ({ kind: "call_with_matches", from: "user", pattern: MESSAGE_ID, argument: "userWords", toolCall: { name, arguments: args as never } });

describe("本项目的规范改写（261 号票）", () => {
  it("维护者引用用户的话提出（不要架构图、进展换写法、多一份运维手册）：卡上逐处对照、附原话、进待办；确认才生效——接口和档案里的 standard-overrides.md 看得出和默认规范哪里不同，检查清单按改写后的，重启也不补回架构图；拒绝的不变；一次只有一张在等；进展不能不要", async () => {
    const dataDir = makeTempDir("ergo-data-");
    const homeDir = makeTempDir("ergo-home-");
    const first = await startTestDaemon({
      reuse: { dataDir, homeDir },
      maintainer: [
        citing("propose_standard_change", {
          drop: ["architecture"],
          change: [{ doc: "progress", how: "按周写，每周一节" }],
          add: [{ path: "runbook.md", title: "运维手册", what: "怎么重启、怎么查日志" }],
          why: "家里自己用的小工具：不画架构图，进展按周写，要一份运维手册",
        }),
        say("卡在这里，点确认就生效"),
        say("好，照改过的规范做"),
      ],
    });
    const frontend = await connect(first.url, [CARDS, INBOX, PROJECTS, PM1]);
    const ledger = seedProject(first.daemon, "记账本", { state: "building", kind: "dev", charterConfirmed: true, standardVersion: PROJECT_STANDARD_LATEST });
    const records = first.daemon.projects.records(ledger.id);
    await waitUntil(() => fs.existsSync(records.architecture), { describe: () => "开发类的规范文档" });

    // 用户在维护者会话里说：维护者引用这句提出，卡上逐处对照、附核实过的原话，进待办，也出在会话里
    const said = await frontend.sendText("这个小工具不用画架构图，进展按周写就行，再加一份运维手册", { conversation: PM1 });
    const card = await cardWhere(frontend, (c) => c.type === "standard_change", "规范改写卡");
    const payload = card.payload as StandardChangeCardPayload;
    expect(payload).toMatchObject({ projectId: ledger.id, projectName: "记账本", revision: 1, why: "家里自己用的小工具：不画架构图，进展按周写，要一份运维手册" });
    expect(payload.items).toEqual([
      { after: { kind: "drop", doc: "architecture" } },
      { after: { kind: "change", doc: "progress", note: "按周写，每周一节" } },
      { after: { kind: "add", path: "runbook.md", title: "运维手册", note: "怎么重启、怎么查日志" } },
    ]);
    expect(payload.upgrade).toBeUndefined();
    expect(payload.userWords).toEqual([
      { messageId: said.messageId, text: "这个小工具不用画架构图，进展按周写就行，再加一份运维手册", conversation: PM1, where: "项目「记账本」的维护者会话", time: expect.any(String), device: "本机" },
    ]);
    expect(card.text).toContain("不要架构图");
    await itemWhere(frontend, (i) => i.kind === "card" && i.cardId === card.id && i.origin?.projectId === ledger.id, "待办里的规范改写卡");
    await waitUntil(() => messagesOf(frontend, PM1).some((m) => m.message.parts.some((p) => p.type === "card_ref" && p.cardId === card.id)), { describe: () => "会话里的规范改写卡" });
    // 用户确认之前不生效
    expect((await standardOf(first, ledger.id)).overrides).toEqual([]);
    // 一次只有一张在等
    const tool = first.daemon.standardChanges.tool(ledger.id, ledger.maintainerId);
    const busy = await tool.run({ drop: ["tickets"], why: "不要票" }, { toolCallId: "t-busy" });
    expect(busy).toMatchObject({ isError: true, text: "上一张规范改写卡（第 1 次）还在等用户，先等它有结论" });

    // 确认：生效——接口里看得出哪里不同，档案里记一份，维护者收到通知，时间线上记一笔
    await inputsDone(frontend, PM1);
    ok(await frontend.cardAction({ cardId: card.id, action: "confirm", expectedVersion: card.version }));
    await eventually(() => projectEventsOf(frontend), (e) => e.change === "standard_changed" && e.project.id === ledger.id, "规范改写生效");
    const changed = await standardOf(first, ledger.id);
    expect(changed.overrides.map((o) => [o.kind, o.path, o.summary, o.revision])).toEqual([
      ["drop", "architecture.md", "不要架构图", 1],
      ["change", "progress.md", "进展换一种写法：按周写，每周一节", 1],
      ["add", "runbook.md", "多一份「运维手册」（runbook.md）：怎么重启、怎么查日志", 1],
    ]);
    expect(changed.docs.filter((d) => d.role === "required").map((d) => [d.key, d.path, standardDocState(d)])).toEqual([
      ["spec", "spec.md", "template"],
      ["architecture", "architecture.md", "dropped"],
      ["progress", "progress.md", "template"],
      ["adr", "adr/", "template"],
      ["custom", "runbook.md", "missing"],
    ]);
    // 建设中 → 使用中的检查清单按改写后的：这个项目不要架构图，架构图那项不列（259 号票的另外几项照列）
    expect(changed.checklist.items.map((i) => i.id)).toEqual(["ops", "services", "public_entry", "progress_written"]);
    const overridesFile = path.join(records.root, "standard-overrides.md");
    await waitUntil(() => fs.existsSync(overridesFile), { describe: () => "档案里的 standard-overrides.md" });
    const file = fs.readFileSync(overridesFile, "utf8");
    expect(file).toContain("# 本项目的规范改写");
    expect(file).toContain("- 不要架构图");
    expect(file).toContain("- 多一份「运维手册」（runbook.md）：怎么重启、怎么查日志");
    expect(file).toContain("### 第 1 次");
    expect(file).toContain("「这个小工具不用画架构图，进展按周写就行，再加一份运维手册」");
    expect(recordsOf(frontend, PM1).find((r) => r.record.kind === "standard_change")?.record.summary).toBe("你确认了规范改写（第 1 次）：家里自己用的小工具：不画架构图，进展按周写，要一份运维手册");
    await eventually(() => noticesOf(frontend, PM1), (m) => textOf(m).includes("用户确认了规范改写（第 1 次）"), "确认的通知");
    // 进展不能不要
    const progress = await tool.run({ drop: ["progress"], why: "不写进展" }, { toolCallId: "t-progress" });
    expect(progress.isError).toBe(true);
    expect(progress.text).toContain("进展不能不要");
    await inputsDone(frontend, PM1);
    await first.daemon.stop();

    // 重启：守护进程再对一遍档案，不要的架构图删了也不补回来；改写还在
    fs.rmSync(records.architecture);
    const second = await startTestDaemon({
      reuse: { dataDir, homeDir },
      maintainer: [citing("propose_standard_change", { restore: ["architecture"], why: "用户想还是画一张架构图" }), say("卡在这里"), say("好，还是不画")],
    });
    const fresh = await connect(second.url, [CARDS, INBOX, PROJECTS, PM1]);
    expect(fs.existsSync(records.architecture)).toBe(false);
    expect((await standardOf(second, ledger.id)).overrides).toHaveLength(3);

    // 再提一次（恢复画架构图）：用户拒绝，改写不变
    await fresh.sendText("要不还是画一张架构图吧", { conversation: PM1 });
    const restore = await cardWhere(fresh, (c) => c.type === "standard_change" && c.id !== card.id, "第二张规范改写卡");
    expect((restore.payload as StandardChangeCardPayload).items).toEqual([{ before: { kind: "drop", doc: "architecture" } }]);
    expect(restore.text).toContain("架构图恢复照默认规范（原来：不要架构图）");
    await inputsDone(fresh, PM1);
    ok(await fresh.cardAction({ cardId: restore.id, action: "reject", expectedVersion: restore.version, note: "算了，不画" }));
    await eventually(() => noticesOf(fresh, PM1), (m) => textOf(m).includes("用户拒绝了规范改写（第 2 次）：「算了，不画」"), "拒绝的通知");
    expect((await standardOf(second, ledger.id)).overrides.map((o) => o.summary)).toEqual(["不要架构图", "进展换一种写法：按周写，每周一节", "多一份「运维手册」（runbook.md）：怎么重启、怎么查日志"]);
    expect(fs.existsSync(records.architecture)).toBe(false);
    expect(recordsOf(fresh, PM1).find((r) => r.record.kind === "standard_change" && r.record.summary.startsWith("你拒绝了"))?.record.summary).toBe("你拒绝了规范改写（第 2 次），规范不变");
    await inputsDone(fresh, PM1);
  }, 120_000);

  it("模板出了新版只提示：项目记着的旧版本照旧，接口里 latest 是新版、档案不动；跟新版也由维护者提、用户确认，确认后版本换成新的、缺的文档从新版模板补上（已有的不动）；已经是最新的不能再跟，规范上线之前建的这样提是补齐规范文档（272 号票）", async () => {
    const td = await startTestDaemon();
    const frontend = await connect(td.url, [CARDS, INBOX, PROJECTS]);
    // 建档时用的是以前的一版（目录里已经没有了）：照旧的最小文档集
    const old = seedProject(td.daemon, "旧账本", { state: "in_use", kind: "dev", charterConfirmed: true, standardVersion: "v0" });
    const records = td.daemon.projects.records(old.id);
    await waitUntil(() => fs.existsSync(records.spec), { describe: () => "旧账本的档案" });
    fs.writeFileSync(records.spec, "# 规格\n\n导入招行的 CSV。\n");
    const before = await standardOf(td, old.id);
    expect(before).toMatchObject({ version: "v0", latest: PROJECT_STANDARD_LATEST, overrides: [] });
    expect(standardDocState(before.docs.find((d) => d.key === "architecture")!)).toBe("missing");
    expect(fs.existsSync(records.architecture)).toBe(false);

    // 维护者提跟新版：出卡，确认之前什么都不变
    const tool = td.daemon.standardChanges.tool(old.id, old.maintainerId);
    const proposed = await tool.run({ upgrade: true, why: "用户说跟上新版规范" }, { toolCallId: "t-up" });
    expect(proposed.isError).toBeUndefined();
    const card = await cardWhere(frontend, (c) => c.type === "standard_change", "跟新版规范的卡");
    expect(card.payload).toMatchObject({ revision: 1, items: [], upgrade: { from: "v0", to: PROJECT_STANDARD_LATEST } });
    expect(card.text).toContain(`跟新版规范：v0 → ${PROJECT_STANDARD_LATEST}`);
    expect(fs.existsSync(records.architecture)).toBe(false);

    // 确认：版本换成新的，缺的从新版模板补上，已经写了的规格不动
    ok(await frontend.cardAction({ cardId: card.id, action: "confirm", expectedVersion: card.version }));
    const changed = await eventually(() => projectEventsOf(frontend), (e) => e.change === "standard_changed" && e.project.id === old.id, "跟上新版");
    expect(changed.project.standardVersion).toBe(PROJECT_STANDARD_LATEST);
    await waitUntil(() => fs.existsSync(records.architecture), { describe: () => "从新版模板补上架构图" });
    expect(fs.readFileSync(records.spec, "utf8")).toBe("# 规格\n\n导入招行的 CSV。\n");
    expect(await standardOf(td, old.id)).toMatchObject({ version: PROJECT_STANDARD_LATEST, latest: PROJECT_STANDARD_LATEST });

    // 已经是最新的：不能再跟。规范上线之前建的（没有版本）：272 号票起这样提就是补齐规范文档（卡上没有"从哪一版"，
    // 确认后照 262 号票的补齐做，主切面在 project-standard-backfill.test.ts）
    const again = await tool.run({ upgrade: true, why: "再跟一次" }, { toolCallId: "t-again" });
    expect(again).toMatchObject({ isError: true, text: `项目「旧账本」用的已经是最新的规范 ${PROJECT_STANDARD_LATEST}` });
    const legacy = seedProject(td.daemon, "老相册", { state: "in_use", kind: "other", charterConfirmed: true });
    const adopt = await td.daemon.standardChanges.tool(legacy.id, legacy.maintainerId).run({ upgrade: true, why: "用户说补上规范文档" }, { toolCallId: "t-legacy" });
    expect(adopt.isError).toBeUndefined();
    const adoptCard = await cardWhere(frontend, (c) => c.type === "standard_change" && (c.payload as StandardChangeCardPayload).projectId === legacy.id, "补齐规范文档的卡");
    expect((adoptCard.payload as StandardChangeCardPayload).upgrade).toMatchObject({ to: PROJECT_STANDARD_LATEST });
    expect((adoptCard.payload as StandardChangeCardPayload).upgrade?.from).toBeUndefined();
    expect(adoptCard.text).toContain("补齐规范文档");
  }, 60_000);
});
