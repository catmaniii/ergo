// 向量索引（规格第 15、21 节，模块层）：素材入库后后台异步补算，不卡写入；每条向量旁记模型名，换模型整批重算；
// 模型文件不在时素材和关键词索引照常，提示用户运行下载命令，模型就位后补算。这里注入假的向量函数，不跑真模型。
// 启动后的补算过一会儿（BACKFILL_DELAY_MS）才开始，不和秘书的拉起抢 CPU；测试里拨 ManualClock。
import { describe, expect, test } from "vitest";
import { EmbeddingUnavailable } from "../../src/materials/embedding/embedder.ts";
import { BACKFILL_DELAY_MS, EMBED_MAX_CHARS, MODEL_MISSING_ITEM_ID, MODEL_RECHECK_MS } from "../../src/materials/vectors.ts";
import { FakeEmbedder, vectorsSettled } from "../helpers/embedder.ts";
import { materialsSetup, postMessage, text } from "./helpers.ts";

describe("后台补算", () => {
  test("素材写入在向量算出之前就返回；算完后语义检索能用", async () => {
    const embedder = new FakeEmbedder();
    const t = materialsSetup({ embedder });
    const release = embedder.hold();

    postMessage(t.store, [text("下个月要搬家了")]);
    // 写入已经返回，素材和关键词索引都在，向量还没算出来
    expect(t.materials.list()).toHaveLength(1);
    expect(t.materials.searchKeyword("搬家")).toHaveLength(1);
    expect(t.materials.vectorStatus()).toMatchObject({ model: "fake-embed@1", available: true, indexed: 0, pending: 1 });

    release();
    await vectorsSettled(t.materials);
    expect(t.materials.vectorStatus()).toMatchObject({ indexed: 1, pending: 0, state: "idle" });
  });

  test("按语义检索：不共享关键词也能找到意思相近的素材，越像越靠前", async () => {
    const t = materialsSetup();
    postMessage(t.store, [text("今天晚饭想吃火锅")]);
    postMessage(t.store, [text("下个月要搬家了，房东要卖房")]);
    postMessage(t.store, [text("周末去健身房")]);
    await vectorsSettled(t.materials);

    expect(t.materials.searchKeyword("换个地方住")).toEqual([]);
    const hits = await t.materials.searchSemantic("我想换个地方住", { limit: 2 });
    expect(hits.map((h) => h.material.segments[0]!.text)).toEqual(["下个月要搬家了，房东要卖房", expect.any(String)]);
    expect(hits[0]!.score).toBeGreaterThan(hits[1]!.score);
  });

  test("向量只算要索引的文字：本人的话加上引用的说明（文件名）；引用块、附件的正文不算", async () => {
    const embedder = new FakeEmbedder();
    const t = materialsSetup({ embedder });
    postMessage(t.store, [{ type: "image", mediaId: "f".repeat(64), name: "家里的猫.png", mime: "image/png" }]);
    postMessage(t.store, [text("有字的\n> 别人说的话")]);
    await vectorsSettled(t.materials);
    expect(embedder.calls.flat()).toEqual(["家里的猫.png", "有字的"]);
    expect(t.materials.vectorStatus()).toMatchObject({ indexed: 2, pending: 0 });
  });

  test("要索引的文字太长只算开头 EMBED_MAX_CHARS 字（166 号票：存的网页正文最多 2 万字）；长的单独一批，不让一批短的跟着补齐到它那么长", async () => {
    const embedder = new FakeEmbedder();
    const t = materialsSetup({ embedder });
    const release = embedder.hold();
    postMessage(t.store, [text("先来一条")]);
    const long = `开头${"字".repeat(EMBED_MAX_CHARS * 2)}结尾的话`;
    postMessage(t.store, [text("短的一")]);
    postMessage(t.store, [text("短的二")]);
    postMessage(t.store, [text(long)]);
    postMessage(t.store, [text("短的三")]);
    release();
    await vectorsSettled(t.materials);
    expect(embedder.calls).toEqual([["先来一条"], ["短的一", "短的二"], [long.slice(0, EMBED_MAX_CHARS)], ["短的三"]]);
    expect(t.materials.vectorStatus()).toMatchObject({ indexed: 5, pending: 0 });
    // 关键词索引照样是全文
    expect(t.materials.searchKeyword("结尾的话")).toHaveLength(1);
  });

  test("算向量出错不影响入库，过一会儿自动重试", async () => {
    const embedder = new FakeEmbedder();
    let fail = true;
    const embed = embedder.embed.bind(embedder);
    embedder.embed = async (texts) => {
      if (fail) throw new Error("模型崩了");
      return embed(texts);
    };
    const t = materialsSetup({ embedder });
    postMessage(t.store, [text("记一下")]);
    await vectorsSettled(t.materials);
    expect(t.materials.vectorStatus()).toMatchObject({ indexed: 0, pending: 1, state: "error" });
    expect(t.logs.join("\n")).toContain("模型崩了");

    fail = false;
    t.clock.advance(60_000);
    await vectorsSettled(t.materials);
    expect(t.materials.vectorStatus()).toMatchObject({ indexed: 1, pending: 0, state: "idle" });
  });
});

describe("模型名", () => {
  test("每条向量旁记着模型名：换了模型，旧模型的向量不再参与检索，整批重算", async () => {
    const t = materialsSetup({ embedder: new FakeEmbedder({ model: "fake-embed@1" }) });
    postMessage(t.store, [text("下个月要搬家了")]);
    postMessage(t.store, [text("周末去跑步")]);
    await vectorsSettled(t.materials);
    expect(t.materials.vectorStatus()).toMatchObject({ model: "fake-embed@1", indexed: 2 });

    const next = new FakeEmbedder({ model: "fake-embed@2" });
    const release = next.hold();
    await t.reopen({ embedder: next });
    // 新模型还没算：旧向量不算数
    expect(t.materials.vectorStatus()).toMatchObject({ model: "fake-embed@2", indexed: 0, pending: 2 });
    t.clock.advance(BACKFILL_DELAY_MS);
    release();
    await vectorsSettled(t.materials);
    expect(t.materials.vectorStatus()).toMatchObject({ model: "fake-embed@2", indexed: 2, pending: 0 });
    expect(next.calls.flat()).toEqual(["下个月要搬家了", "周末去跑步"]);
  });

  test("启动时不马上补算（工作线程也不拉起）：过一会儿才开始；期间来了新素材照常马上算", async () => {
    const t = materialsSetup();
    postMessage(t.store, [text("下个月要搬家了")]);
    const fresh = new FakeEmbedder({ model: "fake-embed@2" });
    await t.reopen({ embedder: fresh });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(fresh.calls).toEqual([]);
    expect(t.materials.vectorStatus()).toMatchObject({ state: "idle", pending: 1, indexed: 0 });

    t.clock.advance(BACKFILL_DELAY_MS - 1);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(fresh.calls).toEqual([]);
    t.clock.advance(1);
    await vectorsSettled(t.materials);
    expect(fresh.calls.flat()).toEqual(["下个月要搬家了"]);

    // 新素材不等：写进来就算
    const again = new FakeEmbedder({ model: "fake-embed@3" });
    await t.reopen({ embedder: again });
    postMessage(t.store, [text("周末去跑步")]);
    await vectorsSettled(t.materials);
    expect(again.calls.flat()).toEqual(["下个月要搬家了", "周末去跑步"]);
  });

  test("重启后同一个模型不重算", async () => {
    const t = materialsSetup();
    postMessage(t.store, [text("记一下")]);
    await vectorsSettled(t.materials);
    const again = new FakeEmbedder();
    await t.reopen({ embedder: again });
    t.clock.advance(BACKFILL_DELAY_MS);
    await vectorsSettled(t.materials);
    expect(again.calls).toEqual([]);
    expect(t.materials.vectorStatus()).toMatchObject({ indexed: 1, pending: 0 });
  });
});

describe("模型文件不在", () => {
  test("素材入库和关键词检索照常；语义检索报模型不在；提示用户运行下载命令（日志和待我处理）", async () => {
    const embedder = new FakeEmbedder({ available: false });
    const t = materialsSetup({ embedder });
    postMessage(t.store, [text("下个月要搬家了")]);
    await vectorsSettled(t.materials);

    expect(t.materials.searchKeyword("搬家")).toHaveLength(1);
    expect(t.materials.vectorStatus()).toMatchObject({ available: false, indexed: 0, pending: 1, state: "waiting_for_model" });
    await expect(t.materials.searchSemantic("搬家")).rejects.toThrow(EmbeddingUnavailable);
    expect(embedder.calls).toEqual([]);
    expect(t.logs.join("\n")).toContain(embedder.unavailableHint());
    expect(t.inbox.get(MODEL_MISSING_ITEM_ID)).toMatchObject({
      kind: "notice",
      notice: "embedding_model_missing",
      urgency: "non_blocking",
      body: expect.stringContaining(embedder.unavailableHint()),
      archived: false,
      // 323 号票："去装组件"由网页带到设置 · 组件
      actions: ["去装组件", "知道了"],
    });
  });

  test("模型文件就位后（不用重启）补算缺的向量，待我处理里那条提示收进归档", async () => {
    const embedder = new FakeEmbedder({ available: false });
    const t = materialsSetup({ embedder });
    postMessage(t.store, [text("下个月要搬家了")]);
    postMessage(t.store, [text("周末去跑步")]);

    embedder.setAvailable(true);
    t.clock.advance(MODEL_RECHECK_MS);
    await vectorsSettled(t.materials);
    expect(t.materials.vectorStatus()).toMatchObject({ available: true, indexed: 2, pending: 0, state: "idle" });
    expect(t.inbox.get(MODEL_MISSING_ITEM_ID)).toMatchObject({ archived: true });
    expect((await t.materials.searchSemantic("换个地方住", { limit: 1 }))[0]!.material.segments[0]!.text).toBe("下个月要搬家了");
  });

  test("提示只放一次：重启后模型还不在，不再往待我处理里放第二条", async () => {
    const t = materialsSetup({ embedder: new FakeEmbedder({ available: false }) });
    await t.reopen({ embedder: new FakeEmbedder({ available: false }) });
    expect(t.inbox.list().filter((i) => i.kind === "notice" && i.notice === "embedding_model_missing")).toHaveLength(1);
  });
});
