// 消耗页和任务详情的用量（24 号票）：范围的快捷选项、范围里的每一天、agent 的叫法。录下的真实事件流回放在 recorded.test.ts 的 token-ledger。
import { describe, expect, test } from "vitest";
import { agentLabel, rangeDays, replay, taskUsage, usageAgentName, usageRange } from "../../src/state/index.ts";
import { frame } from "./events.ts";

describe("消耗页的范围", () => {
  const now = new Date(2026, 9, 8, 15, 30);
  test.each([
    ["today", { from: "2026-10-08", to: "2026-10-08" }],
    ["7d", { from: "2026-10-02", to: "2026-10-08" }],
    ["30d", { from: "2026-09-09", to: "2026-10-08" }],
    ["month", { from: "2026-10-01", to: "2026-10-08" }],
  ] as const)("%s", (preset, expected) => {
    expect(usageRange(preset, now)).toEqual(expected);
  });

  test("范围里的每一天：含两头，跨月", () => {
    expect(rangeDays("2026-09-29", "2026-10-02")).toEqual(["2026-09-29", "2026-09-30", "2026-10-01", "2026-10-02"]);
    expect(rangeDays("2026-10-08", "2026-10-08")).toEqual(["2026-10-08"]);
  });
});

describe("agent 的叫法", () => {
  test("秘书就叫秘书，别的是角色加 id；消耗页上维护者带上它所在的项目或任务", () => {
    expect(agentLabel("secretary", "secretary")).toBe("秘书");
    expect(agentLabel("review-t-1-s2-1", "reviewer")).toBe("评审子 agent review-t-1-s2-1");
    const state = replay([
      frame("board", 1, "task", { task: { id: "t-1", title: "X 的调研", maintainerId: "tm-1" }, change: "created", from: null, by: "user" }),
      frame("projects", 1, "project", { project: { id: "p-1", name: "记账本", maintainerId: "pm-1" }, change: "created", from: null, by: "user" }),
    ]);
    expect(usageAgentName(state, "tm-1", "maintainer")).toBe("任务「X 的调研」的维护者");
    expect(usageAgentName(state, "pm-1", "maintainer")).toBe("项目「记账本」的维护者");
    expect(usageAgentName(state, "tm-9", "maintainer")).toBe("维护者 tm-9");
  });

  test("未归属的 agent 在消耗页上就写 id", () => {
    expect(usageAgentName(replay([]), "stray-1", "unattributed")).toBe("stray-1");
  });

  test("任务详情里范围审视、压缩各单独一行，标出来", () => {
    const tokens = { cacheHit: 10, cacheMiss: 5, output: 1 };
    const state = replay([
      frame("board", 1, "token_totals", {
        owner: { kind: "task", id: "t-1" },
        tokens: { cacheHit: 30, cacheMiss: 15, output: 3 },
        calls: 3,
        byAgent: [
          { agentId: "tm-1", role: "maintainer", purpose: "work", tokens, calls: 1 },
          { agentId: "tm-1", role: "maintainer", purpose: "scope_review", tokens, calls: 1 },
          { agentId: "tm-1", role: "maintainer", purpose: "compaction", tokens, calls: 1 },
        ],
        byStage: [],
        time: "2026-10-08T10:00:00.000+08:00",
      }),
    ]);
    expect(taskUsage(state, "t-1")).toEqual({
      rows: [
        expect.objectContaining({ label: "维护者 tm-1", total: 16, purpose: "work" }),
        expect.objectContaining({ label: "维护者 tm-1 · 范围审视", total: 16, purpose: "scope_review" }),
        expect.objectContaining({ label: "维护者 tm-1 · 压缩", total: 16, purpose: "compaction" }),
      ],
      total: 48,
      calls: 3,
    });
  });
});
