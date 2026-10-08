// 参考音色（规格第 22 节，32 号票）：用户导入的一段干净录音加它的逐字稿，agent 用语音回复时照它的声音克隆。属于个人数据，
// 存在数据目录的 voices 区（不进仓库），文件就是真相，不进事件日志：
//   voices/<id>/reference.wav   参考录音（只收 WAV）
//   voices/<id>/reference.txt   逐字稿（UTF-8；Fish 克隆要 voice_ref 和 reference_text 同时给）
//   voices/<id>/voice.json      { format: 1, id, name, audioFile, referenceTextFile, durationMs, sha256, importedAt }
//   voices/current.json         { format: 1, voiceId }：设置里选的那一个
// audio.cpp 读不了带中文的路径，所以目录和文件名都用英文 id（导入时生成 v-xxxxxxxx），显示名只在 voice.json 里。
// 不列出也不引用 audio.cpp 自带的音色库：用户想用其中某个，就手动导入。
// 语音回复用"现在的那个"：设置里选过的；没选过（或选的被删了）就用最早导入的（只有一个时就是它）。
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
  nowIso,
  REFERENCE_VOICE_MAX_BYTES,
  REFERENCE_VOICE_MAX_MS,
  REFERENCE_VOICE_MIN_MS,
  REFERENCE_VOICE_NAME_MAX,
  REFERENCE_VOICE_TEXT_MAX,
  type ReferenceVoice,
  type ReferenceVoiceList,
} from "@ergou/protocol";
import { RequestRejected } from "../errors.ts";
import { readWav } from "./wav.ts";

/** voice.json 和 current.json 的格式版本 */
const FORMAT = 1;
const AUDIO_FILE = "reference.wav";
const TEXT_FILE = "reference.txt";
const META_FILE = "voice.json";
const CURRENT_FILE = "current.json";

/** 一个参考音色，连同参考录音在磁盘上的位置（送给 audio.cpp 的 voice_ref） */
export interface ResolvedReferenceVoice extends ReferenceVoice {
  audioPath: string;
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
  /** 导入一个：同样的录音和名字已经导过就拿到那一个（created 为 false）。不合规矩的抛 RequestRejected */
  import(input: { name: string; referenceText: string; audio: Buffer }): { voice: ReferenceVoice; created: boolean };
  /** 选它作为语音回复用的 */
  select(voiceId: string): ReferenceVoiceList;
  /** 删掉它（目录整个删掉）；删的是现在用的那个时，退回最早导入的 */
  remove(voiceId: string): ReferenceVoiceList;
  /** 参考音色有了变化（导入、删除）时通知；返回取消的函数 */
  onChange(listener: () => void): () => void;
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
}

/** 只认单纯的文件名（voice.json 是个人数据，也不让它指到目录外面去） */
function plainFile(name: unknown): name is string {
  return typeof name === "string" && name !== "" && path.basename(name) === name && name !== "." && name !== "..";
}

/** 给设置页的样子：不带磁盘上的位置 */
function publicOf({ audioPath: _audioPath, ...voice }: ResolvedReferenceVoice): ReferenceVoice {
  return voice;
}

export function openReferenceVoices(options: { dir: string; log: (line: string) => void }): ReferenceVoices {
  const { dir, log } = options;
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
      name: meta.name,
      referenceText,
      durationMs: typeof meta.durationMs === "number" && meta.durationMs >= 0 ? Math.round(meta.durationMs) : 0,
      sha256: typeof meta.sha256 === "string" ? meta.sha256 : "",
      importedAt: typeof meta.importedAt === "string" ? meta.importedAt : "",
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
    if (!voice) throw new RequestRejected("not_found", `没有这个参考音色：${voiceId}`);
    return voice;
  };

  return {
    list,
    current: () => currentOf(all()),
    get: (voiceId) => (VOICE_ID.test(voiceId) ? readVoice(voiceId) : undefined),
    audioPath: (voiceId) => (VOICE_ID.test(voiceId) ? readVoice(voiceId)?.audioPath : undefined),
    import({ name: rawName, referenceText: rawText, audio }) {
      const name = rawName.trim();
      const referenceText = rawText.trim();
      if (!name || name.length > REFERENCE_VOICE_NAME_MAX) throw new RequestRejected("bad_params", `名字要写，最长 ${REFERENCE_VOICE_NAME_MAX} 个字`);
      if (!referenceText || referenceText.length > REFERENCE_VOICE_TEXT_MAX) throw new RequestRejected("bad_params", `逐字稿要写（参考录音里说的原话），最长 ${REFERENCE_VOICE_TEXT_MAX} 个字`);
      if (audio.length > REFERENCE_VOICE_MAX_BYTES) throw new RequestRejected("bad_params", `参考录音太大了（最大 ${REFERENCE_VOICE_MAX_BYTES / 1024 / 1024} MB）`);
      const wav = readWav(audio);
      if (!wav) throw new RequestRejected("bad_params", "参考录音要是 WAV 文件（PCM 或 32 位浮点）");
      if (wav.durationMs < REFERENCE_VOICE_MIN_MS) throw new RequestRejected("bad_params", `参考录音太短了：至少 ${REFERENCE_VOICE_MIN_MS / 1000} 秒（建议 5–15 秒干净的人声）`);
      if (wav.durationMs > REFERENCE_VOICE_MAX_MS) throw new RequestRejected("bad_params", `参考录音太长了：最长 ${REFERENCE_VOICE_MAX_MS / 1000} 秒（建议 5–15 秒干净的人声）`);
      const sha256 = createHash("sha256").update(audio).digest("hex");
      const same = all().find((v) => v.sha256 === sha256 && v.name === name);
      if (same) return { voice: publicOf(same), created: false };

      const id = `v-${randomUUID().slice(0, 8)}`;
      const meta: StoredMeta = { format: FORMAT, id, name, audioFile: AUDIO_FILE, referenceTextFile: TEXT_FILE, durationMs: wav.durationMs, sha256, importedAt: nowIso() };
      // 先写进临时目录，写全了再改名：半截的目录不会被列出来
      fs.mkdirSync(dir, { recursive: true });
      const staging = path.join(dir, `.importing-${randomUUID()}`);
      fs.mkdirSync(staging);
      try {
        fs.writeFileSync(path.join(staging, AUDIO_FILE), audio);
        fs.writeFileSync(path.join(staging, TEXT_FILE), referenceText, "utf8");
        fs.writeFileSync(path.join(staging, META_FILE), `${JSON.stringify(meta, null, 2)}\n`, "utf8");
        fs.renameSync(staging, path.join(dir, id));
      } catch (err) {
        fs.rmSync(staging, { recursive: true, force: true });
        throw err;
      }
      log(`导入了参考音色 ${id}（${wav.durationMs} 毫秒）`);
      changed();
      return { voice: publicOf(existing(id)), created: true };
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
    onChange(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}
