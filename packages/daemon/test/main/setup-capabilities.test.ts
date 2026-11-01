// 主切面：向导"能力"那一步要的接口，真的守护进程走 HTTP。全在临时目录、系统挑的端口上，下载是本机的假下载站，计划任务是假任务（一个 JSON 文件）：
// - GET / PUT /api/autostart：开机自启的开关（装好的能开能关；源码跑的只显示；指着别处的不动；参数不对 400）；跑完核对真的计划任务一个字没变；
// - 向导第③步换成能力（没有条件，要用户看过才算做完）：新数据目录向量模型装好了也不跳过；老数据目录当时走完的不再看到引导条；
// - POST /api/components check_updates：有新版本只显示、不下载、不换；点了更新才换；没查成是 200，不进待办；发布页上还没有清单（404）不算没查成；
// - 每晚的作业：登记在内部作业上；查到新版本在待办放一条提醒（同一版本一次），换上后自动归档；断网不进待办。
import fs from "node:fs";
import path from "node:path";
import { type AutostartView, type ComponentsView, HTTP_PATHS, type HttpErrorBody, type InboxItem, type SetupView } from "@ergo/protocol";
import { beforeAll, describe, expect, it } from "vitest";
import { readFakeTask } from "../../src/cli/autostart.ts";
import { COMPONENT_UPDATE_JOB, createHttpTransport, LATEST_MANIFEST_NAME, parseManifest } from "../../src/components/index.ts";
import { sign } from "../../src/release/minisign.ts";
import type { InstallLayout } from "../../src/release/layout.ts";
import { startTestDaemon } from "../helpers/daemon.ts";
import { blob, type FakeDownloads, sha256, startFakeDownloads } from "../helpers/fake-downloads.ts";
import { releaseKey } from "../helpers/fake-release.ts";
import { requestJson, setupApi } from "../helpers/http.ts";
import { realAutostartTaskDefinition } from "../helpers/real-autostart-task.ts";
import { makeTempDir } from "../helpers/temp-dir.ts";

let realTaskBefore = "";
beforeAll(() => {
  realTaskBefore = realAutostartTaskDefinition();
});

const autostart = (url: string, enabled?: boolean) =>
  enabled === undefined ? requestJson<AutostartView & HttpErrorBody>(url, HTTP_PATHS.autostart) : requestJson<AutostartView & HttpErrorBody>(url, HTTP_PATHS.autostart, { method: "PUT", body: { enabled } });

function installedLayout(): { layout: InstallLayout; dir: string } {
  const dir = makeTempDir("ergo-install-");
  const home = path.join(dir, "versions", "0.1.0");
  return { dir, layout: { kind: "installed", root: dir, home, appDir: path.join(home, "app"), node: path.join(home, "node", "node.exe") } };
}

describe("开机自启的接口", () => {
  it("装好的：开、关都走假任务，状态跟着变；参数不对 400，不动任务", { timeout: 60_000 }, async () => {
    const { layout, dir } = installedLayout();
    const taskFile = path.join(dir, "task.json");
    const svc = path.join(dir, "svc");
    const td = await startTestDaemon({ installLayout: layout, env: { ERGO_AUTOSTART_TASK_FILE: taskFile, LSM_DATA_DIR: svc, ERGO_SVC_PORT: "17421" } });
    expect((await autostart(td.url)).body).toEqual({ state: "off", managerUrl: "http://127.0.0.1:17421" });
    const on = await autostart(td.url, true);
    expect(on.status).toBe(200);
    expect(on.body.state).toBe("on");
    expect(readFakeTask(taskFile).action).toContain(svc);
    expect((await autostart(td.url, false)).body.state).toBe("off");
    expect(readFakeTask(taskFile).calls).toEqual(["install-autostart", "uninstall-autostart"]);

    const bad = await requestJson<HttpErrorBody>(td.url, HTTP_PATHS.autostart, { method: "PUT", body: { enabled: "yes" } });
    expect(bad.status).toBe(400);
    expect(readFakeTask(taskFile).calls).toHaveLength(2);
  });

  it("注册失败、指着别处：回 400 和原因；源码跑的（测试默认的）：只显示，不能改", { timeout: 60_000 }, async () => {
    const { layout, dir } = installedLayout();
    const taskFile = path.join(dir, "task.json");
    const td = await startTestDaemon({ installLayout: layout, env: { ERGO_AUTOSTART_TASK_FILE: taskFile, LSM_DATA_DIR: path.join(dir, "svc") } });
    fs.writeFileSync(taskFile, JSON.stringify({ failInstall: true }));
    const refused = await autostart(td.url, true);
    expect(refused.status).toBe(400);
    expect(refused.body.message).toContain("fake task refused");

    const action = 'conhost.exe --headless "D:\\tools\\node.exe" "D:\\my\\supervisor\\bin\\lsm.mjs" serve';
    fs.writeFileSync(taskFile, JSON.stringify({ action }));
    expect((await autostart(td.url)).body.state).toBe("elsewhere");
    expect((await autostart(td.url, false)).status).toBe(400);
    expect(readFakeTask(taskFile)).toEqual({ action });

    const dev = await startTestDaemon({ env: { ERGO_AUTOSTART_TASK_FILE: path.join(dir, "dev-task.json"), LSM_DATA_DIR: path.join(dir, "svc2") } });
    const view = await autostart(dev.url);
    expect(view.body.state).toBe("off");
    expect(view.body.cannotChange).toContain("ergo svc");
    expect((await autostart(dev.url, true)).status).toBe(400);
    expect(readFakeTask(path.join(dir, "dev-task.json")).calls).toBeUndefined();
  });

  it("上面跑了这么多次开关，真的计划任务一个字没变", { timeout: 120_000 }, () => {
    expect(realAutostartTaskDefinition()).toBe(realTaskBefore);
  });
});

describe("向导的能力那一步", () => {
  const capabilitiesOf = (view: SetupView) => view.steps.find((step) => step.id === "capabilities");
  const OTHERS = ["language", "model", "phone"] as const;

  it("新数据目录：向量模型装好了、别的都做完，能力还是要看过才算；不会被自动跳过", { timeout: 60_000 }, async () => {
    const fake = await startFakeDownloads();
    const td = await startTestDaemon({
      fresh: true,
      env: { DEEPSEEK_API_KEY: undefined },
      components: { manifest: { signed: false, manifest: parseManifest({ format: 1, release: "0.1.0", components: [entry(fake, "v1", "v1.bin", blob(30_000, 73))] }) }, transport: createHttpTransport() },
    });
    expect(capabilitiesOf((await setupApi.view(td.url)).body)).toEqual({ id: "capabilities", done: false, ready: false, optional: true });

    expect((await requestJson(td.url, HTTP_PATHS.component("bge-m3"), { method: "POST", body: { action: "install" } })).status).toBe(200);
    await td.daemon.components.whenIdle();
    expect(td.daemon.components.view().features.find((f) => f.feature === "memory.semantic")?.ready).toBe(true);
    for (const step of OTHERS) await setupApi.mark(td.url, { step, skip: true });
    const almost = await setupApi.mark(td.url, { step: "safety" });
    expect(capabilitiesOf(almost.body)).toEqual({ id: "capabilities", done: false, ready: false, optional: true });
    expect(almost.body.complete).toBe(false);

    const marked = await setupApi.mark(td.url, { step: "capabilities" });
    expect(capabilitiesOf(marked.body)).toEqual({ id: "capabilities", done: true, ready: false, optional: true });
    expect(marked.body.complete).toBe(true);
  });

  it("老数据目录：以前走完向导的（第③步是组件，点过以后再说）算能力看过了，complete 是 true，引导条不回来；写回配置", { timeout: 60_000 }, async () => {
    const td = await startTestDaemon({ env: { DEEPSEEK_API_KEY: undefined }, config: { setup: { format: 1, skipped: ["language", "model", "components", "phone"], done: ["safety"] } } });
    const view = await setupApi.view(td.url);
    expect(view.body.complete).toBe(true);
    expect(capabilitiesOf(view.body)).toEqual({ id: "capabilities", done: true, ready: false, optional: true });
    expect(JSON.parse(fs.readFileSync(path.join(td.dataDir, "config", "ergo.json"), "utf8"))).toMatchObject({ setup: { format: 2, skipped: ["language", "model", "phone"], done: ["safety", "capabilities"] } });
  });

  it("老数据目录当时没走完（safety 没看）：能力照样要看", { timeout: 60_000 }, async () => {
    const td = await startTestDaemon({ env: { DEEPSEEK_API_KEY: undefined }, config: { setup: { format: 1, skipped: ["language", "model", "components", "phone"], done: [] } } });
    const view = await setupApi.view(td.url);
    expect(view.body.complete).toBe(false);
    expect(capabilitiesOf(view.body)?.done).toBe(false);
  });
});

function entry(fake: FakeDownloads, version: string, file: string, body: Buffer) {
  fake.put(file, body);
  return {
    id: "bge-m3",
    version,
    default: "install",
    enables: ["memory.semantic"],
    target: "models/Xenova/bge-m3",
    sources: [{ id: "a", title: "镜像 A", url: fake.source("a") }],
    variants: [{ id: "q8", parts: [{ files: [{ path: file, size: body.length, sha256: sha256(body) }] }] }],
  };
}
const check = (url: string) => requestJson<ComponentsView & HttpErrorBody>(url, HTTP_PATHS.components, { method: "POST", body: { action: "check_updates" } });
const one = (view: ComponentsView) => view.components.find((c) => c.id === "bge-m3")!;

describe("查更新", () => {
  const V1 = blob(30_000, 71);
  const V2 = blob(40_000, 72);
  const key = releaseKey();

  /** 发布页上放一份新清单（假下载站的 release 这个"镜像"下面，发布地址就是它） */
  function publish(fake: FakeDownloads) {
    const bytes = Buffer.from(JSON.stringify({ format: 1, release: "9.9.9", components: [entry(fake, "v2", "v2.bin", V2)] }));
    fake.put(LATEST_MANIFEST_NAME, bytes);
    fake.put(`${LATEST_MANIFEST_NAME}.minisig`, sign(bytes, key.secret, { fileName: LATEST_MANIFEST_NAME, trustedComment: "t" }));
  }

  const start = async (fake: FakeDownloads, env: Record<string, string> = {}) =>
    startTestDaemon({
      env: { ERGO_RELEASE_URL: `${fake.url}/release`, ERGO_RELEASE_PUBKEY: key.publicLine, ...env },
      components: { manifest: { signed: false, manifest: parseManifest({ format: 1, release: "0.1.0", components: [entry(fake, "v1", "v1.bin", V1)] }) }, transport: createHttpTransport() },
    });
  const install = async (td: Awaited<ReturnType<typeof start>>) => {
    expect((await requestJson(td.url, HTTP_PATHS.component("bge-m3"), { method: "POST", body: { action: "install" } })).status).toBe(200);
    await td.daemon.components.whenIdle();
  };
  const reminders = (td: Awaited<ReturnType<typeof start>>) => td.daemon.inbox.list().filter((item: InboxItem) => item.kind === "notice" && item.notice === "component_update_available");

  it("点检查更新：有新版本只显示、不换；点了更新才换；请求体不对 400", { timeout: 60_000 }, async () => {
    const fake = await startFakeDownloads();
    const td = await start(fake);
    await install(td);
    publish(fake);
    const checked = await check(td.url);
    expect(checked.status).toBe(200);
    expect(checked.body.updates).toMatchObject({ where: `${fake.url}/release/${LATEST_MANIFEST_NAME}`, available: ["bge-m3"] });
    expect(one(checked.body)).toMatchObject({ state: "update", version: "v2", installedVersion: "v1" });
    expect(fake.requests.some((q) => q.path === "v2.bin")).toBe(false);
    const dir = path.join(td.dataDir, "models", "Xenova", "bge-m3");
    expect(fs.existsSync(path.join(dir, "v1.bin"))).toBe(true);
    // 手动查不进待办：人就在页面上
    expect(reminders(td)).toEqual([]);

    await requestJson(td.url, HTTP_PATHS.component("bge-m3"), { method: "POST", body: { action: "update" } });
    await td.daemon.components.whenIdle();
    expect(fs.existsSync(path.join(dir, "v2.bin"))).toBe(true);
    expect((await requestJson<ComponentsView>(td.url, HTTP_PATHS.components)).body.updates?.available).toEqual([]);

    expect((await requestJson(td.url, HTTP_PATHS.components, { method: "POST", body: { action: "explode" } })).status).toBe(400);
  });

  it("断网：接口还是 200，只写原因；每晚的作业也不进待办", { timeout: 60_000 }, async () => {
    const fake = await startFakeDownloads();
    // 发布地址指到一个没人听的端口
    const td = await start(fake, { ERGO_RELEASE_URL: "http://127.0.0.1:1/release" });
    await install(td);
    const checked = await check(td.url);
    expect(checked.status).toBe(200);
    expect(checked.body.updates?.error).toBeTruthy();
    expect(one(checked.body).state).toBe("installed");
    await td.daemon.componentUpdates.nightly();
    expect(reminders(td)).toEqual([]);
    // 组件照常
    expect(one(td.daemon.components.view()).state).toBe("installed");
  });

  it("发布页上还没有这份清单（404）：接口 200，不算没查成，不进待办", { timeout: 60_000 }, async () => {
    const fake = await startFakeDownloads();
    const td = await start(fake);
    await install(td);
    const checked = await check(td.url);
    expect(checked.status).toBe(200);
    expect(checked.body.updates).toMatchObject({ notPublished: true, available: [] });
    expect(checked.body.updates?.error).toBeUndefined();
    await td.daemon.componentUpdates.nightly();
    expect(reminders(td)).toEqual([]);
    expect(one(td.daemon.components.view()).state).toBe("installed");
  });

  it("每晚的作业：登记在内部作业上；有新版本放一条提醒（同一版本一次），换上后自动归档；没装的不提醒", { timeout: 60_000 }, async () => {
    const fake = await startFakeDownloads();
    const td = await start(fake);
    expect(td.daemon.scheduler.pending().some((p: { key: string }) => p.key === `internal:${COMPONENT_UPDATE_JOB}`)).toBe(true);

    await install(td);
    publish(fake);
    await td.daemon.componentUpdates.nightly();
    const [reminder, ...others] = reminders(td);
    expect(others).toEqual([]);
    expect(reminder).toMatchObject({ urgency: "non_blocking", actions: ["去更新组件", "知道了"], data: { components: [{ id: "bge-m3", version: "v2" }] } });
    expect(reminder?.kind === "notice" && reminder.title).toContain("有新版本");
    // 还在提醒着、再查一遍：不再来一条；没动过文件
    await td.daemon.componentUpdates.nightly();
    expect(reminders(td)).toHaveLength(1);
    expect(one(td.daemon.components.view())).toMatchObject({ state: "update", installedVersion: "v1" });

    await requestJson(td.url, HTTP_PATHS.component("bge-m3"), { method: "POST", body: { action: "update" } });
    await td.daemon.components.whenIdle();
    expect(reminders(td)[0]?.archived).toBe(true);
  });

  it("没装的组件查到新版本不提醒：点安装时装的就是新的", { timeout: 60_000 }, async () => {
    const fake = await startFakeDownloads();
    const td = await start(fake);
    publish(fake);
    await td.daemon.componentUpdates.nightly();
    expect(reminders(td)).toEqual([]);
    await install(td);
    expect(one(td.daemon.components.view())).toMatchObject({ state: "installed", version: "v2", installedVersion: "v2" });
    expect(reminders(td)).toEqual([]);
  });
});
