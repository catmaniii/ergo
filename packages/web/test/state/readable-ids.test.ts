// 给用户看的编号写成"编号「简短描述」"（159 号票加名字，163 号票统一成 t-3「标题」）：任务、项目、工单、定时作业、维护者、会话的名字从状态层现取，
// 名字变了跟着变；补发推完了还取不到的写"（已删除）"，还没推完的只写编号。
import { describe, expect, test } from "vitest";
import {
  ASSISTANT_NAME_MARK,
  conversationName,
  conversationPhrase,
  maintainerChannel,
  maintainerLabel,
  projectLabel,
  readableId,
  reduce,
  replay,
  taskLabel,
  type UiState,
  workOrderLabel,
} from "../../src/state/index.ts";
import { frame } from "./events.ts";

const task = (seq: number, id: string, title: string, maintainerId = `tm-${id.slice(2)}`, change = "created") =>
  frame("board", seq, "task", { task: { id, title, maintainerId }, change, from: null, by: "user" });
const project = (id: string, name: string, change = "created", seq = 1) =>
  frame("projects", seq, "project", { project: { id, name, maintainerId: `pm-${id.slice(2)}` }, change, from: null, by: "user" });

const synced = (state: UiState) => reduce(state, { kind: "synced" });

function sample(): UiState {
  return synced(
    replay([
      task(1, "t-1", "X 的调研"),
      task(2, "t-3", "给记账本加周报", "pm-1"),
      project("p-1", "记账本"),
      frame("projects", 2, "work_order", { workOrder: { id: "wo-2", projectId: "p-1", maintainerId: "pm-1", title: "加一个导出说明", taskId: "t-3" } }),
      frame("board", 3, "scheduled_job", { job: { id: "j-1", title: "每天备份", maintainerId: "jm-1" } }),
    ]),
  );
}

describe("编号「简短描述」", () => {
  test("任务、项目、工单写名字", () => {
    const state = sample();
    expect(taskLabel(state, "t-1")).toBe("t-1「X 的调研」");
    expect(projectLabel(state, "p-1")).toBe("p-1「记账本」");
    expect(workOrderLabel(state, "wo-2")).toBe("wo-2「加一个导出说明」");
  });

  test("维护者写它属于哪个任务、项目（项目在前：任务转为项目后维护者归项目）", () => {
    const state = sample();
    expect(maintainerLabel(state, "tm-1")).toBe("tm-1「X 的调研的任务维护者」");
    expect(maintainerLabel(state, "pm-1")).toBe("pm-1「记账本的项目维护者」");
    expect(maintainerLabel(state, "jm-1")).toBe("jm-1「每天备份的维护者」");
    // 任务 t-5 转为项目 p-5：维护者 tm-5 现在是项目的
    const converted = synced(replay([task(1, "t-5", "家电档案"), frame("projects", 1, "project", { project: { id: "p-5", name: "家电档案库", maintainerId: "tm-5" }, change: "created", from: null, by: "user" })]));
    expect(maintainerLabel(converted, "tm-5")).toBe("tm-5「家电档案库的项目维护者」");
  });

  test("按编号的开头认是哪种；认不出的原样", () => {
    const state = sample();
    expect(readableId(state, "t-3")).toBe("t-3「给记账本加周报」");
    expect(readableId(state, "p-1")).toBe("p-1「记账本」");
    expect(readableId(state, "wo-2")).toBe("wo-2「加一个导出说明」");
    expect(readableId(state, "j-1")).toBe("j-1「每天备份」");
    expect(readableId(state, "tm-1")).toBe("tm-1「X 的调研的任务维护者」");
    expect(readableId(state, "pm-1")).toBe("pm-1「记账本的项目维护者」");
    expect(readableId(state, "整理发票")).toBe("整理发票");
    expect(readableId(state, "c-3")).toBe("c-3");
    // 手里有的不管编号长什么样都认（原型里的编号不是数字）；手里没有、又不像编号的原样
    const named = synced(replay([task(1, "t-brief", "每天早上出早报")]));
    expect(readableId(named, "t-brief")).toBe("t-brief「每天早上出早报」");
    expect(readableId(named, "tm-brief")).toBe("tm-brief「每天早上出早报的任务维护者」");
    expect(readableId(named, "t-shirt")).toBe("t-shirt");
    expect(readableId(named, "t-9")).toBe("t-9（已删除）");
  });

  test("名字变了跟着变", () => {
    const renamed = reduce(sample(), { kind: "frame", frame: task(4, "t-1", "X 和 Y 的调研", "tm-1", "updated") });
    expect(taskLabel(renamed, "t-1")).toBe("t-1「X 和 Y 的调研」");
    expect(maintainerLabel(renamed, "tm-1")).toBe("tm-1「X 和 Y 的调研的任务维护者」");
  });

  test("取不到的：补发推完了写（已删除），还没推完只写编号", () => {
    const deleted = reduce(sample(), { kind: "frame", frame: project("p-1", "记账本", "deleted", 3) });
    expect(projectLabel(deleted, "p-1")).toBe("p-1（已删除）");
    expect(maintainerLabel(deleted, "pm-1")).toBe("pm-1（已删除）");
    expect(workOrderLabel(deleted, "wo-2")).toBe("wo-2（已删除）");
    expect(taskLabel(deleted, "t-9")).toBe("t-9（已删除）");
    const early = replay([]);
    expect(taskLabel(early, "t-9")).toBe("t-9");
    expect(maintainerLabel(early, "tm-9")).toBe("tm-9");
  });

  test("会话的名字：秘书主线写名字占位，维护者的写编号加它属于谁", () => {
    const state = sample();
    expect(conversationName(state, "secretary")).toBe(`${ASSISTANT_NAME_MARK}主线`);
    expect(conversationName(state, maintainerChannel("tm-1"))).toBe("tm-1「X 的调研的任务维护者」");
    expect(conversationName(state, maintainerChannel("pm-1"))).toBe("pm-1「记账本的项目维护者」");
    expect(conversationName(state, maintainerChannel("tm-9"))).toBe("tm-9（已删除）");
  });

  test("句子里说哪个会话（删除素材的确认框）：秘书主线的名字括「」，维护者的编号已经带「」了，不再套一层", () => {
    const state = sample();
    expect(conversationPhrase(state, "secretary")).toBe(`会话「${ASSISTANT_NAME_MARK}主线」`);
    expect(conversationPhrase(state, maintainerChannel("tm-1"))).toBe("会话 tm-1「X 的调研的任务维护者」");
    expect(conversationPhrase(state, maintainerChannel("tm-9"))).toBe("会话 tm-9（已删除）");
  });
});
