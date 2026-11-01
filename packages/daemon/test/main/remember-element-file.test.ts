// 主切面："这张图记下来"要把图本身存下来（"这张图记下来还是尽量可以下载吧"）。
// 长按网页元素、在二狗圆钮上说记下来：秘书取回元素的文件（browse_element_content），再记一条（remember_memory 带 file）——
// - 素材里有这张图（附件切段，文件本身在媒体库）、描述、来源网页和地址，素材详情能画出来；
// - 忘掉、彻底删除连图一起删（媒体文件和草稿区那一份），别的消息、素材还引用的留着；
// - file 只认这一轮取回来的编号：以前几轮的、find_files 列的、编的都拒，路径过不了参数校验；
// - 取不到完整图的存截图并写明；什么都取不到只记文字并照实说。
// 真实装配路径（startTestDaemon），假模型（faux 剧本），设备是假的（另一个模拟前端，报浏览器、答请求、把文件传进媒体库）。
import fs from "node:fs";
import path from "node:path";
import {
  type BrowserOutcome,
  type BrowserRequest,
  type BrowsingContext,
  CHANNELS,
  EVENT_TYPES,
  isDeletedEventPayload,
  type MaterialDetailView,
  type MaterialListPage,
  type MemoryCommandEventPayload,
  type MessageEnvelope,
  type MessageEventPayload,
  type MessagePart,
  type MessagesPurgedEventPayload,
  METHODS,
  PURGED_TEXT,
  type PickedElement,
} from "@ergo/protocol";
import { describe, expect, it } from "vitest";
import { MATERIALS_CHANNEL } from "../../src/materials/index.ts";
import type { FauxStep } from "../../src/runtime/index.ts";
import { startTestDaemon } from "../helpers/daemon.ts";
import { stripTimeMarkers } from "../helpers/echo.ts";
import { TestFrontend } from "../helpers/frontend.ts";
import { materialsApi, media } from "../helpers/http.ts";
import { png } from "../helpers/images.ts";
import { waitUntil } from "../helpers/process.ts";

const { secretary: SECRETARY } = CHANNELS;

const BROWSER = "b-0123456789abcdef";
const PAGE = { title: "相册 · 示例", url: "https://photos.example.cn/album" };
const IMAGE: PickedElement = { id: "x1", kind: "image", source: "http", src: "https://cdn.example.cn/cat.png?sig=abc", href: "https://photos.example.cn/cat", label: "一只猫" };
const CANVAS: PickedElement = { id: "x2", kind: "image", source: "canvas" };
const TEXT: PickedElement = { id: "x3", kind: "text", selected: true, text: { text: "一段话", total: 3 } };
/** 秘书写的描述 */
const SAID = "窗台上趴着的一只橘猫，背后是傍晚的天";

const call = (name: string, args: Record<string, unknown>): FauxStep => ({ kind: "reply", toolCalls: [{ name, arguments: args as never }] });
const ECHO: FauxStep = { kind: "echo_context" };
const FETCH = call("browse_element_content", {});
/** 秘书照着上一个工具结果里的文件编号记一条 */
const REMEMBER_WITH_FILE: FauxStep = { kind: "call_with_matches", toolCall: { name: "remember_memory", arguments: { text: SAID } }, argument: "file", pattern: "ref-[0-9a-f]{8}", first: true };

const onElement = (element: PickedElement): BrowsingContext => ({ browser: BROWSER, page: { title: PAGE.title, url: `${PAGE.url}?utm=x` }, via: "button", element });

const messagesOf = (frontend: TestFrontend): MessageEnvelope[] => frontend.events({ channel: SECRETARY, type: EVENT_TYPES.message }).flatMap((f) => (isDeletedEventPayload(f.payload) ? [] : [(f.payload as MessageEventPayload).message]));
const textOf = (m: MessageEnvelope | undefined) => (m?.parts ?? []).flatMap((p) => (p.type === "text" ? [p.text] : [])).join("");
const lastEcho = (frontend: TestFrontend) => stripTimeMarkers(textOf(messagesOf(frontend).filter((m) => m.speaker === "agent" && textOf(m).includes("[system]")).at(-1)));
const toolResultOf = (context: string, tool: string) => context.slice(context.lastIndexOf(`[toolResult] ${tool}: `) + `[toolResult] ${tool}: `.length).split("\n[")[0]!;
const toolCalls = (frontend: TestFrontend, tool: string): Array<Extract<MessagePart, { type: "tool_call" }>> => messagesOf(frontend).flatMap((m) => m.parts.flatMap((p) => (p.type === "tool_call" && p.tool === tool ? [p] : [])));
const turnEnds = (frontend: TestFrontend) => frontend.events({ channel: SECRETARY, type: EVENT_TYPES.turnEnd }).map((f) => f.payload as { inputMessageId: string; moreInputMessageIds?: string[] });

async function tell(frontend: TestFrontend, text: string, browsing?: BrowsingContext) {
  const sent = await frontend.sendText(text, browsing ? { browsing } : {});
  await waitUntil(() => turnEnds(frontend).some((e) => e.inputMessageId === sent.messageId || e.moreInputMessageIds?.includes(sent.messageId)), { timeoutMs: 30_000, describe: () => `等秘书处理完「${text}」` });
  return sent;
}

type Answer = (url: string, request: BrowserRequest) => BrowserOutcome | Promise<BrowserOutcome>;

/** 设备把一张图传进媒体库，交回媒体编号；via 是怎么来的 */
const withImage =
  (extra: Partial<Extract<BrowserOutcome, { ok: true }>["file"] & object> = {}, width = 8): Answer =>
  async (url, request) => {
    if (request.op !== "element_file") return { ok: true };
    const stored = await media.upload(url, png({ width, height: 6 }), { name: "cat.png", mime: "image/png" });
    return { ok: true, file: { mediaId: stored.mediaId, name: stored.name, mime: stored.mime, size: stored.size, via: "original", ...extra } };
  };

async function start(secretary: FauxStep[], answer: Answer = withImage()) {
  const daemon = await startTestDaemon({ secretary });
  const frontend = await TestFrontend.connect(daemon.url);
  await frontend.subscribe({ [SECRETARY]: 0 });
  const requests: BrowserRequest[] = [];
  const seen = new Set<string>();
  const timer = setInterval(() => {
    for (const frame of frontend.events({ channel: SECRETARY, type: EVENT_TYPES.browserRequest })) {
      const req = frame.payload as BrowserRequest;
      if (seen.has(req.id)) continue;
      seen.add(req.id);
      requests.push(req);
      void Promise.resolve(answer(daemon.url, req)).then((result) => frontend.request(METHODS.browserReply, { id: req.id, result }));
    }
  }, 10);
  await frontend.request(METHODS.browserStatus, { browser: BROWSER, page: PAGE });
  const remembered = () => daemon.daemon.materials.list({ kind: "memory_command" }).filter((m) => m.context.includes("command:remember"));
  const commands = () => daemon.daemon.store.read(MATERIALS_CHANNEL, 0, EVENT_TYPES.memoryCommand).map((e) => e.payload as MemoryCommandEventPayload);
  const scratchFiles = () => {
    const dir = path.join(daemon.dataDir, "tmp", "scratch", "element-files");
    return fs.existsSync(dir) ? fs.readdirSync(dir) : [];
  };
  return { ...daemon, frontend, requests, remembered, commands, scratchFiles, stopDevice: () => clearInterval(timer) };
}

const detailOf = async (url: string, id: string) => (await materialsApi.detail(url, id)).body as MaterialDetailView;

describe("这张图记下来", () => {
  it("假模型走通：图本身、描述、来源网页和地址进素材；素材详情画得出这张图", { timeout: 60_000 }, async () => {
    const t = await start([FETCH, REMEMBER_WITH_FILE, ECHO]);
    const sent = await tell(t.frontend, "这张图记下来", onElement(IMAGE));
    t.stopDevice();

    expect(t.requests).toEqual([expect.objectContaining({ op: "element_file", element: "x1", url: PAGE.url })]);
    const result = toolResultOf(lastEcho(t.frontend), "remember_memory");
    expect(result).toContain("记下了");
    expect(result).toContain("连同文件「cat.png」");
    expect(result).toContain("记忆 · 素材");
    expect(result).not.toContain("截图");

    // 事件日志里是一条带文件和来源的"记住"：文字是秘书写的描述，不是用户的原话
    const command = t.commands().find((c) => c.command === "remember");
    expect(command).toMatchObject({
      content: SAID,
      source: "proposed",
      file: { kind: "image", name: "cat.png", mime: "image/png", via: "original", width: 8, height: 6 },
      origin: { page: PAGE, address: IMAGE.src },
      from: { kind: "secretary", conversation: SECRETARY, inputMessageId: sent.messageId },
    });

    // 素材：描述（用户的选择，agent 先提出）、附件、来源网页、地址
    const [material] = t.remembered();
    const mediaId = command!.command === "remember" ? command!.file!.mediaId : "";
    expect(material!.context).toContain("with_attachment");
    expect(material!.segments).toMatchObject([
      { form: "choice", source: "self", notes: ["agent_proposed"], text: SAID },
      { form: "attachment", source: "external_untrusted", notes: [], label: "cat.png", sha256: mediaId, media: { mediaId, name: "cat.png", mime: "image/png", kind: "image" } },
      { form: "web_page", source: "external_untrusted", url: PAGE.url, label: `${PAGE.title}（${PAGE.url}）` },
      { form: "web_page", source: "external_untrusted", url: IMAGE.src },
    ]);
    // 带签名的地址不进说明（不进关键词索引、证据）
    expect(material!.segments[3]!.label).toBeUndefined();

    // 文件还在媒体库里，素材详情给了照附件画的 part
    expect((await media.download(t.url, mediaId)).status).toBe(200);
    const detail = await detailOf(t.url, material!.id);
    expect(detail.segments[1]!.part).toEqual({ type: "image", mediaId, name: "cat.png", mime: "image/png", width: 8, height: 6 });
    expect(detail.segments[0]!.text).toBe(SAID);
    expect(detail.segments[2]!.url).toBe(PAGE.url);

    // 列表：摘录里有描述；按"附件"、按"记忆命令"都筛得到；关键词搜描述、来源网页都搜得到
    const listed = (await materialsApi.list(t.url, { filter: { facets: ["attachment"] } })).body as MaterialListPage;
    expect(listed.items.map((i) => i.id)).toEqual([material!.id]);
    expect(listed.items[0]!.excerpt).toContain("窗台上趴着");
    expect(t.daemon.materials.searchKeyword("相册 · 示例").map((m) => m.id)).toContain(material!.id);
    expect(t.daemon.materials.searchKeyword("sig=abc").map((m) => m.id)).not.toContain(material!.id);

    await t.frontend.close();
    await t.daemon.stop();
  });

  it("不是图的元素（文件）同样：文本文件带上，详情里画成文件卡片", { timeout: 60_000 }, async () => {
    const t = await start([FETCH, REMEMBER_WITH_FILE, ECHO], async (url, request) => {
      if (request.op !== "element_file") return { ok: true };
      const stored = await media.upload(url, Buffer.from("季度报告正文"), { name: "report.txt", mime: "text/plain" });
      return { ok: true, file: { mediaId: stored.mediaId, name: stored.name, mime: stored.mime, size: stored.size, via: "original" } };
    });
    await tell(t.frontend, "这个文件存起来", onElement({ id: "x4", kind: "link", href: "https://photos.example.cn/report.txt", text: { text: "报告", total: 2 } }));
    t.stopDevice();
    const [material] = t.remembered();
    const detail = await detailOf(t.url, material!.id);
    expect(detail.segments[1]!.part).toMatchObject({ type: "file", name: "report.txt", mime: "text/plain", size: 18 });
    expect(detail.segments[3]!.url).toBe("https://photos.example.cn/report.txt");
    await t.frontend.close();
    await t.daemon.stop();
  });

  it("同一句话先只记了文字，取到文件再带上记一次：第二次不算重复", { timeout: 60_000 }, async () => {
    const t = await start([call("remember_memory", { text: SAID }), FETCH, REMEMBER_WITH_FILE, ECHO]);
    await tell(t.frontend, "这张图记下来", onElement(IMAGE));
    t.stopDevice();
    const remembers = t.commands().filter((c) => c.command === "remember");
    expect(remembers).toHaveLength(2);
    expect(remembers[1]).toMatchObject({ file: { name: "cat.png" } });
    await t.frontend.close();
    await t.daemon.stop();
  });
});

describe("忘掉、彻底删除连图一起删", () => {
  it("彻底删除这一条：媒体文件、草稿区那一份都没了；命令和取文件的调用改写，描述一个字不剩", { timeout: 60_000 }, async () => {
    const t = await start([FETCH, REMEMBER_WITH_FILE, { kind: "reply", text: "记下了" }]);
    await tell(t.frontend, "这张图记下来", onElement(IMAGE));
    t.stopDevice();
    const [material] = t.remembered();
    const command = t.commands().find((c) => c.command === "remember");
    const mediaId = command!.command === "remember" ? command!.file!.mediaId : "";
    expect(t.scratchFiles()).toHaveLength(1);
    const [fetchCall] = toolCalls(t.frontend, "browse_element_content");
    const [rememberCall] = toolCalls(t.frontend, "remember_memory");
    // 会话文件里取文件那次的结果有图本身（下面确认改写之后没了）
    const sessionDir = path.join(t.dataDir, "sessions", "secretary");
    const sessionText = () => fs.readdirSync(sessionDir).map((f) => fs.readFileSync(path.join(sessionDir, f), "utf8")).join("\n");
    expect(sessionText()).toContain('"type":"image"');
    const secretaryPid = t.daemon.secretary.pid;

    const purged = await materialsApi.delete(t.url, { scope: { kind: "material", materialId: material!.id }, mode: "purge", idempotencyKey: "purge-image" });
    expect(purged.status).toBe(200);

    expect((await media.download(t.url, mediaId)).status).toBe(404);
    expect(t.scratchFiles()).toEqual([]);
    expect(t.remembered()).toEqual([]);
    // 命令记着删了哪份媒体；"记住"的命令只留命令 id、来源、出处
    expect(t.commands().find((c) => c.command === "purge")).toMatchObject({ mediaIds: [mediaId] });
    const rewritten = t.commands().find((c) => c.command === "remember");
    expect(rewritten).toMatchObject({ content: PURGED_TEXT, from: { kind: "secretary", conversation: SECRETARY } });
    expect(rewritten).not.toHaveProperty("file");
    expect(rewritten).not.toHaveProperty("origin");
    // 记它、取文件的两次调用都改写（会话文件里取文件那次的结果有图本身）
    const notice = (await t.frontend.next(SECRETARY, EVENT_TYPES.messagesPurged)).payload as MessagesPurgedEventPayload;
    expect(notice.toolCallIds.toSorted()).toEqual([fetchCall!.callId, rememberCall!.callId].toSorted());
    const records = t.daemon.store.read(SECRETARY, 0, EVENT_TYPES.message).flatMap((e) => (isDeletedEventPayload(e.payload) ? [] : (e.payload as MessageEventPayload).message.parts));
    expect(records.find((p) => p.type === "tool_call" && p.tool === "browse_element_content")).toMatchObject({ resultSummary: PURGED_TEXT });
    expect(records.find((p) => p.type === "tool_call" && p.tool === "remember_memory")).toMatchObject({ argsSummary: PURGED_TEXT, resultSummary: PURGED_TEXT });
    expect(JSON.stringify(t.daemon.store.readGlobal(0, 100_000))).not.toContain(SAID);
    // 会话文件跟着改：图、描述都不在了
    await waitUntil(() => t.daemon.secretary.pid !== undefined && t.daemon.secretary.pid !== secretaryPid && t.daemon.secretary.status === "idle");
    expect(sessionText()).not.toContain('"type":"image"');
    expect(sessionText()).not.toContain(SAID);

    await t.frontend.close();
    await t.daemon.stop();
  });

  it("按会话彻底删除：同样连文件一起删", { timeout: 60_000 }, async () => {
    const t = await start([FETCH, REMEMBER_WITH_FILE, ECHO]);
    await tell(t.frontend, "这张图记下来", onElement(IMAGE));
    t.stopDevice();
    const command = t.commands().find((c) => c.command === "remember");
    const mediaId = command!.command === "remember" ? command!.file!.mediaId : "";
    const purged = await materialsApi.delete(t.url, { scope: { kind: "conversation", conversation: SECRETARY }, mode: "purge", idempotencyKey: "purge-conversation" });
    expect(purged.status).toBe(200);
    expect((await media.download(t.url, mediaId)).status).toBe(404);
    expect(t.scratchFiles()).toEqual([]);
    await t.frontend.close();
    await t.daemon.stop();
  });

  it("忘掉：图也删；聊天记录里的话还在；重启后不回来", { timeout: 60_000 }, async () => {
    const t = await start([FETCH, REMEMBER_WITH_FILE, ECHO]);
    const sent = await tell(t.frontend, "这张图记下来", onElement(IMAGE));
    t.stopDevice();
    const [material] = t.remembered();
    const command = t.commands().find((c) => c.command === "remember");
    const mediaId = command!.command === "remember" ? command!.file!.mediaId : "";
    const forgot = await materialsApi.delete(t.url, { scope: { kind: "material", materialId: material!.id }, mode: "forget", idempotencyKey: "forget-image" });
    expect(forgot.status).toBe(200);
    expect((await media.download(t.url, mediaId)).status).toBe(404);
    expect(t.scratchFiles()).toEqual([]);
    expect(t.remembered()).toEqual([]);
    expect(messagesOf(t.frontend).find((m) => m.id === sent.messageId)).toBeDefined();
    await t.frontend.close();
    await t.daemon.stop();
  });

  it("别的素材、别的消息还引用的留着：同一张图记了两次，忘掉一条还在，两条都忘了才删；用户发过的附件忘掉也不删", { timeout: 60_000 }, async () => {
    const t = await start([FETCH, REMEMBER_WITH_FILE, { kind: "reply", text: "好" }, FETCH, { ...REMEMBER_WITH_FILE, toolCall: { name: "remember_memory", arguments: { text: "同一张图又记了一次" } } } as FauxStep, { kind: "reply", text: "好" }, { kind: "reply", text: "收到" }]);
    await tell(t.frontend, "这张图记下来", onElement(IMAGE));
    await tell(t.frontend, "这张图再记一次", onElement(IMAGE));
    const [first, second] = t.remembered();
    const command = t.commands().find((c) => c.command === "remember");
    const mediaId = command!.command === "remember" ? command!.file!.mediaId : "";

    await materialsApi.delete(t.url, { scope: { kind: "material", materialId: first!.id }, mode: "forget", idempotencyKey: "forget-first" });
    expect((await media.download(t.url, mediaId)).status).toBe(200);
    expect(t.scratchFiles()).toHaveLength(1);

    // 这张图用户也发过（消息还引用）：素材都忘了也不删
    await t.frontend.sendParts([{ type: "image", mediaId, name: "cat.png", mime: "image/png" }]);
    await waitUntil(() => turnEnds(t.frontend).length >= 3, { timeoutMs: 30_000, describe: () => "等秘书收下附件" });
    await materialsApi.delete(t.url, { scope: { kind: "material", materialId: second!.id }, mode: "forget", idempotencyKey: "forget-second" });
    expect((await media.download(t.url, mediaId)).status).toBe(200);

    t.stopDevice();
    await t.frontend.close();
    await t.daemon.stop();
  });

  it("记忆管理员按用户的话忘掉（forget_material）：命令同样带着媒体编号，图也删", { timeout: 60_000 }, async () => {
    const t = await start([FETCH, REMEMBER_WITH_FILE, ECHO]);
    await tell(t.frontend, "这张图记下来", onElement(IMAGE));
    t.stopDevice();
    const [material] = t.remembered();
    const command = t.commands().find((c) => c.command === "remember");
    const mediaId = command!.command === "remember" ? command!.file!.mediaId : "";
    const { curatorTools } = await import("../../src/memory/curator-tools.ts");
    const tools = curatorTools({
      file: path.join(t.dataDir, "unused-rg.db"),
      clock: { now: () => new Date() },
      store: t.daemon.store,
      conversation: "memory-curator",
      materials: t.daemon.materials,
    } as never);
    const forget = tools.find((tool) => tool.spec.name === "forget_material")!;
    const out = await forget.run({ materialIds: [material!.id] }, { toolCallId: "call-forget" });
    expect(out.isError).toBeUndefined();
    expect(t.commands().find((c) => c.command === "forget")).toMatchObject({ mediaIds: [mediaId], from: { kind: "curator" } });
    expect((await media.download(t.url, mediaId)).status).toBe(404);
    await t.frontend.close();
    await t.daemon.stop();
  });
});

describe("file 只认这一轮取回来的编号", () => {
  it("以前几轮取回来的编号：拒，什么都不记；这一轮重新取了就认", { timeout: 60_000 }, async () => {
    const t = await start([FETCH, { kind: "reply", text: "这是一只猫" }, REMEMBER_WITH_FILE, ECHO, FETCH, REMEMBER_WITH_FILE, ECHO]);
    await tell(t.frontend, "图里是什么", onElement(IMAGE));
    await tell(t.frontend, "这张图记下来", onElement(IMAGE));
    const refused = toolResultOf(lastEcho(t.frontend), "remember_memory");
    expect(refused).toContain("不是这一轮从长按的元素取回来的文件");
    expect(t.commands().filter((c) => c.command === "remember")).toEqual([]);
    expect(toolCalls(t.frontend, "remember_memory").at(-1)).toMatchObject({ outcome: "error" });

    await tell(t.frontend, "这张图记下来", onElement(IMAGE));
    t.stopDevice();
    expect(toolResultOf(lastEcho(t.frontend), "remember_memory")).toContain("连同文件");
    expect(t.commands().filter((c) => c.command === "remember")).toHaveLength(1);
    await t.frontend.close();
    await t.daemon.stop();
  });

  it("find_files 列的编号、编出来的编号：拒；路径过不了参数校验", { timeout: 60_000 }, async () => {
    const t = await start([
      { kind: "reply", text: "收到" },
      call("find_files", { keywords: ["cat-photo"] }),
      REMEMBER_WITH_FILE,
      ECHO,
      call("remember_memory", { text: SAID, file: "ref-00000000" }),
      ECHO,
      call("remember_memory", { text: SAID, file: "element-files/abc.png" }),
      ECHO,
      call("remember_memory", { text: SAID, file: "C:/Users/someone/secret.png" }),
      ECHO,
    ]);
    const upload = await media.upload(t.url, png({ width: 9, height: 7 }), { name: "cat-photo.png", mime: "image/png" });
    await t.frontend.sendParts([{ type: "image", mediaId: upload.mediaId, name: "cat-photo.png", mime: "image/png" }]);
    await waitUntil(() => turnEnds(t.frontend).length >= 1, { timeoutMs: 30_000, describe: () => "等秘书收下附件" });

    await tell(t.frontend, "这张图记下来", onElement(IMAGE));
    const listed = toolResultOf(lastEcho(t.frontend), "find_files");
    expect(listed).toMatch(/ref-[0-9a-f]{8}/);
    expect(toolResultOf(lastEcho(t.frontend), "remember_memory")).toContain("不是这一轮从长按的元素取回来的文件");

    await tell(t.frontend, "这张图记下来", onElement(IMAGE));
    expect(toolResultOf(lastEcho(t.frontend), "remember_memory")).toContain("ref-00000000 不是这一轮");

    for (const bad of ["element-files/abc.png", "C:/Users/someone/secret.png"]) {
      await tell(t.frontend, "这张图记下来", onElement(IMAGE));
      expect(toolResultOf(lastEcho(t.frontend), "remember_memory")).not.toContain("记下了");
      expect(lastEcho(t.frontend)).toContain(bad);
    }
    t.stopDevice();
    expect(t.commands().filter((c) => c.command === "remember")).toEqual([]);
    await t.frontend.close();
    await t.daemon.stop();
  });
});

describe("取不到完整图", () => {
  it("存截图：素材里写明是截图，秘书拿到的结果要它跟用户说清", { timeout: 60_000 }, async () => {
    const t = await start([FETCH, REMEMBER_WITH_FILE, ECHO], withImage({ via: "screenshot" }));
    await tell(t.frontend, "这张图记下来", onElement(IMAGE));
    t.stopDevice();
    const result = toolResultOf(lastEcho(t.frontend), "remember_memory");
    expect(result).toContain("存的是截的这个元素的图，不是原文件");
    expect(result).not.toContain("只截到了");
    const [material] = t.remembered();
    expect(material!.segments[1]).toMatchObject({ form: "attachment", notes: ["screenshot"], label: "截图：cat.png" });
    expect((await detailOf(t.url, material!.id)).segments[1]).toMatchObject({ notes: ["screenshot"], part: { type: "image", name: "cat.png" } });
    await t.frontend.close();
    await t.daemon.stop();
  });

  it("截图只截到一部分：同样写明", { timeout: 60_000 }, async () => {
    const t = await start([FETCH, REMEMBER_WITH_FILE, ECHO], withImage({ via: "screenshot", partial: true }));
    await tell(t.frontend, "这张图记下来", onElement(CANVAS));
    t.stopDevice();
    expect(toolResultOf(lastEcho(t.frontend), "remember_memory")).toContain("只截到了屏幕上看得见的部分");
    const [material] = t.remembered();
    expect(material!.segments[1]).toMatchObject({ notes: ["screenshot_partial"], label: "截图：cat.png" });
    // canvas 没有地址：只有来源网页
    expect(material!.segments.filter((s) => s.form === "web_page").map((s) => s.url)).toEqual([PAGE.url]);
    await t.frontend.close();
    await t.daemon.stop();
  });

  it("什么都取不到：只记文字（连同来源）并说明；秘书拿到的取内容结果也教它这么说", { timeout: 60_000 }, async () => {
    const reason = "网页换了，编号对不上了";
    const t = await start([FETCH, call("remember_memory", { text: "用户让记下这张图：一只猫" }), ECHO], () => ({ ok: false, reason }));
    await tell(t.frontend, "这张图记下来", onElement(IMAGE));
    t.stopDevice();
    const context = lastEcho(t.frontend);
    expect(toolResultOf(context, "browse_element_content")).toContain("不带 file 记文字");
    const result = toolResultOf(context, "remember_memory");
    expect(result).toContain("只记了文字");
    expect(result).toContain(reason);
    const command = t.commands().find((c) => c.command === "remember");
    expect(command).not.toHaveProperty("file");
    expect(command).toMatchObject({ source: "proposed", origin: { page: PAGE, address: IMAGE.src } });
    const [material] = t.remembered();
    expect(material!.segments.map((s) => s.form)).toEqual(["choice", "web_page", "web_page"]);
    await t.frontend.close();
    await t.daemon.stop();
  });

  it("没取就记：照样记文字，说明没带文件、怎么带上", { timeout: 60_000 }, async () => {
    const t = await start([call("remember_memory", { text: "一只猫" }), ECHO]);
    await tell(t.frontend, "这张图记下来", onElement(IMAGE));
    t.stopDevice();
    const result = toolResultOf(lastEcho(t.frontend), "remember_memory");
    expect(result).toContain("只记了文字");
    expect(result).toContain("browse_element_content");
    await t.frontend.close();
    await t.daemon.stop();
  });
});

describe("别的轮次照旧（回归）", () => {
  it("平常说的\"帮我记一句\"、长按文字说的：照原话记，来源标记、结果照旧", { timeout: 60_000 }, async () => {
    const t = await start([call("remember_memory", { text: "周四晚上打羽毛球" }), ECHO, call("remember_memory", { text: "这段话要记住" }), ECHO]);
    await tell(t.frontend, "帮我记一句：周四晚上打羽毛球");
    expect(toolResultOf(lastEcho(t.frontend), "remember_memory")).toContain("照用户的原话记的");
    await tell(t.frontend, "记下来", onElement(TEXT));
    t.stopDevice();
    expect(toolResultOf(lastEcho(t.frontend), "remember_memory")).toContain("照用户的原话记的");
    const remembers = t.commands().filter((c) => c.command === "remember");
    expect(remembers).toMatchObject([{ source: "typed" }, { source: "typed" }]);
    expect(remembers[0]).not.toHaveProperty("origin");
    expect(remembers[1]).not.toHaveProperty("origin");
    expect(t.remembered().map((m) => m.segments.map((s) => s.form))).toEqual([["typed"], ["typed"]]);
    await t.frontend.close();
    await t.daemon.stop();
  });
});
