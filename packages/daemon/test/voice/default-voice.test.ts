// 内置的默认参考音色（ADR-0036）：开源版自带一条，首次启动装进数据目录的 voices 区、选中当默认，装完就有声音、不用先导入。
// - 素材在 src/voice/default-voice/（reference.wav 已经是 16 kHz 单声道 PCM16，reference.txt 是逐字稿）；
// - 幂等：voices 区里已经有一条（哪怕是用户自己的）就什么都不做；装过一次就不再装；
// - 删除语义：用户删了内置的那条就是他的意思，重启不再长回来（装的时候留下 voices/.default-voice-installed.json 这个标记）；
// - 显示名走 t()：中文「小满」、英文「Xiaoman」（voice.json 里的名字只是给用户翻目录时看的）。
// 这里的素材是真的（不是编的示例），但两条路径都不起服务、不用 ffmpeg、不联网：单元用例自己开一个临时 voices 区，
// 守护进程用例走测试底座（临时数据目录，不碰 ~/.ergo）。
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { activeLocaleFrom, DEFAULT_LANGUAGE, HTTP_PATHS, setActiveLocale } from "@ergo/protocol";
import { afterEach, describe, expect, it } from "vitest";
import { builtinCatalogs } from "../../src/i18n/index.ts";
import { DEFAULT_VOICE_ASSET_DIR, DEFAULT_VOICE_ID, DEFAULT_VOICE_MARKER, openReferenceVoices } from "../../src/voice/reference-voices.ts";
import { readWav } from "../../src/voice/wav.ts";
import { startTestDaemon } from "../helpers/daemon.ts";
import { request } from "../helpers/http.ts";
import { makeTempDir } from "../helpers/temp-dir.ts";
import { makeWav, referenceVoicesApi } from "../helpers/tts.ts";

/** 素材里的逐字稿（和录音里念的一字不差） */
const TRANSCRIPT = "妈妈你看，我把今天的作业都写完了，字也写得特别整齐。现在能去楼下玩一会儿吗？我保证六点之前回来。";

/** 素材的录音：24 kHz 的原产物用 ffmpeg 重采样成 16 kHz 单声道 PCM16 的那一份（README.md 里写着） */
const ASSET = { bytes: 271_952, sha256: "df84fd844b1c73a17ec8b66d82f0c437ec15064d5c9236fb2a4d8fb4dd6aa47b", durationMs: 8_496 };

/** 内置音色装的时候不转码：这个转换器一次都不该被调到 */
const NEVER_CONVERT = {
  convert: () => {
    throw new Error("装内置音色不该走 ffmpeg");
  },
};

/** 单元用例用一个临时 voices 区（不碰 ~/.ergo）；defaultVoice 的素材目录可以换成假的 */
function voicesOn(prefix: string, assetDir: string = DEFAULT_VOICE_ASSET_DIR) {
  const dir = path.join(makeTempDir(prefix), "voices");
  const log: string[] = [];
  const voices = openReferenceVoices({ dir, log: (line) => log.push(line), converter: NEVER_CONVERT, defaultVoice: { assetDir } });
  return { dir, log, voices };
}

const use = (language: string) => setActiveLocale(activeLocaleFrom(builtinCatalogs().catalogs, language));
afterEach(() => use(DEFAULT_LANGUAGE));

describe("内置音色的素材", () => {
  it("reference.wav 是 16 kHz、单声道、PCM16 的 8.5 秒，reference.txt 就是那段逐字稿；大小和 sha256 和 README 写的一样", () => {
    const wav = fs.readFileSync(path.join(DEFAULT_VOICE_ASSET_DIR, "reference.wav"));
    expect(fs.readFileSync(path.join(DEFAULT_VOICE_ASSET_DIR, "reference.txt"), "utf8").trim()).toBe(TRANSCRIPT);
    expect(readWav(wav)).toMatchObject({ encoding: "pcm", bitsPerSample: 16, sampleRate: 16_000, channels: 1, durationMs: ASSET.durationMs });
    expect(wav.length).toBe(ASSET.bytes);
    expect(createHash("sha256").update(wav).digest("hex")).toBe(ASSET.sha256);
  });
});

describe("首次启动装上内置的默认参考音色", () => {
  it("voices 区空着：写成 v-default（录音、逐字稿、voice.json 里带名字、sha256、时长、importedAt、内置的标记），并设成在用的那个", () => {
    const { dir, log, voices } = voicesOn("ergo-voice-default-");
    expect(voices.list()).toEqual({ voices: [] });
    expect(voices.ensureDefault()).toMatchObject({ id: DEFAULT_VOICE_ID, name: "小满", referenceText: TRANSCRIPT, durationMs: ASSET.durationMs, sha256: ASSET.sha256, builtin: true });

    // 数据目录里的样子：英文 id 的目录，录音和素材逐字节一样，逐字稿、voice.json、选中它的 current.json、装过的标记
    const voiceDir = path.join(dir, DEFAULT_VOICE_ID);
    expect(fs.readFileSync(path.join(voiceDir, "reference.wav"))).toEqual(fs.readFileSync(path.join(DEFAULT_VOICE_ASSET_DIR, "reference.wav")));
    expect(fs.readFileSync(path.join(voiceDir, "reference.txt"), "utf8")).toBe(TRANSCRIPT);
    const meta = JSON.parse(fs.readFileSync(path.join(voiceDir, "voice.json"), "utf8"));
    expect(meta).toMatchObject({
      format: 1,
      id: DEFAULT_VOICE_ID,
      name: "小满",
      audioFile: "reference.wav",
      referenceTextFile: "reference.txt",
      durationMs: ASSET.durationMs,
      sha256: ASSET.sha256,
      builtin: true,
    });
    expect(meta.importedAt).toEqual(expect.any(String));
    expect(meta.importedAt).not.toBe("");
    expect(JSON.parse(fs.readFileSync(path.join(dir, "current.json"), "utf8"))).toEqual({ format: 1, voiceId: DEFAULT_VOICE_ID });
    expect(JSON.parse(fs.readFileSync(path.join(dir, DEFAULT_VOICE_MARKER), "utf8"))).toMatchObject({ format: 1, voiceId: DEFAULT_VOICE_ID, installedAt: meta.importedAt });

    // 列表里只有它，而且是在用的那个；列表里不带磁盘位置
    expect(voices.list()).toEqual({
      voices: [{ id: DEFAULT_VOICE_ID, name: "小满", referenceText: TRANSCRIPT, durationMs: ASSET.durationMs, sha256: ASSET.sha256, importedAt: meta.importedAt, builtin: true }],
      currentId: DEFAULT_VOICE_ID,
    });
    expect(voices.current()?.audioPath).toBe(path.join(voiceDir, "reference.wav"));
    // 日志只说装上了、多长，不写录音内容和逐字稿正文
    expect(log.join("\n")).toContain(`装上了内置的默认参考音色 ${DEFAULT_VOICE_ID}（8496 毫秒）`);
    expect(log.join("\n")).not.toContain("作业");
    // 没有半截的临时目录
    expect(fs.readdirSync(dir).filter((name) => name.startsWith(".installing-"))).toEqual([]);
  });

  it("voices 区里已经有用户自己的音色：什么都不做，用户的目录、current.json、显示名一个字都不动", () => {
    const { dir, voices } = voicesOn("ergo-voice-kept-");
    const mine = path.join(dir, "v-mine");
    fs.mkdirSync(mine, { recursive: true });
    fs.writeFileSync(path.join(mine, "reference.wav"), fs.readFileSync(path.join(DEFAULT_VOICE_ASSET_DIR, "reference.wav")));
    fs.writeFileSync(path.join(mine, "reference.txt"), "我自己录的。", "utf8");
    fs.writeFileSync(
      path.join(mine, "voice.json"),
      JSON.stringify({ format: 1, id: "v-mine", name: "我的音色", audioFile: "reference.wav", referenceTextFile: "reference.txt", durationMs: 3000, sha256: "ab".repeat(32), importedAt: "2026-01-01T10:00:00+08:00" }),
    );
    const before = fs.readFileSync(path.join(mine, "voice.json"), "utf8");

    expect(voices.ensureDefault()).toBeUndefined();
    expect(fs.existsSync(path.join(dir, DEFAULT_VOICE_ID))).toBe(false);
    expect(fs.existsSync(path.join(dir, DEFAULT_VOICE_MARKER))).toBe(false);
    expect(fs.existsSync(path.join(dir, "current.json"))).toBe(false);
    expect(fs.readFileSync(path.join(mine, "voice.json"), "utf8")).toBe(before);
    expect(voices.list()).toMatchObject({ voices: [{ id: "v-mine", name: "我的音色" }], currentId: "v-mine" });
  });

  it("重复启动（再开一个、同一个数据目录）：不重复装，装的时刻也不变", () => {
    const first = voicesOn("ergo-voice-again-");
    const installed = first.voices.ensureDefault();
    expect(installed?.importedAt).toBeTruthy();
    expect(first.voices.ensureDefault()).toBeUndefined();

    // 守护进程重启：新开一个（同一个目录），照旧只有一条、时刻没变
    const again = openReferenceVoices({ dir: first.dir, log: () => {}, converter: NEVER_CONVERT, defaultVoice: { assetDir: DEFAULT_VOICE_ASSET_DIR } });
    expect(again.ensureDefault()).toBeUndefined();
    expect(again.list()).toMatchObject({ voices: [{ id: DEFAULT_VOICE_ID, importedAt: installed?.importedAt }], currentId: DEFAULT_VOICE_ID });
    expect(fs.readdirSync(first.dir).filter((name) => name === DEFAULT_VOICE_ID)).toHaveLength(1);
  });

  it("用户删掉了内置的那条：再启动不会又长回来（装过的标记还在）", () => {
    const { dir, voices } = voicesOn("ergo-voice-deleted-");
    voices.ensureDefault();
    expect(voices.remove(DEFAULT_VOICE_ID)).toEqual({ voices: [] });
    expect(fs.existsSync(path.join(dir, DEFAULT_VOICE_ID))).toBe(false);
    // 标记留着：那就是「装过」的证据
    expect(fs.existsSync(path.join(dir, DEFAULT_VOICE_MARKER))).toBe(true);
    // 同一个实例、以及守护进程重启后的新实例都不再装
    expect(voices.ensureDefault()).toBeUndefined();
    const again = openReferenceVoices({ dir, log: () => {}, converter: NEVER_CONVERT, defaultVoice: { assetDir: DEFAULT_VOICE_ASSET_DIR } });
    expect(again.ensureDefault()).toBeUndefined();
    expect(again.list()).toEqual({ voices: [] });
  });

  it("用户的音色被删光、但从来没装过内置的：再启动照「一条都没有就装内置的」办（用户还是听得到声音）", () => {
    const { dir, voices } = voicesOn("ergo-voice-empty-again-");
    fs.mkdirSync(path.join(dir, "v-mine"), { recursive: true });
    fs.writeFileSync(path.join(dir, "v-mine", "reference.wav"), fs.readFileSync(path.join(DEFAULT_VOICE_ASSET_DIR, "reference.wav")));
    fs.writeFileSync(path.join(dir, "v-mine", "reference.txt"), "我自己录的。", "utf8");
    fs.writeFileSync(path.join(dir, "v-mine", "voice.json"), JSON.stringify({ format: 1, id: "v-mine", name: "我的音色", audioFile: "reference.wav", referenceTextFile: "reference.txt" }));
    expect(voices.ensureDefault()).toBeUndefined();
    // 用户删掉自己的（目录整个没了）
    fs.rmSync(path.join(dir, "v-mine"), { recursive: true, force: true });
    expect(voices.ensureDefault()).toMatchObject({ id: DEFAULT_VOICE_ID, builtin: true });
  });

  it("素材不全或者不是最终格式：不装、不抛（装不上不能挡住守护进程启动）", () => {
    // 素材目录是空的
    const empty = voicesOn("ergo-voice-noasset-", makeTempDir("ergo-voice-empty-asset-"));
    expect(empty.voices.ensureDefault()).toBeUndefined();
    expect(empty.voices.list()).toEqual({ voices: [] });
    expect(fs.existsSync(path.join(empty.dir, DEFAULT_VOICE_MARKER))).toBe(false);
    expect(empty.log.join("\n")).toContain("内置的默认参考音色装不上");

    // 逐字稿有、录音是 8 kHz 的（导入会经 ffmpeg 转；内置的素材必须是最终格式，所以不装）
    const wrong = makeTempDir("ergo-voice-wrong-asset-");
    fs.writeFileSync(path.join(wrong, "reference.txt"), TRANSCRIPT, "utf8");
    fs.writeFileSync(path.join(wrong, "reference.wav"), makeWav(3));
    const broken = voicesOn("ergo-voice-broken-", wrong);
    expect(broken.voices.ensureDefault()).toBeUndefined();
    expect(broken.log.join("\n")).toContain("不是 16 kHz 单声道 PCM16");
    expect(fs.existsSync(path.join(broken.dir, DEFAULT_VOICE_ID))).toBe(false);
  });
});

describe("内置音色的显示名", () => {
  it("跟着界面语言变：中文是「小满」，英文是「Xiaoman」；voice.json 里的名字只是给用户翻目录时看的", () => {
    const { dir, voices } = voicesOn("ergo-voice-name-");
    voices.ensureDefault();
    expect(voices.list().voices[0]?.name).toBe("小满");
    use("en");
    expect(voices.list().voices[0]?.name).toBe("Xiaoman");
    expect((JSON.parse(fs.readFileSync(path.join(dir, DEFAULT_VOICE_ID, "voice.json"), "utf8")) as { name: string }).name).toBe("小满");
  });
});

describe("守护进程起来以后", () => {
  it("新装的数据目录：设置页列出内置的这一条并选中它，试听拿得到录音；重启不重复装；删掉以后重启不再长回来", async () => {
    const first = await startTestDaemon();
    const listed = (await referenceVoicesApi.list(first.url)).body;
    expect(listed.voices).toMatchObject([{ id: DEFAULT_VOICE_ID, name: "小满", referenceText: TRANSCRIPT, durationMs: ASSET.durationMs, sha256: ASSET.sha256, builtin: true }]);
    expect(listed.currentId).toBe(DEFAULT_VOICE_ID);
    // 试听就是素材那份录音
    const audio = await request(first.url, HTTP_PATHS.referenceVoiceAudio(DEFAULT_VOICE_ID));
    expect(audio.status).toBe(200);
    expect(audio.body).toEqual(fs.readFileSync(path.join(DEFAULT_VOICE_ASSET_DIR, "reference.wav")));

    // 重启：只装一次
    await first.daemon.stop();
    const second = await startTestDaemon({ reuse: { dataDir: first.dataDir, homeDir: first.homeDir } });
    expect((await referenceVoicesApi.list(second.url)).body).toMatchObject({ voices: [{ id: DEFAULT_VOICE_ID, importedAt: listed.voices[0]!.importedAt }], currentId: DEFAULT_VOICE_ID });

    // 删掉：重启以后一条都没有，也不再长回来
    expect((await referenceVoicesApi.remove(second.url, DEFAULT_VOICE_ID)).body).toEqual({ voices: [] });
    await second.daemon.stop();
    const third = await startTestDaemon({ reuse: { dataDir: first.dataDir, homeDir: first.homeDir } });
    expect((await referenceVoicesApi.list(third.url)).body).toEqual({ voices: [] });
    expect(fs.existsSync(path.join(third.dataDir, "voices", DEFAULT_VOICE_ID))).toBe(false);
    // 用户以后自己导入的照常成为在用的那个（内置的不会再插进来）
    const imported = await importMine(third.url);
    expect((await referenceVoicesApi.list(third.url)).body.currentId).toBe(imported);
  });
});

/** 导入一条用户的音色（3 秒的 WAV），返回它的 id */
async function importMine(url: string): Promise<string> {
  const res = await referenceVoicesApi.import(url, { name: "我的音色", referenceText: "我自己录的。", audio: makeWav(3) });
  if (res.status !== 201) throw new Error(`导入参考音色失败：${res.status} ${JSON.stringify(res.body)}`);
  return res.body.id;
}
