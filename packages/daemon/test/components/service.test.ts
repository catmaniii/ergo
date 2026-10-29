// 组件服务（323 号票）：装、删、更新、暂停、继续、取消、离线导入、默认装不装、依赖、别处已经有了、磁盘不够、换到一半被打断。
// 用自己编的小清单和本机的假下载服务（不连外网、不下真模型）。
import fs from "node:fs";
import path from "node:path";
import type { ComponentsView } from "@ergo/protocol";
import { describe, expect, test } from "vitest";
import { type ComponentProbes, createComponents, type LoadedManifest, parseManifest } from "../../src/components/index.ts";
import { createHttpTransport } from "../../src/components/transport.ts";
import { RequestRejected } from "../../src/errors.ts";
import { blob, type FakeDownloads, fakeProbes, makeTar, sha256, startFakeDownloads } from "../helpers/fake-downloads.ts";
import { waitUntil } from "../helpers/process.ts";
import { makeTempDir } from "../helpers/temp-dir.ts";

const CONFIG = Buffer.from('{"model": true}\n');
const WEIGHTS = blob(240_000, 21);
const VOICE = blob(60_000, 22);
const ADDON = blob(5_000, 23);
const PKG = makeTar(
  [
    { path: "package/package.json", body: '{"name":"pkg","version":"1.0.0"}' },
    { path: "package/bin/tool.exe", body: blob(9_000, 24) },
  ],
  true,
);

/** 一份小清单：向量模型（默认装，两个镜像）、语音（问了再装，N 卡版还没接上）、一个 npm 包（检测到才装，解开）、一个依赖向量模型的附加件 */
function manifestFor(fake: FakeDownloads, over: { modelVersion?: string } = {}): LoadedManifest {
  for (const [p, body] of [
    ["config.json", CONFIG],
    ["onnx/model.onnx", WEIGHTS],
    ["voice.bin", VOICE],
    ["pkg/-/pkg-1.0.0.tgz", PKG],
    ["addon.bin", ADDON],
  ] as const)
    fake.put(p, body);
  return {
    signed: false,
    manifest: parseManifest({
      format: 1,
      release: "test",
      components: [
        {
          id: "model",
          version: over.modelVersion ?? "v1",
          default: "install",
          enables: ["memory.semantic"],
          target: "models/test/model",
          sources: [
            { id: "a", title: "镜像 A", url: fake.source("a") },
            { id: "b", title: "镜像 B", url: fake.source("b") },
          ],
          variants: [
            {
              id: "q8",
              parts: [
                {
                  files: [
                    { path: "config.json", size: CONFIG.length },
                    { path: "onnx/model.onnx", size: WEIGHTS.length, sha256: sha256(WEIGHTS) },
                  ],
                },
              ],
            },
          ],
        },
        {
          id: "voice",
          version: "1",
          default: "ask",
          provided: "voice-config",
          enables: ["voice.input"],
          target: "components/voice",
          sources: [{ id: "a", title: "镜像 A", url: fake.source("a") }],
          variants: [
            { id: "cuda", when: { gpu: "nvidia" }, parts: [{ pending: "python" }, { files: [{ path: "voice.bin", size: VOICE.length, sha256: sha256(VOICE) }] }] },
            { id: "cpu", parts: [{ dir: "models", files: [{ path: "voice.bin", size: VOICE.length, sha256: sha256(VOICE) }] }] },
          ],
        },
        {
          id: "pack",
          version: "1.0.0",
          default: "detected",
          detect: "cli-x",
          enables: ["runtime.claude-code"],
          target: "components/pack",
          sources: [{ id: "npm", title: "npm", url: fake.source("npm") }],
          variants: [{ id: "any", parts: [{ files: [{ path: "pkg/-/pkg-1.0.0.tgz", size: PKG.length, sha256: sha256(PKG), extract: { format: "tgz", strip: 1, to: "node_modules/pkg", unpackedSize: 10_000 } }] }] }],
        },
        {
          id: "addon",
          version: "1",
          default: "ask",
          enables: [],
          dependsOn: ["model"],
          target: "components/addon",
          sources: [{ id: "a", title: "镜像 A", url: fake.source("a") }],
          variants: [{ id: "any", parts: [{ files: [{ path: "addon.bin", size: ADDON.length, sha256: sha256(ADDON) }] }] }],
        },
      ],
    }),
  };
}

interface Setup {
  root: string;
  fake: FakeDownloads;
  manifest: LoadedManifest;
  start(over?: { probes?: ComponentProbes; freeBytes?: (dir: string) => number; manifest?: LoadedManifest }): ReturnType<typeof createComponents>;
  logs: string[];
}

async function setup(): Promise<Setup> {
  const fake = await startFakeDownloads();
  const root = makeTempDir();
  const manifest = manifestFor(fake);
  const logs: string[] = [];
  return {
    root,
    fake,
    manifest,
    logs,
    start: (over = {}) =>
      createComponents({
        root,
        componentsDir: path.join(root, "components"),
        manifest: over.manifest ?? manifest,
        probes: over.probes ?? fakeProbes(),
        transport: createHttpTransport({ headersTimeoutMs: 5000 }),
        ...(over.freeBytes ? { freeBytes: over.freeBytes } : {}),
        stallMs: 2000,
        probeBytes: 64 * 1024,
        probeTimeoutMs: 1000,
        diskMargin: 0,
        log: (l) => logs.push(l),
      }),
  };
}

const one = (view: ComponentsView, id: string) => view.components.find((c) => c.id === id)!;

describe("看清单", () => {
  test("每个组件：没装、大小、版本、默认的说法、这台电脑上该不该装、用哪一版、打开的功能、下载地址、装在哪", async () => {
    const s = await setup();
    const view = s.start({ probes: fakeProbes({ detect: { "cli-x": "检测到：C:\\bin\\x.exe" } }) }).view();
    expect(one(view, "model")).toMatchObject({
      state: "missing",
      version: "v1",
      size: CONFIG.length + WEIGHTS.length,
      default: "install",
      defaultText: "默认装",
      wanted: true,
      variant: { id: "q8", title: "q8 量化版" },
      enables: [{ id: "memory.semantic", title: "按意思检索素材" }],
      sources: ["镜像 A", "镜像 B"],
      location: path.join(s.root, "models", "test", "model"),
    });
    expect(one(view, "voice")).toMatchObject({ state: "missing", default: "ask", defaultText: "问了再装", wanted: false, variant: { id: "cpu", reason: "这台电脑没找到 N 卡" } });
    expect(one(view, "pack")).toMatchObject({ default: "detected", wanted: true, detectedText: "检测到：C:\\bin\\x.exe" });
    expect(one(view, "addon").dependsOn).toEqual(["model"]);
    expect(view.features.find((f) => f.feature === "memory.semantic")).toEqual({ feature: "memory.semantic", component: "model", title: "model", ready: false });
    expect(view.defaultsMissing).toEqual(["model", "pack"]);
    expect(view.manifest).toEqual({ release: "test", signed: false });
  });

  test("有 N 卡挑 CUDA 版；那一版有还没接上的部分就不能从这里装（写明原因），装的请求被拒", async () => {
    const s = await setup();
    const components = s.start({ probes: fakeProbes({ gpu: "nvidia" }) });
    const voice = one(components.view(), "voice");
    expect(voice.variant).toMatchObject({ id: "cuda", title: "CUDA 版", reason: "这台电脑有 N 卡" });
    expect(voice.cannotInstall).toBe("这一版还不能从这里装：Python 和 faster-whisper 那部分（用 uv 装）还没接上");
    await expect(components.act("voice", "install")).rejects.toThrow("现在不能从这里装");
    await expect(components.act("nope", "install")).rejects.toMatchObject({ code: "not_found" });
  });

  test("别处已经有了（配置里的识别程序）：算有，对应的功能不灰", async () => {
    const s = await setup();
    const view = s.start({ probes: fakeProbes({ provided: { "voice-config": "用的是配置里的识别程序（python）" } }) }).view();
    expect(one(view, "voice")).toMatchObject({ state: "provided", providedBy: "用的是配置里的识别程序（python）" });
    expect(view.features.find((f) => f.feature === "voice.input")?.ready).toBe(true);
  });
});

describe("装、删、更新", () => {
  test("装：探速挑快的、下到临时目录、校验过才换上；记下装着的版本；功能不再灰", async () => {
    const s = await setup();
    s.fake.behave("a", { kind: "slow", bytesPerTick: 4000, tickMs: 40 });
    const components = s.start();
    const phases = new Set<string>();
    components.onChange(() => {
      const p = one(components.view(), "model").progress;
      if (p) phases.add(p.phase);
    });
    const after = await components.act("model", "install");
    expect(["queued", "downloading"]).toContain(one(after, "model").state);
    await components.whenIdle("model");
    const view = components.view();
    expect(one(view, "model")).toMatchObject({ state: "installed", installedVersion: "v1" });
    expect(one(view, "model").diskSize).toBe(CONFIG.length + WEIGHTS.length);
    const target = path.join(s.root, "models", "test", "model");
    expect(fs.readFileSync(path.join(target, "onnx", "model.onnx")).equals(WEIGHTS)).toBe(true);
    expect(fs.readFileSync(path.join(target, "config.json")).equals(CONFIG)).toBe(true);
    expect(fs.existsSync(path.join(s.root, "components", ".staging", "model"))).toBe(false);
    expect(JSON.parse(fs.readFileSync(path.join(s.root, "components", "installed.json"), "utf8"))).toMatchObject({ format: 1, components: { model: { version: "v1", variant: "q8", from: "download" } } });
    expect(view.features.find((f) => f.feature === "memory.semantic")?.ready).toBe(true);
    // 慢的镜像 A 只被探了一下，文件都从 B 下
    expect(s.fake.requests.filter((r) => r.mirror === "a" && r.range !== "bytes=0-65535")).toEqual([]);
    expect(s.fake.requests.filter((r) => r.mirror === "b").map((r) => r.path)).toEqual(expect.arrayContaining(["onnx/model.onnx", "config.json"]));
    expect(phases).toEqual(new Set(["probing", "downloading", "verifying", "installing"]));
    s.fake.releaseAll();
  });

  test("以前用下载命令放进模型区的：大小、sha256 对得上就算装好了；下了一半的 .part 挪过来接着下", async () => {
    const s = await setup();
    const target = path.join(s.root, "models", "test", "model");
    fs.mkdirSync(path.join(target, "onnx"), { recursive: true });
    fs.writeFileSync(path.join(target, "config.json"), CONFIG);
    fs.writeFileSync(path.join(target, "onnx", "model.onnx.part"), WEIGHTS.subarray(0, 100_000));
    const components = s.start();
    expect(one(components.view(), "model").state).toBe("missing");
    await components.act("model", "install");
    await components.whenIdle("model");
    expect(one(components.view(), "model").state).toBe("installed");
    expect(s.fake.requests.filter((r) => r.path === "config.json")).toEqual([]);
    expect(s.fake.requests.filter((r) => r.path === "onnx/model.onnx" && r.range !== "bytes=0-65535").map((r) => r.range)).toEqual(["bytes=100000-"]);
    // 换上之后正式目录里没有 .part
    expect(fs.readdirSync(path.join(target, "onnx"))).toEqual(["model.onnx"]);

    // 都在、没有记录的（下载命令放的）也算装好了
    fs.rmSync(path.join(s.root, "components", "installed.json"));
    expect(one(s.start().view(), "model")).toMatchObject({ state: "installed", installedVersion: "v1" });
  });

  test("磁盘空间不够：一个字节都不下，写明还要多少、只剩多少", async () => {
    const s = await setup();
    const components = s.start({ freeBytes: () => 1000 });
    await components.act("model", "install");
    await components.whenIdle("model");
    const model = one(components.view(), "model");
    expect(model.state).toBe("failed");
    expect(model.error).toContain("磁盘空间不够");
    expect(model.error).toContain("只剩 1000 B");
    expect(s.fake.requests).toEqual([]);
  });

  test("压缩包（npm 的 .tgz）下好后解开（去掉 package/）再换上", async () => {
    const s = await setup();
    const components = s.start();
    await components.act("pack", "install");
    await components.whenIdle("pack");
    expect(one(components.view(), "pack").state).toBe("installed");
    const dir = path.join(s.root, "components", "pack", "node_modules", "pkg");
    expect(JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8"))).toEqual({ name: "pkg", version: "1.0.0" });
    expect(fs.existsSync(path.join(dir, "bin", "tool.exe"))).toBe(true);
  });

  test("依赖的先装：装附加件时先把向量模型排上", async () => {
    const s = await setup();
    const components = s.start();
    await components.act("addon", "install");
    await components.whenIdle();
    const view = components.view();
    expect(one(view, "model").state).toBe("installed");
    expect(one(view, "addon").state).toBe("installed");
    // 附加件要用向量模型：删不了，先删附加件
    await expect(components.act("model", "remove")).rejects.toThrow("要用");
  });

  test("删：正式目录和记录都没了，功能又灰；没装的删不了", async () => {
    const s = await setup();
    const components = s.start();
    await components.act("model", "install");
    await components.whenIdle("model");
    const view = await components.act("model", "remove");
    expect(one(view, "model").state).toBe("missing");
    expect(fs.existsSync(path.join(s.root, "models", "test", "model"))).toBe(false);
    expect(view.features.find((f) => f.feature === "memory.semantic")?.ready).toBe(false);
    await expect(components.act("model", "remove")).rejects.toBeInstanceOf(RequestRejected);
  });

  test("清单里出了新版本：显示有更新，更新时下新的、换上、旧的删掉", async () => {
    const s = await setup();
    const old = s.start();
    await old.act("model", "install");
    await old.whenIdle("model");
    const components = s.start({ manifest: manifestFor(s.fake, { modelVersion: "v2" }) });
    expect(one(components.view(), "model")).toMatchObject({ state: "update", version: "v2", installedVersion: "v1" });
    await components.act("model", "update");
    await components.whenIdle("model");
    expect(one(components.view(), "model")).toMatchObject({ state: "installed", installedVersion: "v2" });
    expect(fs.readdirSync(path.join(s.root, "models", "test")).toSorted()).toEqual(["model"]);
  });

  test("换到一半被打断（正式目录改了名、新的还没换上）：下次启动改回来", async () => {
    const s = await setup();
    const first = s.start();
    await first.act("model", "install");
    await first.whenIdle("model");
    const target = path.join(s.root, "models", "test", "model");
    fs.renameSync(target, `${target}.old-123`);
    expect(one(s.start().view(), "model").state).toBe("installed");
    expect(fs.existsSync(`${target}.old-123`)).toBe(false);
  });

  test("装上默认的：照清单该装的（默认装的、检测到了的）排上，问了再装的不动", async () => {
    const s = await setup();
    const components = s.start({ probes: fakeProbes({ detect: { "cli-x": "检测到了" } }) });
    await components.installDefaults();
    await components.whenIdle();
    const view = components.view();
    expect(one(view, "model").state).toBe("installed");
    expect(one(view, "pack").state).toBe("installed");
    expect(one(view, "voice").state).toBe("missing");
    expect(view.defaultsMissing).toEqual([]);
  });
});

describe("暂停、继续、取消", () => {
  test("暂停：下了一半的留着；守护进程重启后还是暂停了、进度在；继续接着下", async () => {
    const s = await setup();
    s.fake.behave("a", { kind: "slow", bytesPerTick: 20_000, tickMs: 50 });
    s.fake.behave("b", { kind: "broken" });
    const components = s.start();
    await components.act("model", "install");
    await waitUntil(() => (one(components.view(), "model").progress?.done ?? 0) >= 60_000, { timeoutMs: 10_000 });
    const paused = await components.act("model", "pause");
    expect(one(paused, "model").state).toBe("paused");
    const done = one(paused, "model").progress?.done ?? 0;
    expect(done).toBeGreaterThan(0);
    s.fake.releaseAll();

    // 重启（新的服务）：从临时目录认出下了一半的
    await components.stop();
    const again = s.start();
    expect(one(again.view(), "model")).toMatchObject({ state: "paused", progress: { done: expect.any(Number), total: CONFIG.length + WEIGHTS.length } });
    s.fake.behave("a", { kind: "ok" });
    await again.act("model", "resume");
    await again.whenIdle("model");
    expect(one(again.view(), "model").state).toBe("installed");
    expect(s.fake.requests.filter((r) => r.mirror === "a" && r.path === "onnx/model.onnx").at(-1)?.range).toMatch(/^bytes=[1-9]\d*-$/);
  });

  test("取消：中止，临时目录整个删掉，回到没装", async () => {
    const s = await setup();
    s.fake.behave("a", { kind: "slow", bytesPerTick: 10_000, tickMs: 50 });
    s.fake.behave("b", { kind: "broken" });
    const components = s.start();
    await components.act("model", "install");
    await waitUntil(() => (one(components.view(), "model").progress?.done ?? 0) > 0, { timeoutMs: 10_000 });
    const view = await components.act("model", "cancel");
    expect(one(view, "model").state).toBe("missing");
    expect(fs.existsSync(path.join(s.root, "components", ".staging", "model"))).toBe(false);
    s.fake.releaseAll();
  });

  test("下不下来：出错（写明原因），下好的部分留着，重试接着下", async () => {
    const s = await setup();
    s.fake.behave("a", { kind: "cut", bytes: 50_000, times: 99 });
    s.fake.behave("b", { kind: "broken" });
    const components = s.start();
    await components.act("model", "install");
    await components.whenIdle("model");
    const failed = one(components.view(), "model");
    expect(failed.state).toBe("failed");
    expect(failed.error).toContain("下不下来");
    s.fake.behave("a", { kind: "ok" });
    await components.act("model", "resume");
    await components.whenIdle("model");
    expect(one(components.view(), "model").state).toBe("installed");
  });
});

describe("离线导入", () => {
  test("一个文件夹：按大小和 sha256 认（没写 sha256 的按名字），凑齐的装上；认不出的列出来", async () => {
    const s = await setup();
    const dir = makeTempDir();
    fs.mkdirSync(path.join(dir, "sub"));
    fs.writeFileSync(path.join(dir, "config.json"), CONFIG);
    fs.writeFileSync(path.join(dir, "sub", "model_quantized.onnx"), WEIGHTS);
    fs.writeFileSync(path.join(dir, "readme.txt"), "随便什么");
    fs.writeFileSync(path.join(dir, "wrong.bin"), blob(WEIGHTS.length, 99));
    const components = s.start();
    const result = await components.importFrom(dir);
    expect(result.installed).toEqual(["model"]);
    expect(result.matched).toEqual(expect.arrayContaining([{ component: "model", file: "config.json" }, { component: "model", file: "onnx/model.onnx" }]));
    expect(result.unknown.toSorted()).toEqual(["readme.txt", "wrong.bin"]);
    expect(one(result.view, "model").state).toBe("installed");
    expect(JSON.parse(fs.readFileSync(path.join(s.root, "components", "installed.json"), "utf8")).components.model.from).toBe("import");
    expect(s.fake.requests).toEqual([]);
    // 用户的文件原样留着
    expect(fs.existsSync(path.join(dir, "sub", "model_quantized.onnx"))).toBe(true);
  });

  test("只导入了一部分：停在暂停了、写明还差哪些；点继续从网上下剩下的", async () => {
    const s = await setup();
    const dir = makeTempDir();
    const file = path.join(dir, "model.onnx");
    fs.writeFileSync(file, WEIGHTS);
    const components = s.start();
    const result = await components.importFrom(file);
    expect(result.installed).toEqual([]);
    expect(result.missing).toEqual([{ component: "model", files: ["config.json"] }]);
    expect(one(result.view, "model")).toMatchObject({ state: "paused", missingFiles: ["config.json"] });
    expect(one(result.view, "model").error).toContain("还差 1 个文件");
    await components.act("model", "resume");
    await components.whenIdle("model");
    expect(one(components.view(), "model").state).toBe("installed");
    expect(s.fake.requests.map((r) => r.path)).toEqual(["config.json"]);
  });

  test("打好的包（.tgz）：一项项认；包本身是清单里的文件（npm 的 .tgz）就当文件认", async () => {
    const s = await setup();
    const dir = makeTempDir();
    const pack = path.join(dir, "ergo-components.tgz");
    fs.writeFileSync(pack, makeTar([{ path: "model/config.json", body: CONFIG }, { path: "model/onnx/model_quantized.onnx", body: WEIGHTS }, { path: "notes.txt", body: "x" }], true));
    const npm = path.join(dir, "pkg-1.0.0.tgz");
    fs.writeFileSync(npm, PKG);
    const components = s.start();
    const fromPack = await components.importFrom(pack);
    expect(fromPack.installed).toEqual(["model"]);
    expect(fromPack.unknown).toEqual(["notes.txt"]);
    const fromNpm = await components.importFrom(`"${npm}"`);
    expect(fromNpm.installed).toEqual(["pack"]);
    expect(fs.existsSync(path.join(s.root, "components", "pack", "node_modules", "pkg", "package.json"))).toBe(true);
  });

  test("路径不在、包坏了：拒绝，写明原因", async () => {
    const s = await setup();
    const components = s.start();
    await expect(components.importFrom(path.join(makeTempDir(), "nope"))).rejects.toThrow("这个路径不在");
    const bad = path.join(makeTempDir(), "bad.tar");
    fs.writeFileSync(bad, blob(3000));
    await expect(components.importFrom(bad)).rejects.toThrow("这个包读不了");
  });
});
