// 秘书指挥服务管家的工具（lsm/secretary-tools.ts，418）：用假的管理指令（不连任何服务管家）走每个工具。
// - 只读：列表（状态、端口、开机自启、二狗离不开、场景）、单个服务的详情、日志（截短、擦掉像密钥的）；
// - 普通：启动、优雅停止、等空闲再停、取消、立刻重启、开机自启开、按场景启动，按名字认服务（全名、名下短名、标题，对不上、不止一个照实说）；
// - 本地先拒命脉：二狗自己、它的外网隧道、lifeline 标记的——停、重启、强制停、移出自启、撤销、杀孤儿、关公网入口（目标或它的隧道）、
//   场景停止（成员和依赖里有命脉），一次都不发给服务管家；话里写清是谁、为什么；
// - 服务管家最后裁决：本地看着能做、管理器回 protected 也照实说；没有优雅停机的指去要批准的强制停止；超时、断线、没接入、太老的说清；
// - 重启自己：发了就返回"已排队"，排上后才算忙（restartHold），被拒撤掉；
// - 守卫：六个工具的类别和"对话审批关着也问"。
import { describe, expect, it, vi } from "vitest";
import { CHANNELS, EVENT_TYPES } from "@ergo/protocol";
import type { HostTool } from "../../src/agent-manager/host-tools.ts";
import { BUILTIN_TOOL_REGISTRY, judgementExecutes, judgeToolCall, SECRETARY_ASKS } from "../../src/guard/index.ts";
import type { StoredEvent } from "../../src/events/event-store.ts";
import type { LsmManage, LsmManagedService, LsmManageReply } from "../../src/lsm/link.ts";
import { createRestartSelfHold, withRestartHold } from "../../src/lsm/restart-hold.ts";
import { findManaged, LSM_TOOL, lsmSecretaryTools } from "../../src/lsm/secretary-tools.ts";
import { fakeSecret } from "../helpers/fake-secrets.ts";
import { call, inChat, secretary } from "../guard/helpers/guard-input.ts";

/** 一条服务（没写的按"停着、没保护"） */
function svc(id: string, extra: Partial<LsmManagedService> = {}): LsmManagedService {
  return { id, title: id, port: null, state: "STOPPED", up: false, autostart: false, capabilities: ["start"], protected: false, protectedWhy: [], ...extra };
}

const SERVICES: LsmManagedService[] = [
  svc("ergo-daemon", {
    title: "二狗",
    port: 18810,
    state: "RUNNING",
    up: true,
    autostart: true,
    capabilities: ["start", "busy", "stop", "restart", "health"],
    exposure: { via: "ergo-tunnel", publicUrl: "https://ergo.example.test/" },
    protected: true,
    protectedWhy: ["调用方自己"],
  }),
  svc("ergo-tunnel", { title: "二狗隧道", state: "RUNNING", up: true, protected: true, protectedWhy: ["ergo-daemon 的公网隧道（exposure.via）"] }),
  svc("ergo-asr", { title: "语音识别", port: 18091, state: "RUNNING", up: true, protected: true, protectedWhy: ["注册表里标了 lifeline: true"] }),
  svc("ergo-daemon--audiocpp", { title: "语音合成", owner: "ergo-daemon", port: 18090, state: "RUNNING", up: true, autostart: true, capabilities: ["start", "health"], profiles: ["gpu"] }),
  svc("comfyui", { title: "画图", port: 18188, state: "RUNNING", up: true, capabilities: ["start", "stop"], profiles: ["gpu"], dependsOn: [{ id: "cuda-host", type: "soft" }] }),
  svc("cuda-host", { title: "显卡驱动服务", state: "RUNNING", up: true }),
  svc("web-server", { title: "简报站", port: 18650, exposure: { via: "web-tunnel", publicUrl: "https://brief.example.test/" }, tailnet: { name: "brief", url: "https://brief.tail.example.test/" }, lastError: "端口 18650 没人听" , state: "FAILED" }),
  svc("web-tunnel", { title: "简报站隧道" }),
  // 公网隧道借的是二狗的隧道：关它的公网入口就是停二狗的隧道
  svc("side-site", { title: "附属站", exposure: { via: "ergo-tunnel", publicUrl: null } }),
  svc("reporting", { title: "报表", dependsOn: [{ id: "ergo-asr", type: "hard" }], profiles: ["night"] }),
];
const PROFILES = { gpu: ["ergo-daemon--audiocpp", "comfyui"], ergo: ["ergo-daemon", "ergo-tunnel"], night: ["reporting"] };

type Sent = { method: keyof LsmManage; args: unknown[] };

/** 这个名字的服务现在的样子 */
const current = (name: unknown) => SERVICES.find((s) => s.id === name);
/** 一条只带频道和类型的事件 */
const event = (channel: string, type: string) => ({ channel, type }) as StoredEvent;

/** 假的管理指令：记下每次调用；replies 按方法名给回复（不给的回 ok + 这个服务现在的样子） */
function fakeManage(replies: Partial<Record<keyof LsmManage, (...args: never[]) => LsmManageReply | Promise<LsmManageReply>>> = {}) {
  const sent: Sent[] = [];
  const method =
    (name: keyof LsmManage) =>
    async (...args: unknown[]): Promise<LsmManageReply> => {
      sent.push({ method: name, args });
      const given = replies[name] as ((...a: unknown[]) => LsmManageReply | Promise<LsmManageReply>) | undefined;
      if (given) return given(...args);
      if (name === "list") return { ok: true, self: "ergo-daemon", services: SERVICES, profiles: PROFILES, lifeline: [] };
      const s = current(args[0]);
      return { ok: true, ...(s ? { service: s } : {}) };
    };
  const names = ["list", "logs", "start", "stop", "restart", "cancelStop", "autostart", "profileStart", "profileStop", "exposeOn", "exposeOff", "tailnetOpen", "tailnetClose", "remove", "orphan", "restartSelf"] as const;
  const manage = { support: "supported", ...Object.fromEntries(names.map((n) => [n, method(n)])) } as unknown as LsmManage;
  /** 发给服务管家的（不算取列表） */
  const commands = () => sent.filter((s) => s.method !== "list");
  return { manage, sent, commands };
}

function tools(manage: LsmManage | undefined, hold = createRestartSelfHold()) {
  const list = lsmSecretaryTools({ manage: () => manage, restartHold: hold });
  const byName = (name: string): HostTool => list.find((tool) => tool.spec.name === name)!;
  const run = async (name: string, args: Record<string, unknown>) => byName(name).run(args as never, { toolCallId: "call-1" });
  return { list, byName, run, hold };
}

describe("只读：列表、详情、日志", () => {
  it("列表：每个服务一行（名字、状态、端口、开机自启、二狗离不开、没在跑时最后一次出错），带场景和保护说明；只取了一次列表", async () => {
    const fake = fakeManage();
    const out = await tools(fake.manage).run(LSM_TOOL.status, {});
    expect(out.isError).toBeUndefined();
    const lines = out.text.split("\n");
    expect(lines[0]).toBe("服务管家里有 10 个服务：");
    expect(lines).toContain("- 「ergo-daemon」（二狗）：在跑，端口 18810，开机自启，二狗离不开");
    expect(lines).toContain("- 「ergo-daemon--audiocpp」（语音合成）：在跑，端口 18090，开机自启");
    expect(lines).toContain("- 「web-server」（简报站）：挂了（没起来，或者起来后退出了），端口 18650，最后一次出错：端口 18650 没人听");
    expect(out.text).toContain("场景：gpu（ergo-daemon--audiocpp、comfyui）；ergo（ergo-daemon、ergo-tunnel）；night（reporting）");
    expect(out.text).toContain("标着「二狗离不开」的不能经二狗停止、重启、撤销。");
    expect(fake.sent.map((s) => s.method)).toEqual(["list"]);
  });

  it("单个服务的详情：按标题、名下短名都认得；写着能不能优雅停机、入口、为什么二狗离不开", async () => {
    const fake = fakeManage();
    const { run } = tools(fake.manage);
    const audio = await run(LSM_TOOL.status, { service: "audiocpp" });
    expect(audio.text).toContain("「ergo-daemon--audiocpp」（语音合成）：在跑");
    expect(audio.text).toContain("是 ergo-daemon 名下的服务");
    expect(audio.text).toContain("没有优雅停机的办法：要停只能强制停止（杀进程）");
    const web = await run(LSM_TOOL.status, { service: "简报站" });
    expect(web.text).toContain("公网入口：经隧道 web-tunnel，地址 https://brief.example.test/");
    expect(web.text).toContain("tailnet 入口：https://brief.tail.example.test/");
    const tunnel = await run(LSM_TOOL.status, { service: "ergo-tunnel" });
    expect(tunnel.text).toContain("二狗离不开它：这是二狗的外网隧道，停了手机就连不上二狗。不能经二狗停止、重启、撤销");
    const asr = await run(LSM_TOOL.status, { service: "ergo-asr" });
    expect(asr.text).toContain("二狗要靠它才能跑（服务管家说：注册表里标了 lifeline: true）");
  });

  it("日志：默认要 60 行；像密钥的擦掉、太长的行截短、太多只留最后的；写着还有哪几份日志", async () => {
    const key = fakeSecret("sk-", "a".repeat(32));
    const long = "x".repeat(1000);
    const many = Array.from({ length: 40 }, (_, i) => `第 ${i} 行 ${"y".repeat(200)}`);
    const fake = fakeManage({
      logs: () => ({ ok: true, name: "comfyui", source: 0, label: "命令行输出", lines: [`启动，key=${key}`, long, ...many, ""].join("\n"), sources: [{ source: 0, label: "命令行输出" }, { source: 1, label: "server" }] }),
    });
    const out = await tools(fake.manage).run(LSM_TOOL.logs, { service: "画图" });
    expect(fake.commands()).toEqual([{ method: "logs", args: ["comfyui", { lines: 60 }] }]);
    expect(out.text).not.toContain(key);
    expect(out.text).not.toContain(long);
    expect(out.text).toMatch(/^「comfyui」（画图）的命令行输出，最后 \d+ 行：/);
    expect(out.text).toContain("（太长了，只留最后");
    expect(out.text).toContain("第 39 行");
    expect(out.text.length).toBeLessThan(7_000);
    expect(out.text.split("\n").at(-1)).toBe("还有别的日志（写 source 看）：1 server");
    // 换一份日志、要更多行
    await tools(fake.manage).run(LSM_TOOL.logs, { service: "comfyui", lines: 200, source: 1 });
    expect(fake.commands().at(-1)).toEqual({ method: "logs", args: ["comfyui", { lines: 200, source: 1 }] });
  });

  it("日志里像密钥的短一点也擦（和工具调用记录同一套形态）", async () => {
    const token = fakeSecret("ghp_", "b".repeat(36));
    const fake = fakeManage({ logs: () => ({ ok: true, label: "命令行输出", source: 0, lines: `token ${token}\n`, sources: [] }) });
    const out = await tools(fake.manage).run(LSM_TOOL.logs, { service: "comfyui" });
    expect(out.text).toBe("「comfyui」（画图）的命令行输出，最后 1 行：\ntoken （密钥）");
  });
});

describe("按名字认服务", () => {
  it("全名优先，其次名下短名、标题，再其次互相包含；不分大小写和空白", () => {
    expect(findManaged(SERVICES, "ComfyUI").map((s) => s.id)).toEqual(["comfyui"]);
    expect(findManaged(SERVICES, "audiocpp").map((s) => s.id)).toEqual(["ergo-daemon--audiocpp"]);
    expect(findManaged(SERVICES, "语音 合成").map((s) => s.id)).toEqual(["ergo-daemon--audiocpp"]);
    expect(findManaged(SERVICES, "ergo-daemon").map((s) => s.id)).toEqual(["ergo-daemon"]);
    expect(findManaged(SERVICES, "隧道").map((s) => s.id)).toEqual(["ergo-tunnel", "web-tunnel"]);
  });

  it("对不上、不止一个：照实说，不发指令", async () => {
    const fake = fakeManage();
    const { run } = tools(fake.manage);
    const none = await run(LSM_TOOL.control, { action: "stop", service: "打印机" });
    expect(none.isError).toBe(true);
    expect(none.text).toMatch(/^服务管家里没有和「打印机」对得上的服务。现在有：「ergo-daemon」（二狗）、/);
    const two = await run(LSM_TOOL.control, { action: "stop", service: "隧道" });
    expect(two.text).toBe("和「隧道」对得上的不止一个：「ergo-tunnel」（二狗隧道）、「web-tunnel」（简报站隧道）。问用户是哪一个，别自己挑。");
    const noService = await run(LSM_TOOL.control, { action: "start" });
    expect(noService.text).toBe("要写 service（服务名，lsm_status 列出来的）。");
    const noProfile = await run(LSM_TOOL.control, { action: "profile_start", profile: "夜里" });
    expect(noProfile.text).toBe("没有叫「夜里」的场景。现在有：gpu、ergo、night");
    expect(fake.commands()).toEqual([]);
  });
});

describe("普通：用户说了就做", () => {
  it("每个动作发对指令、说清做了什么和现在的样子", async () => {
    const fake = fakeManage();
    const { run } = tools(fake.manage);
    expect((await run(LSM_TOOL.control, { action: "start", service: "web-server" })).text).toBe(
      "已启动「web-server」（简报站）。\n现在：「web-server」（简报站）：挂了（没起来，或者起来后退出了），端口 18650，最后一次出错：端口 18650 没人听",
    );
    expect((await run(LSM_TOOL.control, { action: "stop", service: "comfyui" })).text).toMatch(/^已停止「comfyui」（画图）。/);
    await run(LSM_TOOL.control, { action: "stop_when_idle", service: "comfyui" });
    await run(LSM_TOOL.control, { action: "cancel_stop", service: "comfyui" });
    await run(LSM_TOOL.control, { action: "restart", service: "comfyui" });
    expect((await run(LSM_TOOL.control, { action: "autostart_on", service: "comfyui" })).text).toMatch(/^已把「comfyui」（画图）加进开机自启/);
    // 对命脉不停的事照常：启动、加进开机自启、取消等空闲再停
    await run(LSM_TOOL.control, { action: "start", service: "ergo-tunnel" });
    await run(LSM_TOOL.control, { action: "autostart_on", service: "ergo-asr" });
    await run(LSM_TOOL.control, { action: "cancel_stop", service: "ergo-daemon" });
    expect(fake.commands()).toEqual([
      { method: "start", args: ["web-server"] },
      { method: "stop", args: ["comfyui"] },
      { method: "stop", args: ["comfyui", { mode: "when-idle" }] },
      { method: "cancelStop", args: ["comfyui"] },
      { method: "restart", args: ["comfyui"] },
      { method: "autostart", args: ["comfyui", true] },
      { method: "start", args: ["ergo-tunnel"] },
      { method: "autostart", args: ["ergo-asr", true] },
      { method: "cancelStop", args: ["ergo-daemon"] },
    ]);
  });

  it("本来就那样、正忙排上了：照实说", async () => {
    const fake = fakeManage({
      start: () => ({ ok: true, already: true, service: SERVICES[4]! }),
      stop: () => ({ ok: true, pending: true, note: "服务正忙，停机已排队", service: SERVICES[4]! }),
    });
    const { run } = tools(fake.manage);
    expect((await run(LSM_TOOL.control, { action: "start", service: "comfyui" })).text).toMatch(/^「comfyui」（画图）本来就在跑。/);
    expect((await run(LSM_TOOL.control, { action: "stop_when_idle", service: "comfyui" })).text).toMatch(/^「comfyui」（画图）正忙，等它空闲了再停：已经排上了。/);
  });

  it("没有优雅停机、没有重启办法的：指去要批准的 lsm_force，不说做了", async () => {
    const fake = fakeManage({
      stop: () => ({ ok: false, error: { code: "no-capability", message: "没有停机能力。要停就带 force: true" } }),
      restart: () => ({ ok: false, error: { code: "no-capability", message: "没有重启能力" } }),
    });
    const { run } = tools(fake.manage);
    const stop = await run(LSM_TOOL.control, { action: "stop", service: "audiocpp" });
    expect(stop.isError).toBe(true);
    expect(stop.text).toBe(
      "「ergo-daemon--audiocpp」（语音合成）没有优雅停机的办法，只能强制停止（杀进程，它手上正在做的会断）。要停就用 lsm_force 的 force_stop，会出审批卡等用户点。\n照实告诉用户，别说已经做了。",
    );
    const restart = await run(LSM_TOOL.control, { action: "restart", service: "audiocpp" });
    expect(restart.text).toContain("只能强制重启（先杀进程再起）。要重启就用 lsm_force 的 force_restart");
  });

  it("按场景启动：每个服务起没起来", async () => {
    const fake = fakeManage({
      profileStart: () => ({ ok: true, profile: "gpu", results: [{ id: "ergo-daemon--audiocpp", ok: true, already: true }, { id: "comfyui", ok: true }] }),
    });
    const out = await tools(fake.manage).run(LSM_TOOL.control, { action: "profile_start", profile: "GPU" });
    expect(fake.commands()).toEqual([{ method: "profileStart", args: ["gpu"] }]);
    expect(out.text).toBe("场景「gpu」启动了：\n- ergo-daemon--audiocpp：本来就在跑\n- comfyui：起来了");
  });
});

describe("命脉：本地先拒一遍，一次都不发给服务管家", () => {
  const CASES: Array<[string, Record<string, unknown>, string]> = [
    [LSM_TOOL.control, { action: "stop", service: "ergo-daemon" }, "「ergo-daemon」（二狗）不能停止：这是二狗自己。"],
    [LSM_TOOL.control, { action: "stop_when_idle", service: "二狗" }, "「ergo-daemon」（二狗）不能等空闲后停止：这是二狗自己。"],
    [LSM_TOOL.control, { action: "stop", service: "ergo-tunnel" }, "「ergo-tunnel」（二狗隧道）不能停止：这是二狗的外网隧道，停了手机就连不上二狗。"],
    [LSM_TOOL.control, { action: "restart", service: "ergo-asr" }, "「ergo-asr」（语音识别）不能重启：二狗要靠它才能跑（服务管家说：注册表里标了 lifeline: true）。"],
    [LSM_TOOL.force, { action: "force_stop", service: "ergo-tunnel" }, "「ergo-tunnel」（二狗隧道）不能强制停止：这是二狗的外网隧道，停了手机就连不上二狗。"],
    [LSM_TOOL.force, { action: "force_restart", service: "ergo-asr" }, "「ergo-asr」（语音识别）不能强制重启："],
    [LSM_TOOL.force, { action: "autostart_off", service: "ergo-daemon" }, "「ergo-daemon」（二狗）不能移出开机自启：这是二狗自己。"],
    [LSM_TOOL.force, { action: "remove", service: "ergo-asr" }, "「ergo-asr」（语音识别）不能撤销："],
    [LSM_TOOL.force, { action: "orphan_kill", service: "ergo-tunnel" }, "「ergo-tunnel」（二狗隧道）不能杀掉占着端口的进程："],
    // 场景停止会连成员依赖的一起停：night 只列了 reporting，它硬依赖 ergo-asr
    [LSM_TOOL.force, { action: "profile_stop", profile: "night" }, "「ergo-asr」（语音识别）不能跟着场景停止："],
    [LSM_TOOL.force, { action: "profile_stop", profile: "ergo" }, "「ergo-daemon」（二狗）不能跟着场景停止：这是二狗自己。"],
    [LSM_TOOL.entries, { action: "expose_off", service: "ergo-daemon" }, "「ergo-daemon」（二狗）不能关掉公网入口：这是二狗自己。"],
    // 附属站的公网隧道借的是二狗的：关它的入口就是停二狗的隧道
    [LSM_TOOL.entries, { action: "expose_off", service: "附属站" }, "「ergo-tunnel」（二狗隧道）不能关掉公网入口：这是二狗的外网隧道，停了手机就连不上二狗。"],
    [LSM_TOOL.entries, { action: "tailnet_close", service: "ergo-daemon" }, "「ergo-daemon」（二狗）不能撤掉 tailnet 入口：这是二狗自己。"],
  ];
  for (const [tool, args, said] of CASES) {
    it(`${tool} ${JSON.stringify(args)}`, async () => {
      const fake = fakeManage();
      const out = await tools(fake.manage).run(tool, args);
      expect(out.isError).toBe(true);
      expect(out.text.startsWith(said)).toBe(true);
      expect(out.text).toContain("二狗离不开的服务不能经二狗停止、重启、撤销；真要做，请用户自己在服务管家的网页上做。");
      expect(fake.commands()).toEqual([]);
    });
  }

  it("重启二狗自己：指去 lsm_restart_self", async () => {
    const out = await tools(fakeManage().manage).run(LSM_TOOL.control, { action: "restart", service: "ergo-daemon" });
    expect(out.text).toContain("要重启二狗自己用 lsm_restart_self（等空闲再重启，要用户批准）。");
  });

  it("服务管家仍然最后裁决：本地看着能做、它回 protected 照实说", async () => {
    const fake = fakeManage({ stop: () => ({ ok: false, error: { code: "protected", message: "不能停止 comfyui：comfyui（注册表里标了 lifeline: true）是 ergo-daemon 的命脉", details: [] } }) });
    const out = await tools(fake.manage).run(LSM_TOOL.control, { action: "stop", service: "comfyui" });
    expect(out.isError).toBe(true);
    expect(out.text).toBe("服务管家拒绝了（二狗离不开的服务不能这样动）：不能停止 comfyui：comfyui（注册表里标了 lifeline: true）是 ergo-daemon 的命脉\n照实告诉用户，别说已经做了。");
  });
});

describe("要批准的：强制停止、移出自启、场景停止、撤销、孤儿、入口", () => {
  it("每个动作发对指令（场景停止带 force：没有优雅停机的也要停得下）", async () => {
    const fake = fakeManage({
      profileStop: () => ({ ok: true, profile: "gpu", results: [{ id: "comfyui", ok: true }, { id: "ergo-daemon--audiocpp", ok: true }] }),
      remove: () => ({ ok: true, removed: { id: "ergo-daemon--audiocpp", name: "audiocpp" } }),
      orphan: (_name: never, decision: never) => (decision === "kill" ? { ok: true, killed: [4242], service: SERVICES[4]! } : { ok: true, service: SERVICES[4]! }),
      exposeOn: () => ({ ok: true, tunnel: "web-tunnel", service: SERVICES[6]! }),
      exposeOff: () => ({ ok: true, tunnel: "web-tunnel", service: SERVICES[6]! }),
      tailnetOpen: () => ({ ok: true, url: "https://brief2.tail.example.test/", note: "DNS 生效要一两分钟", service: SERVICES[6]! }),
    });
    const { run } = tools(fake.manage);
    expect((await run(LSM_TOOL.force, { action: "force_stop", service: "audiocpp" })).text).toMatch(/^已强制停止「ergo-daemon--audiocpp」（语音合成）。/);
    await run(LSM_TOOL.force, { action: "force_restart", service: "audiocpp" });
    expect((await run(LSM_TOOL.force, { action: "autostart_off", service: "audiocpp" })).text).toMatch(/^已把「ergo-daemon--audiocpp」（语音合成）移出开机自启：现在跑着的照常跑/);
    expect((await run(LSM_TOOL.force, { action: "profile_stop", profile: "gpu" })).text).toBe("场景「gpu」停了：\n- comfyui：停了\n- ergo-daemon--audiocpp：停了");
    expect((await run(LSM_TOOL.force, { action: "remove", service: "audiocpp" })).text).toBe("已撤销「ergo-daemon--audiocpp」（语音合成）：停掉了，并从服务管家里拿掉了登记。");
    // 认领孤儿对命脉也能做（不停东西）；杀孤儿写杀了哪个进程
    await run(LSM_TOOL.force, { action: "orphan_adopt", service: "ergo-tunnel" });
    expect((await run(LSM_TOOL.force, { action: "orphan_kill", service: "comfyui" })).text).toMatch(/^已杀掉占着「comfyui」（画图）端口的进程（4242）。/);
    expect((await run(LSM_TOOL.entries, { action: "expose_on", service: "简报站" })).text).toMatch(/^已打开「web-server」（简报站）的公网入口（隧道 web-tunnel 起来了）：https:\/\/brief.example.test\//);
    expect((await run(LSM_TOOL.entries, { action: "expose_off", service: "简报站" })).text).toMatch(/^已关掉「web-server」（简报站）的公网入口（停了隧道 web-tunnel）。/);
    // 服务管家另外交代的照转
    expect((await run(LSM_TOOL.entries, { action: "tailnet_open", service: "简报站", tailnetName: "brief2" })).text).toMatch(
      /^已给「web-server」（简报站）开了 tailnet 入口：https:\/\/brief2.tail.example.test\/\n服务管家说：DNS 生效要一两分钟\n现在：/,
    );
    await run(LSM_TOOL.entries, { action: "tailnet_close", service: "简报站" });
    expect(fake.commands()).toEqual([
      { method: "stop", args: ["ergo-daemon--audiocpp", { force: true }] },
      { method: "restart", args: ["ergo-daemon--audiocpp", { force: true }] },
      { method: "autostart", args: ["ergo-daemon--audiocpp", false] },
      { method: "profileStop", args: ["gpu", { force: true }] },
      { method: "remove", args: ["ergo-daemon--audiocpp"] },
      { method: "orphan", args: ["ergo-tunnel", "adopt"] },
      { method: "orphan", args: ["comfyui", "kill"] },
      { method: "exposeOn", args: ["web-server"] },
      { method: "exposeOff", args: ["web-server"] },
      { method: "tailnetOpen", args: ["web-server", "brief2"] },
      { method: "tailnetClose", args: ["web-server"] },
    ]);
  });

  it("场景里有服务没停下：一个个写清，照实说", async () => {
    const fake = fakeManage({
      profileStop: () => ({ ok: false, error: { code: "failed", message: "场景 gpu 里有服务没停成" }, profile: "gpu", results: [{ id: "comfyui", ok: false, why: "10 秒没停下" }, { id: "ergo-daemon--audiocpp", ok: true }] }),
    });
    const out = await tools(fake.manage).run(LSM_TOOL.force, { action: "profile_stop", profile: "gpu" });
    expect(out.isError).toBe(true);
    expect(out.text).toBe("没做成：场景 gpu 里有服务没停成\n- comfyui：没停下（10 秒没停下）\n- ergo-daemon--audiocpp：停了\n照实告诉用户，别说已经做了。");
  });

  it("撤销手写的、还被别的用着的：照服务管家的原因说", async () => {
    const fake = fakeManage({ remove: () => ({ ok: false, error: { code: "not-owner", message: "comfyui 不是名下的服务" } }) });
    const out = await tools(fake.manage).run(LSM_TOOL.force, { action: "remove", service: "comfyui" });
    expect(out.text).toContain("只能撤销二狗名下的项目服务，手写在服务管家里的请用户在它的网页上删：comfyui 不是名下的服务");
  });
});

describe("连不上、太老、超时、断了", () => {
  it("接入层还没建好、没接入：说清指挥不了", async () => {
    const out = await tools(undefined).run(LSM_TOOL.status, {});
    expect(out).toEqual({ text: "二狗不是由服务管家启动的，指挥不了服务管家里的服务。", isError: true });
  });

  it("太老（welcome 里没有 manage）、没连上：取列表就停下", async () => {
    const old = fakeManage({ list: () => ({ ok: false, error: { code: "unsupported", message: "这个版本的服务管家不支持管理指令" } }) });
    expect((await tools(old.manage).run(LSM_TOOL.control, { action: "stop", service: "comfyui" })).text).toBe("这个版本的服务管家还不能让二狗管别的服务：要先更新服务管家。\n照实告诉用户，别说已经做了。");
    expect(old.commands()).toEqual([]);
    const away = fakeManage({ list: () => ({ ok: false, error: { code: "not-connected", message: "还没连上" } }) });
    expect((await tools(away.manage).run(LSM_TOOL.status, {})).text).toMatch(/^现在没连上服务管家（可能正在重连），过一会儿再试。/);
  });

  it("超时、断线：不代表没做，叫它看一眼列表", async () => {
    const slow = fakeManage({ start: () => ({ ok: false, error: { code: "timeout", message: "服务管家没有应答" } }) });
    expect((await tools(slow.manage).run(LSM_TOOL.control, { action: "start", service: "comfyui" })).text).toMatch(/^服务管家很久没回话。不代表没做（启动要等就绪、场景要一层层起），过一会儿用 lsm_status 看一眼。/);
    const cut = fakeManage({ stop: () => ({ ok: false, error: { code: "disconnected", message: "断了" } }) });
    expect((await tools(cut.manage).run(LSM_TOOL.force, { action: "force_stop", service: "comfyui" })).text).toMatch(/^做到一半和服务管家的连接断了：可能做了也可能没做，用 lsm_status 看一眼现在的样子。/);
  });

  it("会等服务管家的工具：超时比接入层的请求超时（10 分钟）长", () => {
    const { byName } = tools(fakeManage().manage);
    for (const name of [LSM_TOOL.control, LSM_TOOL.force, LSM_TOOL.entries]) expect(byName(name).timeoutMs).toBeGreaterThan(600_000);
    for (const name of [LSM_TOOL.status, LSM_TOOL.logs, LSM_TOOL.restartSelf]) expect(byName(name).timeoutMs).toBeUndefined();
  });
});

describe("重启二狗自己", () => {
  it("发了就返回已排队（不等重启）；排上之后才算忙，秘书这一轮说完放开", async () => {
    const hold = createRestartSelfHold();
    const changes = vi.fn<() => void>();
    hold.onChange(changes);
    let activeWhenSent: boolean | undefined;
    const fake = fakeManage({
      restartSelf: () => {
        // 服务管家收下时（之后马上发 restart when-idle）已经算忙
        activeWhenSent = hold.active;
        return { ok: true, queued: true, note: "已排队" };
      },
    });
    const out = await tools(fake.manage, hold).run(LSM_TOOL.restartSelf, { reason: "改了配置要生效" });
    expect(out.text).toBe(
      "排好了：二狗空闲了（手上的任务、正在执行的调用做完，这一轮话说完）就会重启，服务管家再把它拉起来；重启后这段对话接着在。不用等它，跟用户说一声就好。",
    );
    expect(activeWhenSent).toBe(true);
    expect(fake.sent.map((s) => s.method)).toEqual(["restartSelf"]);
    expect(withRestartHold({ busy: false }, hold)).toEqual({ busy: true, reason: "秘书刚排上等空闲重启二狗，等它说完这一轮" });
    expect(withRestartHold({ busy: true, reason: "正在执行 1 个任务：「整理发票」" }, hold).reason).toBe("正在执行 1 个任务：「整理发票」；秘书刚排上等空闲重启二狗，等它说完这一轮");
    // 别的会话的、秘书这一轮之外的事件不算
    expect(hold.release(event("maintainer:p-1", EVENT_TYPES.turnEnd))).toBe(false);
    expect(hold.release(event(CHANNELS.secretary, EVENT_TYPES.message))).toBe(false);
    expect(hold.active).toBe(true);
    expect(hold.release(event(CHANNELS.secretary, EVENT_TYPES.turnEnd))).toBe(true);
    expect(hold.active).toBe(false);
    expect(withRestartHold({ busy: false }, hold)).toEqual({ busy: false });
    expect(changes).toHaveBeenCalledTimes(2);
  });

  it("已经排着：照实说；被拒、没接入：撤掉忙，照实说", async () => {
    const again = fakeManage({ restartSelf: () => ({ ok: true, queued: true, already: true }) });
    expect((await tools(again.manage).run(LSM_TOOL.restartSelf, {})).text).toBe("已经排着一次了：二狗空闲了就会重启，重启后这段对话接着在。不用再排。");
    const hold = createRestartSelfHold();
    const refused = fakeManage({ restartSelf: () => ({ ok: false, error: { code: "no-capability", message: "ergo-daemon 接入时没报 restart 能力" } }) });
    const out = await tools(refused.manage, hold).run(LSM_TOOL.restartSelf, {});
    expect(out).toEqual({ text: "没做成：ergo-daemon 接入时没报 restart 能力\n照实告诉用户，别说已经做了。", isError: true });
    expect(hold.active).toBe(false);
    expect((await tools(undefined, hold).run(LSM_TOOL.restartSelf, {})).isError).toBe(true);
    expect(hold.active).toBe(false);
  });

  it("一直等不到这一轮说完：最多等 maxMs 也放开（不挡重启）", async () => {
    vi.useFakeTimers();
    try {
      const hold = createRestartSelfHold({ maxMs: 1_000 });
      hold.begin();
      vi.advanceTimersByTime(999);
      expect(hold.active).toBe(true);
      vi.advanceTimersByTime(1);
      expect(hold.active).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("守卫：类别整个工具固定，对话审批关着时普通的直接做、要批准的照旧问", () => {
  const all = tools(fakeManage().manage).list;
  const registry = { ...BUILTIN_TOOL_REGISTRY, ...Object.fromEntries(all.map((tool) => [tool.descriptor.name, tool.descriptor])) };
  const ARGS: Record<string, Record<string, unknown>> = {
    [LSM_TOOL.status]: {},
    [LSM_TOOL.logs]: { service: "comfyui" },
    [LSM_TOOL.control]: { action: "stop", service: "comfyui" },
    [LSM_TOOL.force]: { action: "force_stop", service: "audiocpp" },
    [LSM_TOOL.entries]: { action: "expose_on", service: "web-server" },
    [LSM_TOOL.restartSelf]: { reason: "改了配置要生效" },
  };

  it("登记：名字、类别、只看、只读或幂等", () => {
    expect(all.map((tool) => [tool.descriptor.name, tool.descriptor.title, tool.descriptor.categories, tool.descriptor.nature ?? null, tool.descriptor.readOnlyOrIdempotent])).toEqual([
      ["lsm_status", "看服务管家", [], "look", true],
      ["lsm_logs", "看服务的日志", [], "look", true],
      ["lsm_control", "开关服务", [], null, false],
      ["lsm_force", "服务管家里要批准的操作", ["irreversible_commit"], "modify", false],
      ["lsm_entries", "开关服务的外网入口", ["account_security"], null, false],
      ["lsm_restart_self", "等空闲后重启二狗", ["irreversible_commit"], null, true],
    ]);
    // 要批准的类别都落在秘书特别敏感的那几类里
    for (const tool of all) for (const c of tool.descriptor.categories) expect(SECRETARY_ASKS.has(c)).toBe(true);
  });

  for (const approvals of ["off", "on"] as const) {
    it(`对话审批${approvals === "off" ? "关着" : "开着"}：只读、普通的直接做（只记录），要批准的先问`, () => {
      const judged = all.map((tool) => {
        const j = judgeToolCall({ ...inChat(secretary(), call(tool.descriptor.name, ARGS[tool.descriptor.name]!)), tools: registry, conversationApprovals: approvals });
        expect(j.hardRefusal).toBeNull();
        return [tool.descriptor.name, j.disposition, judgementExecutes(j)];
      });
      expect(judged).toEqual([
        ["lsm_status", "log_only", true],
        ["lsm_logs", "log_only", true],
        ["lsm_control", "log_only", true],
        ["lsm_force", "ask_first", false],
        ["lsm_entries", "ask_first", false],
        ["lsm_restart_self", "ask_first", false],
      ]);
    });
  }
});
