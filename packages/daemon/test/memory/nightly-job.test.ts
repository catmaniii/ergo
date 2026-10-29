// 225 号票：每晚 03:00 的记忆整理作业（假模型、假向量、真 MemoryEngine + 临时目录里的 sqlite、真事件日志）。
// 覆盖：到点/未到点、用户在用往后推（最多到 05:00）、预算用完下次接着做、整理失败不影响素材库、
// 没配模型 key 就跳过并记原因、推理库要重建时只提示一次、停用（abort）时正在推后的那一次马上停。
// 236 号票：抽事实默认走模型版（LlmFactExtractor，和推理同一个假模型、同一份预算），配置开关换成规则版，
// 抽取的输出被截断时这一夜照跑（记进 dropped，不进待我处理）。
import fs from "node:fs";
import path from "node:path";
import { type InboxItem, nowIso } from "@ergo/protocol";
import { type ChatModel, type ChatRequest, type ChatResponse, type Embedder as MemoryEmbedder, FakeChatModel, type FullRejudgeProgress, type GraphValidator, graphSelfCheck, undoFullRejudge } from "@ergo/memory";
import { onTestFinished, describe, expect, it } from "vitest";
import { openEventStore } from "../../src/events/event-store.ts";
import type { NewInboxItem } from "../../src/inbox/inbox.ts";
import type { Material } from "../../src/materials/types.ts";
import type { SensitiveCategory } from "../../src/config/config.ts";
import { kernelEmbedderAdapter } from "../../src/memory/embedder-adapter.ts";
import { openReasoningDb } from "../../src/memory/rg-db.ts";
import { consolidationText } from "../../src/memory/curator-tools.ts";
import { createMemoryNightlyJob, MEMORY_NIGHTLY_FAILED_NOTICE, MEMORY_NIGHTLY_JOB } from "../../src/memory/nightly-job.ts";
import { MEMORY_NIGHTLY_EVENT, memoryNightlyView, type MemoryNightlyRecord } from "../../src/memory/nightly-record.ts";
import { INTERNAL_CHANNEL } from "../../src/scheduler/internal-jobs.ts";
import { clockIso } from "../../src/scheduler/clock.ts";
import { openDatabase } from "../../src/storage/sqlite.ts";
import { ManualClock } from "../helpers/clock.ts";
import { FakeEmbedder } from "../helpers/embedder.ts";
import { makeTempDir } from "../helpers/temp-dir.ts";

/** 本地时间 2026 年 m 月 d 日 hh:mm */
const at = (m: number, d: number, hh: number, mm = 0) => new Date(2026, m - 1, d, hh, mm);
/** 等异步的那几步走完（假模型是立即回，但 runNightly 里还有几个 await） */
const flush = () => new Promise((resolve) => setTimeout(resolve, 5));

let seq = 0;
/** 一条本人的素材（记忆适配器读它变成一条证据） */
function say(id: string, text: string, when: Date, context: string[] = ["weekend", "social"]): Material {
  seq += 1;
  const time = nowIso(when);
  return {
    id,
    kind: "user_utterance",
    mode: "say",
    time,
    conversation: "secretary",
    task: null,
    project: null,
    source: "self",
    ref: { event: { globalSeq: seq, channel: "secretary", seq, type: "message" } },
    context,
    segments: [{ form: "typed", source: "self", notes: [], locator: {}, text, sha256: `h-${seq}` }],
    original: null,
    noInfer: false,
  };
}

/**
 * 模型版抽取器的回复（236）：这一批每条证据抽一条"喜欢周末自己安排时间"的事实。
 * 宾语带上证据 id，免得几条证据抽出来的事实并成一条（并了也没有两条观察，推理那步不会问模型）。
 */
function extractedFacts(request: ChatRequest): unknown {
  const ids = [...request.user.matchAll(/"evidence_id":"(ev-\d+)"/g)].map((m) => m[1]!);
  return {
    facts: ids.map((id) => ({
      evidence_id: id,
      predicate: "prefers",
      object: { name: `周末自己安排时间（${id}）`, type: "activity" },
      negated: false,
      context: ["weekend"],
      statement: `用户想自己安排周末（${id}）`,
      span: "周末想好好休息",
    })),
  };
}

/** rg_manifest 的键值（看抽事实的实现记的是哪个） */
function manifestOf(t: ReturnType<typeof setup>): Record<string, string> {
  return t.withDb((db) => Object.fromEntries(db.all<{ key: string; value: string }>("SELECT key, value FROM rg_manifest").map((row) => [row.key, row.value])));
}

/** rg.db 里这一夜的整理报告（@ergo/memory 写的完整报告） */
function reportAt(t: ReturnType<typeof setup>, night: string): Record<string, unknown> & { reflect: { dropped: { stage: string; reason: string }[]; budgetExhausted: boolean; processedEvidenceIds: string[] } } {
  return t.withDb((db) => JSON.parse(db.get<{ report: string }>("SELECT report FROM nightly_runs WHERE night = ?", night)!.report));
}

/** 假待我处理：记下每一条，够作业用（add / get） */
function fakeInbox(clock: () => string) {
  const items: InboxItem[] = [];
  return {
    items,
    inbox: {
      get: (id: string) => items.find((item) => item.id === id),
      add: (input: NewInboxItem): InboxItem => {
        const common = { id: input.id ?? `i-${items.length + 1}`, version: 1, title: input.title, source: input.source, urgency: input.urgency, pinned: input.pinned ?? false, createdAt: clock(), read: false, archived: false, deleted: false };
        const item: InboxItem =
          input.kind === "notice"
            ? { ...common, kind: "notice", notice: input.notice, actions: input.actions ?? [], ...(input.body === undefined ? {} : { body: input.body }) }
            : { ...common, kind: "card", cardId: input.cardId };
        items.push(item);
        return item;
      },
    },
  };
}

interface SetupOptions {
  at?: Date;
  materials?: Material[];
  maxModelCalls?: number;
  /** 237 号票：这一夜的墙钟上限（分钟）；不给是 60 */
  nightlyTimeoutMinutes?: number;
  /** 抽事实用哪个（236）：不给是 model（默认） */
  extractor?: "model" | "rule";
  /** 234 号票：允许用来推断的敏感类别（默认空 = 健康这类记录、不推断） */
  sensitiveCategories?: readonly SensitiveCategory[];
  /** null = 不给模型（按 DEEPSEEK_API_KEY 建）；不给 = 假模型 */
  chat?: (() => ChatModel) | null;
  env?: Record<string, string | undefined>;
  /** 向量函数（235：不给 FakeEmbedder，能模拟"模型文件不在"） */
  embedder?: MemoryEmbedder;
  /** 267 号票：整理完跑的推理图谱校验器（插件给的是 graphSelfCheck；测试里有假的） */
  validator?: GraphValidator;
}

function setup(options: SetupOptions = {}) {
  const clock = new ManualClock(options.at ?? at(10, 10, 3, 0));
  const dir = makeTempDir("ergo-nightly-job-");
  const store = openEventStore({ file: path.join(dir, "ergo.db"), views: [memoryNightlyView], now: () => clockIso(clock), log: () => {} });
  onTestFinished(() => store.close());
  const materials = options.materials ?? [];
  const { items, inbox } = fakeInbox(() => clockIso(clock));
  const model = { calls: [] as string[], respond: (() => ({})) as (request: ChatRequest) => unknown };
  const chat =
    options.chat === null
      ? undefined
      : (options.chat ??
        (() =>
          new FakeChatModel((request) => {
            model.calls.push(request.purpose);
            return model.respond(request);
          })));
  const config = { maxModelCalls: options.maxModelCalls ?? 200, extractor: options.extractor ?? ("model" as const), sensitiveCategories: options.sensitiveCategories ?? [], enabled: true, nightlyTimeoutMinutes: options.nightlyTimeoutMinutes ?? 60, curator: { maxModelCalls: 8 } };
  const handle = createMemoryNightlyJob({
    file: path.join(dir, "db", "rg.db"),
    materials: { list: () => materials },
    clock,
    store,
    inbox,
    config,
    model: "deepseek-flash",
    env: options.env ?? {},
    ...(options.embedder === undefined ? {} : { embedder: options.embedder }),
    ...(chat === undefined ? {} : { chat }),
    ...(options.validator === undefined ? {} : { validator: options.validator }),
    log: () => {},
  });
  onTestFinished(async () => {
    handle.abort();
    await handle.whenIdle();
  });
  const records = (): MemoryNightlyRecord[] => store.read(INTERNAL_CHANNEL, 0, MEMORY_NIGHTLY_EVENT).map((event) => event.payload as MemoryNightlyRecord);
  const recordAt = (night: string): MemoryNightlyRecord | undefined => {
    const row = store.reader.get<{ record: string }>("SELECT record FROM memory_nightly WHERE night = ?", night);
    return row === undefined ? undefined : (JSON.parse(row.record) as MemoryNightlyRecord);
  };
  /** 打开 rg.db 看一眼（作业跑完会随手关掉） */
  const withDb = <T>(fn: (db: ReturnType<typeof openDatabase>) => T): T => {
    const db = openDatabase(path.join(dir, "db", "rg.db"));
    try {
      return fn(db);
    } finally {
      db.close();
    }
  };
  const signal = new AbortController().signal;
  return { clock, dir, store, materials, items, inbox, config, model, handle, records, recordAt, withDb, signal, file: path.join(dir, "db", "rg.db") };
}

describe("每晚 03:00 的记忆整理作业", () => {
  it("到点（03:00）整理一次：事件日志、整理记录、rg.db 里的报告都有；同一夜再跑只记一条已跑过", async () => {
    const t = setup({
      materials: [
        say("mat-1", "这周六的聚会我就不去了，最近周末想好好休息。", at(10, 9, 20, 0)),
        say("mat-2", "我不反感见朋友，只是不喜欢周末被提前排满。", at(10, 9, 22, 0)),
      ],
    });
    const record = await t.handle.run("scheduled", t.signal);
    expect(record).toMatchObject({ state: "ran", night: "2026-10-10", trigger: "scheduled", budgetExhausted: false, processedEvidence: 2, pendingEvidence: 0 });
    expect(record!.night).toBe("2026-10-10");
    expect(typeof record!.newClaims).toBe("number");
    expect(t.records()).toHaveLength(1);
    expect(t.recordAt("2026-10-10")).toEqual(record);
    // rg.db 里：两条证据都进了库，这一夜的报告记着处理了它们（真 MemoryEngine）
    t.withDb((db) => {
      expect(Number(db.get<{ n: number }>("SELECT COUNT(*) AS n FROM evidence")?.n)).toBe(2);
      const run = db.get<{ report: string }>("SELECT report FROM nightly_runs WHERE night = '2026-10-10'");
      expect(run).toBeDefined();
      expect(JSON.parse(run!.report).reflect.processedEvidenceIds).toHaveLength(2);
    });
    // 待我处理里没有事项（成功了不出声）
    expect(t.items).toEqual([]);

    // 同一夜再来一次（启动补跑）：已跑过，不重复整理
    const again = await t.handle.run("catch_up", t.signal);
    expect(again).toMatchObject({ state: "deferred" });
    expect(again!.reason).toContain("已经整理过");
    expect(t.records()).toHaveLength(2);
    expect(t.recordAt("2026-10-10")!.state).toBe("deferred");
  });

  it("没到点（02:00）：不整理，只记一条下次几点", async () => {
    const t = setup({ at: at(10, 10, 2, 0), materials: [say("mat-1", "周六在家看书。", at(10, 9, 20, 0))] });
    const record = await t.handle.run("scheduled", t.signal);
    expect(record).toMatchObject({ state: "deferred", night: "2026-10-10" });
    expect(record!.reason).toContain("还没到");
    expect(record!.modelCalls).toBe(0);
    t.withDb((db) => expect(Number(db.get<{ n: number }>("SELECT COUNT(*) AS n FROM nightly_runs")?.n)).toBe(0));
  });

  it("用户在用就往后推 30 分钟，推到 05:00 不再推、照跑（记 late 和推了几次）", async () => {
    const t = setup({ materials: [say("mat-1", "还在外面，刚到家。", at(10, 10, 2, 50))] });
    const pending = t.handle.run("scheduled", t.signal);
    await flush();
    expect(t.records().at(-1)).toMatchObject({ state: "deferred" });
    expect(t.records().at(-1)!.reason).toContain("正在用");

    t.materials.push(say("mat-2", "刚和朋友聊完。", at(10, 10, 3, 25)));
    t.clock.advanceTo(at(10, 10, 3, 30));
    await flush();
    expect(t.records().at(-1)!.state).toBe("deferred");

    t.materials.push(say("mat-3", "又说了两句。", at(10, 10, 3, 55)));
    t.clock.advanceTo(at(10, 10, 4, 0));
    await flush();
    expect(t.records().at(-1)!.state).toBe("deferred");

    t.materials.push(say("mat-4", "还在用。", at(10, 10, 4, 25)));
    t.clock.advanceTo(at(10, 10, 4, 30));
    await flush();
    expect(t.records().at(-1)!.state).toBe("deferred");
    expect(t.records().at(-1)!.reason).toContain("05:00");

    t.clock.advanceTo(at(10, 10, 5, 0));
    const record = await pending;
    expect(record).toMatchObject({ state: "ran", late: true });
    expect(record!.deferrals).toBe(4);
    expect(record!.modelCalls).toBeGreaterThanOrEqual(0);
  });

  it("模型版抽事实：和推理用同一个模型，抽出来的事实进库，manifest 记 model:<名>", async () => {
    const t = setup({
      materials: [
        say("mat-1", "这周六的聚会我就不去了，最近周末想好好休息。", at(10, 9, 20, 0)),
        say("mat-2", "我不反感见朋友，只是不喜欢周末被提前排满。", at(10, 9, 22, 0)),
      ],
    });
    t.model.respond = (request) => (request.purpose === "extract" ? extractedFacts(request) : {});
    const record = await t.handle.run("scheduled", t.signal);
    expect(record).toMatchObject({ state: "ran", processedEvidence: 2, pendingEvidence: 0 });
    // 抽事实真的问了模型（一批两条证据发一次），而且算在这一次整理的调用次数里
    expect(t.model.calls.filter((purpose) => purpose === "extract")).toHaveLength(1);
    expect(record!.modelCalls).toBe(t.model.calls.length);
    expect(t.items).toEqual([]);
    // 事实是模型版抽的（extracted_by = model:<名>），manifest 也记着它
    t.withDb((db) => {
      const facts = db.all<{ statement: string; extracted_by: string }>("SELECT statement, extracted_by FROM facts");
      expect(facts.map((f) => f.statement).toSorted()).toEqual(["用户想自己安排周末（ev-0001）", "用户想自己安排周末（ev-0002）"]);
      expect(facts.map((f) => f.extracted_by)).toEqual(["model:fake-llm", "model:fake-llm"]);
    });
    expect(manifestOf(t).extractor).toBe("model:fake-llm");
  });

  it("memory.extractor = rule：抽事实不调模型，规则版照常抽（manifest 记 rule:4.1）", async () => {
    const t = setup({
      extractor: "rule",
      materials: [
        say("mat-1", "这周六的聚会我就不去了，最近周末想好好休息。", at(10, 9, 20, 0)),
        say("mat-2", "我不反感见朋友，只是不喜欢周末被提前排满。", at(10, 9, 22, 0)),
      ],
    });
    const record = await t.handle.run("scheduled", t.signal);
    expect(record).toMatchObject({ state: "ran", processedEvidence: 2, pendingEvidence: 0 });
    // 抽事实这一步没问模型（推理那一步还是模型版）
    expect(t.model.calls).not.toContain("extract");
    t.withDb((db) => {
      const facts = db.all<{ extracted_by: string }>("SELECT extracted_by FROM facts");
      expect(facts.length).toBeGreaterThan(0);
      expect(facts.every((f) => f.extracted_by === "rule:4.1")).toBe(true);
    });
    expect(manifestOf(t).extractor).toBe("rule:4.1");
  });

  it("抽取的回复被截断、解析不了：这一夜照跑，丢掉的记进报告，不进待我处理", async () => {
    /** 抽事实的回复是半截 JSON 并且被标了截断，别的步骤照常回空 */
    const truncated: ChatModel = {
      name: "fake-llm",
      async complete(request: ChatRequest): Promise<ChatResponse> {
        const usage = { inputTokens: 1, outputTokens: 1 };
        if (request.purpose === "extract") return { content: '{"facts": [{"evidence_id": "ev-0001", "predicate": "prefers"', usage, truncated: true };
        return { content: "{}", usage };
      },
    };
    const t = setup({
      chat: () => truncated,
      materials: [
        say("mat-1", "这周六的聚会我就不去了，最近周末想好好休息。", at(10, 9, 20, 0)),
        say("mat-2", "我不反感见朋友，只是不喜欢周末被提前排满。", at(10, 9, 22, 0)),
      ],
    });
    const record = await t.handle.run("scheduled", t.signal);
    // 整夜没有失败：证据照样算整理过，下一夜不用重来
    expect(record).toMatchObject({ state: "ran", processedEvidence: 2, pendingEvidence: 0, budgetExhausted: false });
    expect(t.items).toEqual([]);
    const report = reportAt(t, "2026-10-10");
    expect(report.reflect.dropped.filter((d) => d.stage === "extract")).toHaveLength(1);
    expect(report.reflect.dropped[0]!.reason).toContain("截断");
    t.withDb((db) => expect(Number(db.get<{ n: number }>("SELECT COUNT(*) AS n FROM facts")?.n)).toBe(0));
  });

  it("预算用完：这一次没做完（记下来），下一次整理接着做", async () => {
    const t = setup({
      maxModelCalls: 1,
      materials: [
        say("mat-1", "这周六的聚会我就不去了，最近周末想好好休息。", at(10, 9, 20, 0)),
        say("mat-2", "推掉了朋友安排得很紧凑的周末活动。", at(10, 9, 21, 0)),
        say("mat-3", "我不反感见朋友，只是不喜欢周末被提前排满。", at(10, 9, 22, 0)),
      ],
    });
    t.model.respond = (request) => (request.purpose === "extract" ? extractedFacts(request) : {});
    const first = await t.handle.run("scheduled", t.signal);
    // 只有 1 次预算：抽事实用掉了，整理那一步没轮到；这次不算整理过
    expect(first).toMatchObject({ state: "ran", budgetExhausted: true, processedEvidence: 0, pendingEvidence: 3 });
    expect(first!.modelCalls).toBe(1);
    expect(t.model.calls).toEqual(["extract"]);
    const report = reportAt(t, "2026-10-10");
    expect(report.reflect.budgetExhausted).toBe(true);
    expect(report.reflect.processedEvidenceIds).toEqual([]);

    // 第二夜预算够：上一夜没做完的证据这次处理掉了（抽过的不再抽），调了几次就记几次
    t.config.maxModelCalls = 200;
    t.clock.advanceTo(at(10, 11, 3, 0));
    const callsBefore = t.model.calls.length;
    const second = await t.handle.run("scheduled", t.signal);
    expect(second).toMatchObject({ state: "ran", budgetExhausted: false, processedEvidence: 3, pendingEvidence: 0 });
    expect(second!.modelCalls).toBe(t.model.calls.length - callsBefore);
    expect(t.model.calls.slice(callsBefore)).not.toContain("extract");
    expect(reportAt(t, "2026-10-11").reflect.processedEvidenceIds).toHaveLength(3);
  });

  // 270 号票：线上 10-22 到 10-25 连着几夜"新证据 0 条"——旧追问每夜全部重判、新组的追问排在最后轮不上，记整理过又是全有或全无
  it("270：预算紧时新证据先——新组的追问先问，旧追问没有新东西不重判；整理完的新证据记下来，记录里有每一道的调用数", async () => {
    const topics = ["皮划艇", "羽毛球", "电子琴", "攀岩馆"];
    const topicOf = (text: string) => topics.find((k) => text.includes(k));
    const asked: string[] = [];
    const t = setup({
      materials: topics.slice(0, 3).flatMap((topic, i) => [
        say(`mat-${i}a`, `这周我又去弄了${topic}，挺喜欢的。`, at(10, 6 + i, 9, 0), ["leisure"]),
        say(`mat-${i}b`, `周末还想接着弄${topic}。`, at(10, 6 + i, 21, 0), ["leisure"]),
      ]),
    });
    t.model.respond = (request) => {
      if (request.purpose === "extract") {
        const lines = request.user.split("\n").filter((line) => line.startsWith("{"));
        return {
          facts: lines.map((line) => {
            const e = JSON.parse(line) as { evidence_id: string; text: string };
            const topic = topicOf(e.text)!;
            return { evidence_id: e.evidence_id, predicate: "prefers", object: { name: `${topic}（${e.evidence_id}）`, type: "activity" }, negated: false, context: ["leisure"], statement: `用户喜欢${topic}（${e.evidence_id}）`, span: topic };
          }),
        };
      }
      if (request.purpose === "propose") {
        const batch = request.user.split("这一批的观察")[1]!.split("别的事实")[0]!;
        const byTopic = new Map<string, string[]>();
        for (const line of batch.split("\n").filter((l) => l.startsWith("{"))) {
          const f = JSON.parse(line) as { fact_id: string; evidence: { text: string }[] };
          const topic = topicOf(f.evidence.map((e) => e.text).join(""));
          if (topic) byTopic.set(topic, [...(byTopic.get(topic) ?? []), f.fact_id]);
        }
        return {
          groups: [...byTopic]
            .filter(([, facts]) => facts.length >= 2)
            .map(([topic, facts]) => ({
              observation_ids: facts,
              description: `${topic}这件事`,
              hypotheses: [
                { tier: "preference", statement: `用户喜欢${topic}`, context: ["leisure"], supports: [], refutes: [] },
                { tier: "state", statement: `用户最近在试${topic}`, context: ["leisure"], valid_to: null, supports: [], refutes: [] },
              ],
            })),
        };
      }
      if (request.purpose === "probes") {
        const topic = topicOf(request.user)!;
        const claims = [...request.user.matchAll(/"claim_id":"(cl-\d+)"/g)].map((m) => m[1]!);
        return { probes: [1, 2, 3].map((i) => ({ discriminates: [claims[0], claims[1]], ask: `${topic}第${i}问`, queries: [topic], if_found: claims[0] })) };
      }
      if (request.purpose === "judge") {
        asked.push(/追问：(\S+?)（/.exec(request.user)![1]!);
        return { found_evidence_ids: [], if_found: null, links: [] };
      }
      return {};
    };
    const first = await t.handle.run("scheduled", t.signal);
    expect(first).toMatchObject({ state: "ran", processedEvidence: 6, pendingEvidence: 0 });
    expect(asked).toHaveLength(9);

    // 第二夜：新话题两条；预算只有 8 次（前段 6 次 = 抽事实 1 + 出假设 1 + 新组出追问 1 + 新组三条追问 3）
    asked.length = 0;
    t.materials.push(say("mat-n1", "这周我又去弄了攀岩馆，挺喜欢的。", at(10, 10, 9, 0), ["leisure"]), say("mat-n2", "周末还想接着弄攀岩馆。", at(10, 10, 21, 0), ["leisure"]));
    t.config.maxModelCalls = 8;
    t.clock.advanceTo(at(10, 11, 3, 0));
    const second = await t.handle.run("scheduled", t.signal);
    // 以前：九条旧追问按建组先后排在前面，前段用光、新组的一条没问，新证据 0 条
    expect(asked).toEqual(["攀岩馆第1问", "攀岩馆第2问", "攀岩馆第3问"]);
    expect(second).toMatchObject({ state: "ran", processedEvidence: 2, pendingEvidence: 0 });
    const spend = second!.spend!;
    expect(spend).toMatchObject({ limit: 8, newEvidence: 6, rejudge: 0, review: 0 });
    expect(spend.newEvidence + spend.rejudge + spend.lift + spend.predictions + spend.strategies + spend.review).toBe(second!.modelCalls);
    expect(second!.text).toContain("新证据整理完 2 条、还积压 0 条");
    expect(second!.text).toContain("预算：调了");
  });

  // 235 号票：用户不用等到 03:00，"立即整理一次"走同一份作业（同一个引擎、同一份预算、同一条整理记录）
  it("手动整理一次：没到 03:00 也跑、记一条 manual 的记录、受同一份预算约束；不吃那一夜的定时水位（同一天 03:00 照常跑）", async () => {
    const t = setup({
      at: at(10, 10, 1, 0),
      maxModelCalls: 1,
      materials: [
        say("mat-1", "这周六的聚会我就不去了，最近周末想好好休息。", at(10, 9, 20, 0)),
        say("mat-2", "推掉了朋友安排得很紧凑的周末活动。", at(10, 9, 21, 0)),
        say("mat-3", "我不反感见朋友，只是不喜欢周末被提前排满。", at(10, 9, 22, 0)),
      ],
    });
    t.model.respond = (request) => (request.purpose === "extract" ? extractedFacts(request) : {});
    const record = await t.handle.runNow();
    // 01:00 还没到 03:00 也跑了：trigger 是 manual、不算 late、推后 0 次
    expect(record).toMatchObject({ state: "ran", night: "2026-10-10", trigger: "manual", late: false, deferrals: 0 });
    // 预算照旧：1 次留给抽事实，整理那一步没轮到
    expect(record!.budgetExhausted).toBe(true);
    expect(record!.modelCalls).toBe(1);
    // 同一条整理记录（视图里那一夜就是它）、没有"失败"事项
    expect(t.recordAt("2026-10-10")).toEqual(record);
    expect(t.items).toEqual([]);
    // 手动没有把那一夜写成"已经整理过"：同一天 03:00 的定时那次照常跑，把没做完的接着做完
    t.config.maxModelCalls = 200;
    t.clock.advanceTo(at(10, 10, 3, 0));
    const scheduled = await t.handle.run("scheduled", t.signal);
    expect(scheduled).toMatchObject({ state: "ran", night: "2026-10-10", trigger: "scheduled", processedEvidence: 3, pendingEvidence: 0 });
    expect(t.recordAt("2026-10-10")!.trigger).toBe("scheduled");
  });

  it("手动整理是增量的：连点两次第二次不重复处理、不多出结论；同一天 03:00 照常跑、只处理这期间的新素材", async () => {
    const t = setup({
      at: at(10, 10, 1, 0),
      materials: [
        say("mat-1", "这周六的聚会我就不去了，最近周末想好好休息。", at(10, 9, 20, 0)),
        say("mat-2", "我不反感见朋友，只是不喜欢周末被提前排满。", at(10, 9, 22, 0)),
      ],
    });
    t.model.respond = (request) => (request.purpose === "extract" ? extractedFacts(request) : {});
    const first = await t.handle.runNow();
    expect(first).toMatchObject({ state: "ran", night: "2026-10-10", trigger: "manual", processedEvidence: 2, pendingEvidence: 0 });
    const claims = t.withDb((db) => Number(db.get<{ n: number }>("SELECT COUNT(*) AS n FROM claims")?.n));
    const callsAfterFirst = t.model.calls.length;

    // 同一分钟再点：照样跑（不受"这一夜跑过了"拦），但引擎的增量让它什么都不用做
    const second = await t.handle.runNow();
    expect(second).toMatchObject({ state: "ran", night: "2026-10-10", trigger: "manual", processedEvidence: 0, pendingEvidence: 0, newClaims: 0, changedClaims: 0 });
    expect(second!.modelCalls).toBe(0);
    expect(t.model.calls.length).toBe(callsAfterFirst);
    t.withDb((db) => expect(Number(db.get<{ n: number }>("SELECT COUNT(*) AS n FROM claims")?.n)).toBe(claims));

    // 这期间用户又说了一句：同一天 03:00 的定时那次照常跑（不是 already_ran），只处理这一条增量
    t.materials.push(say("mat-3", "周日想在家待着，不想出门。", at(10, 10, 2, 30)));
    t.clock.advanceTo(at(10, 10, 3, 0));
    const scheduled = await t.handle.run("scheduled", t.signal);
    expect(scheduled).toMatchObject({ state: "ran", night: "2026-10-10", trigger: "scheduled", processedEvidence: 1, pendingEvidence: 0 });

    // 次日 03:00 照常跑（不是 already_ran），只处理这一天的增量
    t.materials.push(say("mat-4", "周一早上要开会，有点紧张。", at(10, 10, 20, 0)));
    t.clock.advanceTo(at(10, 11, 3, 0));
    const nextDay = await t.handle.run("scheduled", t.signal);
    expect(nextDay).toMatchObject({ state: "ran", night: "2026-10-11", trigger: "scheduled", processedEvidence: 1, pendingEvidence: 0 });
  });

  it("手动整理一次：03:00 已经跑过的那一夜照样能跑（记 manual），那一夜的水位不动", async () => {
    const t = setup({
      at: at(10, 10, 3, 0),
      materials: [say("mat-1", "这周六的聚会我就不去了，最近周末想好好休息。", at(10, 9, 20, 0))],
    });
    t.model.respond = (request) => (request.purpose === "extract" ? extractedFacts(request) : {});
    const scheduled = await t.handle.run("scheduled", t.signal);
    expect(scheduled).toMatchObject({ state: "ran", trigger: "scheduled", processedEvidence: 1 });
    // 白天再点：照样跑（不报"今天已经整理过"），没有新素材就是一次便宜的增量
    t.clock.advanceTo(at(10, 10, 10, 0));
    const manual = await t.handle.runNow();
    expect(manual).toMatchObject({ state: "ran", night: "2026-10-10", trigger: "manual", processedEvidence: 0, pendingEvidence: 0 });
    expect(manual!.modelCalls).toBe(0);
    // 那一夜的定时水位还是"已经整理过"：再跑一次定时照旧说 already_ran
    const again = await t.handle.run("scheduled", t.signal);
    expect(again).toMatchObject({ state: "deferred" });
    expect(again!.reason).toContain("已经整理过");
  });

  it("整理失败：进待我处理一条、素材和证据一条不少，下一夜接着做", async () => {
    const t = setup({
      materials: [
        say("mat-1", "这周六的聚会我就不去了，最近周末想好好休息。", at(10, 9, 20, 0)),
        say("mat-2", "我不反感见朋友，只是不喜欢周末被提前排满。", at(10, 9, 22, 0)),
      ],
    });
    t.model.respond = () => {
      throw new Error("模型坏了");
    };
    const failed = await t.handle.run("scheduled", t.signal);
    expect(failed).toMatchObject({ state: "failed", night: "2026-10-10" });
    expect(failed!.reason).toContain("模型坏了");
    expect(t.items).toHaveLength(1);
    expect(t.items[0]).toMatchObject({ kind: "notice", notice: MEMORY_NIGHTLY_FAILED_NOTICE });
    expect((t.items[0] as { body?: string }).body).toContain("模型坏了");
    // 素材和证据都还在（素材是只读的，证据已经落进 rg.db）
    expect(t.materials).toHaveLength(2);
    t.withDb((db) => expect(Number(db.get<{ n: number }>("SELECT COUNT(*) AS n FROM evidence")?.n)).toBe(2));

    // 下一夜模型好了：整理成功，不再多一条失败事项
    t.model.respond = () => ({});
    t.clock.advanceTo(at(10, 11, 3, 0));
    const ok = await t.handle.run("scheduled", t.signal);
    expect(ok).toMatchObject({ state: "ran", night: "2026-10-11" });
    expect(t.items).toHaveLength(1);
  });

  // 235 号票：四条降级之四——整理跑一半崩（抽事实成了、推理那步模型坏了）：已写的不丢，下一夜接着做
  it("整理跑一半崩：已经写进库的证据和事实不丢，下一夜接着做，抽过的不再重抽", async () => {
    const t = setup({
      materials: [
        say("mat-1", "这周六的聚会我就不去了，最近周末想好好休息。", at(10, 9, 20, 0)),
        say("mat-2", "我不反感见朋友，只是不喜欢周末被提前排满。", at(10, 9, 22, 0)),
      ],
    });
    // 抽事实那一步好好回，往上的推理那一步坏掉
    t.model.respond = (request) => {
      if (request.purpose === "extract") return extractedFacts(request);
      throw new Error("推理模型坏了");
    };
    const failed = await t.handle.run("scheduled", t.signal);
    expect(failed).toMatchObject({ state: "failed", night: "2026-10-10" });
    expect(failed!.reason).toContain("推理模型坏了");
    expect(t.items).toHaveLength(1);
    // 已经写进去的：两条证据、两条抽出来的事实都还在（素材本来就是只读的）
    expect(t.materials).toHaveLength(2);
    t.withDb((db) => {
      expect(Number(db.get<{ n: number }>("SELECT COUNT(*) AS n FROM evidence")?.n)).toBe(2);
      expect(Number(db.get<{ n: number }>("SELECT COUNT(*) AS n FROM facts")?.n)).toBe(2);
    });

    // 下一夜模型好了：接着做没做完的，证据一条不少，抽过的事实不再重抽
    t.model.respond = (request) => (request.purpose === "extract" ? extractedFacts(request) : {});
    const callsBefore = t.model.calls.length;
    t.clock.advanceTo(at(10, 11, 3, 0));
    const ok = await t.handle.run("scheduled", t.signal);
    expect(ok).toMatchObject({ state: "ran", night: "2026-10-11", processedEvidence: 2, pendingEvidence: 0 });
    expect(t.model.calls.slice(callsBefore)).not.toContain("extract");
    expect(t.items).toHaveLength(1);
  });

  it("没配 DEEPSEEK_API_KEY：跳过整理、记下原因，不建库、不调模型、不打扰用户；素材一条不丢，下一夜配上 key 照常整理", async () => {
    const t = setup({ chat: null, env: {}, materials: [say("mat-1", "随便说一句。", at(10, 9, 20, 0))] });
    const record = await t.handle.run("scheduled", t.signal);
    expect(record).toMatchObject({ state: "skipped", night: "2026-10-10" });
    expect(record!.reason).toContain("DEEPSEEK_API_KEY");
    expect(record!.modelCalls).toBe(0);
    expect(t.items).toEqual([]);
    expect(fs.existsSync(t.file)).toBe(false);

    // 下一夜配上 key（测试给假模型，不连真的 DeepSeek）：素材还在，照常整理、把攒下的都处理掉
    const calls: string[] = [];
    const second = createMemoryNightlyJob({
      file: t.file,
      materials: { list: () => t.materials },
      clock: t.clock,
      store: t.store,
      inbox: t.inbox,
      config: { ...t.config },
      model: "deepseek-flash",
      chat: () =>
        new FakeChatModel((request) => {
          calls.push(request.purpose);
          return request.purpose === "extract" ? extractedFacts(request) : {};
        }),
      log: () => {},
    });
    onTestFinished(async () => {
      second.abort();
      await second.whenIdle();
    });
    t.clock.advanceTo(at(10, 11, 3, 0));
    const next = await second.run("scheduled", t.signal);
    expect(next).toMatchObject({ state: "ran", night: "2026-10-11", processedEvidence: 1, pendingEvidence: 0 });
    expect(calls).toContain("extract");
    expect(t.materials).toHaveLength(1);
  });

  // 235 号票：四条降级之一——向量模型不在（用户没下载）时整理照常，不算向量、不报错
  it("向量模型不在：这一夜照常整理（不算向量、不报错），素材和证据都进库、不当成失败", async () => {
    const t = setup({
      embedder: kernelEmbedderAdapter(new FakeEmbedder({ available: false })),
      materials: [
        say("mat-1", "这周六的聚会我就不去了，最近周末想好好休息。", at(10, 9, 20, 0)),
        say("mat-2", "我不反感见朋友，只是不喜欢周末被提前排满。", at(10, 9, 22, 0)),
      ],
    });
    const record = await t.handle.run("scheduled", t.signal);
    expect(record).toMatchObject({ state: "ran", night: "2026-10-10", processedEvidence: 2, pendingEvidence: 0 });
    expect(record!.modelCalls).toBe(t.model.calls.length);
    // 成功的整理不出声（没有"向量模型不在"的通知）
    expect(t.items).toEqual([]);
    t.withDb((db) => expect(Number(db.get<{ n: number }>("SELECT COUNT(*) AS n FROM evidence")?.n)).toBe(2));
  });

  it("推理库要重建：不打开、进待我处理一条提示，第二夜不重复提醒", async () => {
    const t = setup({ materials: [] });
    const created = openReasoningDb({ file: t.file, clock: () => clockIso(t.clock), model: "deepseek-flash" });
    if (!created.ok) throw new Error("应该能建库");
    created.engine.close();
    const db = openDatabase(t.file);
    try {
      db.run("UPDATE rg_manifest SET value = '99' WHERE key = 'schema'");
    } finally {
      db.close();
    }
    const record = await t.handle.run("scheduled", t.signal);
    expect(record).toMatchObject({ state: "rebuild_needed", night: "2026-10-10" });
    expect(record!.reason).toContain("99");
    expect(t.items).toHaveLength(1);
    expect(t.items[0]).toMatchObject({ kind: "notice", notice: "memory_nightly_rebuild" });

    t.clock.advanceTo(at(10, 11, 3, 0));
    expect((await t.handle.run("scheduled", t.signal))!.state).toBe("rebuild_needed");
    expect(t.items).toHaveLength(1);
  });

  it("墙钟上限（237）：到点还没跑完就中止、记一条 failed（整理超时）+ 待我处理一条，whenIdle 返回，下一夜照常", async () => {
    let slow = true;
    const chat: ChatModel = {
      name: "fake-llm",
      async complete(): Promise<ChatResponse> {
        // 一次调用比上限（60 毫秒）久：超时在等模型的时候到点，模型回来时 abortableChat 把它拦下
        if (slow) await new Promise((resolve) => setTimeout(resolve, 150));
        return { content: "{}", usage: { inputTokens: 1, outputTokens: 1 } };
      },
    };
    const t = setup({ chat: () => chat, nightlyTimeoutMinutes: 0.001, materials: [say("mat-1", "这周六的聚会我就不去了。", at(10, 9, 20, 0))] });
    const record = await t.handle.run("scheduled", t.signal);
    expect(record).toMatchObject({ state: "failed", night: "2026-10-10" });
    expect(record!.reason).toContain("整理超时");
    expect(record!.reason).toContain("0.001");
    expect(t.items).toHaveLength(1);
    expect(t.items[0]).toMatchObject({ kind: "notice", notice: MEMORY_NIGHTLY_FAILED_NOTICE });
    expect((t.items[0] as { body?: string }).body).toContain("整理超时");
    // 被中止的那一次不算跑过，whenIdle 也真的返回了（上面 await 已经回来）
    await t.handle.whenIdle();

    // 下一夜照常：模型不慢了，整理成功，不再多一条失败事项
    slow = false;
    t.clock.advanceTo(at(10, 11, 3, 0));
    const ok = await t.handle.run("scheduled", t.signal);
    expect(ok).toMatchObject({ state: "ran", night: "2026-10-11" });
    expect(t.items).toHaveLength(1);
  }, 10_000);

  it("停用（abort）：正在推后的那一次马上停，不再排那一夜", async () => {
    const t = setup({ materials: [say("mat-1", "还在外面，刚到家。", at(10, 10, 2, 50))] });
    const pending = t.handle.run("scheduled", t.signal);
    await flush();
    expect(t.records().at(-1)!.state).toBe("deferred");
    t.handle.abort();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    await t.handle.whenIdle();
    // 那一夜没有整理记录（只有推后的那一条）
    expect(t.records().every((record) => record.state === "deferred")).toBe(true);
  });

  it("267 号票：整理完跑每晚校验——校验器拿到这一夜整理完的引擎；结果进整理记录（通过 / 跳过写明原因），写入口拒了几处也记下", async () => {
    const seen: number[] = [];
    const t = setup({
      materials: [say("mat-1", "这周六的聚会我就不去了，最近周末想好好休息。", at(10, 9, 20, 0)), say("mat-2", "我不反感见朋友，只是不喜欢周末被提前排满。", at(10, 9, 22, 0))],
      extractor: "rule",
      validator: {
        name: "假校验器",
        async validate(engine) {
          seen.push(engine.store.listEvidence().length);
          return { state: "skipped", reason: "这一夜不查" };
        },
      },
    });
    const record = await t.handle.run("scheduled", t.signal);
    expect(record).toMatchObject({ state: "ran", validation: { state: "skipped", problems: 0, claimIds: [], reason: "这一夜不查" }, refused: 0 });
    expect(seen).toEqual([2]);
    expect(record!.text).toContain("每晚校验：跳过（这一夜不查）");
  });

  it("329 号票（ADR-0032）：前提的事实后来真冲突了，明说的那条成了猜测、身份不改——整理记录里不再有\"结论 ↔ 假设\"，校验照样通过", async () => {
    const t = setup({ materials: [say("mat-1", "我喜欢吃辣", at(10, 9, 8, 0))], extractor: "rule", validator: graphSelfCheck });
    const first = await t.handle.run("scheduled", t.signal);
    expect(first).toMatchObject({ state: "ran" });
    expect(first!.hypotheses).toBeUndefined();
    t.materials.push(say("mat-2", "我不喜欢吃辣", at(10, 9, 20, 0)));
    t.clock.advanceTo(at(10, 11, 3, 0));
    const second = await t.handle.run("scheduled", t.signal);
    expect(second).toMatchObject({ state: "ran", validation: { state: "ok", problems: 0 } });
    expect(second!.hypotheses).toBeUndefined();
    expect(second!.text).not.toContain("结论 ↔ 假设");
    expect(consolidationText(second)).not.toContain("降成了假设");
    t.withDb((db) => {
      const stated = db.all<{ kind: string; status: string }>("SELECT kind, status FROM claims WHERE epistemic = 'explicit'");
      expect(stated.length).toBeGreaterThan(0);
      expect(stated.every((c) => c.kind === "conclusion")).toBe(true);
      expect(stated.some((c) => c.status === "contested")).toBe(true);
    });
  });

  it("326 号票：没装 Python、没有本机的 skill（环境变量全空）也照样做完校验——记忆系统自己的图谱自检，通过就记通过，不是跳过", async () => {
    const t = setup({
      materials: [say("mat-1", "这周六的聚会我就不去了，最近周末想好好休息。", at(10, 9, 20, 0)), say("mat-2", "我不反感见朋友，只是不喜欢周末被提前排满。", at(10, 9, 22, 0))],
      extractor: "rule",
      env: {},
      validator: graphSelfCheck,
    });
    const record = await t.handle.run("scheduled", t.signal);
    expect(record).toMatchObject({ state: "ran", validation: { state: "ok", problems: 0, claimIds: [] } });
    expect(record!.text).toMatch(/每晚校验：查了 \d+ 个节点，图谱自检通过/);
  });

  it("作业名和时间表是票里写的那个", () => {
    const t = setup({ materials: [] });
    expect(t.handle.job.name).toBe(MEMORY_NIGHTLY_JOB);
    expect(t.handle.job.name).toBe("memory-nightly");
    expect(t.handle.job.schedule).toEqual({ kind: "daily", time: "03:00" });
  });

  // 234 号票：敏感类别默认记录、不用于推断；配置里允许了才进证据
  it("敏感类别（健康）默认不进证据；配置里允许了才进", async () => {
    const off = setup({ materials: [say("mat-1", "周三体检", at(10, 9, 20, 0), [])] });
    await off.handle.run("scheduled", off.signal);
    off.withDb((db) => expect(Number(db.get<{ n: number }>("SELECT COUNT(*) AS n FROM evidence")?.n)).toBe(0));
    // 素材本身还在（默认允许记录）
    expect(off.materials).toHaveLength(1);

    const on = setup({ sensitiveCategories: ["health"], materials: [say("mat-1", "周三体检", at(10, 9, 20, 0), [])] });
    await on.handle.run("scheduled", on.signal);
    on.withDb((db) => expect(Number(db.get<{ n: number }>("SELECT COUNT(*) AS n FROM evidence")?.n)).toBe(1));
  });

  // 263 号票：线上每晚整理接上对抗复核（227）和判到期预测（226），和推理同一个模型
  it("对抗复核和判预测接上了：还没复核过的需求结论交给复核员（判不一致转待复核）、到期的预测交给模型判；次数和结果进整理记录", async () => {
    const t = setup({ materials: [say("mat-1", "这周六朋友排的聚会我又推掉了。", at(10, 9, 20, 0))] });
    seedNeedWithDuePrediction(t.file);
    t.model.respond = (request) => {
      if (request.purpose === "review") return { inference: "这个人周末想休息", support: "no", why: "这几句只说明最近累，看不出看重自己安排" };
      if (request.purpose === "prediction") return { outcome: "hit", why: "又推掉了朋友排的聚会" };
      return {};
    };
    const record = await t.handle.run("scheduled", t.signal);
    expect(record).toMatchObject({ state: "ran" });
    // 两步都真的问了模型（复核员一次、判预测一次），算在这一夜的调用次数里
    expect(t.model.calls.filter((purpose) => purpose === "review")).toHaveLength(1);
    expect(t.model.calls.filter((purpose) => purpose === "prediction")).toHaveLength(1);
    expect(record!.modelCalls).toBe(t.model.calls.length);
    expect(record!.review).toEqual({ reviewed: 1, rejected: 1, unclear: 0 });
    expect(record!.predictions).toMatchObject({ judged: 1, hit: 1, miss: 0, unclear: 0, open: 0 });
    expect(record!.text).toContain("对抗复核");
    // 库里：复核员不认的那条加了复核标记、真值状态不动（修订写着对抗复核不一致），预测判成应验
    t.withDb((db) => {
      expect(db.get<{ status: string; needs_review: number }>("SELECT status, needs_review FROM claims WHERE id = 'cl-0901'")).toMatchObject({ status: "active", needs_review: 1 });
      expect(db.get<{ reason: string }>("SELECT reason FROM revisions WHERE object_id = 'cl-0901' ORDER BY seq DESC LIMIT 1")!.reason).toContain("对抗复核不一致");
      expect(db.get<{ status: string; note: string }>("SELECT status, note FROM predictions WHERE id = 'pd-0901'")).toMatchObject({ status: "hit", note: "又推掉了朋友排的聚会" });
    });

    // 第二夜：判过的不再判、复核过的不再复核（各自只问一次模型）
    t.clock.advanceTo(at(10, 11, 3, 0));
    t.materials.push(say("mat-2", "周日在家看书。", at(10, 10, 20, 0)));
    const second = await t.handle.run("scheduled", t.signal);
    expect(second).toMatchObject({ state: "ran", review: { reviewed: 0, rejected: 0, unclear: 0 } });
    expect(t.model.calls.filter((purpose) => purpose === "review")).toHaveLength(1);
    expect(t.model.calls.filter((purpose) => purpose === "prediction")).toHaveLength(1);
  });
});

/**
 * 263 号票的例子：rg.db 里先放一条推断出来的需求结论（成立、把握中、两条本人原话支持，还没复核过）和它到期的一条预测
 * （9 月 20 日记的、10 月 4 日到期）。直接写库：评测之外很难靠规则版、假模型凑出一条往上抽的需求
 */
// 333 号票：全量重判一次走同一份引擎设置（同一个模型、写入口、敏感类别），不读新素材；模型外面包了计量，进度和花费对得上；能撤回
describe("333：全量重判一次（作业的 runFullRejudge）", () => {
  const topics = ["皮划艇", "羽毛球", "电子琴"];
  const topicOf = (text: string) => topics.find((k) => text.includes(k));

  /** 三个话题各两条素材；假模型一条证据一条观察、同一话题一组（喜欢 / 最近在试）、每组一条追问，判证据记下问了哪个话题 */
  function topicWorld() {
    const asked: string[] = [];
    const t = setup({
      materials: topics.flatMap((topic, i) => [
        say(`mat-${i}a`, `这周我又去弄了${topic}，挺喜欢的。`, at(10, 6 + i, 9, 0), ["leisure"]),
        say(`mat-${i}b`, `周末还想接着弄${topic}。`, at(10, 6 + i, 21, 0), ["leisure"]),
      ]),
    });
    t.model.respond = (request) => {
      if (request.purpose === "extract") {
        const lines = request.user.split("\n").filter((line) => line.startsWith("{"));
        return {
          facts: lines.map((line) => {
            const e = JSON.parse(line) as { evidence_id: string; text: string };
            const topic = topicOf(e.text)!;
            return { evidence_id: e.evidence_id, predicate: "prefers", object: { name: `${topic}（${e.evidence_id}）`, type: "activity" }, negated: false, context: ["leisure"], statement: `用户喜欢${topic}（${e.evidence_id}）`, span: topic };
          }),
        };
      }
      if (request.purpose === "propose") {
        const batch = request.user.split("这一批的观察")[1]!.split("别的事实")[0]!;
        const byTopic = new Map<string, string[]>();
        for (const line of batch.split("\n").filter((l) => l.startsWith("{"))) {
          const f = JSON.parse(line) as { fact_id: string; evidence: { text: string }[] };
          const topic = topicOf(f.evidence.map((e) => e.text).join(""));
          if (topic) byTopic.set(topic, [...(byTopic.get(topic) ?? []), f.fact_id]);
        }
        return {
          groups: [...byTopic]
            .filter(([, facts]) => facts.length >= 2)
            .map(([topic, facts]) => ({
              observation_ids: facts,
              description: `${topic}这件事`,
              hypotheses: [
                { tier: "preference", statement: `用户喜欢${topic}`, context: ["leisure"], supports: [{ target: facts[0], weight: "strong", rationale: "说喜欢" }], refutes: [] },
                { tier: "state", statement: `用户最近在试${topic}`, context: ["leisure"], valid_to: null, supports: [], refutes: [] },
              ],
            })),
        };
      }
      if (request.purpose === "probes") {
        const topic = topicOf(request.user)!;
        const claims = [...request.user.matchAll(/"claim_id":"(cl-\d+)"/g)].map((m) => m[1]!);
        return { probes: [{ discriminates: [claims[0], claims[1]], ask: `${topic}问一下`, queries: [topic], if_found: claims[0] }] };
      }
      if (request.purpose === "judge") {
        asked.push(topicOf(/追问：(\S+?)（/.exec(request.user)![1]!)!);
        return { found_evidence_ids: [], if_found: null, links: [] };
      }
      return {};
    };
    return { t, asked };
  }

  it("不读新素材、只重判标着复核的组；进度一步一行，最后一行的花费和报告、模型真调的次数一致；快照能撤回", async () => {
    const { t, asked } = topicWorld();
    expect(await t.handle.run("scheduled", t.signal)).toMatchObject({ state: "ran", processedEvidence: 6 });
    // 老代码留下的"待复核"状态（329 的迁移改成复核标记）：羽毛球那组的"喜欢"
    const claimId = t.withDb((db) => db.get<{ id: string }>("SELECT id FROM claims WHERE statement = '用户喜欢羽毛球'")!.id);
    t.withDb((db) => {
      db.run("UPDATE claims SET status = 'needs_review' WHERE id = ?", claimId);
      db.run("INSERT INTO revisions (object_type, object_id, op, changes, cause_evidence_id, reason, at) VALUES ('claim', ?, 'update', ?, NULL, '老代码转待复核', ?)", claimId, JSON.stringify({ status: { from: "contested", to: "needs_review" } }), clockIso(t.clock));
    });
    const claimsBefore = t.withDb((db) => db.all("SELECT id, status, confidence FROM claims ORDER BY id"));
    // 新来的素材：全量重判不读它
    t.materials.push(say("mat-new", "这周我又去弄了电子琴。", at(10, 10, 9, 0), ["leisure"]));
    t.clock.advanceTo(at(10, 10, 13, 0));
    asked.length = 0;
    const callsBefore = t.model.calls.length;
    const events: FullRejudgeProgress[] = [];
    const backupFile = path.join(t.dir, "before.db");
    const result = await t.handle.runFullRejudge({ backupFile, onProgress: (e) => events.push(e) });
    if (result.state !== "ran") throw new Error(`没跑成：${result.state} ${result.reason}`);
    const report = result.report;
    expect(report.migration.reviewToFlag).toEqual([claimId]);
    expect(asked).toEqual(["羽毛球"]);
    t.withDb((db) => {
      expect(Number(db.get<{ n: number }>("SELECT COUNT(*) AS n FROM evidence")?.n)).toBe(6);
      expect(db.get<{ status: string; needs_review: number }>("SELECT status, needs_review FROM claims WHERE id = ?", claimId)).toEqual({ status: "contested", needs_review: 0 });
      expect(db.get<{ night: string }>("SELECT night FROM nightly_runs WHERE night LIKE '%#full-%'")?.night).toBe("2026-10-10#full-1300");
    });
    // 花费：计量记的调用次数 = 这一次模型真调的次数 = 报告里的调用次数；最后一条进度带的花费和报告一样
    expect(result.meter.calls).toBe(t.model.calls.length - callsBefore);
    expect(report.modelCalls).toBe(result.meter.calls);
    expect(report.spend).toEqual({ calls: result.meter.calls, inputTokens: result.meter.inputTokens, outputTokens: result.meter.outputTokens, yuan: result.meter.yuan });
    expect(events.at(-1)).toMatchObject({ phase: "done", state: "end", spend: report.spend });
    expect(events.filter((e) => e.step === undefined).map((e) => e.phase)).toContain("reflect");
    // 撤回：换回跑之前的快照
    expect(undoFullRejudge({ file: t.file, backupFile, after: report.after })).toEqual({ restored: true });
    expect(t.withDb((db) => db.all("SELECT id, status, confidence FROM claims ORDER BY id"))).toEqual(claimsBefore);
  });

  it("正在跑时再叫一次回 busy；没配模型 key 就跳过", async () => {
    const { t } = topicWorld();
    const first = t.handle.runFullRejudge();
    expect(await t.handle.runFullRejudge()).toMatchObject({ state: "busy" });
    expect((await first).state).toBe("ran");
    const none = setup({ chat: null, env: {} });
    expect(await none.handle.runFullRejudge()).toMatchObject({ state: "skipped" });
  });
});

function seedNeedWithDuePrediction(file: string): void {
  const opened = openReasoningDb({ file, clock: () => nowIso(at(9, 20, 3, 0)), model: "deepseek-flash" });
  if (!opened.ok) throw new Error("应该能建库");
  const { store } = opened.engine;
  try {
    for (const [id, text, day] of [
      ["ev-0901", "最近太累了，周末只想在家躺着。", 12],
      ["ev-0902", "周日的饭局我推掉了。", 14],
    ] as const) {
      const when = nowIso(at(9, day, 20, 0));
      store.insertEvidence({ id, sourceLevel: "self", mode: "say", kind: "utterance", text, context: ["weekend"], eventTime: when, observedAt: when, sourceRef: `mat-old-${id}` });
    }
    store.insertClaim({
      id: "cl-0901",
      tier: "need",
      statement: "用户重视自己安排周末",
      kind: "hypothesis",
      epistemic: "inferred",
      method: "induction",
      status: "active",
      confidence: "medium",
      context: ["weekend"],
      validFrom: null,
      validTo: null,
      inferredAt: nowIso(at(9, 20, 3, 0)),
      reviewedAt: null,
      retractedBy: null,
      supersededBy: null,
      competesWith: [],
      predicts: [{ claim: "两周内会推掉别人排好的周末活动", outcome: "pending", evidenceIds: [] }],
    });
    store.putLink({ claimId: "cl-0901", target: "ev-0901", polarity: "supports", weight: "strong", rationale: "周末只想自己待着" });
    store.putLink({ claimId: "cl-0901", target: "ev-0902", polarity: "supports", weight: "strong", rationale: "推掉了别人排的饭局" });
    store.putPrediction({ id: "pd-0901", claimId: "cl-0901", predicts: "两周内会推掉别人排好的周末活动", madeAt: nowIso(at(9, 20, 3, 0)), dueAt: nowIso(at(10, 4, 3, 0)), status: "open", evidenceId: null, judgedAt: null, note: "" });
  } finally {
    opened.engine.close();
  }
}
