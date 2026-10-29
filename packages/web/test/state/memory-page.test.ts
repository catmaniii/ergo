// 285 号票：记忆页的说法——顶上"和记忆管理员聊"那张卡的两行（最近一次整理、了解你访谈），记忆管理员整页对话里输入框上面那一行。
// 档案的四组（我 / 家人 / 重要的人 / 其他人）。
import { describe, expect, test } from "vitest";
import {
  type InterviewStatusView,
  type MemorySummaryView,
  memoryInterviewBar,
  memoryKeeperInterviewLine,
  memoryKeeperNightLine,
  personalFileGroups,
  type PersonalFileSummary,
} from "../../src/state/index.ts";

const summary = (lastNight?: MemorySummaryView["lastNight"]): MemorySummaryView => ({
  ready: true,
  total: 4,
  tiers: { state: 1, preference: 1, need: 2, value: 0 },
  statuses: { active: 3, contested: 1, retracted: 0, superseded: 0 },
  openQuestions: 2,
  ...(lastNight === undefined ? {} : { lastNight }),
});

const status = (over: Partial<InterviewStatusView> = {}): InterviewStatusView => ({ covered: ["family"], next: "work_day", cadence: "weekly", invites: true, ...over });

describe("和记忆管理员聊那张卡", () => {
  test("最近一次整理：跑过的写哪天、新出几条；没跑成写结局；还没整理过、推理库读不到写每晚 03:00 整理", () => {
    expect(memoryKeeperNightLine(summary({ night: "2026-10-10", at: "2026-10-10T03:20:00+08:00", state: "ran", newClaims: 2, changedClaims: 1, needsReview: 1 }))).toBe(
      "每晚 03:00 整理 · 10-10 新出 2 条、变了 1 条、待复核 1 条",
    );
    expect(memoryKeeperNightLine(summary({ night: "2026-10-11", at: "2026-10-11T03:20:00+08:00", state: "failed", newClaims: 0, changedClaims: 0, needsReview: 0 }))).toBe("每晚 03:00 整理 · 10-11 出错了");
    expect(memoryKeeperNightLine(summary())).toBe("每晚 03:00 整理 · 还没整理过");
    expect(memoryKeeperNightLine({ ...summary(), ready: false } as MemorySummaryView)).toBe("每晚 03:00 由它整理");
    expect(memoryKeeperNightLine(undefined)).toBe("每晚 03:00 由它整理");
  });

  test("了解你访谈：聊过几个、下次聊什么；正在聊写主题；取不到写一句说明", () => {
    expect(memoryKeeperInterviewLine(status())).toBe("了解你访谈：五个主题聊过 1/5，下次聊：工作和一天怎么过");
    expect(memoryKeeperInterviewLine(status({ active: { id: "iv-1", topic: "family", startedAt: "2026-10-26T10:00:00+08:00", by: "page" } }))).toBe("正在访谈：家里的人和基本情况，点进去接着聊");
    expect(memoryKeeperInterviewLine(undefined)).toBe("了解你访谈：记忆管理员一次问一个主题，十来分钟，随时能停");
  });
});

describe("记忆管理员对话里输入框上面那一行", () => {
  test("没在聊：了解你访谈 · 聊过几个 · 下次聊什么，能开始；正在聊：主题和怎么停，不再给开始", () => {
    expect(memoryInterviewBar(status())).toEqual({ title: "了解你访谈", detail: " · 聊过 1/5 · 下次：工作和一天怎么过", canStart: true });
    expect(memoryInterviewBar(status({ active: { id: "iv-1", topic: "work_day", startedAt: "2026-10-26T10:00:00+08:00", by: "page" } }))).toEqual({
      title: "正在访谈：工作和一天怎么过",
      detail: " · 想停就说“就到这里”",
      canStart: false,
    });
    // 五个都聊过以后：下次聊"最近有什么变化"
    const done = memoryInterviewBar(status({ covered: ["family", "work_day", "choices", "cares", "help"], next: "changes", cadence: "monthly" }));
    expect(done.detail).toBe(" · 聊过 5/5 · 下次：最近有什么变化");
    expect(done.canStart).toBe(true);
  });
});

const person = (id: string, name: string, over: Partial<PersonalFileSummary> = {}): PersonalFileSummary => ({ id, kind: "person", name, filled: 1, notes: 0, ...over });

describe("档案的四组（285 号票）", () => {

  test("我、家人、重要的人、其他人，组里按建的先后；本人那份在\"我\"；空的组也列（写还没有）", () => {
    const groups = personalFileGroups({
      files: [
        { id: "me", kind: "self", filled: 3, notes: 0 },
        person("p-zhang", "小张", { relation: "同事", group: "important" }),
        person("p-mom", "妈妈", { relation: "母亲", group: "family", groupGuessed: true }),
        person("p-wang", "王师傅", { group: "others", groupGuessed: true }),
        person("p-girl", "女儿", { relation: "女儿", group: "family", groupGuessed: true }),
      ],
    });
    expect(groups.map((g) => [g.id, g.title, g.files.map((f) => f.id)])).toEqual([
      ["me", "我", ["me"]],
      ["family", "家人", ["p-mom", "p-girl"]],
      ["important", "重要的人", ["p-zhang"]],
      ["others", "其他人", ["p-wang"]],
    ]);
    expect(personalFileGroups({ files: [{ id: "me", kind: "self", filled: 0, notes: 0 }] }).map((g) => g.files.length)).toEqual([1, 0, 0, 0]);
  });

  test("没带分组的（老的守护进程）按关系猜", () => {
    const groups = personalFileGroups({ files: [{ id: "me", kind: "self", filled: 0, notes: 0 }, person("p-mom", "妈妈", { relation: "妈妈" }), person("p-li", "小李", { relation: "朋友" })] });
    expect(groups.map((g) => g.files.map((f) => f.id))).toEqual([["me"], ["p-mom"], [], ["p-li"]]);
  });
});
