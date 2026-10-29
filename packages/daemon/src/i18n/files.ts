// 从磁盘读语言目录（168 号票）：自带的（packages/protocol/locales/）和用户放的（数据目录的 locales/，即 ~/.ergo/locales/）同一种读法。
// 每种语言一个目录（目录名是语言代码），里面一个 _meta.json 和若干 .json 语言文件；别的文件、子目录不管。
// 读到的问题（JSON 不合法、不是 { "key": "句子" }、某句不是字符串、目录名不是语言代码、读不了）逐条记下，不抛错——
// 用户放坏了文件不能让守护进程起不来，设置 · 语言里写明是哪个文件、哪里错。
import fs from "node:fs";
import path from "node:path";
import { isLanguageId, LOCALE_META_FILE, type LocaleFileProblem, type Messages, newNameOf, parseMessagesFile } from "@ergo/protocol";

/** 一个语言目录里读到的 */
export interface LocaleDirContent {
  /** 语言代码（目录名） */
  id: string;
  /** _meta.json 的内容（解析好的 JSON，还没校验）；没有这个文件是 undefined */
  meta?: unknown;
  /** 语言文件，按文件名排 */
  files: { name: string; messages: Messages }[];
}

/** 读文件出的一个问题：哪个文件（相对语言根目录的路径，用 / 分隔） */
export type LocaleProblem = LocaleFileProblem & { file: string };

export interface LocaleRootContent {
  dirs: LocaleDirContent[];
  problems: LocaleProblem[];
}

const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err));

/** 读一个 JSON 文件：读不了、不合法时记一个问题，回 undefined */
function readJson(file: string, rel: string, problems: LocaleProblem[]): { ok: true; value: unknown } | { ok: false } {
  let text: string;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch (err) {
    problems.push({ file: rel, code: "unreadable", detail: errorText(err) });
    return { ok: false };
  }
  try {
    // Windows 的记事本存的 UTF-8 带 BOM
    return { ok: true, value: JSON.parse(text.replace(/^﻿/, "")) };
  } catch (err) {
    problems.push({ file: rel, code: "bad_json", detail: errorText(err) });
    return { ok: false };
  }
}

function listDir(dir: string): fs.Dirent[] {
  try {
    return fs.readdirSync(dir, { withFileTypes: true }).toSorted((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  } catch {
    return [];
  }
}

/**
 * 312 号票：key 里的旧写法（protocol.eventSources.ergou.label 这种，ergo 以前的拼法）换成新的——用户早先放的语言文件照样盖得上；
 * 同一份文件里新旧两种都写了的，新的为准
 */
function withNewKeys(messages: Messages): Messages {
  const keys = Object.keys(messages);
  if (keys.every((k) => newNameOf(k) === k)) return messages;
  const out: Record<string, string> = {};
  for (const k of keys) if (newNameOf(k) === k) out[k] = messages[k]!;
  for (const k of keys) if (newNameOf(k) !== k && !(newNameOf(k) in out)) out[newNameOf(k)] = messages[k]!;
  return out;
}

/** 读一个语言根目录（不存在就是空的） */
export function readLocaleRoot(root: string): LocaleRootContent {
  const dirs: LocaleDirContent[] = [];
  const problems: LocaleProblem[] = [];
  for (const entry of listDir(root)) {
    if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
    if (!isLanguageId(entry.name)) {
      problems.push({ file: `${entry.name}/`, code: "bad_dir" });
      continue;
    }
    const dir = path.join(root, entry.name);
    const content: LocaleDirContent = { id: entry.name, files: [] };
    for (const file of listDir(dir)) {
      if (!file.isFile() || !file.name.toLowerCase().endsWith(".json")) continue;
      const rel = `${entry.name}/${file.name}`;
      const read = readJson(path.join(dir, file.name), rel, problems);
      if (!read.ok) continue;
      if (file.name === LOCALE_META_FILE) {
        content.meta = read.value;
        continue;
      }
      const parsed = parseMessagesFile(read.value);
      for (const p of parsed.problems) problems.push({ ...p, file: rel });
      content.files.push({ name: file.name, messages: withNewKeys(parsed.messages) });
    }
    dirs.push(content);
  }
  return { dirs, problems };
}

/**
 * 语言根目录现在的样子（每个 .json 的路径、大小、修改时间）：轮询时和上次的比，变了才重新读。
 * 不存在的目录是空串
 */
export function localeRootSignature(root: string): string {
  const parts: string[] = [];
  for (const entry of listDir(root)) {
    if (!entry.isDirectory()) continue;
    for (const file of listDir(path.join(root, entry.name))) {
      if (!file.isFile() || !file.name.toLowerCase().endsWith(".json")) continue;
      try {
        const stat = fs.statSync(path.join(root, entry.name, file.name));
        parts.push(`${entry.name}/${file.name}:${stat.size}:${stat.mtimeMs}`);
      } catch {
        parts.push(`${entry.name}/${file.name}:?`);
      }
    }
    parts.push(`${entry.name}/`);
  }
  return parts.join("\n");
}
