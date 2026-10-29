// 体检（319 号票的 319b，src/doctor/doctor.ts）：八项检查各一个"好的"和一个"坏的"（注入假的探测器），
// 一项抛错只算这一项查不了、别的项照常，查的时刻来自注入的钟；正式用的那几个探测器（端口、pi 版本、服务管家的端口、
// 外网入口配没配、组件缺不缺、磁盘）也单独查一遍——端口用系统挑的临时端口（不碰真的 8810 / 8811），
// 文件都是临时目录里的（不碰真的 ~/.ergo、不碰真的服务管家）。
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { DOCTOR_CHECKS, DOCTOR_FIX_UNKNOWN, type ComponentsView, type DoctorCheckDataById, type DoctorCheckId, type DoctorView } from "@ergo/protocol";
import { describe, expect, it, onTestFinished } from "vitest";
import {
  createDoctor,
  diskProbe,
  externalProbe,
  managerPort,
  missingDefaultFeatures,
  nodeProbe,
  piVersionProbe,
  portsProbe,
  type DoctorProbes,
  supervisorProbe,
  SUPERVISOR_PROBE_TIMEOUT_MS,
} from "../../src/doctor/doctor.ts";
import { makeTempDir } from "../helpers/temp-dir.ts";
import { freePort } from "../helpers/ports.ts";

type Data = { [Id in DoctorCheckId]: DoctorCheckDataById[Id] };

/** 八项都健康时各查出来的 */
const GOOD: Data = {
  ports: { local: 8810, external: 8811, localUp: true, externalUp: true },
  node: { running: "22.23.4", expected: "22" },
  pi: { version: "1.0.4" },
  supervisor: { running: true, port: 7420 },
  model: { configured: true },
  components: { missing: [] },
  disk: { freeGb: 120.5, totalGb: 476.8, path: "C:\\Users\\someone\\.ergo" },
  external: { configured: true, kind: "tailscale" },
};

/** 八项各自坏了时查出来的（每一份只坏这一项） */
const BAD: Data = {
  ports: { local: 8810, external: 8811, localUp: true, externalUp: false },
  node: { running: "24.1.0", expected: "22" },
  pi: {},
  supervisor: { running: false },
  model: { configured: false },
  components: { missing: ["memory.semantic"] },
  disk: { freeGb: 0.8, totalGb: 476.8, path: "C:\\Users\\someone\\.ergo" },
  external: { configured: false },
};

/** 假的探测器：不给的照 GOOD 回；overrides 里写的那几项换掉（抛错的写一个 throw 的函数） */
function fakeProbes(overrides: Partial<Record<DoctorCheckId, () => unknown>> = {}): DoctorProbes {
  const probes = Object.fromEntries(DOCTOR_CHECKS.map((id) => [id, overrides[id] ?? (() => GOOD[id])])) as DoctorProbes;
  return probes;
}

/** 只坏这一项 */
const onlyBad = (id: DoctorCheckId) => fakeProbes({ [id]: () => BAD[id] });

const checkOf = (view: DoctorView, id: DoctorCheckId) => view.checks.find((check) => check.id === id)!;

/** 在系统挑的一个端口上听一会儿（本文件的两个用例共用）；用例结束时关掉 */
async function hold(port: number): Promise<void> {
  const server = net.createServer();
  await new Promise<void>((resolve) => server.listen(port, "127.0.0.1", resolve));
  onTestFinished(() => new Promise<void>((resolve) => server.close(() => resolve())));
}

describe("八项：好的", () => {
  it.each([...DOCTOR_CHECKS])("%s：好的时候 ok，没有'怎么修'", async (id) => {
    const view = await createDoctor({ probes: fakeProbes() }).view();
    expect(view.checks.map((check) => check.id)).toEqual([...DOCTOR_CHECKS]);
    expect(view.checks.every((check) => check.ok)).toBe(true);
    expect(view.checks.every((check) => check.fix === undefined)).toBe(true);
    expect(checkOf(view, id)).toEqual({ id, ok: true, data: GOOD[id] });
  });
});

describe("八项：坏的", () => {
  it.each([...DOCTOR_CHECKS])("%s：坏的时候不 ok，data 是查出来的事实，fix 是这一项的修法，别的七项照旧好", async (id) => {
    const view = await createDoctor({ probes: onlyBad(id) }).view();
    const broken = checkOf(view, id);
    expect(broken).toEqual({ id, ok: false, data: BAD[id], fix: `doctor.fix.${id}` });
    // 别的七项照旧好（一条断言里比，别在循环里各 expect 一次）
    expect(DOCTOR_CHECKS.filter((check) => check !== id).filter((other) => !checkOf(view, other).ok)).toEqual([]);
  });
});

describe("一项查不了不影响别的项", () => {
  it("探测器抛错的那一项：ok: false、fix 是 doctor.fix.retry（网页写'这次没查出来'）、data 是这一项的空值", async () => {
    const view = await createDoctor({
      probes: fakeProbes({
        ports: () => {
          throw new Error("端口探不了");
        },
        disk: () => Promise.reject(new Error("磁盘读不了")),
      }),
    }).view();
    expect(checkOf(view, "ports")).toEqual({ id: "ports", ok: false, data: { local: 0, external: 0, localUp: false, externalUp: false }, fix: DOCTOR_FIX_UNKNOWN });
    expect(checkOf(view, "disk")).toEqual({ id: "disk", ok: false, data: { freeGb: 0, totalGb: 0, path: "" }, fix: DOCTOR_FIX_UNKNOWN });
    // 别的六项照常查出来
    expect(view.checks.filter((check) => check.ok).map((check) => check.id)).toEqual(["node", "pi", "supervisor", "model", "components", "external"]);
  });

  it("查的时刻来自注入的钟（ISO），每次现算：第二次查到的换成新的数据", async () => {
    let free = GOOD.disk.freeGb;
    const probes = fakeProbes({ disk: () => ({ ...GOOD.disk, freeGb: free }) });
    const doctor = createDoctor({ probes, now: () => Date.parse("2026-10-28T09:30:00.000Z") });
    const first = await doctor.view();
    expect(first.at).toBe("2026-10-28T09:30:00.000Z");
    free = 0.5;
    const second = await doctor.view();
    expect(checkOf(second, "disk")).toMatchObject({ ok: false, data: { freeGb: 0.5 }, fix: "doctor.fix.disk" });
    expect(checkOf(first, "disk").ok).toBe(true);
  });
});

describe("正式用的探测器", () => {
  it("Node：现在跑的这个去掉 v，和 ADR-0031 那条线（22）", () => {
    expect(nodeProbe()).toEqual({ running: process.version.replace(/^v/, ""), expected: "22" });
    expect(nodeProbe().running).toMatch(/^\d+\./);
  });

  it("端口：两个都在听、而且是这个进程自己（系统挑的临时端口，不碰真的 8810 / 8811）；没人听的是 false", async () => {
    const [local, external, dead] = await Promise.all([freePort(), freePort(), freePort()]);
    await hold(local);
    await hold(external);
    expect(await portsProbe(() => ({ local, external }))()).toEqual({ local, external, localUp: true, externalUp: true });
    // 外网端口上没人听：这一项就不健康
    expect(await portsProbe(() => ({ local, external: dead }))()).toMatchObject({ local, external: dead, localUp: true, externalUp: false });
  });

  it("pi 的版本：读得到就有，文件不在（依赖没装）就没有——不是体检自己查不了", () => {
    const dir = makeTempDir("ergo-doctor-pi-");
    expect(piVersionProbe(path.join(dir, "package.json"))()).toEqual({});
    fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: ["@earendil", "works", "pi-coding-agent"].join("/"), version: "1.2.3" }));
    expect(piVersionProbe(path.join(dir, "package.json"))()).toEqual({ version: "1.2.3" });
    fs.writeFileSync(path.join(dir, "package.json"), "{oops");
    expect(piVersionProbe(path.join(dir, "package.json"))()).toEqual({});
  });

  it("服务管家的端口从 manager.yaml 读；命令行起不来（没有 lsm.mjs）、超时都是没回应", async () => {
    const dir = makeTempDir("ergo-doctor-svc-");
    fs.mkdirSync(path.join(dir, "registry"), { recursive: true });
    fs.writeFileSync(path.join(dir, "registry", "manager.yaml"), "bind: 127.0.0.1\nport: 7420\n");
    expect(managerPort(path.join(dir, "registry", "manager.yaml"))).toBe(7420);
    expect(managerPort(path.join(dir, "registry", "nope.yaml"))).toBeUndefined();

    // 脚本不在：起不来，当没回应，但端口照样报出来
    const missing = supervisorProbe({ node: process.execPath, script: path.join(dir, "lsm.mjs"), dataDir: dir, timeoutMs: 2_000 });
    expect(await missing()).toEqual({ running: false, port: 7420 });

    // 脚本回一段 JSON：有回应
    fs.writeFileSync(path.join(dir, "lsm.mjs"), 'console.log(JSON.stringify({ services: [] }));\n');
    expect(await supervisorProbe({ node: process.execPath, script: path.join(dir, "lsm.mjs"), dataDir: dir, timeoutMs: SUPERVISOR_PROBE_TIMEOUT_MS })()).toEqual({ running: true, port: 7420 });

    // 回了但不是 JSON：当没回应
    fs.writeFileSync(path.join(dir, "lsm.mjs"), 'console.log("not json");\n');
    expect((await supervisorProbe({ node: process.execPath, script: path.join(dir, "lsm.mjs"), dataDir: dir, timeoutMs: 2_000 })()).running).toBe(false);
  });

  it("外网入口：tailnet 清单里有二狗那一项就是配了（自建 headscale 的报 headscale，否则是 Tailscale），登记里的 exposure.via 是隧道，都没有是没配", () => {
    const dir = makeTempDir("ergo-doctor-svc-");
    const registry = path.join(dir, "registry");
    fs.mkdirSync(path.join(registry, "services"), { recursive: true });
    expect(externalProbe({ svcDataDir: dir })()).toEqual({ configured: false });

    fs.writeFileSync(path.join(registry, "services", "ergo-daemon.yaml"), "id: ergo-daemon\nexposure:\n  via: ergo-tunnel\n  remotePort: 18811\n");
    expect(externalProbe({ svcDataDir: dir })()).toEqual({ configured: true, kind: "tunnel" });

    fs.writeFileSync(path.join(registry, "tailnet.yaml"), "entries:\n  - id: ergo-daemon\n    name: ergo\n  - id: other\n    name: other\n");
    expect(externalProbe({ svcDataDir: dir })()).toEqual({ configured: true, kind: "tailscale" });
    fs.writeFileSync(path.join(dir, "vps-setup.json"), JSON.stringify({ version: 1, modes: { headscale: { host: "vps" } } }));
    expect(externalProbe({ svcDataDir: dir })()).toEqual({ configured: true, kind: "headscale" });
    // 别的服务的 tailnet 项不算二狗的
    fs.writeFileSync(path.join(registry, "tailnet.yaml"), "entries:\n  - id: something-else\n    name: other\n");
    expect(externalProbe({ svcDataDir: dir })()).toEqual({ configured: true, kind: "tunnel" });
  });

  it("磁盘：临时目录所在的卷报得出剩多少、一共多少、是哪个目录", () => {
    const dir = makeTempDir("ergo-doctor-disk-");
    const data = diskProbe(dir)();
    expect(data.path).toBe(dir);
    expect(data.totalGb).toBeGreaterThan(0);
    expect(data.freeGb).toBeGreaterThanOrEqual(0);
    expect(data.freeGb).toBeLessThanOrEqual(data.totalGb + 0.1);
  });

  it("组件缺不缺：清单里默认该装（default: install）的那个组件的功能没就绪才算缺；问过再装、检测到才装的不算", () => {
    const view: ComponentsView = {
      components: [
        { id: "bge-m3", default: "install", enables: [{ id: "memory.semantic", title: "按意思检索素材" }] },
        { id: "asr", default: "ask", enables: [{ id: "voice.input", title: "按住说话" }] },
        { id: "claude-code", default: "detected", enables: [{ id: "runtime.claude-code", title: "用 Claude Code 做任务" }] },
      ] as unknown as ComponentsView["components"],
      features: [
        { feature: "memory.semantic", component: "bge-m3", title: "向量模型 bge-m3", ready: false },
        { feature: "voice.input", component: "asr", title: "语音识别", ready: false },
        { feature: "runtime.claude-code", component: "claude-code", title: "Claude Code 接入", ready: false },
      ],
      manifest: { release: "0.2.1", signed: false },
      defaultsMissing: ["bge-m3"],
    };
    // 只有默认该装的 bge-m3 没装：缺 memory.semantic，别的两项不算
    expect(missingDefaultFeatures(view)).toEqual(["memory.semantic"]);
    expect(missingDefaultFeatures({ ...view, features: view.features.map((gate) => ({ ...gate, ready: true })) })).toEqual([]);
  });
});
