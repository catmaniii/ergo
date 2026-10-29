// 新建时选工作文件夹（305 号票）在网页这一侧的状态层：哪个运行时能选、交给守护进程的选择、能不能交、"新开一个"下面那一行、
// 最近用过的文件夹（本机会话的工作目录去重）、建议立项卡上那一行。
import { describe, expect, it } from "vitest";
import {
  type AgentRuntimeView,
  EMPTY_FOLDER_DRAFT,
  folderChoiceLine,
  folderChoiceOf,
  folderDraftReady,
  folderNameShown,
  joinFolder,
  newFolderPreview,
  RUNTIME_OPERATIONS,
  type ResumableSessionView,
  type RuntimeCapabilities,
  recentFolders,
  workFolderRuntime,
} from "../../src/state/index.ts";

const caps = (yes: readonly string[]): RuntimeCapabilities => Object.fromEntries(RUNTIME_OPERATIONS.map((op) => [op, yes.includes(op)])) as RuntimeCapabilities;
const PI: AgentRuntimeView = { id: "pi", title: "pi", available: true, capabilities: caps([]), settings: [] };
const CLAUDE: AgentRuntimeView = { id: "claude-code", title: "Claude Code", plugin: "claude-code", available: true, capabilities: caps(["take_over"]), settings: [], workFolder: { defaultFolder: "D:\\work\\claude" } };
const session = (cwd: string, updatedAt: string): ResumableSessionView => ({ id: cwd + updatedAt, title: "x", cwd, updatedAt });

describe("新建时选工作文件夹（网页状态层，305 号票）", () => {
  it("能选工作文件夹的运行时：现在能用、清单里带 workFolder 的；pi、停用了的、没取到清单的不算", () => {
    expect(workFolderRuntime([PI, CLAUDE], "claude-code")).toBe(CLAUDE);
    expect(workFolderRuntime([PI, CLAUDE], "pi")).toBeUndefined();
    expect(workFolderRuntime([{ ...CLAUDE, available: false }], "claude-code")).toBeUndefined();
    expect(workFolderRuntime(undefined, "claude-code")).toBeUndefined();
  });

  it("交给守护进程的：新开的、没改名字的不带名字（按标题起）；改了的带上；已有的带路径；用已有的要填了路径才能交", () => {
    expect(folderChoiceOf(EMPTY_FOLDER_DRAFT)).toEqual({ kind: "new" });
    expect(folderChoiceOf({ ...EMPTY_FOLDER_DRAFT, name: " weekly " })).toEqual({ kind: "new", name: "weekly" });
    expect(folderChoiceOf({ mode: "existing", name: "x", path: " D:\\code\\ledger " })).toEqual({ kind: "existing", path: "D:\\code\\ledger" });
    expect(folderDraftReady(EMPTY_FOLDER_DRAFT)).toBe(true);
    expect(folderDraftReady({ ...EMPTY_FOLDER_DRAFT, mode: "existing" })).toBe(false);
    expect(folderDraftReady({ ...EMPTY_FOLDER_DRAFT, mode: "existing", path: "D:\\x" })).toBe(true);
  });

  it("新开的子文件夹名和下面那一行：按标题起（和守护进程同一个规矩），改了的照改的；没设默认文件夹的说照旧", () => {
    expect(folderNameShown(EMPTY_FOLDER_DRAFT, "整理下载/目录\n第二行")).toBe("整理下载-目录");
    expect(folderNameShown({ ...EMPTY_FOLDER_DRAFT, name: "a:b" }, "整理")).toBe("a-b");
    expect(joinFolder("D:\\work\\", "x")).toBe("D:\\work\\x");
    expect(newFolderPreview("D:\\work", "整理下载-目录")).toBe("会新开 D:\\work\\整理下载-目录（重名加序号）");
    expect(newFolderPreview("D:\\work", "")).toBe("会在 D:\\work 下按标题新开一个子文件夹");
    expect(newFolderPreview("D:\\work", "", "project")).toBe("会在 D:\\work 下按项目名新开一个子文件夹");
    expect(newFolderPreview(undefined, "x")).toBe("还没设默认文件夹：照旧用给任务开的工作目录");
  });

  it("最近用过的文件夹：本机会话的工作目录，最近活动的在前，不分大小写去重，最多 5 个", () => {
    const list = [
      session("D:\\a", "2026-10-25T08:00:00+08:00"),
      session("D:\\b", "2026-10-25T10:00:00+08:00"),
      session("d:\\B\\", "2026-10-25T09:00:00+08:00"),
      ...["c", "d", "e", "f"].map((n, i) => session(`D:\\${n}`, `2026-10-24T0${i}:00:00+08:00`)),
    ];
    expect(recentFolders(list)).toEqual(["D:\\b", "D:\\a", "D:\\f", "D:\\e", "D:\\d"]);
    expect(recentFolders([])).toEqual([]);
  });

  it("建议立项卡上那一行：已有的写路径；新开的写会建在哪（名字没起的按项目名）；没设默认文件夹的在项目档案里", () => {
    expect(folderChoiceLine({ kind: "existing", path: "D:\\code\\ledger" }, "D:\\work", "家电档案")).toBe("在哪个文件夹做：D:\\code\\ledger");
    expect(folderChoiceLine(undefined, "D:\\work", "家电/档案")).toBe("在哪个文件夹做：新开 D:\\work\\家电-档案");
    expect(folderChoiceLine({ kind: "new", name: "home" }, "D:\\work", "家电档案")).toBe("在哪个文件夹做：新开 D:\\work\\home");
    expect(folderChoiceLine(undefined, undefined, "家电档案")).toBe("在哪个文件夹做：项目档案里（还没设默认文件夹）");
  });
});
