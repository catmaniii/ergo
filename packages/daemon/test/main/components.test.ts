// 主切面：设置 · 组件（323 号票）。真的守护进程走组合根和网关的 HTTP 接口；清单是随程序发布的那份，只把向量模型的文件换成
// 本机假下载服务上的小文件（同样装进数据目录的模型区 models/Xenova/bge-m3，照新流程走一遍：探速、下到临时目录、校验、换上），
// 不连外网、不下真模型（真的 560 MB 只在主会话手动核一次）：
// - GET /api/components：清单里的四个组件、默认装不装、功能灰不灰；
// - POST /api/components/bge-m3 install：马上回（排上了），下完是装好了，文件在模型区，功能不再灰；
// - POST /api/components install_defaults：照默认该装的排上（这里没有了）；删、不认得的组件（404）、参数不对（400）、不能从这里装的（400）；
// - POST /api/component-import：离线导入一个文件夹，凑齐了装上；路径不在回 400。
import fs from "node:fs";
import path from "node:path";
import { type ComponentImportResult, type ComponentsView, HTTP_PATHS, type HttpErrorBody } from "@ergo/protocol";
import { describe, expect, it } from "vitest";
import { createHttpTransport, loadManifest, parseManifest } from "../../src/components/index.ts";
import { startTestDaemon } from "../helpers/daemon.ts";
import { blob, type FakeDownloads, fakeProbes, sha256, startFakeDownloads } from "../helpers/fake-downloads.ts";
import { requestJson } from "../helpers/http.ts";
import { waitUntil } from "../helpers/process.ts";
import { makeTempDir } from "../helpers/temp-dir.ts";

const CONFIG = Buffer.from('{"model_type":"xlm-roberta"}\n');
const TOKENIZER = blob(70_000, 31);
const WEIGHTS = blob(300_000, 32);

/** 随程序发布的清单，向量模型的文件换成假下载服务上的小文件（两个镜像） */
function testManifest(fake: FakeDownloads) {
  const shipped = loadManifest().manifest;
  fake.put("config.json", CONFIG);
  fake.put("tokenizer.json", TOKENIZER);
  fake.put("onnx/model_quantized.onnx", WEIGHTS);
  return {
    signed: false,
    manifest: parseManifest({
      ...shipped,
      components: shipped.components.map((c) =>
        c.id !== "bge-m3"
          ? c
          : {
              ...c,
              sources: [
                { id: "huggingface", title: "Hugging Face", url: fake.source("hf") },
                { id: "hf-mirror", title: "hf-mirror", url: fake.source("mirror") },
              ],
              variants: [
                {
                  id: "q8",
                  parts: [
                    {
                      files: [
                        { path: "config.json", size: CONFIG.length },
                        { path: "tokenizer.json", size: TOKENIZER.length, sha256: sha256(TOKENIZER) },
                        { path: "onnx/model_quantized.onnx", size: WEIGHTS.length, sha256: sha256(WEIGHTS) },
                      ],
                    },
                  ],
                },
              ],
            },
      ),
    }),
  };
}

const view = (url: string) => requestJson<ComponentsView & HttpErrorBody>(url, HTTP_PATHS.components);
const act = (url: string, id: string, action: string) => requestJson<ComponentsView & HttpErrorBody>(url, HTTP_PATHS.component(id), { method: "POST", body: { action } });
const one = (v: ComponentsView, id: string) => v.components.find((c) => c.id === id)!;

describe("设置 · 组件", () => {
  it("列出清单里的组件；装向量模型：下到临时目录、校验过换进模型区，功能不再灰；删掉又灰", async () => {
    const fake = await startFakeDownloads();
    const td = await startTestDaemon({ components: { manifest: testManifest(fake), probes: fakeProbes({ provided: { "voice-recognizer": "用的是配置里的识别程序（python）" } }), transport: createHttpTransport() } });

    const before = await view(td.url);
    expect(before.status).toBe(200);
    expect(before.body.components.map((c) => [c.id, c.state, c.default])).toEqual([
      ["bge-m3", "missing", "install"],
      ["asr", "provided", "ask"],
      ["tts", "missing", "ask"],
      ["claude-code", "missing", "detected"],
    ]);
    expect(one(before.body, "bge-m3")).toMatchObject({ title: "向量模型 bge-m3", defaultText: "默认装", wanted: true, location: path.join(td.dataDir, "models", "Xenova", "bge-m3") });
    expect(one(before.body, "claude-code")).toMatchObject({ defaultText: "本机装了 Claude Code 才装", detectedText: "没检测到", wanted: false });
    expect(one(before.body, "tts").cannotInstall).toContain("audio.cpp 的程序和模型");
    expect(before.body.features.find((f) => f.feature === "memory.semantic")).toMatchObject({ component: "bge-m3", ready: false });
    expect(before.body.features.find((f) => f.feature === "voice.input")?.ready).toBe(true);
    expect(before.body.defaultsMissing).toEqual(["bge-m3"]);

    const started = await act(td.url, "bge-m3", "install");
    expect(started.status).toBe(200);
    expect(["queued", "downloading", "installing", "installed"]).toContain(one(started.body, "bge-m3").state);
    await waitUntil(() => one(td.daemon.components.view(), "bge-m3").state === "installed", { timeoutMs: 15_000 });
    const after = (await view(td.url)).body;
    expect(one(after, "bge-m3")).toMatchObject({ state: "installed", installedVersion: one(after, "bge-m3").version, diskSize: CONFIG.length + TOKENIZER.length + WEIGHTS.length });
    expect(after.features.find((f) => f.feature === "memory.semantic")?.ready).toBe(true);
    const dir = path.join(td.dataDir, "models", "Xenova", "bge-m3");
    expect(fs.readFileSync(path.join(dir, "onnx", "model_quantized.onnx")).equals(WEIGHTS)).toBe(true);
    expect(fs.existsSync(path.join(td.dataDir, "components", ".staging", "bge-m3"))).toBe(false);
    expect(after.defaultsMissing).toEqual([]);
    expect((await requestJson<ComponentsView>(td.url, HTTP_PATHS.components, { method: "POST", body: { action: "install_defaults" } })).status).toBe(200);

    const removed = await act(td.url, "bge-m3", "remove");
    expect(one(removed.body, "bge-m3").state).toBe("missing");
    expect(fs.existsSync(dir)).toBe(false);
  });

  it("做不了的回 400 和原因，不认得的回 404；离线导入一个文件夹，凑齐了装上", async () => {
    const fake = await startFakeDownloads();
    const td = await startTestDaemon({ components: { manifest: testManifest(fake), transport: createHttpTransport() } });

    expect((await act(td.url, "nope", "install")).status).toBe(404);
    const bad = await act(td.url, "bge-m3", "explode");
    expect(bad.status).toBe(400);
    const tts = await act(td.url, "tts", "install");
    expect(tts.status).toBe(400);
    expect(tts.body.message).toContain("现在不能从这里装");
    expect((await act(td.url, "bge-m3", "remove")).body.message).toContain("没装");

    const folder = makeTempDir();
    fs.mkdirSync(path.join(folder, "onnx"));
    fs.writeFileSync(path.join(folder, "config.json"), CONFIG);
    fs.writeFileSync(path.join(folder, "tokenizer.json"), TOKENIZER);
    fs.writeFileSync(path.join(folder, "onnx", "model_quantized.onnx"), WEIGHTS);
    const imported = await requestJson<ComponentImportResult & HttpErrorBody>(td.url, HTTP_PATHS.componentImport, { method: "POST", body: { path: folder } });
    expect(imported.status).toBe(200);
    expect(imported.body.installed).toEqual(["bge-m3"]);
    expect(one(imported.body.view, "bge-m3").state).toBe("installed");
    expect(fake.requests).toEqual([]);

    const missing = await requestJson<HttpErrorBody>(td.url, HTTP_PATHS.componentImport, { method: "POST", body: { path: path.join(folder, "nope") } });
    expect(missing.status).toBe(400);
    expect(missing.body.message).toContain("这个路径不在");
  });
});
