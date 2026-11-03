// 主切面：秘书把读到的外部信息存进素材（ingest_material）。用户说"把这封邮件存下来"，假模型按剧本调 ingest_material，
// 再用 search_materials 按关键词检索：检索得到、结果里带出处；素材是"存下的外部信息"，来源外部（不可信）。
// 然后用户在记忆 · 素材里点开这一条彻底删除（范围是"这一条"，和详情页的按钮同一个接口）：再检索搜不到，原始事件改写成删除标记，
// 存它的那次工具调用改写（会话文件里也要改），正文整个事件日志里不剩。
// 走真的装配路径（组合根 + 插件清单 + 假模型），临时数据目录、假向量，不碰真的 ~/.ergo。
import {
  CHANNELS,
  EVENT_TYPES,
  isDeletedEventPayload,
  type MaterialIngestedEventPayload,
  type MessageEventPayload,
  type MessagePart,
  type MessagesPurgedEventPayload,
  PURGED_TEXT,
} from "@ergo/protocol";
import { describe, expect, it } from "vitest";
import { MATERIALS_CHANNEL } from "../../src/materials/index.ts";
import type { FauxStep } from "../../src/runtime/index.ts";
import { startTestDaemon } from "../helpers/daemon.ts";
import { TestFrontend } from "../helpers/frontend.ts";
import { materialsApi } from "../helpers/http.ts";

const { secretary: SECRETARY } = CHANNELS;
const ALL = { [SECRETARY]: 0 };

/** 秘书读到的一封邮件（编的） */
const MAIL = {
  kind: "email",
  title: "物业通知：周六上午小区停水",
  text: "各位业主：本周六上午 8:00–12:00 二期水管检修，期间停水，请提前储水，带好门禁卡。",
  sourceRef: "<notice-0412@property.example.com>",
  capturedAt: "2026-10-07T08:55:00+08:00",
} as const;
/** 正文里不会出现在检索词、标题里的一段（彻底删除以后整个事件日志里搜它） */
const BODY_ONLY = "带好门禁卡";

const say = (text: string): FauxStep => ({ kind: "reply", text });
const ingest = (): FauxStep => ({ kind: "reply", toolCalls: [{ name: "ingest_material", arguments: MAIL }] });
const search = (query: string): FauxStep => ({ kind: "reply", toolCalls: [{ name: "search_materials", arguments: { query, why: "用户问物业那封邮件说了什么" } }] });
/** 删完以后用户再问的那句 */
const ASK_AGAIN = "物业那封邮件说了什么来着";
/**
 * 彻底删除以后秘书的会话文件改了、子进程重新拉起，假模型的剧本从头走：按上下文里有没有再问的那句分开
 * （没重新拉起时接着走后两步，也对）
 */
const SCRIPT: FauxStep[] = [
  { kind: "branch_on_context", contains: [ASK_AGAIN], matched: search("水管检修"), otherwise: ingest() },
  { kind: "branch_on_context", contains: [ASK_AGAIN], matched: say("没找到。"), otherwise: search("水管检修") },
  say("存好了。"),
  search("水管检修"),
  say("没找到。"),
];

/** 会话里某个工具调用的记录（守卫接入记的那一条） */
const toolCallParts = (td: Awaited<ReturnType<typeof startTestDaemon>>, tool: string): Array<Extract<MessagePart, { type: "tool_call" }>> =>
  td.daemon.store.read(SECRETARY, 0, EVENT_TYPES.message).flatMap((event) => {
    if (isDeletedEventPayload(event.payload)) return [];
    return (event.payload as MessageEventPayload).message.parts.flatMap((part) => (part.type === "tool_call" && part.tool === tool ? [part] : []));
  });

const ingestedEvents = (td: Awaited<ReturnType<typeof startTestDaemon>>) => td.daemon.store.read(MATERIALS_CHANNEL, 0, EVENT_TYPES.materialIngested);

describe("秘书存外部信息", () => {
  it("存一封邮件后按关键词检索得到、结果带出处；在素材里点彻底删除后检索不到，存它的那次调用改写，正文整个事件日志里不剩", { timeout: 90_000 }, async () => {
    const td = await startTestDaemon({ secretary: SCRIPT });
    const frontend = await TestFrontend.connect(td.url);
    try {
      await frontend.subscribe(ALL);
      const sent = await frontend.sendText("把物业那封停水的邮件存下来，再看看说了什么");
      await frontend.next(SECRETARY, EVENT_TYPES.turnEnd);

      // 存下了：过了守卫、做完了；事件记着会话、那条消息、那次调用
      const [call] = toolCallParts(td, "ingest_material");
      expect(call).toMatchObject({ tool: "ingest_material", outcome: "done" });
      const [event] = ingestedEvents(td);
      expect(event!.payload).toMatchObject({ ...MAIL, conversation: SECRETARY, inputMessageId: sent.messageId, toolCallId: call!.callId } satisfies Partial<MaterialIngestedEventPayload>);
      const material = td.daemon.materials.list({ conversation: SECRETARY }).find((m) => m.kind === "ingested_info")!;
      expect(material).toMatchObject({ source: "external_untrusted", original: null });

      // 检索得到，结果带出处
      const [found] = toolCallParts(td, "search_materials");
      expect(found!.resultSummary).toContain(material.id);
      expect(found!.resultSummary).toContain(`出处 ${MAIL.sourceRef}`);
      expect(found!.recall?.hits.map((h) => h.materialId)).toEqual([material.id]);

      // 记忆 · 素材里看得到：详情给出处、正文
      const detail = await materialsApi.detail(td.url, material.id);
      expect(detail.status).toBe(200);
      expect(detail.body).toMatchObject({ kind: "存下的外部信息", source: "external_untrusted", ingested: { kind: "email", sourceRef: MAIL.sourceRef } });

      // 用户点开这一条彻底删除（详情页的按钮：范围是"这一条"）
      const purged = await materialsApi.delete(td.url, { scope: { kind: "material", materialId: material.id }, mode: "purge", idempotencyKey: "purge-ingested-main" });
      expect(purged.status).toBe(200);
      const notice = (await frontend.next(SECRETARY, EVENT_TYPES.messagesPurged)).payload as MessagesPurgedEventPayload;
      // 存它的那次调用在会话文件里也要改（参数和结果整个换掉）
      expect(notice.toolCallIds).toContain(call!.callId);
      expect(td.daemon.materials.get(material.id)).toBeUndefined();
      // 原始事件只换掉标题、正文、出处
      expect(ingestedEvents(td).map((e) => e.payload)).toEqual([expect.objectContaining({ title: PURGED_TEXT, text: PURGED_TEXT, sourceRef: PURGED_TEXT, toolCallId: call!.callId })]);
      // 存它的那次调用的记录改写成删除标记
      expect(toolCallParts(td, "ingest_material")[0]).toMatchObject({ argsSummary: PURGED_TEXT, resultSummary: PURGED_TEXT });

      // 再问：检索不到了
      await frontend.sendText(ASK_AGAIN);
      await frontend.next(SECRETARY, EVENT_TYPES.turnEnd);
      const again = toolCallParts(td, "search_materials").at(-1)!;
      // （假向量会把彻底删除的那条记忆命令按语义带出来，不管它）
      expect(again.outcome).toBe("done");
      expect(again.resultSummary).not.toContain(material.id);
      expect(again.resultSummary).not.toContain("存下的外部信息");
      // 没有再存一条
      expect(ingestedEvents(td)).toHaveLength(1);
      // 正文整个事件日志里一个字不剩（含工具调用的完整内容）
      expect(JSON.stringify(td.daemon.store.readGlobal(0, 100_000))).not.toContain(BODY_ONLY);
    } finally {
      await frontend.close();
      await td.daemon.stop();
    }
  });
});
