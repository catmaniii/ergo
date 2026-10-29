// 运营层照插件的纪律写（280 号票，方案 C 第 4 点）：只起运营层（project-ops/layer.ts 的 createOpsLayer）加假的登记口和假的项目系统，
// 不起守护进程、不接 LSM。看三件事：
// - 装配时只经宿主现成的登记口登记（就是插件宿主给插件的 ctx 里那几样）：服务入口卡、运营手段"服务"；上线了的服务的 /apps 转发经转发登记口，
//   不再拿整张转发登记表；
// - 交出去的小接口：秘书的工具先后照原来、查看板那一节、维护者的 check_ops、网关订阅时补推的服务；
// - project_ops 自己声明参数要打码，聊天里的工具调用摘要按登记擦，结果和原来按名字认时一样。
// 走项目系统的组装函数的在 test/projects/system.test.ts（运营手段的整张先后），走组合根的整条路在主切面（test/main/project-ops.test.ts、
// operation-services.test.ts 等）。
import fs from "node:fs";
import path from "node:path";
import { CHANNELS, EVENT_TYPES, type OperationService, type Project } from "@ergo/protocol";
import { describe, expect, it, onTestFinished } from "vitest";
import type { AppRegistration } from "../../src/apps/registry.ts";
import { createCardService } from "../../src/cards/cards.ts";
import { CardTypeRegistry } from "../../src/cards/registry.ts";
import { cardsView } from "../../src/cards/views.ts";
import { createEphemeralBus, type EphemeralBus } from "../../src/events/ephemeral.ts";
import { openEventStore } from "../../src/events/event-store.ts";
import { BUILTIN_TOOL_REGISTRY, maskSecretArgValues, registerTools } from "../../src/guard/index.ts";
import { summarizeArgs } from "../../src/guard-runtime/describe.ts";
import { DISABLED_LSM_SERVICES } from "../../src/lsm/link.ts";
import { CHECK_OPS_TOOL, OPEN_SERVICE_TOOL, PROJECT_OPS_TOOL, SWITCH_SERVICES_TOOL } from "../../src/project-ops/api.ts";
import { createOpsLayer, OPS_LAYER_VIEWS, type OpsLayerContext } from "../../src/project-ops/layer.ts";
import { PROJECT_SERVICE_EVENTS, type ServiceDesiredPayload, type ServiceRolloutPayload } from "../../src/project-services/events.ts";
import { OPERATIONS_CHANNEL } from "../../src/projects/api.ts";
import { projectRecordsPaths } from "../../src/projects/records.ts";
import { clockIso } from "../../src/scheduler/clock.ts";
import { ManualClock } from "../helpers/clock.ts";
import { makeTempDir } from "../helpers/temp-dir.ts";

/** 不该被叫到的：叫到了就是测试面以外的路，直接红 */
const unexpected = (what: string) => () => {
  throw new Error(`${what} 不该被叫到`);
};

/** 记下每一次登记的登记口（插件宿主给插件的 ctx 里那几样），撤销也记下 */
function recordingContext() {
  const registered: string[] = [];
  const apps: AppRegistration[] = [];
  const undone: string[] = [];
  const recorded = (label: string) => {
    registered.push(label);
    return () => void undone.push(label);
  };
  const ctx: OpsLayerContext = {
    cardTypes: { register: (definition) => recorded(`卡片类型 ${definition.type}`) },
    operationMeans: { register: (means) => recorded(`运营手段 ${means.id}`) },
    apps: {
      register: (app) => {
        apps.push(app);
        return recorded(`转发 ${app.name}`);
      },
    },
  };
  return { ctx, registered, apps, undone };
}

/** 起运营层：临时目录里的真事件存储（运营层的视图）、卡片；项目系统那一边是一个使用中的项目 */
function opsLayer() {
  const dir = fs.realpathSync.native(makeTempDir("ergo-ops-layer-"));
  const projectsDir = path.join(dir, "projects");
  const clock = new ManualClock(new Date("2026-10-25T09:00:00+08:00"));
  const now = () => clockIso(clock);
  const logs: string[] = [];
  const store = openEventStore({ file: path.join(dir, "ergo.db"), views: [cardsView, ...OPS_LAYER_VIEWS], now, log: (line) => logs.push(line) });
  onTestFinished(() => store.close());
  const cards = createCardService({ store, registry: new CardTypeRegistry(), now });
  const project = { id: "p-1", name: "记账本", state: "in_use", maintainerId: "pm-1" } as Project;
  const records = projectRecordsPaths(projectsDir, project.id);
  const workdir = path.join(records.root, "workdir");
  fs.mkdirSync(workdir, { recursive: true });
  const published: Parameters<EphemeralBus["publish"]>[0][] = [];
  const bus = createEphemeralBus();
  const recording = recordingContext();
  const ops = createOpsLayer(recording.ctx, {
    store,
    cards,
    projects: { get: (projectId) => (projectId === project.id ? project : undefined), list: () => [project], records: () => records, workdir: () => workdir },
    pendingPlan: () => undefined,
    scheduledJobs: unexpected("触发底座"),
    tellMaintainer: unexpected("跟维护者说一句"),
    delegate: unexpected("转给维护者当工单"),
    isTemplate: () => false,
    notifyMaintainer: unexpected("通知维护者"),
    onChecked: () => {},
    notifications: {
      publish: (frame) => {
        published.push(frame);
        bus.publish(frame);
      },
    },
    secretsDir: path.join(dir, "secrets"),
    thumbnailsDir: path.join(dir, "cache", "thumbnails"),
    serviceThumbnail: unexpected("截服务首页"),
    browser: unexpected("浏览器"),
    ports: { local: 18810, external: 18811 },
    newJob: () => undefined,
    clock,
    now,
    log: (line) => logs.push(line),
  });
  onTestFinished(() => ops.stop());
  return { ops, store, project, workdir, published, logs, ...recording };
}

describe("运营层照插件的纪律写（280）", () => {
  it("装配时只经宿主现成的登记口登记：服务入口卡、运营手段“服务”；上线了的服务开始时经转发登记口登记 /apps（不拿整张转发登记表）", () => {
    const { ops, store, project, workdir, registered, apps, logs } = opsLayer();
    expect(registered).toEqual(["卡片类型 service_entry", "运营手段 service"]);

    // 一个上线了的、有网页的服务（确认运营方案时记的要求，加上 LSM 上线成功的结果）
    const service: OperationService = { name: "web", app: "p-1-web", command: "node server.mjs", cwd: workdir, env: [], port: 18080, autostart: true, autoRestart: false, web: { home: "/", prefix: "strip" } };
    const desired = store.append({
      channel: OPERATIONS_CHANNEL,
      type: PROJECT_SERVICE_EVENTS.desired,
      payload: { projectId: project.id, key: "web", title: "网页", app: service.app, present: true, service, why: "confirmed", time: "2026-10-25T08:00:00.000+08:00" } satisfies ServiceDesiredPayload,
    });
    store.append({
      channel: OPERATIONS_CHANNEL,
      type: PROJECT_SERVICE_EVENTS.rollout,
      payload: { projectId: project.id, key: "web", app: service.app, desiredSeq: desired.event.globalSeq, state: "live", registered: true, powerSeq: 0, time: "2026-10-25T08:00:05.000+08:00" } satisfies ServiceRolloutPayload,
    });
    expect(apps).toEqual([]);

    // 接入 LSM 之后开始（这里是没接入的接入层）：上线了的先经转发登记口登记，不等 LSM
    ops.start({ lsm: DISABLED_LSM_SERVICES, ports: { local: 18810, external: 18811 } });
    expect(apps).toEqual([{ name: "p-1-web", target: "http://127.0.0.1:18080", title: "网页", prefix: "strip" }]);
    expect(registered).toEqual(["卡片类型 service_entry", "运营手段 service", "转发 p-1-web"]);
    // 订阅项目列表频道时补推的：同一个服务
    expect(ops.servicesFrame()).toMatchObject({ channel: CHANNELS.projects, type: EVENT_TYPES.projectServices, payload: { services: [{ projectId: "p-1", app: "p-1-web", rollout: "live" }] } });
    expect(ops.secretary.boardSection()).toContain("网页");
    expect(logs.filter((line) => line.includes("出错"))).toEqual([]);
  });

  it("交出去的小接口：秘书的工具先后照原来；project_ops 自己声明参数要打码，聊天里的摘要按登记擦、和原来按名字认时一样；维护者的 check_ops", () => {
    const { ops } = opsLayer();
    const tools = ops.secretary.tools();
    expect(tools.map((tool) => tool.spec.name)).toEqual([OPEN_SERVICE_TOOL, SWITCH_SERVICES_TOOL, PROJECT_OPS_TOOL]);
    expect(tools.filter((tool) => tool.descriptor.maskArgs === true).map((tool) => tool.spec.name)).toEqual([PROJECT_OPS_TOOL]);
    // 守卫运行时拿这个会话的工具注册表写给人看的参数摘要：project_ops 的 args 里像密钥的擦掉，别的照原样列
    const registry = registerTools(BUILTIN_TOOL_REGISTRY, ...tools.map((tool) => tool.descriptor));
    const args = { action: "call", project: "记账本", op: "sync", args: { account: "家用", api_key: "abc-123-xyz" }, why: "用户要同步" };
    const summary = summarizeArgs(registry, PROJECT_OPS_TOOL, args);
    expect(summary).not.toContain("abc-123-xyz");
    expect(summary).toContain("家用");
    expect(summary).toBe(summarizeArgs(BUILTIN_TOOL_REGISTRY, PROJECT_OPS_TOOL, maskSecretArgValues(args)));
    // 没有服务时查看板不多那一节；维护者的 check_ops 绑在它的项目上
    expect(ops.secretary.boardSection()).toBeUndefined();
    expect(ops.checkTool({ projectId: "p-1", maintainerId: "pm-1" }).spec.name).toBe(CHECK_OPS_TOOL);
    expect(ops.servicesFrame()).toMatchObject({ payload: { services: [] } });
  });
});
