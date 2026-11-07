// 设置 · 服务（lsm/services-page.ts，428）：用假的管理指令（不连任何服务管家）走列表、操作、日志。
// - 只列和二狗有关的：假列表里混着 drama-server、别的项目和它们的隧道，一个都不出现；五条规则各认得出；
// - 受保护的（二狗自己、它的外网隧道、tailnet 网关、服务管家说二狗离不开的）停止、强制停、重启、关开机自启本地先拒，一条指令都不发；
//   启动、开开机自启、看日志照常；服务管家回 protected 照实转；
// - 没有正常停止 / 重启办法的：先发普通的，服务管家回 no-capability 再发强制的，结果写 forced；有办法的照常、不改强制；
// - 不是和二狗有关的 id：操作、日志都回 not-related，不发指令；
// - 没接入、没连上、服务管家太老、取列表失败照实说；日志截短、擦掉像密钥的。
import { describe, expect, it } from "vitest";
import type { LsmManage, LsmManagedService, LsmManageReply } from "../../src/lsm/link.ts";
import { createManagedServices } from "../../src/lsm/services-page.ts";
import { voicePortsInUse } from "../../src/lsm/voice-ports.ts";
import { fakeSecret } from "../helpers/fake-secrets.ts";

function svc(id: string, extra: Partial<LsmManagedService> = {}): LsmManagedService {
  return { id, title: id, port: null, state: "STOPPED", up: false, autostart: false, capabilities: ["start"], protected: false, protectedWhy: [], ...extra };
}

const SINCE = Date.UTC(2026, 10, 7, 1, 0, 0);
const SERVICES: LsmManagedService[] = [
  svc("drama-server", { title: "短剧站", port: 13000, state: "RUNNING", up: true, capabilities: ["start", "stop"] }),
  svc("ergo-daemon", {
    title: "二狗",
    port: 18810,
    state: "RUNNING",
    up: true,
    since: SINCE,
    autostart: true,
    capabilities: ["start", "busy", "stop", "restart", "health"],
    exposure: { via: "ergo-tunnel", publicUrl: "https://ergo.example.test/" },
    tailnet: { name: "ergo", url: "https://ergo.tail.example.test/" },
    dependsOn: [{ id: "audiocpp", type: "soft" }],
    protected: true,
    protectedWhy: ["调用方自己"],
  }),
  svc("ergo-tunnel", { title: "二狗隧道", role: "tunnel", state: "RUNNING", up: true, protected: true, protectedWhy: ["ergo-daemon 的公网隧道（exposure.via）"] }),
  svc("tail-gw", { title: "tailnet 网关", port: 18443, state: "RUNNING", up: true, protected: true, protectedWhy: ["tailnet 网关（ergo-daemon 开着 tailnet 入口）"] }),
  // 手工登记的语音合成：没有停机钩子（停要强制）；它挂着的时候服务管家记的最后一次出错
  svc("audiocpp", { title: "语音合成（audio.cpp）", port: 18090, state: "FAILED", autostart: true, lastError: "端口 18090 没人听" }),
  svc("ergo-asr", { title: "语音识别", port: 18091, state: "RUNNING", up: true, since: SINCE, capabilities: ["start", "stop", "restart"], protected: true, protectedWhy: ["注册表里标了 lifeline: true"] }),
  svc("ergo-daemon--p-1-web", { title: "记账本网页", owner: "ergo-daemon", port: 18600, state: "RUNNING", up: true, capabilities: ["start", "stop"] }),
  svc("comfyui", { title: "画图", port: 18188, state: "RUNNING", up: true, capabilities: ["start", "stop"], exposure: { via: "comfy-tunnel", publicUrl: null } }),
  svc("comfy-tunnel", { title: "画图隧道", role: "tunnel", state: "RUNNING", up: true }),
  svc("notes-sync", { title: "笔记同步", port: 18700, ergo: true }),
];

type Sent = { method: keyof LsmManage; args: unknown[] };

/** 假的管理指令：记下每次调用；replies 按方法名给回复（不给的回 ok + 这个服务现在的样子） */
function fakeManage(replies: Partial<Record<keyof LsmManage, (...args: never[]) => LsmManageReply>> = {}, support: LsmManage["support"] = "supported") {
  const sent: Sent[] = [];
  const method =
    (name: keyof LsmManage) =>
    async (...args: unknown[]): Promise<LsmManageReply> => {
      sent.push({ method: name, args });
      const given = replies[name] as ((...a: unknown[]) => LsmManageReply) | undefined;
      if (given) return given(...args);
      if (name === "list") return { ok: true, self: "ergo-daemon", services: SERVICES, profiles: {}, lifeline: [], tailnetGateway: "tail-gw" };
      const s = SERVICES.find((x) => x.id === args[0]);
      return { ok: true, ...(s ? { service: s } : {}) };
    };
  const names = ["list", "logs", "start", "stop", "restart", "cancelStop", "autostart", "profileStart", "profileStop", "exposeOn", "exposeOff", "tailnetOpen", "tailnetClose", "remove", "orphan", "restartSelf"] as const;
  const manage = { support, ...Object.fromEntries(names.map((n) => [n, method(n)])) } as unknown as LsmManage;
  return { manage, sent, commands: () => sent.filter((s) => s.method !== "list") };
}

function page(manage: LsmManage | undefined, voice = { speechPort: 18090, recognizerPort: 18091 }) {
  return createManagedServices({ manage: () => manage, voicePorts: () => voice, managerUrl: () => "http://127.0.0.1:17420/", now: () => 42 });
}

describe("设置 · 服务：列表", () => {
  it("只列和二狗有关的（二狗自己在最前），混着的 drama-server、画图和它的隧道一个都没有；每条带状态、端口、自启、出错、在跑多久、用途", async () => {
    const view = await page(fakeManage().manage).view();
    expect(view.support).toBe("supported");
    expect(view.managerUrl).toBe("http://127.0.0.1:17420/");
    expect(view.at).toBe(42);
    expect(view.services.map((s) => [s.id, s.uses])).toEqual([
      ["ergo-daemon", ["self"]],
      ["audiocpp", ["speech", "dependency"]],
      ["ergo-asr", ["recognizer"]],
      ["ergo-tunnel", ["tunnel"]],
      ["tail-gw", ["gateway"]],
      ["ergo-daemon--p-1-web", ["owned"]],
      ["notes-sync", ["marked"]],
    ]);
    for (const id of ["drama-server", "comfyui", "comfy-tunnel"]) expect(view.services.some((s) => s.id === id)).toBe(false);
    const audio = view.services.find((s) => s.id === "audiocpp")!;
    expect(audio).toMatchObject({ title: "语音合成（audio.cpp）", state: "FAILED", up: false, port: 18090, autostart: true, since: null, lastError: "端口 18090 没人听", canStop: false, canRestart: false });
    expect(audio.protection).toBeUndefined();
    expect(view.services[0]).toMatchObject({ id: "ergo-daemon", up: true, since: SINCE, canStop: true, canRestart: true, protection: { kind: "self", why: ["调用方自己"] } });
  });

  it("受保护的写清为什么：二狗自己、外网隧道、tailnet 网关，别的照服务管家的原因", async () => {
    const view = await page(fakeManage().manage).view();
    const kind = (id: string) => view.services.find((s) => s.id === id)?.protection;
    expect(kind("ergo-tunnel")).toEqual({ kind: "tunnel", why: ["ergo-daemon 的公网隧道（exposure.via）"] });
    expect(kind("tail-gw")).toEqual({ kind: "gateway", why: ["tailnet 网关（ergo-daemon 开着 tailnet 入口）"] });
    expect(kind("ergo-asr")).toEqual({ kind: "other", why: ["注册表里标了 lifeline: true"] });
    expect(kind("ergo-daemon--p-1-web")).toBeUndefined();
  });

  it("没在用语音时，手工登记的语音服务只靠别的规则认（audiocpp 是二狗的依赖，还在；ergo-asr 就不列了）", async () => {
    const view = await page(fakeManage().manage, {} as never).view();
    expect(view.services.map((s) => s.id)).toEqual(["ergo-daemon", "ergo-tunnel", "tail-gw", "audiocpp", "ergo-daemon--p-1-web", "notes-sync"]);
  });

  it("没接入、还没连上、服务管家太老：不取列表，照实写 support；取列表失败带上原因", async () => {
    expect(await page(undefined).view()).toEqual({ support: "disabled", services: [], at: 42, managerUrl: "http://127.0.0.1:17420/" });
    for (const support of ["waiting", "unsupported", "disabled"] as const) {
      const fake = fakeManage({}, support);
      expect((await page(fake.manage).view()).support).toBe(support);
      expect(fake.sent).toEqual([]);
    }
    const broken = fakeManage({ list: () => ({ ok: false, error: { code: "timeout", message: "服务管家 30 秒没回" } }) });
    expect(await page(broken.manage).view()).toMatchObject({ support: "supported", services: [], error: { code: "timeout", message: "服务管家 30 秒没回" } });
  });
});

describe("设置 · 服务：操作", () => {
  it("启动、停止、重启、取消等空闲再停、开机自启开 / 关各发对指令，结果带做完后的样子", async () => {
    const fake = fakeManage();
    const p = page(fake.manage);
    for (const action of ["start", "stop", "restart", "cancel_stop", "autostart_on", "autostart_off", "force_stop"] as const) {
      const r = await p.act("ergo-daemon--p-1-web", action);
      expect(r).toMatchObject({ ok: true, action, service: { id: "ergo-daemon--p-1-web", uses: ["owned"] } });
    }
    expect(fake.commands()).toEqual([
      { method: "start", args: ["ergo-daemon--p-1-web"] },
      { method: "stop", args: ["ergo-daemon--p-1-web"] },
      { method: "restart", args: ["ergo-daemon--p-1-web"] },
      { method: "cancelStop", args: ["ergo-daemon--p-1-web"] },
      { method: "autostart", args: ["ergo-daemon--p-1-web", true] },
      { method: "autostart", args: ["ergo-daemon--p-1-web", false] },
      { method: "stop", args: ["ergo-daemon--p-1-web", { force: true }] },
    ]);
  });

  it("受保护的：停止、强制停、重启、关开机自启本地先拒，一条指令都不发；启动、开开机自启照常", async () => {
    for (const id of ["ergo-daemon", "ergo-tunnel", "tail-gw", "ergo-asr"]) {
      const fake = fakeManage();
      const p = page(fake.manage);
      for (const action of ["stop", "force_stop", "restart", "autostart_off"] as const) {
        const r = await p.act(id, action);
        expect(r, `${id} ${action}`).toMatchObject({ ok: false, action, code: "protected", service: { id } });
      }
      expect(fake.commands(), id).toEqual([]);
      expect((await p.act(id, "start")).ok).toBe(true);
      expect((await p.act(id, "autostart_on")).ok).toBe(true);
      expect(fake.commands().map((c) => c.method)).toEqual(["start", "autostart"]);
    }
  });

  it("没有正常停止 / 重启办法的：先发普通的，服务管家回 no-capability 再发强制的，结果写 forced；强制也没成照实说", async () => {
    const nocap = (name: unknown, options?: { force?: boolean }): LsmManageReply =>
      options?.force ? { ok: true, service: { ...SERVICES.find((s) => s.id === name)!, state: "STOPPED", up: false } } : { ok: false, error: { code: "no-capability", message: `${String(name)} 没有停机能力。要停就带 force: true` } };
    const fake = fakeManage({ stop: nocap as never, restart: nocap as never });
    const p = page(fake.manage);
    expect(await p.act("audiocpp", "stop")).toMatchObject({ ok: true, action: "stop", forced: true, service: { id: "audiocpp", state: "STOPPED" } });
    expect(await p.act("audiocpp", "restart")).toMatchObject({ ok: true, action: "restart", forced: true });
    expect(fake.commands()).toEqual([
      { method: "stop", args: ["audiocpp"] },
      { method: "stop", args: ["audiocpp", { force: true }] },
      { method: "restart", args: ["audiocpp"] },
      { method: "restart", args: ["audiocpp", { force: true }] },
    ]);
    const stuck = fakeManage({ stop: ((name: unknown, options?: { force?: boolean }) => (options?.force ? { ok: false, error: { code: "failed", message: "10 秒没停下，进程杀不掉" } } : nocap(name))) as never });
    expect(await page(stuck.manage).act("audiocpp", "stop")).toMatchObject({ ok: false, action: "stop", code: "failed", message: "10 秒没停下，进程杀不掉" });
  });

  it("有正常停止办法的照常优雅停，不改强制；正忙排上了写 pending；本来就停着写 already", async () => {
    const fake = fakeManage({ stop: (() => ({ ok: true, pending: true, note: "服务正忙，停机已排队" })) as never });
    const r = await page(fake.manage).act("ergo-daemon--p-1-web", "stop");
    expect(r).toEqual(expect.objectContaining({ ok: true, pending: true, note: "服务正忙，停机已排队" }));
    expect(r).not.toHaveProperty("forced");
    expect(fake.commands()).toEqual([{ method: "stop", args: ["ergo-daemon--p-1-web"] }]);
    const already = fakeManage({ start: (() => ({ ok: true, already: true })) as never });
    expect(await page(already.manage).act("ergo-asr", "start")).toMatchObject({ ok: true, already: true });
  });

  it("服务管家回 protected、别的失败：照实转（原因是它的话）", async () => {
    const fake = fakeManage({ stop: (() => ({ ok: false, error: { code: "protected", message: "不能停止 notes-sync：它是 ergo-daemon 的命脉" } })) as never });
    expect(await page(fake.manage).act("notes-sync", "stop")).toMatchObject({ ok: false, code: "protected", message: "不能停止 notes-sync：它是 ergo-daemon 的命脉", service: { id: "notes-sync" } });
  });

  it("不是和二狗有关的（drama-server、画图、不存在的）：操作和日志都回 not-related，不发指令", async () => {
    const fake = fakeManage();
    const p = page(fake.manage);
    for (const id of ["drama-server", "comfyui", "comfy-tunnel", "没有这个"]) {
      expect(await p.act(id, "stop")).toMatchObject({ ok: false, code: "not-related" });
      expect(await p.logs(id)).toMatchObject({ ok: false, id, code: "not-related" });
    }
    expect(fake.commands()).toEqual([]);
  });

  it("没接入、没连上、太老：不发指令，code 写明", async () => {
    expect(await page(undefined).act("audiocpp", "start")).toMatchObject({ ok: false, code: "not-linked" });
    expect(await page(fakeManage({}, "waiting").manage).act("audiocpp", "start")).toMatchObject({ ok: false, code: "not-connected" });
    expect(await page(fakeManage({}, "unsupported").manage).logs("audiocpp")).toMatchObject({ ok: false, code: "unsupported" });
  });
});

describe("设置 · 服务：日志", () => {
  it("最后几十行：默认 60 行、最多 200 行，每行截短、擦掉像密钥的，太长只留最后的；列出别的几份", async () => {
    const key = fakeSecret("sk-", "a".repeat(32));
    const long = "x".repeat(500);
    const raw = [...Array.from({ length: 30 }, (_, i) => `line ${i} ${long}`), `token ${key}`, ""].join("\n");
    const fake = fakeManage({
      logs: (() => ({ ok: true, name: "audiocpp", source: 0, label: "命令行输出", lines: raw, capped: false, sources: [{ source: 0, label: "命令行输出" }, { source: 1, label: "server" }] })) as never,
    });
    const p = page(fake.manage);
    const r = await p.logs("audiocpp");
    if (!r.ok) throw new Error("应当成功");
    expect(r.label).toBe("命令行输出");
    expect(r.sources).toHaveLength(2);
    expect(r.lines.at(-1)).not.toContain(key);
    expect(r.lines.every((line) => line.length <= 401)).toBe(true);
    expect(r.lines.join("\n").length).toBeLessThanOrEqual(6000);
    expect(r.cut).toBe(true);
    await p.logs("audiocpp", { lines: 999, source: 1 });
    await p.logs("audiocpp", { lines: 0 });
    expect(fake.commands().map((c) => c.args)).toEqual([
      ["audiocpp", { lines: 60 }],
      ["audiocpp", { lines: 200, source: 1 }],
      ["audiocpp", { lines: 1 }],
    ]);
  });

  it("服务管家取不到日志：照实说", async () => {
    const fake = fakeManage({ logs: (() => ({ ok: false, error: { code: "not-found", message: "没有第 3 份日志" } })) as never });
    expect(await page(fake.manage).logs("audiocpp", { source: 3 })).toEqual({ ok: false, id: "audiocpp", code: "not-found", message: "没有第 3 份日志" });
  });
});

describe("二狗在用的语音端口", () => {
  const voice = (mode: "spawn" | "lsm" | "audiocpp", speech = "http://127.0.0.1:18090", recognizer = "http://127.0.0.1:18091") => ({ speech: { url: speech }, recognizer: { mode, url: recognizer } }) as never;
  it("语音插件启用着才算；识别 lsm 用自己的地址、audiocpp 和合成同一个、spawn 不归服务管家；不是本机的不算", () => {
    expect(voicePortsInUse(voice("lsm"), { voiceOn: true })).toEqual({ speechPort: 18090, recognizerPort: 18091 });
    expect(voicePortsInUse(voice("audiocpp"), { voiceOn: true })).toEqual({ speechPort: 18090, recognizerPort: 18090 });
    expect(voicePortsInUse(voice("spawn"), { voiceOn: true })).toEqual({ speechPort: 18090 });
    expect(voicePortsInUse(voice("lsm", "http://192.168.1.9:8090", "http://192.168.1.9:8091"), { voiceOn: true })).toEqual({});
    expect(voicePortsInUse(voice("lsm"), { voiceOn: false })).toEqual({});
    expect(voicePortsInUse(voice("lsm"), { voiceOn: true, speechUrl: "http://127.0.0.1:1" })).toEqual({ speechPort: 1, recognizerPort: 18091 });
  });
});
