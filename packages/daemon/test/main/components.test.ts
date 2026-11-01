// 主切面：设置 · 组件。真的守护进程走组合根和网关的 HTTP 接口；清单是随程序发布的那份，只把向量模型的文件换成
// 本机假下载服务上的小文件（同样装进数据目录的模型区 models/Xenova/bge-m3，照新流程走一遍：探速、下到临时目录、校验、换上），
// 不连外网、不下真模型（真的 560 MB 只手动核一次）：
// - GET /api/components：清单里的四个组件、默认装不装、功能灰不灰；
// - POST /api/components/bge-m3 install：马上回（排上了），下完是装好了，文件在模型区，功能不再灰；
// - POST /api/components install_defaults：照默认该装的排上（这里没有了）；删、不认得的组件（404）、参数不对（400）、不能从这里装的（400）；
// - 语音合成：真的守护进程、假下载站、LSM 替身、假语音服务：没确认许可 400 不下载；确认后装好、登记、启动、进名单，
//   守护进程的语音合成（预热的试合成）打得到它；已有手动配的不覆盖；
// - 语音识别：真的守护进程、假下载站、LSM 替身、假 audio.cpp：没确认许可不下载；装好后配置指向 audiocpp、不用重启，语音消息走到新接入；
//   删了指回去；已配 LSM 模式、配了 Python、手动配的 audio.cpp 都不改，配置文件按字节核对；
// - POST /api/component-import：离线导入一个文件夹，凑齐了装上；路径不在回 400；
// - 查更新：POST /api/components check_updates、每晚的作业、待办里的提醒（同一版本一次，换上后自动归档）；断网不报错、不进待办。
import fs from "node:fs";
import path from "node:path";
import { CHANNELS, type ComponentImportResult, type ComponentsView, HTTP_PATHS, type HttpErrorBody, type VoiceModelsView } from "@ergo/protocol";
import { describe, expect, it } from "vitest";
import { type ComponentProbes, createHttpTransport, loadManifest, parseManifest } from "../../src/components/index.ts";
import { startTestDaemon } from "../helpers/daemon.ts";
import { blob, type FakeDownloads, fakeProbes, makeZip, sha256, startFakeDownloads } from "../helpers/fake-downloads.ts";
import { media, requestJson } from "../helpers/http.ts";
import { startLsmStandIn } from "../helpers/lsm-stand-in.ts";
import { waitUntil } from "../helpers/process.ts";
import { makeTempDir } from "../helpers/temp-dir.ts";
import { startFakeSpeechService } from "../helpers/tts.ts";
import { fakeMp3 } from "../helpers/audio.ts";
import { TestFrontend } from "../helpers/frontend.ts";
import { startFakeAudioCppAsr } from "../helpers/fake-audiocpp-asr.ts";
import { fakeWavRecording, voiceSettled } from "../helpers/voice.ts";

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
      ["audiocpp", "missing", "ask"],
      ["tts", "missing", "ask"],
      ["claude-code", "missing", "detected"],
    ]);
    expect(one(before.body, "bge-m3")).toMatchObject({ title: "向量模型 bge-m3", defaultText: "默认装", wanted: true, location: path.join(td.dataDir, "models", "Xenova", "bge-m3") });
    expect(one(before.body, "claude-code")).toMatchObject({ defaultText: "本机装了 Claude Code 才装", detectedText: "没检测到", wanted: false });
    expect(one(before.body, "tts")).toMatchObject({ recommended: true, license: { name: "Fish Audio Research License", confirm: true, accepted: false } });
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
    // 要确认许可的没带确认标记：不开始（语音识别模型能从这里装了）
    const needsLicense = await act(td.url, "asr", "install");
    expect(needsLicense.status).toBe(400);
    expect(needsLicense.body.message).toContain("要先确认");
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

  describe("语音合成", () => {
    const PROGRAM = makeZip([{ name: "audiocpp_server.exe", body: blob(5000, 41) }]);
    const MODEL = blob(90_000, 42);

    /** 随程序发布的清单，语音合成那两条的文件换成假下载站上的小文件、端口换成假语音服务的 */
    function speechManifest(fake: FakeDownloads, port: number) {
      const shipped = loadManifest().manifest;
      fake.put("bin.zip", PROGRAM);
      fake.put("model.gguf", MODEL);
      const sources = [{ id: "a", title: "镜像 A", url: fake.source("a") }];
      return {
        signed: false,
        manifest: parseManifest({
          ...shipped,
          components: shipped.components.map((c) => {
            if (c.id === "audiocpp") {
              return { ...c, sources, service: { ...c.service!, port }, variants: [{ id: "cpu", parts: [{ files: [{ path: "bin.zip", size: PROGRAM.length, sha256: sha256(PROGRAM), extract: { format: "zip" as const, to: "bin" } }] }] }] };
            }
            if (c.id === "tts") {
              return { ...c, sources, serve: { ...c.serve!, file: "model.gguf" }, variants: [{ id: "q8", parts: [{ files: [{ path: "model.gguf", size: MODEL.length, sha256: sha256(MODEL) }] }] }] };
            }
            return c;
          }),
        }),
      };
    }

    it("没确认许可 400、不下载；确认后装好、登记、启动、健康检查、进名单，守护进程的语音合成打得到；卸载撤登记和名单", async () => {
      const fake = await startFakeDownloads();
      const speech = await startFakeSpeechService();
      const port = Number(new URL(speech.url).port);
      await speech.down();
      const lsm = await startLsmStandIn({ owned: true });
      const td = await startTestDaemon({
        env: lsm.env,
        speechUrl: speech.url,
        config: { voice: { speech: { probeSeconds: 1 } } },
        components: { manifest: speechManifest(fake, port), probes: fakeProbes(), transport: createHttpTransport(), audiocpp: { healthTimeoutMs: 15_000, healthPollMs: 50 } },
      });
      await waitUntil(() => lsm.connections > 0, { timeoutMs: 10_000 });

      const refused = await act(td.url, "tts", "install");
      expect(refused.status).toBe(400);
      expect(refused.body.message).toContain("Fish Audio Research License");
      expect(fake.requests).toEqual([]);

      const started = await requestJson<ComponentsView & HttpErrorBody>(td.url, HTTP_PATHS.component("tts"), { method: "POST", body: { action: "install", licenseAccepted: true } });
      expect(started.status).toBe(200);
      // 替身不起进程：它说要启动，假语音服务就开起来（扮演服务管家拉起的程序）
      await lsm.waitFor((m) => m.type === "services.start", "启动语音服务", { timeoutMs: 15_000 });
      await speech.up();
      await waitUntil(() => one(td.daemon.components.view(), "audiocpp").service?.state === "running", { timeoutMs: 20_000 });

      const after = (await view(td.url)).body;
      expect(one(after, "audiocpp")).toMatchObject({ state: "installed", service: { state: "running", port, autostart: true } });
      expect(one(after, "tts")).toMatchObject({ state: "installed", license: { accepted: true } });
      expect(after.features.find((f) => f.feature === "voice.reply")?.ready).toBe(true);
      expect(lsm.owned.services.get("audiocpp")).toMatchObject({ autostart: true, state: "RUNNING" });
      const config = JSON.parse(fs.readFileSync(path.join(td.dataDir, "components", "audiocpp-service", "server.json"), "utf8")) as { host: string; port: number; lazy_load: boolean; models: { id: string }[] };
      expect(config).toMatchObject({ host: "127.0.0.1", port, lazy_load: true, models: [{ id: "tts", family: "fish_audio" }] });

      // 语音回复走的那个客户端打得到：服务一通，语音模块自己发预热的试合成（用默认音色、配置里的模型 id）
      await waitUntil(() => speech.warmups.length > 0, { timeoutMs: 15_000 });
      expect(speech.warmups[0]).toMatchObject({ model: "tts" });

      expect((await act(td.url, "tts", "remove")).status).toBe(200);
      await waitUntil(() => !lsm.owned.services.has("audiocpp"), { timeoutMs: 10_000 });
      expect(fs.existsSync(path.join(td.dataDir, "components", "audiocpp-service", "server.json"))).toBe(false);
    });

    describe("语音识别模型", () => {
      const ASR_MODEL = blob(70_000, 43);

      /** 随程序发布的清单，语音程序和语音识别模型的文件换成假下载站上的小文件 */
      function recognizerManifest(fake: FakeDownloads, port: number) {
        const shipped = loadManifest().manifest;
        fake.put("bin.zip", PROGRAM);
        fake.put("asr.gguf", ASR_MODEL);
        const sources = [{ id: "a", title: "镜像 A", url: fake.source("a") }];
        return {
          signed: false,
          manifest: parseManifest({
            ...shipped,
            components: shipped.components.map((c) => {
              if (c.id === "audiocpp") {
                return { ...c, sources, service: { ...c.service!, port }, variants: [{ id: "cpu", parts: [{ files: [{ path: "bin.zip", size: PROGRAM.length, sha256: sha256(PROGRAM), extract: { format: "zip" as const, to: "bin" } }] }] }] };
              }
              if (c.id === "asr") {
                return { ...c, sources, serve: { ...c.serve!, file: "asr.gguf" }, variants: [{ id: "q8", parts: [{ files: [{ path: "asr.gguf", size: ASR_MODEL.length, sha256: sha256(ASR_MODEL) }] }] }] };
              }
              return c;
            }),
          }),
        };
      }

      const configFileOf = (dataDir: string) => path.join(dataDir, "config", "ergo.json");
      const models = (url: string) => requestJson<VoiceModelsView>(url, HTTP_PATHS.voiceModels);
      /** 等本机接口上的状态满足条件（waitUntil 只认同步的条件） */
      async function modelsWhen(url: string, ok: (view: VoiceModelsView) => boolean): Promise<VoiceModelsView> {
        const deadline = Date.now() + 15_000;
        for (;;) {
          const { body } = await models(url);
          if (ok(body)) return body;
          if (Date.now() > deadline) throw new Error(`等不到：${JSON.stringify(body)}`);
          await new Promise((resolve) => setTimeout(resolve, 50));
        }
      }

      it("没确认许可不下载；确认后装好、接上，配置指向 audiocpp、不用重启，语音消息走到新接入；删了指回去", async () => {
        const fake = await startFakeDownloads();
        const asr = await startFakeAudioCppAsr({ down: true });
        const lsm = await startLsmStandIn({ owned: true });
        const td = await startTestDaemon({
          env: lsm.env,
          speechUrl: asr.url,
          config: { voice: { speech: { probeSeconds: 1 } } },
          components: { manifest: recognizerManifest(fake, asr.port), probes: fakeProbes(), transport: createHttpTransport(), audiocpp: { healthTimeoutMs: 15_000, healthPollMs: 50 } },
        });
        await waitUntil(() => lsm.connections > 0, { timeoutMs: 10_000 });
        // 默认识别方式没变：装之前还是 spawn、faster-whisper，"按住说话"的组件是没装
        expect(td.daemon.config.voice.recognizer.mode).toBe("spawn");
        expect((await models(td.url)).body).toMatchObject({ recognizerEngine: "faster-whisper" });
        expect((await models(td.url)).body.recognizerInput).toBeUndefined();
        const before = (await view(td.url)).body;
        expect(one(before, "asr")).toMatchObject({ state: "missing", recommended: true, license: { name: "FunASR Model License v1.1", accepted: false, attribution: "Fun-ASR-Nano-2512 · FunAudioLLM / Alibaba Group" } });
        expect(before.features.find((f) => f.feature === "voice.input")?.ready).toBe(false);
        expect(before.defaultsMissing).not.toContain("asr");

        const refused = await act(td.url, "asr", "install");
        expect(refused.status).toBe(400);
        expect(refused.body.message).toContain("FunASR Model License v1.1");
        expect(fake.requests).toEqual([]);

        const started = await requestJson<ComponentsView & HttpErrorBody>(td.url, HTTP_PATHS.component("asr"), { method: "POST", body: { action: "install", licenseAccepted: true } });
        expect(started.status).toBe(200);
        // 替身不起进程：它说要启动，假 audio.cpp 就开起来（扮演服务管家拉起的程序）
        await lsm.waitFor((m) => m.type === "services.start", "启动语音服务", { timeoutMs: 15_000 });
        await asr.up();
        await waitUntil(() => one(td.daemon.components.view(), "audiocpp").service?.state === "running", { timeoutMs: 20_000 });

        const after = (await view(td.url)).body;
        expect(one(after, "asr")).toMatchObject({ state: "installed", license: { accepted: true } });
        expect(after.features.find((f) => f.feature === "voice.input")?.ready).toBe(true);
        expect(lsm.owned.services.get("audiocpp")).toMatchObject({ autostart: true, state: "RUNNING" });
        const server = JSON.parse(fs.readFileSync(path.join(td.dataDir, "components", "audiocpp-service", "server.json"), "utf8")) as unknown;
        expect(server).toMatchObject({ host: "127.0.0.1", port: asr.port, lazy_load: true, models: [{ id: "asr", family: "fun_asr_nano", task: "asr", mode: "offline" }] });

        // 配置指过来了，语音插件当场换、预热（发一小段静音）
        const written = JSON.parse(fs.readFileSync(configFileOf(td.dataDir), "utf8")) as { voice: { recognizer: { mode: string } } };
        expect(written.voice.recognizer.mode).toBe("audiocpp");
        await waitUntil(() => asr.requests.some((r) => r.silence), { timeoutMs: 15_000 });
        await modelsWhen(td.url, (v) => v.recognizer.status === "ready");
        expect((await models(td.url)).body).toMatchObject({ recognizerEngines: ["Fun-ASR Nano"], recognizerEngine: "Fun-ASR Nano", recognizerInput: "wav", recognizer: { model: "fun_asr_nano（audio.cpp/asr）", device: "cuda" } });

        // 语音消息走到新接入（网页转好的 WAV）
        const frontend = await TestFrontend.connect(td.url);
        await frontend.subscribe({ [CHANNELS.secretary]: 0 });
        const uploaded = await media.upload(td.url, fakeWavRecording({ text: "按住说的一句话" }), { name: "语音.wav", mime: "audio/wav" });
        await frontend.sendParts([{ type: "voice", mediaId: uploaded.mediaId, mime: "audio/wav", durationMs: 1000, waveform: [8, 40] }]);
        const done = await voiceSettled(frontend, (v) => v.mediaId === uploaded.mediaId && v.status === "done", 15_000);
        expect(done.recognition?.text).toBe("按住说的一句话");
        expect(asr.recognitions()).toHaveLength(1);
        expect(asr.recognitions()[0]!.fields).toEqual({ model: "asr", language: "zh" });

        // 不是 WAV 的（老版本页面、旧录音）用 ffmpeg 转（测试里是假的），传过去的是 WAV
        const mp3 = await media.upload(td.url, fakeMp3({ seconds: 1, asr: { text: "转完的一句话" } }), { name: "语音.mp3", mime: "audio/mpeg" });
        await frontend.sendParts([{ type: "voice", mediaId: mp3.mediaId, mime: "audio/mpeg", durationMs: 1000, waveform: [8, 40] }]);
        const converted = await voiceSettled(frontend, (v) => v.mediaId === mp3.mediaId && v.status === "done", 15_000);
        expect(converted.recognition?.text).toBe("转完的一句话");
        expect(asr.recognitions()[1]!.file.toString("latin1", 0, 4)).toBe("RIFF");

        // 删了：撤登记，配置里这一项没了，回到默认的接入，功能灰掉
        expect((await act(td.url, "asr", "remove")).status).toBe(200);
        await waitUntil(() => !lsm.owned.services.has("audiocpp"), { timeoutMs: 10_000 });
        await waitUntil(() => td.daemon.config.voice.recognizer.mode === "spawn", { timeoutMs: 10_000 });
        const restored = JSON.parse(fs.readFileSync(configFileOf(td.dataDir), "utf8")) as { voice?: { recognizer?: { mode?: string } } };
        expect(restored.voice?.recognizer?.mode).toBeUndefined();
        await modelsWhen(td.url, (v) => v.recognizerEngine === "faster-whisper");
        expect((await models(td.url)).body.recognizerInput).toBeUndefined();
        expect((await view(td.url)).body.features.find((f) => f.feature === "voice.input")?.ready).toBe(false);
      });

      it("重启之后还是走它（配置里写着 audiocpp）：一起来就预热；服务没开时写明原因、怎么修，开了自己接上，语音消息照常", async () => {
        const asr = await startFakeAudioCppAsr({ down: true });
        const td = await startTestDaemon({
          speechUrl: asr.url,
          recognizerRetryMs: [100],
          config: { voice: { recognizer: { mode: "audiocpp" } } },
          components: { probes: fakeProbes(), transport: createHttpTransport() },
        });
        const down = await modelsWhen(td.url, (v) => v.recognizer.status === "error");
        expect(down).toMatchObject({ recognizerEngine: "Fun-ASR Nano", recognizerInput: "wav" });
        expect(down.recognizer.reason).toContain(asr.url);

        await asr.up();
        await modelsWhen(td.url, (v) => v.recognizer.status === "ready");
        const frontend = await TestFrontend.connect(td.url);
        await frontend.subscribe({ [CHANNELS.secretary]: 0 });
        const uploaded = await media.upload(td.url, fakeWavRecording({ text: "重启之后说的" }), { name: "语音.wav", mime: "audio/wav" });
        await frontend.sendParts([{ type: "voice", mediaId: uploaded.mediaId, mime: "audio/wav", durationMs: 1000, waveform: [8, 40] }]);
        expect((await voiceSettled(frontend, (v) => v.status === "done", 15_000)).recognition?.text).toBe("重启之后说的");
      });

      /** 已经配好了的：配置文件按字节留着，接口拒绝装，什么都不下、不登记 */
      async function untouched(recognizerConfig: Record<string, unknown>, providedBy: RegExp, over: { speechUp?: boolean } = {}) {
        const fake = await startFakeDownloads();
        const asr = await startFakeAudioCppAsr(over.speechUp ? {} : { down: true });
        const lsm = await startLsmStandIn({ owned: true });
        const td = await startTestDaemon({
          env: lsm.env,
          speechUrl: asr.url,
          config: { voice: { recognizer: recognizerConfig } },
          components: { manifest: recognizerManifest(fake, asr.port), probes: undefined as unknown as ComponentProbes, transport: createHttpTransport() },
        });
        await waitUntil(() => lsm.connections > 0, { timeoutMs: 10_000 });
        const file = configFileOf(td.dataDir);
        const original = fs.readFileSync(file);
        const shown = (await view(td.url)).body;
        expect(one(shown, "asr").state).toBe("provided");
        expect(one(shown, "asr").providedBy).toMatch(providedBy);
        expect(one(shown, "asr").cannotInstall).toContain("先撤掉自己配的");
        expect(shown.features.find((f) => f.feature === "voice.input")?.ready).toBe(true);
        const refused = await requestJson<HttpErrorBody>(td.url, HTTP_PATHS.component("asr"), { method: "POST", body: { action: "install", licenseAccepted: true } });
        expect(refused.status).toBe(400);
        expect(fake.requests).toEqual([]);
        expect(lsm.serviceRequests()).toEqual([]);
        expect(fs.readFileSync(file).equals(original)).toBe(true);
        return td;
      }

      it("已配 LSM 模式（这台机器就是）：不改，写已有自己配的语音识别，引擎还是 faster-whisper", async () => {
        const td = await untouched({ mode: "lsm", url: "http://127.0.0.1:1" }, /已有自己配的语音识别.*服务管家托管的识别服务/);
        expect(td.daemon.config.voice.recognizer.mode).toBe("lsm");
        expect((await models(td.url)).body.recognizerEngine).toBe("faster-whisper");
      });

      it("配了 Python 的路径（spawn）：不改", async () => {
        const python = path.join(makeTempDir("ergo-py-"), "python.exe");
        fs.writeFileSync(python, "");
        const td = await untouched({ mode: "spawn", python }, /已有自己配的语音识别.*配置里的 Python/);
        expect(td.daemon.config.voice.recognizer.mode).toBe("spawn");
      });

      it("LSM 模式加手动配的 audio.cpp 同时在（这台机器就是这样）：还是不改", async () => {
        const td = await untouched({ mode: "lsm", url: "http://127.0.0.1:1" }, /已有自己配的语音识别/, { speechUp: true });
        expect(one((await view(td.url)).body, "audiocpp").state).toBe("provided");
      });
    });

    it("已有手动配的服务：写在用它，接口拒绝安装，什么都不登记", async () => {
      const fake = await startFakeDownloads();
      const speech = await startFakeSpeechService();
      const lsm = await startLsmStandIn({ owned: true });
      const td = await startTestDaemon({
        env: lsm.env,
        speechUrl: speech.url,
        components: { manifest: speechManifest(fake, Number(new URL(speech.url).port)), probes: undefined as unknown as ComponentProbes, transport: createHttpTransport() },
      });
      await waitUntil(() => lsm.connections > 0, { timeoutMs: 10_000 });
      const shown = (await view(td.url)).body;
      expect(one(shown, "tts")).toMatchObject({ state: "provided", providedBy: `已有自己配的语音合成，在用它（${speech.url}）` });
      expect(one(shown, "audiocpp").state).toBe("provided");
      expect(shown.features.find((f) => f.feature === "voice.reply")?.ready).toBe(true);
      const refused = await requestJson<HttpErrorBody>(td.url, HTTP_PATHS.component("tts"), { method: "POST", body: { action: "install", licenseAccepted: true } });
      expect(refused.status).toBe(400);
      expect(lsm.serviceRequests()).toEqual([]);
      expect(fake.requests).toEqual([]);
    });
  });
});
