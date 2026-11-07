// 接入层（lsm/link.ts）的管理指令（协议 §9，418）：对 LSM 替身（helpers/lsm-stand-in.ts，不连真的服务管家）走一遍。
// - welcome 里有 manage 才算支持；老管理器（没有）一条都不发、回"不支持"；没注入身份的回"没接入"；
// - 每个方法发对消息（manage.<名字>、自己编的 id、全名、mode / force / on / decision / lines / source / tailnetName），等 manage.reply；
// - 和名下服务的请求共用一张在途表：回复按 id 认，乱序到也对得上；
// - 断线时在途的回"断了"；restartSelf 拿到回复就返回，之后管理器发来的 restart（when-idle）照现有的停机处理应答。
import { describe, expect, it, onTestFinished } from "vitest";
import { DISABLED_LSM_MANAGE, type LsmLink, linkToLsm } from "../../src/lsm/link.ts";
import { type LinkMessage, startLsmStandIn, type StandInManage } from "../helpers/lsm-stand-in.ts";
import { waitUntil } from "../helpers/process.ts";

/** 接上替身，等到 welcome 之后（管理指令的支持定下来） */
async function linked(manage?: StandInManage, extra: { owned?: boolean } = {}) {
  const lsm = await startLsmStandIn({ heartbeatIntervalMs: 60_000, ...(manage ? { manage } : {}), ...extra });
  const shutdowns: string[] = [];
  const link: LsmLink = linkToLsm({
    env: lsm.env,
    port: 1,
    version: "test",
    busy: () => ({ busy: false }),
    health: () => "ok",
    onShutdown: async () => void shutdowns.push("shutdown"),
    onConflict: () => {},
    log: () => {},
  });
  onTestFinished(() => link.close());
  await waitUntil(() => link.manage.support !== "waiting", { timeoutMs: 10_000, describe: () => `管理指令的支持：${link.manage.support}` });
  return { lsm, link, shutdowns };
}

describe("接入层的管理指令", () => {
  it("没注入身份：一律回没接入", async () => {
    expect(DISABLED_LSM_MANAGE.support).toBe("disabled");
    const link = linkToLsm({ env: {}, port: 1, version: "test", busy: () => ({ busy: false }), health: () => "ok", onShutdown: async () => {}, onConflict: () => {}, log: () => {} });
    expect(await link.manage.list()).toEqual({ ok: false, error: { code: "not-linked", message: "二狗没有接入服务管家（不是由服务管家启动的）" } });
    expect(await link.manage.restartSelf()).toMatchObject({ ok: false, error: { code: "not-linked" } });
  });

  it("老管理器（welcome 里没有 manage）：不发，回不支持", async () => {
    const t = await linked(undefined, { owned: true });
    expect(t.link.manage.support).toBe("unsupported");
    expect(await t.link.manage.stop("comfyui", { force: true })).toEqual({ ok: false, error: { code: "unsupported", message: "这个版本的服务管家不支持管理指令" } });
    expect(t.lsm.messages.some((m) => m.message.type.startsWith("manage."))).toBe(false);
  });

  it("每个方法发对消息、拿回复", async () => {
    const replies: Record<string, Record<string, unknown>> = {
      "manage.list": { ok: true, self: "ergo-daemon", services: [{ id: "comfyui", state: "RUNNING" }], profiles: { gpu: ["comfyui"] }, lifeline: [{ id: "ergo-daemon", why: ["调用方自己"] }] },
      "manage.logs": { ok: true, name: "comfyui", source: 1, label: "server", lines: "a\nb", capped: false, sources: [] },
    };
    const t = await linked((m) => replies[m.type] ?? { ok: true, echo: m.type });
    const { manage } = t.link;
    expect(manage.support).toBe("supported");
    expect(await manage.list()).toEqual(replies["manage.list"]);
    expect(await manage.logs("comfyui", { lines: 20, source: 1 })).toEqual(replies["manage.logs"]);
    await manage.logs("comfyui");
    await manage.start("comfyui");
    await manage.stop("comfyui");
    await manage.stop("comfyui", { mode: "when-idle" });
    await manage.stop("comfyui", { force: true });
    await manage.restart("comfyui", { force: true });
    await manage.cancelStop("comfyui");
    await manage.autostart("comfyui", false);
    await manage.profileStart("gpu");
    await manage.profileStop("gpu", { force: true });
    await manage.exposeOn("web");
    await manage.exposeOff("web");
    await manage.tailnetOpen("web", "brief");
    await manage.tailnetOpen("web");
    await manage.tailnetClose("web");
    await manage.remove("ergo-daemon--p-1-web");
    await manage.orphan("web", "kill");
    expect(await manage.restartSelf()).toEqual({ ok: true, echo: "manage.restartSelf" });
    const sent = t.lsm.messages.map((m) => m.message).filter((m) => m.type.startsWith("manage."));
    // 每条带自己编的 id（不重）
    expect(new Set(sent.map((m) => m.id)).size).toBe(sent.length);
    expect(sent.map(({ id: _id, ...rest }) => rest)).toEqual([
      { type: "manage.list" },
      { type: "manage.logs", name: "comfyui", lines: 20, source: 1 },
      { type: "manage.logs", name: "comfyui" },
      { type: "manage.start", name: "comfyui" },
      { type: "manage.stop", name: "comfyui", mode: "now", force: false },
      { type: "manage.stop", name: "comfyui", mode: "when-idle", force: false },
      { type: "manage.stop", name: "comfyui", mode: "now", force: true },
      { type: "manage.restart", name: "comfyui", force: true },
      { type: "manage.cancelStop", name: "comfyui" },
      { type: "manage.autostart", name: "comfyui", on: false },
      { type: "manage.profileStart", profile: "gpu" },
      { type: "manage.profileStop", profile: "gpu", force: true },
      { type: "manage.exposeOn", name: "web" },
      { type: "manage.exposeOff", name: "web" },
      { type: "manage.tailnetOpen", name: "web", tailnetName: "brief" },
      { type: "manage.tailnetOpen", name: "web" },
      { type: "manage.tailnetClose", name: "web" },
      { type: "manage.remove", name: "ergo-daemon--p-1-web" },
      { type: "manage.orphan", name: "web", decision: "kill" },
      { type: "manage.restartSelf", mode: "when-idle" },
    ]);
  });

  it("和名下服务的请求共用在途表：回复按 id 认，后发的先回也对得上", async () => {
    let releaseSlow: (() => void) | undefined;
    const t = await linked(
      (m) =>
        m.type === "manage.start"
          ? new Promise<Record<string, unknown>>((resolve) => {
              releaseSlow = () => resolve({ ok: true, which: "start" });
            })
          : { ok: true, which: m.type },
      { owned: true },
    );
    const slow = t.link.manage.start("comfyui");
    await waitUntil(() => releaseSlow !== undefined, { timeoutMs: 5_000, describe: () => "替身收到 start" });
    expect(await t.link.manage.list()).toEqual({ ok: true, which: "manage.list" });
    expect(await t.link.services.list()).toMatchObject({ ok: true, services: [] });
    releaseSlow!();
    expect(await slow).toEqual({ ok: true, which: "start" });
  });

  it("断线时在途的回断了；重连后照常", async () => {
    let gotStop = false;
    const t = await linked((m) => {
      if (m.type === "manage.stop") {
        gotStop = true;
        return undefined;
      }
      return { ok: true };
    });
    const pending = t.link.manage.stop("comfyui", { force: true });
    await waitUntil(() => gotStop, { timeoutMs: 5_000, describe: () => "替身收到 stop" });
    t.lsm.drop();
    expect(await pending).toMatchObject({ ok: false, error: { code: "disconnected" } });
    await waitUntil(() => t.link.manage.support === "supported" && t.lsm.connections >= 2, { timeoutMs: 15_000, describe: () => "重连" });
    expect(await t.link.manage.list()).toEqual({ ok: true });
  });

  it("restartSelf：拿到已排队就返回；之后管理器发来的 restart（when-idle）照现有的停机处理：应答、不忙就停", async () => {
    const holder: { lsm?: Awaited<ReturnType<typeof startLsmStandIn>> } = {};
    const t = await linked((m: LinkMessage) => {
      if (m.type !== "manage.restartSelf") return { ok: true };
      // 回复发出之后才发重启指令（和真的服务管家一样）
      setTimeout(() => holder.lsm?.send({ type: "restart", id: "cmd-r", mode: "when-idle", deadlineMs: 3_600_000 }), 0);
      return { ok: true, queued: true, note: "已排队" };
    });
    holder.lsm = t.lsm;
    expect(await t.link.manage.restartSelf()).toEqual({ ok: true, queued: true, note: "已排队" });
    expect(await t.lsm.waitFor((m) => m.type === "ack" && m.id === "cmd-r", "重启指令的应答")).toMatchObject({ ok: true });
    await waitUntil(() => t.shutdowns.length === 1, { timeoutMs: 5_000, describe: () => "不忙：停机" });
  });
});
