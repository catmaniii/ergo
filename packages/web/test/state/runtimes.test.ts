// 维护者的运行时在网页这一侧（289 号票）的状态层：会话的维护者用哪个运行时（项目的照项目、没写照转来的任务，任务的照任务，秘书是 pi）、
// 能力清单（清单还没取到、不认得的当都支持）、新建时能选的（只有 pi 时不显示）、卡上的签（pi 不标）、⚙ 里换运行时的选项和那一行说明。
import { describe, expect, it } from "vitest";
import {
  type AgentRuntimeStateView,
  type AgentRuntimeView,
  conversationRuntime,
  type Project,
  projectRuntime,
  RUNTIME_OPERATIONS,
  type RuntimeCapabilities,
  runtimeBlockShown,
  runtimeChipText,
  runtimeChoices,
  runtimeOptionsFor,
  runtimeSettingValue,
  runtimeStateLine,
  runtimeSupports,
  branchFilesLine,
  rollbackRuntimeNotes,
  type Task,
} from "../../src/state/index.ts";

const caps = (yes: readonly string[]): RuntimeCapabilities => Object.fromEntries(RUNTIME_OPERATIONS.map((op) => [op, yes.includes(op)])) as RuntimeCapabilities;
const PI: AgentRuntimeView = { id: "pi", title: "pi", available: true, capabilities: caps(["rollback", "branch_switch", "branch_summary", "compact"]), settings: [] };
const CLAUDE: AgentRuntimeView = {
  id: "claude-code",
  title: "Claude Code",
  plugin: "claude-code",
  available: true,
  capabilities: caps(["compact", "slash_passthrough"]),
  models: [{ id: "opus", title: "Opus" }],
  settings: [{ id: "effort", title: "思考档位", options: [{ value: "inherit", title: "跟 Claude Code 自己的设置" }, { value: "high", title: "高" }], default: "inherit" }],
};
const OFF: AgentRuntimeView = { ...CLAUDE, id: "codex", title: "Codex", available: false, unavailable: "Codex插件没启用" };

const task = (id: string, runtime?: string): Task => ({ id, maintainerId: `tm-${id}`, ...(runtime ? { runtime } : {}) }) as Task;
const project = (id: string, extra: Partial<Project> = {}): Project => ({ id, maintainerId: `pm-${id}`, ...extra }) as Project;

describe("维护者的运行时（网页状态层）", () => {
  it("会话的维护者用哪个运行时：项目的照项目、没写照转来的任务；任务的照任务；秘书和不认得的是 pi", () => {
    const state = {
      tasks: { t1: task("t1", "claude-code"), t2: task("t2") },
      projects: { p1: project("p1", { runtime: "codex" }), p2: project("p2", { fromTaskId: "t1" }), p3: project("p3") },
    };
    expect(conversationRuntime(state, "maintainer:tm-t1")).toBe("claude-code");
    expect(conversationRuntime(state, "maintainer:tm-t2")).toBe("pi");
    expect(conversationRuntime(state, "maintainer:pm-p1")).toBe("codex");
    expect(conversationRuntime(state, "maintainer:pm-p2")).toBe("claude-code");
    expect(conversationRuntime(state, "maintainer:pm-p3")).toBe("pi");
    expect(conversationRuntime(state, "secretary")).toBe("pi");
    expect(projectRuntime(project("p4", { runtime: "claude-code", fromTaskId: "t2" }), state.tasks)).toBe("claude-code");
  });

  it("撤回的确认框按运行时多说的（293 号票）：分支摘要不是它自己写的、撤回时恢复文件（阶段、步骤开始前不恢复）；pi 什么都不多说", () => {
    const withRollback: AgentRuntimeView = { ...CLAUDE, capabilities: caps(["rollback", "branch_switch", "rewind_files", "compact"]) };
    expect(rollbackRuntimeNotes([PI, withRollback], "pi", false)).toEqual({ lines: [], restoresFiles: false, runtimeTitle: "pi" });
    expect(rollbackRuntimeNotes([PI, withRollback], "claude-code", false)).toEqual({
      lines: ["Claude Code 从这条之前另起一个会话接着，分支摘要由二狗按自己记下的写。", "Claude Code 用 Write、Edit 改过的文件会恢复到这条之前；Bash 改的文件追不到。"],
      restoresFiles: true,
      runtimeTitle: "Claude Code",
    });
    expect(rollbackRuntimeNotes([PI, withRollback], "claude-code", true)).toMatchObject({
      lines: ["Claude Code 从这条之前另起一个会话接着，分支摘要由二狗按自己记下的写。", "撤回到阶段、步骤开始前不恢复文件：Claude Code 的文件检查点只按整条输入记。"],
      restoresFiles: false,
    });
  });

  it("分支摘要上恢复文件的那一句（293 号票）：只写文件名、超过三个写一共几个，没有要恢复的、阶段开始前没恢复、出错了各有说法", () => {
    expect(branchFilesLine({ restored: ["D:\\code\\flaky-ci\\.github\\workflows\\ci.yml", "test/helpers/retry.ts"] })).toBe("文件恢复到了撤回点：ci.yml、retry.ts（Bash 改的追不到）");
    expect(branchFilesLine({ restored: ["a.md", "b.md", "c.md", "d.md"] })).toBe("文件恢复到了撤回点：a.md、b.md、c.md 等 4 个（Bash 改的追不到）");
    expect(branchFilesLine({ restored: [] })).toBe("没有要恢复的文件（只追 Write、Edit 改的，Bash 改的追不到）");
    expect(branchFilesLine({ restored: [], skipped: "call_point" })).toBe("文件没恢复：撤回到阶段、步骤开始前时只能按整条输入恢复");
    expect(branchFilesLine({ restored: [], error: "No file checkpoint" })).toBe("文件没恢复成：No file checkpoint");
    expect(branchFilesLine({ restored: ["a.md"], error: "坏了" })).toBe("恢复了 a.md，没恢复完：坏了");
  });

  it("能力清单：照运行时的；清单还没取到、不认得的运行时当都支持（界面照旧）", () => {
    expect(runtimeSupports([PI, CLAUDE], "claude-code", "rollback")).toBe(false);
    expect(runtimeSupports([PI, CLAUDE], "claude-code", "compact")).toBe(true);
    expect(runtimeSupports([PI, CLAUDE], undefined, "rollback")).toBe(true);
    expect(runtimeSupports(undefined, "claude-code", "rollback")).toBe(true);
    expect(runtimeSupports([PI], "codex", "rollback")).toBe(true);
  });

  it("新建时能选的：现在能用的；只有 pi 时是空的（不显示）。卡上的签：插件登记的写名字，pi 不标", () => {
    expect(runtimeChoices([PI, CLAUDE, OFF])).toEqual([
      { id: "pi", title: "pi" },
      { id: "claude-code", title: "Claude Code" },
    ]);
    expect(runtimeChoices([PI, OFF])).toEqual([]);
    expect(runtimeChoices(undefined)).toEqual([]);
    expect(runtimeChipText([PI, CLAUDE], "claude-code")).toBe("Claude Code");
    expect(runtimeChipText([PI, CLAUDE], "pi")).toBeUndefined();
    expect(runtimeChipText([PI, CLAUDE], undefined)).toBeUndefined();
    expect(runtimeChipText(undefined, "claude-code")).toBe("claude-code");
  });

  it("⚙：换运行时的选项是能用的加上现在用的（停用了也列着）；那一行写在换到哪了、现在用的不能用；设置项没选是默认", () => {
    const state: AgentRuntimeStateView = { id: "codex", title: "Codex", settings: {}, unavailable: "Codex插件没启用" };
    expect(runtimeOptionsFor([PI, CLAUDE, OFF], state)).toEqual([
      { id: "pi", title: "pi", disabled: false },
      { id: "claude-code", title: "Claude Code", disabled: false },
      { id: "codex", title: "Codex", disabled: false },
    ]);
    expect(runtimeStateLine(state)).toBe("Codex插件没启用");
    const waiting: AgentRuntimeStateView = { id: "pi", title: "pi", settings: {}, switching: { to: "claude-code", title: "Claude Code", state: "waiting" } };
    expect(runtimeStateLine(waiting)).toBe("正在换成 Claude Code：等手头这一条做完");
    expect(runtimeStateLine({ ...waiting, switching: { ...waiting.switching!, state: "handoff" } })).toBe("正在换成 Claude Code：pi 在写交接摘要");
    expect(runtimeStateLine({ id: "pi", title: "pi", settings: {} })).toBeUndefined();
    expect(runtimeSettingValue(CLAUDE.settings[0]!, { id: "claude-code", title: "Claude Code", settings: {} })).toBe("inherit");
    expect(runtimeSettingValue(CLAUDE.settings[0]!, { id: "claude-code", title: "Claude Code", settings: { effort: "high" } })).toBe("high");
  });

  it("⚙ 里的运行时一块：只有 pi 能用、用的也是 pi 时不显示（和以前一样）；用别的、在换、有别的能用时显示；秘书没有", () => {
    const pi: AgentRuntimeStateView = { id: "pi", title: "pi", settings: {} };
    expect(runtimeBlockShown([PI, OFF], pi)).toBe(false);
    expect(runtimeBlockShown(undefined, pi)).toBe(false);
    expect(runtimeBlockShown([PI, CLAUDE], pi)).toBe(true);
    expect(runtimeBlockShown([PI, OFF], { id: "codex", title: "Codex", settings: {}, unavailable: "Codex插件没启用" })).toBe(true);
    expect(runtimeBlockShown([PI], { ...pi, switching: { to: "claude-code", title: "Claude Code", state: "waiting" } })).toBe(true);
    expect(runtimeBlockShown([PI, CLAUDE], undefined)).toBe(false);
  });
});
