// 主切面：我的名字（249 号票，用户 2026-10-22："另外可以加一个我的名字的设置，让 agent 可以叫我的名字"）。
// 用户**自己**的名字，和"个人助理的名字"（43 号票）是两回事：那个是用户给秘书起的、界面上处处用它；这个是用户自己的。
// 这里跑的是真的守护进程（模型是 faux）：
// - 设置里填了：GET 读得到、存在配置区、⚙ 面板的实际系统提示里、下一轮交到模型手里的系统提示里都有那句；
// - 没设：⚙ 面板和交到模型手里的提示里都没有那句（和现在的样子一样，单位测试另外守着逐字节一致）；清除了回到没设；
// - 秘书、项目维护者的提示里都有；秘书是常驻的，填了名字从下一轮起生效；
// - 不合规的 400 带原因，什么都不改；
// - 和助理的名字互不干扰（各存各的文件、各走各的路：我的名字不走事件）；
// - 停掉再起还在；停着时手改了配置文件，起来按文件来；文件改坏了只当没设、不覆盖它。
import fs from "node:fs";
import path from "node:path";
import {
  type AssistantNameEventPayload,
  CHANNELS,
  type ConversationId,
  EVENT_TYPES,
  maintainerChannel,
  type MessageEventPayload,
} from "@ergo/protocol";
import { describe, expect, it } from "vitest";
import { dataDirLayout } from "../../src/config/data-dir.ts";
import type { FauxStep } from "../../src/runtime/index.ts";
import { startTestDaemon } from "../helpers/daemon.ts";
import { stripTimeMarkers } from "../helpers/echo.ts";
import { TestFrontend } from "../helpers/frontend.ts";
import { agentSettingsApi, assistantNameApi, userNameApi } from "../helpers/http.ts";
import { waitUntil } from "../helpers/process.ts";
import { seedProject } from "../helpers/projects.ts";

const { secretary: SECRETARY, assistantName: ASSISTANT } = CHANNELS;
const PM1 = maintainerChannel("pm-1");

const ECHO: FauxStep = { kind: "echo_context" };
const echoes = (n: number): FauxStep[] => Array.from({ length: n }, () => ECHO);

/** 系统提示里那一句（设了名字才有） */
const line = (name: string) => `用户叫「${name}」，需要称呼用户时用这个名字（对话、念给用户听的话都可以这样叫）。`;
/** 那一句里独有的一小段：判断"没设"时不能用"用户叫"（秘书的提示里本来就有"用户叫你「…」"，那是 43 号票助理的名字） */
const MARK = "需要称呼用户时用这个名字";

const textOf = (payload: MessageEventPayload) => payload.message.parts.map((p) => (p.type === "text" ? p.text : "")).join("");
const turnEnds = (frontend: TestFrontend, channel: string) => frontend.events({ channel, type: EVENT_TYPES.turnEnd }).length;

/** 说一句，等这个会话又处理完一条，返回 agent 最后说的（回显的上下文去掉时间标记） */
async function say1(frontend: TestFrontend, text: string, conversation: ConversationId = SECRETARY): Promise<string> {
  const before = turnEnds(frontend, conversation);
  await frontend.sendText(text, { conversation });
  await waitUntil(() => turnEnds(frontend, conversation) > before, { timeoutMs: 30_000, describe: () => `等 ${conversation} 处理完「${text.slice(0, 10)}」` });
  const messages = frontend.events({ channel: conversation, type: EVENT_TYPES.message }).map((f) => f.payload as MessageEventPayload);
  const reply = messages.findLast((m) => m.message.speaker === "agent");
  return stripTimeMarkers(reply ? textOf(reply) : "");
}

/** 回显里这一轮的系统提示（换了提示接着原会话时 pi 在会话中途记一条新的系统消息，取最后一条） */
const systemOf = (echo: string) => {
  const rest = echo.slice(echo.lastIndexOf("[system] "));
  const end = rest.search(/\n\n<cwd>|\n\[(user|assistant|tool|system)\] /);
  return end < 0 ? rest : rest.slice(0, end);
};

const file = (dataDir: string) => path.join(dataDirLayout(dataDir).config, "user-name.json");

describe("设置里填我的名字：存下、读得到、agent 知道该叫用户什么", () => {
  it("填了：GET 读得到、存在配置区、⚙ 面板的实际系统提示里有那句；秘书从下一轮起按新名字（没设时没有那句）", async () => {
    const { url, dataDir } = await startTestDaemon({ secretary: echoes(4) });
    const frontend = await TestFrontend.connect(url);
    await frontend.subscribe({ [SECRETARY]: 0 });

    // 没设：GET 是空的，⚙ 面板的实际提示里没有那句
    expect(await userNameApi.get(url)).toMatchObject({ status: 200, body: {} });
    expect((await agentSettingsApi.view(url, "secretary")).body.prompt.effective).not.toContain(MARK);
    // 没设时交到模型手里的提示还是原来开头（前面没有多一行）
    const before = await say1(frontend, "第一句");
    expect(systemOf(before)).toMatch(/^\[system\] 你是「二狗」的秘书/);

    // 填上：去掉首尾空白存下，文件和 GET 都是那个
    expect(await userNameApi.change(url, "  文翰 ")).toMatchObject({ status: 200, body: { name: "文翰", changed: true } });
    expect((await userNameApi.get(url)).body).toEqual({ name: "文翰" });
    expect(JSON.parse(fs.readFileSync(file(dataDir), "utf8"))).toEqual({ format: 1, name: "文翰" });
    // ⚙ 面板的"实际生效的"（和拉起时同一份：前缀 + 名称那句 + 角色提示 + 语言那句）
    expect((await agentSettingsApi.view(url, "secretary")).body.prompt.effective).toContain(line("文翰"));

    // 下一轮起：真的交到模型手里的系统提示里也有（常驻的秘书重新拉起，接着同一条主线会话）
    const after = await say1(frontend, "第二句");
    expect(stripTimeMarkers(after)).toContain("[user] 第一句");
    expect(systemOf(after)).toContain(line("文翰"));
  });

  it("清除了：回到没设（GET 空的、配置文件删掉、提示里那句没有了）", async () => {
    const { url, dataDir } = await startTestDaemon({ secretary: echoes(4) });
    const frontend = await TestFrontend.connect(url);
    await frontend.subscribe({ [SECRETARY]: 0 });
    await userNameApi.change(url, "文翰");
    expect((await agentSettingsApi.view(url, "secretary")).body.prompt.effective).toContain(line("文翰"));

    expect(await userNameApi.change(url, null)).toMatchObject({ status: 200, body: { changed: true } });
    expect((await userNameApi.get(url)).body).toEqual({});
    expect(fs.existsSync(file(dataDir))).toBe(false);
    expect((await agentSettingsApi.view(url, "secretary")).body.prompt.effective).not.toContain(MARK);

    const reply = await say1(frontend, "现在呢");
    expect(systemOf(reply)).toMatch(/^\[system\] 你是「二狗」的秘书/);
    expect(systemOf(reply)).not.toContain(MARK);
    // 空串也是清除（没有变化）
    expect((await userNameApi.change(url, "")).body).toEqual({ changed: false });
  });

  it("不合规的被拒（400 带原因），什么都不改", async () => {
    const { url, dataDir } = await startTestDaemon();
    for (const bad of ["一二三四五六七八九", "文\n翰", "文\u0007翰", "文⟦翰"]) {
      const res = await userNameApi.change(url, bad);
      expect(res.status).toBe(400);
      expect((res.body as { code?: string }).code).toBe("bad_request");
    }
    // 请求体不对（name 不是字符串也不是 null）
    expect(await userNameApi.change(url, 42 as never)).toMatchObject({ status: 400, body: { code: "bad_request" } });
    expect(await userNameApi.get(url)).toMatchObject({ body: {} });
    expect(fs.existsSync(file(dataDir))).toBe(false);
  });
});

describe("维护者的系统提示里也有", () => {
  it("项目维护者：填了名字，⚙ 面板的实际提示和下一轮交到模型手里的提示里都有那句", async () => {
    const td = await startTestDaemon({ maintainer: (id) => (id === "pm-1" ? echoes(3) : []) });
    seedProject(td.daemon, "记账本");
    const frontend = await TestFrontend.connect(td.url);
    await frontend.subscribe({ [PM1]: 0 });

    expect((await agentSettingsApi.view(td.url, "pm-1")).body.prompt.effective).not.toContain(MARK);
    await userNameApi.change(td.url, "文翰");
    expect((await agentSettingsApi.view(td.url, "pm-1")).body.prompt.effective).toContain(line("文翰"));

    const reply = await say1(frontend, "你是谁", PM1);
    expect(systemOf(reply)).toContain(line("文翰"));
  });

  it("记忆管理员的系统提示里也有（它是按需拉起的：⚙ 面板拿到的就是拉起时那一份）", async () => {
    const td = await startTestDaemon();
    expect((await agentSettingsApi.view(td.url, "memory-curator")).body.prompt.effective).not.toContain(MARK);
    await userNameApi.change(td.url, "文翰");
    expect((await agentSettingsApi.view(td.url, "memory-curator")).body.prompt.effective).toContain(line("文翰"));
  });
});

describe("我的名字和助理的名字互不干扰", () => {
  it("改一个不动另一个：文件各是各的，名字频道上只有助理的名字（我的名字不走事件）", async () => {
    const { url, dataDir } = await startTestDaemon();
    const frontend = await TestFrontend.connect(url);
    await frontend.subscribe({ [ASSISTANT]: 0 });
    const layout = dataDirLayout(dataDir);

    await userNameApi.change(url, "文翰");
    await assistantNameApi.change(url, "阿福");
    expect((await userNameApi.get(url)).body).toEqual({ name: "文翰" });
    expect(JSON.parse(fs.readFileSync(layout.userNameFile, "utf8"))).toEqual({ format: 1, name: "文翰" });
    expect(JSON.parse(fs.readFileSync(layout.assistantNameFile, "utf8"))).toEqual({ format: 1, name: "阿福" });
    // ⚙ 面板里两句各是各的：`{{名字}}` 填的是助理的名字（"用户叫你「阿福」"），"用户叫…"填的是我的名字
    const effective = (await agentSettingsApi.view(url, "secretary")).body.prompt.effective;
    expect(effective).toContain(line("文翰"));
    expect(effective).toContain("用户叫你「阿福」");
    await waitUntil(() => frontend.events({ channel: ASSISTANT, type: EVENT_TYPES.assistantName }).length >= 1);
    expect((frontend.events({ channel: ASSISTANT, type: EVENT_TYPES.assistantName }).map((f) => f.payload) as AssistantNameEventPayload[]).map((e) => e.name)).toEqual(["阿福"]);

    // 反过来：清掉我的名字，助理的名字照旧
    await userNameApi.change(url, null);
    expect((await userNameApi.get(url)).body).toEqual({});
    expect(JSON.parse(fs.readFileSync(layout.assistantNameFile, "utf8"))).toEqual({ format: 1, name: "阿福" });
    // 名字频道上还是只有助理改名那一条（我的名字不走事件）
    expect(frontend.events({ channel: ASSISTANT, type: EVENT_TYPES.assistantName })).toHaveLength(1);
  });
});

describe("停掉再起、停着时手改配置文件", () => {
  it("名字还在；停着时手改成新的，起来按文件来；文件改坏了只当没设、不覆盖它", async () => {
    const first = await startTestDaemon();
    await userNameApi.change(first.url, "文翰");
    await first.daemon.stop();

    const reuse = { dataDir: first.dataDir, homeDir: first.homeDir };
    const second = await startTestDaemon({ reuse });
    expect((await userNameApi.get(second.url)).body).toEqual({ name: "文翰" });
    // 停着时手改（去掉首尾空白也认）
    fs.writeFileSync(file(first.dataDir), JSON.stringify({ format: 1, name: " 小文 " }));
    await second.daemon.stop();

    const third = await startTestDaemon({ reuse });
    expect((await userNameApi.get(third.url)).body).toEqual({ name: "小文" });
    await third.daemon.stop();

    // 改坏了（名字太长）：只当没设，文件原样留着
    const broken = JSON.stringify({ format: 1, name: "一二三四五六七八九" });
    fs.writeFileSync(file(first.dataDir), broken);
    const fourth = await startTestDaemon({ reuse });
    expect((await userNameApi.get(fourth.url)).body).toEqual({});
    expect(fs.readFileSync(file(first.dataDir), "utf8")).toBe(broken);
  });
});
