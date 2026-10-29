// 主切面：项目的服务首页的缩略图（140 号票）。真的守护进程，LSM 用替身（helpers/lsm-stand-in.ts 的 owned：支持名下服务的新管理器，
// 不起真进程），"上线的服务"是随机端口上的假服务（helpers/fake-app.ts），截图注入假的（不起浏览器，测试照着守护进程给的地址取一遍页面，
// 核对截的是经二狗本机端口转发的首页），测试扮演前端和一台外网设备。
// - 服务上线并在线后守护进程截一张：截图时间带在项目的服务上推给前端；
// - 取图的接口按项目编号和服务名给 JPEG（每次都问一声换没换：no-cache + ETag 是截图时间，没换回 304）；没有的 404；
// - 和别的接口一样只有已配对的设备能取：外网端口上没配对的 401，配对了的能取。
import fs from "node:fs";
import path from "node:path";
import { CHANNELS, EVENT_TYPES, HTTP_PATHS, nowIso, type ProjectServicesEventPayload } from "@ergo/protocol";
import { describe, expect, it } from "vitest";
import { OPERATIONS_CHANNEL } from "../../src/operations/events.ts";
import { PROJECT_SERVICE_EVENTS, type ServiceDesiredPayload } from "../../src/project-services/index.ts";
import { startTestDaemon } from "../helpers/daemon.ts";
import { pairDevice, TestDevice } from "../helpers/device.ts";
import { startFakeApp } from "../helpers/fake-app.ts";
import { TestFrontend } from "../helpers/frontend.ts";
import { request } from "../helpers/http.ts";
import { startLsmStandIn } from "../helpers/lsm-stand-in.ts";
import { waitUntil } from "../helpers/process.ts";
import { seedProject } from "../helpers/projects.ts";

const { cards: CARDS, projects: PROJECTS } = CHANNELS;

describe("项目的服务首页的缩略图", () => {
  it("上线并在线后截一张（经二狗本机端口转发的首页），截图时间推给前端；取图的接口给 JPEG、没换回 304、没有的 404；外网端口上只有配对了的设备能取", async () => {
    const lsm = await startLsmStandIn({ owned: true, heartbeatIntervalMs: 60_000 });
    const app = await startFakeApp();
    // 假的截图：照给的地址取一遍页面（核对是经二狗转发的首页），回一段假的 JPEG
    const shot: { url?: string; page?: string } = {};
    const td = await startTestDaemon({
      env: lsm.env,
      serviceThumbnail: async (url) => {
        shot.url = url;
        shot.page = await (await fetch(url)).text();
        return Buffer.from("FAKE-JPEG 简报站");
      },
    });
    await lsm.waitFor((m) => m.type === "hello", "握手");
    const frontend = await TestFrontend.connect(td.url);
    await frontend.subscribe({ [PROJECTS]: 0, [CARDS]: 0 });
    seedProject(td.daemon, "AI 简报站", { state: "in_use", charterConfirmed: true, kind: "other" });
    const cwd = path.join(td.dataDir, "projects", "p-1", "workdir");
    fs.mkdirSync(cwd, { recursive: true });
    const desired: ServiceDesiredPayload = {
      projectId: "p-1",
      key: "site",
      title: "简报站",
      app: "p-1-site",
      present: true,
      service: { name: "site", app: "p-1-site", command: "node server.mjs", cwd, env: [], port: app.port, autostart: true, autoRestart: false, web: { home: "/", prefix: "strip" } },
      why: "confirmed",
      time: nowIso(),
    };
    td.daemon.store.append({ channel: OPERATIONS_CHANNEL, type: PROJECT_SERVICE_EVENTS.desired, payload: desired });

    // 上线、在线之后截了一张：截的是经二狗本机端口转发的首页；截图时间推给前端
    await waitUntil(() => td.daemon.projectServices.view()[0]?.thumbnailAt !== undefined, { timeoutMs: 20_000, describe: () => JSON.stringify(td.daemon.projectServices.view()) });
    expect(shot.url).toBe(`${td.url}/apps/p-1-site/`);
    expect(shot.page).toContain("简报站首页");
    const takenAt = td.daemon.projectServices.view()[0]!.thumbnailAt!;
    await waitUntil(
      () => frontend.events({ channel: PROJECTS, type: EVENT_TYPES.projectServices }).some((f) => (f.payload as ProjectServicesEventPayload).services.some((v) => v.app === "p-1-site" && v.thumbnailAt === takenAt)),
      { describe: () => "前端收到带截图时间的服务" },
    );

    // 取图：本机端口直接给；JPEG、每次都问一声（no-cache），ETag 是截图时间；没换回 304
    const got = await request(td.url, HTTP_PATHS.serviceThumbnail("p-1", "site", { at: takenAt }));
    expect(got.status).toBe(200);
    expect(got.headers["content-type"]).toBe("image/jpeg");
    expect(got.headers["cache-control"]).toBe("private, no-cache");
    expect(got.headers.etag).toBe(`"${takenAt}"`);
    expect(got.body.toString("utf8")).toBe("FAKE-JPEG 简报站");
    expect((await request(td.url, HTTP_PATHS.serviceThumbnail("p-1", "site"), { headers: { "If-None-Match": `"${takenAt}"` } })).status).toBe(304);
    // 没有的服务、没有的项目：404
    const missing = await request(td.url, HTTP_PATHS.serviceThumbnail("p-1", "nope"));
    expect(missing.status).toBe(404);
    expect(JSON.parse(missing.body.toString("utf8"))).toMatchObject({ code: "not_found" });
    expect((await request(td.url, HTTP_PATHS.serviceThumbnail("p-9", "site"))).status).toBe(404);

    // 外网端口：没配对的设备取不到，配对了的能取
    const stranger = new TestDevice(td.externalUrl);
    expect((await stranger.request(HTTP_PATHS.serviceThumbnail("p-1", "site"))).status).toBe(401);
    const phone = await pairDevice(td.externalUrl, frontend);
    const viaPhone = await phone.request(HTTP_PATHS.serviceThumbnail("p-1", "site", { at: takenAt }));
    expect(viaPhone.status).toBe(200);
    expect(viaPhone.body).toBe("FAKE-JPEG 简报站");
  }, 90_000);
});
