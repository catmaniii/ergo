// 主切面：个人档案和记忆、提醒联动（283 号票）。真的守护进程（秘书是 faux，每晚整理的模型是假的 FakeChatModel，时钟手动拨）：
// - 生日变成每年提醒：核对卡上确认妈妈生日 3 月 2 日、提前 3 天 → 一条每年 2 月 27 日的提醒；生日改成 3 月 5 日提醒跟着改、
//   改提前几天跟着改、删了生日提醒跟着删（原话里明说了、直接写的生日 302 号票起直接建，见 personal-files-followups.test.ts）；
// - 每晚整理（假模型）从白天的话里认出"表弟小张在某公司上班"、提到够三次 → 第二天一张候选核对卡，确认后小张有档案、单位有值；
// - "二狗了解到的"：档案里的人（按别名）对到事实图谱的人物实体，列相关的结论、事实、原话；停用记忆插件时写明没启用、不报错；
// - 改了住址：事实图谱里旧住址的事实到期，依赖它的结论加复核标记（经唯一写入口，用户发起 · 经个人档案）；
// - 每晚整理发给模型的请求里没有号码类字段（证件号、电话、住址）的值；档案摘要当背景进了推理的提示。
// 示例数据全是编的：号码是明显的假号码，地址、单位是编的。
import { type ChatRequest, FakeChatModel } from "@ergo/memory";
import {
  type Card,
  type CardEventPayload,
  CHANNELS,
  EVENT_TYPES,
  HTTP_PATHS,
  type HttpErrorBody,
  type MessageEventPayload,
  nowIso,
  type PersonalFileCardPayload,
  type PersonalFileLearnedView,
  type PersonalFilesView,
  type PersonalFileSuggestCardPayload,
  type PersonalFileView,
  type ReminderEventPayload,
  SELF_PERSON_ID,
} from "@ergo/protocol";
import { describe, expect, it } from "vitest";
import type { MemoryNightlyRecord } from "../../src/memory/nightly-record.ts";
import { MEMORY_NIGHTLY_EVENT } from "../../src/memory/nightly-record.ts";
import { openReasoningDb } from "../../src/memory/rg-db.ts";
import type { FauxStep } from "../../src/runtime/index.ts";
import { clockIso } from "../../src/scheduler/clock.ts";
import { INTERNAL_CHANNEL } from "../../src/scheduler/internal-jobs.ts";
import { openDatabase } from "../../src/storage/sqlite.ts";
import { ManualClock } from "../helpers/clock.ts";
import { startTestDaemon } from "../helpers/daemon.ts";
import { TestFrontend } from "../helpers/frontend.ts";
import { requestJson } from "../helpers/http.ts";
import { waitUntil } from "../helpers/process.ts";

const { secretary: SECRETARY, cards: CARDS, inbox: INBOX, board: BOARD } = CHANNELS;
const ALL = { [SECRETARY]: 0, [CARDS]: 0, [INBOX]: 0, [BOARD]: 0 };

/** 本地时间 y 年 m 月 d 日 hh:mm */
const at = (m: number, d: number, hh: number, mm = 0, y = 2026) => new Date(y, m - 1, d, hh, mm);

const ID_CARD = "110101199003071234";
const PHONE = "13800138000";
const OLD_ADDRESS = "杭州市西湖区文三路 18 号";
const NEW_ADDRESS = "上海市徐汇区漕溪北路 9 号";

const propose = (params: Record<string, unknown>): FauxStep => ({ kind: "reply", toolCalls: [{ name: "propose_quick_action", arguments: { type: "personal_file", params } as never }] });
const OK: FauxStep = { kind: "reply", text: "好的。" };

const filesApi = {
  list: (url: string) => requestJson<PersonalFilesView & HttpErrorBody>(url, HTTP_PATHS.personalFiles),
  get: (url: string, id: string) => requestJson<PersonalFileView & HttpErrorBody>(url, HTTP_PATHS.personalFile(id)),
  add: (url: string, body: unknown) => requestJson<PersonalFileView & HttpErrorBody>(url, HTTP_PATHS.personalFiles, { method: "POST", body }),
  change: (url: string, id: string, body: unknown) => requestJson<PersonalFileView & HttpErrorBody>(url, HTTP_PATHS.personalFile(id), { method: "POST", body }),
  remove: (url: string, id: string, body: unknown) => requestJson<HttpErrorBody>(url, HTTP_PATHS.personalFileDelete(id), { method: "POST", body }),
  learned: (url: string, id: string) => requestJson<PersonalFileLearnedView & HttpErrorBody>(url, HTTP_PATHS.personalFileLearned(id)),
};

const turnEnds = (frontend: TestFrontend) => frontend.events({ channel: SECRETARY, type: EVENT_TYPES.turnEnd }).length;

async function tell(frontend: TestFrontend, text: string) {
  const before = turnEnds(frontend);
  const sent = await frontend.sendText(text);
  await waitUntil(() => turnEnds(frontend) > before, { timeoutMs: 30_000, describe: () => `等秘书处理完「${text.slice(0, 12)}」` });
  return sent;
}

const cardsOf = (frontend: TestFrontend): Card[] => frontend.events({ channel: CARDS, type: EVENT_TYPES.card }).map((f) => (f.payload as CardEventPayload).card);
const latestCard = (frontend: TestFrontend, id: string): Card => cardsOf(frontend).filter((c) => c.id === id).at(-1)!;
const remindersOf = (frontend: TestFrontend) => frontend.events({ channel: BOARD, type: EVENT_TYPES.reminder }).map((f) => f.payload as ReminderEventPayload);
const fieldOf = (file: PersonalFileView, field: string) => file.fields.find((f) => f.field === field)!;

describe("生日、纪念日变成每年提醒", () => {
  it("核对卡上确认妈妈生日 3 月 2 日、提前 3 天 → 每年 2 月 27 日的提醒；改成 3 月 5 日跟着改；改提前几天跟着改；删了生日跟着删", { timeout: 90_000 }, async () => {
    const clock = new ManualClock(at(10, 26, 10));
    const { url } = await startTestDaemon({ clock, secretary: [propose({ person: "妈妈", relation: "母亲", fields: [{ field: "生日", value: "3月2日" }] }), OK] });
    const frontend = await TestFrontend.connect(url);
    await frontend.subscribe(ALL);

    // 新建一个人总出核对卡：卡上带着"每年提前 3 天提醒"的勾（默认勾着）
    await tell(frontend, "记一下，我妈生日是3月2日");
    const card = cardsOf(frontend).find((c) => c.type === "personal_file")!;
    expect(card).toMatchObject({ status: "pending", typeVersion: 2 });
    expect((card.payload as PersonalFileCardPayload).remind).toEqual([{ field: "birthday", label: "生日", month: 3, day: 2, daysBefore: 3 }]);
    expect(card.text).toContain("每年提醒：生日提前 3 天");

    // 确认（勾着提前 3 天）：档案里有了妈妈、生日，提醒插件里有一条每年 2 月 27 日 09:00 的提醒
    await frontend.cardAction({ cardId: card.id, action: "execute", expectedVersion: card.version, input: { remind: [{ field: "birthday", daysBefore: 3 }] } });
    await waitUntil(() => remindersOf(frontend).length === 1, { describe: () => "等每年提醒建好" });
    const created = remindersOf(frontend)[0]!;
    expect(created).toMatchObject({ change: "created", by: "user", reminder: { schedule: { kind: "yearly", month: 2, day: 27, time: "09:00" }, status: "pending" } });
    expect(created.reminder.text).toBe("3 月 2 日是妈妈的生日（还有 3 天）");
    expect(created.reminder.nextAt).toBe(nowIso(at(2, 27, 9, 0, 2027)));
    const mom = (await filesApi.list(url)).body.files.find((f) => f.name === "妈妈")!;
    expect(fieldOf((await filesApi.get(url, mom.id)).body, "birthday").annual).toEqual({ monthDay: { month: 3, day: 2 }, daysBefore: 3, nextAt: nowIso(at(2, 27, 9, 0, 2027)) });

    // 生日改成 3 月 5 日（档案页里改的）：提醒跟着改成每年 3 月 2 日、内容跟着变，还是同一条
    await filesApi.change(url, mom.id, { kind: "set_field", field: "birthday", value: "3月5日" });
    const updated = remindersOf(frontend).at(-1)!;
    expect(updated).toMatchObject({ change: "updated", reminder: { id: created.reminder.id, schedule: { kind: "yearly", month: 3, day: 2 } } });
    expect(updated.reminder.text).toBe("3 月 5 日是妈妈的生日（还有 3 天）");

    // 改成提前 7 天：每年 2 月 26 日
    const week = await filesApi.change(url, mom.id, { kind: "set_reminder", field: "birthday", daysBefore: 7 });
    expect(week.status).toBe(200);
    expect(remindersOf(frontend).at(-1)).toMatchObject({ change: "updated", reminder: { id: created.reminder.id, schedule: { month: 2, day: 26 } } });
    expect(fieldOf(week.body, "birthday").annual?.daysBefore).toBe(7);

    // 改了称呼：提醒的内容跟着变
    await filesApi.change(url, mom.id, { kind: "set_field", field: "name", value: "老妈" });
    expect(remindersOf(frontend).at(-1)!.reminder.text).toBe("3 月 5 日是老妈的生日（还有 7 天）");

    // 不是生日、纪念日的字段开不了；农历的认不出日子
    expect((await filesApi.change(url, mom.id, { kind: "set_reminder", field: "phone", daysBefore: 3 })).status).toBe(400);

    // 删了生日（忘掉）：提醒跟着删
    expect((await filesApi.remove(url, mom.id, { target: { kind: "field", field: "birthday" }, mode: "forget" })).status).toBe(200);
    expect(remindersOf(frontend).at(-1)).toMatchObject({ change: "deleted", reminder: { id: created.reminder.id, status: "deleted" } });
    expect(fieldOf((await filesApi.get(url, mom.id)).body, "birthday").annual).toEqual({});
  });
});

/** 假的整理模型：认人物信息那一步按话里有没有"小张"交回；别的步骤回空 */
function peopleModel(request: ChatRequest): unknown {
  if (request.purpose !== "people") return {};
  const evidence = request.user
    .split("\n")
    .filter((line) => line.startsWith('{"evidence_id"'))
    .map((line) => JSON.parse(line) as { evidence_id: string; text: string });
  const zhang = evidence.filter((e) => e.text.includes("小张"));
  if (zhang.length === 0) return { people: [] };
  const work = zhang.find((e) => e.text.includes("某公司"));
  return {
    people: [
      {
        name: "小张",
        aliases: [],
        relation: "表弟",
        evidence_ids: zhang.map((e) => e.evidence_id),
        fields: work === undefined ? [] : [{ field: "work", value: "某公司", evidence_id: work.evidence_id }],
      },
    ],
  };
}

describe("每晚整理攒候选，第二天一张核对卡", () => {
  it("假模型认出'表弟小张在某公司上班'、提到三次 → 第二天一张候选核对卡；确认后小张有档案、单位字段有值", { timeout: 120_000 }, async () => {
    const clock = new ManualClock(at(10, 26, 20));
    const td = await startTestDaemon({ clock, memoryPlugin: true, memoryModel: () => new FakeChatModel(peopleModel), secretary: [OK, OK, OK] });
    const frontend = await TestFrontend.connect(td.url);
    await frontend.subscribe(ALL);
    await tell(frontend, "我表弟小张在某公司上班，最近挺忙的。");
    await tell(frontend, "周末和小张去爬山了。");
    await tell(frontend, "小张说下个月要出差。");
    // 白天不打断：没有卡
    expect(cardsOf(frontend).filter((c) => c.type === "personal_file_suggest")).toEqual([]);

    clock.advanceTo(at(10, 27, 3, 0));
    await td.daemon.internalJobs.whenIdle();
    const records = td.daemon.store.read(INTERNAL_CHANNEL, 0, MEMORY_NIGHTLY_EVENT).map((e) => e.payload as MemoryNightlyRecord);
    const ran = records.find((r) => r.state === "ran")!;
    expect(ran.people).toMatchObject({ calls: 1, scanned: 3, mentions: 1, candidates: 1 });

    // 一张候选核对卡（进了待我处理）：建档（表弟、提到 3 次）、单位
    await waitUntil(() => cardsOf(frontend).some((c) => c.type === "personal_file_suggest"), { describe: () => "等候选核对卡" });
    const card = cardsOf(frontend).filter((c) => c.type === "personal_file_suggest").at(-1)!;
    expect(ran.people?.cardId).toBe(card.id);
    const payload = card.payload as PersonalFileSuggestCardPayload;
    expect(payload.date).toBe("2026-10-27");
    expect(payload.items).toMatchObject([
      // heard 是那几句话的日子（事件日志按真的钟记时间，不跟着测试拨的钟）
      { kind: "create", person: { name: "小张", relation: "表弟", isNew: true }, mentions: 3, heard: [expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/)], origin: "nightly" },
      { kind: "field", person: { name: "小张", isNew: true }, field: "work", label: "单位或学校", value: "某公司" },
    ]);
    expect(frontend.events({ channel: INBOX, type: EVENT_TYPES.inboxItem }).some((f) => (f.payload as { item: { cardId?: string } }).item.cardId === card.id)).toBe(true);

    // 逐条确认：都勾上
    await frontend.cardAction({ cardId: card.id, action: "confirm", expectedVersion: card.version, input: { accept: payload.items.map((i) => i.id) } });
    await waitUntil(() => latestCard(frontend, card.id).status === "handled", { describe: () => "等候选核对卡处理完" });
    const zhang = (await filesApi.list(td.url)).body.files.find((f) => f.name === "小张")!;
    expect(zhang).toMatchObject({ relation: "表弟" });
    const file = (await filesApi.get(td.url, zhang.id)).body;
    expect(fieldOf(file, "work").current).toMatchObject({ value: "某公司", source: { via: "curator", basis: "confirmed" } });

    // 第二夜：同样的话不再提
    clock.advanceTo(at(10, 28, 3, 0));
    await td.daemon.internalJobs.whenIdle();
    expect(cardsOf(frontend).filter((c) => c.type === "personal_file_suggest" && c.id !== card.id)).toEqual([]);
  });
});

/** 往守护进程的 rg.db 里写证据、人物实体、事实、结论和一条支持（它这会儿没握着写的句柄） */
function seedGraph(file: string, clock: ManualClock, spec: { evidence: string; entity?: string; subject?: string; object: string; statement: string; claim: string; observedAt: string }) {
  const opened = openReasoningDb({ file, clock: () => clockIso(clock), model: "deepseek-flash" });
  if (!opened.ok) throw new Error("守护进程起来时应该建好了 rg.db");
  try {
    const store = opened.engine.store;
    const evidence = store.insertEvidence({ sourceLevel: "self", mode: "say", kind: "utterance", text: spec.evidence, context: [], eventTime: spec.observedAt, observedAt: spec.observedAt, sourceRef: null });
    const subjectId = spec.entity === undefined ? (spec.subject ?? "en-user") : store.insertEntity({ type: "person", name: spec.entity, aliases: [] }).id;
    const fact = store.insertFact(
      {
        subjectId,
        predicate: "associated_with",
        object: { type: "value", value: spec.object },
        negated: false,
        statement: spec.statement,
        assertion: "user_stated",
        context: [],
        evidenceIds: [evidence.id],
        eventTime: spec.observedAt,
        observedAt: spec.observedAt,
        validFrom: spec.observedAt,
        validTo: null,
        status: "active",
        supersededBy: null,
        retractedBy: null,
        contestedWith: [],
        extractedBy: "model:fake-llm",
      },
      { reason: "测试" },
    );
    const claim = store.insertClaim({
      tier: "preference",
      statement: spec.claim,
      kind: "conclusion",
      epistemic: "inferred",
      method: "induction",
      status: "active",
      confidence: "medium",
      context: [],
      validFrom: null,
      validTo: null,
      inferredAt: spec.observedAt,
      reviewedAt: null,
      retractedBy: null,
      supersededBy: null,
      competesWith: [],
      predicts: [],
    });
    store.putLink({ claimId: claim.id, target: fact.id, polarity: "supports", rationale: "测试", weight: "strong" });
    return { factId: fact.id, claimId: claim.id, evidenceId: evidence.id };
  } finally {
    opened.engine.close();
  }
}

describe("二狗了解到的", () => {
  it("档案里的人按别名对到人物实体：列相关的结论、事实、原话；停用记忆插件时写明没启用、不报错", { timeout: 90_000 }, async () => {
    const clock = new ManualClock(at(10, 26, 10));
    const td = await startTestDaemon({ clock, memoryPlugin: true, secretary: [OK] });
    const rgDb = td.daemon.layout.rgDb;
    const mom = (await filesApi.add(td.url, { name: "妈妈", relation: "母亲" })).body;
    await filesApi.change(td.url, mom.id, { kind: "set_field", field: "aliases", value: "老妈" });
    seedGraph(rgDb, clock, { evidence: "我老妈最近腿脚不好，爬楼吃力", entity: "老妈", object: "腿脚不好", statement: "妈妈腿脚不好，爬楼吃力", claim: "很在意妈妈的身体", observedAt: nowIso(at(10, 20, 9)) });

    const learned = await filesApi.learned(td.url, mom.id);
    expect(learned.status).toBe(200);
    expect(learned.body).toMatchObject({
      ready: true,
      entities: ["老妈"],
      claims: [{ statement: "很在意妈妈的身体", tier: "preference", status: "active", epistemic: "inferred" }],
      facts: [{ statement: "妈妈腿脚不好，爬楼吃力" }],
      quotes: [{ text: "我老妈最近腿脚不好，爬楼吃力" }],
    });
    // 没有这份档案：404
    expect((await filesApi.learned(td.url, "p-nobody")).status).toBe(404);

    // 停用记忆插件：200、ready false、写明没启用；档案本身照常
    await td.daemon.plugins.disable("memory");
    const off = await filesApi.learned(td.url, mom.id);
    expect(off.status).toBe(200);
    expect(off.body).toEqual({ ready: false, reason: "记忆插件没启用", entities: [], claims: [], facts: [], quotes: [] });
    expect((await filesApi.get(td.url, mom.id)).status).toBe(200);
  });
});

describe("新值作废旧事实", () => {
  it("改了住址：事实图谱里旧住址的事实到期，依赖它的结论加复核标记（唯一写入口，用户发起 · 经个人档案）", { timeout: 90_000 }, async () => {
    const clock = new ManualClock(at(10, 26, 10));
    const td = await startTestDaemon({ clock, memoryPlugin: true, secretary: [OK] });
    const rgDb = td.daemon.layout.rgDb;
    await filesApi.change(td.url, SELF_PERSON_ID, { kind: "set_field", field: "address", value: OLD_ADDRESS });
    const seeded = seedGraph(rgDb, clock, { evidence: `我住在${OLD_ADDRESS}`, object: "杭州市西湖区文三路18号", statement: "用户住在杭州市西湖区文三路18号", claim: "喜欢住在西湖边", observedAt: nowIso(at(10, 1, 9)) });

    clock.advanceTo(at(10, 26, 11));
    await filesApi.change(td.url, SELF_PERSON_ID, { kind: "set_field", field: "address", value: NEW_ADDRESS });
    const read = () => {
      const db = openDatabase(rgDb);
      try {
        return {
          fact: db.get<{ valid_to: string | null; status: string }>("SELECT valid_to, status FROM facts WHERE id = ?", seeded.factId)!,
          claim: db.get<{ status: string; needs_review: number }>("SELECT status, needs_review FROM claims WHERE id = ?", seeded.claimId)!,
          writes: db.all<{ actor: string; via: string | null; op: string }>("SELECT actor, via, op FROM rg_writes WHERE object_id = ?", seeded.factId),
        };
      } finally {
        db.close();
      }
    };
    await waitUntil(() => read().fact.valid_to !== null, { describe: () => "等旧住址的事实到期" });
    const after = read();
    expect(after.fact).toEqual({ valid_to: nowIso(at(10, 26, 11)), status: "active" });
    // 329 号票：待复核不再是状态，是复核标记
    expect(after.claim.needs_review).toBe(1);
    expect(after.writes).toEqual([{ actor: "user", via: "个人档案", op: "correct" }]);
  });
});

/** 假的整理模型：抽事实给每条证据一条事实（好让出假设那一步问模型），认人物信息回空 */
function recordingModel(request: ChatRequest): unknown {
  if (request.purpose === "people") return { people: [] };
  if (request.purpose !== "extract") return {};
  const ids = [...request.user.matchAll(/"evidence_id":"(ev-\d+)"/g)].map((m) => m[1]!);
  return {
    facts: ids.map((id) => ({
      evidence_id: id,
      predicate: "prefers",
      object: { name: `周末带孩子出门（${id}）`, type: "activity" },
      negated: false,
      context: ["weekend"],
      statement: `用户周末喜欢带孩子出门（${id}）`,
      span: "周末",
    })),
  };
}

describe("号码类字段不进整理提示", () => {
  it("每晚整理发给模型的每个请求里都没有证件号、电话、住址的值；档案摘要当背景进了出假设的提示", { timeout: 120_000 }, async () => {
    const clock = new ManualClock(at(10, 26, 20));
    const models: FakeChatModel[] = [];
    const td = await startTestDaemon({
      clock,
      memoryPlugin: true,
      memoryModel: () => {
        const model = new FakeChatModel(recordingModel);
        models.push(model);
        return model;
      },
      secretary: [OK, OK],
    });
    await filesApi.change(td.url, SELF_PERSON_ID, { kind: "set_field", field: "id_card", value: ID_CARD });
    await filesApi.change(td.url, SELF_PERSON_ID, { kind: "set_field", field: "phone", value: PHONE });
    await filesApi.change(td.url, SELF_PERSON_ID, { kind: "set_field", field: "address", value: OLD_ADDRESS });
    await filesApi.change(td.url, SELF_PERSON_ID, { kind: "set_field", field: "work", value: "某研究所 工程师" });
    const daughter = (await filesApi.add(td.url, { name: "女儿", relation: "女儿" })).body;
    await filesApi.change(td.url, daughter.id, { kind: "set_field", field: "birthday", value: "2020-03-02" });
    const frontend = await TestFrontend.connect(td.url);
    await frontend.subscribe(ALL);
    await tell(frontend, `记住我身份证号是 ${ID_CARD}，手机 138 0013 8000`);
    await tell(frontend, `我住在${OLD_ADDRESS}，周末常带女儿去公园`);
    // 用户的话记的是守护进程的钟（手动拨的）上的时间，不是真实时间：真实时间过了这一夜 03:00 以后，
    // 记成真实时间的话在这一夜还"没说"，出假设那一步拿不到观察（2026-10-27 起这条随真实时间变红）
    const said = frontend.events({ channel: SECRETARY, type: EVENT_TYPES.message }).map((f) => (f.payload as MessageEventPayload).message).filter((m) => m.speaker === "user");
    expect(said.map((m) => m.time)).toEqual([nowIso(at(10, 26, 20)), nowIso(at(10, 26, 20))]);

    clock.advanceTo(at(10, 27, 3, 0));
    await td.daemon.internalJobs.whenIdle();
    const requests = models.flatMap((m) => m.calls);
    expect(requests.some((r) => r.purpose === "extract")).toBe(true);
    const squash = (text: string) => text.replace(/[\s-]+/g, "");
    for (const request of requests) {
      const text = squash(`${request.system}\n${request.user}`);
      expect(text).not.toContain(ID_CARD);
      expect(text).not.toContain(PHONE);
      expect(text).not.toContain(squash(OLD_ADDRESS));
    }
    // 素材里的号码换成了占位
    const extract = requests.find((r) => r.purpose === "extract")!;
    expect(extract.user).toContain("［号码已略去］");
    expect(extract.user).toContain("［住址已略去］");
    // 档案摘要进了推理的提示（只当情境），号码、住址的值不列；抽事实的提示里没有摘要
    const proposeRequest = requests.find((r) => r.purpose === "propose")!;
    expect(proposeRequest.system).toContain("【个人档案摘要】");
    expect(proposeRequest.system).toContain("某研究所 工程师");
    expect(proposeRequest.system).toContain("女儿（女儿）：生日 2020-03-02");
    expect(extract.system).not.toContain("【个人档案摘要】");
  });
});
