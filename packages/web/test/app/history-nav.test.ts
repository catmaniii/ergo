// 88 号票评审：标题栏的 ‹ 不再往浏览器历史里压新记录。看板 → 点卡进任务（压一条，记下从看板来）→ ‹：上一条就是看板，后退一步；
// 不是从看板来的（从待我处理的链接跳进来、刷新后打开的）就把这一条换成看板。浏览器的历史换成假的：一串记录加当前位置。
import { describe, expect, test } from "vitest";
import { backStep, backToHash, cameFrom, type HistoryEnv, pushHash } from "../../src/app/history-nav.ts";

/** 假的浏览器历史：location.hash 赋值压一条新记录（截掉前进的那几条），replace 换掉当前这条，back 退一条 */
function fakeHistory(start: string) {
  const entries: { hash: string; state: unknown }[] = [{ hash: start, state: null }];
  let at = 0;
  const env: HistoryEnv = {
    location: {
      get hash() {
        return entries[at]!.hash;
      },
      set hash(to: string) {
        if (to === entries[at]!.hash) return;
        entries.splice(at + 1, entries.length, { hash: to, state: null });
        at++;
      },
      replace(to: string) {
        entries[at] = { hash: to, state: null };
      },
    },
    history: {
      get state() {
        return entries[at]!.state;
      },
      back() {
        if (at > 0) at--;
      },
      replaceState(data: unknown) {
        entries[at] = { ...entries[at]!, state: data };
      },
    },
  };
  return {
    env,
    /** 现在在哪 */
    here: () => entries[at]!.hash,
    /** 全部记录 */
    list: () => entries.map((e) => e.hash),
    /** 浏览器的后退按钮 */
    browserBack: () => env.history.back(),
    /** 用户点了页面里的普通链接（<a href="#/…">）：浏览器压一条，不经 pushHash，没有来处 */
    clickLink: (to: string) => {
      env.location.hash = to;
    },
  };
}

describe("‹ 回到上一级不压新记录", () => {
  test("看板 → 点卡进任务 → ‹：后退一步回到看板；再按浏览器后退离开看板（回到秘书页），不会重新打开刚才的任务", () => {
    const h = fakeHistory("#/secretary");
    pushHash(h.env, "#/tasks");
    pushHash(h.env, "#/tasks/t-1");
    backToHash(h.env, "#/tasks");
    expect(h.here()).toBe("#/tasks");
    h.browserBack();
    expect(h.here()).toBe("#/secretary");
  });

  test("从待我处理的链接直接跳进任务（上一条不是看板）→ ‹：这一条换成看板，再后退回到待我处理", () => {
    const h = fakeHistory("#/inbox");
    h.clickLink("#/tasks/t-1");
    backToHash(h.env, "#/tasks");
    expect(h.list()).toEqual(["#/inbox", "#/tasks"]);
    h.browserBack();
    expect(h.here()).toBe("#/inbox");
  });

  test("经 navigate 从待我处理进任务（记下的来处是待我处理，不是看板）→ ‹：同样换掉这一条", () => {
    const h = fakeHistory("#/inbox");
    pushHash(h.env, "#/tasks/t-1");
    backToHash(h.env, "#/tasks");
    expect(h.list()).toEqual(["#/inbox", "#/tasks"]);
  });

  test("在任务里点进另一个任务、再 ‹：上一条是前一个任务，不是看板，换掉这一条；历史只有一条看板", () => {
    const h = fakeHistory("#/tasks");
    pushHash(h.env, "#/tasks/t-1");
    pushHash(h.env, "#/tasks/t-2");
    backToHash(h.env, "#/tasks");
    expect(h.list()).toEqual(["#/tasks", "#/tasks/t-1", "#/tasks"]);
  });

  test("去的就是现在这一页：不压记录、不改来处", () => {
    const h = fakeHistory("#/tasks");
    pushHash(h.env, "#/tasks");
    expect(h.list()).toEqual(["#/tasks"]);
    expect(h.env.history.state).toBeNull();
  });

  test("来处按地址认：写法不同的同一页算同一页（#tasks 和 #/tasks）；没记来处的按换掉", () => {
    expect(backStep("#/tasks", "#/tasks")).toBe("back");
    expect(backStep("#/tasks", "#tasks")).toBe("back");
    expect(backStep("#/tasks", "#/tasks/t-1")).toBe("replace");
    expect(backStep("#/tasks", undefined)).toBe("replace");
  });
});

describe("报告页的 ‹（113 号票）", () => {
  test("从会话里点附件卡片进来的：记着来处，‹ 后退一步回到那个会话", () => {
    const h = fakeHistory("#/secretary");
    pushHash(h.env, "#/tasks/t-1");
    pushHash(h.env, "#/report/abc");
    expect(cameFrom(h.env)).toBe("#/tasks/t-1");
    backToHash(h.env, cameFrom(h.env) ?? "#/secretary");
    expect(h.list()).toEqual(["#/secretary", "#/tasks/t-1", "#/report/abc"]);
    expect(h.here()).toBe("#/tasks/t-1");
  });

  test("直接打开的（刷新、收藏、别的设备点开链接）：没有来处", () => {
    const h = fakeHistory("#/report/abc");
    expect(cameFrom(h.env)).toBeUndefined();
  });
});
