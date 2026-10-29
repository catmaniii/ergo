// 主切面：记忆的推理库只读接口（233 号票）。走真实的装配路径和本机端口：
// - 停用记忆插件、库还没建：四个接口都回 200、ready=false、一句原因，不是 500；
// - 记忆插件开着：守护进程起来就建好 rg.db，接口读得到（空的），不知道的结论回 404、参数不对回 400；
// - 在守护进程的 rg.db 里写一条结论（守护进程只在启动和每晚整理时开库），下一个请求就看得到：每次现开现读，不缓存。
import fs from "node:fs";
import { FakeChatModel } from "@ergo/memory";
import { CHANNELS } from "@ergo/protocol";
import { describe, expect, it } from "vitest";
import { openReasoningDb } from "../../src/memory/rg-db.ts";
import { clockIso } from "../../src/scheduler/clock.ts";
import { ManualClock } from "../helpers/clock.ts";
import { startTestDaemon } from "../helpers/daemon.ts";
import { memoryApi } from "../helpers/http.ts";

/** 本地时间 2026 年 m 月 d 日 hh:mm（2026-10-07 是周三） */
const at = (m: number, d: number, hh: number, mm = 0) => new Date(2026, m - 1, d, hh, mm);

/** 往守护进程的 rg.db 里写一条结论（它在启动、每晚整理时才开库，这会儿没有句柄） */
function seedClaim(file: string, clock: ManualClock): void {
  const opened = openReasoningDb({ file, clock: () => clockIso(clock), model: "deepseek-flash" });
  if (!opened.ok) throw new Error("守护进程起来时应该建好了 rg.db");
  try {
    opened.engine.store.insertClaim({
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
      inferredAt: clockIso(clock),
      reviewedAt: null,
      retractedBy: null,
      supersededBy: null,
      competesWith: [],
      predicts: [],
    });
  } finally {
    opened.engine.close();
  }
}

describe("记忆的推理库只读接口", () => {
  it("停用记忆插件、库还没建：四个接口都是 200、ready=false、写清为什么，不是 500", { timeout: 60_000 }, async () => {
    const clock = new ManualClock(at(10, 7, 2, 0));
    const td = await startTestDaemon({ clock, plugins: [] });
    const rgDb = td.daemon.layout.rgDb;
    expect(fs.existsSync(rgDb)).toBe(false);

    const summary = await memoryApi.summary(td.url);
    expect(summary.status).toBe(200);
    expect(summary.body).toMatchObject({ ready: false, total: 0, openQuestions: 0 });
    expect(summary.body.reason).toContain("还没建");
    expect(summary.body.tiers).toEqual({ state: 0, preference: 0, need: 0, value: 0 });

    const claims = await memoryApi.claims(td.url);
    expect(claims.status).toBe(200);
    expect(claims.body).toMatchObject({ ready: false, total: 0, items: [] });

    const detail = await memoryApi.detail(td.url, "cl-0001");
    expect(detail.status).toBe(200);
    expect(detail.body.ready).toBe(false);
    expect(detail.body.claim).toBeUndefined();

    const questions = await memoryApi.questions(td.url);
    expect(questions.status).toBe(200);
    expect(questions.body).toMatchObject({ ready: false, total: 0, open: 0, items: [] });

    // 只读：看一眼不会把库建出来
    expect(fs.existsSync(rgDb)).toBe(false);
  });

  it("记忆插件开着：库里是空的也读得到；不知道的结论 404、参数不对 400；写进去的结论下一个请求就看得到", { timeout: 60_000 }, async () => {
    const clock = new ManualClock(at(10, 7, 2, 0));
    const td = await startTestDaemon({ clock, plugins: ["memory"], memoryModel: () => new FakeChatModel(() => ({})), secretary: [{ kind: "reply", text: "好。" }] });
    const rgDb = td.daemon.layout.rgDb;
    expect(fs.existsSync(rgDb)).toBe(true);

    const empty = await memoryApi.summary(td.url);
    expect(empty.status).toBe(200);
    expect(empty.body).toMatchObject({ ready: true, total: 0, openQuestions: 0 });
    // 还没整理过：没有"最近一次整理"那一行
    expect(empty.body.lastNight).toBeUndefined();
    expect((await memoryApi.claims(td.url)).body).toMatchObject({ ready: true, total: 0, items: [] });
    expect((await memoryApi.questions(td.url)).body).toMatchObject({ ready: true, total: 0, open: 0, items: [] });

    // 不知道的结论、参数不对
    const missing = await memoryApi.detail(td.url, "cl-9999");
    expect(missing.status).toBe(404);
    expect(missing.body.code).toBe("not_found");
    const badTier = await memoryApi.claims(td.url, { tier: "nope" });
    expect(badTier.status).toBe(400);
    expect(badTier.body.code).toBe("bad_request");
    expect(badTier.body.message).toContain("nope");
    const badStatus = await memoryApi.claims(td.url, { status: "nope" });
    expect(badStatus.status).toBe(400);
    const badLimit = await memoryApi.claims(td.url, { limit: "abc" });
    expect(badLimit.status).toBe(400);

    // 写一条进去（守护进程这会儿没握着 rg.db）：下一次请求现开现读
    seedClaim(rgDb, clock);
    const page = await memoryApi.claims(td.url, { tier: "preference", limit: 10 });
    expect(page.status).toBe(200);
    expect(page.body.total).toBe(1);
    expect(page.body.items[0]).toMatchObject({ id: "cl-0001", statement: "不喜欢周末被提前排满", tier: "preference", status: "active", confidence: "high", epistemic: "explicit" });
    const summary = await memoryApi.summary(td.url);
    expect(summary.body).toMatchObject({ ready: true, total: 1, tiers: { state: 0, preference: 1, need: 0, value: 0 } });

    const detail = await memoryApi.detail(td.url, "cl-0001");
    expect(detail.status).toBe(200);
    expect(detail.body.ready).toBe(true);
    expect(detail.body.claim).toMatchObject({ id: "cl-0001", statement: "不喜欢周末被提前排满", method: "explicit" });
    expect(detail.body.supports).toEqual([]);
    expect(detail.body.premises).toMatchObject({ id: "cl-0001", kind: "claim" });

    // 按状态筛还是没有
    expect((await memoryApi.claims(td.url, { status: "retracted" })).body).toMatchObject({ total: 0, items: [] });
    // 那个会话没受影响
    expect(td.daemon.plugins.report().running).toContain("memory");
    expect(CHANNELS.secretary).toBe("secretary");
  });
});
