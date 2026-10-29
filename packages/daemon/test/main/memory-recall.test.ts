// 主切面：回话时调用记忆（187 号票）。秘书接 faux 剧本：用户问以前说过的事，秘书用 search_materials（带"为什么查" why）检索、
// 用 read_material 读其中一条的全文。网页收到的这两次调用的工具调用记录上带着结构化的部分（ToolCallPart.recall）：
// 为什么查、查了什么、找到读到的素材的编号、种类、时间、来源会话、怎么找出来的——网页据此把它们单独画成"回忆了 N 条记忆 ›"，
// 再按素材 id 现取原文和时间（GET /api/materials/<素材 id>）。给模型的文字照旧；没写 why 的调用 pi 按参数的 schema 拦下。
// 真实装配，秘书接 faux 剧本。
import { CHANNELS, EVENT_TYPES, type MaterialDetailView, type MessageEventPayload, type MessagePart } from "@ergo/protocol";
import { describe, expect, it } from "vitest";
import type { FauxStep } from "../../src/runtime/index.ts";
import { startTestDaemon } from "../helpers/daemon.ts";
import { TestFrontend } from "../helpers/frontend.ts";
import { materialsApi } from "../helpers/http.ts";

const { secretary: SECRETARY } = CHANNELS;
const WHY = "用户问自己对什么过敏，找他以前说过的";

const say = (text: string): FauxStep => ({ kind: "reply", text });
/** 从检索结果里抄出第一条素材 id 读全文 */
const readFirst: FauxStep = { kind: "call_with_matches", toolCall: { name: "read_material", arguments: {} }, argument: "materialId", pattern: "mat-[0-9a-f]{24}", first: true };

type ToolCallPart = Extract<MessagePart, { type: "tool_call" }>;
const toolPartsOf = (frontend: TestFrontend): ToolCallPart[] =>
  frontend
    .events({ channel: SECRETARY, type: EVENT_TYPES.message })
    .flatMap((f) => (f.payload as MessageEventPayload).message.parts)
    .filter((p): p is ToolCallPart => p.type === "tool_call");

async function tell(frontend: TestFrontend, text: string) {
  const sent = await frontend.sendText(text);
  await frontend.next(SECRETARY, EVENT_TYPES.turnEnd);
  return sent;
}

describe("回话时调用记忆", () => {
  it("检索（带为什么查）、读全文：网页收到的工具调用记录上带着结构化的命中（编号、种类、时间、来源会话、怎么找出来的），按编号取得到原文和时间", async () => {
    const { url, daemon } = await startTestDaemon({
      secretary: [
        say("记下了"),
        { kind: "reply", toolCalls: [{ name: "search_materials", arguments: { query: "芒果 过敏", why: WHY } }] },
        readFirst,
        { kind: "reply", toolCalls: [{ name: "search_materials", arguments: { query: "火星基地", why: "看用户有没有说过火星基地" } }] },
        say("你说过对芒果过敏"),
      ],
    });
    const frontend = await TestFrontend.connect(url);
    await frontend.subscribe({ [SECRETARY]: 0 });
    const said = await tell(frontend, "我对芒果过敏，吃了会起疹子");
    const material = daemon.materials.list().find((m) => m.ref.messageId === said.messageId)!;

    await tell(frontend, "我对什么过敏来着？");
    const [searched, read, nothing] = toolPartsOf(frontend);
    expect([searched!.tool, read!.tool, nothing!.tool]).toEqual(["search_materials", "read_material", "search_materials"]);
    // 检索：为什么查、查了什么、命中（关键词命中；向量模型在时还有语义的分数）
    expect(searched).toMatchObject({
      outcome: "done",
      recall: { source: "search", why: WHY, query: "芒果 过敏", hits: [{ materialId: material.id, kind: "user_utterance", time: material.time, conversation: SECRETARY, keyword: true }] },
    });
    expect(searched!.recall!.hits).toHaveLength(1);
    // 给模型的文字照旧（结果摘要里还是那一行）
    expect(searched!.resultSummary).toContain(`找到 1 条素材： - ${material.id}`);
    // 读全文：读到的那一条，没有命中方式
    expect(read).toMatchObject({ outcome: "done", recall: { source: "read", hits: [{ materialId: material.id, kind: "user_utterance", time: material.time, conversation: SECRETARY }] } });
    expect(read!.recall!.hits[0]).not.toHaveProperty("keyword");
    expect(read!.recall).not.toHaveProperty("why");
    // 查了没找到：命中是空的
    expect(nothing!.recall).toEqual({ source: "search", why: "看用户有没有说过火星基地", query: "火星基地", hits: [] });

    // 网页按编号取原文和时间（记忆页同一个接口）
    const detail = await materialsApi.detail(url, material.id);
    expect(detail.status).toBe(200);
    expect(detail.body as MaterialDetailView).toMatchObject({ id: material.id, time: material.time, conversation: SECRETARY, message: { id: said.messageId, state: "shown" }, segments: [{ source: "self", text: "我对芒果过敏，吃了会起疹子" }] });
    // 编号取不到（忘掉、彻底删除了）是 404，网页写"这条记忆已删除"
    expect((await materialsApi.detail(url, "mat-000000000000000000000000")).status).toBe(404);
  });

  it("没写为什么查的检索：按参数的 schema 拦下（模型收到参数不对），没有结构化的部分", async () => {
    const { url } = await startTestDaemon({
      secretary: [{ kind: "reply", toolCalls: [{ name: "search_materials", arguments: { query: "芒果" } }] }, say("好")],
    });
    const frontend = await TestFrontend.connect(url);
    await frontend.subscribe({ [SECRETARY]: 0 });
    await tell(frontend, "我对什么过敏来着？");
    const parts = toolPartsOf(frontend);
    // pi 先按 schema 校验：不合的调用不执行、不经守卫，会话里没有这次调用的记录（也就没有结构化的部分）
    expect(parts.filter((p) => p.recall !== undefined)).toEqual([]);
  });
});
