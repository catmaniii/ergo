// 前端状态层回放 27 号票（skill 库、MCP 登记与工具包）主切面录下的事件流：
// - toolkit-change（toolkit.test.ts）：项目维护者不在任务里时申请开联网、加 MCP（同时关掉 bash：减少能力直接生效），
//   待我处理出现"工具包变更"卡；批准后项目的工具包扩大，再申请开 bash 被拒绝；
//   每次变更都是维护者会话时间线上的一条记录（toolkit）。
// 重新录：ERGOU_RECORD_EVENTS=1 npx vitest run packages/daemon/test/main/toolkit.test.ts
import fs from "node:fs";
import path from "node:path";
import { describe, expect, test } from "vitest";
import {
  cardDisplay,
  inboxEntries,
  replay,
  selectProject,
  timelineItems,
  type TimelineRecord,
  type ToolkitChangeCardPayload,
  toolkitText,
  type UiInput,
  type UiState,
} from "../../src/state/index.ts";

function load(name: string): UiInput[] {
  return JSON.parse(fs.readFileSync(path.join(import.meta.dirname, "recordings", `${name}.json`), "utf8")) as UiInput[];
}

const toolkitCards = (state: UiState) => Object.values(state.cards).filter((c) => c.card.type === "toolkit_change");
const records = (state: UiState): TimelineRecord[] =>
  timelineItems(state, "maintainer:pm-1").flatMap((it) => (it.kind === "record" && it.record.type === "timeline" ? [it.record.timeline] : []));

describe("回放：工具包变更卡（toolkit-change）", () => {
  const inputs = load("toolkit-change");
  const final = replay(inputs);

  test("两张工具包变更卡：这个页面认识这种卡（按类型显示，不降级）；第一张批准、第二张拒绝", () => {
    const cards = toolkitCards(final);
    expect(cards.map((c) => [c.card.status, c.card.outcome?.action])).toEqual([
      ["handled", "approve"],
      ["handled", "deny"],
    ]);
    for (const c of cards) expect(cardDisplay(final, c.card.id)).toMatchObject({ kind: "typed", type: "toolkit_change" });
    const first = cards[0]!.card.payload as ToolkitChangeCardPayload;
    expect(first.additions).toEqual(["MCP demo", "联网"]);
    expect(toolkitText(first.applied!)).toBe("bash 关、联网开；skill：无；MCP：demo");
  });

  test("卡出来时在待我处理里（待处理）；处理之后移到已处理", () => {
    const at = inputs.findIndex((i) => i.kind === "frame" && i.frame.type === "inbox_item");
    const pending = replay(inputs.slice(0, at + 1));
    const cardId = toolkitCards(final)[0]!.card.id;
    const isCard = (e: { item: { kind: string; cardId?: string } }) => e.item.kind === "card" && e.item.cardId === cardId;
    expect(inboxEntries(pending, "open").some(isCard)).toBe(true);
    expect(inboxEntries(final, "open").some(isCard)).toBe(false);
    expect(inboxEntries(final, "done").some(isCard)).toBe(true);
  });

  test("项目的工具包跟着变：关 bash 直接生效，批准后加上 MCP 和联网，拒绝的不加", () => {
    expect(selectProject(final, "p-1")?.project.toolkit).toEqual({ skills: [], mcp: ["demo"], bash: false, network: true });
  });

  test("维护者会话的时间线上每次变更一条记录", () => {
    expect(records(final).filter((r) => r.kind === "toolkit").map((r) => r.summary)).toEqual([
      "维护者减少了能力（要给老王发笔记）：去掉 bash",
      "你批准了工具包变更：加上 MCP demo、联网",
    ]);
  });
});
