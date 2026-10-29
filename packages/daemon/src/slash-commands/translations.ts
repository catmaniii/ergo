// 斜杠命令的说明换成用户的语言（310 号票）：Claude Code 报回的命令、skill 带的说明多是英文的，界面是中文时候选里要看得懂。
// - 谁要换：skill 和运行时的命令（二狗自己的命令本来就按现在的语言写）；说明已经是用户的语言的不换（inLanguage：中文看有没有汉字，
//   英文看有没有汉字，别的语言认不出就都交给模型，模型照提示"已经是这种语言就原样回"）；已经查过表的（Claude Code 内置命令的中文说明表，
//   list.ts 的 runtimeEntries 换好、带着 originalDescription）不再翻；
// - 怎么换：用二狗的模型（秘书那一行，没配 key 时不翻）在一次性子进程里翻（runtime/translation.ts），只交说明原文；按"语言 + 命令名 + 原文"
//   缓存在数据目录的缓存区（slash-translations.json，随时能重新翻出来，不进备份），原文变了（skill 改了说明、Claude Code 升级）重新翻；
// - 第一次弹出时：先给原文、标 translating（网页开着候选时隔一会儿再取），同时排进翻译；翻好的写进缓存，下次取直接给译文，原文放进
//   originalDescription（展开的说明下面小字显示）；
// - 模型没配、出错（整批起不来、这一条没翻成）：照原文，不标 translating；出错的过 TRANSLATION_RETRY_MS 再试（不每次弹出都去花钱）；
// - 一次只跑一批（最多 TRANSLATION_BATCH_MAX 条，同一句原文只翻一次），排着的等它做完再起下一批。
import fs from "node:fs";
import path from "node:path";
import { activeLocale, type SlashCommandEntry, type SlashCommandList } from "@ergo/protocol";
import { writeJsonAtomic } from "../util/json-file.ts";

/** 账本里翻译调用记的会话 id（用量记成二狗的系统开销，agent 是秘书，purpose 是 translation） */
export const SLASH_TRANSLATION_SESSION = "slash-translation";

/** 出错（没翻成）的说明过多久再试 */
export const TRANSLATION_RETRY_MS = 10 * 60_000;

/** 缓存里最多留多少条（多了扔掉最早的） */
export const TRANSLATION_CACHE_MAX = 2000;

/** 一批最多几条（和 runtime/translation.ts 的 TRANSLATION_BATCH_MAX 一致；这里不引用 runtime，测试换假的翻译也照它分批） */
const BATCH_MAX = 20;

/**
 * 这句话是不是已经是这种语言的（不用翻）：中文看有没有汉字，英文看没有汉字；别的语言认不出，一律当不是（交给模型，它照提示原样回）
 */
export function inLanguage(text: string, language: string): boolean {
  const han = /\p{Script=Han}/u.test(text);
  if (language === "zh" || language.startsWith("zh-")) return han;
  if (language === "en" || language.startsWith("en-")) return !han;
  return false;
}

/** 翻一批说明（只交原文，language 是给模型看的语言名）：和 texts 一一对应，没翻成的是 null；整批做不了抛错 */
export type SlashTranslate = (texts: readonly string[], language: string) => Promise<ReadonlyArray<string | null>>;

export interface SlashTranslationsOptions {
  /** 缓存文件（数据目录缓存区的 slash-translations.json） */
  file: string;
  /** 现在能不能翻（二狗的模型配了没有）；不能时照原文、不排队 */
  available(): boolean;
  translate: SlashTranslate;
  /** 毫秒时钟（出错之后多久再试） */
  now(): number;
  log(line: string): void;
}

export interface SlashTranslations {
  /** 候选里的说明换成现在的语言的：缓存里有的换上（原文放 originalDescription），没有的排进翻译、标 translating */
  localize(list: SlashCommandList): SlashCommandList;
  /** 排着的、在翻的都做完（测试用） */
  idle(): Promise<void>;
}

/** 缓存文件里的一条 */
interface CachedTranslation {
  language: string;
  name: string;
  original: string;
  text: string;
}

/** 排着要翻的一条 */
interface Job {
  key: string;
  language: string;
  /** 给模型看的语言名 */
  modelName: string;
  name: string;
  original: string;
}

const keyOf = (language: string, name: string, original: string) => JSON.stringify([language, name, original]);

export function createSlashTranslations(options: SlashTranslationsOptions): SlashTranslations {
  const { log } = options;
  let cache: Map<string, CachedTranslation> | undefined;
  const pending = new Map<string, Job>();
  const inFlight = new Set<string>();
  /** 没翻成的：key → 什么时候 */
  const failed = new Map<string, number>();
  let running: Promise<void> | undefined;

  const loaded = (): Map<string, CachedTranslation> => {
    if (cache) return cache;
    cache = new Map();
    try {
      const raw = JSON.parse(fs.readFileSync(options.file, "utf8")) as { entries?: unknown };
      for (const item of Array.isArray(raw.entries) ? raw.entries : []) {
        const e = item as Partial<CachedTranslation>;
        if (typeof e.language === "string" && typeof e.name === "string" && typeof e.original === "string" && typeof e.text === "string") {
          cache.set(keyOf(e.language, e.name, e.original), { language: e.language, name: e.name, original: e.original, text: e.text });
        }
      }
    } catch (err) {
      // 没有这个文件是常态；读不出来就当空的（缓存随时能重新翻出来）
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") log(`斜杠命令说明的译文缓存读不出来，当作空的重新翻：${err instanceof Error ? err.message : String(err)}`);
    }
    return cache;
  };

  const save = () => {
    const entries = [...loaded().values()].slice(-TRANSLATION_CACHE_MAX);
    try {
      fs.mkdirSync(path.dirname(options.file), { recursive: true });
      writeJsonAtomic(options.file, { format: 1, entries });
    } catch (err) {
      log(`斜杠命令说明的译文缓存写不进去：${err instanceof Error ? err.message : String(err)}`);
    }
  };

  const runBatch = async (): Promise<void> => {
    const first = pending.values().next().value;
    if (!first) return;
    const batch: Job[] = [];
    for (const job of pending.values()) {
      if (job.language !== first.language) continue;
      batch.push(job);
      if (batch.length >= BATCH_MAX) break;
    }
    for (const job of batch) {
      pending.delete(job.key);
      inFlight.add(job.key);
    }
    // 同一句原文只翻一次（同一个 skill 在不同会话里写法不一样）
    const originals = [...new Set(batch.map((job) => job.original))];
    try {
      const texts = await options.translate(originals, first.modelName);
      const byOriginal = new Map(originals.map((original, i) => [original, texts[i] ?? null]));
      const store = loaded();
      let missed = 0;
      for (const job of batch) {
        const text = byOriginal.get(job.original);
        if (text) {
          store.delete(job.key);
          store.set(job.key, { language: job.language, name: job.name, original: job.original, text });
        } else {
          missed += 1;
          failed.set(job.key, options.now());
        }
      }
      if (missed < batch.length) save();
      if (missed > 0) log(`斜杠命令的说明有 ${missed} 条没翻成，先显示原文，${TRANSLATION_RETRY_MS / 60_000} 分钟后再试`);
    } catch (err) {
      for (const job of batch) failed.set(job.key, options.now());
      log(`斜杠命令的说明没翻成（先显示原文，${TRANSLATION_RETRY_MS / 60_000} 分钟后再试）：${err instanceof Error ? err.message : String(err)}`);
    } finally {
      for (const job of batch) inFlight.delete(job.key);
    }
  };

  const schedule = () => {
    if (running || pending.size === 0) return;
    running = runBatch().finally(() => {
      running = undefined;
      schedule();
    });
  };

  return {
    localize(list) {
      const meta = activeLocale().meta;
      const language = meta.id;
      const store = loaded();
      const localized = list.commands.map((entry): SlashCommandEntry => {
        if (entry.kind === "command" || entry.originalDescription !== undefined) return entry;
        const original = entry.description.trim();
        if (original === "" || inLanguage(original, language)) return entry;
        const name = entry.text.slice(1);
        const key = keyOf(language, name, original);
        const cached = store.get(key);
        if (cached) return cached.text === original ? entry : { ...entry, description: cached.text, originalDescription: entry.description };
        if (pending.has(key) || inFlight.has(key)) return { ...entry, translating: true };
        if (!options.available()) return entry;
        const failedAt = failed.get(key);
        if (failedAt !== undefined && options.now() - failedAt < TRANSLATION_RETRY_MS) return entry;
        pending.set(key, { key, language, modelName: meta.modelName, name, original });
        return { ...entry, translating: true };
      });
      schedule();
      return { commands: localized };
    },
    async idle() {
      // 一批做完会接着起下一批：等到没有在跑的为止
      for (let current = running; current; current = running) await current;
    },
  };
}
