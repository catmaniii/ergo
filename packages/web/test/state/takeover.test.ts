// 从已有的会话接管（290 号票）在网页这一侧的状态层：哪个运行时能接管、会话那一行的第二行（分支 · 最近活动 · 大小）、
// 选中被占着的那个时的说明（终端里开着的、二狗自己在管的）、什么时候能点"接管"、接管好了的提示、⚙ 里接管来的那一行。
// 292 号票：⚙ 里"会话在哪边"那一块按二狗接管 / 官方 App / 空着给说法、链接和按钮（二狗自己开的会话没有"交还"），卡上的"在官方 App 里"。
import { describe, expect, it } from "vitest";
import {
  activityAgo,
  type AgentRuntimeStateView,
  type AgentRuntimeView,
  RUNTIME_OPERATIONS,
  type ResumableSessionView,
  type RuntimeCapabilities,
  sessionMetaLine,
  takeoverPick,
  takeoverReady,
  takeoverRuntime,
  remoteBadgeOf,
  takeoverPanel,
  takeoverStateLines,
  takeoverToast,
} from "../../src/state/index.ts";

const caps = (yes: readonly string[]): RuntimeCapabilities => Object.fromEntries(RUNTIME_OPERATIONS.map((op) => [op, yes.includes(op)])) as RuntimeCapabilities;
const PI: AgentRuntimeView = { id: "pi", title: "pi", available: true, capabilities: caps(["rollback"]), settings: [] };
const CLAUDE: AgentRuntimeView = { id: "claude-code", title: "Claude Code", plugin: "claude-code", available: true, capabilities: caps(["take_over", "compact"]), settings: [] };
const NOW = Date.parse("2026-10-25T12:00:00+08:00");

const idle: ResumableSessionView = { id: "s-1", title: "修 CI 的 flaky 测试", cwd: "D:\\code\\flaky-ci", branch: "fix/flaky", updatedAt: "2026-10-25T11:34:00+08:00", bytes: 2_412_000 };
const terminal: ResumableSessionView = { id: "s-2", title: "记账本导出", cwd: "D:\\code\\ledger", updatedAt: "2026-10-25T11:59:40+08:00", busy: "在终端里开着（进程 21844）" };
const held: ResumableSessionView = { ...idle, id: "s-3", busy: "任务 t-9「修 CI 的 flaky 测试」在管（交还之前别的不能接管）", heldBy: { kind: "task", id: "t-9", title: "修 CI 的 flaky 测试", maintainerId: "tm-9" } };

describe("从已有的会话接管（网页状态层，290 号票）", () => {
  it("能接管已有会话的运行时：现在能用、能力清单里 take_over 的才算", () => {
    expect(takeoverRuntime([PI, CLAUDE], "claude-code")).toBe(CLAUDE);
    expect(takeoverRuntime([PI, CLAUDE], "pi")).toBeUndefined();
    expect(takeoverRuntime([PI, { ...CLAUDE, available: false }], "claude-code")).toBeUndefined();
    expect(takeoverRuntime(undefined, "claude-code")).toBeUndefined();
  });

  it("会话那一行的第二行：分支 · 最近活动 · 大小；最近活动按刚才、几分钟前、几小时前，再早的写日期时间", () => {
    expect(sessionMetaLine(idle, NOW)).toBe("分支 fix/flaky · 26 分钟前 · 2.3 MB");
    expect(sessionMetaLine(terminal, NOW)).toBe("刚才");
    expect(activityAgo("2026-10-25T09:00:00+08:00", NOW)).toBe("3 小时前");
    expect(activityAgo("2026-10-23T09:05:00+08:00", NOW)).toBe("10-23 09:05");
  });

  it("选中被占着的：说清为什么不能直接接（终端里开着的没有锁会分叉）、能分叉一份；二狗自己在管的写明是谁", () => {
    expect(takeoverPick(idle, "Claude Code")).toEqual({ busy: false, note: undefined });
    const busy = takeoverPick(terminal, "Claude Code");
    expect(busy.busy).toBe(true);
    expect(busy.note).toBe("在终端里开着（进程 21844）。Claude Code 的会话记录没有锁，直接接会分叉、丢掉一边说的话：先在那边关掉再点刷新，或者勾上下面的“分叉一份接管”（原会话不动）。");
    expect(takeoverPick(held, "Claude Code").note).toBe("任务 t-9「修 CI 的 flaky 测试」在管（交还之前别的不能接管）。要另起一份，勾上下面的“分叉一份接管”（原会话不动）。");
  });

  it("什么时候能点接管：选了会话；被占着的要勾分叉；接成任务要写接着做什么，接成项目可以不写", () => {
    expect(takeoverReady({ session: undefined, fork: false, as: "task", request: "接着修" })).toBe(false);
    expect(takeoverReady({ session: idle, fork: false, as: "task", request: "  " })).toBe(false);
    expect(takeoverReady({ session: idle, fork: false, as: "task", request: "接着修" })).toBe(true);
    expect(takeoverReady({ session: idle, fork: false, as: "project", request: "" })).toBe(true);
    expect(takeoverReady({ session: terminal, fork: false, as: "project", request: "" })).toBe(false);
    expect(takeoverReady({ session: terminal, fork: true, as: "project", request: "" })).toBe(true);
  });

  it("接管好了的提示：接着那个会话，或者分叉了一份", () => {
    expect(takeoverToast({ as: "task", id: "t-9", title: "修 CI 的 flaky 测试", fork: false, runtimeTitle: "Claude Code" })).toBe("接管好了：任务 t-9「修 CI 的 flaky 测试」接着 Claude Code 的这个会话");
    expect(takeoverToast({ as: "project", id: "p-3", title: "家里的知识库", fork: true, runtimeTitle: "Claude Code" })).toBe("分叉了一份接管：项目 p-3「家里的知识库」（原来的 Claude Code 会话不动）");
  });

  it("⚙ 里接管来的那一行：接管自哪个会话（分叉的写明）、工作目录；管着、交还了的说法不同；不是接管来的没有", () => {
    const state: AgentRuntimeStateView = { id: "claude-code", title: "Claude Code", settings: {}, takeover: { sessionId: "s-1", title: "修 CI 的 flaky 测试", cwd: "D:\\code\\flaky-ci", returned: false, place: "ergo" } };
    expect(takeoverStateLines(state)).toEqual({
      head: "接管自 Claude Code 会话「修 CI 的 flaky 测试」",
      where: "工作目录 D:\\code\\flaky-ci",
      note: "管着期间只有这里写它；要回终端里用，先交还给 Claude Code。",
    });
    const returned = takeoverStateLines({ ...state, takeover: { ...state.takeover!, forkedFrom: "s-0", returned: true, place: "returned" } });
    expect(returned?.head).toBe("接管自 Claude Code 会话「修 CI 的 flaky 测试」分叉的一份");
    expect(returned?.note).toBe("已交还给 Claude Code：这里不再写它，维护者也不接着做；收回前会核对它没在别处开着。");
    expect(takeoverStateLines({ id: "pi", title: "pi", settings: {} })).toBeUndefined();
  });

  it("⚙ 里会话在哪边（292 号票）：二狗接管着的能交给官方 App、接管来的还能交还；在官方 App 里的给链接和收回；空着的收回或交给官方 App", () => {
    const base: AgentRuntimeStateView = { id: "claude-code", title: "Claude Code", settings: {}, remoteControl: true, takeover: { sessionId: "s-1", title: "修 CI 的 flaky 测试", cwd: "D:/code/flaky-ci", returned: false, place: "ergo" } };
    const ergo = takeoverPanel(base, "二狗")!;
    expect(ergo.place).toBe("ergo");
    expect(ergo.buttons).toEqual([
      { action: "remote", label: "交给官方 App", primary: false },
      { action: "return", label: "交还给 Claude Code", primary: false },
    ]);
    const remote = takeoverPanel({ ...base, takeover: { ...base.takeover!, returned: true, place: "remote", url: "https://claude.ai/code/session_01Demo" } }, "小白")!;
    expect(remote).toMatchObject({ place: "remote", url: "https://claude.ai/code/session_01Demo", note: "在 Claude Code 的官方 App 里接着：这里不写它，那边的进度只读跟着补记过来；收回时先停掉那边的后台会话。" });
    expect(remote.buttons).toEqual([{ action: "reclaim", label: "收回到小白", primary: true }]);
    // 链接还没拿到：写明，能重新打开一次（拿链接）
    const noLink = takeoverPanel({ ...base, takeover: { ...base.takeover!, returned: true, place: "remote" } }, "二狗")!;
    expect(noLink.noLink).toBe("链接还没拿到");
    expect(noLink.buttons.map((b) => b.label)).toEqual(["收回到二狗", "重新打开官方 App 那边"]);
    const returned = takeoverPanel({ ...base, takeover: { ...base.takeover!, returned: true, place: "returned" } }, "二狗")!;
    expect(returned.buttons.map((b) => b.action)).toEqual(["reclaim", "remote"]);
    // 二狗自己开的会话：还没交过的只有"交给官方 App"；交过的没有"交还"
    const fresh = takeoverPanel({ id: "claude-code", title: "Claude Code", settings: {}, remoteControl: true }, "二狗")!;
    expect(fresh).toMatchObject({ place: "ergo", note: "这个会话现在在这里：要在手机上、claude.ai 上接着，交给官方 App；之后在这里收回。" });
    expect(fresh.head).toBeUndefined();
    expect(fresh.buttons.map((b) => b.action)).toEqual(["remote"]);
    const own = takeoverPanel({ ...base, takeover: { ...base.takeover!, own: true } }, "二狗")!;
    expect(own.head).toBe("Claude Code 会话「修 CI 的 flaky 测试」（这里开的）");
    expect(own.buttons.map((b) => b.action)).toEqual(["remote"]);
    // 不能交给官方 App、也不是接管来的：没有这一块；pi 没有
    expect(takeoverPanel({ id: "pi", title: "pi", settings: {} }, "二狗")).toBeUndefined();
  });

  it("卡上的「在官方 App 里」（292 号票）：在官方 App 里才有，拿到的链接带上", () => {
    const at = "2026-10-25T10:00:00.000+08:00";
    expect(remoteBadgeOf(undefined)).toBeUndefined();
    expect(remoteBadgeOf({ runtime: "claude-code", sessionId: "s-1", title: "t", at })).toBeUndefined();
    expect(remoteBadgeOf({ runtime: "claude-code", sessionId: "s-1", title: "t", at, returnedAt: at })).toBeUndefined();
    expect(remoteBadgeOf({ runtime: "claude-code", sessionId: "s-1", title: "t", at, returnedAt: at, remote: { job: "s-1", sessionId: "s-1", url: "https://claude.ai/code/x", since: at } })).toEqual({ label: "在官方 App 里", url: "https://claude.ai/code/x" });
    // 收回过（since 去掉了）：不标
    expect(remoteBadgeOf({ runtime: "claude-code", sessionId: "s-1", title: "t", at, remote: { job: "s-1", sessionId: "s-1" } })).toBeUndefined();
  });
});
