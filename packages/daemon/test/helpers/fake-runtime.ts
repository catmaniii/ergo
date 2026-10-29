// 测试用的假运行时插件（286 号票，只在测试里）：照"运行时"贡献点在数据契约里登记一个运行时 fake，子进程入口是
// fixtures/fake-runtime-child.ts（不跑模型，只说宿主协议）。主切面经 startTestDaemon 的 extraPlugins 接在插件清单后面，
// 和真插件走同一条装配路径；停用、启用经设置 · 插件（或配置 plugins.disabled）。
import { fileURLToPath } from "node:url";
import type { PluginDefinition } from "../../src/plugins/host.ts";
import type { AgentRuntime } from "../../src/runtime/index.ts";

/** 假运行时的 id（任务、项目的运行时属性里写它） */
export const FAKE_RUNTIME_ID = "fake";
/** 登记它的插件的名字（配置 plugins.disabled、设置 · 插件里用） */
export const FAKE_RUNTIME_PLUGIN = "fake-runtime";
/** 插件给人看的名字（"假运行时插件没启用"） */
export const FAKE_RUNTIME_TITLE = "假运行时";
/** 假运行时的子进程入口 */
export const FAKE_RUNTIME_ENTRY = fileURLToPath(new URL("../fixtures/fake-runtime-child.ts", import.meta.url));
/** 假运行时每次回复的开头（测试据此认出维护者是经它拉起的） */
export const FAKE_REPLY = "假运行时收到了";

/** 假运行时：能插话、能接管（列一个假的会话），别的都不能；可选模型、设置项各一个 */
export const fakeRuntime: AgentRuntime = {
  id: FAKE_RUNTIME_ID,
  title: "假运行时",
  entry: FAKE_RUNTIME_ENTRY,
  capabilities: {
    interject: true,
    compact: false,
    rollback: false,
    branch_switch: false,
    branch_summary: false,
    rewind_files: false,
    model_handoff: false,
    thinking_levels: false,
    slash_passthrough: true,
    take_over: true,
    purge_rewrite: false,
    yield: false,
    live_toolkit: false,
    scope_review: false,
    remote_control: false,
  },
  models: () => [{ id: "fake-1", title: "假模型一号" }],
  settings: () => [{ id: "mode", title: "模式", options: [{ value: "calm", title: "稳" }, { value: "fast", title: "快" }], default: "calm" }],
  sessions: () => Promise.resolve([{ id: "s-1", title: "以前的会话", cwd: "D:/work/demo", updatedAt: "2026-10-25T09:00:00+08:00" }]),
  // 290 号票：能接管的运行时四样都要给（假的：都空闲、分叉出 s-1-fork、没有前情）
  sessionBusy: () => Promise.resolve(undefined),
  forkSession: (sessionId) => Promise.resolve(`${sessionId}-fork`),
  sessionHistory: () => Promise.resolve({ items: [], truncated: false }),
};

/** 假运行时插件：只在数据契约里登记运行时，装配时什么都不做 */
export const fakeRuntimePlugin: PluginDefinition = {
  name: FAKE_RUNTIME_PLUGIN,
  title: FAKE_RUNTIME_TITLE,
  contracts(ctx) {
    ctx.runtimes.register(fakeRuntime);
  },
  setup() {},
};
