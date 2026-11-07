// 原型里的设置 · 服务（428）：演示页没有服务管家，这里编一份"服务管家的全部服务"，里面混着和二狗无关的（短剧站、画图和它的隧道），
// 用和守护进程同一份判定（协议包的 ergoRelated）挑出和二狗有关的再给页面——页面上不该出现无关的那几个。
// 编的样子照 11-07 那天：二狗经外网隧道出网、开着 tailnet 入口；手工登记的语音合成 audiocpp 起不来（出错了，没有正常停止办法）；
// 语音识别 ergo-asr 在跑；二狗名下有记账本的网页；一个登记里标了 ergo: true 的笔记同步停着。
// 操作只改内存里的样子，和守护进程一样要一会儿；受保护的停止、重启、关开机自启回 protected；没有正常停止办法的停止、重启写"强制的"。
// ?demo-services=disabled|waiting|unsupported|error 看几种取不到列表的样子。全是编的，没有真实信息。
import type { ErgoRelatedService, ManagedServiceAction, ManagedServiceActionResult, ManagedServiceLogsView, ManagedServicesView, ManagedServiceView } from "../state/index.ts";
import { ergoRelated, MANAGED_SERVICE_GUARDED_ACTIONS } from "../state/index.ts";
import { demoParam } from "./fake-connection.ts";

/** 假服务管家里的一个服务 */
interface FakeService extends ErgoRelatedService {
  title: string;
  state: string;
  autostart: boolean;
  since: number | null;
  lastError: string | null;
  capabilities: string[];
  pendingStop: boolean;
  busyReason: string | null;
  protectedWhy: string[];
}

const MIN = 60_000;
const SELF = "ergo-daemon";
const GATEWAY = "tail-gw";
/** 二狗配置里语音合成、语音识别的端口（原型编的，和服务管家里登记的对上） */
const VOICE = { speechPort: 8090, recognizerPort: 8091 };

function fakeServices(now: number): FakeService[] {
  const one = (id: string, title: string, extra: Partial<FakeService>): FakeService => ({
    id,
    title,
    port: null,
    state: "RUNNING",
    autostart: false,
    since: now - 50 * MIN,
    lastError: null,
    capabilities: ["start", "stop"],
    pendingStop: false,
    busyReason: null,
    protectedWhy: [],
    ...extra,
  });
  return [
    one("drama-server", "短剧站", { port: 3000, autostart: true }),
    one(SELF, "二狗", {
      port: 8810,
      autostart: true,
      since: now - 192 * MIN,
      capabilities: ["start", "busy", "stop", "restart", "health"],
      via: "ergo-tunnel",
      tailnet: true,
      dependsOn: [{ id: "audiocpp", type: "soft" }],
      protectedWhy: ["调用方自己"],
    }),
    one("ergo-tunnel", "二狗的外网隧道", { role: "tunnel", autostart: true, since: now - 191 * MIN, protectedWhy: ["ergo-daemon 的公网隧道（exposure.via）"] }),
    one(GATEWAY, "tailnet 网关", { port: 8443, autostart: true, since: now - 26 * 60 * MIN, protectedWhy: ["tailnet 网关（ergo-daemon 开着 tailnet 入口）"] }),
    one("audiocpp", "语音合成（audio.cpp）", { port: 8090, state: "FAILED", autostart: true, since: null, capabilities: ["start", "health"], lastError: "进程启动 3 秒后退出（退出码 1）：显存不够" }),
    one("ergo-asr", "语音识别", { port: 8091, capabilities: ["start", "stop", "restart"], since: now - 47 * MIN }),
    one("ergo-daemon--p-ledger-web", "记账本 · 网页", { port: 18600, autostart: true, since: now - 5 * 60 * MIN }),
    one("comfyui", "画图", { port: 8188, via: "comfy-tunnel" }),
    one("comfy-tunnel", "画图的隧道", { role: "tunnel" }),
    one("notes-sync", "笔记同步", { port: 7000, state: "STOPPED", since: null, ergo: true }),
  ];
}

const UP = ["RUNNING", "DEGRADED"];

/** 假的日志（程序自己打的，原样是英文） */
const FAKE_LOGS: Readonly<Record<string, string>> = {
  audiocpp: [
    "[15:42:01] audio.cpp 0.9.3 starting, models: tts, asr",
    "[15:42:01] listening on 127.0.0.1:8090",
    "[15:42:02] loading tts (fish-s2-pro-q8)...",
    "[15:42:04] CUDA error: out of memory (need 6.1 GB, free 3.8 GB)",
    "[15:42:04] hf_token=***",
    "[15:42:04] exit code 1",
  ].join("\n"),
};

export class FakeManagedServices {
  private readonly services: FakeService[] = fakeServices(Date.now());

  private related(): Map<string, ManagedServiceView["uses"]> {
    return ergoRelated(this.services, { self: SELF, ...VOICE, tailnetGateway: GATEWAY });
  }

  private viewOf(s: FakeService, uses: ManagedServiceView["uses"]): ManagedServiceView {
    const up = UP.includes(s.state);
    const own = this.services.find((x) => x.id === SELF);
    const kind = s.id === SELF ? "self" : own?.via === s.id ? "tunnel" : s.id === GATEWAY ? "gateway" : "other";
    return {
      id: s.id,
      title: s.title,
      state: s.state,
      up,
      port: s.port ?? null,
      autostart: s.autostart,
      since: up ? s.since : null,
      lastError: s.lastError,
      uses,
      canStop: s.capabilities.includes("stop"),
      canRestart: s.capabilities.includes("restart"),
      busy: s.busyReason !== null,
      busyReason: s.busyReason,
      pendingStop: s.pendingStop,
      ...(s.protectedWhy.length > 0 ? { protection: { kind, why: s.protectedWhy } } : {}),
    };
  }

  view(): Promise<ManagedServicesView> {
    const base = { at: Date.now(), managerUrl: "http://127.0.0.1:7420/" };
    const mode = demoParam("demo-services");
    if (mode === "disabled" || mode === "waiting" || mode === "unsupported") return Promise.resolve({ support: mode, services: [], ...base });
    if (mode === "error") return Promise.resolve({ support: "supported", services: [], error: { code: "timeout", message: "服务管家 30 秒没回话" }, ...base });
    const services = [...this.related()].map(([id, uses]) => this.viewOf(this.services.find((s) => s.id === id)!, uses));
    return Promise.resolve({ support: "supported", services, ...base });
  }

  act(id: string, action: ManagedServiceAction): Promise<ManagedServiceActionResult> {
    // 和守护进程一样要一会儿（启动等就绪、强制停先等）
    return new Promise((resolve) => setTimeout(() => resolve(this.actNow(id, action)), 600));
  }

  private actNow(id: string, action: ManagedServiceAction): ManagedServiceActionResult {
    const uses = this.related().get(id);
    const s = this.services.find((x) => x.id === id);
    if (!uses || !s) return { ok: false, action, code: "not-related", message: "" };
    if (s.protectedWhy.length > 0 && MANAGED_SERVICE_GUARDED_ACTIONS.includes(action)) return { ok: false, action, code: "protected", message: s.protectedWhy.join(", "), service: this.viewOf(s, uses) };
    const up = UP.includes(s.state);
    let forced = false;
    let already = false;
    switch (action) {
      case "start":
        if (up) already = true;
        else Object.assign(s, { state: "RUNNING", since: Date.now(), lastError: null });
        break;
      case "stop":
      case "force_stop":
        if (!up) already = true;
        else {
          forced = action === "stop" && !s.capabilities.includes("stop");
          Object.assign(s, { state: "STOPPED", since: null, pendingStop: false });
        }
        break;
      case "restart":
        forced = up && !s.capabilities.includes("restart");
        Object.assign(s, { state: "RUNNING", since: Date.now(), lastError: null });
        break;
      case "cancel_stop":
        s.pendingStop = false;
        break;
      case "autostart_on":
      case "autostart_off":
        s.autostart = action === "autostart_on";
        break;
    }
    return { ok: true, action, ...(forced ? { forced: true } : {}), ...(already ? { already: true } : {}), service: this.viewOf(s, uses) };
  }

  logs(id: string, source = 0): Promise<ManagedServiceLogsView> {
    if (!this.related().has(id)) return Promise.resolve({ ok: false, id, code: "not-related", message: "" });
    const sources = [{ source: 0, label: "命令行输出" }];
    if (source !== 0) return Promise.resolve({ ok: false, id, code: "not-found", message: `${id} 没有第 ${source} 份日志` });
    const raw = FAKE_LOGS[id] ?? "[09:00:00] started\n[09:00:01] ready";
    return Promise.resolve({ ok: true, id, source, label: "命令行输出", lines: raw.split("\n"), cut: false, sources });
  }
}
