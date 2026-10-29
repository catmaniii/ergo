// 项目的服务（133 号票）的状态层：项目列表频道上的临时事件 project_services 整份换掉；项目卡、项目页的入口（撤下了的不算）；
// 入口点了能不能打开、打不开提示什么；运营方案那一节里服务那一条的状态照项目的服务现算；改了的服务改了哪几处。
import { describe, expect, test } from "vitest";
import {
  EVENT_TYPES,
  type OperationItem,
  type OperationService,
  operationChangedFields,
  type Project,
  type ProjectEventPayload,
  projectOperationRows,
  projectServicesOf,
  type ProjectServiceView,
  replay,
  serviceByApp,
  serviceEntryClick,
  serviceEntryView,
  serviceOfItem,
  serviceSpecRows,
} from "../../src/state/index.ts";
import { frame } from "./events.ts";

const T = "2026-10-08T09:00:00.000+08:00";

const view = (key: string, extra: Partial<ProjectServiceView> = {}): ProjectServiceView => ({
  projectId: "p-1",
  key,
  title: key === "web" ? "简报站" : key,
  name: key,
  app: `p-1-${key}`,
  port: 18080,
  autostart: true,
  url: `/apps/p-1-${key}/`,
  rollout: "live",
  status: "online",
  ...extra,
});

const service: OperationService = { name: "web", app: "p-1-web", command: "node server.mjs", cwd: "D:/work/p-1/site", env: [{ name: "KEY", secret: "k.txt" }, { name: "MODE", value: "prod" }], port: 18080, health: { path: "/health" }, autostart: true, autoRestart: false, web: { home: "/", prefix: "strip" } };

const serviceItem = (key: string, extra: Partial<OperationItem> = {}): OperationItem => ({
  key,
  name: key,
  means: "service",
  meansLabel: "项目自己的服务（登记到 LSM）",
  automatic: true,
  triggerText: `上线服务「${key}」（端口 18080，开机自启）`,
  approach: "plain",
  instructions: "网页",
  capabilities: {},
  service: { ...service, name: key, app: `p-1-${key}` },
  ...extra,
});

const project: Project = {
  id: "p-1",
  name: "AI 简报站",
  goal: "每天出 AI 日报",
  state: "in_use",
  origin: "suggestion",
  maintainerId: "pm-1",
  workdir: { external: false },
  charterConfirmed: true,
  createdAt: T,
  updatedAt: T,
  operations: { revision: 1, confirmedAt: T, items: ["web", "api", "doc", "old", "new"].map((k) => serviceItem(k)) },
};

const services = (list: ProjectServiceView[]) => frame("projects", 1, EVENT_TYPES.projectServices, { services: list });

describe("项目的服务", () => {
  test("临时事件 project_services 整份换掉；按项目取（撤下了的不算）、按运营方案的一条取、按应用名取", () => {
    const state = replay([
      frame("projects", 1, "project", { project, change: "in_use", from: "building", by: "user" } satisfies ProjectEventPayload),
      services([view("web"), view("old", { rollout: "withdrawn" })]),
      services([view("web", { status: "offline" }), view("old", { rollout: "withdrawn" }), view("x", { projectId: "p-2", app: "p-2-x" })]),
    ]);
    expect(state.projectServices).toHaveLength(3);
    expect(projectServicesOf(state, "p-1").map((v) => [v.app, v.status])).toEqual([["p-1-web", "offline"]]);
    expect(serviceOfItem(state, "p-1", "old")?.rollout).toBe("withdrawn");
    expect(serviceByApp(state, "p-2-x")?.projectId).toBe("p-2");
  });

  test("入口：上线了、有网页的能打开（不在线也打开：转发给说明页）；上线中、失败、要手动、没网页的不打开，提示原因", () => {
    expect(serviceEntryView(view("web"))).toEqual({ label: "打开「简报站」", canOpen: true, kind: "online", text: "在线" });
    expect(serviceEntryView(view("web", { status: "failed", detail: "退出码 1" }))).toMatchObject({ canOpen: true, kind: "failed", text: "失败", detail: "退出码 1" });
    expect(serviceEntryView(view("web", { status: "offline" }))).toMatchObject({ canOpen: true, kind: "offline", text: "离线" });
    expect(serviceEntryView(view("web", { rollout: "pending", status: "unknown" }))).toMatchObject({ canOpen: false, kind: "busy", text: "上线中", hint: "「简报站」上线中" });
    expect(serviceEntryView(view("web", { rollout: "failed", reason: "端口被占" }))).toMatchObject({ canOpen: false, kind: "failed", hint: "「简报站」上线失败：端口被占" });
    expect(serviceEntryView(view("web", { rollout: "manual", reason: "LSM 版本不支持名下的服务" }))).toMatchObject({ canOpen: false, kind: "manual", text: "要你手动" });
    const { url: _url, ...noWeb } = view("web");
    expect(serviceEntryView(noWeb)).toMatchObject({ canOpen: false, hint: "「简报站」没有网页" });
    // 点了：能打开的交给内置浏览器（地址、标题栏的名字），别的提示原因
    expect(serviceEntryClick(view("web", { status: "offline" }))).toEqual({ kind: "open", url: "/apps/p-1-web/", title: "简报站" });
    expect(serviceEntryClick(view("web", { rollout: "failed", reason: "端口被占" }))).toEqual({ kind: "hint", text: "「简报站」上线失败：端口被占" });
    expect(serviceEntryClick(noWeb)).toEqual({ kind: "hint", text: "「简报站」没有网页" });
  });

  test("运营方案那一节：服务那一条照项目的服务现算——在线、上线失败（原因）、要你手动、已撤下、还没收到的状态未知；行上带着服务（入口）", () => {
    const state = replay([
      frame("projects", 1, "project", { project, change: "in_use", from: "building", by: "user" } satisfies ProjectEventPayload),
      services([
        view("web"),
        view("api", { rollout: "failed", reason: "端口 18080 已被 node.exe (4321) 占着" }),
        view("doc", { rollout: "manual", reason: "LSM 版本不支持名下的服务，需要手动在 LSM 里登记" }),
        view("old", { rollout: "withdrawn" }),
      ]),
    ]);
    const rows = projectOperationRows(state, state.projects["p-1"]!);
    expect(rows.map((r) => [r.item.key, r.status, r.statusText, r.detail])).toEqual([
      ["web", "running", "在线", undefined],
      ["api", "failed", "上线失败", "端口 18080 已被 node.exe (4321) 占着"],
      ["doc", "manual", "要你手动", "LSM 版本不支持名下的服务，需要手动在 LSM 里登记"],
      ["old", "paused", "已撤下", undefined],
      ["new", "paused", "状态未知", undefined],
    ]);
    expect(rows[0]!.service?.url).toBe("/apps/p-1-web/");
    expect(rows[0]!.howText).toBe("有网页 · /apps/p-1-web/");
  });

  test("卡上服务那一条的细节、改了的服务改了哪几处（不重复写触发）", () => {
    expect(serviceSpecRows(service)).toEqual([
      { label: "启动命令", value: "node server.mjs" },
      { label: "工作目录", value: "D:/work/p-1/site" },
      { label: "端口", value: "18080" },
      { label: "环境变量", value: "KEY（密钥：k.txt）、MODE=prod" },
      { label: "健康检查", value: "/health" },
      { label: "开机自启", value: "开" },
      { label: "网页", value: "/apps/p-1-web/" },
    ]);
    const before = serviceItem("web");
    const after = serviceItem("web", { triggerText: "上线服务「web」（端口 18090，不开机自启，挂了自动重启）", service: { ...service, port: 18090, autostart: false, autoRestart: true, command: "node server.mjs --quiet" } });
    expect(operationChangedFields(before, after)).toEqual(["启动命令：node server.mjs → node server.mjs --quiet", "端口：18080 → 18090", "开机自启：开 → 关", "挂了自动重启：关 → 开"]);
    // 开着挂了自动重启的，细节里多一项
    expect(serviceSpecRows({ ...service, autoRestart: true })).toContainEqual({ label: "挂了自动重启", value: "开" });
  });
});
