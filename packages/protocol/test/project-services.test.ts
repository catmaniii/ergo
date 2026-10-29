// 项目的服务（133 号票）在协议包里的说法；257 号票：项目卡片、项目页上的"启动""关闭"——一个服务关着、在启动 / 关闭的说法，
// 一个项目的服务开关现在什么样、两个按钮能不能点（projectPower：只有使用中、有在 LSM 上的服务的项目才有）。
import { describe, expect, test } from "vitest";
import { projectPower, type ProjectServiceView, serviceLine, serviceStateText } from "../src/index.ts";

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

describe("一个服务关着、在启动 / 关闭时的说法（257）", () => {
  test("关着的写“已关闭”（灰）；还在启动、关闭的写“启动中…”“关闭中…”；关闭没做成写原因；没关过的照旧", () => {
    expect(serviceStateText(view("web", { paused: true, status: "offline" }))).toEqual({ kind: "offline", text: "已关闭" });
    expect(serviceStateText(view("web", { paused: true, power: "stopping" }))).toEqual({ kind: "busy", text: "关闭中…" });
    expect(serviceStateText(view("web", { power: "starting", status: "offline" }))).toEqual({ kind: "busy", text: "启动中…" });
    expect(serviceStateText(view("web", { paused: true, powerReason: "停不下来：进程不响应" }))).toEqual({ kind: "failed", text: "关闭失败", detail: "停不下来：进程不响应" });
    // 上线失败的关了：也是关着
    expect(serviceStateText(view("web", { rollout: "failed", reason: "端口被占", paused: true }))).toEqual({ kind: "offline", text: "已关闭" });
    // 撤下了的不看开关
    expect(serviceStateText(view("web", { rollout: "withdrawn", paused: true }))).toMatchObject({ kind: "withdrawn" });
    expect(serviceStateText(view("web"))).toEqual({ kind: "online", text: "在线" });
    // 秘书的看板、工具结果里那一行
    expect(serviceLine(view("web", { paused: true, status: "offline" }))).toBe("服务「简报站」（p-1 · p-1-web · 端口 18080）：已关闭，入口 /apps/p-1-web/");
  });
});

describe("一个项目的服务开关（projectPower，257）", () => {
  test("只有使用中、有在 LSM 上的服务的项目才有：别的状态、没有服务、只剩撤下了的都没有", () => {
    expect(projectPower("in_use", [view("web")])).toBeDefined();
    expect(projectPower("retired", [view("web")])).toBeUndefined();
    expect(projectPower("building", [view("web")])).toBeUndefined();
    expect(projectPower("in_use", [])).toBeUndefined();
    expect(projectPower("in_use", [view("web", { rollout: "withdrawn" }), view("api", { rollout: "withdrawing" })])).toBeUndefined();
  });

  test("在线：全部在线时“启动”不能点、“关闭”能点", () => {
    expect(projectPower("in_use", [view("web"), view("api")])).toEqual({ state: "online", text: "在线", canStart: false, canStop: true });
  });

  test("关着：“启动”能点、“关闭”不能点；关闭中、启动中的两头各一个能点（照最新的来）；关闭没做成的两个都能点", () => {
    expect(projectPower("in_use", [view("web", { paused: true, status: "offline" })])).toEqual({ state: "off", text: "已关闭", canStart: true, canStop: false });
    expect(projectPower("in_use", [view("web", { paused: true, power: "stopping" }), view("api", { paused: true, status: "offline" })])).toEqual({ state: "stopping", text: "关闭中…", canStart: true, canStop: false });
    expect(projectPower("in_use", [view("web", { power: "starting", status: "offline" })])).toEqual({ state: "starting", text: "启动中…", canStart: false, canStop: true });
    expect(projectPower("in_use", [view("web", { paused: true, powerReason: "停不下来" })])).toEqual({ state: "stopFailed", text: "关闭失败", detail: "停不下来", canStart: true, canStop: true });
  });

  test("失败：上线 / 启动失败、挂了的写原因（几个服务时写是哪个）；有的停着写“不在线”；两个按钮都能点", () => {
    expect(projectPower("in_use", [view("web", { rollout: "failed", reason: "端口 18080 已被占用" })])).toEqual({ state: "failed", text: "失败", detail: "端口 18080 已被占用", canStart: true, canStop: true });
    expect(projectPower("in_use", [view("web"), view("api", { status: "failed", detail: "进程退出了（退出码 1）" })])).toEqual({
      state: "failed",
      text: "失败",
      detail: "「api」进程退出了（退出码 1）",
      canStart: true,
      canStop: true,
    });
    expect(projectPower("in_use", [view("web"), view("api", { status: "offline" })])).toEqual({ state: "offline", text: "不在线", canStart: true, canStop: true });
  });

  test("LSM 没连上（都是状态未知）、LSM 不支持或二狗不是由 LSM 启动的（要你手动）：两个按钮都不能点，写原因", () => {
    expect(projectPower("in_use", [view("web", { status: "unknown" })])).toEqual({ state: "unknown", text: "状态未知", canStart: false, canStop: false, blocked: "LSM 没连上，现在启动、关闭不了" });
    expect(projectPower("in_use", [view("web", { rollout: "manual", status: "unknown", reason: "LSM 版本不支持名下的服务" })])).toMatchObject({ canStart: false, canStop: false, blocked: "LSM 版本不支持名下的服务" });
  });
});
