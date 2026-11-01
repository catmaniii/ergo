// 二狗的接入层（lsm/link.ts）对真的服务管家（packages/supervisor 的 Supervisor + 接入层）走一遍"指向自己的入口"（协议 §8）。
//
// 安全措施：服务管家的注册表、账本都在临时目录（LSM_DATA_DIR，模块加载前就设好）；端口全是临时挑的；不调 refresh，不起任何进程，
// 不碰真的服务管家（7420）和真的二狗（8810、8811）。
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createConnectionAddresses } from "../../src/pairing/addresses.ts";
import { linkToLsm } from "../../src/lsm/link.ts";
import { waitUntil } from "../helpers/process.ts";

const freePort = () =>
  new Promise<number>((resolve, reject) => {
    const s = net.createServer();
    s.on("error", reject);
    s.listen(0, "127.0.0.1", () => {
      const { port } = s.address() as net.AddressInfo;
      s.close(() => resolve(port));
    });
  });

describe("真的服务管家", () => {
  const DATA = fs.mkdtempSync(path.join(os.tmpdir(), "ergo-entries-real-"));
  const saved = { dir: process.env.LSM_DATA_DIR, quiet: process.env.LSM_QUIET };
  let server: http.Server;
  let linkSrv: { handleUpgrade(req: unknown, socket: unknown, head: unknown): void; close(): void };
  let sup: { st(id: string): { linkToken?: string }; emit(event: string, ...args: unknown[]): void; exposureChecks?: Map<string, unknown> };
  let MGR = 0;
  let LOCAL = 0;
  let EXTERNAL = 0;

  beforeAll(async () => {
    process.env.LSM_DATA_DIR = DATA;
    process.env.LSM_QUIET = "1";
    [MGR, LOCAL, EXTERNAL] = await Promise.all([freePort(), freePort(), freePort()]);
    if ([MGR, LOCAL, EXTERNAL].some((port) => [7420, 8810, 8811].includes(port))) throw new Error("临时挑的端口撞上了真的服务管家或二狗");
    const REG = path.join(DATA, "registry");
    fs.mkdirSync(path.join(REG, "services"), { recursive: true });
    fs.writeFileSync(
      path.join(REG, "manager.yaml"),
      ["bind: 127.0.0.1", `port: ${MGR}`, "probeIntervalMs: 5000", "autoResolveConflicts: false", "sentinels:", "  port: false", "  scheduledTask: false", "tailnet:", "  domain: tail.example.test", "  gateway: tail-gw", ""].join("\n"),
    );
    const root = `root: ${JSON.stringify(DATA)}`;
    fs.writeFileSync(path.join(REG, "services", "tail-gw.yaml"), ["id: tail-gw", root, "kind: managed", "probe:", "  tier: port", `  port: ${await freePort()}`, "hooks:", "  start:", "    cmd: node -e 0", "    detaches: false", ""].join("\n"));
    fs.writeFileSync(
      path.join(REG, "services", "ergo-tunnel.yaml"),
      ["id: ergo-tunnel", root, "kind: managed", "role: tunnel", "probe:", "  tier: process", "  matchCmd: x", "hooks:", "  start:", "    argv:", "      - ssh", "      - -R", `      - 127.0.0.1:18811:127.0.0.1:${EXTERNAL}`, "      - u@vps.example.test", "    detaches: false", ""].join("\n"),
    );
    // 手写的示例就是这样：探活是本机端口，exposure 没写 localPort；tailnet 入口因此接到了本机端口（要进 wrongPort）
    fs.writeFileSync(
      path.join(REG, "services", "ergo-daemon.yaml"),
      ["id: ergo-daemon", root, "kind: managed", "probe:", "  tier: port", `  port: ${LOCAL}`, "hooks:", "  start:", "    cmd: node -e 0", "    detaches: false", "link:", "  enabled: true", "exposure:", "  via: ergo-tunnel", "  remotePort: 18811", "  publicUrl: https://ergo.example.test/", "  check: true", ""].join("\n"),
    );
    fs.writeFileSync(path.join(REG, "tailnet.yaml"), "entries:\n  - id: ergo-daemon\n    name: ergo\n");

    const supervisorSrc = new URL("../../../supervisor/src/", import.meta.url).href;
    const { Supervisor } = (await import(/* @vite-ignore */ `${supervisorSrc}supervisor.mjs`)) as { Supervisor: new () => typeof sup & { registryErrors: string[]; link?: unknown } };
    const { attachLink } = (await import(/* @vite-ignore */ `${supervisorSrc}link.mjs`)) as { attachLink(s: unknown): typeof linkSrv };
    const instance = new Supervisor();
    if (instance.registryErrors.length > 0) throw new Error(`临时注册表不对：${instance.registryErrors.join("；")}`);
    sup = instance;
    linkSrv = attachLink(instance);
    instance.link = linkSrv;
    server = http.createServer((_req, res) => {
      res.writeHead(404);
      res.end();
    });
    server.on("upgrade", (req, socket, head) => linkSrv.handleUpgrade(req, socket, head));
    await new Promise<void>((resolve) => server.listen(MGR, "127.0.0.1", resolve));
    sup.st("ergo-daemon").linkToken = "tok";
  });

  afterAll(async () => {
    linkSrv?.close();
    if (server) await new Promise((resolve) => server.close(resolve));
    if (saved.dir === undefined) delete process.env.LSM_DATA_DIR;
    else process.env.LSM_DATA_DIR = saved.dir;
    if (saved.quiet === undefined) delete process.env.LSM_QUIET;
    else process.env.LSM_QUIET = saved.quiet;
    try {
      fs.rmSync(DATA, { recursive: true, force: true });
    } catch {
      // Windows 上偶尔还占着；临时目录，不要紧
    }
  });

  it("接入 → 拿到入口：隧道的 -R 接外网端口算数，tailnet 接本机端口不给并写日志；实测变了推过来；管理器的网页地址也知道", async () => {
    const lines: string[] = [];
    const link = linkToLsm({
      env: { LSM_URL: `ws://127.0.0.1:${MGR}/link`, LSM_SERVICE_ID: "ergo-daemon", LSM_TOKEN: "tok", LSM_PROTOCOL: "1" },
      port: LOCAL,
      externalPort: EXTERNAL,
      version: "test",
      busy: () => ({ busy: false }),
      health: () => "ok",
      onShutdown: async () => {},
      onConflict: () => {},
      log: () => {},
    });
    const addresses = createConnectionAddresses({ manual: undefined, save: () => {}, log: (line) => lines.push(line) });
    const detach = addresses.attach({ entries: link.entries, managerUrl: link.managerUrl, externalPort: EXTERNAL });
    try {
      await waitUntil(() => addresses.view().addresses.length === 1);
      expect(addresses.view()).toEqual({
        addresses: [{ kind: "public", url: "https://ergo.example.test/", reachable: null }],
        manager: "supported",
        managerUrl: `http://127.0.0.1:${MGR}/`,
        rejected: [{ kind: "tailnet", url: "https://ergo.tail.example.test/", reason: "wrong_port", port: LOCAL }],
      });
      expect(lines.join("\n")).toContain("https://ergo.tail.example.test/");

      // 慢周期打了一遍：通了
      sup.exposureChecks = new Map([["ergo-daemon", { ok: true, status: 200, checkedAt: Date.now() }]]);
      sup.emit("refresh", {});
      await waitUntil(() => addresses.view().addresses[0]?.reachable === true);
    } finally {
      detach();
      link.close();
    }
  });
});
