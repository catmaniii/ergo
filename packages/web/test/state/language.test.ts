// 前端状态层：多语言（168 号票）。语言频道上的 language 事件归并成设置里选的、临时事件 locale 归并成实际在用的和词典的版本；
// 设置 · 语言每一行写什么、读语言文件出的问题怎么说（按当前语言）；外壳的字按当前语言现取（导航的 NAV_LABELS）。
import { afterEach, describe, expect, test } from "vitest";
import {
  activeLocale,
  activeLocaleFrom,
  CHANNELS,
  EVENT_TYPES,
  initialUiState,
  languageGoneText,
  languageRows,
  type LocaleListView,
  localeProblemText,
  NAV_LABELS,
  reduce,
  replay,
  setActiveLocale,
} from "../../src/state/index.ts";
import { TEST_LOCALES } from "../setup-locales.ts";
import { frame } from "./events.ts";

const zhLocale = activeLocale();
const english = () => setActiveLocale(activeLocaleFrom(TEST_LOCALES, "en"));
afterEach(() => setActiveLocale(zhLocale));

const VIEW: LocaleListView = {
  language: "zh-CN",
  effective: "zh-CN",
  userDir: "C:\\Users\\me\\.ergo\\locales",
  languages: [
    { id: "zh-CN", nativeName: "中文", source: "builtin", overridden: 0, missing: 0 },
    { id: "en", nativeName: "English", source: "builtin_user", overridden: 1, missing: 0 },
    { id: "fr", nativeName: "Français", source: "user", overridden: 0, missing: 3 },
  ],
  problems: [{ file: "de/", code: "missing_meta" }],
  revision: "r-1",
};

describe("语言频道", () => {
  test("language 事件是设置里选的；临时事件 locale 是实际在用的和词典的版本；重新同步语言频道时清掉选的", () => {
    let state = replay([frame(CHANNELS.language, 1, EVENT_TYPES.language, { language: "en", source: "settings" })]);
    expect(state.language).toBe("en");
    state = reduce(state, { kind: "frame", frame: frame(CHANNELS.language, 1, EVENT_TYPES.locale, { language: "en", revision: "b-2" }) });
    expect(state.locale).toEqual({ language: "en", revision: "b-2" });
    expect(reduce(state, { kind: "resync", channel: CHANNELS.language }).language).toBeUndefined();
    expect(initialUiState.language).toBeUndefined();
    expect(initialUiState.locale).toBeUndefined();
  });
});

describe("设置 · 语言", () => {
  test("每一行：本地名不翻；小字写自带的、来自哪个目录、改了几句、缺几句（中文）", () => {
    expect(languageRows(VIEW)).toEqual([
      { id: "zh-CN", nativeName: "中文", current: true, selected: true, notes: ["自带"] },
      { id: "en", nativeName: "English", current: false, selected: false, notes: ["自带，C:\\Users\\me\\.ergo\\locales 里改了 1 句"] },
      { id: "fr", nativeName: "Français", current: false, selected: false, notes: ["来自 C:\\Users\\me\\.ergo\\locales", "缺 3 句，用中文补"] },
    ]);
  });

  test("英文下：单复数跟着数变", () => {
    english();
    const rows = languageRows({ ...VIEW, languages: [...VIEW.languages, { id: "ja", nativeName: "日本語", source: "user", overridden: 0, missing: 1 }] });
    expect(rows.find((r) => r.id === "en")!.notes).toEqual(["Built in, 1 line changed in C:\\Users\\me\\.ergo\\locales"]);
    expect(rows.find((r) => r.id === "fr")!.notes).toEqual(["From C:\\Users\\me\\.ergo\\locales", "3 lines missing, shown in Chinese"]);
    expect(rows.find((r) => r.id === "ja")!.notes[1]).toBe("1 line missing, shown in Chinese");
  });

  test("选的语言不在了（实际用中文）才写一句", () => {
    expect(languageGoneText(VIEW)).toBeUndefined();
    expect(languageGoneText({ ...VIEW, language: "fr", effective: "fr" })).toBeUndefined();
    expect(languageGoneText({ ...VIEW, language: "de" })).toBe("选的语言「de」不在了（C:\\Users\\me\\.ergo\\locales 里删掉了？），先用中文。");
  });

  test("读语言文件出的问题按种类写成话", () => {
    expect(localeProblemText({ file: "de/", code: "missing_meta" })).toBe("新语言要有 _meta.json（至少写本地名 nativeName），这种语言没认");
    expect(localeProblemText({ file: "fr/a.json", code: "bad_json", detail: "Unexpected token" })).toBe("不是合法的 JSON：Unexpected token");
    expect(localeProblemText({ file: "fr/a.json", code: "bad_value", key: "shell.nav.tasks" })).toBe("「shell.nav.tasks」不是一句话（要是字符串），这句没用上");
    english();
    expect(localeProblemText({ file: "fr/a.json", code: "not_object" })).toBe('It must look like { "key": "text" }');
  });
});

describe("外壳的字按当前语言现取", () => {
  test("导航的名字：中文和原来一字不差，英文是英文；换语言不用重新建表", () => {
    expect(NAV_LABELS.secretary).toBe("秘书");
    expect(NAV_LABELS.inbox).toBe("待办");
    english();
    expect(NAV_LABELS.secretary).toBe("Secretary");
    expect(NAV_LABELS.inbox).toBe("Inbox");
    expect(NAV_LABELS.more).toBe("More");
  });
});
