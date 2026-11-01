// 主切面：体检的接口（319b）——GET /api/doctor 回八项检查（顺序照共享协议包的 DOCTOR_CHECKS），
// 每项有 id、ok、结构化的事实，健康时没有"怎么修"、不健康时给的是文案键（doctor.fix.*，网页按当前语言取）。
// 数据目录是临时目录、两个端口是系统挑的（不碰真的 8810 / 8811、不碰真的 ~/.ergo）：磁盘那项报得出数据目录所在卷的数；
// 这个临时数据目录里没装组件、没配 key、临时程序目录里没有 lsm.mjs，所以对应的三项是坏的，报的仍是查出来的事实。
import fs from "node:fs";
import path from "node:path";
import { CHANNELS, DOCTOR_CHECKS, type DoctorCheckView } from "@ergo/protocol";
import { describe, expect, it } from "vitest";
import { startTestDaemon } from "../helpers/daemon.ts";
import { pairDevice } from "../helpers/device.ts";
import { TestFrontend } from "../helpers/frontend.ts";
import { doctorApi } from "../helpers/http.ts";
import { makeTempDir } from "../helpers/temp-dir.ts";

const idOf = (checks: readonly DoctorCheckView[], id: string) => checks.find((check) => check.id === id)!;

describe("体检的接口（319b）", () => {
  it("GET /api/doctor：八项都在、顺序照协议包，每项有 id、ok、事实；健康项没有修法，坏项给的是文案键", { timeout: 60_000 }, async () => {
    const td = await startTestDaemon({ env: { DEEPSEEK_API_KEY: undefined } });
    const res = await doctorApi.view(td.url);
    expect(res.status).toBe(200);
    expect(res.body.checks.map((check) => check.id)).toEqual([...DOCTOR_CHECKS]);
    expect(res.body.checks).toHaveLength(DOCTOR_CHECKS.length);
    // 查的时刻是 ISO（刚刚）
    expect(Number.isNaN(Date.parse(res.body.at))).toBe(false);
    expect(Math.abs(Date.parse(res.body.at) - Date.now())).toBeLessThan(60_000);
    // 每项都有 id、布尔 ok、一份事实
    expect(res.body.checks.filter((check) => typeof check.ok !== "boolean")).toEqual([]);
    expect(res.body.checks.filter((check) => typeof check.data !== "object")).toEqual([]);
    // 健康时没有"怎么修"；不健康时给的是文案键，不是拼好的句子
    expect(res.body.checks.filter((check) => check.ok && check.fix !== undefined)).toEqual([]);
    expect(res.body.checks.filter((check) => !check.ok && !/^doctor\.fix\.[a-z]+$/.test(check.fix ?? "")).map((check) => check.id)).toEqual([]);
  });

  it("各项查出来的事实：端口就是网关实际监听的那两个（都通）、Node 版本对、磁盘报临时数据目录所在卷、服务管家和外网入口都是这个临时环境的样子", { timeout: 60_000 }, async () => {
    const td = await startTestDaemon({ env: { DEEPSEEK_API_KEY: undefined } });
    const checks = (await doctorApi.view(td.url)).body.checks;

    // 端口：网关的两个端口（系统挑的）都在听、是二狗自己
    expect(idOf(checks, "ports")).toEqual({
      id: "ports",
      ok: true,
      data: { local: Number(new URL(td.url).port), external: Number(new URL(td.externalUrl).port), localUp: true, externalUp: true },
    });
    // Node：跑的这个（去掉 v），和 ADR-0031 那条线
    expect(idOf(checks, "node")).toEqual({ id: "node", ok: true, data: { running: process.version.replace(/^v/, ""), expected: "22" } });

    // 磁盘：临时数据目录所在卷，剩多少、一共多少都是数
    const disk = idOf(checks, "disk");
    expect(disk.data).toMatchObject({ path: td.dataDir });
    expect(fs.existsSync((disk.data as { path: string }).path)).toBe(true);
    expect((disk.data as { totalGb: number }).totalGb).toBeGreaterThan(0);
    expect((disk.data as { freeGb: number }).freeGb).toBeGreaterThanOrEqual(0);
    expect(disk.ok).toBe((disk.data as { freeGb: number }).freeGb > 1);

    // pi：临时程序目录里没有 node_modules，读不到版本（不是体检自己查不了：修法是"去装依赖"）
    expect(idOf(checks, "pi")).toEqual({ id: "pi", ok: false, data: {}, fix: "doctor.fix.pi" });
    // 服务管家：临时程序目录里没有 lsm.mjs，当没回应；manager.yaml 也没有，所以不带端口
    expect(idOf(checks, "supervisor")).toEqual({ id: "supervisor", ok: false, data: { running: false }, fix: "doctor.fix.supervisor" });
    // 外网入口：服务管家里没登记、也没有配对设备（网页写"没登记"，不断言"没配"）
    expect(idOf(checks, "external")).toEqual({ id: "external", ok: false, data: { configured: false }, fix: "doctor.fix.external" });
    // 模型的 key：没配
    expect(idOf(checks, "model")).toEqual({ id: "model", ok: false, data: { configured: false }, fix: "doctor.fix.model" });

    // 组件：照清单的默认该装、现在还不能用的那几个（临时数据目录里一个组件都没装）
    const components = idOf(checks, "components");
    const missing = (components.data as { missing: string[] }).missing;
    expect(Array.isArray(missing)).toBe(true);
    expect(components.ok).toBe(missing.length === 0);
  });

  it("每次现算：再查一遍拿到的是新的一份（时刻往后走）；配好模型 key 之后模型那项就变好了", { timeout: 60_000 }, async () => {
    const td = await startTestDaemon({ env: { DEEPSEEK_API_KEY: "test-doctor-key-abcdefghij" } });
    const first = await doctorApi.view(td.url);
    expect(idOf(first.body.checks, "model")).toEqual({ id: "model", ok: true, data: { configured: true } });
    const second = await doctorApi.view(td.url);
    expect(Date.parse(second.body.at)).toBeGreaterThanOrEqual(Date.parse(first.body.at));
    expect(second.body.checks.map((check) => check.id)).toEqual(first.body.checks.map((check) => check.id));
  });

  it("外网入口：配对过的设备算依据，吊销了的不算（用不上了）", { timeout: 60_000 }, async () => {
    const td = await startTestDaemon({ env: { DEEPSEEK_API_KEY: undefined } });
    const external = async () => idOf((await doctorApi.view(td.url)).body.checks, "external");
    expect(await external()).toEqual({ id: "external", ok: false, data: { configured: false }, fix: "doctor.fix.external" });

    const pc = await TestFrontend.connect(td.url);
    await pc.subscribe({ [CHANNELS.cards]: 0, [CHANNELS.inbox]: 0 });
    await pairDevice(td.externalUrl, pc, { name: "手机" });
    await pairDevice(td.externalUrl, pc, { name: "平板" });
    expect(await external()).toEqual({ id: "external", ok: true, data: { configured: true, kind: "paired", devices: 2 } });

    const [phone, tablet] = td.daemon.pairing.list();
    td.daemon.pairing.revoke(phone!.id, "doctor-revoke-phone");
    expect(await external()).toEqual({ id: "external", ok: true, data: { configured: true, kind: "paired", devices: 1 } });
    td.daemon.pairing.revoke(tablet!.id, "doctor-revoke-tablet");
    expect(await external()).toEqual({ id: "external", ok: false, data: { configured: false }, fix: "doctor.fix.external" });
  });

  it("外网入口：读的是 LSM_DATA_DIR 指的服务管家目录（管理器带 --data-dir 跑在别处时，登记里要声明它）", { timeout: 60_000 }, async () => {
    const svc = makeTempDir("ergo-doctor-svc-");
    fs.mkdirSync(path.join(svc, "registry"), { recursive: true });
    fs.writeFileSync(path.join(svc, "registry", "tailnet.yaml"), "entries:\n  - id: ergo-daemon\n    name: ergo\n");
    const td = await startTestDaemon({ env: { DEEPSEEK_API_KEY: undefined, LSM_DATA_DIR: svc } });
    expect(idOf((await doctorApi.view(td.url)).body.checks, "external")).toEqual({ id: "external", ok: true, data: { configured: true, kind: "tailscale" } });
  });

  it("只认 GET：POST /api/doctor 回 405；路径不对回 404", { timeout: 60_000 }, async () => {
    const td = await startTestDaemon({ env: { DEEPSEEK_API_KEY: undefined } });
    const posted = await fetch(`${td.url}/api/doctor`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    expect(posted.status).toBe(405);
    expect((await fetch(`${td.url}/api/doctor/extra`)).status).toBe(404);
  });
});
