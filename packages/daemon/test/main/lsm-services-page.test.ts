// 主切面：设置 · 服务（428）。真的守护进程，服务管家是替身（helpers/lsm-stand-in.ts：welcome 带 manage，管理指令按剧本回；
// 不连真的服务管家、不起任何服务）。经 HTTP 接口走一遍网页要的三件事：
// - GET /api/managed-services：替身的列表里混着和二狗无关的 drama-server、画图，回的只有和二狗有关的，二狗自己带着受保护；
// - POST /api/managed-services/<id>：停二狗自己在本地就拒了（一条停的指令都没发）；没有正常停止办法的语音合成直接强制停；
//   不是和二狗有关的回 not-related、不发指令；请求体不对回 400；
// - GET /api/managed-services/<id>/logs：截短、擦掉像密钥的。
// 没接入服务管家的守护进程（测试平常的样子）：列表写 disabled，操作回 not-linked。
import type { ManagedServiceActionResult, ManagedServiceLogsView, ManagedServicesView } from "@ergo/protocol";
import { HTTP_PATHS } from "@ergo/protocol";
import { describe, expect, it } from "vitest";
import type { LsmManagedService } from "../../src/lsm/link.ts";
import { startTestDaemon } from "../helpers/daemon.ts";
import { fakeSecret } from "../helpers/fake-secrets.ts";
import { requestJson } from "../helpers/http.ts";
import { type LinkMessage, startLsmStandIn } from "../helpers/lsm-stand-in.ts";

const service = (id: string, extra: Partial<LsmManagedService> = {}): LsmManagedService => ({
  id,
  title: id,
  port: null,
  state: "RUNNING",
  up: true,
  autostart: false,
  capabilities: ["start", "stop"],
  protected: false,
  protectedWhy: [],
  ...extra,
});
const SERVICES = [
  service("drama-server", { title: "短剧站", port: 13000 }),
  service("ergo-daemon", { title: "二狗", capabilities: ["start", "busy", "stop", "restart", "health"], protected: true, protectedWhy: ["调用方自己"] }),
  service("comfyui", { title: "画图", port: 18188 }),
  // 二狗名下的语音合成：没有停机钩子、也没接入（不带 force 停它回 no-capability）
  service("ergo-daemon--audiocpp", { title: "语音合成", port: 18090, capabilities: ["start", "health"], autostart: true }),
];

async function standIn() {
  const key = fakeSecret("sk-", "c".repeat(32));
  const lsm = await startLsmStandIn({
    heartbeatIntervalMs: 60_000,
    manage: (m: LinkMessage) => {
      if (m.type === "manage.list") return { ok: true, self: "ergo-daemon", services: SERVICES, profiles: {}, lifeline: [{ id: "ergo-daemon", why: ["调用方自己"] }], tailnetGateway: null };
      if (m.type === "manage.stop") {
        const target = SERVICES.find((s) => s.id === m.name)!;
        if (!target.capabilities.includes("stop") && m.force !== true) return { ok: false, error: { code: "no-capability", message: `${target.id} 没有停机能力。要停就带 force: true` } };
        return { ok: true, service: { ...target, state: "STOPPED", up: false } };
      }
      if (m.type === "manage.logs") return { ok: true, name: m.name, source: 0, label: "命令行输出", lines: `ready\nkey=${key}\n`, capped: false, sources: [{ source: 0, label: "命令行输出" }] };
      return { ok: false, error: { code: "bad-request", message: `剧本里没有 ${m.type}` } };
    },
  });
  return { lsm, key };
}

const manageSent = (messages: ReadonlyArray<{ message: LinkMessage }>) =>
  messages
    .map((m) => m.message)
    .filter((m) => m.type.startsWith("manage.") && m.type !== "manage.list")
    .map(({ id: _id, ...rest }) => rest);

describe("设置 · 服务（经接口）", () => {
  it("只列和二狗有关的；停二狗自己本地就拒、没有正常停止办法的直接强制停、无关的不认；日志擦掉像密钥的", async () => {
    const { lsm, key } = await standIn();
    const td = await startTestDaemon({ env: lsm.env });
    await lsm.waitFor((m) => m.type === "hello", "握手");
    // welcome 收到之前列表写 waiting：等到 supported
    let view: ManagedServicesView | undefined;
    for (const deadline = Date.now() + 10_000; ; ) {
      view = (await requestJson<ManagedServicesView>(td.url, HTTP_PATHS.managedServices)).body;
      if (view.support === "supported" || Date.now() > deadline) break;
      await new Promise((r) => setTimeout(r, 50));
    }
    expect(view!.support).toBe("supported");
    expect(view!.services.map((s) => [s.id, s.uses])).toEqual([
      ["ergo-daemon", ["self"]],
      ["ergo-daemon--audiocpp", ["owned"]],
    ]);
    expect(view!.services[0]!.protection).toEqual({ kind: "self", why: ["调用方自己"] });
    expect(view!.managerUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+\//);

    const act = async (id: string, body: unknown) => requestJson<ManagedServiceActionResult>(td.url, HTTP_PATHS.managedService(id), { method: "POST", body });
    expect((await act("ergo-daemon", { action: "stop" })).body).toMatchObject({ ok: false, action: "stop", code: "protected" });
    expect((await act("drama-server", { action: "stop" })).body).toMatchObject({ ok: false, code: "not-related" });
    expect((await act("ergo-daemon--audiocpp", { action: "stop" })).body).toMatchObject({ ok: true, action: "stop", forced: true, service: { id: "ergo-daemon--audiocpp", state: "STOPPED" } });
    expect((await act("ergo-daemon--audiocpp", { action: "explode" })).status).toBe(400);
    // 二狗自己、drama-server 一条停的指令都没发；语音合成先普通停、再强制停
    expect(manageSent(lsm.messages)).toEqual([
      { type: "manage.stop", name: "ergo-daemon--audiocpp", mode: "now", force: false },
      { type: "manage.stop", name: "ergo-daemon--audiocpp", mode: "now", force: true },
    ]);

    const logs = (await requestJson<ManagedServiceLogsView>(td.url, HTTP_PATHS.managedServiceLogs("ergo-daemon--audiocpp", { lines: 20 }))).body;
    expect(logs).toMatchObject({ ok: true, id: "ergo-daemon--audiocpp", label: "命令行输出", cut: false });
    if (!logs.ok) throw new Error("应当成功");
    expect(logs.lines[0]).toBe("ready");
    expect(logs.lines.join("\n")).not.toContain(key);
    expect(manageSent(lsm.messages).at(-1)).toEqual({ type: "manage.logs", name: "ergo-daemon--audiocpp", lines: 20 });
    expect((await requestJson(td.url, `${HTTP_PATHS.managedServiceLogs("ergo-daemon--audiocpp")}?lines=abc`)).status).toBe(400);
  });

  it("没接入服务管家（不是它拉起来的）：列表写 disabled，操作回 not-linked", async () => {
    const td = await startTestDaemon();
    expect((await requestJson<ManagedServicesView>(td.url, HTTP_PATHS.managedServices)).body).toMatchObject({ support: "disabled", services: [] });
    expect((await requestJson<ManagedServiceActionResult>(td.url, HTTP_PATHS.managedService("ergo-daemon"), { method: "POST", body: { action: "start" } })).body).toMatchObject({ ok: false, code: "not-linked" });
  });
});
