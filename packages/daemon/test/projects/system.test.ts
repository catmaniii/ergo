// 项目系统只起它自己加假内核（278 号票，方案 C："接口就是测试面"，docs/research/29-plugin-expansion-review.html）：不起守护进程、不拉 agent 子进程。
// 内核那一边是临时目录里的真事件存储、卡片、待我处理、任务模块（它们便宜），建在项目系统之后的（执行控制器、agent 宿主、执行名额、任务的维护者、
// 子 agent、工具包、MCP 登记变更、触发底座）换成假的；只经 createProjectSystem 交出来的小接口和生命周期操作、观察。
// 走组合根的整条路照旧在主切面（test/main/projects.test.ts 等）测。
import fs from "node:fs";
import path from "node:path";
import { CHANNELS, EVENT_TYPES, MAINTAINER_CHANNEL_PREFIX, maintainerChannel } from "@ergo/protocol";
import { describe, expect, it, onTestFinished } from "vitest";
import type { AgentHost } from "../../src/agent-host/host.ts";
import { createAppRegistry } from "../../src/apps/registry.ts";
import { createCardService } from "../../src/cards/cards.ts";
import { CardTypeRegistry } from "../../src/cards/registry.ts";
import { cardsView } from "../../src/cards/views.ts";
import { dataDirLayout } from "../../src/config/data-dir.ts";
import type { AgentSession } from "../../src/conversation/agent-session.ts";
import { conversationWhere } from "../../src/conversation/user-words.ts";
import { conversationViews } from "../../src/conversation/views.ts";
import { DeletionParticipants, PROJECT_DELETION } from "../../src/deletion/participants.ts";
import { createEphemeralBus } from "../../src/events/ephemeral.ts";
import { openEventStore } from "../../src/events/event-store.ts";
import { BUILTIN_TOOL_REGISTRY } from "../../src/guard/index.ts";
import { createInboxService } from "../../src/inbox/inbox.ts";
import { inboxView } from "../../src/inbox/views.ts";
import { PurgeRewriters } from "../../src/memory/rewriters.ts";
import { OPEN_SERVICE_TOOL, PROJECT_OPS_TOOL, PROPOSE_GO_LIVE_TOOL, READ_PROJECT_RECORDS_TOOL, SWITCH_SERVICES_TOOL } from "../../src/projects/api.ts";
import { createProjectDirectory, createProjectSystem, PROJECT_SYSTEM_VIEWS, type ProjectSystem, type ProjectSystemKernel } from "../../src/projects/system.ts";
import { clockIso } from "../../src/scheduler/clock.ts";
import type { CompletedTask } from "../../src/tasks/execution.ts";
import { createTaskService } from "../../src/tasks/tasks.ts";
import { tasksView } from "../../src/tasks/views.ts";
import { ManualClock } from "../helpers/clock.ts";
import { makeTempDir } from "../helpers/temp-dir.ts";

/** 不该被叫到的假内核方法：叫到了就是测试面以外的路，直接红 */
const unexpected = (what: string) => () => {
  throw new Error(`假内核的 ${what} 不该被叫到`);
};

/** 起项目系统和假内核（用例结束时倒着收尾、关库） */
function projectSystemWithFakeKernel() {
  const dir = fs.realpathSync.native(makeTempDir("ergo-project-system-"));
  const layout = dataDirLayout(dir);
  for (const d of [layout.db, layout.projects, layout.secrets, layout.config]) fs.mkdirSync(d, { recursive: true });
  const clock = new ManualClock(new Date("2026-10-25T09:00:00+08:00"));
  const now = () => clockIso(clock);
  const logs: string[] = [];
  const log = (line: string) => logs.push(line);

  // 内核那一边的真实现（便宜的几样）：事件存储连同项目系统的视图、卡片、待我处理、任务模块
  const store = openEventStore({ file: path.join(layout.db, "ergo.db"), views: [...conversationViews, cardsView, inboxView, tasksView, ...PROJECT_SYSTEM_VIEWS], now, log });
  const cardTypes = new CardTypeRegistry();
  const cards = createCardService({ store, registry: cardTypes, now });
  const notifications = createEphemeralBus();
  const inbox = createInboxService({ store, notifications, now, log });
  const rewriters = new PurgeRewriters();
  const deletion = new DeletionParticipants({ store, cards, rewriters });
  const sources: string[] = [];
  // 任务模块建在项目系统之前：项目列表的只读视图先建一份，派单器现取（和组合根一样）
  const directory = createProjectDirectory({ store, projectsDir: layout.projects });
  let system: ProjectSystem | undefined;
  const tasks = createTaskService({ store, cards, inbox, now, watchSettings: () => ({}), planTools: BUILTIN_TOOL_REGISTRY, projects: () => directory, workOrders: () => system!.taskWorkOrders });

  system = createProjectSystem({
    store,
    cards,
    inbox,
    tasks,
    cardTypes,
    rewriters,
    materialSources: {
      register: (source) => {
        sources.push(source.eventType);
        return () => {};
      },
    },
    deletion,
    userWords: { store, whereOf: conversationWhere({ projectOf: (maintainerId) => directory.maintainedBy(maintainerId), taskOf: (maintainerId) => tasks.ofMaintainer(maintainerId) }) },
    notifications,
    apps: createAppRegistry(),
    places: { dataDir: { root: dir, config: layout.config, secrets: layout.secrets, db: layout.db, projects: layout.projects }, programDir: path.join(dir, "program"), homeDir: dir, ownPorts: [] },
    watchSettings: () => ({}),
    conversationApprovals: "off",
    nudges: 2,
    clock,
    now,
    layout,
    realDirs: { projects: layout.projects, data: dir, secrets: layout.secrets, program: path.join(dir, "program") },
    ports: { local: 18810, external: 18811 },
    serviceThumbnail: unexpected("截服务首页"),
    browser: unexpected("浏览器"),
    relay: {
      scopeOf: (conversation, taskId) => system!.conversationScope(conversation, taskId),
      preludeOf: (conversation, key, taskId) => (conversation.startsWith(MAINTAINER_CHANNEL_PREFIX) ? system!.messagePrelude(conversation.slice(MAINTAINER_CHANNEL_PREFIX.length), key, taskId) : []),
    },
    newJob: () => undefined,
    scheduledJobs: unexpected("触发底座"),
    checkEventTrigger: () => [],
    log,
  });

  // 建在项目系统之后的内核模块：假的，记下项目系统叫了它们什么
  const calls = { kicks: 0, completedListeners: [] as Array<(completed: CompletedTask) => void>, attached: 0, sessions: [] as string[], pokes: 0 };
  const session = {
    start: () => {},
    stop: () => Promise.resolve(),
    poke: () => {
      calls.pokes += 1;
    },
    refresh: () => {},
  } as unknown as AgentSession;
  const agentHost = {
    store,
    tasks,
    prompts: { onAgentChange: () => () => {} },
    attach: () => {
      calls.attached += 1;
    },
    assemblyOf: () => undefined,
    session: (config: { agentId: string }) => {
      calls.sessions.push(config.agentId);
      return session;
    },
  } as unknown as AgentHost;
  const kernel: ProjectSystemKernel = {
    execution: {
      kick: () => {
        calls.kicks += 1;
      },
      awaitAnswer: unexpected("执行控制器的 awaitAnswer"),
      answered: unexpected("执行控制器的 answered"),
      countReturn: unexpected("执行控制器的 countReturn"),
      guardTask: () => null,
      onCompleted: (fn) => {
        calls.completedListeners.push(fn);
        return () => {};
      },
    },
    agentHost,
    slots: { hasSlot: () => true, onFreed: () => {} },
    taskMaintainers: { release: () => Promise.resolve() },
    subAgents: { reassemble: () => [] },
    toolkits: { skillTool: unexpected("工具包的 skillTool"), requestTool: unexpected("工具包的 requestTool") },
    mcpChanges: { requestTool: unexpected("MCP 登记变更的 requestTool") },
  };

  const stops: Array<() => void | Promise<void>> = [];
  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    for (const stop of stops.splice(0).toReversed()) await stop();
    system!.stopServices();
    store.close();
  };
  onTestFinished(close);
  return { system, kernel, stops, store, cards, cardTypes, rewriters, deletion, sources, directory, calls, logs, close };
}

describe("项目系统只起它自己加假内核（278）", () => {
  it("建出来就登记好卡片类型、改写函数、素材来源、删除参与方；接上、开始之后经小接口立项、找项目、开对话段、重置维护者，秘书的工具先后照旧", async () => {
    const { system, kernel, stops, cards, cardTypes, rewriters, deletion, sources, directory, calls, logs, close } = projectSystemWithFakeKernel();
    // 第一步建出来：项目系统自己的卡片类型、改写函数、素材来源都登记进了内核给的登记表（组合根不再一样样登记）
    const types = ["suggest_project", "charter", "charter_change", "standard_change", "standard_backfill", "build_done", "go_live", "service_entry", "operations_change", "work_order"];
    expect(types.filter((type) => cardTypes.get(type) === undefined)).toEqual([]);
    // 运营手段（280）：内核的定时、事件触发，运营层经登记口自己登记的服务，公网入口——交运营方案的工具说明里列的先后照原来
    expect(system.handles.operationMeans.list().map((m) => m.id)).toEqual(["schedule", "event", "service", "public_entry"]);
    expect(() => rewriters.register({ eventType: EVENT_TYPES.workOrder, rewrite: () => null })).toThrow("已经登记过了");
    expect(sources).toEqual(expect.arrayContaining([EVENT_TYPES.charterDecided, EVENT_TYPES.workOrderDecided]));
    expect(sources).toHaveLength(5);
    // 删除参与方（279）：项目自己的、项目之外读过它的调用、工单、运营方案（内核的由组合根在这之后登记）
    expect(deletion.owners(PROJECT_DELETION)).toEqual(["projects", "projects:outside-reads", "work-orders", "operations"]);

    // 第二步、第三步：接上建在它之后的内核模块（派单器开始、任务完成回调登记上），开始（建出项目的维护者，登记进 agent 宿主）
    system.connect(kernel, stops);
    expect(calls.completedListeners).toHaveLength(1);
    system.start(stops);
    expect(calls.attached).toBe(1);

    // 经秘书的小接口立项：建议立项工具出卡，用户在卡上点"立项"
    const suggested = await system.secretary.suggestTool().run({ name: "记账本", goal: "记每天的花销" }, { toolCallId: "c-1" });
    const cardId = suggested.cardIds![0]!;
    await cards.act({ cardId, action: "kickoff", expectedVersion: cards.get(cardId)!.version, idempotencyKey: "kickoff-1" });

    // 找项目：工具包的小接口、内核的只读视图、任务模块的核对都认得它
    const project = system.toolkitProjects.get("p-1")!;
    expect(project).toMatchObject({ name: "记账本", state: "preparing", maintainerId: "pm-1" });
    expect(directory.checkTaskProjects(["记账本"])).toEqual(["p-1"]);
    expect(directory.maintainedBy("pm-1")?.id).toBe("p-1");
    // 维护者会话里的那条说明唤起了项目的维护者（假的 agent 宿主记下了拉起的是谁）
    expect(calls.sessions).toContain("pm-1");

    // 用户往维护者的会话里说话：消息属于这个项目；手上没有在进行的段，先开一个对话段
    expect(system.conversationScope(maintainerChannel("pm-1"))).toEqual({ projectId: "p-1" });
    expect(system.messagePrelude("pm-1", "say-1").length).toBeGreaterThan(0);

    // 网关的请求：重置维护者（项目 → 派单器，组装函数里的现取）
    const pokesBefore = calls.pokes;
    const reset = system.requests.resetMaintainer({ projectId: "p-1" }, "reset-1");
    expect(reset).toMatchObject({ projectId: "p-1", segmentId: expect.any(String) });
    expect(calls.pokes).toBeGreaterThan(pokesBefore);

    // 秘书的工具先后（277 号票定的，主切面逐个比对的也是它）
    expect(system.secretary.tools().map((tool) => tool.spec.name)).toEqual([READ_PROJECT_RECORDS_TOOL, OPEN_SERVICE_TOOL, SWITCH_SERVICES_TOOL, PROJECT_OPS_TOOL, PROPOSE_GO_LIVE_TOOL]);
    // 订阅项目列表频道时补推的项目的服务：还没有服务
    expect(system.servicesFrame()).toMatchObject({ channel: CHANNELS.projects, type: EVENT_TYPES.projectServices, payload: { services: [] } });
    // 收尾：各步排上的倒着停，一路没有出错的日志
    await close();
    expect(logs.filter((line) => line.includes("出错"))).toEqual([]);
  });

  it("交出去的小接口建好就能用；建在它之后的内核模块没接上就用到的，报还没接上（MCP 登记变了的通知没接上时什么都不做）", () => {
    const { system, stops } = projectSystemWithFakeKernel();
    // 没 connect 就 start：项目的维护者要 agent 宿主
    expect(() => system.start(stops)).toThrow("agentHost 还没接上");
    expect(stops).toEqual([]);
    // 项目的维护者在 start 里才建出
    expect(() => system.skillsOf("pm-1")).toThrow("projectMaintainers 还没接上");
    expect(() => system.reassemble("pm-1", "MCP 登记变了")).not.toThrow();
    // 只读的、派单器的小接口建出来就是现成的对象（执行控制器、触发底座、任务的维护者拿到的不是现取的函数）
    expect(system.projectTasks.of({ id: "t-1", maintainerId: "tm-1" } as never)).toBeUndefined();
    expect(typeof system.multiProjectTasks.stageGate).toBe("function");
    expect(typeof system.jobWorkOrders.dispatchRun).toBe("function");
    expect(typeof system.multiProjectMaintainer.tools).toBe("function");
  });
});
