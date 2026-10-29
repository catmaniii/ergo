// 网页这一侧的多语言（168 号票）：打包进去的自带语言、垫在守护进程给的词典下面、记在这台设备上、一打开就用上次的。
import { afterEach, describe, expect, test } from "vitest";
import { applyDictionary, appliedLocale, bootLocale, bundledLocale, layeredLocale } from "../../src/app/locale.ts";
import { BUNDLED_LOCALES } from "../../src/app/locale-bundle.ts";
import { activeLocale, type LocaleDictionaryView, setActiveLocale, t, WEB_NAMESPACES } from "../../src/state/index.ts";

const before = activeLocale();
afterEach(() => setActiveLocale(before));

/** 假的 localStorage */
function memoryStorage(initial: Record<string, string> = {}) {
  const data = new Map(Object.entries(initial));
  return { getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => void data.set(k, v), removeItem: (k: string) => void data.delete(k), data };
}

const EN_META = { id: "en", nativeName: "English", modelName: "English", intlLocale: "en" };

describe("打包进去的自带语言", () => {
  test("中文、英文都在，只有网页用到的区域（守护进程自己用的 i18n.* 不打进来）", () => {
    expect([...BUNDLED_LOCALES.keys()].toSorted()).toEqual(["en", "zh-CN"]);
    const namespaces = new Set([...BUNDLED_LOCALES.values()].flatMap((e) => Object.keys(e.messages).map((k) => k.split(".")[0]!)));
    for (const ns of namespaces) expect(WEB_NAMESPACES as readonly string[]).toContain(ns);
    expect(BUNDLED_LOCALES.get("zh-CN")!.messages["i18n.unknownLanguage"]).toBeUndefined();
    expect(BUNDLED_LOCALES.get("en")!.messages["shell.nav.secretary"]).toBe("Secretary");
  });
});

describe("守护进程给的词典", () => {
  test("垫上打包进去的：守护进程改了的用它的；它没有的新句子（守护进程比网页旧）用打包进去的；都没有的回退中文", () => {
    const view: LocaleDictionaryView = { language: "en", meta: EN_META, messages: { "shell.nav.secretary": "Assistant" }, fallback: { "shell.nav.tasks": "事情" }, revision: "b-1" };
    setActiveLocale(layeredLocale(view));
    expect(t("shell.nav.secretary")).toBe("Assistant");
    expect(t("shell.nav.projects")).toBe("Projects");
    expect(activeLocale().fallback["shell.nav.tasks"]).toBe("事情");
  });

  test("用户自己加的语言：缺的用中文（守护进程给的中文垫在打包进去的中文上面）", () => {
    const view: LocaleDictionaryView = {
      language: "fr",
      meta: { id: "fr", nativeName: "Français", modelName: "French", intlLocale: "fr" },
      messages: { "shell.nav.secretary": "Secrétaire" },
      fallback: { "shell.nav.secretary": "秘书" },
      revision: "b-2",
    };
    setActiveLocale(layeredLocale(view));
    expect(t("shell.nav.secretary")).toBe("Secrétaire");
    expect(t("shell.nav.tasks")).toBe("任务");
    expect(t("shell.pages.debug.minutesLeft", { count: 2, minutes: 2 })).toBe("还剩 2 分钟");
  });

  test("装上就记到这台设备上；下次打开先用记着的那份（不先闪一下中文），版本也记着（同一版不再取）", () => {
    const storage = memoryStorage();
    applyDictionary({ language: "en", meta: EN_META, messages: { "shell.nav.secretary": "Assistant" }, fallback: {}, revision: "b-3" }, () => storage);
    expect(storage.data.has("ergo-locale")).toBe(true);
    setActiveLocale(bundledLocale("zh-CN"));
    expect(t("shell.nav.secretary")).toBe("秘书");
    bootLocale(() => storage);
    expect(t("shell.nav.secretary")).toBe("Assistant");
    expect(appliedLocale()).toEqual({ language: "en", revision: "b-3" });
  });

  test("没记过、记的东西坏了、存储用不了：用打包进去的中文；原型按地址给的语言", () => {
    bootLocale(() => memoryStorage({ "ergo-locale": "{坏的" }));
    expect(t("shell.nav.secretary")).toBe("秘书");
    bootLocale(() => {
      throw new Error("隐私模式");
    });
    expect(t("shell.nav.secretary")).toBe("秘书");
    bootLocale(() => memoryStorage(), "en");
    expect(t("shell.nav.secretary")).toBe("Secretary");
  });
});
