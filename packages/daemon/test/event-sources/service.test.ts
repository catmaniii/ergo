// 项目的服务报的事件的前台：谁在等（同一个项目、名字一字不差）、暂停着的不交、交给分发的那一条长什么样；过滤条件现查。
import type { EventTrigger } from "@ergo/protocol";
import { describe, expect, it } from "vitest";
import { createServiceEventDesk, type EventDelivery, type EventSubscription, type SourceEvent } from "../../src/event-sources/index.ts";

const trigger = (name: string): EventTrigger => ({ kind: "event", source: "service", events: ["reported"], filter: { name } });
const sub = (id: string, name: string, projectId: string, extra: Partial<EventSubscription> = {}): EventSubscription => ({ id, kind: "task", trigger: trigger(name), taskId: `t-${id}`, projectId, active: true, ...extra });
const report = { projectId: "p-1", service: "watcher", title: "评论监控", name: "评论异常", at: "2026-11-01T09:00:00+08:00", key: "k-1" };

function harness(subs: EventSubscription[], delivery: EventDelivery = { outcome: "queued", runId: "j-1-r1" }) {
  const desk = createServiceEventDesk();
  const got: Array<[string, SourceEvent]> = [];
  const source = desk.attach({
    emit: () => {},
    deliver: (s, e) => {
      got.push([s.id, e]);
      return delivery;
    },
    log: () => {},
  });
  source.sync(subs);
  return { desk, source, got };
}

describe("项目的服务报的事件", () => {
  it("只交给同一个项目里等这个名字的；名字一字不差；带上事件名、服务名、数据", () => {
    const { desk, got } = harness([sub("a", "评论异常", "p-1"), sub("b", "评论异常", "p-2"), sub("c", "价格异常", "p-1")]);
    expect(desk.names("p-1")).toEqual(["价格异常", "评论异常"]);
    expect(desk.deliver({ ...report, data: { count: 3 } })).toEqual({ outcome: "delivered", runs: [{ taskId: "t-a", runId: "j-1-r1", merged: false }], reasons: [] });
    expect(got.map(([id]) => id)).toEqual(["a"]);
    expect(got[0]![1]).toMatchObject({ source: "service", event: "reported", at: report.at, key: "k-1", data: { name: "评论异常", service: "watcher", data: { count: 3 } } });
    // 一句话说明不带数据
    expect(got[0]![1].summary).toBe("服务「评论监控」报了事件「评论异常」");
    expect(got[0]![1].summary).not.toContain("count");
  });

  it("没人等的：别的项目等这个名字也不算，说清现在能报哪些；不交出去", () => {
    const { desk, got } = harness([sub("b", "评论异常", "p-2"), sub("c", "价格异常", "p-1")]);
    expect(desk.deliver(report)).toEqual({ outcome: "no_waiter", names: ["价格异常"] });
    expect(got).toEqual([]);
  });

  it("等它的全暂停着：不交出去；有一个在运营的就交给在运营的", () => {
    const paused = harness([sub("a", "评论异常", "p-1", { active: false })]);
    expect(paused.desk.deliver(report)).toEqual({ outcome: "paused", names: ["评论异常"] });
    expect(paused.got).toEqual([]);
    const mixed = harness([sub("a", "评论异常", "p-1", { active: false }), sub("b", "评论异常", "p-1")]);
    expect(mixed.desk.deliver(report)).toMatchObject({ outcome: "delivered" });
    expect(mixed.got.map(([id]) => id)).toEqual(["b"]);
  });

  it("并进排着的算 merged；任务没接的写原因", () => {
    expect(harness([sub("a", "评论异常", "p-1")], { outcome: "merged", runId: "j-1-r2" }).desk.deliver(report)).toEqual({ outcome: "delivered", runs: [{ taskId: "t-a", runId: "j-1-r2", merged: true }], reasons: [] });
    expect(harness([sub("a", "评论异常", "p-1")], { outcome: "ignored", reason: "任务已取消" }).desk.deliver(report)).toEqual({ outcome: "delivered", runs: [], reasons: ["任务已取消"] });
  });

  it("简单提醒这类别的订阅方不算在等（建不出来，这里再挡一下）；还没接上分发时谁都不算在等", () => {
    const other = harness([{ id: "r-1", kind: "reminder", trigger: trigger("评论异常"), projectId: "p-1", active: true }]);
    expect(other.desk.deliver(report)).toEqual({ outcome: "no_waiter", names: [] });
    expect(createServiceEventDesk().deliver(report)).toEqual({ outcome: "no_waiter", names: [] });
  });

  it("停了之后谁都不算在等", () => {
    const { desk, source } = harness([sub("a", "评论异常", "p-1")]);
    source.stop();
    expect(desk.deliver(report)).toEqual({ outcome: "no_waiter", names: [] });
  });

  it("事件名现查：只能一行、不能太长；对的不说话", () => {
    const { source } = harness([]);
    expect(source.check(trigger("评论异常"))).toEqual([]);
    expect(source.check(trigger("评论\n异常"))[0]).toContain("只能写一行");
    expect(source.check(trigger("长".repeat(81)))[0]).toContain("最多 80 个字");
  });
});
