// 主切面：授权的文件夹（138 号票）。秘书在聊天里和"浏览"里共用一份（设置 · 浏览与填框里那一份，local-folders.json；149 号票起
// "浏览"里悬浮按钮背后也是秘书本人）：
// - 秘书的聊天里授权走快速动作"授权文件夹"：任何 agent 自己都不能改（2026-10-18 用户定），用户点名了是哪几个文件夹的、没点名的
//   都出待确认的卡（卡上写清哪几个完整路径、进待我处理），用户点"执行"才加；取消授权同样；路径不对的不出卡、原因回给秘书。改完的列表 GET /api/local-folders 照样取得到，"浏览"里的 find_files 在里面找；
// - 秘书被唤起时带着现在授权了哪几个文件夹（没有写"还没有"），那块写着用快速动作授权；
// - 设置页：PATCH 加几个、拿掉几个（找不到了的照样留着），选文件夹的框列常用位置、各个盘、子文件夹。
// 真实装配路径（startTestDaemon），假模型；用户目录、盘都是临时目录。
import fs from "node:fs";
import path from "node:path";
import {
  AUTHORIZE_FOLDERS_ACTION,
  CHANNELS,
  EVENT_TYPES,
  type FolderBrowseView,
  HTTP_PATHS,
  type LocalFoldersView,
  METHODS,
  type QuickActionCardPayload,
} from "@ergo/protocol";
import { describe, expect, it } from "vitest";
import { startTestDaemon } from "../helpers/daemon.ts";
import { TestFrontend } from "../helpers/frontend.ts";
import { requestJson } from "../helpers/http.ts";
import { waitUntil } from "../helpers/process.ts";
import { call, cardWhere, inboxOf, latestCards, messagesOf, ok, say, textOf, toolCallsOf } from "../helpers/task-flow.ts";
import { makeTempDir } from "../helpers/temp-dir.ts";

const SECRETARY = CHANNELS.secretary;
const ECHO = { kind: "echo_context" } as const;
const authorize = (change: "add" | "remove", folders: string[]) => call("propose_quick_action", { type: AUTHORIZE_FOLDERS_ACTION, params: { change, folders } });

/** 一个假的用户目录：图片、下载两个文件夹 */
function homeFolders() {
  const home = makeTempDir("ergo-user-");
  const pictures = path.join(home, "Pictures");
  const downloads = path.join(home, "Downloads");
  fs.mkdirSync(pictures);
  fs.mkdirSync(downloads);
  return { home, pictures, downloads };
}

const folderList = async (url: string) => (await requestJson<LocalFoldersView>(url, HTTP_PATHS.localFolders)).body.folders.map((f) => f.path);
/** 秘书处理完第 n 条输入 */
const secretaryTurns = (frontend: TestFrontend, n: number) =>
  waitUntil(() => frontend.events({ channel: SECRETARY, type: EVENT_TYPES.turnEnd }).length >= n, { timeoutMs: 30_000, describe: () => `等秘书处理完 ${n} 条输入` });
/** 秘书最后一次 echo_context 的回显 */
const lastEcho = (frontend: TestFrontend) => textOf(messagesOf(frontend, SECRETARY).filter((m) => m.message.speaker === "agent" && textOf(m).includes("[system] ")).at(-1)!);
/** 快速动作卡（同一张卡取最新的版本） */
const quickCards = (frontend: TestFrontend) => latestCards(frontend).filter((c) => c.type === "quick_action");
/** 秘书最后一次"提议快速动作"的工具结果 */
const lastProposal = (frontend: TestFrontend) => toolCallsOf(frontend, SECRETARY).filter((c) => c.tool === "propose_quick_action").at(-1);

describe("秘书的聊天里授权", () => {
  it("点名了也出待确认的卡，点“执行”后才加，设置里跟着有，“浏览”里 find_files 在里面找得到；秘书的上下文里是现在的列表", { timeout: 90_000 }, async () => {
    const { pictures, downloads } = homeFolders();
    fs.writeFileSync(path.join(downloads, "一个男人.jpg"), "照片");
    const td = await startTestDaemon({
      config: { guard: { conversationApprovals: "off" } },
      secretary: [ECHO, authorize("add", [pictures, downloads]), say("授权好了"), ECHO, call("find_files", { keywords: ["男人"], kind: "image" }), ECHO],
    });
    const frontend = await TestFrontend.connect(td.url);
    await frontend.subscribe({ [SECRETARY]: 0, [CHANNELS.cards]: 0, [CHANNELS.inbox]: 0 });

    // 还没有授权的文件夹：秘书的那块写"还没有"，并写着用快速动作授权
    await frontend.sendText("你好");
    await secretaryTurns(frontend, 1);
    const before = lastEcho(frontend);
    expect(before).toContain("授权的文件夹（你在聊天里、在“浏览”里找文件都用这一份，设置 · 浏览与填框里能看、能改）：\n还没有。");
    expect(before).toContain("用 propose_quick_action 的 authorize_folders");

    // 用户原话里点名了也不直接执行：出待确认的卡，卡上写清哪几个完整路径
    await frontend.sendText("把图片和下载文件夹授权给你");
    await secretaryTurns(frontend, 2);
    const pending = await cardWhere(frontend, (c) => c.type === "quick_action" && c.status === "pending");
    expect(pending.payload).toMatchObject({
      action: { type: AUTHORIZE_FOLDERS_ACTION, params: { change: "add", folders: [pictures, downloads] } },
      title: "授权文件夹：Pictures、Downloads",
      target: `${pictures}、${downloads}`,
      explicit: false,
    } satisfies Partial<QuickActionCardPayload>);
    expect(inboxOf(frontend).map((i) => i.title)).toEqual(["确认快速动作：授权文件夹"]);
    expect(lastProposal(frontend)?.resultSummary).toContain("等用户确认");
    expect(await folderList(td.url)).toEqual([]);

    ok(await frontend.cardAction({ cardId: pending.id, action: "execute", expectedVersion: pending.version }));
    const done = await cardWhere(frontend, (c) => c.id === pending.id && c.status === "handled");
    expect((done.payload as QuickActionCardPayload).result).toBe(`已授权 2 个文件夹：${pictures}、${downloads}。设置 · 浏览与填框里能看、能改`);
    expect(await folderList(td.url)).toEqual([pictures, downloads]);

    // 下一次唤起：秘书看到的是新的列表
    await frontend.sendText("现在授权了哪些？");
    await secretaryTurns(frontend, 3);
    expect(lastEcho(frontend)).toContain(`设置 · 浏览与填框里能看、能改）：\n- ${pictures}\n- ${downloads}`);

    // "浏览"里悬浮按钮上说的（秘书本人，149 号票）：find_files 在这两个文件夹里找到了
    const browser = "b-00000000000000aa";
    ok(await frontend.request(METHODS.browserStatus, { browser, page: { title: "上传头像", url: "https://example.cn/upload" } }));
    const avatar = { id: "f1", kind: "file" as const, label: "头像", accept: "image/*" };
    await frontend.sendText("放一张男人的照片", { browsing: { browser, page: { title: "上传头像", url: "https://example.cn/upload" }, selected: avatar, via: "button" } });
    await secretaryTurns(frontend, 4);
    expect(lastEcho(frontend)).toContain("一个男人.jpg");
  });

  it("没点名的同样出待确认的卡（进待我处理），点“执行”才加；取消授权也要点“执行”，设置里跟着少一行", { timeout: 90_000 }, async () => {
    const { pictures, downloads } = homeFolders();
    const td = await startTestDaemon({
      config: { guard: { conversationApprovals: "off" } },
      secretary: [authorize("add", [pictures, downloads]), say("请确认"), authorize("remove", [downloads]), say("拿掉了")],
    });
    const frontend = await TestFrontend.connect(td.url);
    await frontend.subscribe({ [SECRETARY]: 0, [CHANNELS.cards]: 0, [CHANNELS.inbox]: 0 });

    await frontend.sendText("你刚才访问的几个文件夹都可以授权");
    await secretaryTurns(frontend, 1);
    const pending = await cardWhere(frontend, (c) => c.type === "quick_action" && c.status === "pending");
    expect(pending.payload).toMatchObject({ explicit: false, title: "授权文件夹：Pictures、Downloads" });
    expect(inboxOf(frontend).map((i) => i.title)).toEqual(["确认快速动作：授权文件夹"]);
    expect(await folderList(td.url)).toEqual([]);
    expect(lastProposal(frontend)?.resultSummary).toContain("等用户确认");

    ok(await frontend.cardAction({ cardId: pending.id, action: "execute", expectedVersion: pending.version }));
    await cardWhere(frontend, (c) => c.id === pending.id && c.status === "handled");
    expect(await folderList(td.url)).toEqual([pictures, downloads]);

    await frontend.sendText("别让二狗看下载了");
    await secretaryTurns(frontend, 2);
    await waitUntil(() => quickCards(frontend).length === 2);
    const removal = quickCards(frontend).at(-1)!;
    expect(removal).toMatchObject({ status: "pending", payload: { explicit: false, title: "取消授权文件夹：Downloads", target: downloads } });
    expect(await folderList(td.url)).toEqual([pictures, downloads]);
    ok(await frontend.cardAction({ cardId: removal.id, action: "execute", expectedVersion: removal.version }));
    const removed = await cardWhere(frontend, (c) => c.id === removal.id && c.status === "handled");
    expect((removed.payload as QuickActionCardPayload).result).toBe(`已取消授权 1 个文件夹：${downloads}。设置 · 浏览与填框里能看、能改`);
    expect(await folderList(td.url)).toEqual([pictures]);
  });

  it("路径不是完整路径、不存在的：不执行、不出卡，秘书拿到原因", { timeout: 90_000 }, async () => {
    const { home } = homeFolders();
    const missing = path.join(home, "没有");
    const td = await startTestDaemon({
      config: { guard: { conversationApprovals: "off" } },
      secretary: [authorize("add", ["Pictures"]), say("不行"), authorize("add", [missing]), say("没有这个")],
    });
    const frontend = await TestFrontend.connect(td.url);
    await frontend.subscribe({ [SECRETARY]: 0, [CHANNELS.cards]: 0 });
    await frontend.sendText("把 Pictures 授权给你");
    await secretaryTurns(frontend, 1);
    expect(lastProposal(frontend)).toMatchObject({ outcome: "error", resultSummary: "不能这样做：要写完整的路径（比如 D:\\照片）：Pictures" });
    await frontend.sendText(`把 ${missing} 授权给你`);
    await secretaryTurns(frontend, 2);
    expect(lastProposal(frontend)).toMatchObject({ outcome: "error", resultSummary: `不能这样做：这台电脑上没有这个文件夹：${missing}` });
    expect(quickCards(frontend)).toEqual([]);
    expect(await folderList(td.url)).toEqual([]);
  });
});

describe("设置页的接口", () => {
  it("PATCH 加几个、拿掉几个，马上存；找不到了的照样留着、也能拿掉；路径不对 400", async () => {
    const { home, pictures, downloads } = homeFolders();
    const gone = path.join(home, "旧照片");
    fs.mkdirSync(gone);
    const td = await startTestDaemon();
    const patch = (body: unknown) => requestJson<LocalFoldersView>(td.url, HTTP_PATHS.localFolders, { method: "PATCH", body });
    expect((await patch({ add: [pictures, gone] })).body).toEqual({ folders: [{ path: pictures, exists: true }, { path: gone, exists: true }] });
    fs.rmSync(gone, { recursive: true });
    // 别的文件夹找不到了，照样能加新的
    expect((await patch({ add: [downloads] })).body).toEqual({ folders: [{ path: pictures, exists: true }, { path: gone, exists: false }, { path: downloads, exists: true }] });
    expect((await patch({ remove: [gone, pictures.toUpperCase()] })).body).toEqual({ folders: [{ path: downloads, exists: true }] });
    const bad = await requestJson<{ message: string }>(td.url, HTTP_PATHS.localFolders, { method: "PATCH", body: { add: [path.join(home, "没有")] } });
    expect(bad.status).toBe(400);
    expect(bad.body.message).toContain("这台电脑上没有这个文件夹");
    expect((await requestJson(td.url, HTTP_PATHS.localFolders, { method: "PATCH", body: { add: "x" } })).status).toBe(400);
  });

  it("选文件夹的框：不给路径是常用位置（按用户目录）和各个盘，给了路径是子文件夹和上一级，读不了的回原因", async () => {
    const drive = makeTempDir("ergo-drive-");
    const td = await startTestDaemon({ folderDrives: () => Promise.resolve([drive]) });
    for (const name of ["Pictures", "Desktop"]) fs.mkdirSync(path.join(td.homeDir, name));
    fs.mkdirSync(path.join(td.homeDir, "Pictures", "2026 杭州"));
    fs.mkdirSync(path.join(td.homeDir, "Pictures", ".cache"));
    const browse = (folder?: string) => requestJson<FolderBrowseView>(td.url, HTTP_PATHS.localFoldersBrowse(folder));
    const roots = (await browse()).body;
    expect(roots.kind === "roots" && roots.places.map((p) => p.name)).toEqual(["图片", "桌面", "用户目录"]);
    expect(roots.kind === "roots" && roots.drives).toEqual([{ name: drive, path: drive }]);
    const pictures = (await browse(path.join(td.homeDir, "Pictures"))).body;
    expect(pictures).toMatchObject({ kind: "folder", folders: [{ name: "2026 杭州" }], total: 1 });
    if (pictures.kind !== "folder") throw new Error("应当列出子文件夹");
    expect(pictures.parent).toBe(path.dirname(pictures.path));
    expect((await browse(path.join(td.homeDir, "没有"))).body).toMatchObject({ kind: "unreadable", reason: "这台电脑上没有这个文件夹" });
  });
});
