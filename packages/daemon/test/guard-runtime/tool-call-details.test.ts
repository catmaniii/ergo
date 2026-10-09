// 工具调用完整内容的派生视图（53 号票；65 号票加了时间、大小、任务、样子几列）：53 号票建的表在打开时删掉重建、从事件日志补回来。
// 彻底删除过的事件里只剩删除标记，补回来的也只有删除标记，原文补不回来。
import path from "node:path";
import { PURGED_TEXT, type ToolCallDetail } from "@ergou/protocol";
import { expect, test } from "vitest";
import { openEventStore } from "../../src/events/event-store.ts";
import { detailEventsOfCall, detailTotals, findToolCallDetail, fullDetails, recordToolCallDetail, toolCallDetailPurge, toolCallDetailsView } from "../../src/guard-runtime/tool-call-details.ts";
import { openDatabase } from "../../src/storage/sqlite.ts";
import { makeTempDir } from "../helpers/temp-dir.ts";

const detail = (callId: string, content: string): ToolCallDetail => ({
  callId,
  tool: "write",
  toolTitle: "写文件",
  agentId: "secretary",
  conversation: "secretary",
  outcome: "blocked",
  endedAt: "2026-10-09T10:00:00.000+08:00",
  args: { path: "notes.md", content },
  result: `没有写：${content}`,
  isError: true,
});

/** 换回 53 号票建的表：只有调用 id、工具、agent、会话、项目，内容照事件日志填 */
function toLegacyTable(file: string): void {
  const db = openDatabase(file);
  try {
    db.exec(`
      DROP TABLE tool_call_details;
      CREATE TABLE tool_call_details (global_seq INTEGER PRIMARY KEY, call_id TEXT NOT NULL, tool TEXT NOT NULL, agent_id TEXT NOT NULL, conversation TEXT, project_id TEXT);
      INSERT INTO tool_call_details SELECT global_seq, json_extract(payload, '$.callId'), json_extract(payload, '$.tool'), json_extract(payload, '$.agentId'), json_extract(payload, '$.conversation'), NULL
        FROM events WHERE channel = 'tool_calls';
    `);
  } finally {
    db.close();
  }
}

test("53 号票的表打开时重建：彻底删除过的只剩删除标记、不算存着完整内容，原文补不回来；还存着的照样算大小", () => {
  const file = path.join(makeTempDir(), "ergou.db");
  let store = openEventStore({ file, views: [toolCallDetailsView] });
  recordToolCallDetail(store, detail("c-gone", "要彻底删除的那句原话"));
  recordToolCallDetail(store, detail("c-kept", "留着的内容"));
  const [gone] = detailEventsOfCall(store, "c-gone");
  store.appendBatch([], { purge: [{ globalSeq: gone!.globalSeq, payload: toolCallDetailPurge.rewrite(gone!, { deletedAt: "2026-10-09T11:00:00.000+08:00", materialIds: new Set() }) }] });
  const before = detailTotals(store.reader);
  store.close();

  toLegacyTable(file);
  store = openEventStore({ file, views: [toolCallDetailsView] });
  try {
    expect(findToolCallDetail(store, "c-gone")).toMatchObject({ purged: true, result: PURGED_TEXT, args: { path: PURGED_TEXT, content: PURGED_TEXT } });
    expect(fullDetails(store.reader).map((d) => d.callId)).toEqual(["c-kept"]);
    expect(detailTotals(store.reader)).toEqual(before);
    expect(detailTotals(store.reader)).toMatchObject({ full: 1, cleared: 0 });
    expect(JSON.stringify(store.readGlobal(0, 100))).not.toContain("那句原话");
    expect(JSON.stringify(store.reader.all("SELECT * FROM tool_call_details"))).not.toContain("那句原话");
  } finally {
    store.close();
  }
});
