// 语音合成在组件页一键装（345 号票，ADR-0038）：假程序（解开的假 zip + 服务管家"拉起"时在清单写的端口上起假语音服务）+ 假下载站 + 假服务管家
// （LSM 替身，经真的 lsm/link.ts 接入）跑通：安装 → 生成配置 → 登记 → 启动 → 健康检查 → 进名单 → 语音合成调得到。
// 端口都是系统挑的，不碰 8090；不联网；不跑真的 audio.cpp。
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import type { ComponentsView } from "@ergo/protocol";
import { describe, expect, onTestFinished, test } from "vitest";
import { type AudioCppHost, type AudioCppHostOptions, createAudioCppHost } from "../../src/components/audiocpp-host.ts";
import { createHttpTransport, createComponents, loadManifest, parseManifest, type RecognizerLink } from "../../src/components/index.ts";
import type { LoadedManifest } from "../../src/components/manifest.ts";
import { DISABLED_LSM_SERVICES, linkToLsm, type LsmServiceDefinition, type LsmServices } from "../../src/lsm/link.ts";
import { createAudioCppSynthesizer } from "../../src/voice/speech.ts";
import { blob, type FakeDownloads, makeZip, sha256, startFakeDownloads } from "../helpers/fake-downloads.ts";
import { type LsmStandIn, startLsmStandIn } from "../helpers/lsm-stand-in.ts";
import { waitUntil } from "../helpers/process.ts";
import { makeTempDir } from "../helpers/temp-dir.ts";
import { type FakeSpeechService, makeWav, startFakeSpeechService } from "../helpers/tts.ts";

const PROGRAM_ZIP = makeZip([
  { name: "audiocpp_server.exe", body: blob(4000, 1) },
  { name: "ggml-cuda.dll", body: blob(3000, 2) },
  { name: "model_specs/fish_audio.json", body: "{}" },
]);
const RUNTIME_ZIP = makeZip([
  { name: "cudart64_13.dll", body: blob(2000, 3) },
  { name: "cublas64_13.dll", body: blob(2000, 4) },
]);
const CPU_ZIP = makeZip([{ name: "audiocpp_server.exe", body: blob(1000, 5) }]);
/** 新版包里的结构没实际核对过：程序套在一层目录里也要能用 */
const NESTED_PROGRAM_ZIP = makeZip([
  { name: "audio-v0.9.3/", directory: true },
  { name: "audio-v0.9.3/audiocpp_server.exe", body: blob(4000, 1) },
  { name: "audio-v0.9.3/ggml-cuda.dll", body: blob(3000, 2) },
]);
const MODEL = blob(120_000, 6);
const OTHER_MODEL = blob(80_000, 7);
const GGUF = "Fish-Audio-S2-Pro-GGUF/fish-audio-s2-pro-q8_0.gguf";

const zipFile = (name: string, body: Buffer, to = "bin") => ({ path: name, size: body.length, sha256: sha256(body), extract: { format: "zip" as const, to } });

/** 随程序发布的那两条（许可、推荐、service、serve 都是真的），只把文件换成假下载站上的小文件、端口换成系统挑的 */
function testManifest(fake: FakeDownloads, port: number, over: { version?: string; revision?: string; extra?: boolean; nestedProgram?: boolean } = {}): LoadedManifest {
  const shipped = loadManifest().manifest.components;
  const audiocpp = shipped.find((c) => c.id === "audiocpp")!;
  const tts = shipped.find((c) => c.id === "tts")!;
  fake.put("bin-cuda.zip", over.nestedProgram ? NESTED_PROGRAM_ZIP : PROGRAM_ZIP);
  fake.put("rt-cuda.zip", RUNTIME_ZIP);
  fake.put("bin-cpu.zip", CPU_ZIP);
  fake.put(GGUF, MODEL);
  fake.put("asr/model.gguf", OTHER_MODEL);
  const sources = [{ id: "a", title: "镜像 A", url: fake.source("a") }];
  return {
    signed: false,
    manifest: parseManifest({
      format: 1,
      release: "test",
      components: [
        {
          ...audiocpp,
          version: over.version ?? audiocpp.version,
          sources,
          service: { ...audiocpp.service!, port },
          variants: [
            { id: "cuda", when: { gpu: "nvidia" }, expects: ["cudart64_*.dll", "cublas64_*.dll"], parts: [{ files: [zipFile("bin-cuda.zip", over.nestedProgram ? NESTED_PROGRAM_ZIP : PROGRAM_ZIP), { ...zipFile("rt-cuda.zip", RUNTIME_ZIP), extract: { format: "zip" as const, to: "bin", beside: "audiocpp_server.exe" } }] }] },
            { id: "cpu", parts: [{ files: [zipFile("bin-cpu.zip", CPU_ZIP)] }] },
          ],
        },
        {
          ...tts,
          ...(over.revision !== undefined ? { license: { ...tts.license!, revision: over.revision } } : {}),
          sources,
          variants: [{ id: "q8", parts: [{ files: [{ path: GGUF, size: MODEL.length, sha256: sha256(MODEL) }] }] }],
        },
        // 346 号票的样子：再加一条带 serve 的组件，用同一个程序
        ...(over.extra
          ? [
              {
                id: "asr-nano",
                version: "1",
                default: "ask",
                enables: [],
                dependsOn: ["audiocpp"],
                target: "components/asr-nano",
                sources,
                serve: { host: "audiocpp", id: "asr", family: "funasr_nano", task: "asr", mode: "offline", file: "asr/model.gguf" },
                variants: [{ id: "q8", parts: [{ files: [{ path: "asr/model.gguf", size: OTHER_MODEL.length, sha256: sha256(OTHER_MODEL) }] }] }],
              },
            ]
          : []),
      ],
    }),
  };
}

/**
 * 假的"服务管家拉起程序"：真的 link.ts 经 LSM 替身登记、启动（替身不起进程），这一层在替身说起来了之后把假语音服务开在端口上；
 * 开之前核对程序文件真在、配置文件读得出来（拉起的人看到的就是这些）。program.healthy 关掉时程序"起来了但健康检查一直不通"
 */
function withFakeProgram(services: LsmServices, tts: FakeSpeechService, configs: unknown[], program: { healthy: boolean }): LsmServices {
  let definition: LsmServiceDefinition | undefined;
  let running = false;
  const down = async () => {
    if (running) await tts.down();
    running = false;
  };
  const up = async () => {
    const argv = definition?.argv ?? [];
    expect(fs.existsSync(argv[0]!), `程序 ${argv[0]} 要在`).toBe(true);
    configs.push(JSON.parse(fs.readFileSync(path.join(definition!.cwd, argv[2]!), "utf8")));
    if (program.healthy && !running) {
      await tts.up();
      running = true;
    }
  };
  return {
    get support() {
      return services.support;
    },
    put: (d) => {
      definition = d;
      return services.put(d);
    },
    start: async (name) => {
      const reply = await services.start(name);
      if (reply.ok) await up();
      return reply;
    },
    restart: async (name, options) => {
      await down();
      const reply = await services.restart(name, options);
      if (reply.ok) await up();
      return reply;
    },
    stop: async (name, options) => {
      await down();
      return services.stop(name, options);
    },
    remove: async (name) => {
      await down();
      return services.remove(name);
    },
    autostart: (name, on) => services.autostart(name, on),
    list: () => services.list(),
    onStatus: (listener) => services.onStatus(listener),
    onSupport: (listener) => services.onSupport(listener),
  };
}

interface Setup {
  root: string;
  componentsDir: string;
  fake: FakeDownloads;
  tts: FakeSpeechService;
  port: number;
  lsm: LsmStandIn;
  host: AudioCppHost;
  /** 假程序每次被拉起时读到的配置 */
  configs: { host: string; port: number; backend: string; threads: number; lazy_load: boolean; models: { id: string; family: string; path: string; task: string; mode: string }[] }[];
  program: { healthy: boolean };
  components: ReturnType<typeof createComponents>;
  logs: string[];
  restart(over?: { version?: string; revision?: string; extra?: boolean; gpu?: "nvidia" | "none"; nestedProgram?: boolean }): Promise<void>;
  view(): ComponentsView;
  installAll(): Promise<void>;
  settled(): Promise<void>;
  configPath: string;
  requests(type: string): Record<string, unknown>[];
}

interface SetupOptions {
  gpu?: "nvidia" | "none";
  url?: string;
  /** 不接服务管家 */
  noLsm?: boolean;
  componentsDir?: string;
  extra?: boolean;
  nestedProgram?: boolean;
  /** 换一份清单（在假下载站上放不一样的包） */
  manifest?: (s: Pick<Setup, "fake" | "port">) => LoadedManifest;
  /** 接上之前动一下替身（名下已有同名的登记……） */
  beforeLink?: (lsm: LsmStandIn, port: number) => void;
  wrap?: (services: LsmServices) => LsmServices;
  host?: Partial<AudioCppHostOptions>;
}

async function setup(options: SetupOptions = {}): Promise<Setup> {
  const fake = await startFakeDownloads();
  const root = makeTempDir();
  const componentsDir = options.componentsDir ?? path.join(root, "components");
  const tts = await startFakeSpeechService();
  const port = Number(new URL(tts.url).port);
  await tts.down();
  const lsm = await startLsmStandIn({ owned: true });
  options.beforeLink?.(lsm, port);
  const logs: string[] = [];
  const link = options.noLsm ? undefined : linkToLsm({ env: lsm.env, port: 1, version: "test", busy: () => ({ busy: false }), health: () => "ok", onShutdown: async () => {}, onConflict: () => {}, log: (l) => logs.push(l) });
  if (link) onTestFinished(() => link.close());
  const configs: Setup["configs"] = [];
  const program = { healthy: true };
  const log = (line: string) => logs.push(line);
  const services = link ? withFakeProgram(link.services, tts, configs, program) : DISABLED_LSM_SERVICES;
  const wrapped = options.wrap ? options.wrap(services) : services;
  const build = (over: Parameters<Setup["restart"]>[0] = {}) => {
    const host = createAudioCppHost({ componentsDir, speech: { url: options.url ?? `http://127.0.0.1:${port}`, model: "tts" }, healthTimeoutMs: 800, healthPollMs: 20, probeTimeoutMs: 400, cpuThreads: 4, log, ...options.host });
    host.attachLsm(wrapped);
    const components = createComponents({
      root,
      componentsDir,
      manifest: options.manifest ? options.manifest({ fake, port }) : testManifest(fake, port, { extra: options.extra === true, nestedProgram: options.nestedProgram === true, ...over }),
      probes: { gpu: () => over.gpu ?? options.gpu ?? "none", detect: () => undefined, provided: (id) => (id === "voice-speech" ? host.provided() : undefined) },
      transport: createHttpTransport({ headersTimeoutMs: 5000 }),
      host,
      diskMargin: 0,
      freeBytes: () => Number.MAX_SAFE_INTEGER,
      stallMs: 2000,
      log,
    });
    return { host, components };
  };
  // 和守护进程一样：接入层建好马上接上（接入时推的那次全量才收得到）
  const first = build();
  if (link) await waitUntil(() => link.services.support === "supported");
  const s: Setup = {
    root,
    componentsDir,
    fake,
    tts,
    port,
    lsm,
    host: first.host,
    components: first.components,
    configs,
    program,
    logs,
    configPath: path.join(componentsDir, "audiocpp-service", "server.json"),
    async restart(over) {
      await s.components.stop();
      const next = build(over);
      s.host = next.host;
      s.components = next.components;
    },
    view: () => s.components.view(),
    async settled() {
      await s.components.whenIdle();
      await s.host.whenIdle();
    },
    async installAll() {
      await s.components.act("tts", "install", { licenseAccepted: true });
      await s.settled();
    },
    requests: (type) => lsm.serviceRequests().filter((m) => m.type === type),
  };
  onTestFinished(() => s.components.stop());
  return s;
}

const one = (view: ComponentsView, id: string) => view.components.find((c) => c.id === id)!;

describe("装：程序、模型、接上服务管家", () => {
  test("确认过许可才下载：下程序再下模型 → 生成配置 → 登记 → 启动 → 健康检查 → 进名单 → 语音合成调得到", async () => {
    const s = await setup();
    await s.components.refresh();
    expect(one(s.view(), "tts")).toMatchObject({ state: "missing", recommended: true, license: { name: "Fish Audio Research License", confirm: true, accepted: false, attribution: "Built with Fish Audio" }, dependsOn: ["audiocpp"] });
    expect(one(s.view(), "tts").license?.summary).toBe("个人非商业免费；商业使用要另外向 Fish Audio 取得授权");
    expect(one(s.view(), "audiocpp")).toMatchObject({ state: "missing", license: { name: "Apache-2.0", confirm: false, accepted: true } });

    await s.installAll();

    expect(one(s.view(), "audiocpp")).toMatchObject({ state: "installed", version: "0.9.3", service: { state: "running", port: s.port, autostart: true } });
    expect(one(s.view(), "tts")).toMatchObject({ state: "installed", license: { accepted: true } });
    expect(s.view().features.find((f) => f.feature === "voice.reply")).toMatchObject({ component: "tts", ready: true });

    // 配置：只绑 127.0.0.1、端口、lazy_load、模型 id 用配置里的、CPU 版的后端和线程
    expect(s.configs).toHaveLength(1);
    expect(s.configs[0]).toEqual({
      host: "127.0.0.1",
      port: s.port,
      backend: "cpu",
      device: 0,
      threads: 4,
      lazy_load: true,
      models: [{ id: "tts", family: "fish_audio", path: path.join(s.root, "components", "tts", ...GGUF.split("/")), task: "tts", mode: "offline" }],
    });
    expect(fs.readFileSync(s.configs[0]!.models[0]!.path).equals(MODEL)).toBe(true);

    // 服务管家：登记（命令是装好的程序，不写 autostart）→ 启动 → 进名单
    const registered = s.lsm.owned.services.get("audiocpp")!;
    expect(registered.definition).toMatchObject({ name: "audiocpp", argv: [path.join(s.root, "components", "audiocpp", "bin", "audiocpp_server.exe"), "--config", "server.json"], cwd: path.dirname(s.configPath), port: s.port, health: { path: "/health" } });
    expect(registered.autostart).toBe(true);
    expect(registered.state).toBe("RUNNING");
    expect(s.requests("services.autostart").at(-1)).toMatchObject({ name: "audiocpp", on: true });
    // 次序：先试登记并撤掉（查手写的服务），再正式登记、启动、进名单
    expect(s.lsm.serviceRequests().map((m) => m.type)).toEqual(["services.put", "services.remove", "services.put", "services.start", "services.autostart"]);

    // 语音回复照配置调得到（和语音插件用的是同一个客户端）
    const voice = path.join(s.root, "ref.wav");
    fs.writeFileSync(voice, makeWav(1));
    const synth = createAudioCppSynthesizer({ url: `http://127.0.0.1:${s.port}`, model: "tts", timeout: { baseMs: 5000, coldStartMs: 0, perSpeechSecond: 1 }, log: () => {} });
    expect(await synth.health()).toEqual({ up: true });
    const out = await synth.synthesize({ text: "你好呀", voiceId: "v-1", voiceRef: voice, referenceText: "参考" }, { estimatedSeconds: 1 });
    expect(out.wav.length).toBeGreaterThan(44);
    expect(s.tts.requests.at(-1)).toMatchObject({ model: "tts", input: "你好呀" });
  });

  test("有 N 卡：CUDA 版的程序包和运行库包解到同一处、配置写 cuda；程序放在一层目录里也找得到", async () => {
    const s = await setup({ gpu: "nvidia" });
    await s.installAll();
    const bin = path.join(s.root, "components", "audiocpp", "bin");
    expect(fs.readdirSync(bin).toSorted()).toEqual(["audiocpp_server.exe", "cublas64_13.dll", "cudart64_13.dll", "ggml-cuda.dll", "model_specs"]);
    expect(s.configs[0]).toMatchObject({ backend: "cuda", threads: 1 });
    expect(one(s.view(), "audiocpp")).toMatchObject({ variant: { id: "cuda" }, size: PROGRAM_ZIP.length + RUNTIME_ZIP.length });
    expect(one(s.view(), "tts").note).toBeUndefined();
  });

  test("程序在包里套了一层目录（新版包的结构没实际核对过）：运行库照样放到程序旁边，登记的是找到的那个程序", async () => {
    const s = await setup({ gpu: "nvidia", nestedProgram: true });
    await s.installAll();
    const dir = path.join(s.root, "components", "audiocpp", "bin", "audio-v0.9.3");
    expect(fs.readdirSync(dir).toSorted()).toEqual(["audiocpp_server.exe", "cublas64_13.dll", "cudart64_13.dll", "ggml-cuda.dll"]);
    expect(s.lsm.owned.services.get("audiocpp")?.definition.argv).toEqual([path.join(dir, "audiocpp_server.exe"), "--config", "server.json"]);
    expect(one(s.view(), "audiocpp").service?.state).toBe("running");
  });

  test("没有 N 卡：挑 CPU 包、模型这一行写明没有显卡会很慢", async () => {
    const s = await setup({ gpu: "none" });
    expect(one(s.view(), "audiocpp").variant).toMatchObject({ id: "cpu", reason: "这台电脑没找到 N 卡" });
    expect(one(s.view(), "tts").note).toBe("这台电脑没有 NVIDIA 显卡：也能用，但没有显卡会很慢");
  });

  test("只装程序：没有模型不登记，写明等模型；之后装模型自动接上", async () => {
    const s = await setup();
    await s.components.act("audiocpp", "install");
    await s.settled();
    expect(one(s.view(), "audiocpp")).toMatchObject({ state: "installed", service: { state: "idle", note: "还没有模型：装上语音合成或语音识别模型后自动启动" } });
    expect(s.lsm.owned.services.size).toBe(0);
    expect(fs.existsSync(s.configPath)).toBe(false);
    await expect(s.components.act("audiocpp", "start")).rejects.toThrow("还没有模型");
    await s.installAll();
    expect(one(s.view(), "audiocpp").service?.state).toBe("running");
  });
});

describe("许可", () => {
  test("没带确认标记：接口拒绝，一个字节都不下；重试（继续）也一样", async () => {
    const s = await setup();
    await expect(s.components.act("tts", "install")).rejects.toMatchObject({ code: "not_allowed", message: expect.stringContaining("Fish Audio Research License") });
    expect(s.fake.requests).toEqual([]);
    expect(one(s.view(), "tts").state).toBe("missing");
    expect(fs.existsSync(path.join(s.componentsDir, "licenses.json"))).toBe(false);
    await expect(s.components.act("tts", "install", { licenseAccepted: false })).rejects.toThrow("要先确认");
    expect(s.fake.requests).toEqual([]);
  });

  test("确认过的记住：重启、删了再装都不再问；许可换了版本要重新确认；程序不用确认", async () => {
    const s = await setup();
    await s.components.act("audiocpp", "install");
    await s.settled();
    await s.installAll();
    const saved = JSON.parse(fs.readFileSync(path.join(s.componentsDir, "licenses.json"), "utf8")) as { accepted: Record<string, { name: string; revision: string }> };
    expect(saved.accepted.tts).toMatchObject({ name: "Fish Audio Research License", revision: "2026-03-07" });

    await s.components.act("tts", "remove");
    await s.host.whenIdle();
    await s.restart();
    expect(one(s.view(), "tts")).toMatchObject({ state: "missing", license: { accepted: true } });
    await s.components.act("tts", "install");
    await s.settled();
    expect(one(s.view(), "tts").state).toBe("installed");

    await s.components.act("tts", "remove");
    await s.host.whenIdle();
    await s.restart({ revision: "2027-01-01" });
    expect(one(s.view(), "tts").license?.accepted).toBe(false);
    await expect(s.components.act("tts", "install")).rejects.toThrow("要先确认");
  });

  test("离线导入凑齐了也要先确认：导入不开始装，写明；确认后接着装", async () => {
    const s = await setup();
    await s.components.act("audiocpp", "install");
    await s.settled();
    const file = path.join(s.root, "fish.gguf");
    fs.writeFileSync(file, MODEL);
    await s.components.importFrom(file);
    await s.settled();
    expect(one(s.view(), "tts")).toMatchObject({ state: "failed", error: expect.stringContaining("要先确认许可") });
    await expect(s.components.act("tts", "resume")).rejects.toThrow("要先确认");
    await s.components.act("tts", "resume", { licenseAccepted: true });
    await s.settled();
    expect(one(s.view(), "tts").state).toBe("installed");
    expect(one(s.view(), "audiocpp").service?.state).toBe("running");
    expect(s.fake.requests.some((r) => r.path === GGUF)).toBe(false);
  });
});

describe("中途失败：回滚，写清哪一步、什么原因", () => {
  test("启动没起来：撤登记、删配置，文件留着；点重试不重新下载，接上", async () => {
    const s = await setup({ beforeLink: () => {} });
    s.lsm.owned.failNextStart("audiocpp", "端口被 node.exe (1234) 占着");
    await s.installAll();
    const service = one(s.view(), "audiocpp").service!;
    expect(service.state).toBe("failed");
    expect(service.error).toContain("启动这一步");
    expect(service.error).toContain("端口被 node.exe (1234) 占着");
    expect(s.lsm.owned.services.has("audiocpp")).toBe(false);
    expect(fs.existsSync(s.configPath)).toBe(false);
    expect(one(s.view(), "tts").state).toBe("installed");

    const downloads = s.fake.requests.length;
    await s.components.act("audiocpp", "start");
    expect(one(s.view(), "audiocpp").service?.state).toBe("starting");
    await s.host.whenIdle();
    expect(one(s.view(), "audiocpp").service).toMatchObject({ state: "running", autostart: true });
    expect(s.fake.requests.length).toBe(downloads);
    expect(one(s.view(), "audiocpp").service?.error).toBeUndefined();
  });

  test("起来了但健康检查一直不通：写明是等健康检查这一步，撤掉", async () => {
    const s = await setup();
    s.program.healthy = false;
    await s.installAll();
    const service = one(s.view(), "audiocpp").service!;
    expect(service.state).toBe("failed");
    expect(service.error).toContain("等健康检查这一步");
    expect(service.error).toContain(`http://127.0.0.1:${s.port}/health`);
    expect(s.lsm.owned.services.has("audiocpp")).toBe(false);
    expect(fs.existsSync(s.configPath)).toBe(false);
  });

  test.each([
    ["put", "在服务管家登记这一步", "定义不合规"],
    ["autostart", "进开机自启名单这一步", "autostart.yaml 坏了"],
  ] as const)("%s 失败：写明哪一步、什么原因，撤掉", async (method, stepText, reason) => {
    let armed = false;
    const s = await setup({
      wrap: (services) => {
        const copy = Object.create(services) as LsmServices;
        const original = services[method].bind(services) as (...args: never[]) => ReturnType<LsmServices["put"]>;
        (copy as unknown as Record<string, unknown>)[method] = (...args: never[]) => (armed && (method !== "autostart" || args[1] === (true as never)) ? Promise.resolve({ ok: false, error: { code: "registry", message: reason } }) : original(...args));
        return copy;
      },
    });
    await s.components.act("audiocpp", "install");
    await s.settled();
    armed = true;
    await s.installAll();
    const service = one(s.view(), "audiocpp").service!;
    expect(service.state).toBe("failed");
    expect(service.error).toContain(stepText);
    expect(service.error).toContain(reason);
    expect(s.lsm.owned.services.has("audiocpp")).toBe(false);
    expect(fs.existsSync(s.configPath)).toBe(false);
  });

  test("包里没有服务程序：写明，不登记", async () => {
    const s = await setup({
      wrap: (services) => services,
    });
    await s.components.act("audiocpp", "install");
    await s.settled();
    fs.rmSync(path.join(s.root, "components", "audiocpp", "bin", "audiocpp_server.exe"));
    await s.installAll();
    const service = one(s.view(), "audiocpp").service!;
    expect(service.state).toBe("failed");
    expect(service.error).toContain("生成配置这一步");
    expect(service.error).toContain("audiocpp_server.exe");
    expect(s.requests("services.start")).toEqual([]);
  });
});

describe("下载失败（国内访问 GitHub 可能慢或不通）", () => {
  test("组件页给下载地址和手动导入的办法；只列还差的文件；两个包导入齐了装上，模型重试后接上服务", async () => {
    const s = await setup({ gpu: "nvidia" });
    s.fake.behave("a", { kind: "broken" });
    await s.components.act("tts", "install", { licenseAccepted: true });
    await s.settled();
    const failed = one(s.view(), "audiocpp");
    expect(failed.state).toBe("failed");
    expect(failed.error).toContain("下不下来");
    expect(failed.manualDownload).toEqual([
      { name: "bin-cuda.zip", size: PROGRAM_ZIP.length, links: [{ title: "镜像 A", url: `${s.fake.url}/a/bin-cuda.zip` }] },
      { name: "rt-cuda.zip", size: RUNTIME_ZIP.length, links: [{ title: "镜像 A", url: `${s.fake.url}/a/rt-cuda.zip` }] },
    ]);
    // 模型是因为程序没装好才停的：它自己不用手动下
    expect(one(s.view(), "tts")).toMatchObject({ state: "failed", error: expect.stringContaining("要先装好") });
    expect(one(s.view(), "tts").manualDownload).toBeUndefined();

    // 先导入一个包：还差另一个，地址只剩它
    const folder = makeTempDir();
    const first = path.join(folder, "bin-cuda.zip");
    fs.writeFileSync(first, PROGRAM_ZIP);
    const partial = await s.components.importFrom(first);
    expect(partial.missing).toEqual([{ component: "audiocpp", files: ["rt-cuda.zip"] }]);
    expect(one(s.view(), "audiocpp").manualDownload?.map((f) => f.name)).toEqual(["rt-cuda.zip"]);

    // 另一个也导入：装好；程序不用从网上下
    const second = path.join(folder, "rt-cuda.zip");
    fs.writeFileSync(second, RUNTIME_ZIP);
    const done = await s.components.importFrom(second);
    expect(done.installed).toEqual(["audiocpp"]);
    expect(one(s.view(), "audiocpp")).toMatchObject({ state: "installed", service: { state: "idle" } });
    expect(one(s.view(), "audiocpp").manualDownload).toBeUndefined();

    s.fake.behave("a", { kind: "ok" });
    await s.components.act("tts", "resume");
    await s.settled();
    expect(one(s.view(), "audiocpp").service?.state).toBe("running");
  });

  test("暂停着也给地址（太慢不想等）；正在下的时候不给", async () => {
    const s = await setup();
    s.fake.behave("a", { kind: "slow", bytesPerTick: 100, tickMs: 50 });
    await s.components.act("audiocpp", "install");
    await waitUntil(() => one(s.view(), "audiocpp").state === "downloading");
    expect(one(s.view(), "audiocpp").manualDownload).toBeUndefined();
    await s.components.act("audiocpp", "pause");
    expect(one(s.view(), "audiocpp")).toMatchObject({ state: "paused", manualDownload: [{ name: "bin-cpu.zip" }] });
    s.fake.releaseAll();
  });

  test("程序包里找不到程序（运行库没地方放）：写明，不换上", async () => {
    const empty = makeZip([{ name: "README.md", body: "没有程序" }]);
    const s = await setup({ gpu: "nvidia" });
    const manifest = testManifest(s.fake, s.port);
    s.fake.put("bin-cuda.zip", empty);
    const audiocpp = manifest.manifest.components.find((c) => c.id === "audiocpp")!;
    const files = audiocpp.variants[0]!.parts[0]!.files!;
    files[0] = zipFile("bin-cuda.zip", empty);
    const components = createComponents({
      root: s.root,
      componentsDir: s.componentsDir,
      manifest,
      probes: { gpu: () => "nvidia", detect: () => undefined, provided: () => undefined },
      transport: createHttpTransport({ headersTimeoutMs: 5000 }),
      diskMargin: 0,
      freeBytes: () => Number.MAX_SAFE_INTEGER,
      stallMs: 2000,
      log: () => {},
    });
    onTestFinished(() => components.stop());
    await components.act("audiocpp", "install");
    await components.whenIdle();
    const c = one(components.view(), "audiocpp");
    expect(c.state).toBe("failed");
    expect(c.error).toContain("发布包里没找到 audiocpp_server.exe");
    expect(c.manualDownload).toBeUndefined();
    expect(fs.existsSync(path.join(s.root, "components", "audiocpp"))).toBe(false);
  });

  test("CPU 版的包里也找不到程序：装程序这一步就报清楚，不换上，不用等模型下完", async () => {
    const empty = makeZip([{ name: "README.md", body: "没有程序" }]);
    const s = await setup();
    const manifest = testManifest(s.fake, s.port);
    s.fake.put("bin-cpu.zip", empty);
    const audiocpp = manifest.manifest.components.find((c) => c.id === "audiocpp")!;
    audiocpp.variants[1]!.parts[0]!.files![0] = zipFile("bin-cpu.zip", empty);
    const components = createComponents({
      root: s.root,
      componentsDir: s.componentsDir,
      manifest,
      probes: { gpu: () => "none", detect: () => undefined, provided: () => undefined },
      transport: createHttpTransport({ headersTimeoutMs: 5000 }),
      diskMargin: 0,
      freeBytes: () => Number.MAX_SAFE_INTEGER,
      stallMs: 2000,
      log: () => {},
    });
    onTestFinished(() => components.stop());
    await components.act("tts", "install", { licenseAccepted: true });
    await components.whenIdle();
    expect(one(components.view(), "audiocpp")).toMatchObject({ state: "failed", error: expect.stringContaining("发布包里没找到 audiocpp_server.exe") });
    expect(fs.existsSync(path.join(s.root, "components", "audiocpp"))).toBe(false);
    // 模型没开始下
    expect(s.fake.requests.some((r) => r.path === GGUF)).toBe(false);
  });

  describe("CUDA 运行库不全", () => {
    /** 运行库包里少了 cublas：装得上，名字对不上清单写的 */
    const partialRuntime = makeZip([{ name: "cudart64_13.dll", body: "rt" }]);
    function withPartialRuntime(s: Pick<Setup, "fake" | "port">) {
      const manifest = testManifest(s.fake, s.port);
      s.fake.put("rt-cuda.zip", partialRuntime);
      const audiocpp = manifest.manifest.components.find((c) => c.id === "audiocpp")!;
      const variant = audiocpp.variants[0]!;
      variant.expects = ["cudart64_*.dll", "cublas64_*.dll", "cublasLt64_*.dll"];
      variant.parts[0]!.files![1] = { ...zipFile("rt-cuda.zip", partialRuntime), extract: { format: "zip", to: "bin", beside: "audiocpp_server.exe" } };
      return manifest;
    }

    test("起得来：照样接上，组件页写明缺哪几个、怎么办", async () => {
      const s = await setup({ gpu: "nvidia", manifest: withPartialRuntime });
      await s.installAll();
      const service = one(s.view(), "audiocpp").service!;
      expect(service.state).toBe("running");
      expect(service.warning).toContain("CUDA 运行库不全");
      expect(service.warning).toContain("cublas64_*.dll");
      expect(service.warning).toContain("cublasLt64_*.dll");
      expect(service.warning).not.toContain("cudart64_*.dll");
      expect(service.warning).toContain("rt-cuda.zip");
    });

    test("起不来：错误里连着这句话，用户知道是缺运行库", async () => {
      const s = await setup({ gpu: "nvidia", manifest: withPartialRuntime });
      s.lsm.owned.failNextStart("audiocpp", "退出码 3221225781");
      await s.installAll();
      const service = one(s.view(), "audiocpp").service!;
      expect(service.state).toBe("failed");
      expect(service.error).toContain("退出码 3221225781");
      expect(service.error).toContain("CUDA 运行库不全");
    });

    test("运行库齐的、CPU 版：没有这句话", async () => {
      const cuda = await setup({ gpu: "nvidia" });
      await cuda.installAll();
      expect(one(cuda.view(), "audiocpp").service?.warning).toBeUndefined();
      const cpu = await setup({ gpu: "none" });
      await cpu.installAll();
      expect(one(cpu.view(), "audiocpp").service?.warning).toBeUndefined();
    });
  });
});

describe("守护进程停下", () => {
  test("接到一半停了：不回滚，配置和登记留着，下次起来还认得是我们的", async () => {
    const s = await setup({ host: { healthTimeoutMs: 5000 } });
    s.program.healthy = false;
    await s.components.act("tts", "install", { licenseAccepted: true });
    await s.components.whenIdle();
    await waitUntil(() => s.lsm.owned.services.get("audiocpp")?.state === "RUNNING");
    await s.components.stop();
    await s.host.whenIdle();
    expect(fs.existsSync(s.configPath)).toBe(true);
    expect(s.lsm.owned.services.has("audiocpp")).toBe(true);
    await s.restart();
    await s.components.refresh();
    expect(s.host.provided()).toBeUndefined();
    expect(one(s.view(), "audiocpp").service?.state).toBe("stopped");
  });
});

describe("卸载", () => {
  test("删模型：撤开机名单和登记、删配置；程序也能删；删程序之前模型要先删", async () => {
    const s = await setup();
    await s.installAll();
    await expect(s.components.act("audiocpp", "remove")).rejects.toThrow("要用");
    await s.components.act("tts", "remove");
    await s.host.whenIdle();
    expect(s.requests("services.autostart").at(-1)).toMatchObject({ name: "audiocpp", on: false });
    expect(s.requests("services.remove").length).toBeGreaterThan(0);
    expect(s.lsm.owned.services.has("audiocpp")).toBe(false);
    expect(fs.existsSync(s.configPath)).toBe(false);
    expect(fs.existsSync(path.join(s.root, "components", "tts"))).toBe(false);
    expect(one(s.view(), "audiocpp")).toMatchObject({ state: "installed", service: { state: "idle" } });
    await s.components.act("audiocpp", "remove");
    expect(one(s.view(), "audiocpp").state).toBe("missing");
    expect(fs.existsSync(path.join(s.root, "components", "audiocpp"))).toBe(false);
  });

  test("服务管家撤不掉（还被别的东西用着）：说清楚，文件和配置都不动", async () => {
    let refuse = false;
    const s = await setup({
      wrap: (services) => {
        const copy = Object.create(services) as LsmServices;
        copy.remove = (name) => (refuse ? Promise.resolve({ ok: false, error: { code: "in-use", message: "还开着公网隧道" } }) : services.remove(name));
        return copy;
      },
    });
    await s.installAll();
    refuse = true;
    await expect(s.components.act("tts", "remove")).rejects.toThrow("还开着公网隧道");
    expect(fs.existsSync(path.join(s.root, "components", "tts"))).toBe(true);
    expect(fs.existsSync(s.configPath)).toBe(true);
    expect(one(s.view(), "tts").state).toBe("installed");
  });
});

/** 这台机器上已经有人在这个端口上跑语音服务 */
async function manualRunning(s: Setup) {
  await s.tts.up();
  await s.components.refresh();
}

describe("已有手动配的服务：不覆盖，显示在用它", () => {
  test("端口上已经有语音服务：两个组件都写在用它、没有安装按钮可点，接口拒绝；登记、下载、配置一样都没碰", async () => {
    const s = await setup();
    await manualRunning(s);
    for (const id of ["audiocpp", "tts"]) {
      const c = one(s.view(), id);
      expect(c.state).toBe("provided");
      expect(c.providedBy).toBe(`已有自己配的语音合成，在用它（http://127.0.0.1:${s.port}）`);
      expect(c.cannotInstall).toContain("先撤掉自己配的");
    }
    expect(s.view().features.find((f) => f.feature === "voice.reply")?.ready).toBe(true);
    await expect(s.components.act("tts", "install", { licenseAccepted: true })).rejects.toThrow("先撤掉自己配的");
    expect(s.lsm.serviceRequests()).toEqual([]);
    expect(s.fake.requests).toEqual([]);
    expect(fs.existsSync(s.configPath)).toBe(false);
  });

  test("端口有人但不是语音服务（健康检查不通）：一样不覆盖，说法不一样", async () => {
    const s = await setup();
    await s.tts.up();
    await s.tts.down();
    const other = http.createServer((_req, res) => res.writeHead(404).end());
    await new Promise<void>((resolve) => other.listen(s.port, "127.0.0.1", resolve));
    onTestFinished(() => new Promise<void>((resolve) => other.close(() => resolve())));
    await s.components.refresh();
    expect(one(s.view(), "tts").providedBy).toContain("端口上已经有别的程序");
    await expect(s.components.act("tts", "install", { licenseAccepted: true })).rejects.toThrow("不能从这里装");
  });

  test("配置里的地址指别处：算用户自己配的，不管那边通不通", async () => {
    const s = await setup({ url: "http://127.0.0.1:1" });
    await s.components.refresh();
    expect(one(s.view(), "tts")).toMatchObject({ state: "provided", providedBy: "已有自己配的语音合成，在用它（配置里写的 http://127.0.0.1:1）" });
    await expect(s.components.act("audiocpp", "install")).rejects.toThrow("先撤掉自己配的");
    expect(s.lsm.serviceRequests()).toEqual([]);
  });

  test("服务管家里手写的服务停着（端口没人听，只有登记冲突看得出来）：点安装时查出来，拒绝，不留登记；它撤了以后就能装", async () => {
    const s = await setup({ host: { registeredRecheckMs: 0 } });
    s.lsm.owned.takePort(s.port, "audiocpp");
    await s.components.refresh();
    expect(one(s.view(), "tts").state).toBe("missing");
    await expect(s.components.act("tts", "install", { licenseAccepted: true })).rejects.toThrow(`服务管家里端口 ${s.port} 已经登记了`);
    expect(s.lsm.owned.services.size).toBe(0);
    expect(s.fake.requests).toEqual([]);
    expect(one(s.view(), "tts")).toMatchObject({ state: "provided", providedBy: `已有自己配的语音合成，在用它（服务管家里端口 ${s.port} 已经登记了）` });
    expect(fs.existsSync(path.join(s.componentsDir, "licenses.json"))).toBe(false);

    await s.components.refresh();
    expect(one(s.view(), "tts").state).toBe("provided");
    s.lsm.owned.releasePort(s.port);
    await s.components.refresh();
    expect(one(s.view(), "tts").state).toBe("missing");
    expect(s.lsm.owned.services.size).toBe(0);
    await s.installAll();
    expect(one(s.view(), "audiocpp").service?.state).toBe("running");
  });

  test("名下已经有同名的登记、却不是我们生成的：不覆盖", async () => {
    const s = await setup({
      beforeLink: (lsm, port) => {
        lsm.owned.services.set("audiocpp", { definition: { name: "audiocpp", port, command: "别人写的" }, state: "STOPPED", autostart: false, lastError: null });
      },
    });
    await s.components.refresh();
    expect(one(s.view(), "tts").state).toBe("provided");
    await expect(s.components.act("tts", "install", { licenseAccepted: true })).rejects.toThrow("先撤掉自己配的");
    expect(s.lsm.owned.services.get("audiocpp")?.definition.command).toBe("别人写的");
    expect(s.requests("services.put")).toEqual([]);
  });

  test("下载的时候才冒出来手写的登记：装完不覆盖、不算失败，配置撤掉，写在用它", async () => {
    const s = await setup();
    await s.components.act("tts", "install", { licenseAccepted: true });
    s.lsm.owned.takePort(s.port, "audiocpp");
    await s.settled();
    expect(one(s.view(), "tts").state).toBe("installed");
    expect(one(s.view(), "audiocpp").service).toMatchObject({ state: "idle", note: `已有自己配的语音合成，在用它（服务管家里端口 ${s.port} 已经登记了）` });
    expect(s.lsm.owned.services.has("audiocpp")).toBe(false);
    expect(fs.existsSync(s.configPath)).toBe(false);
  });

  test("我们自己接上的服务：端口有人听不算手动配的", async () => {
    const s = await setup();
    await s.installAll();
    await s.components.refresh();
    expect(one(s.view(), "audiocpp")).toMatchObject({ state: "installed", service: { state: "running" } });
    expect(one(s.view(), "audiocpp").providedBy).toBeUndefined();
    // 守护进程重启：认 server.json，还是我们的
    await s.restart();
    await s.components.refresh();
    expect(one(s.view(), "tts").providedBy).toBeUndefined();
    expect(one(s.view(), "audiocpp").service?.state).toBe("running");
  });
});

describe("装不了的", () => {
  test("没接上服务管家：下载之前就说，一个字节不下", async () => {
    const s = await setup({ noLsm: true });
    await s.components.refresh();
    await expect(s.components.act("tts", "install", { licenseAccepted: true })).rejects.toThrow("服务管家");
    expect(s.fake.requests).toEqual([]);
  });

  test("数据目录带中文：audio.cpp 读不了，写明，不让装", async () => {
    const s = await setup({ componentsDir: path.join(makeTempDir(), "数据", "components") });
    const c = one(s.view(), "tts");
    expect(c.cannotInstall).toContain("读不了这个路径");
    expect(one(s.view(), "audiocpp").cannotInstall).toContain("读不了这个路径");
    await expect(s.components.act("tts", "install", { licenseAccepted: true })).rejects.toThrow("读不了这个路径");
  });
});

describe("启动、停止、更新", () => {
  test("停止 → 没在运行；启动 → 运行中（强制停：它没有停机能力）", async () => {
    const s = await setup();
    await s.installAll();
    await s.components.act("audiocpp", "stop");
    expect(s.requests("services.stop").at(-1)).toMatchObject({ name: "audiocpp", force: true });
    await waitUntil(() => one(s.view(), "audiocpp").service?.state === "stopped");
    await s.components.act("audiocpp", "start");
    await s.host.whenIdle();
    await waitUntil(() => one(s.view(), "audiocpp").service?.state === "running");
    expect(one(s.view(), "audiocpp").service?.autostart).toBe(true);
  });

  test("不带服务的组件没有启动、停止", async () => {
    const s = await setup();
    await s.installAll();
    await expect(s.components.act("tts", "start")).rejects.toThrow("没有能启动、停止的服务");
  });

  test("更新程序：先停服务再换文件，换完起来，配置和名单还在", async () => {
    const s = await setup();
    await s.installAll();
    await s.restart({ version: "0.9.4" });
    expect(one(s.view(), "audiocpp")).toMatchObject({ state: "update", installedVersion: "0.9.3", version: "0.9.4" });
    const from = s.lsm.serviceRequests().length;
    await s.components.act("audiocpp", "update");
    await s.settled();
    expect(s.lsm.serviceRequests().slice(from).map((m) => m.type)).toEqual(["services.stop", "services.put", "services.start", "services.autostart"]);
    expect(one(s.view(), "audiocpp")).toMatchObject({ state: "installed", installedVersion: "0.9.4", service: { state: "running", autostart: true } });
  });

  test("再加一个模型（346 号票的样子）：配置里两个模型、重启服务；删一个写回一个、重启；更新失败不影响", async () => {
    const s = await setup({ extra: true });
    await s.installAll();
    expect(s.configs.at(-1)?.models.map((m) => m.id)).toEqual(["tts"]);
    await s.components.act("asr-nano", "install");
    await s.settled();
    expect(s.configs.at(-1)?.models.map((m) => [m.id, m.family, m.task])).toEqual([
      ["tts", "fish_audio", "tts"],
      ["asr", "funasr_nano", "asr"],
    ]);
    expect(s.requests("services.restart").at(-1)).toMatchObject({ name: "audiocpp", force: true });
    expect(one(s.view(), "audiocpp").service?.state).toBe("running");

    await s.components.act("tts", "remove");
    await s.host.whenIdle();
    expect(s.configs.at(-1)?.models.map((m) => m.id)).toEqual(["asr"]);
    expect(s.lsm.owned.services.has("audiocpp")).toBe(true);
    expect(one(s.view(), "audiocpp").service?.state).toBe("running");
  });

  describe("语音识别模型（346 号票）", () => {
    /** 记下来的：组件页告诉语音识别那一边的事 */
    function link(configured?: string): { calls: string[]; recognizer: RecognizerLink } {
      const calls: string[] = [];
      return {
        calls,
        recognizer: { configured: () => configured, connected: () => calls.push("connected"), removed: () => calls.push("removed") },
      };
    }

    test("只装语音识别模型也能接上：配置里只有它，服务接上了才告诉识别；删了撤登记、告诉识别", async () => {
      const { calls, recognizer } = link();
      const s = await setup({ extra: true, host: { recognizer } });
      await s.components.act("asr-nano", "install");
      await s.settled();
      expect(s.configs.at(-1)?.models.map((m) => m.id)).toEqual(["asr"]);
      expect(one(s.view(), "audiocpp").service).toMatchObject({ state: "running", autostart: true });
      expect(calls).toEqual(["connected"]);

      await s.components.act("asr-nano", "remove");
      await s.host.whenIdle();
      expect(calls).toEqual(["connected", "removed"]);
      expect(s.lsm.owned.services.has("audiocpp")).toBe(false);
    });

    test("服务没接上（启动失败）：不告诉识别，配置和接入方式都不动；点启动接上了才告诉", async () => {
      const { calls, recognizer } = link();
      const s = await setup({ extra: true, host: { recognizer } });
      s.lsm.owned.failNextStart("audiocpp", "显存不够");
      await s.components.act("asr-nano", "install");
      await s.settled();
      expect(one(s.view(), "audiocpp").service).toMatchObject({ state: "failed", error: expect.stringContaining("显存不够") });
      expect(calls).toEqual([]);

      await s.components.act("audiocpp", "start");
      await s.settled();
      expect(one(s.view(), "audiocpp").service?.state).toBe("running");
      expect(calls).toEqual(["connected"]);
    });

    test("只装语音合成模型：不告诉识别", async () => {
      const { calls, recognizer } = link();
      const s = await setup({ extra: true, host: { recognizer } });
      await s.installAll();
      expect(calls).toEqual([]);
    });

    test("已配了别的语音识别（LSM、Python）：语音识别模型不让装、写明；语音合成照样能装，互不影响", async () => {
      const { calls, recognizer } = link("已有自己配的语音识别，在用它（服务管家托管的识别服务 http://127.0.0.1:8091）");
      const s = await setup({ extra: true, host: { recognizer } });
      expect(one(s.view(), "asr-nano").cannotInstall).toBe("要改用这里装的，先撤掉自己配的（配置里的 voice.recognizer.mode、voice.recognizer.python）");
      await expect(s.components.act("asr-nano", "install")).rejects.toThrow("先撤掉自己配的");
      expect(s.fake.requests).toEqual([]);
      expect(s.lsm.serviceRequests()).toEqual([]);

      await s.installAll();
      expect(one(s.view(), "tts").state).toBe("installed");
      expect(s.configs.at(-1)?.models.map((m) => m.id)).toEqual(["tts"]);
      expect(calls).toEqual([]);
    });

    test("已有手动配的 audio.cpp 服务（端口有人听）：语音识别模型不让装，说清可以自己加；什么都不登记", async () => {
      const { calls, recognizer } = link();
      const s = await setup({ extra: true, host: { recognizer } });
      await s.tts.up();
      await s.components.refresh();
      expect(one(s.view(), "asr-nano").cannotInstall).toContain("id 为 asr 的模型");
      await expect(s.components.act("asr-nano", "install")).rejects.toThrow("id 为 asr 的模型");
      expect(s.fake.requests).toEqual([]);
      expect(s.lsm.serviceRequests()).toEqual([]);
      expect(calls).toEqual([]);
    });

    test("装好以后用户又配了别的（改了配置文件）：更新不挡，不抢回来由 link 决定", async () => {
      let configured: string | undefined;
      const calls: string[] = [];
      const s = await setup({ extra: true, host: { recognizer: { configured: () => configured, connected: () => calls.push("connected"), removed: () => calls.push("removed") } } });
      await s.components.act("asr-nano", "install");
      await s.settled();
      configured = "已有自己配的";
      expect(one(s.view(), "asr-nano").cannotInstall).toBeUndefined();
    });
  });

  test("加模型后启动失败：配置回到原来的样子，原来的服务接着跑", async () => {
    const s = await setup({ extra: true });
    await s.installAll();
    const before = fs.readFileSync(s.configPath, "utf8");
    s.lsm.owned.failNextStart("audiocpp", "显存不够");
    await s.components.act("asr-nano", "install");
    await s.settled();
    expect(fs.readFileSync(s.configPath, "utf8")).toBe(before);
    expect(s.lsm.owned.services.has("audiocpp")).toBe(true);
    expect(one(s.view(), "audiocpp").service).toMatchObject({ state: "failed", error: expect.stringContaining("显存不够") });
  });
});
