// 语言目录（168 号票）：自带的中文、英文齐不齐；~/.ergo/locales 里放一个目录就是新语言、放同名 key 就改译法、放坏了有说明不崩；
// 轮询看到变化。
import fs from "node:fs";
import path from "node:path";
import { compareMessages, DEFAULT_LANGUAGE, logicalKey, namespaceOf } from "@ergo/protocol";
import { describe, expect, it } from "vitest";
import { BUILTIN_LOCALES_DIR, buildCatalogs, builtinCatalogs, createLocales, readLocaleRoot } from "../../src/i18n/index.ts";
import { waitUntil } from "../helpers/process.ts";
import { makeTempDir } from "../helpers/temp-dir.ts";

const write = (root: string, rel: string, content: unknown) => {
  const file = path.join(root, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, typeof content === "string" ? content : JSON.stringify(content));
};

describe("自带的语言", () => {
  it("中文、英文都在，读的时候没有问题；_meta.json 写了本地名、给模型的语言名、区域码", () => {
    const set = builtinCatalogs();
    expect([...set.catalogs.keys()]).toEqual(["zh-CN", "en"]);
    expect(set.builtinProblems).toEqual([]);
    expect(set.catalogs.get("zh-CN")!.meta).toEqual({ id: "zh-CN", nativeName: "中文", modelName: "中文", intlLocale: "zh-CN" });
    expect(set.catalogs.get("en")!.meta).toEqual({ id: "en", nativeName: "English", modelName: "English", intlLocale: "en" });
  });

  it("自带的英文必须全有：不缺句、不多句、两边的插值参数一样", () => {
    const set = builtinCatalogs();
    const report = compareMessages(set.catalogs.get(DEFAULT_LANGUAGE)!.messages, set.catalogs.get("en")!.messages);
    expect(report).toEqual({ missing: [], extra: [], paramMismatch: [] });
  });

  it("自带的语言文件按区域分：文件名就是 key 的第一段（每张迁移票只碰自己区域的文件），两种语言的文件一一对应", () => {
    const root = readLocaleRoot(BUILTIN_LOCALES_DIR);
    const filesOf = (id: string) => root.dirs.find((d) => d.id === id)!.files.map((f) => f.name);
    expect(filesOf("en")).toEqual(filesOf("zh-CN"));
    for (const dir of root.dirs) {
      for (const file of dir.files) {
        const ns = file.name.replace(/\.json$/, "");
        const wrong = Object.keys(file.messages).filter((key) => namespaceOf(key) !== ns);
        expect(wrong, `${dir.id}/${file.name}`).toEqual([]);
      }
    }
  });

  it("中文不用单复数的后缀（中文只有一种写法，写不带后缀的那句）", () => {
    const zh = builtinCatalogs().catalogs.get(DEFAULT_LANGUAGE)!.messages;
    expect(Object.keys(zh).filter((key) => logicalKey(key) !== key)).toEqual([]);
  });
});

const builtin = () => readLocaleRoot(BUILTIN_LOCALES_DIR);

describe("~/.ergo/locales 里放的", () => {
  it("新目录是新语言（排在自带的后面），缺的不补（运行时查不到用中文）；同名目录里的同名 key 覆盖自带的译法", () => {
    const user = makeTempDir("ergo-locales-");
    write(user, "fr/_meta.json", { nativeName: "Français", modelName: "French" });
    write(user, "fr/shell.json", { "shell.nav.tasks": "Tâches" });
    write(user, "en/mine.json", { "shell.nav.tasks": "Jobs", "shell.nav.more": "More…" });
    const set = buildCatalogs(builtin(), readLocaleRoot(user));
    expect([...set.catalogs.keys()]).toEqual(["zh-CN", "en", "fr"]);
    expect(set.problems).toEqual([]);
    const fr = set.catalogs.get("fr")!;
    expect(fr).toMatchObject({ source: "user", meta: { id: "fr", nativeName: "Français", modelName: "French", intlLocale: "fr" }, messages: { "shell.nav.tasks": "Tâches" } });
    const en = set.catalogs.get("en")!;
    expect(en).toMatchObject({ source: "builtin_user", overridden: 2 });
    expect(en.messages["shell.nav.tasks"]).toBe("Jobs");
    expect(en.messages["shell.nav.projects"]).toBe("Projects");
  });

  it("放坏了的逐条记下（哪个文件、哪里错），能用的照用，不抛错", () => {
    const user = makeTempDir("ergo-locales-");
    write(user, "fr/_meta.json", { nativeName: "Français" });
    write(user, "fr/broken.json", '{ "shell.nav.tasks": "Tâches", }');
    write(user, "fr/list.json", ["x"]);
    write(user, "fr/ok.json", { "shell.nav.more": "Plus", "shell.nav.tasks": 3 });
    write(user, "de/shell.json", { "shell.nav.tasks": "Aufgaben" });
    write(user, "ja/_meta.json", { modelName: "Japanese" });
    write(user, "en_US/shell.json", {});
    write(user, "en/_meta.json", "{");
    const set = buildCatalogs(builtin(), readLocaleRoot(user));
    expect([...set.catalogs.keys()]).toEqual(["zh-CN", "en", "fr"]);
    expect(set.catalogs.get("fr")!.messages).toEqual({ "shell.nav.more": "Plus" });
    // 自带语言的覆盖目录里 _meta.json 坏了：只是不换说明
    expect(set.catalogs.get("en")!.meta.nativeName).toBe("English");
    const problems = set.problems.map(({ detail, ...p }) => (detail === undefined ? p : { ...p, detail: detail.length > 0 }));
    expect(problems).toEqual(
      expect.arrayContaining([
        { file: "en_US/", code: "bad_dir" },
        { file: "en/_meta.json", code: "bad_json", detail: true },
        { file: "fr/broken.json", code: "bad_json", detail: true },
        { file: "fr/list.json", code: "not_object" },
        { file: "fr/ok.json", code: "bad_value", key: "shell.nav.tasks" },
        { file: "de/", code: "missing_meta" },
        { file: "ja/_meta.json", code: "bad_meta", detail: true },
      ]),
    );
    expect(problems).toHaveLength(7);
  });

  it("带 BOM 的 UTF-8（Windows 记事本存的）照样认", () => {
    const user = makeTempDir("ergo-locales-");
    write(user, "fr/_meta.json", `﻿${JSON.stringify({ nativeName: "Français" })}`);
    expect(buildCatalogs(builtin(), readLocaleRoot(user)).catalogs.has("fr")).toBe(true);
  });

  it("盯着目录：放进新语言、改了句子都看得到（版本号加一、通知），内容没变不算变；目录一开始不存在也行", async () => {
    const root = makeTempDir("ergo-data-");
    const user = path.join(root, "locales");
    const lines: string[] = [];
    const locales = createLocales({ userDir: user, pollMs: 20, log: (l) => lines.push(l) });
    locales.start();
    try {
      expect(locales.summaries().map((s) => s.id)).toEqual(["zh-CN", "en"]);
      let changes = 0;
      locales.onChange(() => changes++);
      write(user, "fr/_meta.json", { nativeName: "Français" });
      write(user, "fr/shell.json", { "shell.nav.tasks": "Tâches" });
      await waitUntil(() => locales.catalog("fr") !== undefined);
      expect(locales.revision()).toBeGreaterThan(0);
      const fr = locales.summaries().find((s) => s.id === "fr")!;
      expect(fr).toMatchObject({ nativeName: "Français", source: "user", overridden: 0 });
      expect(fr.missing).toBeGreaterThan(10);
      const before = changes;
      // 同样的内容重写一遍：修改时间变了，内容没变，不算变
      write(user, "fr/shell.json", { "shell.nav.tasks": "Tâches" });
      expect(locales.reload()).toBe(false);
      expect(changes).toBe(before);
      write(user, "fr/shell.json", { "shell.nav.tasks": "Les tâches" });
      await waitUntil(() => locales.catalog("fr")?.messages["shell.nav.tasks"] === "Les tâches");
      expect(changes).toBe(before + 1);
    } finally {
      locales.stop();
    }
  });
});
