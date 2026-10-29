// 主切面：Looki 的"存一份到本地"（307 号票）。真的守护进程走组合根和插件清单，清单里的 Looki 插件经 extraPlugins 换成同名的、
// 接口地址指向本机假 Looki（helpers/fake-looki.ts：时刻、文件、vlog、预签名的文件链接都在本机；不连真的 Looki、不联网），
// 默认位置换成临时目录（绝不往真的用户目录下写）：
// - 设置 · 数据源里 Looki 下面有"存一份到本地"那一块：默认开着、位置是默认的 Looki 文件夹、照片 / 日记 / vlog 开着、原始视频关着；
// - 同步一天 → 照片按 年-月\日期\时刻（起始时间 标题）\ 落盘，字节一个不差、文件时间是拍摄时间；AI 日记写进当天的 日记.md；
//   vlog 放当天文件夹；每天一份 说明.txt；原始视频不下；文件链接不带 Key；不进素材（素材只有导入的记录）；旁边别的目录不碰；
// - 再同步不重下（存齐了的时刻连文件都不再列）；
// - 晚上传的时刻：列出来的链接已经过期 → 重新取一次链接再下；
// - "打开文件夹"走内核的在电脑上打开；
// - 断开并连已导入的一起删：确认框那句写明不删、存下的文件都还在。
import fs from "node:fs";
import path from "node:path";
import { isLookiArchiveView, type DataSourceView, type LookiArchiveView } from "@ergo/protocol";
import { describe, expect, it } from "vitest";
import { LOOKI_CHANNEL, LOOKI_JOURNAL, LOOKI_MOMENT, LOOKI_SOURCE_ID } from "../../src/looki/api.ts";
import { createLookiPlugin } from "../../src/looki/plugin.ts";
import { ManualClock } from "../helpers/clock.ts";
import { startTestDaemon, type TestDaemon } from "../helpers/daemon.ts";
import { type FakeLooki, fakeMoment, fakePhoto, fakeVideo, LOOKI_TEST_KEY, startFakeLooki } from "../helpers/fake-looki.ts";
import { dataSourcesApi } from "../helpers/http.ts";
import { waitUntil } from "../helpers/process.ts";
import { makeTempDir } from "../helpers/temp-dir.ts";

/** 守护进程的"现在"：2026-10-25（周日）上午，昨天是 10-24 */
const NOW = new Date("2026-10-25T10:00:00+08:00");

let n = 0;
const key = () => `looki-archive-${++n}`;

const photo11 = fakePhoto("f-11", "2026-10-24T14:00:05+08:00", "望京 SOHO");
const photo12 = fakePhoto("f-12", "2026-10-24T15:30:00+08:00", "望京 SOHO");
const clip13 = fakeVideo("f-13", "2026-10-24T14:10:00+08:00");
const photo21 = fakePhoto("f-21", "2026-10-24T19:20:00+08:00");
const photo01 = fakePhoto("f-01", "2026-10-23T12:10:00+08:00", "海底捞（望京店）");
const vlogFile = fakeVideo("vf-1", "2026-10-24T23:00:00+08:00");

/** 假 Looki 里放好的：昨天两个时刻（开会那个有两张照片和一段视频）、一篇日记、一个 vlog，前天一个时刻 */
function script(fake: FakeLooki) {
  fake.moments.set("2026-10-24", [
    fakeMoment({ id: "m-1", date: "2026-10-24", start: "14:00", end: "16:30", title: "在望京开会", description: "和同事在会议室讨论下季度计划", location: "望京 SOHO", media: ["IMAGE", "VIDEO"] }),
    fakeMoment({ id: "m-2", date: "2026-10-24", start: "19:10", end: "19:40", title: "散步回家", description: "沿着河边慢慢走回家" }),
  ]);
  fake.moments.set("2026-10-23", [fakeMoment({ id: "m-0", date: "2026-10-23", start: "12:00", end: "12:50", title: "吃火锅", description: "中午和朋友吃了一顿火锅", location: "海底捞（望京店）" })]);
  fake.files.set("m-1", [photo11, clip13, photo12]);
  fake.files.set("m-2", [photo21]);
  fake.files.set("m-0", [photo01]);
  fake.journals.push({ id: "j-1", type: "DIARY", title: "忙碌又平静的周六", description: "下午开会，晚上散步", content: "今天下午在望京开了一个很长的会，有点累；晚上沿河散步，心情放松了不少。", recorded_at: "2026-10-24T22:00:00+08:00" });
  fake.vlogs.push({ id: "v-1", type: "DAILY_VLOG", title: "忙碌的周六", description: "一天的高光", recorded_date: "2026-10-24", created_at: "2026-10-25T01:00:00+08:00", file: vlogFile });
}

const lookiOf = (sources: readonly DataSourceView[]) => sources.find((s) => s.id === LOOKI_SOURCE_ID)!;
const panelOf = (source: DataSourceView): LookiArchiveView => {
  expect(isLookiArchiveView(source.panel)).toBe(true);
  return source.panel as LookiArchiveView;
};

/** 等数据源页上"存一份到本地"那一块满足条件（存是在后台排队做的） */
async function waitPanel(td: TestDaemon, ok: (panel: LookiArchiveView) => boolean, what: string): Promise<LookiArchiveView> {
  const deadline = Date.now() + 30_000;
  for (;;) {
    const panel = panelOf(lookiOf((await dataSourcesApi.view(td.url)).body.sources));
    if (ok(panel)) return panel;
    if (Date.now() > deadline) throw new Error(`等不到：${what}（${JSON.stringify(panel)}）`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}
const idleWith = (photos: number) => (p: LookiArchiveView) => p.working === undefined && p.saved.photos === photos;

const lookiMaterials = (td: TestDaemon) => td.daemon.materials.list().filter((m) => m.ref.event.channel === LOOKI_CHANNEL);
/** 一个文件夹下的全部文件（相对路径，正斜杠） */
function listAll(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { recursive: true, withFileTypes: true }).flatMap((e) => (e.isFile() ? [path.relative(dir, path.join(e.parentPath, e.name)).split(path.sep).join("/")] : []));
}
const filesRequested = (fake: FakeLooki, moment: string) => fake.keyed().filter((r) => r.path === `/api/v1/moments/${moment}/files`).length;

describe("Looki 存一份到本地（假 Looki 接口、临时目录代替默认位置）", () => {
  it("同步一天 → 照片、日记、vlog 按日期 / 时刻落盘，原始视频不下；再同步不重下；链接过期重新取；断开并删不碰本地文件", { timeout: 120_000 }, async () => {
    const fake = await startFakeLooki();
    script(fake);
    const tmp = makeTempDir("ergo-looki-archive-");
    const documents = path.join(tmp, "Documents");
    const folder = path.join(documents, "Looki");
    // 旁边别的目录（用户自己的文件……）：一个字节都不许动
    fs.mkdirSync(path.join(documents, "其他文件"), { recursive: true });
    fs.writeFileSync(path.join(documents, "其他文件", "说明.txt"), "别的东西");
    const opened: string[] = [];
    const logs: string[] = [];
    const td = await startTestDaemon({
      extraPlugins: [createLookiPlugin({ endpoints: { cn: fake.base, global: fake.base }, rateLimitWaitMs: 20, archive: { defaultFolder: folder } })],
      clock: new ManualClock(NOW),
      memoryPlugin: true,
      log: (line) => logs.push(line),
      openFolder: (dir) => {
        opened.push(dir);
        return Promise.resolve();
      },
    });
    expect(path.relative(td.dataDir, folder).startsWith("..")).toBe(true);

    // 设置 · 数据源里 Looki 下面有"存一份到本地"那一块：默认开着、位置、几类的默认
    const first = lookiOf((await dataSourcesApi.view(td.url)).body.sources);
    expect(panelOf(first)).toMatchObject({
      on: true,
      folder,
      defaultFolder: folder,
      kinds: { photos: true, journals: true, vlogs: true, clips: false },
      saved: { photos: 0, clips: 0, journals: 0, vlogs: 0, bytes: 0, days: 0 },
      pending: 0,
      failed: 0,
    });
    expect(first.disconnectNote).toContain(folder);
    expect(fs.existsSync(folder)).toBe(false);

    await dataSourcesApi.act(td.url, LOOKI_SOURCE_ID, { action: "configure", values: { key: LOOKI_TEST_KEY, region: "cn" }, idempotencyKey: key() });
    const synced = await dataSourcesApi.act(td.url, LOOKI_SOURCE_ID, { action: "sync", idempotencyKey: key() });
    expect(synced.body).toMatchObject({ added: 4 });

    // 存是排在后面做的：等它存完
    const done = await waitPanel(td, idleWith(4), "存下 4 张照片");
    const day = path.join(folder, "2026-10", "2026-10-24");
    const meeting = path.join(day, "14.00 在望京开会");
    expect(listAll(folder).toSorted()).toEqual(
      [
        "2026-10/2026-10-23/12.00 吃火锅/12.10.00-f01.jpg",
        "2026-10/2026-10-23/说明.txt",
        "2026-10/2026-10-24/14.00 在望京开会/14.00.05-f11.jpg",
        "2026-10/2026-10-24/14.00 在望京开会/15.30.00-f12.jpg",
        "2026-10/2026-10-24/19.10 散步回家/19.20.00-f21.jpg",
        "2026-10/2026-10-24/vlog 忙碌的周六.mp4",
        "2026-10/2026-10-24/日记.md",
        "2026-10/2026-10-24/说明.txt",
      ].toSorted(),
    );
    // 照片原样保存：字节一个不差（拍摄时间、地点在原文件的 EXIF 里），文件时间是拍摄时间
    expect(fs.readFileSync(path.join(meeting, "14.00.05-f11.jpg")).equals(photo11.bytes)).toBe(true);
    expect(fs.readFileSync(path.join(meeting, "15.30.00-f12.jpg")).equals(photo12.bytes)).toBe(true);
    expect(Math.abs(fs.statSync(path.join(meeting, "14.00.05-f11.jpg")).mtimeMs - Date.parse("2026-10-24T14:00:05+08:00"))).toBeLessThan(2000);
    expect(fs.readFileSync(path.join(day, "vlog 忙碌的周六.mp4")).equals(vlogFile.bytes)).toBe(true);
    // 原始视频片段默认不存：连下载都没有
    expect(fake.downloads).not.toContain("f-13");
    expect(fake.downloads.toSorted()).toEqual(["f-01", "f-11", "f-12", "f-21", "vf-1"]);
    // 文件链接不带 Key
    expect(fake.mediaWithKey).toBe(0);
    // AI 日记存成 日记.md（日期、正文）
    const journal = fs.readFileSync(path.join(day, "日记.md"), "utf8");
    expect(journal).toContain("# 2026-10-24 · 忙碌又平静的周六");
    expect(journal).toContain("今天下午在望京开了一个很长的会");
    // 每天一份说明：这天有哪些时刻、几点、在哪、照片在哪个文件夹、日记、vlog
    const readme = fs.readFileSync(path.join(day, "说明.txt"), "utf8");
    expect(readme).toContain("2026-10-24（周六）· Looki");
    expect(readme).toContain("这天有 2 个时刻");
    expect(readme).toContain("14:00–16:30  在望京开会");
    expect(readme).toContain("地点：望京 SOHO");
    expect(readme).toContain("照片 2 张 → 文件夹「14.00 在望京开会」");
    expect(readme).toContain("AI 日记：日记.md（忙碌又平静的周六）");
    expect(readme).toContain("vlog：vlog 忙碌的周六.mp4");
    // 已存多少：数据源页上那一块
    const bytes = [photo11, photo12, photo21, photo01, vlogFile].reduce((sum, f) => sum + f.bytes.length, 0) + Buffer.byteLength(journal);
    expect(done).toMatchObject({ saved: { photos: 4, clips: 0, journals: 1, vlogs: 1, days: 2, bytes }, pending: 0, failed: 0 });
    expect(done.lastSavedAt).toBeDefined();
    expect(done.problem).toBeUndefined();
    // 旁边别的目录没动
    expect(listAll(path.join(documents, "其他文件"))).toEqual(["说明.txt"]);
    expect(fs.readFileSync(path.join(documents, "其他文件", "说明.txt"), "utf8")).toBe("别的东西");
    // 不进素材：素材只有导入的四条记录；预签名链接哪儿都不存
    await waitUntil(() => lookiMaterials(td).length === 4, { timeoutMs: 20_000, describe: () => `素材：${lookiMaterials(td).length}` });
    expect(new Set(lookiMaterials(td).map((m) => m.ref.event.type))).toEqual(new Set([LOOKI_MOMENT, LOOKI_JOURNAL]));
    expect(td.daemon.materials.list().some((m) => JSON.stringify(m).includes(".jpg"))).toBe(false);
    expect(JSON.stringify(td.daemon.store.readGlobal(0, 1_000_000).map((e) => e.payload))).not.toContain("X-Amz-Signature");

    // 再同步一次：不重下，存齐了的时刻连文件都不再列
    const listedBefore = ["m-0", "m-1", "m-2"].map((m) => filesRequested(fake, m));
    await dataSourcesApi.act(td.url, LOOKI_SOURCE_ID, { action: "sync", idempotencyKey: key() });
    await waitPanel(td, idleWith(4), "再同步一次后闲下来");
    expect(fake.downloads).toHaveLength(5);
    expect(["m-0", "m-1", "m-2"].map((m) => filesRequested(fake, m))).toEqual(listedBefore);

    // 晚上传的时刻：列出来的链接已经过期（像过了一小时）→ 重新取一次链接再下
    const photo31 = fakePhoto("f-31", "2026-10-24T18:05:00+08:00");
    fake.moments.get("2026-10-24")!.push(fakeMoment({ id: "m-3", date: "2026-10-24", start: "18:00", end: "18:40", title: "吃晚饭", description: "楼下的面馆" }));
    fake.files.set("m-3", [photo31]);
    fake.expireNext = 1;
    await dataSourcesApi.act(td.url, LOOKI_SOURCE_ID, { action: "sync", idempotencyKey: key() });
    await waitPanel(td, idleWith(5), "存下晚上传的那张");
    expect(filesRequested(fake, "m-3")).toBe(2);
    expect(fake.downloads.filter((id) => id === "f-31")).toHaveLength(1);
    expect(fs.readFileSync(path.join(day, "18.00 吃晚饭", "18.05.00-f31.jpg")).equals(photo31.bytes)).toBe(true);
    expect(fs.readFileSync(path.join(day, "说明.txt"), "utf8")).toContain("这天有 3 个时刻");
    expect(logs.some((line) => line.includes("下载链接过期了，重新取一次"))).toBe(true);

    // "打开文件夹"：内核用和导入文件夹同一个做法打开存放位置
    const open = await dataSourcesApi.act(td.url, LOOKI_SOURCE_ID, { action: "open", idempotencyKey: key() });
    expect(open.body).toMatchObject({ opened: true });
    expect(opened).toEqual([folder]);

    // 断开并连已导入的一起删：存下的文件都还在，那一块照样显示已存多少
    const saved = listAll(folder);
    const purged = await dataSourcesApi.act(td.url, LOOKI_SOURCE_ID, { action: "disconnect", purge: true, idempotencyKey: key() });
    expect(purged.status).toBe(200);
    expect(purged.body.purged?.events).toBeGreaterThan(0);
    expect(listAll(folder)).toEqual(saved);
    expect(fs.readFileSync(path.join(meeting, "14.00.05-f11.jpg")).equals(photo11.bytes)).toBe(true);
    const after = lookiOf(purged.body.view.sources);
    expect(after.connection).toBe("not_connected");
    expect(panelOf(after).saved.photos).toBe(5);
    // Key 哪儿都没有
    expect(logs.some((line) => line.includes(LOOKI_TEST_KEY))).toBe(false);
    expect(JSON.stringify(after)).not.toContain(LOOKI_TEST_KEY);
  });
});
