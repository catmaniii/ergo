// 主切面：多语言（168 号票，用户 2026-10-19 定的三条）。
// - 全局一个语言：设置接口改，改了以后语言频道上推一条 language 事件和一条临时事件 locale，开着的前端都跟着变；存在配置区，重启后还在；
//   停着时手改了配置文件，启动后以文件为准补一条事件；只能选列表里有的；
// - 网页的词典：实际在用的语言，自带的加上 ~/.ergo/locales 里的（合好的，只有网页用到的区域），不是中文时连同中文的（回退用）；
// - 放一个文件就能加新语言：数据目录的 locales/ 里放一个新目录，不重启，设置 · 语言里就有它、能选，缺的句子用中文补；
//   放同名 key 能覆盖自带的译法；格式不对的写明是哪个文件、哪里错，守护进程照常；
// - 秘书和维护者用所选语言回答：不是中文时各 agent 的系统提示末尾多一句"用 <语言> 回答用户"，改了语言手头这一条处理完按新的提示重新拉起；
// - 守护进程这之后生成的话按新语言（t() 换了），停下时装回中文。
import fs from "node:fs";
import path from "node:path";
import { CHANNELS, EVENT_TYPES, type LanguageEventPayload, type LocaleEventPayload, maintainerChannel, type MessageEventPayload, t } from "@ergo/protocol";
import { describe, expect, it } from "vitest";
import { dataDirLayout } from "../../src/config/data-dir.ts";
import type { FauxStep } from "../../src/runtime/index.ts";
import { startTestDaemon } from "../helpers/daemon.ts";
import { TestFrontend } from "../helpers/frontend.ts";
import { languageApi } from "../helpers/http.ts";
import { waitUntil } from "../helpers/process.ts";

const { language: LANGUAGE, secretary: SECRETARY, board: BOARD } = CHANNELS;
const ECHO: FauxStep = { kind: "echo_context" };
const LINE = "用 English 回答用户，给用户看的报告、文件也用 English。";

const languageEvents = (frontend: TestFrontend) => frontend.events({ channel: LANGUAGE, type: EVENT_TYPES.language }).map((f) => f.payload as LanguageEventPayload);
const localeEvents = (frontend: TestFrontend) => frontend.events({ channel: LANGUAGE, type: EVENT_TYPES.locale }).map((f) => f.payload as LocaleEventPayload);
const textOf = (payload: MessageEventPayload) => payload.message.parts.map((p) => (p.type === "text" ? p.text : "")).join("");
const agentTexts = (frontend: TestFrontend, channel: string) =>
  frontend
    .events({ channel, type: EVENT_TYPES.message })
    .map((f) => f.payload as MessageEventPayload)
    .filter((p) => p.message.speaker === "agent")
    .map(textOf);
/** echo_context 回显里生效的系统提示：最后一条系统消息（换了系统提示接着会话时 pi 在中途记一条） */
const latestSystem = (echo: string) => echo.slice(echo.lastIndexOf("[system] "));

const write = (root: string, rel: string, content: unknown) => {
  const file = path.join(root, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, typeof content === "string" ? content : JSON.stringify(content));
};

describe("全局一个语言：设置里改，开着的前端实时跟着变", () => {
  it("一开始是中文（自带中文、英文）；改成英文：两个前端都收到 language 事件和新的 locale；存在配置区；同样的再改没有变化", async () => {
    const { url, dataDir } = await startTestDaemon();
    const a = await TestFrontend.connect(url);
    const b = await TestFrontend.connect(url);
    await a.subscribe({ [LANGUAGE]: 0 });
    await b.subscribe({ [LANGUAGE]: 0 });
    // 订阅时补推一条现在的（临时事件不补发）
    await waitUntil(() => localeEvents(a).length >= 1);
    const first = localeEvents(a)[0]!;
    expect(first.language).toBe("zh-CN");

    const list = (await languageApi.list(url)).body;
    expect(list).toMatchObject({ language: "zh-CN", effective: "zh-CN", userDir: dataDirLayout(dataDir).locales, problems: [] });
    expect(list.languages).toEqual([
      { id: "zh-CN", nativeName: "中文", source: "builtin", overridden: 0, missing: 0 },
      { id: "en", nativeName: "English", source: "builtin", overridden: 0, missing: 0 },
    ]);

    expect(await languageApi.change(url, "en")).toMatchObject({ status: 200, body: { language: "en", changed: true } });
    expect(await languageApi.change(url, "en")).toMatchObject({ status: 200, body: { language: "en", changed: false } });
    for (const frontend of [a, b]) {
      await waitUntil(() => languageEvents(frontend).length === 1 && localeEvents(frontend).some((e) => e.language === "en"));
      expect(languageEvents(frontend)).toEqual([{ language: "en", source: "settings" }]);
      expect(localeEvents(frontend).at(-1)!.revision).not.toBe(first.revision);
    }
    expect(JSON.parse(fs.readFileSync(path.join(dataDirLayout(dataDir).config, "language.json"), "utf8"))).toEqual({ format: 1, language: "en" });
    expect((await languageApi.list(url)).body).toMatchObject({ language: "en", effective: "en" });
  });

  it("只能选列表里有的：没有的语言、不是字符串的被拒，什么都不改", async () => {
    const { url } = await startTestDaemon();
    for (const bad of ["fr", "../en", ""]) expect(await languageApi.change(url, bad)).toMatchObject({ status: 400, body: { code: "bad_request" } });
    expect((await languageApi.change(url, "fr")).body.message).toContain("没有这种语言：fr");
    expect(await languageApi.change(url, 42 as never)).toMatchObject({ status: 400, body: { code: "bad_request" } });
    expect((await languageApi.list(url)).body.language).toBe("zh-CN");
  });

  it("停掉再起：语言还在；停着时手改了配置文件，启动后按文件来并推一条事件", async () => {
    const first = await startTestDaemon();
    await languageApi.change(first.url, "en");
    await first.daemon.stop();
    const reuse = { dataDir: first.dataDir, homeDir: first.homeDir };
    const second = await startTestDaemon({ reuse });
    expect((await languageApi.list(second.url)).body.effective).toBe("en");
    await second.daemon.stop();

    fs.writeFileSync(path.join(dataDirLayout(first.dataDir).config, "language.json"), JSON.stringify({ format: 1, language: "zh-CN" }));
    const third = await startTestDaemon({ reuse });
    const frontend = await TestFrontend.connect(third.url);
    await frontend.subscribe({ [LANGUAGE]: 0 });
    await waitUntil(() => languageEvents(frontend).length >= 2);
    expect(languageEvents(frontend)).toEqual([
      { language: "en", source: "settings" },
      { language: "zh-CN", source: "config_file" },
    ]);
  });
});

describe("网页的词典", () => {
  it("中文时只有中文；英文时是英文的句子，连同中文的（回退用）；只给网页用到的区域", async () => {
    const { url } = await startTestDaemon();
    const zh = (await languageApi.dictionary(url)).body;
    expect(zh).toMatchObject({ language: "zh-CN", meta: { id: "zh-CN", intlLocale: "zh-CN" } });
    expect(zh.messages["shell.nav.secretary"]).toBe("秘书");
    expect(zh.fallback).toBeUndefined();
    // 守护进程自己用的区域（i18n.*）不给网页
    expect(Object.keys(zh.messages).some((k) => k.startsWith("i18n."))).toBe(false);

    await languageApi.change(url, "en");
    const en = (await languageApi.dictionary(url)).body;
    expect(en).toMatchObject({ language: "en", meta: { nativeName: "English", modelName: "English", intlLocale: "en" } });
    expect(en.messages["shell.nav.secretary"]).toBe("Secretary");
    expect(en.fallback?.["shell.nav.secretary"]).toBe("秘书");
  });
});

describe("放一个文件就能加新语言、改译法", () => {
  it("locales/ 里放一个新目录：不重启，列表里出现（来自 ~/.ergo/locales、缺几句）、开着的前端收到新的 locale，能选，缺的用中文补", async () => {
    const { url, dataDir } = await startTestDaemon();
    const frontend = await TestFrontend.connect(url);
    await frontend.subscribe({ [LANGUAGE]: 0 });
    await waitUntil(() => localeEvents(frontend).length >= 1);
    const root = dataDirLayout(dataDir).locales;
    write(root, "fr/_meta.json", { nativeName: "Français", modelName: "French" });
    write(root, "fr/shell.json", { "shell.nav.secretary": "Secrétaire" });
    await waitUntil(() => localeEvents(frontend).length >= 2);
    const list = (await languageApi.list(url)).body;
    const fr = list.languages.find((l) => l.id === "fr");
    expect(fr).toMatchObject({ nativeName: "Français", source: "user", overridden: 0 });
    expect(fr!.missing).toBeGreaterThan(0);

    expect(await languageApi.change(url, "fr")).toMatchObject({ status: 200, body: { language: "fr", changed: true } });
    const dict = (await languageApi.dictionary(url)).body;
    expect(dict.messages).toEqual({ "shell.nav.secretary": "Secrétaire" });
    expect(dict.fallback?.["shell.nav.tasks"]).toBe("任务");
    // 守护进程这边也按法语：有的用法语，缺的用中文
    expect(t("shell.nav.secretary")).toBe("Secrétaire");
    expect(t("shell.nav.tasks")).toBe("任务");

    // 删掉这种语言：设置不动，实际先用中文；放回来又用上
    fs.rmSync(path.join(root, "fr"), { recursive: true });
    await waitUntil(() => localeEvents(frontend).at(-1)?.language === "zh-CN");
    expect((await languageApi.list(url)).body).toMatchObject({ language: "fr", effective: "zh-CN" });
  });

  it("放同名 key 覆盖自带的译法（自带，改了几句）；格式不对的写明哪个文件、哪里错，能用的照用，守护进程照常", async () => {
    const { url, dataDir } = await startTestDaemon();
    await languageApi.change(url, "en");
    const root = dataDirLayout(dataDir).locales;
    write(root, "en/mine.json", { "shell.nav.secretary": "Assistant" });
    write(root, "en/broken.json", '{ "shell.nav.tasks": "Jobs", }');
    write(root, "de/shell.json", { "shell.nav.tasks": "Aufgaben" });
    await waitUntil(() => (t("shell.nav.secretary") as string) === "Assistant");
    const list = (await languageApi.list(url)).body;
    expect(list.languages.find((l) => l.id === "en")).toMatchObject({ source: "builtin_user", overridden: 1, missing: 0 });
    expect(list.languages.map((l) => l.id)).toEqual(["zh-CN", "en"]);
    expect(list.problems.map((p) => ({ file: p.file, code: p.code }))).toEqual([
      { file: "de/", code: "missing_meta" },
      { file: "en/broken.json", code: "bad_json" },
    ]);
    expect(list.problems.find((p) => p.code === "bad_json")!.detail).toBeTruthy();
    expect((await languageApi.dictionary(url)).body.messages["shell.nav.secretary"]).toBe("Assistant");
    expect(t("shell.nav.tasks")).toBe("Tasks");
  });
});

describe("秘书和维护者用所选语言回答", () => {
  it("中文时系统提示末尾没有那句；改成英文后从下一轮起秘书的系统提示末尾多一句；守护进程停下后 t() 回到中文", async () => {
    const { url, daemon } = await startTestDaemon({ secretary: [ECHO, ECHO] });
    const frontend = await TestFrontend.connect(url);
    await frontend.subscribe({ [SECRETARY]: 0 });

    await frontend.sendText("你好");
    await waitUntil(() => agentTexts(frontend, SECRETARY).length >= 1);
    expect(agentTexts(frontend, SECRETARY)[0]).not.toContain("回答用户，给用户看的报告");

    await languageApi.change(url, "en");
    expect(t("shell.nav.secretary")).toBe("Secretary");
    await frontend.sendText("hello");
    await waitUntil(() => agentTexts(frontend, SECRETARY).length >= 2);
    const latest = latestSystem(agentTexts(frontend, SECRETARY)[1]!);
    expect(latest).toContain(LINE);
    // 那句在系统提示的末尾：后面紧跟着的是这一轮的用户消息
    expect(latest.slice(latest.indexOf(LINE) + LINE.length).trimStart()).toMatch(/^\[user\]/);

    await daemon.stop();
    expect(t("shell.nav.secretary")).toBe("秘书");
  });

  it("维护者：子进程还在时改了语言，交下一条输入之前按新的系统提示重新拉起", { timeout: 60_000 }, async () => {
    const TM1 = maintainerChannel("tm-1");
    const { url } = await startTestDaemon({ secretary: [{ kind: "reply", text: "好" }], maintainer: () => [ECHO] });
    const frontend = await TestFrontend.connect(url);
    await frontend.subscribe({ [BOARD]: 0, [TM1]: 0, [SECRETARY]: 0 });
    const started = await frontend.startTask("整理一下下载目录里的截图", "k-lang", [], "plain");
    expect(started.ok).toBe(true);
    await waitUntil(() => agentTexts(frontend, TM1).length >= 1, { timeoutMs: 30_000 });
    expect(agentTexts(frontend, TM1)[0]).not.toContain(LINE);

    await languageApi.change(url, "en");
    await frontend.sendText("再看一眼", { conversation: TM1, taskId: "t-1" });
    await waitUntil(() => agentTexts(frontend, TM1).length >= 2, { timeoutMs: 30_000 });
    expect(latestSystem(agentTexts(frontend, TM1)[1]!)).toContain(LINE);
  });
});
