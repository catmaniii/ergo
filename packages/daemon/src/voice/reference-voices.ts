// 参考音色（规格第 22 节，32 号票）：用户导入的一段干净录音加它的逐字稿，agent 用语音回复时照它的声音克隆。属于个人数据，
// 存在数据目录的 voices 区（不进仓库），文件就是真相，不进事件日志：
//   voices/<id>/reference.wav   参考录音（230 号票起：导入的常见音频先经本机 ffmpeg 转成 16 kHz、单声道、PCM16 的 WAV 再存）
//   voices/<id>/reference.txt   逐字稿（UTF-8；Fish 克隆要 voice_ref 和 reference_text 同时给；230 号票起不给就自动识别）
//   voices/<id>/voice.json      { format: 1, id, name, audioFile, referenceTextFile, durationMs, sha256, importedAt, builtin? }
//   voices/current.json         { format: 1, voiceId }：设置里选的那一个
// audio.cpp 读不了带中文的路径，所以目录和文件名都用英文 id（导入时生成 v-xxxxxxxx），显示名只在 voice.json 里。
// 不列出也不引用 audio.cpp 自带的音色库：用户想用其中某个，就手动导入。
//
// 内置的默认参考音色（ADR-0036）：开源版自带一条，id 固定是 v-default，素材在 src/voice/default-voice/
// （reference.wav 已经是 16 kHz 单声道 PCM16，装的时候不转码、不用 ffmpeg、不联网）。数据目录的 voices 区一条参考音色都没有、
// 也没装过时，首次启动把它写进去、选中它当默认——装完就有声音，不用先导入。另有一个标记文件：
//   voices/.default-voice-installed.json   { format: 1, voiceId, installedAt }：装过一次就留下
// 删除语义（用户在设置里删掉内置的这条）：删了就是用户的意思，不再自动长回来。所以标记在**装的时候**写，不在删的时候写——
// 装过之后再启动就看到标记、什么都不做；从来没装过的（用户一上来就自己导入了）照"一条都没有时装内置的"办。
// 理由和取舍见 docs/adr/0036-builtin-default-voice.md。
// 语音回复用"现在的那个"：设置里选过的；没选过（或选的被删了）就用最早导入的（只有一个时就是它）。
// 230 号票（用户定"导入音频要支持更多类型……大不了用本地 ffmpeg 转""直接用语音转文本识别逐字稿"）：
// - 导入收 wav、mp3、m4a、aac、opus、ogg、flac、webm 等常见音频，转码在 audio-convert.ts（可注入，测试不真跑 ffmpeg）；
// - 1–30 秒按转换后的真实时长判；转不了、ffmpeg 不在、识别为空或失败都给明确的原因，不建目录；
// - 请求里给了 referenceText 就照用（兼容旧调用、手工修正），不给就调识别进程的 transcribe()（和语音消息共用）；
// - 日志只写 id、时长、识别不识别，不写音频内容和逐字稿正文。
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  nowIso,
  t,
  REFERENCE_VOICE_MAX_BYTES,
  REFERENCE_VOICE_MAX_MS,
  REFERENCE_VOICE_MIN_MS,
  REFERENCE_VOICE_NAME_MAX,
  REFERENCE_VOICE_TEXT_MAX,
  type ReferenceVoice,
  type ReferenceVoiceList,
} from "@ergo/protocol";
import { RequestRejected } from "../errors.ts";
import { renameRetrying, renameRetryingAsync, writeFileAtomic } from "../util/atomic-file.ts";
import type { AudioConverter } from "./audio-convert.ts";
import { type Recognizer, RecognizerUnavailable } from "./recognizer.ts";
import { readWav } from "./wav.ts";

/** voice.json 和 current.json 的格式版本 */
const FORMAT = 1;
const AUDIO_FILE = "reference.wav";
const TEXT_FILE = "reference.txt";
const META_FILE = "voice.json";
const CURRENT_FILE = "current.json";

/** 内置的默认参考音色在数据目录里的 id（固定；目录名只许英文字母、数字和连字符，audio.cpp 读不了中文路径） */
export const DEFAULT_VOICE_ID = "v-default";
/** 内置音色的素材在程序里：src/voice/default-voice/，发布包解开就有（不用下载、不用 ffmpeg、不联网） */
export const DEFAULT_VOICE_ASSET_DIR = fileURLToPath(new URL("./default-voice/", import.meta.url));
/** 装过一次留下的标记（见文件开头"删除语义"）：有它就不再自动装，用户删了以后重启不会长回来 */
export const DEFAULT_VOICE_MARKER = ".default-voice-installed.json";
/** 内置音色的显示名：每次读的时候现查（换了语言跟着变），中文"小满"、英文"Xiaoman" */
const DEFAULT_VOICE_NAME_KEY = "voice.reference.builtinName";

/** 一个参考音色，连同参考录音在磁盘上的位置（送给 audio.cpp 的 voice_ref） */
export interface ResolvedReferenceVoice extends ReferenceVoice {
  audioPath: string;
}

/** 导入一个参考音色要的东西：名字、录音（常见音频，转不转由实现来）、可选的逐字稿（230 号票：不给就自动识别） */
export interface ReferenceVoiceImport {
  name: string;
  referenceText?: string;
  audio: Buffer;
}

/** 自动识别逐字稿时给识别进程的语言和提示（和语音消息的识别一样） */
export interface ReferenceVoiceRecognition {
  language?: string;
  initialPrompt?: string;
}

/** 逐字稿自动识别没做成：识别进程没就绪、识别失败或超时（HTTP 回 503，带原因） */
export class ReferenceVoiceTranscribeFailed extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReferenceVoiceTranscribeFailed";
  }
}

export interface ReferenceVoices {
  /** 全部参考音色（按导入的先后）和现在用的那个 */
  list(): ReferenceVoiceList;
  /** 语音回复现在用的；一个都没有时为 undefined */
  current(): ResolvedReferenceVoice | undefined;
  /** 某一个（连同参考录音的位置）；没有时为 undefined */
  get(voiceId: string): ResolvedReferenceVoice | undefined;
  /** 某个参考音色的参考录音（试听用）；没有这个音色时为 undefined */
  audioPath(voiceId: string): string | undefined;
  /**
   * 导入一个：同样的录音和名字已经导过就拿到那一个（created 为 false）。不合规矩的抛 RequestRejected；
   * 230 号票起录音收常见音频（先经本机 ffmpeg 转成 16 kHz 单声道 WAV），不给逐字稿就自动识别（抛 ReferenceVoiceTranscribeFailed）
   */
  import(input: ReferenceVoiceImport): Promise<{ voice: ReferenceVoice; created: boolean }>;
  /** 选它作为语音回复用的 */
  select(voiceId: string): ReferenceVoiceList;
  /** 删掉它（目录整个删掉）；删的是现在用的那个时，退回最早导入的 */
  remove(voiceId: string): ReferenceVoiceList;
  /**
   * 首次启动装上内置的默认参考音色（ADR-0036）：voices 区一条参考音色都没有、又从来没装过时，把
   * src/voice/default-voice/ 的素材写成 v-default 并选中；已经有任何音色（哪怕是用户自己的）、装过了（用户删掉了）、
   * 素材不全时什么都不做。返回装上的那一条，没装时 undefined
   */
  ensureDefault(): ReferenceVoice | undefined;
  /** 参考音色有了变化（导入、删除）时通知；返回取消的函数 */
  onChange(listener: () => void): () => void;
}

/** 打开参考音色区要的东西 */
export interface ReferenceVoiceOptions {
  /** voices 区 */
  dir: string;
  log: (line: string) => void;
  /** 把导入的音频转成 16 kHz 单声道 PCM16 WAV 的执行器（230 号票；测试换成不跑 ffmpeg 的假的） */
  converter: AudioConverter;
  /** 自动识别逐字稿用的识别进程（和语音消息共用）；不给时只能导入带逐字稿的 */
  recognizer?: Recognizer;
  /** 自动识别时给识别进程的语言和提示 */
  recognition?: ReferenceVoiceRecognition;
  /** 内置的默认参考音色从哪个目录装（ADR-0036）；不给就没有内置音色（不起守护进程、自己造目录的测试） */
  defaultVoice?: { assetDir: string };
}

/** 目录名（音色 id）：英文字母、数字和连字符（audio.cpp 读不了带中文的路径） */
const VOICE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

interface StoredMeta {
  format: number;
  id: string;
  name: string;
  audioFile: string;
  referenceTextFile: string;
  durationMs: number;
  sha256: string;
  importedAt: string;
  /** 是开源版自带的默认音色（不是用户导入的）：显示名每次都按当时的语言现查 */
  builtin?: boolean;
}

/** 只认单纯的文件名（voice.json 是个人数据，也不让它指到目录外面去） */
function plainFile(name: unknown): name is string {
  return typeof name === "string" && name !== "" && path.basename(name) === name && name !== "." && name !== "..";
}

/** 给设置页的样子：不带磁盘上的位置 */
function publicOf({ audioPath: _audioPath, ...voice }: ResolvedReferenceVoice): ReferenceVoice {
  return voice;
}

export function openReferenceVoices(options: ReferenceVoiceOptions): ReferenceVoices {
  const { dir, log, converter, recognizer, recognition } = options;
  const listeners = new Set<() => void>();
  const changed = () => {
    for (const listener of listeners) {
      try {
        listener();
      } catch (err) {
        log(`参考音色变化的通知出错：${err instanceof Error ? err.message : String(err)}`);
      }
    }
  };

  /** 读一个音色目录；不像样的跳过（记日志） */
  const readVoice = (id: string): ResolvedReferenceVoice | undefined => {
    const voiceDir = path.join(dir, id);
    let meta: Partial<StoredMeta>;
    try {
      meta = JSON.parse(fs.readFileSync(path.join(voiceDir, META_FILE), "utf8")) as Partial<StoredMeta>;
    } catch {
      return undefined;
    }
    if (meta.format !== FORMAT || typeof meta.name !== "string" || !plainFile(meta.audioFile) || !plainFile(meta.referenceTextFile)) {
      log(`参考音色 ${id} 的 voice.json 不对（要 format 1、name、audioFile、referenceTextFile），没有列出`);
      return undefined;
    }
    const audioPath = path.join(voiceDir, meta.audioFile);
    let referenceText: string;
    try {
      referenceText = fs.readFileSync(path.join(voiceDir, meta.referenceTextFile), "utf8").replace(/^﻿/, "").trim();
    } catch {
      log(`参考音色 ${id} 没有逐字稿 ${meta.referenceTextFile}，没有列出`);
      return undefined;
    }
    if (!fs.existsSync(audioPath) || !referenceText) {
      log(`参考音色 ${id} 缺参考录音或逐字稿是空的，没有列出`);
      return undefined;
    }
    return {
      id,
      // 内置的那条显示名每次现查：用户换了语言以后设置页跟着变（voice.json 里的名字只是给用户翻目录时看的）
      name: meta.builtin === true ? t(DEFAULT_VOICE_NAME_KEY) : meta.name,
      referenceText,
      durationMs: typeof meta.durationMs === "number" && meta.durationMs >= 0 ? Math.round(meta.durationMs) : 0,
      sha256: typeof meta.sha256 === "string" ? meta.sha256 : "",
      importedAt: typeof meta.importedAt === "string" ? meta.importedAt : "",
      ...(meta.builtin === true ? { builtin: true as const } : {}),
      audioPath,
    };
  };

  /** 全部音色，按导入的先后（时间一样按 id） */
  const all = (): ResolvedReferenceVoice[] => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return [];
    }
    return entries
      .filter((e) => e.isDirectory() && VOICE_ID.test(e.name))
      .flatMap((e) => readVoice(e.name) ?? [])
      .toSorted((a, b) => (a.importedAt === b.importedAt ? (a.id < b.id ? -1 : 1) : Date.parse(a.importedAt) - Date.parse(b.importedAt) || (a.importedAt < b.importedAt ? -1 : 1)));
  };

  const selected = (): string | undefined => {
    try {
      const raw = JSON.parse(fs.readFileSync(path.join(dir, CURRENT_FILE), "utf8")) as { format?: unknown; voiceId?: unknown };
      return raw.format === FORMAT && typeof raw.voiceId === "string" ? raw.voiceId : undefined;
    } catch {
      return undefined;
    }
  };

  const currentOf = (voices: readonly ResolvedReferenceVoice[]): ResolvedReferenceVoice | undefined => {
    const id = selected();
    return voices.find((v) => v.id === id) ?? voices[0];
  };

  const list = (): ReferenceVoiceList => {
    const voices = all();
    const current = currentOf(voices);
    return { voices: voices.map(publicOf), ...(current ? { currentId: current.id } : {}) };
  };

  const existing = (voiceId: string): ResolvedReferenceVoice => {
    const voice = VOICE_ID.test(voiceId) ? readVoice(voiceId) : undefined;
    if (!voice) throw new RequestRejected("not_found", t("voice.reference.notFound", { id: voiceId }));
    return voice;
  };

  /** 自动识别逐字稿（230 号票）：识别进程没就绪、识别失败或超时都算 ReferenceVoiceTranscribeFailed（HTTP 503） */
  const transcribe = async (audioPath: string, audioMs: number): Promise<string> => {
    if (!recognizer) throw new RequestRejected("bad_params", t("voice.reference.noRecognizer"));
    let text: string;
    try {
      text = (await recognizer.transcribe({ path: audioPath, ...recognition }, audioMs)).text.trim();
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      log(`参考音色：自动识别逐字稿失败（${reason}）`);
      throw new ReferenceVoiceTranscribeFailed(err instanceof RecognizerUnavailable ? t("voice.reference.transcribeUnavailable", { reason }) : t("voice.reference.transcribeFailed", { reason }));
    }
    if (text === "") throw new RequestRejected("bad_params", t("voice.reference.emptyText"));
    return text;
  };

  /** 内置音色的素材：读出来量时长、算 sha256（素材本来就是 16 kHz 单声道 PCM16，不转码）；不全或不对时不装 */
  const defaultVoiceMaterial = (assetDir: string): { wav: Buffer; text: string; durationMs: number } | undefined => {
    let wav: Buffer;
    let text: string;
    try {
      wav = fs.readFileSync(path.join(assetDir, AUDIO_FILE));
      text = fs.readFileSync(path.join(assetDir, TEXT_FILE), "utf8").replace(/^﻿/, "").trim();
    } catch (err) {
      log(`内置的默认参考音色装不上：素材不全（${assetDir}）：${err instanceof Error ? err.message : String(err)}`);
      return undefined;
    }
    const parsed = readWav(wav);
    if (text === "" || !parsed || parsed.encoding !== "pcm" || parsed.bitsPerSample !== 16 || parsed.sampleRate !== 16000 || parsed.channels !== 1) {
      log("内置的默认参考音色装不上：素材不是 16 kHz 单声道 PCM16 的 WAV，或者逐字稿是空的");
      return undefined;
    }
    return { wav, text, durationMs: parsed.durationMs };
  };

  return {
    list,
    current: () => currentOf(all()),
    get: (voiceId) => (VOICE_ID.test(voiceId) ? readVoice(voiceId) : undefined),
    audioPath: (voiceId) => (VOICE_ID.test(voiceId) ? readVoice(voiceId)?.audioPath : undefined),
    async import({ name: rawName, referenceText: rawText, audio }) {
      const name = rawName.trim();
      const givenText = rawText?.trim() ?? "";
      if (!name || name.length > REFERENCE_VOICE_NAME_MAX) throw new RequestRejected("bad_params", t("voice.reference.badName", { max: REFERENCE_VOICE_NAME_MAX }));
      if (givenText.length > REFERENCE_VOICE_TEXT_MAX) throw new RequestRejected("bad_params", t("voice.reference.badText", { max: REFERENCE_VOICE_TEXT_MAX }));
      if (audio.length > REFERENCE_VOICE_MAX_BYTES) throw new RequestRejected("bad_params", t("voice.reference.tooBig", { max: REFERENCE_VOICE_MAX_BYTES / 1024 / 1024 }));
      // 同样的录音和名字：早就有，直接交回（230 号票：不必再转一次码）
      const sha256 = createHash("sha256").update(audio).digest("hex");
      const same = all().find((v) => v.sha256 === sha256 && v.name === name);
      if (same) return { voice: publicOf(same), created: false };

      // 230 号票：统一经本机 ffmpeg 转成 16 kHz、单声道、PCM16 的 WAV；1–30 秒按转换后的真实时长判
      const converted = await converter.convert(audio);
      try {
        const wav = readWav(converted.wav);
        if (!wav || wav.encoding !== "pcm" || wav.bitsPerSample !== 16 || wav.sampleRate !== 16000 || wav.channels !== 1) {
          throw new RequestRejected("bad_params", t("voice.reference.convertedBad"));
        }
        if (wav.durationMs < REFERENCE_VOICE_MIN_MS) throw new RequestRejected("bad_params", t("voice.reference.tooShort", { min: REFERENCE_VOICE_MIN_MS / 1000 }));
        if (wav.durationMs > REFERENCE_VOICE_MAX_MS) throw new RequestRejected("bad_params", t("voice.reference.tooLong", { max: REFERENCE_VOICE_MAX_MS / 1000 }));
        // 逐字稿：给了照用（兼容旧调用、手工修正），不给就自动识别（识别的是转换后的 WAV）
        const referenceText = givenText !== "" ? givenText : await transcribe(converted.path, wav.durationMs);
        if (referenceText.length > REFERENCE_VOICE_TEXT_MAX) throw new RequestRejected("bad_params", t("voice.reference.badText", { max: REFERENCE_VOICE_TEXT_MAX }));

        const id = `v-${randomUUID().slice(0, 8)}`;
        const meta: StoredMeta = { format: FORMAT, id, name, audioFile: AUDIO_FILE, referenceTextFile: TEXT_FILE, durationMs: wav.durationMs, sha256, importedAt: nowIso() };
        // 先写进临时目录，写全了再改名：半截的目录不会被列出来
        fs.mkdirSync(dir, { recursive: true });
        const staging = path.join(dir, `.importing-${randomUUID()}`);
        fs.mkdirSync(staging);
        try {
          fs.writeFileSync(path.join(staging, AUDIO_FILE), converted.wav);
          fs.writeFileSync(path.join(staging, TEXT_FILE), referenceText, "utf8");
          fs.writeFileSync(path.join(staging, META_FILE), `${JSON.stringify(meta, null, 2)}\n`, "utf8");
          // 刚写的文件被杀毒扫着时整个目录改名等一会儿重试（265 号票；异步等，不挡事件循环）
          await renameRetryingAsync(staging, path.join(dir, id));
        } catch (err) {
          fs.rmSync(staging, { recursive: true, force: true });
          throw err;
        }
        // 日志只写 id、时长和是不是自动识别的，不写音频内容和逐字稿正文
        log(`导入了参考音色 ${id}（${wav.durationMs} 毫秒${givenText === "" ? "，逐字稿是自动识别的" : ""}）`);
        changed();
        return { voice: publicOf(existing(id)), created: true };
      } finally {
        converted.cleanup();
      }
    },
    select(voiceId) {
      existing(voiceId);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, CURRENT_FILE), `${JSON.stringify({ format: FORMAT, voiceId })}\n`, "utf8");
      changed();
      return list();
    },
    remove(voiceId) {
      existing(voiceId);
      fs.rmSync(path.join(dir, voiceId), { recursive: true, force: true });
      if (selected() === voiceId) fs.rmSync(path.join(dir, CURRENT_FILE), { force: true });
      log(`删掉了参考音色 ${voiceId}`);
      changed();
      return list();
    },
    ensureDefault() {
      const assetDir = options.defaultVoice?.assetDir;
      if (!assetDir) return undefined;
      // 装不上不该挡住启动：出什么错都只记一行日志
      try {
        // 已经有任何一条参考音色（哪怕不是内置的）：什么都不做，绝不覆盖用户自己的
        if (all().length > 0) return undefined;
        // 装过了：用户后来把它删了，删了就是他的意思，重启不再长回来（ADR-0036）
        if (fs.existsSync(path.join(dir, DEFAULT_VOICE_MARKER))) return undefined;
        const voiceDir = path.join(dir, DEFAULT_VOICE_ID);
        // 目录在、却列不出来（voice.json 或逐字稿坏了）：不碰它，也不对内置的这条改名覆盖
        if (fs.existsSync(voiceDir)) {
          log(`内置的默认参考音色没装：${DEFAULT_VOICE_ID} 的目录已经在，但没有列出来（voice.json 或逐字稿不对？）`);
          return undefined;
        }
        const material = defaultVoiceMaterial(assetDir);
        if (!material) return undefined;
        const meta: StoredMeta = {
          format: FORMAT,
          id: DEFAULT_VOICE_ID,
          name: t(DEFAULT_VOICE_NAME_KEY),
          audioFile: AUDIO_FILE,
          referenceTextFile: TEXT_FILE,
          durationMs: material.durationMs,
          sha256: createHash("sha256").update(material.wav).digest("hex"),
          importedAt: nowIso(),
          builtin: true,
        };
        // 和导入一样：先写进临时目录，写全了再改名（半截的目录不会被列出来）
        fs.mkdirSync(dir, { recursive: true });
        const staging = path.join(dir, `.installing-${randomUUID()}`);
        fs.mkdirSync(staging);
        try {
          fs.writeFileSync(path.join(staging, AUDIO_FILE), material.wav);
          fs.writeFileSync(path.join(staging, TEXT_FILE), material.text, "utf8");
          fs.writeFileSync(path.join(staging, META_FILE), `${JSON.stringify(meta, null, 2)}\n`, "utf8");
          renameRetrying(staging, voiceDir);
        } catch (err) {
          fs.rmSync(staging, { recursive: true, force: true });
          throw err;
        }
        // 选中它（本来就只有这一条；明写一份，设置页上"在用的那个"有据可查）
        writeFileAtomic(path.join(dir, CURRENT_FILE), `${JSON.stringify({ format: FORMAT, voiceId: DEFAULT_VOICE_ID })}\n`);
        // 装过的标记写在最后：装了一半不算装过，下次启动接着装
        writeFileAtomic(path.join(dir, DEFAULT_VOICE_MARKER), `${JSON.stringify({ format: FORMAT, voiceId: DEFAULT_VOICE_ID, installedAt: meta.importedAt }, null, 2)}\n`);
        log(`装上了内置的默认参考音色 ${DEFAULT_VOICE_ID}（${material.durationMs} 毫秒）`);
        changed();
        const installed = readVoice(DEFAULT_VOICE_ID);
        return installed ? publicOf(installed) : undefined;
      } catch (err) {
        log(`内置的默认参考音色没装成：${err instanceof Error ? err.message : String(err)}`);
        return undefined;
      }
    },
    onChange(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}
