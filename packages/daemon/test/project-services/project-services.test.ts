// 项目的服务（133 号票）的单元切面：
// - 一个服务写得对不对（spec.ts）：工作目录不出界（项目档案里也行）、密钥、补齐、交给 LSM 的定义；
// - 接入层的名下服务（lsm/link.ts）：新管理器（welcome 里有 services）能登记、启停、撤销、收状态推送，断线时在途的请求回"断了"；
//   老管理器什么都不发；
// - 上线、撤下（project-services.ts，假的接入层）：二狗没接入 LSM 记"要你手动"；LSM 没连上的等连上再做，接上后补做；
//   在跑时改端口先停再登记；LSM 里没登记过的撤下不去找 LSM；LSM 推来的状态换算成在线、失败……
// - 接上 LSM 时兜底（269 号票）：接上后的第一份全量里上线了、用户没关、没在跑的整份登记、启动，记上线的结果（带 revive）；在跑的、
//   关着的、还没做完的、要你手动的不算；接上之后再挂不拉；拉的时候不看挂没挂、用户点了关闭照最新的来；拉不起来通知维护者。
// - 服务首页的缩略图（140 号票，截图注入假的）：上线并在线后截一次、6 小时内有人看不重截、过了 6 小时有人看补截、改了方案或重启后重截、
//   同时只截一个、截不了的留旧图（没有旧图的不给截图时间）、守护进程起来时不一口气截、删除项目时删掉；怎么截（假的浏览器驱动）。
import fs from "node:fs";
import path from "node:path";
import { CHANNELS, EVENT_TYPES, maintainerChannel, type MessageEventPayload, nowIso, type OperationItemDraft, type OperationService, type Project, type ProjectEventPayload, type ProjectServiceView } from "@ergo/protocol";
import { describe, expect, it, onTestFinished } from "vitest";
import { createAppRegistry } from "../../src/apps/registry.ts";
import { openEventStore } from "../../src/events/event-store.ts";
import { DISABLED_LSM_SERVICES, linkToLsm, type LsmServiceDefinition, type LsmServices, type LsmServicesReply, type LsmServicesSupport, type LsmServicesStatusMessage } from "../../src/lsm/link.ts";
import { OPERATIONS_CHANNEL, OPERATIONS_EVENTS, type OperationsDecidedPayload } from "../../src/operations/events.ts";
import {
  captureServiceHome,
  createProjectServices,
  looksLikeSecret,
  lsmDefinition,
  withOwnNode,
  normalizeService,
  PROJECT_SERVICE_EVENTS,
  type ProjectServicesOptions,
  projectServicesView,
  SERVICE_THUMBNAIL_SCALE,
  SERVICE_THUMBNAIL_VIEWPORT,
  serviceProblems,
  type ServiceRolloutPayload,
  statusOf,
} from "../../src/project-services/index.ts";
import { projectsView } from "../../src/projects/views.ts";
import { ManualClock } from "../helpers/clock.ts";
import { startLsmStandIn } from "../helpers/lsm-stand-in.ts";
import { waitUntil } from "../helpers/process.ts";
import { makeTempDir } from "../helpers/temp-dir.ts";
import { FakeBrowser } from "../helpers/web.ts";
import { fakeSecret } from "../helpers/fake-secrets.ts";

const draft = (service: Partial<NonNullable<OperationItemDraft["service"]>> = {}): OperationItemDraft => ({
  key: "web",
  name: "网页",
  means: "service",
  instructions: "网页",
  capabilities: {},
  service: { name: "web", command: "node server.mjs", port: 18080, ...service },
});

/** 一个项目的项目档案和工作目录（临时目录要在测试里建） */
function specPaths() {
  const root = fs.realpathSync.native(makeTempDir("ergo-spec-"));
  const records = path.join(root, "projects", "p-1");
  const workdir = path.join(records, "workdir");
  fs.mkdirSync(path.join(workdir, "site"), { recursive: true });
  fs.mkdirSync(path.join(records, "adr"), { recursive: true });
  return { records, workdir, ctx: { projectId: "p-1", workdir, records, takenPorts: () => new Map([[8810, "二狗的本机端口"]]) } };
}

describe("一个服务写得对不对（spec.ts）", () => {

  it("工作目录：相对工作目录写、不写是工作目录本身、项目档案里的也行；出界、不存在的拒", () => {
    const { ctx, records } = specPaths();
    expect(serviceProblems(draft({ cwd: "site" }), ctx)).toEqual([]);
    expect(serviceProblems(draft(), ctx)).toEqual([]);
    expect(serviceProblems(draft({ cwd: path.join(records, "adr") }), ctx)).toEqual([]);
    expect(serviceProblems(draft({ cwd: "../../.." }), ctx)[0]).toContain("出界了");
    expect(serviceProblems(draft({ cwd: "nope" }), ctx)[0]).toContain("不存在");
  });

  it("密钥：看名字、看值像密钥的不许写值；写引用（secret、userEnv）可以；一个变量只写一种来源", () => {
    const { ctx } = specPaths();
    expect(looksLikeSecret(fakeSecret("sk-", "proj-abcdefghijklmnop1234"))).toBe(true);
    expect(looksLikeSecret(fakeSecret("ghp_", "abcdefghijklmnopqrstuv"))).toBe(true);
    expect(looksLikeSecret("a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6")).toBe(true);
    expect(looksLikeSecret("production")).toBe(false);
    expect(looksLikeSecret("C:/Users/me/very/long/path/that/is/not/a/secret")).toBe(false);
    expect(serviceProblems(draft({ env: [{ name: "DB_PASSWORD", value: "x" }] }), ctx)[0]).toContain("看名字是密钥");
    expect(serviceProblems(draft({ env: [{ name: "DB_PASSWORD", secret: "db.txt" }, { name: "HOME_DIR", userEnv: true }, { name: "MODE", value: "prod" }] }), ctx)).toEqual([]);
    expect(serviceProblems(draft({ env: [{ name: "A", value: "x", userEnv: true }] }), ctx)[0]).toContain("三样里写一样");
    expect(serviceProblems(draft({ env: [{ name: "A", secret: "../x.txt" }] }), ctx)[0]).toContain("要是密钥区里的文件名");
  });

  it("端口撞了二狗自己的拒；服务名里不能有连着的两个连字符；不写触发、不是流程", () => {
    const { ctx } = specPaths();
    expect(serviceProblems(draft({ port: 8810 }), ctx)).toEqual(["端口 8810 已经是二狗的本机端口的了：换一个"]);
    expect(serviceProblems(draft({ name: "a--b" }), ctx)[0]).toContain("连着的两个连字符");
    expect(serviceProblems({ ...draft(), schedule: { kind: "daily", time: "08:00" } }, ctx)[0]).toContain("不写 schedule");
    expect(serviceProblems({ ...draft(), approach: "workflow" }, ctx)[0]).toContain("不能是流程");
  });

  it("补齐：绝对路径、开机自启默认开、挂了自动重启默认关、首页 / 和 strip；交给 LSM 的定义换密钥区的路径、注入 ERGO_BASE_PATH、空值算可选、挂了自动重启照写", () => {
    const { ctx, workdir } = specPaths();
    const s = normalizeService(draft({ cwd: "site", web: {}, env: [{ name: "KEY", secret: "k.txt" }, { name: "EMPTY", value: "" }] }).service!, ctx);
    expect(s).toEqual({ name: "web", app: "p-1-web", command: "node server.mjs", cwd: path.join(workdir, "site"), env: [{ name: "KEY", secret: "k.txt" }, { name: "EMPTY", value: "" }], port: 18080, autostart: true, autoRestart: false, web: { home: "/", prefix: "strip" } });
    expect(lsmDefinition(s, { title: "网页", projectName: "简报站" }, "D:/data/secrets")).toEqual({
      name: "p-1-web",
      title: "简报站 · 网页",
      project: "二狗 · 简报站",
      command: "node server.mjs",
      cwd: path.join(workdir, "site"),
      port: 18080,
      env: [
        { name: "KEY", from: "file", path: path.join("D:/data/secrets", "k.txt") },
        { name: "EMPTY", from: "literal", value: "", optional: true },
        { name: "ERGO_BASE_PATH", from: "literal", value: "/apps/p-1-web" },
        // 312 号票：另带一份旧名字的（早先做的服务读的是它）
        { name: "ERGOU_BASE_PATH", from: "literal", value: "/apps/p-1-web" },
      ],
      autostart: true,
      autoRestart: false,
    });
    // 维护者写了挂了自动重启：照它登记
    const restarting = normalizeService(draft({ autoRestart: true, autostart: false }).service!, ctx);
    expect(restarting).toMatchObject({ autostart: false, autoRestart: true });
    expect(lsmDefinition(restarting, { title: "网页", projectName: "简报站" }, "D:/data/secrets")).toMatchObject({ autostart: false, autoRestart: true });
  });

  it("命令开头是 node 的换成二狗自己那份 Node（带引号），别的原样；不给 nodePath 原样", () => {
    const own = String.raw`C:\Program Files\ergo\node.exe`;
    expect(withOwnNode("node server.mjs", own)).toBe(`"${own}" server.mjs`);
    expect(withOwnNode("node.exe server.mjs --port 1", own)).toBe(`"${own}" server.mjs --port 1`);
    expect(withOwnNode("NODE a.js", own)).toBe(`"${own}" a.js`);
    expect(withOwnNode("  node a.js", own)).toBe(`"${own}" a.js`);
    expect(withOwnNode("node", own)).toBe(`"${own}"`);
    for (const kept of ["nodemon a.js", "npm start", "npx serve .", String.raw`D:\tools\node.exe a.js`, "python -m http.server", "node-red"]) expect(withOwnNode(kept, own)).toBe(kept);
    expect(withOwnNode("node a.js", undefined)).toBe("node a.js");
    const { ctx } = specPaths();
    const s = normalizeService(draft({}).service!, ctx);
    expect(lsmDefinition(s, { title: "网页", projectName: "简报站" }, "D:/data/secrets", own).command).toBe(`"${own}" server.mjs`);
  });

  it("LSM 推来的状态换算：在跑在线、健康检查不过算失败、FAILED 带原因、停着离线", () => {
    const base = { id: "x--a", name: "a", port: 1, up: false };
    expect(statusOf({ ...base, state: "RUNNING", up: true, health: "ok" })).toEqual({ status: "online" });
    expect(statusOf({ ...base, state: "DEGRADED", up: true, health: "failing", detail: "HTTP 500" })).toEqual({ status: "failed", detail: "HTTP 500" });
    expect(statusOf({ ...base, state: "FAILED", lastError: "端口被占" })).toEqual({ status: "failed", detail: "端口被占" });
    expect(statusOf({ ...base, state: "STOPPED" })).toEqual({ status: "offline" });
    expect(statusOf({ ...base, state: "STARTING" })).toEqual({ status: "starting" });
  });
});

/** 接入层的选项（只关心名下的服务） */
const options = (env: Record<string, string>) => ({ env, port: 1, version: "t", busy: () => ({ busy: false }), health: () => "ok" as const, onShutdown: async () => {}, onConflict: () => {}, log: () => {} });

describe("接入层的名下服务（lsm/link.ts）", () => {

  it("新管理器：hello 声明 features，welcome 带 services 就支持；登记、启动、停止（force）、撤销照协议回；接入时收到全量状态；断线时在途的请求回“断了”", async () => {
    const lsm = await startLsmStandIn({ owned: true });
    const link = linkToLsm(options(lsm.env));
    const supports: LsmServicesSupport[] = [];
    link.services.onSupport((s) => supports.push(s));
    const statuses: LsmServicesStatusMessage[] = [];
    link.services.onStatus((m) => statuses.push(m));
    await waitUntil(() => link.services.support === "supported", { describe: () => "等 welcome" });
    expect((await lsm.waitFor((m) => m.type === "hello", "握手")).features).toEqual(["services"]);
    await waitUntil(() => statuses.some((m) => m.full), { describe: () => "接入时的全量状态" });

    const put = await link.services.put({ name: "p-1-web", command: "node a.mjs", cwd: "D:/w", port: 18080, autostart: true });
    expect(put).toMatchObject({ ok: true, created: true, service: { name: "p-1-web", state: "STOPPED", autostart: true } });
    expect(await link.services.start("p-1-web")).toMatchObject({ ok: true, service: { state: "RUNNING", up: true } });
    await waitUntil(() => statuses.some((m) => !m.full && m.services.some((s) => s.state === "RUNNING")), { describe: () => "状态推送" });
    expect(lsm.serviceRequests().find((m) => m.type === "services.stop")).toBeUndefined();
    expect(await link.services.stop("p-1-web", { force: true })).toMatchObject({ ok: true });
    expect(lsm.serviceRequests().at(-1)).toMatchObject({ type: "services.stop", name: "p-1-web", force: true, mode: "now" });
    expect(await link.services.remove("p-1-web")).toMatchObject({ ok: true, removed: { name: "p-1-web" } });
    expect(await link.services.remove("p-1-web")).toMatchObject({ ok: false, error: { code: "not-found" } });

    // 断线：在途的请求回"断了"，支不支持回到 waiting（等重连后的 welcome）
    lsm.owned.failNextStart("x", "never");
    const pending = link.services.list();
    await lsm.close();
    const reply = await pending;
    // 替身可能在关之前回了，也可能没回：没回的一定是"断了"
    expect(reply.ok ? "replied" : reply.error.code).toMatch(/^(replied|disconnected)$/);
    await waitUntil(() => link.services.support === "waiting", { describe: () => "断线后等重连" });
    expect(supports.slice(0, 2)).toEqual(["supported", "waiting"]);
    link.close();
  });

  it("老管理器（welcome 里没有 features）：不支持，请求不发、直接回 unsupported；没注入身份的是 disabled", async () => {
    const lsm = await startLsmStandIn();
    const link = linkToLsm(options(lsm.env));
    await waitUntil(() => link.services.support === "unsupported", { describe: () => "等 welcome" });
    expect(await link.services.put({ name: "a", command: "x", cwd: "D:/", port: 18081 })).toMatchObject({ ok: false, error: { code: "unsupported" } });
    expect(lsm.serviceRequests()).toEqual([]);
    link.close();
    const none = linkToLsm(options({}));
    expect(none.services.support).toBe("disabled");
    expect(await none.services.start("a")).toMatchObject({ ok: false, error: { code: "not-linked" } });
  });
});

/**
 * 假的接入层：支不支持由测试定，请求按测试给的回。calls 记"种类 名字"，requests 另记登记的定义、开关、force（257 号票）；
 * holdNext(种类) 让下一次这种请求等测试放行（做到一半又点）
 */
function fakeLsm(support: LsmServicesSupport) {
  const calls: string[] = [];
  const requests: Array<{ type: string; name: string; on?: boolean; force?: boolean; definition?: LsmServiceDefinition }> = [];
  const supportListeners = new Set<(s: LsmServicesSupport) => void>();
  const statusListeners = new Set<(m: LsmServicesStatusMessage) => void>();
  const replies: Record<string, LsmServicesReply[]> = {};
  const holds = new Map<string, Promise<void>>();
  const answer = async (type: string, name: string, extra: Omit<(typeof requests)[number], "type" | "name"> = {}): Promise<LsmServicesReply> => {
    calls.push(`${type} ${name}`);
    requests.push({ type, name, ...extra });
    const hold = holds.get(type);
    holds.delete(type);
    if (hold) await hold;
    return replies[type]?.shift() ?? { ok: true, service: { id: `ergo-daemon--${name}`, name, port: 1, state: type === "stop" ? "STOPPED" : "RUNNING", up: type !== "stop" && type !== "put" } };
  };
  const services: LsmServices & { set(s: LsmServicesSupport): void; push(m: LsmServicesStatusMessage): void } = {
    get support() {
      return support;
    },
    put: (d) => answer("put", d.name, { definition: d }),
    start: (n) => answer("start", n),
    stop: (n, o) => answer("stop", n, { force: o?.force === true }),
    restart: (n, o) => answer("restart", n, { force: o?.force === true }),
    autostart: (n, on) => answer("autostart", n, { on }),
    remove: (n) => answer("remove", n),
    list: () => answer("list", ""),
    onStatus: (l) => (statusListeners.add(l), () => statusListeners.delete(l)),
    onSupport: (l) => (supportListeners.add(l), () => supportListeners.delete(l)),
    set(s) {
      support = s;
      for (const l of supportListeners) l(s);
    },
    push(m) {
      for (const l of statusListeners) l(m);
    },
  };
  /** 下一次这种请求等着，返回放行 */
  const holdNext = (type: string): (() => void) => {
    let release: (() => void) | undefined;
    holds.set(type, new Promise<void>((resolve) => (release = resolve)));
    return () => release?.();
  };
  return { services, calls, requests, replies, holdNext };
}

/** 一个事件存储（项目列表、服务两个视图）、一个使用中的项目，和建在上面的 project-services */
function setup(lsm: LsmServices, clock = new ManualClock(Date.parse("2026-10-18T09:00:00+08:00")), extra: Partial<ProjectServicesOptions> = {}) {
  const store = openEventStore({ file: path.join(makeTempDir("ergo-ps-"), "ergo.db"), views: [projectsView, projectServicesView], log: () => {} });
  onTestFinished(() => store.close());
  const project: Project = { id: "p-1", name: "简报站", goal: "g", state: "in_use", origin: "suggestion", maintainerId: "pm-1", workdir: { external: false }, charterConfirmed: true, createdAt: nowIso(), updatedAt: nowIso() };
  store.append({ channel: CHANNELS.projects, type: EVENT_TYPES.project, payload: { project, change: "created", from: null, by: "user" } satisfies ProjectEventPayload });
  const apps = createAppRegistry();
  const published: ProjectServiceView[][] = [];
  // 守护进程重启：同一个事件存储上再建一份
  const make = (more: Partial<ProjectServicesOptions> = {}) => createProjectServices({
    store,
    lsm: () => lsm,
    apps,
    secretsDir: "D:/data/secrets",
    project: (id) => (id === "p-1" ? project : undefined),
    prefixCheck: async () => ({ url: "", status: 200, basePath: "", findings: [] }),
    publish: (s) => published.push(s),
    clock,
    now: nowIso,
    log: () => {},
    ...extra,
    ...more,
  });
  const services = make();
  const service: OperationService = { name: "web", app: "p-1-web", command: "node a.mjs", cwd: "D:/w", env: [], port: 18080, autostart: true, autoRestart: false, web: { home: "/", prefix: "strip" } };
  const want = (present: boolean, s = service, key = "web", title = "网页") =>
    store.append({ channel: OPERATIONS_CHANNEL, type: PROJECT_SERVICE_EVENTS.desired, payload: { projectId: "p-1", key, title, app: s.app, present, service: s, why: present ? "confirmed" : "removed", time: nowIso() } });
  return { store, apps, services, published, want, service, clock, make, project };
}

describe("上线、撤下（project-services.ts）", () => {
  it("二狗没接入 LSM：记“要你手动”，不找 LSM；转发不登记", async () => {
    const { services, want, apps } = setup(DISABLED_LSM_SERVICES);
    services.start();
    want(true);
    await services.idle();
    expect(services.view()).toMatchObject([{ app: "p-1-web", rollout: "manual", reason: expect.stringContaining("二狗不是由 LSM 启动的"), status: "unknown" }]);
    expect(apps.get("p-1-web")).toBeUndefined();
    services.stop();
  });

  it("LSM 还没连上：上线中，等连上（welcome 里有 services）再做；上线了登记转发，LSM 推来的状态跟着变", async () => {
    const lsm = fakeLsm("waiting");
    const { services, want, apps, published } = setup(lsm.services);
    services.start();
    want(true);
    await services.idle();
    expect(services.view()[0]).toMatchObject({ rollout: "pending", status: "unknown" });
    expect(lsm.calls).toEqual([]);
    lsm.services.set("supported");
    await waitUntil(() => services.view()[0]?.rollout === "live", { describe: () => JSON.stringify(services.view()) });
    expect(lsm.calls).toEqual(["put p-1-web", "start p-1-web"]);
    expect(apps.get("p-1-web")).toMatchObject({ port: 18080, prefix: "strip", title: "网页" });
    lsm.services.push({ full: true, services: [{ id: "ergo-daemon--p-1-web", name: "p-1-web", port: 18080, state: "FAILED", up: false, lastError: "退出码 1" }], removed: [] });
    expect(services.view()[0]).toMatchObject({ rollout: "live", status: "failed", detail: "退出码 1", url: "/apps/p-1-web/" });
    expect(published.at(-1)?.[0]).toMatchObject({ status: "failed" });
    // 全量推送里没有它了：LSM 里没有它了
    lsm.services.push({ full: true, services: [], removed: [] });
    expect(services.view()[0]?.status).toBe("missing");
    services.stop();
  });

  it("在跑时改端口：LSM 回 running 就先停（强制）再登记；撤下：撤掉转发、LSM 里撤销；LSM 里没登记过的撤下不找 LSM", async () => {
    const lsm = fakeLsm("supported");
    const { services, want, apps, service } = setup(lsm.services);
    services.start();
    want(true);
    await services.idle();
    expect(services.view()[0]?.rollout).toBe("live");
    lsm.replies.put = [{ ok: false, error: { code: "running", message: "在跑的时候不能改端口" } }, { ok: true, restartNeeded: false, service: { id: "x", name: "p-1-web", port: 18090, state: "STOPPED", up: false } }];
    lsm.calls.length = 0;
    want(true, { ...service, port: 18090 });
    await services.idle();
    expect(lsm.calls).toEqual(["put p-1-web", "stop p-1-web", "put p-1-web", "start p-1-web"]);
    expect(apps.get("p-1-web")?.port).toBe(18090);
    lsm.calls.length = 0;
    want(false);
    await services.idle();
    expect(lsm.calls).toEqual(["remove p-1-web"]);
    expect(services.view()[0]?.rollout).toBe("withdrawn");
    expect(apps.get("p-1-web")).toBeUndefined();
    // 已经撤下了的再撤：LSM 里没有它的登记，不去找 LSM
    lsm.calls.length = 0;
    want(false);
    await services.idle();
    expect(lsm.calls).toEqual([]);
    services.stop();
  });

  it("上线失败：原因来自 LSM（message 加逐条的 details）；撤下失败的记原因，重新接上时再撤", async () => {
    const lsm = fakeLsm("supported");
    const { services, want } = setup(lsm.services);
    services.start();
    lsm.replies.put = [{ ok: false, error: { code: "invalid", message: "定义不合规", details: ["cwd 不存在：D:/w"] } }];
    want(true);
    await services.idle();
    expect(services.view()[0]).toMatchObject({ rollout: "failed", reason: "定义不合规；cwd 不存在：D:/w" });
    // 再交一次：这次起来了
    want(true);
    await services.idle();
    expect(services.view()[0]?.rollout).toBe("live");
    lsm.replies.remove = [{ ok: false, error: { code: "in-use", message: "还接着公网隧道" } }];
    want(false);
    await services.idle();
    expect(services.view()[0]).toMatchObject({ rollout: "withdraw_failed", reason: "还接着公网隧道" });
    lsm.services.set("waiting");
    lsm.services.set("supported");
    await waitUntil(() => services.view()[0]?.rollout === "withdrawn", { describe: () => JSON.stringify(services.view()) });
    services.stop();
  });

  it("上线后又挂了：不在线持续 30 秒才通知维护者（LSM 给的原因），重启一下不报；同一次故障只报一次（守护进程重启了也不重报），又在线 30 秒说一声好了；LSM 没连上时不判", async () => {
    const lsm = fakeLsm("supported");
    const { services, want, store, clock, make } = setup(lsm.services);
    services.start();
    want(true);
    await services.idle();
    expect(services.view()[0]?.rollout).toBe("live");
    const push = (state: string, extra: Record<string, unknown> = {}, full = false) =>
      lsm.services.push({ full, services: [{ id: "ergo-daemon--p-1-web", name: "p-1-web", port: 18080, state, up: state === "RUNNING", ...extra }], removed: [] });
    const notices = () => store.read(maintainerChannel("pm-1"), 0, EVENT_TYPES.message).map((e) => (e.payload as MessageEventPayload).message.parts.map((p) => ("text" in p ? p.text : "")).join(""));
    push("RUNNING", {}, true);

    // 重启一下（停止中、停了 10 秒、启动中、又在线）：不报
    push("STOPPING");
    push("STOPPED");
    clock.advance(10_000);
    push("STARTING");
    push("RUNNING");
    clock.advance(60_000);
    expect(notices()).toEqual([]);

    // 挂了：失败（LSM 给了原因），重拉时启动中也算没好；持续 30 秒才报，写明原因
    push("FAILED", { lastError: "进程退出了（退出码 1）" });
    clock.advance(29_000);
    push("STARTING");
    expect(notices()).toEqual([]);
    clock.advance(2_000);
    expect(notices()).toHaveLength(1);
    expect(notices()[0]).toContain("服务「网页」（p-1-web，端口 18080）上线后挂了，现在不在线：进程退出了（退出码 1）。它没开挂了自动重启");
    // 同一次故障：又失败一次、再等也不重报
    push("FAILED", { lastError: "进程退出了（退出码 1）" });
    clock.advance(60_000);
    expect(notices()).toHaveLength(1);

    // 守护进程重启：故障报过了，不重报；又在线持续 30 秒说一声好了（中途又掉了就重新数）
    services.stop();
    const again = make();
    again.start();
    push("FAILED", { lastError: "进程退出了（退出码 1）" }, true);
    clock.advance(60_000);
    expect(notices()).toHaveLength(1);
    push("RUNNING");
    clock.advance(20_000);
    push("STARTING");
    push("RUNNING");
    clock.advance(29_000);
    expect(notices()).toHaveLength(1);
    clock.advance(2_000);
    expect(notices()).toHaveLength(2);
    expect(notices()[1]).toContain("服务「网页」（p-1-web）又在线了");

    // 好了以后又挂了（这次是停着的，LSM 没给原因）：另一次故障，再报
    push("STOPPED");
    clock.advance(31_000);
    expect(notices()).toHaveLength(3);
    expect(notices()[2]).toContain("LSM 里它是停着的");
    push("RUNNING");
    clock.advance(31_000);
    expect(notices()).toHaveLength(4);

    // LSM 断了（状态未知）：不判
    push("FAILED", { lastError: "退出码 2" });
    lsm.services.set("waiting");
    clock.advance(60_000);
    expect(notices()).toHaveLength(4);

    // 撤下了的不再看
    lsm.services.set("supported");
    push("RUNNING", {}, true);
    want(false);
    await again.idle();
    push("FAILED", {}, true);
    clock.advance(60_000);
    expect(notices()).toHaveLength(4);
    again.stop();
  });
});

/** 257：第二个服务（接口，没有网页） */
const api = (service: OperationService): OperationService => ({ ...service, name: "api", app: "p-1-api", port: 18081, web: undefined });
/** 257：对一个服务发过的请求（"种类 开关 force"） */
const of = (lsm: ReturnType<typeof fakeLsm>, app: string) => lsm.requests.filter((r) => r.name === app).map((r) => `${r.type}${r.on === undefined ? "" : r.on ? " on" : " off"}${r.force ? " force" : ""}`);
/** 257：记下的开关 */
const powerEvents = (store: ReturnType<typeof setup>["store"]) => store.read(OPERATIONS_CHANNEL, 0, PROJECT_SERVICE_EVENTS.power).map((e) => e.payload);
/** 257：做不了的原因（没拒是"没拒"） */
const rejectionOf = (fn: () => unknown): string => {
  try {
    fn();
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
  return "没拒";
};

describe("项目的服务全部关闭、启动（257 号票）", () => {

  it("关闭：每个服务先取消开机自启、再强制停，记成关着；守护进程重启、LSM 重新接上都不去拉起；启动：整份重新登记（恢复开机自启）并启动", async () => {
    const lsm = fakeLsm("supported");
    const { services, want, service, make, store } = setup(lsm.services);
    services.start();
    want(true);
    want(true, api(service), "api", "接口");
    await services.idle();
    lsm.requests.length = 0;

    expect(services.power("p-1", "stop", "user", "k-stop")).toEqual({ projectId: "p-1", action: "stop", services: 2 });
    // 交给 LSM 了、还没做完：关着、关闭中
    expect(services.ofProject("p-1")).toMatchObject([
      { app: "p-1-api", paused: true, power: "stopping" },
      { app: "p-1-web", paused: true, power: "stopping" },
    ]);
    await services.idle();
    expect(of(lsm, "p-1-web")).toEqual(["autostart off", "stop force"]);
    expect(of(lsm, "p-1-api")).toEqual(["autostart off", "stop force"]);
    const off = services.ofProject("p-1");
    expect(off).toMatchObject([
      { app: "p-1-api", rollout: "live", paused: true, status: "offline" },
      { app: "p-1-web", rollout: "live", paused: true, status: "offline" },
    ]);
    expect(off.some((v) => v.power !== undefined || v.powerReason !== undefined)).toBe(false);
    expect(powerEvents(store)).toEqual([{ projectId: "p-1", on: false, by: "user", time: expect.any(String) }]);
    // 同一个请求重发：不多记
    services.power("p-1", "stop", "user", "k-stop");
    expect(powerEvents(store)).toHaveLength(1);

    // 守护进程重启：关着的照样关着，不去 LSM 拉起；LSM 断了又接上也一样
    services.stop();
    lsm.requests.length = 0;
    const again = make();
    again.start();
    lsm.services.set("waiting");
    lsm.services.set("supported");
    lsm.services.push({ full: true, services: ["p-1-web", "p-1-api"].map((name) => ({ id: `ergo-daemon--${name}`, name, port: 1, state: "STOPPED", up: false })), removed: [] });
    await again.idle();
    expect(lsm.requests).toEqual([]);
    expect(again.ofProject("p-1").every((v) => v.paused && v.status === "offline")).toBe(true);

    // 启动：照定义整份重新登记（开机自启回到开着）、启动，等到就绪
    again.power("p-1", "start", "user", "k-start");
    expect(again.ofProject("p-1").map((v) => [v.paused, v.power])).toEqual([
      [undefined, "starting"],
      [undefined, "starting"],
    ]);
    await again.idle();
    expect(of(lsm, "p-1-web")).toEqual(["put", "start"]);
    expect(lsm.requests.find((r) => r.type === "put" && r.name === "p-1-web")?.definition).toMatchObject({ autostart: true });
    expect(again.ofProject("p-1")).toMatchObject([
      { app: "p-1-api", rollout: "live", status: "online" },
      { app: "p-1-web", rollout: "live", status: "online" },
    ]);
    expect(again.ofProject("p-1").some((v) => v.paused || v.power)).toBe(false);
    again.stop();
  });

  it("做到一半又点：启动还在等 LSM 就绪时点关闭——启动的结果不记，接着关掉；关闭做到一半点启动同理，照最新的来", async () => {
    const lsm = fakeLsm("supported");
    const { services, want } = setup(lsm.services);
    services.start();
    want(true);
    await services.idle();
    services.power("p-1", "stop", "user", "k-1");
    await services.idle();
    lsm.requests.length = 0;
    lsm.calls.length = 0;

    const releaseStart = lsm.holdNext("start");
    services.power("p-1", "start", "user", "k-2");
    await waitUntil(() => lsm.calls.at(-1) === "start p-1-web", { describe: () => JSON.stringify(lsm.calls) });
    services.power("p-1", "stop", "user", "k-3");
    expect(services.view()[0]).toMatchObject({ paused: true, power: "stopping" });
    releaseStart();
    await services.idle();
    expect(of(lsm, "p-1-web")).toEqual(["put", "start", "autostart off", "stop force"]);
    expect(services.view()[0]).toMatchObject({ rollout: "live", paused: true, status: "offline" });
    expect(services.view()[0]?.power).toBeUndefined();

    lsm.requests.length = 0;
    lsm.calls.length = 0;
    const releaseStop = lsm.holdNext("stop");
    services.power("p-1", "start", "user", "k-4");
    services.power("p-1", "stop", "user", "k-5");
    await waitUntil(() => lsm.calls.at(-1) === "stop p-1-web", { describe: () => JSON.stringify(lsm.calls) });
    services.power("p-1", "start", "user", "k-6");
    releaseStop();
    await services.idle();
    // 关闭停到一半又点了启动：照最新的再登记、启动
    expect(of(lsm, "p-1-web").slice(-2)).toEqual(["put", "start"]);
    expect(services.view()[0]).toMatchObject({ rollout: "live", status: "online" });
    expect(services.view()[0]?.paused).toBeUndefined();
    services.stop();
  });

  it("做不了的说清原因、不记事件：LSM 没连上、版本不支持、二狗不是由 LSM 启动的；项目不是使用中的；没有在 LSM 上的服务的", async () => {
    for (const [support, why] of [
      ["waiting", "LSM 没连上，等连上再试"],
      ["unsupported", "LSM 版本不支持名下的服务"],
    ] as const) {
      const lsm = fakeLsm(support);
      const { services, want, store } = setup(lsm.services);
      services.start();
      want(true);
      await services.idle();
      expect(rejectionOf(() => services.power("p-1", "stop", "user", "k"))).toContain(why);
      expect(powerEvents(store)).toEqual([]);
      services.stop();
    }
    const none = setup(DISABLED_LSM_SERVICES);
    none.services.start();
    none.want(true);
    await none.services.idle();
    expect(rejectionOf(() => none.services.power("p-1", "start", "user", "k"))).toContain("二狗不是由 LSM 启动的");
    none.services.stop();

    // 没有服务、服务都撤下了
    const lsm = fakeLsm("supported");
    const empty = setup(lsm.services);
    empty.services.start();
    expect(rejectionOf(() => empty.services.power("p-1", "stop", "user", "k"))).toBe("项目「简报站」没有上线的服务，没有可以启动、关闭的");
    empty.want(true);
    empty.want(false);
    await empty.services.idle();
    expect(rejectionOf(() => empty.services.power("p-1", "stop", "user", "k"))).toBe("项目「简报站」没有上线的服务，没有可以启动、关闭的");
    expect(rejectionOf(() => empty.services.power("p-2", "stop", "user", "k"))).toBe("没有这个项目：p-2");
    empty.services.stop();

    // 不是使用中（停用了）：停用、重新启用照原样，启停不管
    const retired: Project = { ...empty.project, state: "retired" };
    const stopped = setup(lsm.services, undefined, { project: (id) => (id === "p-1" ? retired : undefined) });
    stopped.services.start();
    stopped.want(true);
    await stopped.services.idle();
    expect(rejectionOf(() => stopped.services.power("p-1", "start", "user", "k"))).toBe("项目「简报站」不是使用中的，没有可以启动、关闭的服务");
    expect(powerEvents(stopped.store)).toEqual([]);
    stopped.services.stop();
  });

  it("关着的项目停用后重新启用（用户 2026-10-24 定，259 号票改）：重新启用就全部拉起——记一条“全部启动”、重新登记（开机自启开）并启动；取消归档回到使用中同样；本来开着的不多记", async () => {
    const lsm = fakeLsm("supported");
    const { services, want, store, project } = setup(lsm.services);
    services.start();
    want(true);
    await services.idle();
    services.power("p-1", "stop", "user", "k-stop");
    await services.idle();
    const projectEvent = (change: ProjectEventPayload["change"], from: Project["state"], state: Project["state"]) =>
      store.append({ channel: CHANNELS.projects, type: EVENT_TYPES.project, payload: { project: { ...project, state }, change, from, by: "user" } satisfies ProjectEventPayload });
    // 停用：撤下（运营方案的 pause 追加的那条"撤下"）
    projectEvent("retired", "in_use", "retired");
    want(false);
    await services.idle();
    lsm.requests.length = 0;
    // 重新启用：同一时刻记一条"全部启动"，运营方案的 resume 追加的"该在 LSM 上"照它做——整份登记（开机自启开着）、启动
    projectEvent("reactivated", "retired", "in_use");
    want(true);
    await services.idle();
    expect(powerEvents(store).map((p) => [(p as { on: boolean }).on, (p as { by: string }).by])).toEqual([
      [false, "user"],
      [true, "user"],
    ]);
    expect(of(lsm, "p-1-web")).toEqual(["put", "start"]);
    expect(lsm.requests.find((r) => r.type === "put")?.definition).toMatchObject({ autostart: true });
    expect(services.view()[0]).toMatchObject({ rollout: "live", status: "online" });
    expect(services.view()[0]?.paused).toBeUndefined();

    // 再关、使用中归档、取消归档回到使用中：同样拉起
    services.power("p-1", "stop", "user", "k-stop-2");
    await services.idle();
    projectEvent("archived", "in_use", "archived");
    want(false);
    await services.idle();
    projectEvent("unarchived", "archived", "in_use");
    want(true);
    await services.idle();
    expect(powerEvents(store).map((p) => (p as { on: boolean }).on)).toEqual([false, true, false, true]);
    expect(services.view()[0]?.paused).toBeUndefined();

    // 本来开着的：停用、重新启用不多记开关
    projectEvent("retired", "in_use", "retired");
    want(false);
    await services.idle();
    projectEvent("reactivated", "retired", "in_use");
    want(true);
    await services.idle();
    expect(powerEvents(store)).toHaveLength(4);
    services.stop();
  });

  it("给了二狗自己那份 Node：登记给 LSM 的命令开头换成它（项目服务跟着二狗的 Node 版本走）", async () => {
    const lsm = fakeLsm("supported");
    const { services, want } = setup(lsm.services, undefined, { nodePath: String.raw`D:\ergo\node.exe` });
    services.start();
    want(true);
    await services.idle();
    expect(lsm.requests.find((r) => r.type === "put")?.definition).toMatchObject({ command: String.raw`"D:\ergo\node.exe" a.mjs` });
    services.stop();
  });

  it("关着的时候改了方案（重新上线）：登记时开机自启是关的、不启动；关着时挂了、停着都不报故障", async () => {
    const lsm = fakeLsm("supported");
    const { services, want, service, store, clock } = setup(lsm.services);
    services.start();
    want(true);
    await services.idle();
    services.power("p-1", "stop", "user", "k-1");
    await services.idle();
    lsm.requests.length = 0;
    want(true, { ...service, command: "node b.mjs" });
    await services.idle();
    expect(of(lsm, "p-1-web")).toEqual(["put"]);
    expect(lsm.requests[0]?.definition).toMatchObject({ command: "node b.mjs", autostart: false });
    expect(services.view()[0]).toMatchObject({ rollout: "live", paused: true });

    const notices = () => store.read(maintainerChannel("pm-1"), 0, EVENT_TYPES.message).length;
    const before = notices();
    lsm.services.push({ full: true, services: [{ id: "ergo-daemon--p-1-web", name: "p-1-web", port: 1, state: "FAILED", up: false, lastError: "退出码 1" }], removed: [] });
    clock.advance(120_000);
    lsm.services.push({ full: false, services: [{ id: "ergo-daemon--p-1-web", name: "p-1-web", port: 1, state: "STOPPED", up: false }], removed: [] });
    clock.advance(120_000);
    expect(notices()).toBe(before);
    services.stop();
  });

  it("启动没起来：照上线失败记原因（同一事务通知维护者）；关闭没做成：记成关闭失败和原因，LSM 重新接上时再关", async () => {
    const lsm = fakeLsm("supported");
    const { services, want, store } = setup(lsm.services);
    services.start();
    want(true);
    await services.idle();
    services.power("p-1", "stop", "user", "k-1");
    await services.idle();

    lsm.replies.start = [{ ok: false, error: { code: "failed", message: "端口 18080 已被 node.exe (4321) 占着" } }];
    services.power("p-1", "start", "user", "k-2");
    await services.idle();
    expect(services.view()[0]).toMatchObject({ rollout: "failed", reason: "端口 18080 已被 node.exe (4321) 占着" });
    expect(services.view()[0]?.paused).toBeUndefined();
    const texts = () => store.read(maintainerChannel("pm-1"), 0, EVENT_TYPES.message).map((e) => (e.payload as MessageEventPayload).message.parts.map((p) => ("text" in p ? p.text : "")).join(""));
    expect(texts().some((t) => t.includes("没上线：端口 18080 已被 node.exe (4321) 占着"))).toBe(true);

    // 上线失败的照样能关（登记着的取消开机自启、停掉）；LSM 停不下来：关闭失败
    lsm.replies.stop = [{ ok: false, error: { code: "failed", message: "停不下来：进程不响应" } }];
    lsm.requests.length = 0;
    services.power("p-1", "stop", "user", "k-3");
    await services.idle();
    expect(of(lsm, "p-1-web")).toEqual(["autostart off", "stop force"]);
    expect(services.view()[0]).toMatchObject({ paused: true, powerReason: "停不下来：进程不响应" });
    // LSM 重新接上：再关一遍
    lsm.requests.length = 0;
    lsm.services.set("waiting");
    lsm.services.set("supported");
    await waitUntil(() => services.view()[0]?.powerReason === undefined, { describe: () => JSON.stringify(services.view()) });
    await services.idle();
    expect(of(lsm, "p-1-web")).toEqual(["autostart off", "stop force"]);
    expect(services.view()[0]).toMatchObject({ paused: true, status: "offline" });
    services.stop();
  });
});

/** 269：同一个项目里的另一个服务（没有网页） */
const other = (service: OperationService, name: string, port: number): OperationService => ({ ...service, name, app: `p-1-${name}`, port, web: undefined });
/** 269：LSM 推来的全量（应用名 → LSM 里的状态；不在里面的就是 LSM 里没有了） */
const fullOf = (lsm: ReturnType<typeof fakeLsm>, states: Record<string, string>) =>
  lsm.services.push({ full: true, services: Object.entries(states).map(([name, state]) => ({ id: `ergo-daemon--${name}`, name, port: 1, state, up: state === "RUNNING" || state === "DEGRADED" })), removed: [] });
/** 269：断了又接上（welcome 里有 services） */
const reconnect = (lsm: ReturnType<typeof fakeLsm>) => {
  lsm.services.set("waiting");
  lsm.services.set("supported");
};
/** 269：接上时兜底拉起的结果 */
const revivesOf = (store: ReturnType<typeof setup>["store"]) => store.read(OPERATIONS_CHANNEL, 0, PROJECT_SERVICE_EVENTS.rollout).map((e) => e.payload as ServiceRolloutPayload).filter((p) => p.revive === true);
/** 269：给维护者的通知 */
const noticesOf = (store: ReturnType<typeof setup>["store"]) => store.read(maintainerChannel("pm-1"), 0, EVENT_TYPES.message).map((e) => (e.payload as MessageEventPayload).message.parts.map((p) => ("text" in p ? p.text : "")).join(""));

/** 324：登记的回复（在跑的；restartNeeded 是定义变了） */
const putReply = (name: string, restartNeeded: boolean): LsmServicesReply => ({ ok: true, changed: restartNeeded, restartNeeded, service: { id: `ergo-daemon--${name}`, name, port: 1, state: "RUNNING", up: true } });

describe("接上 LSM 时重新登记在跑的（324 号票）", () => {
  it("在跑的照现在的方案整份再登记：定义变了（二狗换了 Node）LSM 回 restartNeeded 就强制重启一次，不记事件、不当挂了；没变的只登记不重启", async () => {
    const lsm = fakeLsm("supported");
    const { services, want, service, store, make } = setup(lsm.services);
    services.start();
    want(true);
    want(true, other(service, "api", 18081), "api", "api");
    await services.idle();
    const rollouts = store.read(OPERATIONS_CHANNEL, 0, PROJECT_SERVICE_EVENTS.rollout).length;

    // 二狗换了 Node 重启：起来接上 LSM，第一份全量里两个都在跑；p-1-web 的定义变了（LSM 回 restartNeeded），p-1-api 没变
    services.stop();
    lsm.services.set("waiting");
    lsm.requests.length = 0;
    const again = make({ nodePath: "D:/ergo/node26/node.exe" });
    again.start();
    lsm.services.set("supported");
    // 两个服务各排一串、谁先登记不一定：按名字回
    const original = lsm.services.put;
    lsm.services.put = async (d) => {
      await original(d);
      return putReply(d.name, d.name === "p-1-web");
    };
    fullOf(lsm, { "p-1-web": "RUNNING", "p-1-api": "RUNNING" });
    await again.idle();
    expect(of(lsm, "p-1-web")).toEqual(["put", "restart force"]);
    expect(of(lsm, "p-1-api")).toEqual(["put"]);
    expect(lsm.requests.find((r) => r.type === "put" && r.name === "p-1-web")?.definition).toMatchObject({ command: '"D:/ergo/node26/node.exe" a.mjs', autostart: true });
    expect(store.read(OPERATIONS_CHANNEL, 0, PROJECT_SERVICE_EVENTS.rollout)).toHaveLength(rollouts);
    expect(noticesOf(store)).toEqual([]);
    again.stop();
  });
});

describe("接上 LSM 时兜底（269 号票）", () => {

  it("守护进程起来、接上 LSM 后的第一份全量里停着、失败、LSM 里没有了的：整份登记、启动，记上线的结果（带 revive）；在跑、启动中、停止中的不动；接上之后再挂、又来一份全量都不拉", async () => {
    const lsm = fakeLsm("supported");
    const { services, want, service, store, make } = setup(lsm.services);
    services.start();
    want(true);
    for (const [i, name] of ["api", "gone", "up", "boot", "halt"].entries()) want(true, other(service, name, 18081 + i), name, name);
    await services.idle();
    expect(services.view().every((v) => v.rollout === "live")).toBe(true);
    expect(revivesOf(store)).toEqual([]);

    // 电脑重启：守护进程停了（LSM 没连上），起来时接入层还没连上，连上后 welcome、第一份全量
    services.stop();
    lsm.services.set("waiting");
    lsm.requests.length = 0;
    const again = make();
    again.start();
    lsm.services.set("supported");
    expect(lsm.requests).toEqual([]);
    fullOf(lsm, { "p-1-web": "STOPPED", "p-1-api": "FAILED", "p-1-up": "RUNNING", "p-1-boot": "STARTING", "p-1-halt": "STOPPING" });
    await again.idle();
    for (const app of ["p-1-web", "p-1-api", "p-1-gone"]) expect(of(lsm, app)).toEqual(["put", "start"]);
    // 324：在跑的整份再登记一次（同一份定义 LSM 不改，没回 restartNeeded 就不重启）；启动中、停止中的不动
    expect(of(lsm, "p-1-up")).toEqual(["put"]);
    for (const app of ["p-1-boot", "p-1-halt"]) expect(of(lsm, app)).toEqual([]);
    expect(lsm.requests.find((r) => r.type === "put" && r.name === "p-1-web")?.definition).toMatchObject({ name: "p-1-web", port: 18080, autostart: true });
    expect(revivesOf(store).map((p) => [p.app, p.state, p.registered, p.powerSeq]).toSorted()).toEqual([
      ["p-1-api", "live", true, 0],
      ["p-1-gone", "live", true, 0],
      ["p-1-web", "live", true, 0],
    ]);
    expect(again.ofProject("p-1").filter((v) => ["p-1-web", "p-1-api", "p-1-gone"].includes(v.app)).map((v) => [v.rollout, v.status])).toEqual([
      ["live", "online"],
      ["live", "online"],
      ["live", "online"],
    ]);

    // 接上之后又挂了：不拉（照 133 的故障通知走）；又来一份全量（没有重新接上）也不拉
    lsm.requests.length = 0;
    lsm.services.push({ full: false, services: [{ id: "ergo-daemon--p-1-web", name: "p-1-web", port: 1, state: "FAILED", up: false, lastError: "退出码 1" }], removed: [] });
    await again.idle();
    fullOf(lsm, { "p-1-web": "STOPPED", "p-1-api": "RUNNING" });
    await again.idle();
    expect(lsm.requests).toEqual([]);
    expect(again.view().find((v) => v.app === "p-1-web")).toMatchObject({ rollout: "live", status: "offline" });

    // 断了又接上：每次接上做一次，停着的再拉
    reconnect(lsm);
    fullOf(lsm, { "p-1-web": "STOPPED", "p-1-api": "RUNNING", "p-1-gone": "RUNNING", "p-1-up": "RUNNING", "p-1-boot": "RUNNING", "p-1-halt": "RUNNING" });
    await again.idle();
    // 324：在跑的整份再登记一次（同一份定义不重启）
    expect(lsm.requests.map((r) => `${r.type} ${r.name}`).toSorted()).toEqual(["put p-1-api", "put p-1-boot", "put p-1-gone", "put p-1-halt", "put p-1-up", "put p-1-web", "start p-1-web"]);
    expect(revivesOf(store)).toHaveLength(4);
    again.stop();
  });

  it("用户关着的不拉；还没做完的、要你手动的照 133 补做（不算兜底，不再拉第二遍）；关闭没做成的照 257 再关", async () => {
    const lsm = fakeLsm("supported");
    const { services, want, service, store } = setup(lsm.services);
    services.start();
    want(true);
    await services.idle();
    services.power("p-1", "stop", "user", "k-stop");
    await services.idle();
    lsm.requests.length = 0;
    reconnect(lsm);
    fullOf(lsm, { "p-1-web": "STOPPED" });
    await services.idle();
    expect(lsm.requests).toEqual([]);
    expect(services.view()[0]).toMatchObject({ paused: true, status: "offline" });
    services.power("p-1", "start", "user", "k-start");
    await services.idle();

    // LSM 版本不支持时上线的：要你手动；LSM 升级后接上，照 133 补做一遍（不另外兜底）
    lsm.services.set("unsupported");
    want(true, other(service, "api", 18081), "api", "接口");
    await services.idle();
    expect(services.view().find((v) => v.app === "p-1-api")?.rollout).toBe("manual");
    lsm.requests.length = 0;
    lsm.services.set("supported");
    fullOf(lsm, { "p-1-web": "RUNNING" });
    await services.idle();
    expect(of(lsm, "p-1-api")).toEqual(["put", "start"]);
    expect(of(lsm, "p-1-web")).toEqual(["put"]); // 324：在跑的整份再登记一次
    expect(services.view().find((v) => v.app === "p-1-api")?.rollout).toBe("live");
    expect(revivesOf(store)).toEqual([]);

    // 关闭没做成的：重新接上时照 257 再关，不拉
    lsm.replies.stop = [{ ok: false, error: { code: "failed", message: "停不下来" } }, { ok: false, error: { code: "failed", message: "停不下来" } }];
    services.power("p-1", "stop", "user", "k-stop-2");
    await services.idle();
    expect(services.view().every((v) => v.paused && v.powerReason === "停不下来")).toBe(true);
    lsm.requests.length = 0;
    reconnect(lsm);
    fullOf(lsm, { "p-1-web": "FAILED", "p-1-api": "FAILED" });
    await services.idle();
    expect(of(lsm, "p-1-web")).toEqual(["autostart off", "stop force"]);
    expect(of(lsm, "p-1-api")).toEqual(["autostart off", "stop force"]);
    expect(revivesOf(store)).toEqual([]);
    services.stop();
  });

  it("拉的时候不看挂没挂（等就绪久也不报“上线后挂了”）；拉的时候用户点了关闭：拉的结果不记，接着关掉；拉不起来：记上线失败和原因，通知维护者说是接上时拉的，下次接上不再拉", async () => {
    const lsm = fakeLsm("supported");
    const { services, want, store, clock } = setup(lsm.services);
    services.start();
    want(true);
    await services.idle();

    // 等 LSM 就绪等了两分钟：不报挂了；这期间用户点了关闭
    lsm.requests.length = 0;
    const release = lsm.holdNext("start");
    reconnect(lsm);
    fullOf(lsm, { "p-1-web": "FAILED" });
    await waitUntil(() => lsm.requests.at(-1)?.type === "start", { describe: () => JSON.stringify(lsm.requests) });
    clock.advance(120_000);
    expect(noticesOf(store)).toEqual([]);
    services.power("p-1", "stop", "user", "k-stop");
    release();
    await services.idle();
    expect(of(lsm, "p-1-web")).toEqual(["put", "start", "autostart off", "stop force"]);
    expect(revivesOf(store)).toEqual([]);
    expect(services.view()[0]).toMatchObject({ rollout: "live", paused: true, status: "offline" });
    clock.advance(120_000);
    expect(noticesOf(store)).toEqual([]);

    // 用户再启动；之后 LSM 重启了、二狗接上去拉，起不来
    services.power("p-1", "start", "user", "k-start");
    await services.idle();
    lsm.requests.length = 0;
    lsm.replies.start = [{ ok: false, error: { code: "failed", message: "端口 18080 已被 node.exe (4321) 占着" } }];
    reconnect(lsm);
    fullOf(lsm, { "p-1-web": "STOPPED" });
    await services.idle();
    expect(of(lsm, "p-1-web")).toEqual(["put", "start"]);
    expect(services.view()[0]).toMatchObject({ rollout: "failed", reason: "端口 18080 已被 node.exe (4321) 占着" });
    expect(revivesOf(store)).toEqual([expect.objectContaining({ app: "p-1-web", state: "failed", reason: "端口 18080 已被 node.exe (4321) 占着", registered: true })]);
    expect(noticesOf(store)).toHaveLength(1);
    expect(noticesOf(store)[0]).toContain("服务「网页」（p-1-web，端口 18080）本该在线（上线了、用户没关），二狗接上 LSM 时它没在跑，去拉起来没起来：端口 18080 已被 node.exe (4321) 占着");
    clock.advance(120_000);
    expect(noticesOf(store)).toHaveLength(1);

    // 下次接上：上线失败的不是"上线了"，不再拉（等用户点启动、维护者再交方案）
    lsm.requests.length = 0;
    reconnect(lsm);
    fullOf(lsm, { "p-1-web": "STOPPED" });
    await services.idle();
    expect(lsm.requests).toEqual([]);
    services.stop();
  });
});

/** 假的截图：记下截过的地址；截出来的内容依次是 jpeg-1、jpeg-2……；fail 时抛错，hold 时等测试放行 */
function fakeCapture() {
  const urls: string[] = [];
  let n = 0;
  let inFlight = 0;
  let maxInFlight = 0;
  const held: Array<() => void> = [];
  const state = { fail: false, hold: false };
  const capture = async (url: string): Promise<Buffer> => {
    urls.push(url);
    inFlight += 1;
    maxInFlight = Math.max(maxInFlight, inFlight);
    try {
      if (state.hold) await new Promise<void>((resolve) => held.push(resolve));
      if (state.fail) throw new Error("页面打不开（HTTP 502）");
      n += 1;
      return Buffer.from(`jpeg-${n}`);
    } finally {
      inFlight -= 1;
    }
  };
  return { capture, urls, state, held, max: () => maxInFlight };
}

const HOUR = 60 * 60_000;

/** 一个支持名下服务的假接入层、一个截图目录和假的截图，建在上面的 project-services */
function thumbSetup() {
  const lsm = fakeLsm("supported");
  const dir = makeTempDir("ergo-thumbs-");
  const shots = fakeCapture();
  const clock = new ManualClock(Date.parse("2026-10-18T09:00:00+08:00"));
  const base = setup(lsm.services, clock, { thumbnails: { dir, capture: shots.capture, baseUrl: () => "http://127.0.0.1:9999" } });
  const push = (state: string, full = false, app = "p-1-web") => lsm.services.push({ full, services: [{ id: `ergo-daemon--${app}`, name: app, port: 18080, state, up: state === "RUNNING" }], removed: [] });
  const file = (app = "p-1-web") => fs.readFileSync(path.join(dir, `${app}.jpg`), "utf8");
  return { ...base, lsm, dir, shots, push, file };
}

describe("服务首页的缩略图（140 号票）", () => {

  it("上线并在线后截一次（经二狗本机端口的转发）；6 小时内有人看不重截，过了 6 小时有人看补一张；重启了（离上一张 10 分钟以上）、改了方案重截；不在线的不截", async () => {
    const { services, want, shots, push, clock, store, published, file } = thumbSetup();
    services.start();
    want(true);
    await services.idle();
    expect(shots.urls).toEqual(["http://127.0.0.1:9999/apps/p-1-web/"]);
    const first = services.view()[0]!.thumbnailAt!;
    expect(first).toBeDefined();
    expect(file()).toBe("jpeg-1");
    expect(published.at(-1)?.[0]?.thumbnailAt).toBe(first);
    expect(services.thumbnail("p-1", "web")).toEqual({ file: expect.stringContaining("p-1-web.jpg"), takenAt: first });

    // 6 小时内有人看：给现在这张，不重截
    clock.advance(5 * HOUR);
    services.thumbnail("p-1", "web");
    await services.idle();
    expect(shots.urls).toHaveLength(1);
    // 过了 6 小时有人看：先给现在这张，补一张；截图时间换了、推一次新的样子
    clock.advance(HOUR);
    expect(services.thumbnail("p-1", "web")?.takenAt).toBe(first);
    await services.idle();
    expect(shots.urls).toHaveLength(2);
    expect(file()).toBe("jpeg-2");
    expect(services.view()[0]!.thumbnailAt).not.toBe(first);
    expect(published.at(-1)?.[0]?.thumbnailAt).toBe(services.view()[0]!.thumbnailAt);

    // 接上 LSM 时的第一份全量不算重启；重启了但离上一张不到 10 分钟：不截
    push("RUNNING", true);
    push("STOPPED");
    push("RUNNING");
    await services.idle();
    expect(shots.urls).toHaveLength(2);
    // 10 分钟以后再重启：重截
    clock.advance(11 * 60_000);
    push("STARTING");
    push("RUNNING");
    await services.idle();
    expect(shots.urls).toHaveLength(3);

    // 确认了这个项目的新一份运营方案：马上重截（不看隔多久）
    const decided: OperationsDecidedPayload = { projectId: "p-1", projectName: "简报站", revision: 2, via: "change", cardId: "c-9", confirmed: true, results: [], summary: "", by: "user", time: nowIso() };
    store.append({ channel: OPERATIONS_CHANNEL, type: OPERATIONS_EVENTS.decided, payload: decided });
    await services.idle();
    expect(shots.urls).toHaveLength(4);
    // 拒绝了的不截
    store.append({ channel: OPERATIONS_CHANNEL, type: OPERATIONS_EVENTS.decided, payload: { ...decided, revision: 3, confirmed: false } });
    await services.idle();
    expect(shots.urls).toHaveLength(4);

    // 不在线：过了 6 小时有人看也不截，给的还是上一张
    push("FAILED");
    clock.advance(7 * HOUR);
    expect(services.thumbnail("p-1", "web")?.takenAt).toBe(services.view()[0]!.thumbnailAt);
    await services.idle();
    expect(shots.urls).toHaveLength(4);
    // 没有这个服务、项目编号对不上的：没有
    expect(services.thumbnail("p-1", "nope")).toBeUndefined();
    expect(services.thumbnail("p-2", "web")).toBeUndefined();
    services.stop();
  });

  it("截不了的留着上一张，有人看时半小时内不再试；没有上一张的不给截图时间；上线时还没在线的等在线再截；守护进程起来时不一口气截，截图时间从缓存区读回来", async () => {
    const { services, want, shots, push, clock, lsm, file, make } = thumbSetup();
    services.start();
    // 上线时 LSM 说还在启动：先不截，在线了再截
    lsm.replies.start = [{ ok: true, service: { id: "ergo-daemon--p-1-web", name: "p-1-web", port: 18080, state: "STARTING", up: false } }];
    shots.state.fail = true;
    want(true);
    await services.idle();
    expect(shots.urls).toEqual([]);
    push("RUNNING");
    await services.idle();
    // 截不成：没有上一张，不给截图时间
    expect(shots.urls).toHaveLength(1);
    expect(services.view()[0]!.thumbnailAt).toBeUndefined();
    // 有人看：半小时内不再试，过了再试
    services.thumbnail("p-1", "web");
    await services.idle();
    expect(shots.urls).toHaveLength(1);
    clock.advance(31 * 60_000);
    shots.state.fail = false;
    services.thumbnail("p-1", "web");
    await services.idle();
    expect(shots.urls).toHaveLength(2);
    const taken = services.view()[0]!.thumbnailAt;
    expect(taken).toBeDefined();
    expect(file()).toBe("jpeg-1");
    // 之后截不成：留着上一张
    shots.state.fail = true;
    clock.advance(7 * HOUR);
    services.thumbnail("p-1", "web");
    await services.idle();
    expect(shots.urls).toHaveLength(3);
    expect(services.view()[0]!.thumbnailAt).toBe(taken);
    expect(file()).toBe("jpeg-1");

    // 守护进程重启：LSM 推来全量的在线不截；截图时间从缓存区读回来
    services.stop();
    const again = make();
    again.start();
    push("RUNNING", true);
    await again.idle();
    expect(shots.urls).toHaveLength(3);
    expect(again.view()[0]!.thumbnailAt).toBe(taken);
    again.stop();
  });

  it("同时只截一个：几个服务一起上线排着队一个一个截；删除项目时缩略图一起删掉", async () => {
    const { services, want, shots, store, dir, service } = thumbSetup();
    services.start();
    shots.state.hold = true;
    want(true);
    want(true, { ...service, name: "api", app: "p-1-api", port: 18081 });
    await waitUntil(() => shots.urls.length === 1, { describe: () => `截过的：${shots.urls.join("、")}` });
    // 第一张没截完，第二个还排着
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(shots.urls).toHaveLength(1);
    shots.state.hold = false;
    for (const go of shots.held.splice(0)) go();
    await services.idle();
    expect(shots.urls.toSorted()).toEqual(["http://127.0.0.1:9999/apps/p-1-api/", "http://127.0.0.1:9999/apps/p-1-web/"]);
    expect(shots.max()).toBe(1);
    expect(fs.readdirSync(dir).toSorted()).toEqual(["p-1-api.jpg", "p-1-api.json", "p-1-web.jpg", "p-1-web.json"]);

    // 删除项目：缩略图一起删掉
    const project: Project = { id: "p-1", name: "简报站", goal: "g", state: "archived", origin: "suggestion", maintainerId: "pm-1", workdir: { external: false }, charterConfirmed: true, createdAt: nowIso(), updatedAt: nowIso() };
    store.append({ channel: CHANNELS.projects, type: EVENT_TYPES.project, payload: { project, change: "deleted", from: "archived", by: "user" } satisfies ProjectEventPayload });
    expect(fs.readdirSync(dir)).toEqual([]);
    services.stop();
  });

  it("怎么截：1280×800 排版、0.5 倍出图、JPEG；页面打不开（状态码 ≥ 400、没有响应）的算没截成", async () => {
    const browser = new FakeBrowser((url) => (url.endsWith("/apps/p-1-web/") ? { status: 200, title: "简报站" } : url.endsWith("/apps/p-1-down/") ? { status: 502 } : undefined));
    expect((await captureServiceHome(browser, "http://127.0.0.1:9999/apps/p-1-web/")).toString()).toBe("fake-jpeg page q70");
    expect(browser.launches[0]).toMatchObject({ viewport: SERVICE_THUMBNAIL_VIEWPORT, deviceScaleFactor: SERVICE_THUMBNAIL_SCALE });
    expect(SERVICE_THUMBNAIL_VIEWPORT.width * SERVICE_THUMBNAIL_SCALE).toBe(640);
    await expect(captureServiceHome(browser, "http://127.0.0.1:9999/apps/p-1-down/")).rejects.toThrow("页面打不开（HTTP 502）");
    await expect(captureServiceHome(browser, "http://127.0.0.1:9999/apps/nope/")).rejects.toThrow("net::ERR_NAME_NOT_RESOLVED");
  });
});
