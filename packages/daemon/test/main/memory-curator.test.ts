// 主切面：记忆管理员（242 号票）。走真实的装配路径（真的守护进程、真的事件日志、真的 rg.db，模型全是假的）：
// - 03:00 的内部作业改成唤醒记忆管理员：它调 run_memory_consolidation（还是同一份 runNightly、同一条整理记录），
//   跑完把这一夜写成一段整理日记；整理记录里看得到管理员自己额外花了几次模型调用；
// - 用户在记忆页那一层跟它说话（会话就是普通的输入输出）；
// - 让它把一条结论标成待复核：调 review_memory_claim，库里加了复核标记（329 号票起不改真值状态）、修订记录写明是记忆管理员做的；
// - 让它把一条素材忘掉：走 234 号票的 purge-rg（证据清原文、事实撤回、依赖的结论加复核标记），并留下一条"记忆管理员下的命令"；
// - 管理员起不来（模型坏了）：整理照旧按失败记、待我处理一条，守护进程不崩；
// - 243 号票：它按需拉起、不常驻——起来时只建壳（没有子进程、不占 agents.maxLive 的名额），用户发消息才拉起，闲置后退出。
// 265 号票起底座在给了 clock 时默认停掉记忆插件，这里测的就是它，拨时钟的用例都写 memoryPlugin: true。
import { type ChatRequest, FakeChatModel, type MemoryEngine } from "@ergo/memory";
import { CHANNELS, EVENT_TYPES, type MessageEventPayload } from "@ergo/protocol";
import { describe, expect, it } from "vitest";
import { MEMORY_CURATOR_CONVERSATION } from "../../src/memory/curator.ts";
import { openReasoningDb } from "../../src/memory/rg-db.ts";
import { MEMORY_NIGHTLY_EVENT, type MemoryNightlyRecord } from "../../src/memory/nightly-record.ts";
import type { FauxStep } from "../../src/runtime/index.ts";
import { INTERNAL_CHANNEL } from "../../src/scheduler/internal-jobs.ts";
import { ManualClock } from "../helpers/clock.ts";
import { startTestDaemon } from "../helpers/daemon.ts";
import { TestFrontend } from "../helpers/frontend.ts";
import { submitPlanStep } from "../helpers/plans.ts";
import { waitUntil } from "../helpers/process.ts";

const { secretary: SECRETARY } = CHANNELS;
const CURATOR = MEMORY_CURATOR_CONVERSATION;

const say = (text: string): FauxStep => ({ kind: "reply", text });
const call = (name: string, args: Record<string, unknown>): FauxStep => ({ kind: "reply", toolCalls: [{ name, arguments: args as never }] });
const writeBrief = (taskId: string): FauxStep => call("write_task_brief", { taskId, goal: `完成 ${taskId}`, acceptanceCriteria: ["做完"], constraints: [], projects: [], memoryScope: "" });

/** 本地时间 2026 年 m 月 d 日 hh:mm（2026-10-07 是周三） */
const at = (m: number, d: number, hh: number, mm = 0) => new Date(2026, m - 1, d, hh, mm);

type TestDaemon = Awaited<ReturnType<typeof startTestDaemon>>;

/** 假模型的回复：抽事实那一步给这一批每条证据一条事实，别的步骤回空 */
function fakeMemoryModel(request: ChatRequest): unknown {
  if (request.purpose !== "extract") return {};
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

/** 会话频道上的消息文字（按先后） */
function texts(td: TestDaemon, channel: string): string[] {
  return td.daemon.store
    .read(channel, 0, EVENT_TYPES.message)
    .map((event) => (event.payload as MessageEventPayload).message)
    .flatMap((message) => message.parts.flatMap((part) => (part.type === "text" ? [part.text] : [])));
}

/** 整理记录（internal 频道上的事件，按先后） */
function nightlyRecords(td: TestDaemon): MemoryNightlyRecord[] {
  return td.daemon.store.read(INTERNAL_CHANNEL, 0, MEMORY_NIGHTLY_EVENT).map((event) => event.payload as MemoryNightlyRecord);
}

/** 某一夜的整理记录（视图里那一行：一夜一条，后来的覆盖先前的） */
function nightlyOf(td: TestDaemon, night: string): MemoryNightlyRecord | undefined {
  const row = td.daemon.store.reader.get<{ record: string }>("SELECT record FROM memory_nightly WHERE night = ?", night);
  return row === undefined ? undefined : (JSON.parse(row.record) as MemoryNightlyRecord);
}

/** 打开守护进程的 rg.db 看一眼（守护进程只在启动、整理和工具调用时开句柄；WAL 下两边各自一个连接） */
function withDb<T>(td: TestDaemon, fn: (engine: MemoryEngine) => T): T {
  const opened = openReasoningDb({ file: td.daemon.layout.rgDb, clock: () => new Date().toISOString(), model: "deepseek-flash" });
  if (!opened.ok) throw new Error(`推理库打不开：${opened.issue.code}`);
  try {
    return fn(opened.engine);
  } finally {
    opened.engine.close();
  }
}

/**
 * 往守护进程的 rg.db 里放一条证据和一条以它为依据的结论（和 memory-graph.test.ts 一样直接写库：
 * 守护进程这会儿只在启动、整理时开过库）
 */
function seedClaimAndLink(td: TestDaemon, materialId: string): string {
  return withDb(td, (engine) => {
    const evidence = engine.store.insertEvidence({
      id: "ev-0001",
      sourceLevel: "self",
      mode: "say",
      kind: "utterance",
      text: "这周六的聚会我就不去了，最近周末想好好休息。",
      context: ["weekend"],
      eventTime: new Date().toISOString(),
      observedAt: new Date().toISOString(),
      sourceRef: materialId,
    });
    engine.store.insertClaim({
      id: "cl-0001",
      tier: "preference",
      statement: "不喜欢周末被提前排满",
      kind: "conclusion",
      epistemic: "explicit",
      method: "explicit",
      status: "active",
      confidence: "high",
      context: ["weekend"],
      validFrom: null,
      validTo: null,
      inferredAt: new Date().toISOString(),
      reviewedAt: null,
      retractedBy: null,
      supersededBy: null,
      competesWith: [],
      predicts: [],
    });
    engine.store.putLink({ claimId: "cl-0001", target: evidence.id, polarity: "supports", rationale: "这一条里说过", weight: "strong" });
    return evidence.id;
  });
}

describe("记忆管理员", () => {
  it(
    "03:00 唤醒它：它调 run_memory_consolidation 跑完（同一条整理记录和原来一样有一条）、写一段整理日记；记录里看得到它额外花了几次",
    { timeout: 90_000 },
    async () => {
      const clock = new ManualClock(at(10, 7, 2, 0));
      const td = await startTestDaemon({
        clock,
        memoryPlugin: true,
        memoryModel: () => new FakeChatModel(fakeMemoryModel),
        secretary: [{ kind: "reply", text: "好。" }],
        curator: [
          { kind: "reply", toolCalls: [{ name: "run_memory_consolidation", arguments: {} }] },
          { kind: "reply", text: "今晚整理完了：新出的结论一条，没有拿不准的。" },
          { kind: "reply", text: "那条是从你说过的话里整理的。" },
        ],
      });
      const frontend = await TestFrontend.connect(td.url);
      await frontend.subscribe({ [SECRETARY]: 0 });
      // 用户说一句话，采成素材
      await frontend.sendText("这周六的聚会我就不去了，最近周末想好好休息。");
      await frontend.next(SECRETARY, EVENT_TYPES.turnEnd);
      expect(nightlyRecords(td)).toEqual([]);

      // 03:00 到点：管理员被唤醒，它自己调了整理
      clock.advanceTo(at(10, 7, 3, 0));
      await td.daemon.internalJobs.whenIdle();
      const night = nightlyOf(td, "2026-10-07");
      expect(night).toMatchObject({ state: "ran", trigger: "scheduled", budgetExhausted: false });
      expect(night!.processedEvidence).toBeGreaterThan(0);
      // 管理员自己额外花了几次模型调用（两个 faux 剧本步骤：调工具、写日记）
      expect(night!.curatorModelCalls).toBeGreaterThanOrEqual(2);
      // 整理记录还是同一份作业的：这条记录就是这一夜的那一条（管理员的次数补在同一条上）
      const ran = nightlyRecords(td).filter((record) => record.state === "ran");
      expect(ran.length).toBeGreaterThanOrEqual(1);
      expect(ran.every((record) => record.night === "2026-10-07")).toBe(true);
      // 待我处理里没有失败事项
      expect(td.daemon.inbox.list().filter((item) => item.kind === "notice" && item.notice === "memory_nightly_failed")).toEqual([]);

      // 会话里有一条唤醒的系统消息和它写的整理日记
      const said = texts(td, CURATOR);
      expect(said.some((text) => text.startsWith("【记忆整理】"))).toBe(true);
      expect(said.some((text) => text.includes("今晚整理完了"))).toBe(true);

      // 用户接着跟它说话：一句输入、它回一句（从这会儿起订它的会话，不再补发刚才那一夜的历史）
      await frontend.subscribe({ [SECRETARY]: frontend.cursors[SECRETARY] ?? 0, [CURATOR]: td.daemon.store.lastSeq(CURATOR) });
      await frontend.sendText("上周那条结论是哪来的？", { conversation: CURATOR });
      await frontend.next(CURATOR, EVENT_TYPES.turnEnd);
      expect(texts(td, CURATOR).at(-1)).toContain("那条是从你说过的话里整理的");
    },
  );

  it(
    "用户让它把一条结论标成待复核：加了复核标记（329 号票起不改真值状态）、修订记录写明是记忆管理员做的；让它忘掉一条素材：证据失效、依赖的结论加复核标记",
    { timeout: 90_000 },
    async () => {
      const clock = new ManualClock(at(10, 7, 2, 0));
      const td = await startTestDaemon({
        clock,
        memoryPlugin: true,
        memoryModel: () => new FakeChatModel(fakeMemoryModel),
        secretary: [{ kind: "reply", text: "好。" }],
        curator: [
          { kind: "reply", toolCalls: [{ name: "review_memory_claim", arguments: { claimId: "cl-0001", status: "needs_review", reason: "用户让我核对这条" } }] },
          { kind: "reply", text: "标成待复核了。" },
          // 忘掉素材：先检索出那一条（工具结果里有素材 id），再照着 id 忘
          { kind: "reply", toolCalls: [{ name: "search_materials", arguments: { query: "聚会 周末", why: "找用户说要忘掉的那条素材" } }] },
          { kind: "call_with_matches", toolCall: { name: "forget_material", arguments: { reason: "用户让忘掉" } }, argument: "materialIds", pattern: "mat-[0-9a-f]{24}" },
          { kind: "reply", text: "忘了。" },
          // 只管记忆：让删素材库——它没有这个工具（模型会先试着调一个不存在的），照实说"这个我不做"
          { kind: "reply", toolCalls: [{ name: "delete_material_library", arguments: {} }] },
          { kind: "reply", text: "这个我不做：删素材库要去「记忆 · 素材」的成批删除，我只能改记忆。" },
        ],
      });
      const frontend = await TestFrontend.connect(td.url);
      await frontend.subscribe({ [SECRETARY]: 0, [CURATOR]: 0 });
      await frontend.sendText("这周六的聚会我就不去了，最近周末想好好休息。");
      await frontend.next(SECRETARY, EVENT_TYPES.turnEnd);

      // 在守护进程的 rg.db 里放一条结论，并让它以这条素材的证据为依据
      const materialId = td.daemon.materials.list()[0]!.id;
      const evidenceId = seedClaimAndLink(td, materialId);

      // 把 cl-0001 标成待复核
      await frontend.sendText("把 cl-0001 标成待复核", { conversation: CURATOR });
      await frontend.next(CURATOR, EVENT_TYPES.turnEnd);
      expect(withDb(td, (engine) => engine.store.getClaim("cl-0001"))).toMatchObject({ status: "active", needsReview: true });
      const revisions = withDb(td, (engine) => engine.store.revisions("cl-0001", "claim"));
      expect(revisions.at(-1)!.reason).toContain("记忆管理员");
      expect(texts(td, CURATOR).at(-1)).toContain("标成待复核了");

      // 摘掉标记，再让它忘掉那条素材：purge-rg 把证据清掉，依赖的结论又加上复核标记
      withDb(td, (engine) => engine.store.updateClaim("cl-0001", { needsReview: false }, { reason: "测试里先摘掉标记" }));
      await frontend.sendText("把这条素材忘掉", { conversation: CURATOR });
      await frontend.next(CURATOR, EVENT_TYPES.turnEnd);
      expect(withDb(td, (engine) => engine.store.getEvidence(evidenceId)!.status)).toBe("forgotten");
      expect(withDb(td, (engine) => engine.store.getClaim("cl-0001")!.needsReview)).toBe(true);
      // 事件日志里留下一条命令：记忆管理员下的忘掉（234 号票的 purge-rg 认它）
      const commands = td.daemon.store.reader.all<{ payload: string }>("SELECT payload FROM events WHERE type = 'memory_command'");
      expect(commands.some((row) => row.payload.includes('"kind":"curator"') && row.payload.includes(materialId))).toBe(true);
      expect(texts(td, CURATOR).at(-1)).toContain("忘了。");

      // 只管记忆：让它清空素材库——它没有这个工具，照实拒绝，原来的素材一条没少（它自己的会话里说的话也会采成素材，不算）
      const before = td.daemon.materials.list().map((m) => m.id);
      await frontend.sendText("把素材库清空", { conversation: CURATOR });
      await frontend.next(CURATOR, EVENT_TYPES.turnEnd);
      expect(texts(td, CURATOR).at(-1)).toContain("这个我不做");
      const after = new Set(td.daemon.materials.list().map((m) => m.id));
      expect(before.every((id) => after.has(id))).toBe(true);
    },
  );

  it("管理员起不来（模型坏了）：整理照旧按失败记、待我处理一条，守护进程不崩", { timeout: 90_000 }, async () => {
    const clock = new ManualClock(at(10, 7, 2, 0));
    const td = await startTestDaemon({
      clock,
      memoryPlugin: true,
      // 整理用的模型坏了
      memoryModel: () =>
        new FakeChatModel(() => {
          throw new Error("模型坏了");
        }),
      secretary: [{ kind: "reply", text: "好。" }],
      // 管理员的模型也坏了（剧本是空的：一被调用就得到错误回复）
      curator: [],
    });
    const frontend = await TestFrontend.connect(td.url);
    await frontend.subscribe({ [SECRETARY]: 0, [CURATOR]: 0 });
    await frontend.sendText("这周六的聚会我就不去了，最近周末想好好休息。");
    await frontend.next(SECRETARY, EVENT_TYPES.turnEnd);

    clock.advanceTo(at(10, 7, 3, 0));
    await td.daemon.internalJobs.whenIdle();
    const night = nightlyOf(td, "2026-10-07");
    expect(night).toMatchObject({ state: "failed", night: "2026-10-07" });
    expect(night!.reason).toContain("模型坏了");
    expect(td.daemon.inbox.list().filter((item) => item.kind === "notice" && item.notice === "memory_nightly_failed")).toHaveLength(1);
    // 守护进程还在：秘书还能回话
    await frontend.sendText("还在吗？");
    await frontend.next(SECRETARY, EVENT_TYPES.turnEnd);
    expect(texts(td, SECRETARY).some((text) => text === "好。")).toBe(true);
  });

  it(
    "不常驻（243 号票）：起来时只建壳——没有 memory-curator 子进程、不占 maxLive 名额（秘书 + 一个维护者照旧能起）；用户发消息才拉起它；闲置后退出",
    { timeout: 90_000 },
    async () => {
      const td = await startTestDaemon({
        // maxLive=2：秘书占一个，另一个给维护者；管理员常驻的话维护者就起不来（242 合进 main 后的 8 条失败就是这个）
        config: { agents: { maxLive: 2, idleMinutes: 0.1 } },
        secretary: [writeBrief("t-1"), say("交给维护者了")],
        maintainer: [submitPlanStep(), say("计划交了")],
        curator: [say("我在：记忆这边随时可以问。")],
      });
      const { url, daemon } = td;
      const live = () => daemon.agents.live();
      const running = (agentId: string) => live().some((agent) => agent.agentId === agentId);
      // 守护进程起来（记忆插件在跑、管理员已经建好壳）：只有秘书在，管理员没有子进程
      await waitUntil(() => running("secretary"), { timeoutMs: 20_000, describe: () => JSON.stringify(live()) });
      expect(running("memory-curator")).toBe(false);
      // 名额没被它占：maxLive=2 时"秘书 + 一个维护者"照旧能起
      const frontend = await TestFrontend.connect(url);
      await frontend.subscribe({ [SECRETARY]: 0, [CURATOR]: 0 });
      await frontend.startTask("任务 1");
      await waitUntil(() => daemon.tasks.get("t-1")?.state === "awaiting_confirm", { timeoutMs: 45_000, describe: () => JSON.stringify(daemon.tasks.list().map((t) => t.state)) });
      const working = live().map((agent) => agent.agentId);
      expect(working).toContain("secretary");
      expect(working).toContain("tm-1");
      expect(working).not.toContain("memory-curator");
      expect(working.length).toBeLessThanOrEqual(2);

      // 维护者闲置退出（让出第二个名额），管理员照旧没有被拉起
      await waitUntil(() => !running("tm-1"), { timeoutMs: 20_000, describe: () => JSON.stringify(live()) });
      expect(running("memory-curator")).toBe(false);

      // 用户在记忆页发一句话：它这才被拉起（网页上看历史不需要它活着）
      await frontend.sendText("记忆这边怎么样了？", { conversation: CURATOR });
      await waitUntil(() => running("memory-curator"), { timeoutMs: 20_000, describe: () => JSON.stringify(live()) });
      await frontend.next(CURATOR, EVENT_TYPES.turnEnd);
      expect(texts(td, CURATOR).at(-1)).toContain("记忆这边随时可以问");

      // 闲置到 agents.idleMinutes 后照维护者的规矩退出
      await waitUntil(() => !running("memory-curator"), { timeoutMs: 20_000, describe: () => JSON.stringify(live()) });
    },
  );
});
