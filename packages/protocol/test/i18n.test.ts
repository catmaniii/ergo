// 多语言的运行时（168 号票）：t() 的插值、单复数、回退中文、合并覆盖；语言文件的检查（缺的、多的、插值参数对不上）。
// 纯函数，不读文件：词典直接在这里写。
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  type ActiveLocale,
  activeLocale,
  compareMessages,
  DEFAULT_LANGUAGE,
  followLocale,
  forModel,
  formatList,
  formatNumber,
  isLanguageId,
  localeRevision,
  logicalKey,
  messageParams,
  mergeMessages,
  onLocaleChange,
  parseLocaleMeta,
  parseMessagesFile,
  setActiveLocale,
  setMissingMessageHandler,
  t,
  tParts,
  tTable,
} from "../src/index.ts";

const ZH = { id: "zh-CN", nativeName: "中文", modelName: "中文", intlLocale: "zh-CN" };
const EN = { id: "en", nativeName: "English", modelName: "English", intlLocale: "en" };

const zh = {
  "shell.nav.tasks": "任务",
  "shell.nav.more": "更多",
  "shell.greet": "你好，{name}",
  "shell.count": "{count} 个任务",
  "shell.only.zh": "只有中文",
  "shell.debug.left": "还剩 {minutes} 分钟",
};
const en = {
  "shell.nav.tasks": "Tasks",
  "shell.greet": "Hello, {name}",
  "shell.count_zero": "No tasks",
  "shell.count_one": "{count} task",
  "shell.count_other": "{count} tasks",
  "shell.debug.left_one": "{minutes} minute left",
  "shell.debug.left_other": "{minutes} minutes left",
};

const zhLocale: ActiveLocale = { meta: ZH, messages: zh, fallback: zh, fallbackMeta: ZH };
const enLocale: ActiveLocale = { meta: EN, messages: en, fallback: zh, fallbackMeta: ZH };

const before = activeLocale();
afterEach(() => {
  setActiveLocale(before);
  setMissingMessageHandler(undefined);
});

describe("t()", () => {
  it("按 key 取当前语言的一句，{name} 换成参数；没给的参数原样留着；不是 {标识符} 的花括号不动", () => {
    setActiveLocale(enLocale);
    expect(t("shell.nav.tasks")).toBe("Tasks");
    expect(t("shell.greet", { name: "Ergo" })).toBe("Hello, Ergo");
    expect(t("shell.greet")).toBe("Hello, {name}");
    setActiveLocale({ ...enLocale, messages: { ...en, "shell.raw": "{ a: 1 } and {x}" } });
    expect(t("shell.raw", { x: 2 })).toBe("{ a: 1 } and 2");
  });

  it("当前语言缺的回退中文（不提示）；中文也没有的回 key 本身，并提示一次", () => {
    setActiveLocale(enLocale);
    const missing = vi.fn<(key: string) => void>();
    setMissingMessageHandler(missing);
    expect(t("shell.only.zh")).toBe("只有中文");
    expect(t("shell.nav.more")).toBe("更多");
    expect(missing).not.toHaveBeenCalled();
    expect(t("shell.nope")).toBe("shell.nope");
    expect(t("shell.nope")).toBe("shell.nope");
    expect(missing).toHaveBeenCalledTimes(1);
    expect(missing).toHaveBeenCalledWith("shell.nope");
  });

  it("单复数：参数 count 按当前语言的 Intl.PluralRules 挑 key_one / key_other，0 有 key_zero 时用它；中文只有一种写法", () => {
    setActiveLocale(enLocale);
    expect(t("shell.count", { count: 0 })).toBe("No tasks");
    expect(t("shell.count", { count: 1 })).toBe("1 task");
    expect(t("shell.count", { count: 3 })).toBe("3 tasks");
    // 复数挑的是 count，插的参数可以是别的名字（count 只用来挑）
    expect(t("shell.debug.left", { count: 1, minutes: 1 })).toBe("1 minute left");
    expect(t("shell.debug.left", { count: 5, minutes: 5 })).toBe("5 minutes left");
    setActiveLocale(zhLocale);
    expect(t("shell.count", { count: 0 })).toBe("0 个任务");
    expect(t("shell.count", { count: 1 })).toBe("1 个任务");
    expect(t("shell.debug.left", { count: 5, minutes: 5 })).toBe("还剩 5 分钟");
  });

  it("回退到中文时复数按中文的规则挑（英文缺了这句，中文只有不带后缀的那句）", () => {
    setActiveLocale({ ...enLocale, messages: { "shell.nav.tasks": "Tasks" } });
    expect(t("shell.count", { count: 1 })).toBe("1 个任务");
  });

  it("tParts：插的参数可以是任意值（界面上放名字标签这类元素），按顺序和文字交错，空的段去掉", () => {
    setActiveLocale(enLocale);
    const tag = { tag: "name" };
    expect(tParts("shell.greet", { name: tag })).toEqual(["Hello, ", tag]);
    setActiveLocale({ ...enLocale, messages: { "shell.mid": "{a}x{b}" } });
    expect(tParts("shell.mid", { a: 1, b: 2 })).toEqual([1, "x", 2]);
  });

  it("tTable：常量表写成 key，取值时按当前语言现取（换语言不用重新建表）；可以 Object.entries、toEqual", () => {
    const table = tTable({ tasks: "shell.nav.tasks", more: "shell.nav.more" });
    setActiveLocale(zhLocale);
    expect(table.tasks).toBe("任务");
    expect(table).toEqual({ tasks: "任务", more: "更多" });
    setActiveLocale(enLocale);
    expect(Object.entries(table)).toEqual([
      ["tasks", "Tasks"],
      ["more", "更多"],
    ]);
  });

  it("换语言：版本号加一，登记的都被叫到；取消登记后不再叫", () => {
    const fn = vi.fn<() => void>();
    const off = onLocaleChange(fn);
    const rev = localeRevision();
    setActiveLocale(enLocale);
    expect(localeRevision()).toBe(rev + 1);
    expect(fn).toHaveBeenCalledTimes(1);
    off();
    setActiveLocale(zhLocale);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("forModel：给模型看的那份按中文（回退的那种）取，跑完换回来；不算换语言（版本号不变、不通知）（172 号票）", () => {
    setActiveLocale(enLocale);
    const fn = vi.fn<() => void>();
    const off = onLocaleChange(fn);
    const rev = localeRevision();
    expect(forModel(() => `${t("shell.nav.tasks")} / ${t("shell.greet", { name: "A" })}`)).toBe("任务 / 你好，A");
    expect(t("shell.nav.tasks")).toBe("Tasks");
    expect(() => forModel(() => { throw new Error("x"); })).toThrow("x");
    expect(t("shell.nav.tasks")).toBe("Tasks");
    expect(localeRevision()).toBe(rev);
    expect(fn).not.toHaveBeenCalled();
    off();
  });

  it("followLocale：装上过语言就先跑一次，之后每换一次再跑（导出的单个字符串常量跟着当前语言用它）（172 号票）", () => {
    setActiveLocale(zhLocale);
    let label = "";
    followLocale(() => {
      label = t("shell.nav.tasks");
    });
    expect(label).toBe("任务");
    setActiveLocale(enLocale);
    expect(label).toBe("Tasks");
    // forModel 里读到的是中文，出来换回当前语言
    expect(forModel(() => label)).toBe("任务");
    expect(label).toBe("Tasks");
  });
});

describe("按语言格式化（Intl）", () => {
  it("数字、列表按当前语言的区域码", () => {
    setActiveLocale(enLocale);
    expect(formatNumber(12345.5)).toBe("12,345.5");
    expect(formatList(["a", "b", "c"])).toBe("a, b, and c");
    setActiveLocale(zhLocale);
    expect(formatList(["甲", "乙", "丙"])).toBe("甲、乙和丙");
  });
});

describe("语言文件", () => {
  it("_meta.json：本地名必填；给模型的语言名不填用本地名，区域码不填用语言代码；格式不对的说清哪里错", () => {
    expect(parseLocaleMeta("fr", { nativeName: "Français" })).toEqual({ ok: true, meta: { id: "fr", nativeName: "Français", modelName: "Français", intlLocale: "fr" } });
    expect(parseLocaleMeta("pt-BR", { nativeName: "Português", modelName: "Brazilian Portuguese", intlLocale: "pt-BR" })).toMatchObject({ ok: true, meta: { modelName: "Brazilian Portuguese" } });
    expect(parseLocaleMeta("fr", { modelName: "French" })).toEqual({ ok: false, problem: { code: "bad_meta", detail: "nativeName" } });
    expect(parseLocaleMeta("fr", [])).toEqual({ ok: false, problem: { code: "bad_meta", detail: "_meta.json" } });
    expect(parseLocaleMeta("fr", { nativeName: "Français", intlLocale: "不是区域码" })).toEqual({ ok: false, problem: { code: "bad_meta", detail: "intlLocale" } });
  });

  it("语言代码：zh-CN、en、pt-BR 这类；带空格、点、下划线开头的不认", () => {
    for (const ok of ["zh-CN", "en", "fr", "pt-BR", "zh-Hant-TW"]) expect(isLanguageId(ok)).toBe(true);
    for (const bad of ["", "e", "en_US", ".git", "_meta", "中文", "en-"]) expect(isLanguageId(bad)).toBe(false);
  });

  it("一个语言文件：要是对象、值都是字符串；不是字符串的那句跳过并写明 key，别的照用", () => {
    expect(parseMessagesFile({ "shell.a": "甲", "shell.b": 2, "shell.c": "丙" })).toEqual({ messages: { "shell.a": "甲", "shell.c": "丙" }, problems: [{ code: "bad_value", key: "shell.b" }] });
    expect(parseMessagesFile(["x"])).toEqual({ messages: {}, problems: [{ code: "not_object" }] });
    expect(parseMessagesFile("x")).toEqual({ messages: {}, problems: [{ code: "not_object" }] });
  });

  it("合并：后面的同名 key 覆盖前面的（自带的被 ~/.ergo/locales 里的覆盖）", () => {
    expect(mergeMessages({ a: "1", b: "2" }, { b: "二" }, { c: "3" })).toEqual({ a: "1", b: "二", c: "3" });
  });

  it("复数的几种写法算同一句（logicalKey），插值参数取几种写法的并集", () => {
    expect(logicalKey("shell.count_one")).toBe("shell.count");
    expect(logicalKey("shell.count_other")).toBe("shell.count");
    expect(logicalKey("shell.count")).toBe("shell.count");
    expect(logicalKey("shell.snake_case")).toBe("shell.snake_case");
    expect(messageParams("{a} 和 {b}，{a}")).toEqual(["a", "b"]);
  });

  it("两种语言比一比：缺的、多的、插值参数对不上的（按逻辑上的一句比）", () => {
    const report = compareMessages(zh, { ...en, "shell.extra": "x", "shell.nav.more": "More {oops}" });
    expect(report.missing).toEqual(["shell.only.zh"]);
    expect(report.extra).toEqual(["shell.extra"]);
    expect(report.paramMismatch).toEqual([{ key: "shell.nav.more", expected: [], actual: ["oops"] }]);
  });

  it("默认语言是中文", () => {
    expect(DEFAULT_LANGUAGE).toBe("zh-CN");
  });
});
