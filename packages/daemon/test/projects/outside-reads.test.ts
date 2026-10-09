// 删除项目时找项目之外读过这个项目的调用（66 号票，projects/outside-reads.ts）：
// - 读项目档案的工具（秘书、跨项目任务自己的维护者，哪个会话里的都算）按返回开头的"项目 p-N"认，不按参数里的名字；
// - 参数里写着路径的，秘书会话里的和不在任何会话里的（评审子 agent 的）：碰到的路径取调用时守卫规范化过的（效果日志里的）
//   和完整参数里写死的绝对路径（通用 bash 按守卫的拆法拆）；和项目档案、工作目录有包含关系就算，任一方向（读了上级目录、
//   递归扫到项目里也算），按真实路径比（经目录联接读到的也算），通配符先展开，展不开的按通配符之前的那段目录。
// 读别的项目、读项目外文件的、这个项目自己的维护者会话里的、彻底删除过的不算。主切面（真的秘书、跨项目任务的维护者和评审读，
// 删项目之后取不到）在 test/main/project-deletion-reads.test.ts。
import fs from "node:fs";
import path from "node:path";
import { nowIso, type Project, type ToolCallDetail } from "@ergou/protocol";
import { expect, test } from "vitest";
import { type EventStore, openEventStore } from "../../src/events/event-store.ts";
import type { EffectRecord } from "../../src/guard/index.ts";
import { effectLogView } from "../../src/guard-runtime/effect-log.ts";
import { type EffectRecordedPayload, GUARD_CHANNEL, GUARD_EVENTS } from "../../src/guard-runtime/events.ts";
import { clearedDetail, recordToolCallDetail, toolCallDetailsView } from "../../src/guard-runtime/tool-call-details.ts";
import { expandWildcards, outsideReadsOf, pathsOfCall } from "../../src/projects/outside-reads.ts";
import { projectRecordsPaths } from "../../src/projects/records.ts";
import { realPathOf } from "../../src/util/real-path.ts";
import { makeTempDir } from "../helpers/temp-dir.ts";

const project = (id: string, name: string): Project => ({
  id,
  name,
  goal: `${name}的目标`,
  state: "archived",
  origin: "suggestion",
  maintainerId: `pm-${id.slice(2)}`,
  workdir: { external: false },
  charterConfirmed: true,
  createdAt: nowIso(),
  updatedAt: nowIso(),
});
const A = project("p-1", "记账本");
const B = project("p-2", "家电档案");
const C = project("p-10", "相册库");

/**
 * 一个数据目录：项目区里 p-1、p-2、p-10（编号是 p-1 开头的别的项目），p-1、p-2 各有 spec.md；草稿区里一个联接到 p-1 的项目档案，
 * p-2 的工作目录里一个联接到 p-1 的工作目录
 */
function places() {
  const root = realPathOf(makeTempDir("ergou-outside-reads-"))!;
  const projectsDir = path.join(root, "projects");
  const scratch = path.join(root, "tmp", "scratch");
  const [a, b, c] = [A, B, C].map((p) => projectRecordsPaths(projectsDir, p.id));
  for (const records of [a!, b!, c!]) fs.mkdirSync(records.workdir, { recursive: true });
  fs.writeFileSync(path.join(a!.root, "spec.md"), "记账本规格");
  fs.writeFileSync(path.join(b!.root, "spec.md"), "家电档案规格");
  fs.mkdirSync(scratch, { recursive: true });
  fs.writeFileSync(path.join(scratch, "memo.txt"), "备忘");
  fs.symlinkSync(a!.root, path.join(scratch, "link"), "junction");
  fs.symlinkSync(a!.workdir, path.join(b!.workdir, "link-a"), "junction");
  const store = openEventStore({ file: path.join(root, "ergou.db"), views: [toolCallDetailsView, effectLogView] });
  return { root, projectsDir, scratch, a: a!, b: b!, c: c!, store };
}

const detail = (callId: string, over: Partial<ToolCallDetail> & Pick<ToolCallDetail, "tool" | "args">): ToolCallDetail => ({
  callId,
  agentId: "secretary",
  conversation: "secretary",
  outcome: "done",
  endedAt: "2026-10-10T10:00:00.000+08:00",
  result: "读到的内容",
  isError: false,
  ...over,
});

let seq = 0;
/** 一次调用：完整内容，执行成功的再记一条效果日志（参数是调用时守卫规范化过的） */
function record(store: EventStore, d: ToolCallDetail, effects: Array<Pick<EffectRecord, "tool" | "args">> = []): void {
  recordToolCallDetail(store, d);
  if (effects.length === 0) return;
  const records = effects.map((e): EffectRecord => ({ ...e, seq: ++seq, taskId: null, stageId: null, agentId: d.agentId, summary: "读文件；成功", at: Date.now(), callId: d.callId }));
  store.append({ channel: GUARD_CHANNEL, type: GUARD_EVENTS.effectRecorded, payload: { records } satisfies EffectRecordedPayload });
}
/** 秘书读一个文件（执行成功，效果日志里是同一个路径） */
const read = (store: EventStore, callId: string, file: string, over: Partial<ToolCallDetail> = {}) =>
  record(store, detail(callId, { tool: "read", args: { path: file }, ...over }), [{ tool: "read", args: { path: file } }]);

const readsOf = (store: EventStore, p: Project, records: ReturnType<typeof projectRecordsPaths>) =>
  outsideReadsOf(store, p, records).map((e) => (e.payload as ToolCallDetail).callId);

test("秘书会话里读这个项目里的：写死的绝对路径、经草稿区里的联接读到的（相对路径，按效果日志里调用时规范化过的）、读了文件再失败的 bash；读别的项目、项目外文件的不算", () => {
  const { scratch, a, b, c, store } = places();
  try {
    read(store, "abs", path.join(a.root, "spec.md"));
    record(store, detail("via-link", { tool: "read", args: { path: "link/charter.md" } }), [{ tool: "read", args: { path: path.join(scratch, "link", "charter.md") } }]);
    // 读了文件再以非零退出的 bash：没有效果日志，返回里也有读到的；命令里写死的路径照守卫的拆法认出来
    record(store, detail("bash-failed", { tool: "bash", args: { command: `cat "${path.join(a.workdir, "notes.md").replaceAll("\\", "/")}" && exit 3` }, outcome: "error", isError: true }));
    read(store, "other-project", path.join(b.root, "spec.md"));
    read(store, "p-10", path.join(c.root, "spec.md"));
    read(store, "scratch", path.join(scratch, "memo.txt"));
    record(store, detail("home", { tool: "read", args: { path: "~/notes.md" }, outcome: "blocked" }));
    read(store, "purged", path.join(a.root, "spec.md"), { purged: true });

    expect(readsOf(store, A, a)).toEqual(["abs", "via-link", "bash-failed"]);
    expect(readsOf(store, B, b)).toEqual(["other-project"]);
    expect(readsOf(store, C, c)).toEqual(["p-10"]);
  } finally {
    store.close();
  }
});

test("读了上级目录、递归扫到项目里的也算（任一方向的包含关系）：bash 的 grep -r 项目区、内置 grep / find 把项目区当路径、ls 数据目录", () => {
  const { root, projectsDir, a, b, c, store } = places();
  try {
    record(store, detail("grep-r", { tool: "bash", args: { command: `grep -r 对账 "${projectsDir.replaceAll("\\", "/")}"` } }), [{ tool: "read", args: { path: projectsDir } }]);
    record(store, detail("builtin-grep", { tool: "grep", args: { pattern: "对账", path: projectsDir } }), [{ tool: "grep", args: { pattern: "对账", path: projectsDir } }]);
    record(store, detail("builtin-find", { tool: "find", args: { pattern: "*.md", path: projectsDir }, outcome: "error", isError: true }));
    record(store, detail("ls-root", { tool: "ls", args: { path: root } }), [{ tool: "ls", args: { path: root } }]);
    // 项目区下面别的地方（不是这几个项目的上级）不算
    read(store, "sibling", path.join(projectsDir, "README.md"));

    for (const [p, records] of [[A, a], [B, b], [C, c]] as const) expect(readsOf(store, p, records)).toEqual(["grep-r", "builtin-grep", "builtin-find", "ls-root"]);
  } finally {
    store.close();
  }
});

test("带通配符的先展开：cat projects/*/spec.md 只算展开到的项目；展不开（没有匹配、**）的按通配符之前的那段目录", () => {
  const { projectsDir, scratch, a, b, c, store } = places();
  try {
    // 相对路径写的通配符：效果日志里是调用时按工作目录规范化过的（cd 到了数据目录）
    record(store, detail("glob", { tool: "bash", args: { command: "cd .. && cat projects/*/spec.md" } }), [{ tool: "read", args: { path: path.join(projectsDir, "*", "spec.md") } }]);
    read(store, "class", path.join(projectsDir, "p-[2]", "spec.md"));
    read(store, "no-match", path.join(a.root, "nothing-*.md"));
    read(store, "globstar", path.join(projectsDir, "**", "spec.md"));
    read(store, "outside", path.join(scratch, "*.txt"));

    expect(readsOf(store, A, a)).toEqual(["glob", "no-match", "globstar"]);
    expect(readsOf(store, B, b)).toEqual(["glob", "class", "globstar"]);
    // p-10 没有 spec.md：展开不到它
    expect(readsOf(store, C, c)).toEqual(["globstar"]);
  } finally {
    store.close();
  }
});

test("读项目档案的工具按返回开头的项目编号认：秘书的、跨项目任务自己的维护者的，过了保留期只剩摘要的也认得出；名字被新项目重用了不认错；这个项目自己的维护者会话里的不在这里找", () => {
  const { a, b, store } = places();
  try {
    const records = (callId: string, ref: string, result: string, over: Partial<ToolCallDetail> = {}) =>
      record(store, detail(callId, { tool: "read_project_records", args: { project: ref }, result, ...over }));
    records("by-name", " 记账本 ", "项目 p-1「记账本」（已归档）的项目档案（只读，目录 D:\\data\\projects\\p-1）：\n## 进展（progress.md）\n导出做完了");
    records("by-id", "P-1", "项目 p-1「记账本」（已归档）的项目档案：……");
    records("tm", "记账本", "项目 p-1「记账本」（使用中）的项目档案：……", { agentId: "tm-1", conversation: "maintainer:tm-1" });
    recordToolCallDetail(store, clearedDetail(detail("cleared", { tool: "read_project_records", args: { project: "p-1" }, result: "项目 p-1「记账本」（使用中）的项目档案：……" }), "expired", nowIso()));
    // 不算的：读的是别的项目、没读成、删掉的项目的名字被新项目 p-3 重用之后读的、这个项目自己的维护者会话里的
    records("other", "家电档案", "项目 p-2「家电档案」（使用中）的项目档案：……");
    records("not-found", "记账", "没有项目「记账」：现有的项目：……", { isError: true, outcome: "error" });
    records("reused-name", "记账本", "项目 p-3「记账本」（筹备中）的项目档案：……");
    records("own", "p-1", "项目 p-1「记账本」（使用中）的项目档案：……", { agentId: "pm-1", conversation: "maintainer:pm-1" });

    expect(readsOf(store, A, a)).toEqual(["by-name", "by-id", "tm", "cleared"]);
    expect(readsOf(store, B, b)).toEqual(["other"]);
  } finally {
    store.close();
  }
});

test("不在任何会话里的（评审子 agent 的）读这个项目的算，经别的项目工作目录里的联接读到的也算；别的会话里读文件的不在这里找", () => {
  const { a, b, store } = places();
  try {
    const review = (callId: string, file: string) => read(store, callId, file, { agentId: "review-t-1-s1-1", conversation: null, taskId: "t-1", stageId: "s1" });
    review("rv-a", path.join(a.workdir, "export.md"));
    review("rv-a-records", path.join(a.root, "progress.md"));
    review("rv-link", path.join(b.workdir, "link-a", "export.md"));
    review("rv-b", path.join(b.workdir, "import.md"));
    // 别的维护者会话里的文件读取（跨项目任务的维护者没有文件工具；别的项目的维护者读不到这里）
    read(store, "other-conversation", path.join(a.root, "spec.md"), { agentId: "pm-2", conversation: "maintainer:pm-2" });

    expect(readsOf(store, A, a)).toEqual(["rv-a", "rv-a-records", "rv-link"]);
    // 经联接读的那次，写的路径在 p-2 的工作目录里：删 p-2 时也算
    expect(readsOf(store, B, b)).toEqual(["rv-link", "rv-b"]);
  } finally {
    store.close();
  }
});

test("一次调用碰到的路径：完整参数里写死的绝对路径（通用 bash 按守卫的拆法拆开），加上效果日志里调用时规范化过的；~、$HOME 开头的（不知道调用时的主目录）只认效果日志里的", () => {
  const { scratch, a, store } = places();
  try {
    const notes = path.join(a.workdir, "notes.md");
    record(store, detail("bash", { tool: "bash", args: { command: `cd "${a.workdir.replaceAll("\\", "/")}" && cat notes.md ~/x.md "$HOME/y.md"` } }), [{ tool: "read", args: { path: path.join(scratch, "y.md") } }]);
    const [event] = store.read("tool_calls");
    // cd 进去的目录也算碰到了
    expect(pathsOfCall(store, event!).toSorted()).toEqual([a.workdir, notes, path.join(scratch, "y.md")].toSorted());
  } finally {
    store.close();
  }
});

test("通配符展开：* ? [...] 按现有的文件展开（不分大小写）；名字里本来就有 [ ] 的现有文件照原样；展不开的退回通配符之前的那段目录", () => {
  const { projectsDir, a, b, scratch, store } = places();
  store.close();
  fs.writeFileSync(path.join(scratch, "a[1].txt"), "名字里有方括号");
  // p-10 里没有 spec.md：和 bash 一样只展开成现有的
  expect(expandWildcards(path.join(projectsDir, "*", "spec.md")).toSorted()).toEqual([path.join(a.root, "spec.md"), path.join(b.root, "spec.md")].toSorted());
  expect(expandWildcards(path.join(projectsDir, "P-?", "spec.md")).toSorted()).toEqual([path.join(a.root, "spec.md"), path.join(b.root, "spec.md")].toSorted());
  expect(expandWildcards(path.join(projectsDir, "p-[!1]", "spec.md"))).toEqual([path.join(b.root, "spec.md")]);
  expect(expandWildcards(path.join(scratch, "a[1].txt"))).toEqual([path.join(scratch, "a[1].txt")]);
  expect(expandWildcards(path.join(projectsDir, "p-9*"))).toEqual([projectsDir]);
  expect(expandWildcards(path.join(projectsDir, "**", "x.md"))).toEqual([projectsDir]);
});
