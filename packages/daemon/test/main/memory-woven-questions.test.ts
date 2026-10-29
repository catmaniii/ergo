// 主切面：顺口问（264 号票接进线上；271 号票：秘书按语气自己改写，用户有没有在答由记忆管理员在每晚整理时批量判）。
// 走真实的装配路径（组合根、插件清单、秘书的 faux 剧本、03:00 的内部作业、假的整理模型）：
// - 话题对上、不急、今天还没问：秘书这一轮的输入后面跟一块【顺口问】，写着要问什么、为什么问、可以不问，让它用自己的话问；
//   不再要求原样带那一句。秘书问了就调 mark_woven_question 标一下，标了才记"问过"（改写了照样记）；没标的不算（回话里原样带了也不算），
//   标错了编号的也不算；
// - 急事、话题对不上不带；一天只问一个；
// - 白天的规则照旧处理紧接着的下一句里明显的：回答了回写成本人证据，"别问这个"这一类都不再问，"跳过"回到问题箱；
// - 规则认不出的（隐含的回答）留到每晚整理：记忆管理员把问题和用户之后的几句话一起看——答了回写（留痕写明经记忆管理员夜里判），
//   没答算跳过一次，拿不准留到下一夜，下一夜用户又说起了就判成在答；
// - 设置里关掉：不带；默认开着。
// 秘书的剧本用 echo_context：回显的上下文里看得到这一轮的【顺口问】和工具的结果。
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CHANNELS, EVENT_TYPES, type MessageEventPayload } from "@ergo/protocol";
import { type ChatRequest, FakeChatModel, type MemoryEngine, type NewClaim, type QuestionDraft, SyntheticEventsSource } from "@ergo/memory";
import { describe, expect, it } from "vitest";
import { MEMORY_NIGHTLY_EVENT, type MemoryNightlyRecord } from "../../src/memory/nightly-record.ts";
import { openReasoningDb } from "../../src/memory/rg-db.ts";
import type { FauxStep } from "../../src/runtime/index.ts";
import { clockIso } from "../../src/scheduler/clock.ts";
import { INTERNAL_CHANNEL } from "../../src/scheduler/internal-jobs.ts";
import { ManualClock } from "../helpers/clock.ts";
import { startTestDaemon } from "../helpers/daemon.ts";
import { TestFrontend } from "../helpers/frontend.ts";
import { agentSettingsApi, memoryApi } from "../helpers/http.ts";

const { secretary: SECRETARY } = CHANNELS;
const echo: FauxStep = { kind: "echo_context" };
const say = (text: string): FauxStep => ({ kind: "reply", text });
const MARK = "mark_woven_question";
/** 秘书标一下这一轮问的是哪个问题 */
const mark = (id: string): FauxStep => ({ kind: "reply", toolCalls: [{ name: MARK, arguments: { id } }] });
/** 秘书照【顺口问】里写的编号标（从这一轮输入后面的上下文块里抄编号） */
const markOffered: FauxStep = { kind: "call_with_matches", toolCall: { name: MARK, arguments: {} }, argument: "id", pattern: "qu-\\d{4}", from: "user", first: true };

/** 本地时间 2026 年 m 月 d 日 hh:mm（2026-10-10 是周六） */
const at = (m: number, d: number, hh: number, mm = 0) => new Date(2026, m - 1, d, hh, mm);
const HOUR = 60 * 60 * 1000;

const OWN = "上次推掉的周末活动，要是时间由你自己定，你会去吗？";
const ALONE = "周末有人约你的时候，你更愿意一个人待着吗？";
/** 198 写死的那一句（271 起不再要求原样带） */
const FIXED = (question: string) => `顺便问一句：${question}（想更了解你一点，不想答可以跳过。）`;
const WEEKEND_TALK = "这周六同学约我聚会，我还在想要不要去。";
const TOPIC = "repeated_decline|weekend|social";
const VIA_DAY = "经秘书顺口问";
const VIA_NIGHT = "经记忆管理员夜里判";

function claim(id: string, statement: string, competesWith: string): NewClaim {
  return {
    id,
    tier: "need",
    statement,
    kind: "hypothesis",
    epistemic: "inferred",
    method: "abduction",
    status: "contested",
    confidence: "low",
    context: ["weekend", "social"],
    validFrom: null,
    validTo: null,
    inferredAt: "2026-10-09T03:00:00+08:00",
    reviewedAt: null,
    retractedBy: null,
    supersededBy: null,
    competesWith: [competesWith],
    predicts: [],
  };
}

function draft(key: string, text: string, separation: number): QuestionDraft {
  return {
    key,
    topic: TOPIC,
    kind: "unresolved",
    sources: ["unresolved"],
    text,
    why: "cl-0001「周末想自己安排时间」和 cl-0002「不喜欢那类聚会」还分不清",
    targets: [
      { id: "cl-0001", kind: "claim", statement: "周末想自己安排时间" },
      { id: "cl-0002", kind: "claim", statement: "不喜欢那类聚会" },
    ],
    answers: {
      yes: { supports: ["cl-0001"], refutes: ["cl-0002"], maxWeight: "decisive", note: "会去：是想自己定时间" },
      no: { supports: ["cl-0002"], refutes: ["cl-0001"], maxWeight: "decisive", note: "不去：是不喜欢那类聚会" },
    },
    domains: ["schedule", "social"],
    scenes: ["weekend"],
    terms: [],
    probeId: null,
    validUntil: null,
    separation,
    closeness: 1,
    frequency: 1,
  };
}

/** 往守护进程的 rg.db 里放两条分不出胜负的结论、同一类的两个问题（qu-0001"自己定时间就去吗"排在前面，qu-0002） */
function seed(file: string, clock: ManualClock): void {
  const opened = openReasoningDb({ file, clock: () => clockIso(clock), model: "deepseek-flash" });
  if (!opened.ok) throw new Error("守护进程起来时应该建好了 rg.db");
  try {
    const { engine } = opened;
    engine.store.insertClaim(claim("cl-0001", "周末想自己安排时间", "cl-0002"));
    engine.store.insertClaim(claim("cl-0002", "不喜欢那类聚会", "cl-0001"));
    engine.questions.offer(draft("own", OWN, 1), clockIso(clock));
    engine.questions.offer(draft("alone", ALONE, 0.5), clockIso(clock));
  } finally {
    opened.engine.close();
  }
}

/** 周末社交案例的前三条（@ergo/memory 的合成例子），规则版整理一次：出两组还分不清的结论和问题箱里的几个问题（每晚整理的那一节用） */
const WEEKEND_FIXTURE = fileURLToPath(new URL("../../../memory/test/fixtures/weekend-events.json", import.meta.url));
async function seedWeekend(file: string, clock: ManualClock): Promise<void> {
  const opened = openReasoningDb({ file, clock: () => clockIso(clock), model: "deepseek-flash" });
  if (!opened.ok) throw new Error("守护进程起来时应该建好了 rg.db");
  try {
    const { engine } = opened;
    for (const d of SyntheticEventsSource.fromFile(WEEKEND_FIXTURE).read()) if (["ev-w01", "ev-w02", "ev-w03"].includes(d.id!)) engine.ingestEvidence(d);
    const night = await engine.runNightly({ userActive: false, manual: true });
    if (!night.ran) throw new Error("规则版整理没跑");
  } finally {
    opened.engine.close();
  }
}

/** 读一眼 rg.db（只读，不写 manifest） */
function peek<T>(file: string, clock: ManualClock, read: (engine: MemoryEngine) => T): T {
  const opened = openReasoningDb({ file, clock: () => clockIso(clock), model: "deepseek-flash", readOnly: true });
  if (!opened.ok) throw new Error("rg.db 打不开");
  try {
    return read(opened.engine);
  } finally {
    opened.engine.close();
  }
}

async function tell(frontend: TestFrontend, text: string) {
  await frontend.sendText(text);
  await frontend.next(SECRETARY, EVENT_TYPES.turnEnd);
}

const lastSecretaryText = (frontend: TestFrontend) =>
  (frontend.events({ channel: SECRETARY, type: EVENT_TYPES.message }).at(-1)!.payload as MessageEventPayload).message.parts.map((p) => (p.type === "text" ? p.text : "")).join("");
/** 说一句，等秘书这一轮做完；回显里这一轮的输入（这句话最后一次出现的地方起：后面跟着这一轮的上下文块、工具的结果） */
async function turn(frontend: TestFrontend, text: string): Promise<string> {
  await tell(frontend, text);
  const echoed = lastSecretaryText(frontend);
  return echoed.slice(echoed.lastIndexOf(text));
}

async function start(secretary: FauxStep[], options: { config?: Record<string, unknown>; memoryModel?: () => FakeChatModel; seed?: "plain" | "weekend" } = {}) {
  const clock = new ManualClock(at(10, 10, 9, 0));
  // 265 号票：给了 clock 时底座默认停掉记忆插件；顺口问是它的，打开
  const td = await startTestDaemon({
    clock,
    memoryPlugin: true,
    secretary,
    ...(options.config === undefined ? {} : { config: options.config }),
    ...(options.memoryModel === undefined ? {} : { memoryModel: options.memoryModel }),
  });
  const rgDb = td.daemon.layout.rgDb;
  if (options.seed === "weekend") await seedWeekend(rgDb, clock);
  else seed(rgDb, clock);
  const frontend = await TestFrontend.connect(td.url);
  await frontend.subscribe({ [SECRETARY]: 0 });
  return { td, clock, rgDb, frontend };
}

describe("顺口问：秘书按语气自己改写，标了才算问过", () => {
  it("急事、话题对不上不带；话题对上带一块【顺口问】（要问什么、为什么、可以不问，用自己的话）；秘书标了就记问过；同一天不再带；紧接着回答了：回写成本人证据", { timeout: 90_000 }, async () => {
    const { td, clock, rgDb, frontend } = await start([echo, echo, mark("qu-0001"), echo, echo, echo]);

    // 急事：不带
    expect(await turn(frontend, "会议提前了，赶紧帮我把周六的安排改一下！")).not.toContain("【顺口问】");
    // 话题对不上（查天气）：不带
    clock.advance(HOUR);
    expect(await turn(frontend, "帮我查一下明天上海的天气")).not.toContain("【顺口问】");
    expect(peek(rgDb, clock, (e) => e.listQuestions({ status: "asked" }))).toEqual([]);

    // 周末聚会：话题对上，带优先级高的那个。上下文块给要问什么、为什么问、可以不问，让秘书用自己的话问；不再要求原样带那一句
    clock.advance(HOUR);
    const offered = await turn(frontend, WEEKEND_TALK);
    expect(offered).toContain("【顺口问】");
    expect(offered).toContain("qu-0001");
    expect(offered).toContain(`要问的：${OWN}`);
    expect(offered).toContain("为什么问：");
    expect(offered).toContain("用你自己的话");
    expect(offered).toContain("不合适就别问");
    expect(offered).toContain(MARK);
    expect(offered).not.toContain("原样带上");
    expect(offered).not.toContain(FIXED(OWN));
    expect(offered).not.toContain(ALONE);
    // 秘书标了（工具回"记下了"）→ 这一轮做完记问过（经过里写明是秘书用自己的话问的）
    expect(offered).toContain("记下了");
    const asked = peek(rgDb, clock, (e) => e.listQuestions({ status: "asked" }));
    expect(asked.map((q) => q.text)).toEqual([OWN]);
    expect(asked[0]).toMatchObject({ askedCount: 1, lastAskedAt: clockIso(clock) });
    expect(asked[0]!.history.at(-1)!.detail).toContain("在聊天里顺着话题顺口问了");

    // 紧接着的下一句回答了（白天的规则认得出的）：读成"是"（不算明确，下一夜按判法判），回答记成本人证据，出处是这句话的素材
    clock.advance(5 * 60 * 1000);
    const noted = await turn(frontend, "会啊，时间我自己定的话就去");
    expect(noted).toContain("【顺口问】");
    expect(noted).toContain("回答了");
    // 同一天：不再带新的问题
    expect(noted).not.toContain(ALONE);
    const [material] = td.daemon.materials.searchKeyword("时间我自己定的话就去");
    expect(material).toBeDefined();
    const { question, evidence } = peek(rgDb, clock, (e) => {
      const q = e.listQuestions().find((x) => x.text === OWN)!;
      return { question: q, evidence: q.answerEvidenceId === null ? undefined : e.store.getEvidence(q.answerEvidenceId) };
    });
    expect(question).toMatchObject({ status: "answered", verdict: "yes", clear: false });
    expect(evidence).toMatchObject({ sourceLevel: "self", text: "会啊，时间我自己定的话就去", sourceRef: material!.id });
    // 267 号票：都经推理库的唯一写入口——记问过是记忆管理员，回答（连同回答证据入库）是用户的表态，都经秘书顺口问
    const trail = peek(rgDb, clock, (e) => ({ question: e.gate.history(question.id), evidence: e.gate.history(evidence!.id) }));
    expect(trail.question).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ objectType: "question", op: "ask", actor: "curator", via: VIA_DAY }),
        expect.objectContaining({ objectType: "question", op: "verdict", actor: "user_verdict", via: VIA_DAY }),
      ]),
    );
    expect(trail.evidence).toEqual([expect.objectContaining({ objectType: "evidence", op: "ingest", actor: "user_verdict", via: VIA_DAY })]);

    // 同一天再聊到周末：不带（每天最多一个）
    clock.advance(HOUR);
    expect(await turn(frontend, "这周末老同学又约饭了")).not.toContain("要问的：");

    // 记忆页的问题箱：看得到问过、答了，回答原话和读成什么，经过
    const view = await memoryApi.questions(td.url);
    const item = view.body.items.find((i) => i.text === OWN)!;
    expect(item).toMatchObject({ status: "answered", askedCount: 1, skippedCount: 0, verdict: "yes", answerText: "会啊，时间我自己定的话就去" });
    expect(item.history.map((h) => h.event)).toEqual(["created", "asked", "answered"]);
    expect(view.body.items.find((i) => i.text === ALONE)).toMatchObject({ status: "open", askedCount: 0 });
  });

  it("没标不算问过（回话里原样带了那一句也不算）、标错编号也不算；标了才算；'别问这个'：这一类都不再问，第二天也不带", { timeout: 90_000 }, async () => {
    const { td, clock, rgDb, frontend } = await start([
      say(`好，周六的事你再想想。${FIXED(OWN)}`),
      mark("qu-0002"),
      echo,
      mark("qu-0001"),
      say("你自己的时间你说了算。话说回来，上次推掉的那个活动，要是时间由你来定，会去吗？"),
      echo,
      echo,
    ]);

    // 秘书这一轮没标（哪怕回话里原样带了那一句）：不记问过（同一天还能再挑）
    await tell(frontend, WEEKEND_TALK);
    expect(peek(rgDb, clock, (e) => e.listQuestions({ status: "asked" }))).toEqual([]);

    // 标错了编号（这一轮交给它的是 qu-0001）：工具回错，不记问过
    clock.advance(HOUR);
    const wrong = await turn(frontend, "周日要不要约朋友去爬山？");
    expect(wrong).toContain("这一轮交给你的顺口问是 qu-0001");
    expect(peek(rgDb, clock, (e) => e.listQuestions({ status: "asked" }))).toEqual([]);

    // 标了：秘书用自己的话问的，照样记问过
    clock.advance(HOUR);
    await tell(frontend, "周六下午那个聚会到底去不去呢");
    expect(peek(rgDb, clock, (e) => e.listQuestions({ status: "asked" }).map((q) => q.text))).toEqual([OWN]);

    // 用户说别问这个：这一类（两个问题同一类）都关掉、挡住
    clock.advance(5 * 60 * 1000);
    expect(await turn(frontend, "这个别问了")).toContain("【顺口问】用户说别问这个");
    const statuses = peek(rgDb, clock, (e) => e.listQuestions().map((q) => [q.text, q.status]));
    expect(statuses).toEqual(expect.arrayContaining([[OWN, "declined"], [ALONE, "declined"]]));
    expect(peek(rgDb, clock, (e) => e.questions.isBlocked(TOPIC))).toBe(true);
    // 267 号票："别问这个"经唯一写入口，记成用户发起、经秘书顺口问（同一类的两个问题都记一行）
    const declined = peek(rgDb, clock, (e) => e.gate.records({ op: "decline" }));
    expect(declined.length).toBe(2);
    expect(declined.every((r) => r.objectType === "question" && r.actor === "user" && r.via === VIA_DAY)).toBe(true);

    // 第二天同样的话题：不带
    clock.advance(24 * HOUR);
    expect(await turn(frontend, WEEKEND_TALK)).not.toContain("【顺口问】");
    expect((await memoryApi.questions(td.url)).body.items.map((i) => i.status)).toEqual(["declined", "declined"]);
  });

  it("设置里关掉就不带（默认开着）；再打开又带；用户说跳过：问题回到问题箱、记跳过一次", { timeout: 90_000 }, async () => {
    const { td, clock, rgDb, frontend } = await start([echo, mark("qu-0001"), echo, echo]);
    expect((await memoryApi.settings(td.url)).body).toEqual({ wovenQuestions: true, memoryBrief: true, interviewInvites: true });
    const off = await memoryApi.saveSettings(td.url, { wovenQuestions: false });
    expect(off.status).toBe(200);
    expect(off.body).toEqual({ wovenQuestions: false, memoryBrief: true, interviewInvites: true });
    expect(await turn(frontend, WEEKEND_TALK)).not.toContain("【顺口问】");
    // 存在数据目录的配置区（重启照样按它）；请求体不对回 400
    expect((await memoryApi.settings(td.url)).body).toEqual({ wovenQuestions: false, memoryBrief: true, interviewInvites: true });
    expect(JSON.parse(fs.readFileSync(path.join(td.dataDir, "config", "memory-settings.json"), "utf8"))).toEqual({ format: 1, wovenQuestions: false, memoryBrief: true, interviewInvites: true });
    expect((await memoryApi.saveSettings(td.url, { wovenQuestions: "no" } as never)).status).toBe(400);

    expect((await memoryApi.saveSettings(td.url, { wovenQuestions: true })).body).toEqual({ wovenQuestions: true, memoryBrief: true, interviewInvites: true });
    clock.advance(HOUR);
    expect(await turn(frontend, WEEKEND_TALK)).toContain(`要问的：${OWN}`);

    // 用户说跳过：回到问题箱（跳过一次，优先级减半），秘书知道不用再提
    clock.advance(5 * 60 * 1000);
    expect(await turn(frontend, "这个跳过吧")).toContain("【顺口问】用户跳过了");
    const own = peek(rgDb, clock, (e) => e.listQuestions().find((q) => q.text === OWN)!);
    expect(own).toMatchObject({ status: "open", askedCount: 1, skippedCount: 1 });
    expect(own.history.map((h) => h.event)).toEqual(["created", "asked", "skipped"]);
    // 267 号票：跳过经唯一写入口，记成用户的表态、经秘书顺口问
    expect(peek(rgDb, clock, (e) => e.gate.history(own.id).at(-1))).toMatchObject({ objectType: "question", op: "skip", actor: "user_verdict", via: VIA_DAY });
  });
});

describe("330 号票（R15）：一次对话最多顺口问一个", () => {
  it("同一次对话里过了零点（每天一个的限制已经过了）聊到也不再挑，另一个问题留在问题箱；清空当前对话（新的一段）以后才再挑", { timeout: 90_000 }, async () => {
    // 清空以后秘书是新的一段会话、剧本从头来：第一步照这一轮交来的编号标
    const { td, clock, rgDb, frontend } = await start([markOffered, echo, echo, echo]);
    // 周六 23:40 问了一个（不跨 03:00 的整理：整理会把这里手放的问题当成不用问了）
    clock.advanceTo(at(10, 10, 23, 40));
    await tell(frontend, WEEKEND_TALK);
    expect(peek(rgDb, clock, (e) => e.listQuestions({ status: "asked" }).map((q) => q.text))).toEqual([OWN]);
    // 半小时后过了零点，还是同一次对话（没隔一小时、没新开一段）：同样的话题也不挑，另一个问题照旧在问题箱里
    clock.advanceTo(at(10, 11, 0, 10));
    expect(await turn(frontend, WEEKEND_TALK)).not.toContain("要问的：");
    expect(peek(rgDb, clock, (e) => e.listQuestions().find((q) => q.text === ALONE)!.status)).toBe("open");
    // 清空当前对话：新的一段，又能顺口问一个
    expect((await agentSettingsApi.clear(td.url, "secretary", "k-new-segment")).status).toBe(200);
    clock.advance(10 * 60 * 1000);
    expect(await turn(frontend, WEEKEND_TALK)).toContain(`要问的：${ALONE}`);
    expect(peek(rgDb, clock, (e) => e.listQuestions({ status: "asked" }).map((q) => q.text).toSorted())).toEqual([OWN, ALONE].toSorted());
  });
});

/** 假的整理模型：抽事实什么都不抽，判回答按用户说了什么回；别的步骤回空。记下每次判回答的请求 */
function nightModel(replies: ChatRequest[]) {
  return () =>
    new FakeChatModel((request) => {
      if (request.purpose === "extract") return { facts: [] };
      if (request.purpose !== "reply") return {};
      replies.push(request);
      const sentence = (needle: string) => [...request.user.matchAll(/- (s\d+) [^「]*「([^」]*)」/g)].find((m) => m[2]!.includes(needle))?.[1];
      const busy = sentence("事情确实太多");
      if (busy) return { kind: "answered", verdict: "yes", answer: [busy], why: "说事情太多、别排太满" };
      const own = sentence("替我安排");
      if (own) return { kind: "answered", verdict: "yes", answer: [own], why: "不喜欢别人替自己安排，自己定就去" };
      if (request.user.includes("还行吧")) return { kind: "unsure", why: "'还行吧'说不清是不是要少排" };
      return { kind: "not_answered", why: "在交代别的事" };
    });
}

const nightlyRecords = (td: Awaited<ReturnType<typeof startTestDaemon>>) => td.daemon.store.read(INTERNAL_CHANNEL, 0, MEMORY_NIGHTLY_EVENT).map((event) => event.payload as MemoryNightlyRecord);

describe("顺口问的回答：记忆管理员每晚整理时批量判", () => {
  it("隐含的回答夜里判成在答并回写；没答的算跳过一次；拿不准的留到下一夜，下一夜用户又说起了就判成在答", { timeout: 180_000 }, async () => {
    const replies: ChatRequest[] = [];
    const { td, clock, rgDb, frontend } = await start(
      [
        // 第一天：秘书标了、用自己的话问了"自己定时间会不会去"那一个；用户隐含地答了一句、又说了句别的
        markOffered,
        say("去不去都看你。对了，上回推掉的那个活动，要是时间全由你来定，你会去吗？"),
        say("明白。"),
        say("明天上海晴。"),
        // 第二天：问"要不要少排一些"那一个；用户说的是别的事
        markOffered,
        say("周六你自己定。最近要不要我给你少排点事？"),
        say("好的，帮你看票。"),
        // 第三天：又问了一次；用户只说了句"还行吧"
        markOffered,
        say("周末你自己安排就好。接下来要不要我少排一些事？"),
        say("嗯。"),
        // 第四天：用户自己又说起了
        say("好，我记着，下周少排点。"),
      ],
      { seed: "weekend", memoryModel: nightModel(replies) },
    );
    const own = peek(rgDb, clock, (e) => e.listQuestions().find((q) => q.text === OWN)!);
    expect(own.status).toBe("open");

    // 第一天 11:00：话题对上，秘书标了"自己定时间会不会去"那一个（用自己的话问的），记问过
    clock.advanceTo(at(10, 10, 11, 0));
    await tell(frontend, WEEKEND_TALK);
    expect(peek(rgDb, clock, (e) => e.listQuestions({ status: "asked" }).map((q) => q.id))).toEqual([own.id]);
    // 用户隐含地答了：白天的规则认不出，不动（以前到第二天就记成问了没答）
    clock.advanceTo(at(10, 10, 11, 5));
    await tell(frontend, "我就是不喜欢别人替我安排");
    clock.advanceTo(at(10, 10, 11, 10));
    await tell(frontend, "帮我查一下明天上海的天气");
    expect(peek(rgDb, clock, (e) => e.listQuestions().find((q) => q.id === own.id)!.status)).toBe("asked");

    // 第一夜 03:00：记忆管理员看问过以后用户说的两句——答了：回答回写成本人证据（出处是那句话的素材），同一夜按判法判
    clock.advanceTo(at(10, 11, 3, 0));
    await td.daemon.internalJobs.whenIdle();
    expect(replies).toHaveLength(1);
    expect(replies[0]!.user).toContain(OWN);
    expect(replies[0]!.user).toContain("上回推掉的那个活动，要是时间全由你来定");
    expect(replies[0]!.user).toContain("「我就是不喜欢别人替我安排」");
    expect(replies[0]!.user).toContain("「帮我查一下明天上海的天气」");
    const [answerMaterial] = td.daemon.materials.searchKeyword("不喜欢别人替我安排");
    const first = peek(rgDb, clock, (e) => {
      const q = e.listQuestions().find((x) => x.id === own.id)!;
      return { q, evidence: e.store.getEvidence(q.answerEvidenceId!), trail: e.gate.history(own.id) };
    });
    expect(first.q).toMatchObject({ status: "resolved", verdict: "yes" });
    expect(first.evidence).toMatchObject({ sourceLevel: "self", sourceRef: answerMaterial!.id });
    expect(first.trail).toEqual(expect.arrayContaining([expect.objectContaining({ op: "verdict", actor: "user_verdict", via: VIA_NIGHT })]));
    const night1 = nightlyRecords(td).at(-1)!;
    expect(night1).toMatchObject({ state: "ran", night: "2026-10-11" });
    expect(night1.spend?.replies).toBe(1);
    expect(night1.text).toContain(`答了 ${own.id}`);

    // 第二天：问了"要不要少排一些"那一个，用户说的是别的事
    clock.advanceTo(at(10, 11, 10, 0));
    await tell(frontend, WEEKEND_TALK);
    const [lighter] = peek(rgDb, clock, (e) => e.listQuestions({ status: "asked" }));
    expect(lighter).toBeDefined();
    clock.advanceTo(at(10, 11, 10, 5));
    await tell(frontend, "帮我订一张周六去杭州的火车票");
    // 第二夜：判成没在答，算跳过一次（回到问题箱）
    clock.advanceTo(at(10, 12, 3, 0));
    await td.daemon.internalJobs.whenIdle();
    expect(replies).toHaveLength(2);
    const skipped = peek(rgDb, clock, (e) => e.listQuestions().find((q) => q.id === lighter!.id)!);
    expect(skipped).toMatchObject({ status: "open", skippedCount: 1 });
    expect(skipped.history.at(-1)!.detail).toContain("记忆管理员夜里看了问过以后用户说的话");

    // 第三天：又问了一次，用户只说了句"还行吧"——第三夜拿不准，留到下一夜（问题还等着回答）
    clock.advanceTo(at(10, 12, 10, 0));
    await tell(frontend, WEEKEND_TALK);
    clock.advanceTo(at(10, 12, 10, 5));
    await tell(frontend, "还行吧");
    clock.advanceTo(at(10, 13, 3, 0));
    await td.daemon.internalJobs.whenIdle();
    expect(replies).toHaveLength(3);
    const unsure = peek(rgDb, clock, (e) => e.listQuestions().find((q) => q.id === lighter!.id)!);
    expect(unsure).toMatchObject({ status: "asked", skippedCount: 1 });
    expect(unsure.history.at(-1)).toMatchObject({ event: "unsure" });

    // 第四天：用户自己又说起了；第四夜再判，这次判成在答
    clock.advanceTo(at(10, 13, 10, 0));
    await tell(frontend, "最近事情确实太多了，下周别给我排太满");
    clock.advanceTo(at(10, 14, 3, 0));
    await td.daemon.internalJobs.whenIdle();
    expect(replies).toHaveLength(4);
    expect(replies[3]!.user).toContain("「还行吧」");
    expect(replies[3]!.user).toContain("「最近事情确实太多了，下周别给我排太满」");
    const answered = peek(rgDb, clock, (e) => e.listQuestions().find((q) => q.id === lighter!.id)!);
    expect(answered.status).toMatch(/answered|resolved/);
    expect(answered.verdict).toBe("yes");

    // 记忆页的问题箱：经过里看得到夜里拿不准的那一笔
    const item = (await memoryApi.questions(td.url)).body.items.find((i) => i.id === lighter!.id)!;
    expect(item.history.map((h) => h.event)).toEqual(expect.arrayContaining(["asked", "skipped", "unsure", "answered"]));
  });
});
