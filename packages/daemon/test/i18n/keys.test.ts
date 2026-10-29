// 代码里用到的 key 都在语言文件里（168 号票）：t("…")、tParts("…")、<T k="…">、tTable({ …: "…" }) 里写的 key，中文的语言文件里
// 都要有（复数的几种写法算有）——key 写错了这里就挂，不用等到页面上显示出 key 本身。网页里用的 key 还得在网页打包的区域里
// （WEB_NAMESPACES，守护进程用的区域网页拿不到）。网页打包的 glob 和 WEB_NAMESPACES 两边一致。
// 拼出来的 key（`shell.language.problem.${code}`）查不到，由英文完整的测试和运行时的提示兜着。
// 175 号票：鸿蒙 App 原生（frontend/harmony 的 .ets）写的 t('…') 也查，而且只能是 harmony.*（App 只有这一块），这一块不分单复数（App 不挑）。
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_LANGUAGE, logicalKey, namespaceOf, WEB_NAMESPACES } from "@ergo/protocol";
import { describe, expect, it } from "vitest";
import { builtinCatalogs } from "../../src/i18n/index.ts";

const REPO = fileURLToPath(new URL("../../../../", import.meta.url));
const SOURCES = ["packages/web/src", "packages/daemon/src", "packages/protocol/src", "frontend/harmony/entry/src/main/ets"];

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (/\.(ts|tsx|ets)$/.test(entry.name)) out.push(full);
  }
  return out;
}

/** 一个文件里写死的 key（只认字面量写的；tx 是鸿蒙 App 的 Index.ets 里读着 textsRevision 的 t） */
export function keysIn(code: string): string[] {
  const keys: string[] = [];
  for (const m of code.matchAll(/\b(?:t|tx|tParts)\(\s*["'`]([A-Za-z][\w.-]*)["'`]/g)) keys.push(m[1]!);
  for (const m of code.matchAll(/<T\s+k="([A-Za-z][\w.-]*)"/g)) keys.push(m[1]!);
  for (const m of code.matchAll(/\btTable\(\{([\s\S]*?)\}\)/g)) for (const v of m[1]!.matchAll(/:\s*"([A-Za-z][\w.-]*)"/g)) keys.push(v[1]!);
  return keys;
}

describe("代码里用到的 key", () => {
  const zh = builtinCatalogs().catalogs.get(DEFAULT_LANGUAGE)!.messages;
  const known = new Set(Object.keys(zh).map(logicalKey));
  const files = SOURCES.flatMap((dir) => walk(path.join(REPO, dir)));

  it("认得出各种写法", () => {
    expect(keysIn(`t("shell.a"); tParts('shell.b', {}); <T k="shell.c" params={{}} />; const x = tTable({ a: "shell.d", "b-c": "shell.e" });`)).toEqual(["shell.a", "shell.b", "shell.c", "shell.d", "shell.e"]);
    expect(keysIn("const n = count(1); format(\"x\")")).toEqual([]);
  });

  it("中文的语言文件里都有", () => {
    const missing = files.flatMap((file) => keysIn(fs.readFileSync(file, "utf8")).filter((k) => !known.has(k)).map((k) => `${path.relative(REPO, file)}：${k}`));
    expect(missing).toEqual([]);
    // 起码真的找到了一些（写法认错了这条会是空的、上一条白过）
    expect(files.flatMap((file) => keysIn(fs.readFileSync(file, "utf8"))).length).toBeGreaterThan(50);
  });

  it("网页里用的 key 在网页打包的区域里", () => {
    const web = new Set<string>(WEB_NAMESPACES);
    const wrong = files
      .filter((file) => file.includes(`${path.sep}web${path.sep}src${path.sep}`))
      .flatMap((file) => keysIn(fs.readFileSync(file, "utf8")).filter((k) => !web.has(namespaceOf(k))).map((k) => `${path.relative(REPO, file)}：${k}`));
    expect(wrong).toEqual([]);
  });

  it("鸿蒙 App 原生只用 harmony.* 的 key，这一块不分单复数", () => {
    const ets = files.filter((file) => file.endsWith(".ets"));
    const used = ets.flatMap((file) => keysIn(fs.readFileSync(file, "utf8")));
    expect(used.length).toBeGreaterThan(50);
    expect(used.filter((k) => namespaceOf(k) !== "harmony")).toEqual([]);
    for (const [language, entry] of builtinCatalogs().catalogs) {
      const plural = Object.keys(entry.messages).filter((k) => namespaceOf(k) === "harmony" && logicalKey(k) !== k);
      expect({ language, plural }).toEqual({ language, plural: [] });
    }
  });

  it("网页打包的 glob 和 WEB_NAMESPACES 一致", () => {
    const bundle = fs.readFileSync(path.join(REPO, "packages/web/src/app/locale-bundle.ts"), "utf8");
    const braces = /locales\/\*\/\{([^}]+)\}\.json/.exec(bundle)?.[1]?.split(",") ?? [];
    expect(braces.filter((n) => n !== "_meta").toSorted()).toEqual([...WEB_NAMESPACES].toSorted());
    expect(braces).toContain("_meta");
  });
});
