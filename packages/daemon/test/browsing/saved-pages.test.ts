// 存进二狗的素材（165 号票，模块层）："浏览"的 ⋮ 菜单里把开着的一页存进素材。存下的是素材频道上的一条 web_page_saved 事件，
// 采成一条"用户主动投喂的材料"素材（来源本人：存是用户做的；情境 saved_web_page）；网页那一段是外部、不可信的，只记网址、标题和正文的哈希——
// 正文不进切段、不进原文副本（推断不拿它当用户的话）。同一个幂等键重发只存一次；彻底删除时事件里的标题、地址、正文换成删除标记。
// 166 号票（用户 2026-10-19 定，规格第 15 节的例外）：用户主动存的网页，正文进检索的索引（关键词、向量）——按正文里的字检索得到；
// 166 之前存的（索引里没有正文）守护进程起来时按原始事件补进索引。
import fs from "node:fs";
import path from "node:path";
import { EVENT_TYPES, type MemoryCommandEventPayload, PURGED_TEXT, SAVED_WEB_PAGE_CONTEXT, type WebPageSavedEventPayload } from "@ergo/protocol";
import { describe, expect, test } from "vitest";
import { createSavedPages, webPageSavedPurge, webPageSavedSource } from "../../src/browsing/saved-pages.ts";
import { MATERIALS_CHANNEL } from "../../src/materials/index.ts";
import { sha256Hex } from "../../src/materials/segments.ts";
import { BACKFILL_DELAY_MS } from "../../src/materials/vectors.ts";
import { FakeEmbedder, vectorsSettled } from "../helpers/embedder.ts";
import { materialsSetup } from "../materials/helpers.ts";

const PAGE = {
  idempotencyKey: "save-1",
  title: "周末去杭州玩什么 - 旅行攻略",
  url: "https://travel.example.com/hangzhou?from=feed",
  text: "西湖、灵隐寺、龙井村。第一天去西湖骑车环湖。",
  truncated: false,
  total: 23,
};

const TIME = "2026-10-19T10:00:00.000+08:00";

function setup(options: { collect?: boolean; embedder?: FakeEmbedder } = {}) {
  const t = materialsSetup({ sources: [webPageSavedSource], ...options });
  let n = 0;
  const pages = () => createSavedPages({ store: t.store, now: () => TIME, newId: () => `wp-test-${++n}` });
  return { t, pages };
}

describe("存一页", () => {
  test("素材频道上追加一条 web_page_saved；采成一条用户主动投喂的材料：来源本人、情境 saved_web_page，网页那一段外部、不可信，只有网址、标题和哈希", () => {
    const { t, pages } = setup();
    const result = pages().save(PAGE);

    const [event, ...more] = t.store.read(MATERIALS_CHANNEL, 0, EVENT_TYPES.webPageSaved);
    expect(more).toEqual([]);
    expect(event!.payload).toEqual({ id: "wp-test-1", time: TIME, title: PAGE.title, url: PAGE.url, text: PAGE.text, truncated: false, total: 23 } satisfies WebPageSavedEventPayload);

    const [material, ...rest] = t.materials.list();
    expect(rest).toEqual([]);
    expect(result).toEqual({ id: "wp-test-1", materialId: material!.id });
    expect(material).toMatchObject({
      kind: "fed_material",
      mode: "say",
      time: TIME,
      conversation: null,
      source: "self",
      context: [SAVED_WEB_PAGE_CONTEXT],
      ref: { event: { channel: MATERIALS_CHANNEL, seq: event!.seq, type: EVENT_TYPES.webPageSaved }, recordId: "wp-test-1" },
      segments: [
        {
          form: "web_page",
          source: "external_untrusted",
          notes: [],
          label: `${PAGE.title}（${PAGE.url}）`,
          url: PAGE.url,
          sha256: sha256Hex(PAGE.text),
        },
      ],
      noInfer: false,
    });
    // 正文不进素材、不进原文副本
    expect(material!.segments[0]).not.toHaveProperty("text");
    expect(fs.readFileSync(path.join(t.materialsDir, material!.original!.path), "utf8")).not.toContain("灵隐寺");
  });

  test("按标题、网址的关键词检索得到；166 号票起按正文里的字也检索得到（长词走索引、短词子串过滤）", () => {
    const { t, pages } = setup();
    pages().save(PAGE);
    expect(t.materials.searchKeyword("杭州玩什么").map((m) => m.context)).toEqual([[SAVED_WEB_PAGE_CONTEXT]]);
    expect(t.materials.searchKeyword("travel.example")).toHaveLength(1);
    expect(t.materials.searchKeyword("灵隐寺").map((m) => m.context)).toEqual([[SAVED_WEB_PAGE_CONTEXT]]);
    expect(t.materials.searchKeyword("龙井村 骑车")).toHaveLength(1);
    expect(t.materials.searchKeyword("湖")).toHaveLength(1);
    expect(t.materials.searchKeyword("断桥残雪")).toEqual([]);
  });

  test("有向量模型时按正文的意思也检索得到（166 号票）", async () => {
    const { t, pages } = setup();
    pages().save({ ...PAGE, title: "清单", text: "下个月搬到新住处之前要准备的东西：纸箱、胶带、记号笔。" });
    pages().save({ ...PAGE, idempotencyKey: "save-2", title: "菜谱", text: "番茄炒蛋的做法。" });
    await vectorsSettled(t.materials);
    const [hit] = await t.materials.searchSemantic("想换个地方住", { limit: 1 });
    expect(hit!.material.segments[0]!.label).toBe(`清单（${PAGE.url}）`);
  });

  test("推断不拿网页正文当用户的话：正文不进切段（没有本人的段）、不进原文副本；存的这个动作（什么时候存了什么网页）在信封上", () => {
    const { t, pages } = setup();
    pages().save(PAGE);
    const [material] = t.materials.list();
    expect(material!.segments.filter((s) => s.source === "self")).toEqual([]);
    expect(JSON.stringify(material!.segments)).not.toContain("灵隐寺");
    expect(fs.readFileSync(path.join(t.materialsDir, material!.original!.path), "utf8")).not.toContain("灵隐寺");
    expect(material).toMatchObject({ source: "self", time: TIME, context: [SAVED_WEB_PAGE_CONTEXT] });
  });

  test("166 之前存的网页（索引里没有正文）：守护进程起来时按原始事件把正文补进索引，向量重算；只补一次", async () => {
    const { t, pages } = setup();
    const { materialId } = pages().save(PAGE);
    await vectorsSettled(t.materials);
    // 扮成 166 之前的库：索引文字只有引用的说明，没记过索引文字的版本
    const label = `${PAGE.title}（${PAGE.url}）`;
    const embedder = new FakeEmbedder();
    await t.reopen({
      embedder,
      materialsDbSql: [
        `UPDATE materials SET search_text = '${label}'`,
        "DELETE FROM material_fts",
        `INSERT INTO material_fts (material_id, body) VALUES ('${materialId}', '${label}')`,
        "DELETE FROM capture_state WHERE key = 'search_text_version'",
      ],
    });
    expect(t.materials.searchKeyword("灵隐寺").map((m) => m.id)).toEqual([materialId]);
    expect(t.logs.join("\n")).toContain("按原始事件重算了 1 条素材的索引文字");
    // 向量按新的索引文字重算（启动后的补算过一会儿才开始）
    expect(t.materials.vectorStatus()).toMatchObject({ pending: 1 });
    t.clock.advance(BACKFILL_DELAY_MS);
    await vectorsSettled(t.materials);
    expect(embedder.calls.flat()).toEqual([`${label}\n${PAGE.text}`]);

    // 再起来不再重算
    await t.reopen();
    expect(t.logs.filter((l) => l.includes("重算了"))).toHaveLength(1);
  });

  test("忘掉这一条后按正文也检索不到（彻底删除在主切面测）", () => {
    const { t, pages } = setup();
    const { materialId } = pages().save(PAGE);
    t.store.append({
      channel: MATERIALS_CHANNEL,
      type: EVENT_TYPES.memoryCommand,
      payload: { commandId: "cmd-1", command: "forget", materialIds: [materialId], from: { kind: "settings", scope: { kind: "material", materialId } } } satisfies MemoryCommandEventPayload,
    });
    expect(t.materials.get(materialId)).toBeUndefined();
    expect(t.materials.searchKeyword("灵隐寺")).toEqual([]);
  });

  test("同一个幂等键重发只存一次、回同一个结果；没标题时网页那一段只写网址", () => {
    const { t, pages } = setup();
    const first = pages().save(PAGE);
    expect(pages().save({ ...PAGE, title: "改了也不算" })).toEqual(first);
    expect(t.store.read(MATERIALS_CHANNEL, 0, EVENT_TYPES.webPageSaved)).toHaveLength(1);

    pages().save({ ...PAGE, idempotencyKey: "save-2", title: "  ", text: "" });
    expect(t.materials.list().map((m) => m.segments[0]!.label)).toEqual([`${PAGE.title}（${PAGE.url}）`, PAGE.url]);
  });

  test("记忆插件没开（素材库只保管）时也回素材 id：开了以后采出来就是这个 id", async () => {
    const { t, pages } = setup({ collect: false });
    const result = pages().save(PAGE);
    expect(t.materials.list({ kind: "fed_material" }).map((m) => m.id)).toEqual([result.materialId]);
    await t.reopen({ collect: true });
    expect(t.materials.get(result.materialId)).toMatchObject({ context: [SAVED_WEB_PAGE_CONTEXT] });
  });
});

describe("彻底删除", () => {
  test("改写函数把标题、地址、正文换成删除标记，编号、时间、截没截、字数不变；改写过的事件不再采成素材", () => {
    const { t, pages } = setup();
    pages().save(PAGE);
    const [event] = t.store.read(MATERIALS_CHANNEL, 0, EVENT_TYPES.webPageSaved);
    const rewritten = webPageSavedPurge.rewrite(event!, { deletedAt: TIME, materialIds: new Set() });
    expect(webPageSavedPurge.eventType).toBe(EVENT_TYPES.webPageSaved);
    expect(rewritten).toEqual({ id: "wp-test-1", time: TIME, title: PURGED_TEXT, url: PURGED_TEXT, text: PURGED_TEXT, truncated: false, total: 23 });
    expect(webPageSavedSource.capture({ ...event!, payload: rewritten })).toEqual([]);
  });
});
