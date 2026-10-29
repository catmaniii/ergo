// 主切面：个人助理的名字（43 号票，规格第 19 节"名称"）。
// - 名字存在守护进程（数据目录配置区的文件是真相），设置接口改，改了以后名字频道上推一条事件，开着的前端都跟着变；
// - 不合规的名字被拒，什么都不改；重启后还在；停着时手改了配置文件，启动后以文件为准补一条事件；
// - 秘书知道自己叫什么：名字写进秘书的系统提示，改名后从下一轮起生效（一轮进行中改名，这一轮照常做完，消息不丢）；
// - 守护进程生成、在界面上显示的话里提到秘书的，写名字占位（前端按当前的名字显示），不写死名字。
import fs from "node:fs";
import path from "node:path";
import {
  ASSISTANT_NAME_MARK,
  type AssistantNameEventPayload,
  CHANNELS,
  EVENT_TYPES,
  type InboxItemEventPayload,
  type MessageEventPayload,
} from "@ergo/protocol";
import { describe, expect, it } from "vitest";
import { dataDirLayout } from "../../src/config/data-dir.ts";
import { startTestDaemon } from "../helpers/daemon.ts";
import { stripTimeMarkers } from "../helpers/echo.ts";
import { TestFrontend } from "../helpers/frontend.ts";
import { assistantNameApi } from "../helpers/http.ts";
import { waitUntil } from "../helpers/process.ts";
import { withoutFoldersBlock } from "../helpers/folders-block.ts";

const { assistantName: ASSISTANT, secretary: SECRETARY } = CHANNELS;

const nameEvents = (frontend: TestFrontend) => frontend.events({ channel: ASSISTANT, type: EVENT_TYPES.assistantName }).map((f) => f.payload as AssistantNameEventPayload);

const textOf = (payload: MessageEventPayload) => payload.message.parts.map((p) => (p.type === "text" ? p.text : "")).join("");

describe("设置里改名：存在守护进程，开着的前端实时跟着变", () => {
  it("改名：去掉首尾空白存下，两个前端都收到名字频道上的一条事件；名字存在配置区；同样的名字再改一次没有变化、不产生事件", async () => {
    const { url, dataDir } = await startTestDaemon();
    const a = await TestFrontend.connect(url);
    const b = await TestFrontend.connect(url);
    await a.subscribe({ [ASSISTANT]: 0 });
    await b.subscribe({ [ASSISTANT]: 0 });

    expect(await assistantNameApi.change(url, "  阿福 ")).toMatchObject({ status: 200, body: { name: "阿福", changed: true } });
    expect(await assistantNameApi.change(url, "阿福")).toMatchObject({ status: 200, body: { name: "阿福", changed: false } });
    // 恢复默认：就是改回"二狗"（89 号票，用户 2026-10-11 定；原来是"个人助理"）
    expect(await assistantNameApi.change(url, "二狗")).toMatchObject({ status: 200, body: { name: "二狗", changed: true } });

    for (const frontend of [a, b]) {
      await waitUntil(() => nameEvents(frontend).length === 2, { describe: () => JSON.stringify(nameEvents(frontend)) });
      expect(nameEvents(frontend)).toEqual([
        { name: "阿福", source: "settings" },
        { name: "二狗", source: "settings" },
      ]);
    }
    const file = path.join(dataDirLayout(dataDir).config, "assistant-name.json");
    expect(JSON.parse(fs.readFileSync(file, "utf8"))).toEqual({ format: 1, name: "二狗" });
  });

  it("不合规的名字被拒（空的、九个字、带换行），什么都不改", async () => {
    const { url, dataDir } = await startTestDaemon();
    const frontend = await TestFrontend.connect(url);
    await frontend.subscribe({ [ASSISTANT]: 0 });
    for (const bad of ["  ", "一二三四五六七八九", "二\n狗"]) {
      expect(await assistantNameApi.change(url, bad)).toMatchObject({ status: 400, body: { code: "bad_request" } });
    }
    expect(await assistantNameApi.change(url, 42 as never)).toMatchObject({ status: 400, body: { code: "bad_request" } });
    // 合规的一次：之前被拒的都没留下事件
    await assistantNameApi.change(url, "阿福");
    await waitUntil(() => nameEvents(frontend).length >= 1);
    expect(nameEvents(frontend)).toEqual([{ name: "阿福", source: "settings" }]);
    expect(JSON.parse(fs.readFileSync(path.join(dataDirLayout(dataDir).config, "assistant-name.json"), "utf8"))).toEqual({ format: 1, name: "阿福" });
  });

  it("停掉再起：名字还在，不重复产生事件；停着时手改了配置文件，启动后按文件来并推一条事件；文件改坏了沿用上一次的名字", async () => {
    const first = await startTestDaemon();
    await assistantNameApi.change(first.url, "小美");
    await first.daemon.stop();

    const reuse = { dataDir: first.dataDir, homeDir: first.homeDir };
    const second = await startTestDaemon({ reuse });
    const frontend = await TestFrontend.connect(second.url);
    await frontend.subscribe({ [ASSISTANT]: 0 });
    await waitUntil(() => nameEvents(frontend).length >= 1);
    expect(nameEvents(frontend)).toEqual([{ name: "小美", source: "settings" }]);
    await second.daemon.stop();

    const file = path.join(dataDirLayout(first.dataDir).config, "assistant-name.json");
    fs.writeFileSync(file, JSON.stringify({ format: 1, name: " 小八 " }));
    const third = await startTestDaemon({ reuse });
    const again = await TestFrontend.connect(third.url);
    await again.subscribe({ [ASSISTANT]: 0 });
    await waitUntil(() => nameEvents(again).length >= 2);
    expect(nameEvents(again)).toEqual([
      { name: "小美", source: "settings" },
      { name: "小八", source: "config_file" },
    ]);
    await third.daemon.stop();

    // 改坏了（名字太长）：不覆盖文件，沿用上一次的名字，不推事件
    fs.writeFileSync(file, JSON.stringify({ format: 1, name: "一二三四五六七八九" }));
    const fourth = await startTestDaemon({ reuse });
    const last = await TestFrontend.connect(fourth.url);
    await last.subscribe({ [ASSISTANT]: 0 });
    await waitUntil(() => nameEvents(last).length >= 2);
    // 再改一次名字作为"推完了"的标记：前面没有多出 config_file 的事件
    await assistantNameApi.change(fourth.url, "阿福");
    await waitUntil(() => nameEvents(last).length >= 3);
    expect(nameEvents(last).map((e) => e.name)).toEqual(["小美", "小八", "阿福"]);
  });
});

describe("秘书知道自己叫什么", () => {
  it("名字写进秘书的系统提示；改名后从下一轮起按新名字", async () => {
    const { url } = await startTestDaemon({ secretary: [{ kind: "echo_context" }, { kind: "echo_context" }] });
    const frontend = await TestFrontend.connect(url);
    await frontend.subscribe({ [SECRETARY]: 0 });

    await frontend.sendText("你叫什么");
    await frontend.next(SECRETARY, EVENT_TYPES.message);
    const before = withoutFoldersBlock(textOf((await frontend.next(SECRETARY, EVENT_TYPES.message)).payload as MessageEventPayload));
    await frontend.next(SECRETARY, EVENT_TYPES.turnEnd);
    expect(before).toMatch(/^\[system\] 你是「二狗」的秘书/);
    expect(before).toContain("用户叫你「二狗」");

    await assistantNameApi.change(url, "阿福");
    await frontend.sendText("现在呢");
    await frontend.next(SECRETARY, EVENT_TYPES.message);
    const after = textOf((await frontend.next(SECRETARY, EVENT_TYPES.message)).payload as MessageEventPayload);
    // 接着的还是同一条主线会话：上一轮的话还在上下文里
    expect(stripTimeMarkers(after)).toContain("[user] 你叫什么");
    // 换了系统提示接着会话：pi 在会话中途记一条系统消息（认中途系统消息的模型照原样收到，前缀缓存不打穿；
    // 不认的模型由 pi 把新的系统提示放回开头），所以生效的是最后一条系统消息：它在这一轮的用户消息之前，是新名字
    const latest = after.slice(after.lastIndexOf("[system] "));
    expect(latest).toContain("用户叫你「阿福」");
    expect(latest).not.toContain("用户叫你「二狗」");
    expect(latest).toMatch(/\[user\] [^\n]*\n现在呢$/);
  });

  it("一轮进行中改名：这一轮照常做完（不中断、回复完整），下一轮按新名字，消息一条不丢", { timeout: 120_000 }, async () => {
    // 回复慢慢流出来（回显上下文，一千多字），改名时这一轮还在说。faux 的剧本每个子进程从头来，改名后重新拉起的子进程也是回显
    const { url } = await startTestDaemon({ secretary: [{ kind: "echo_context" }, { kind: "echo_context" }], secretaryTokensPerSecond: 400 });
    const frontend = await TestFrontend.connect(url);
    await frontend.subscribe({ [SECRETARY]: 0 });

    const first = await frontend.sendText("第一条");
    await frontend.next(SECRETARY, EVENT_TYPES.stream); // 秘书已经在回第一条
    await assistantNameApi.change(url, "阿福");
    expect(frontend.events({ channel: SECRETARY, type: EVENT_TYPES.turnEnd })).toEqual([]); // 改名时这一轮还没完
    expect((await frontend.next(SECRETARY, EVENT_TYPES.turnEnd, 90_000)).payload).toEqual({ inputMessageId: first.messageId, outcome: "completed" });

    const second = await frontend.sendText("第二条");
    expect((await frontend.next(SECRETARY, EVENT_TYPES.turnEnd, 90_000)).payload).toEqual({ inputMessageId: second.messageId, outcome: "completed" });

    // 会话里：两条用户消息、两条回复，没有"中断了""没能回复"之类的系统说明
    const messages = frontend.events({ channel: SECRETARY, type: EVENT_TYPES.message }).map((f) => f.payload as MessageEventPayload);
    expect(messages.map((m) => m.message.speaker)).toEqual(["user", "agent", "user", "agent"]);
    // 这一轮按改名前的系统提示说完了
    const firstReply = textOf(messages[1]!);
    expect(firstReply).toContain("用户叫你「二狗」");
    expect(firstReply).toMatch(/\n第一条$/);
    // 下一轮：接着同一条主线会话（第一轮的话和完整的回复都在上下文里），生效的系统提示是新名字
    const echoed = textOf(messages[3]!);
    expect(stripTimeMarkers(echoed)).toContain("[user] 第一条");
    expect(echoed).toContain(`[assistant] ${firstReply}`);
    const latest = echoed.slice(echoed.lastIndexOf("[system] "));
    expect(latest).toContain("用户叫你「阿福」");
    expect(latest).not.toContain("用户叫你「二狗」");
    expect(latest).toMatch(/\[user\] [^\n]*\n第二条$/);
  });
});

describe("守护进程生成的话里提到秘书的，写名字占位", () => {
  it("秘书没能回复时会话里的系统说明：用名字占位，不写死名字", async () => {
    const { url } = await startTestDaemon({ secretary: [] });
    const frontend = await TestFrontend.connect(url);
    await frontend.subscribe({ [SECRETARY]: 0 });
    await assistantNameApi.change(url, "小美");
    await frontend.sendText("在吗");
    await frontend.next(SECRETARY, EVENT_TYPES.message);
    const note = (await frontend.next(SECRETARY, EVENT_TYPES.message)).payload as MessageEventPayload;
    expect(note.message.speaker).toBe("system");
    expect(textOf(note)).toMatch(new RegExp(`^${ASSISTANT_NAME_MARK}这次没能回复：`));
    expect(textOf(note)).not.toContain("小美");
  });

  it("待我处理事项的来源：秘书对话里来的写名字占位", async () => {
    const { url } = await startTestDaemon({ secretary: [{ kind: "reply", toolCalls: [{ name: "read", arguments: { path: "~/note.txt" } }] }, { kind: "reply", text: "等你批准" }] });
    const frontend = await TestFrontend.connect(url);
    await frontend.subscribe({ [SECRETARY]: 0, [CHANNELS.inbox]: 0 });
    await frontend.sendText("读一下我的笔记");
    await waitUntil(() => frontend.events({ channel: CHANNELS.inbox, type: EVENT_TYPES.inboxItem }).length > 0, { timeoutMs: 15_000 });
    const item = (frontend.events({ channel: CHANNELS.inbox, type: EVENT_TYPES.inboxItem })[0]!.payload as InboxItemEventPayload).item;
    expect(item.source).toBe(`${ASSISTANT_NAME_MARK}对话`);
  });
});
