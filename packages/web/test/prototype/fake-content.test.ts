// 假数据按界面语言出内容（prototype/fake-content.ts、prototype/en/）：
// - 表要全：原型源码里每个中文字面量都有英文，表里也没有源码里已经没有的字；英文里没有中文，插值个数对得上；
// - 只换字：同一份假数据中英两边结构、个数、顺序、状态、数字都一样，只有文字不同（金额按约定换成美元，除外）；
// - 中文界面原样不动（拿到的就是原来那个对象）。
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, test, vi } from "vitest";
import { scanSource } from "../../../daemon/src/i18n/hardcoded.ts";
import { EN_PHRASES } from "../../src/prototype/en/index.ts";
import { fakeFormat, fakeMoney, fakeText, hasChinese, localized, localizedFake } from "../../src/prototype/fake-content.ts";
import { FakeConnection } from "../../src/prototype/fake-connection.ts";
import { FAKE_BOARD, FAKE_DEVICES, FAKE_INBOX, FAKE_PROJECT_DETAILS, FAKE_PROJECTS, FAKE_TASK_DETAILS, fakeUsageSummary, projectDetailOf, taskDetailOf } from "../../src/prototype/fake-data.ts";
import { FAKE_CARDS, FAKE_HISTORY } from "../../src/prototype/fake-conversations.ts";
import { FakeDaemonHttp } from "../../src/prototype/fake-http.ts";
import { activeLocaleFrom, type ConversationId, DEFAULT_LANGUAGE, EVENT_TYPES, setActiveLocale, type UiInput } from "../../src/state/index.ts";
import { TEST_LOCALES } from "../setup-locales.ts";

vi.mock("../../src/app/build-info.ts", () => ({ APP_VERSION: "0.0.0-test", CHANGELOG: "", PAGE_WEB_VERSION: undefined }));

const PROTOTYPE = fileURLToPath(new URL("../../src/prototype/", import.meta.url));

/** 自己带着英文、不走表的文件（say(中文, 英文)）；工具自己 */
const NOT_IN_BOOK = new Set(["fake-plugins.ts", "fake-content.ts"]);

const inEnglish = () => setActiveLocale(activeLocaleFrom(TEST_LOCALES, "en"));
const inChinese = () => setActiveLocale(activeLocaleFrom(TEST_LOCALES, DEFAULT_LANGUAGE));

afterEach(inChinese);

/** 字面量的字（扫描器给的是源码的写法）换成运行时的样子 */
const cooked = (raw: string) => raw.replaceAll("\r\n", "\n").replace(/\\(.)/g, (_all, c: string) => (c === "n" ? "\n" : c));
const withoutHoles = (key: string) => key.replaceAll("{}", "");

function sourceLiterals(): { file: string; text: string; template: boolean }[] {
  return fs
    .readdirSync(PROTOTYPE)
    .filter((name) => /\.tsx?$/.test(name) && !NOT_IN_BOOK.has(name))
    .flatMap((file) =>
      scanSource(fs.readFileSync(path.join(PROTOTYPE, file), "utf8"))
        .literals.filter((l) => l.kind !== "regex")
        .map((l) => ({ file, text: cooked(l.text), template: l.kind === "template" })),
    );
}

describe("表要全", () => {
  const keys = Object.keys(EN_PHRASES);
  const covers = new Set(keys.map(withoutHoles));

  test("原型源码里每个中文字面量都有英文（缺的列出来）", () => {
    const missing = sourceLiterals()
      .filter((l) => !covers.has(withoutHoles(l.text)))
      .map((l) => `${l.file}: ${l.text.slice(0, 80)}`);
    expect(missing).toEqual([]);
  });

  test("表里没有源码里已经没有的字", () => {
    // 有的字是从字面量里取出来显示的（"anniversary:结婚纪念日"的后半截），算在
    const literals = sourceLiterals().map((l) => withoutHoles(l.text));
    expect(keys.filter((key) => !literals.some((l) => l.includes(withoutHoles(key)))).map((key) => key.slice(0, 80))).toEqual([]);
  });

  test("英文里没有中文，也不空着；插值个数对得上", () => {
    const bad = Object.entries(EN_PHRASES).filter(([zh, en]) => en.trim() === "" || hasChinese(en) || zh.split("{}").length !== en.split("{}").length);
    expect(bad.map(([zh, en]) => `${zh.slice(0, 40)} => ${en.slice(0, 40)}`)).toEqual([]);
  });
});

describe("只换字：数字和中文一样", () => {
  const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
  // 金额按约定换成了美元，不比
  const withoutMoney = (text: string) => text.replace(/¥[\d,.]+/g, " ").replace(/\$[\d,.]+/g, " ").replace(/[\d,.]+ ?元/g, " ").replace(/那笔 \d+/g, " ");
  const numbers = (text: string): number[] => (withoutMoney(text).replace(/(\d),(?=\d{3})/g, "$1").match(/\d+(?:\.\d+)?/g) ?? []).map(Number);
  const monthNumbers = (text: string): number[] =>
    [...text.toLowerCase().matchAll(/\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\b/g)].map((m) => MONTHS.indexOf(m[1]!) + 1);
  /** 代码块、网页源码里的英文单词（color: #1f2328、march）不算，比数字用不着它们 */
  const take = (bag: number[], n: number) => {
    const at = bag.indexOf(n);
    if (at < 0) return false;
    bag.splice(at, 1);
    return true;
  };

  test("中文里写成阿拉伯数字的，英文里都在（日期里的月份可以写成英文的月份名）", () => {
    const bad = Object.entries(EN_PHRASES).flatMap(([zh, en]) => {
      const bag = [...numbers(en), ...monthNumbers(en)];
      const lost = numbers(zh).filter((n) => !take(bag, n));
      return lost.length === 0 ? [] : [`${zh.slice(0, 60)} => ${en.slice(0, 60)}: 少了 ${lost.join(",")}`];
    });
    expect(bad).toEqual([]);
  });

  test("金额都是美元：英文里没有人民币", () => {
    expect(Object.entries(EN_PHRASES).filter(([, en]) => /¥|￥|\byuan\b|\bCNY\b|\bRMB\b/.test(en)).map(([zh]) => zh.slice(0, 60))).toEqual([]);
  });

  test("金额：同一笔钱各处一致，午饭 32 元是 $12，打车 46 元是 $7", () => {
    expect(EN_PHRASES["打车 46 元"]).toBe("Taxi $7");
    expect(EN_PHRASES["午饭 32 元"]).toBe("Lunch $12");
    expect(EN_PHRASES["合计 ¥1,280.00 × 85% = ¥1,088.00"]).toContain("$180.00");
    expect(EN_PHRASES["您本月的账单已出，应还 1,280.00 元，到期日 11 月 8 日。\n\n这是一封示例邮件。"]).toContain("$180.00");
    expect(EN_PHRASES["1 笔：09-30 ¥1,050"]).toContain("$150");
    expect(EN_PHRASES["记了：09-30 交的物业费 ¥1,050，归在「住房」。"]).toContain("$150");
  });
});

type Tree = unknown;

/** 比两棵假数据：结构、个数、顺序、状态、数字一样，只有文字不同。moneyKeys 下面的数字（金额）不比 */
function compare(zh: Tree, en: Tree, where: string, out: string[], moneyKeys: ReadonlySet<string> = new Set()): void {
  if (typeof zh === "string") {
    if (typeof en !== "string") out.push(`${where}: 不是字符串了`);
    else if (!hasChinese(zh) && zh !== en) out.push(`${where}: 没有中文的字变了：${zh.slice(0, 40)} → ${String(en).slice(0, 40)}`);
    else if (hasChinese(en) && !ACTION_WORDS_AT.test(where)) out.push(`${where}: 还有中文：${en.slice(0, 80)}`);
    return;
  }
  if (Array.isArray(zh)) {
    if (!Array.isArray(en) || en.length !== zh.length) return void out.push(`${where}: 个数不同`);
    zh.forEach((item, i) => compare(item, en[i], `${where}[${i}]`, out, moneyKeys));
    return;
  }
  if (zh !== null && typeof zh === "object" && Object.getPrototypeOf(zh) === Object.prototype) {
    if (en === null || typeof en !== "object") return void out.push(`${where}: 不是对象了`);
    const left = Object.entries(zh);
    const right = Object.entries(en);
    if (left.length !== right.length) return void out.push(`${where}: 键的个数不同`);
    left.forEach(([key, value], i) => {
      const [enKey, enValue] = right[i]!;
      if (!hasChinese(key) && key !== enKey) out.push(`${where}.${key}: 键变了`);
      if (moneyKeys.has(key)) return;
      compare(value, enValue, `${where}.${key}`, out, moneyKeys);
    });
    return;
  }
  if (zh !== en) out.push(`${where}: ${String(zh)} ≠ ${String(en)}`);
}

/** 待办的动作：协议包认得的存中文原字（按字认），显示时协议包换 */
const ACTION_WORDS_AT = /\.(actions|handled)(\[\d+\])?$/;

function framesOf(connection: FakeConnection): UiInput[] {
  const frames: UiInput[] = [];
  connection.connect({}, (input) => {
    if (input.kind === "frame") frames.push(input);
  })();
  return frames;
}

describe("只换字：两种语言的假数据一一对应", () => {
  const STATIC = { FAKE_BOARD, FAKE_DEVICES, FAKE_INBOX, FAKE_PROJECTS, FAKE_CARDS, FAKE_HISTORY, FAKE_TASK_DETAILS, FAKE_PROJECT_DETAILS };

  test("内存里的假数据：结构、个数、顺序、状态、数字都一样，只有文字不同", () => {
    inEnglish();
    const out: string[] = [];
    compare(STATIC, localized(STATIC), "fake", out);
    expect(out).toEqual([]);
  });

  test("假连接推的事件（打开时补发的历史）", () => {
    const connection = new FakeConnection();
    const zh = framesOf(connection);
    inEnglish();
    const en: UiInput[] = [];
    localizedFake(connection).connect({}, (input) => {
      if (input.kind === "frame") en.push(input);
    })();
    const out: string[] = [];
    expect(en.length).toBe(zh.length);
    compare(zh, en, "frames", out);
    expect(out).toEqual([]);
  });

  test("假 HTTP 的回复：记忆、素材、档案、数据源、背后的 agent、模型、提示词……", async () => {
    const http = new FakeDaemonHttp(new FakeConnection());
    const all = async (api: FakeDaemonHttp) => ({
      memory: await api.memorySummary(),
      claims: await api.memoryClaims(),
      claim1: await api.memoryClaim("cl-0001"),
      claim2: await api.memoryClaim("cl-0002"),
      questions: await api.memoryQuestions(),
      strategies: await api.memoryStrategies(),
      materials: await api.materialList(undefined, { offset: 0, limit: 200 }),
      files: await api.personalFiles(),
      me: await api.personalFile("me"),
      prompts: await api.systemPrompts(),
      voices: await api.voiceModels(),
      backup: await api.backupStatus(),
      calendar: await api.calendarMonth("2026-10"),
    });
    const zh = await all(http);
    inEnglish();
    const en = await all(localizedFake(http));
    // 秘书主线最后演过一次会话回退：被放弃那条分支的详情也只换字
    const branch = framesOf(new FakeConnection()).flatMap((input) => (input.kind === "frame" && input.frame.type === EVENT_TYPES.sessionBranch ? [input.frame] : []))[0];
    expect(branch).toBeDefined();
    const { from } = branch!.payload as { from: string };
    const view = (api: FakeDaemonHttp) => api.branchView(branch!.channel as ConversationId, from);
    inChinese();
    const zhBranch = await view(http);
    inEnglish();
    const enBranch = await view(localizedFake(http));
    const out: string[] = [];
    compare(zh, en, "http", out);
    compare(zhBranch, enBranch, "branch", out);
    expect(out).toEqual([]);
  });

  test("消耗页：token 数、次数不变，钱换成美元（约 7 元 = 1 美元）", () => {
    const range = { from: "2026-10-01", to: "2026-10-07" };
    const zh = fakeUsageSummary(range);
    inEnglish();
    const en = localized(fakeUsageSummary(range));
    expect(zh.pricing.currency).toBe("CNY");
    expect(en.pricing.currency).toBe("USD");
    expect(en.total.tokens).toEqual(zh.total.tokens);
    expect(en.total.calls).toBe(zh.total.calls);
    expect(en.total.cost).toBeCloseTo(zh.total.cost / 7, 6);
    const out: string[] = [];
    compare(zh, en, "usage", out, new Set(["cost", "currency", "price", "prices"]));
    expect(out).toEqual([]);
  });
});

describe("按语言取字", () => {
  test("中文界面原样不动：字不换，对象还是原来那个", () => {
    expect(localized(FAKE_INBOX)).toBe(FAKE_INBOX);
    expect(fakeText("记账本")).toBe("记账本");
    expect(taskDetailOf("t-bills")).toBe(FAKE_TASK_DETAILS["t-bills"]);
    expect(projectDetailOf("p-ledger")).toBe(FAKE_PROJECT_DETAILS["p-ledger"]);
    expect(fakeFormat("{} 月 {} 日", 10, 7)).toBe("10 月 7 日");
    expect(fakeMoney(35)).toBe(35);
  });

  test("英文：查表、拼进去的字也换；默认名字的记号不动；假详情同一种语言拿到同一个对象", () => {
    inEnglish();
    expect(fakeText("记账本")).toBe("Ledger");
    expect(fakeText("项目「记账本」")).toBe("Project “Ledger”");
    expect(fakeText("提醒：交房租")).toBe("Reminder: pay rent");
    expect(fakeText("⟦个人助理⟧对话")).toBe("Chat with ⟦个人助理⟧");
    expect(fakeText("没有这个句子就原样")).toBe("没有这个句子就原样");
    expect(fakeFormat("{} 月 {} 日", 10, 7)).toBe("10/7");
    expect(fakeMoney(35)).toBe(5);
    expect(taskDetailOf("t-bills")).toBe(taskDetailOf("t-bills"));
  });

  test("调进假连接的参数换回中文：页面选的英文项目名，假数据里认得出来", () => {
    const calls: unknown[] = [];
    const fake = localizedFake({
      start(request: unknown) {
        calls.push(request);
        return { title: "记账本", projects: ["记账本"] };
      },
    });
    inEnglish();
    expect(fake.start({ action: "archive", projects: ["Ledger"], note: "随便写的话 free text" })).toEqual({ title: "Ledger", projects: ["Ledger"] });
    expect(calls).toEqual([{ action: "archive", projects: ["记账本"], note: "随便写的话 free text" }]);
  });

  test("回来的错误也换", async () => {
    const fake = localizedFake({
      fail() {
        return Promise.reject(new Error("没有这个项目"));
      },
      boom() {
        throw new Error("已被处理");
      },
    });
    inEnglish();
    await expect(fake.fail()).rejects.toThrow("No such project");
    expect(() => fake.boom()).toThrow("Already handled");
  });
});
