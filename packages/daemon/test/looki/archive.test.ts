// Looki 的"存一份到本地"在假内核里（startPluginKernel：真的插件宿主、数据源那一层），接口地址指向本机的假 Looki
// （helpers/fake-looki.ts：时刻、文件、vlog、文件链接都在本机，不联网），存放位置一律是临时目录（不碰真的用户目录）。查：
// - 文件夹名、文件名：非法字换成全角的、保留名、太长截短（整条路径不超过上限）、同一分钟同名的加序号；
// - 存哪几类的开关：原始视频开了才下、照片 / 日记 / vlog 关了不存；后来开了原始视频，下次同步把同步范围里的时刻补上；
// - 下载失败：时刻记着没存齐（说明.txt 写明），下次同步接着补（不在这次同步的日子里也补）；连着 5 次不行不再自动试，"现在接着存"再试；
// - 翻页：一个时刻的文件分几页列；
// - 磁盘满、位置不是文件夹、相对路径、放进数据目录、默认位置的上一级不在：停下 / 不改，原因写明；同步照样导入记录；
// - 关着不存；索引丢了不重下、不重复写；
// - 补存：默认最近 30 天往回补、一天一批；一直限速时等着（写明在等），能停、能接着补、补完；没连上不让补，日期不对不让补；
// - 停用插件、断开时正在补的停下（已暂停）；
// - vlog 从 /journals 取（424）：默认不勾，不勾时整条不要（不下视频、不当日记导入、不写进 日记.md）；勾上后 DAILY_VLOG 条目里的视频存下来、不重复存，封面不下；/for_you/items 不再调用；空列表、翻页照常；
//   以前从 for_you 存下的 vlog 不动、不重下（索引改记新 id）；Looki 回"接口停用了"时那一块写"Looki 换了接口"，照片、日记照常，好了清掉。
import fs from "node:fs";
import path from "node:path";
import type { LookiArchiveView } from "@ergo/protocol";
import { describe, expect, it } from "vitest";
import { dataDirLayout } from "../../src/config/data-dir.ts";
import { LOOKI_CHANNEL, LOOKI_JOURNAL, LOOKI_PLUGIN, LOOKI_SOURCE_ID } from "../../src/looki/api.ts";
import { MAX_PATH_CHARS, mediaFileName, momentFolderName, safeName, vlogFileName } from "../../src/looki/archive-paths.ts";
import { createArchiveStore } from "../../src/looki/archive-store.ts";
import { createLookiClient, LookiError } from "../../src/looki/client.ts";
import { createLookiPlugin, type LookiPluginOptions } from "../../src/looki/plugin.ts";
import { KERNEL } from "../../src/plugins/kernel.ts";
import { type FakeLooki, fakeMoment, fakePhoto, fakeVideo, LOOKI_TEST_KEY, startFakeLooki } from "../helpers/fake-looki.ts";
import { extraService, type PluginKernel, startPluginKernel } from "../helpers/plugin-kernel.ts";
import { makeTempDir } from "../helpers/temp-dir.ts";

/** 假内核的"现在"：2026-10-25（周日）上午 */
const AT = new Date("2026-10-25T10:00:00+08:00");

let seq = 0;
const key = () => `la-${++seq}`;

async function setup(archive: LookiPluginOptions["archive"] & { home?: string } = {}) {
  const fake = await startFakeLooki();
  const home = archive.home ?? path.join(makeTempDir("ergo-looki-home-"), "Looki");
  const { home: _home, ...rest } = archive;
  const plugin = createLookiPlugin({ endpoints: { cn: fake.base, global: fake.base }, rateLimitWaitMs: 10, archive: { defaultFolder: home, ...rest } });
  const k = await startPluginKernel({ plugins: [plugin], at: AT, services: [extraService(KERNEL.layout, ({ dir }) => dataDirLayout(dir))] });
  return { fake, k, home };
}

const view = (k: PluginKernel) => k.dataSources.view().sources.find((s) => s.id === LOOKI_SOURCE_ID)!;
const panel = (k: PluginKernel) => view(k).panel as LookiArchiveView;
const configure = (k: PluginKernel, values: Record<string, string>) => k.dataSources.act(LOOKI_SOURCE_ID, { action: "configure", values, idempotencyKey: key() });
const connect = (k: PluginKernel) => configure(k, { key: LOOKI_TEST_KEY, region: "cn" });
const sync = (k: PluginKernel) => k.dataSources.act(LOOKI_SOURCE_ID, { action: "sync", idempotencyKey: key() });
const archive = (k: PluginKernel, values: Record<string, string>) => configure(k, values);
/** 勾上 vlog（默认不勾，424） */
const vlogsOn = (k: PluginKernel) => archive(k, { archive: "settings", vlogs: "true" });

/** 等那一块满足条件（存在后台排队做） */
async function until(k: PluginKernel, ok: (p: LookiArchiveView) => boolean, what: string): Promise<LookiArchiveView> {
  for (let i = 0; i < 800; i += 1) {
    const p = panel(k);
    if (ok(p)) return p;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`等不到：${what}（${JSON.stringify(panel(k))}）`);
}
const idle = (p: LookiArchiveView) => p.working === undefined;

function listAll(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir, { recursive: true, withFileTypes: true })
    .flatMap((e) => (e.isFile() ? [path.relative(dir, path.join(e.parentPath, e.name)).split(path.sep).join("/")] : []))
    .toSorted();
}
const filesListed = (fake: FakeLooki, moment: string) => fake.keyed().filter((r) => r.path === `/api/v1/moments/${moment}/files`).length;
const daysAsked = (fake: FakeLooki) => fake.keyed().filter((r) => r.path === "/api/v1/moments").map((r) => r.query.on_date);

/** 昨天一个时刻（两张照片一段视频）、10-20 一个时刻（一张照片）、昨天一篇日记、一个 vlog */
function script(fake: FakeLooki) {
  fake.moments.set("2026-10-24", [fakeMoment({ id: "m-1", date: "2026-10-24", start: "14:00", end: "16:30", title: "在望京开会", description: "讨论下季度计划", location: "望京 SOHO", media: ["IMAGE", "VIDEO"] })]);
  fake.moments.set("2026-10-20", [fakeMoment({ id: "m-0", date: "2026-10-20", start: "12:00", end: "12:50", title: "吃火锅", description: "中午和朋友吃火锅" })]);
  fake.files.set("m-1", [fakePhoto("p-1", "2026-10-24T14:00:05+08:00"), fakeVideo("c-1", "2026-10-24T14:10:00+08:00"), fakePhoto("p-2", "2026-10-24T15:00:00+08:00")]);
  fake.files.set("m-0", [fakePhoto("p-0", "2026-10-20T12:10:00+08:00")]);
  fake.journals.push({ id: "j-1", type: "DIARY", title: "周六", description: "开会", content: "下午开了个长会。", recorded_at: "2026-10-24T22:00:00+08:00" });
  fake.vlogs.push({ id: "v-1", type: "DAILY_VLOG", title: "周六", description: "", recorded_date: "2026-10-24", created_at: "2026-10-25T01:00:00+08:00", file: fakeVideo("vf-1", "2026-10-25T01:00:00+08:00") });
}

describe("文件夹名、文件名", () => {
  it("非法字换成全角的、控制字符和末尾的点去掉、保留名加\"_\"", () => {
    expect(safeName('会议: Q4/计划? <草稿> "a|b*c" \\ 结束...')).toBe("会议： Q4／计划？ ＜草稿＞ ＂a｜b＊c＂ ＼ 结束");
    expect(safeName("第一行\n第二行\t完")).toBe("第一行 第二行 完");
    expect(safeName("CON")).toBe("CON_");
    expect(safeName("nul.txt")).toBe("nul.txt_");
    expect(safeName("😀".repeat(40), 5)).toBe("😀😀");
  });

  it("时刻文件夹：钟点 + 标题，标题按路径预算截短（截没了只留钟点），同一分钟同名的加序号", () => {
    const root = "C:\\Looki";
    expect(momentFolderName(root, "2026-10-24", "2026-10-24T14:00:00.000+08:00", "会议: Q4/计划?", new Set())).toBe("14.00 会议： Q4／计划？");
    expect(momentFolderName(root, "2026-10-24", "2026-10-24T14:00:00.000+08:00", "开会", new Set(["14.00 开会"]))).toBe("14.00 开会 (2)");
    expect(momentFolderName(root, "2026-10-24", "2026-10-24T09:05:00.000+08:00", "长".repeat(300), new Set())).toBe(`09.05 ${"长".repeat(60)}`);
    // 存放位置本身很长：整条路径（含照片的文件名）不超过上限
    const deep = `C:\\${"很长的文件夹名".repeat(25)}`;
    const name = momentFolderName(deep, "2026-10-24", "2026-10-24T09:05:00.000+08:00", "长".repeat(300), new Set());
    const photo = path.win32.join(deep, "2026-10", "2026-10-24", name, mediaFileName("2026-10-24T09:05:07+08:00", "file-abcdef123", ".jpeg"));
    expect(photo.length).toBeLessThanOrEqual(MAX_PATH_CHARS);
    expect(name.startsWith("09.05")).toBe(true);
    const deeper = `C:\\${"很长的文件夹名".repeat(32)}`;
    expect(momentFolderName(deeper, "2026-10-24", "2026-10-24T09:05:00.000+08:00", "长".repeat(300), new Set())).toBe("09.05");
  });

  it("照片文件名：拍摄时刻（墙上时间）加 id 末 6 位；vlog：vlog + 标题，重了加序号", () => {
    expect(mediaFileName("2026-10-24T14:00:05.000+08:00", "file_9f8e7d6c5b", ".jpg")).toBe("14.00.05-7d6c5b.jpg");
    expect(vlogFileName("C:\\Looki", "2026-10-24", "忙碌的周六", ".mp4", new Set())).toBe("vlog 忙碌的周六.mp4");
    expect(vlogFileName("C:\\Looki", "2026-10-24", "", ".mp4", new Set(["vlog.mp4"]))).toBe("vlog (2).mp4");
  });
});

describe("存哪几类", () => {
  it("原始视频开了才下；照片、日记、vlog 关了不存；后来开了原始视频，下次同步把范围里的时刻补上", async () => {
    const { fake, k, home } = await setup();
    script(fake);
    await connect(k);
    await archive(k, { archive: "settings", photos: "false", journals: "false", vlogs: "false", clips: "false" });
    expect(panel(k).kinds).toEqual({ photos: false, journals: false, vlogs: false, clips: false });
    await sync(k);
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(listAll(home)).toEqual([]);
    expect(fake.downloads).toEqual([]);
    expect(fake.keyed().some((r) => r.path === "/api/v1/for_you/items")).toBe(false);

    // 只开原始视频：只下视频
    await archive(k, { archive: "settings", clips: "true" });
    await sync(k);
    await until(k, (p) => idle(p) && p.saved.clips === 1, "存下一段视频");
    expect(listAll(home)).toEqual(["2026-10/2026-10-24/14.00 在望京开会/14.10.00-c1.mp4", "2026-10/2026-10-24/说明.txt"]);
    expect(fs.readFileSync(path.join(home, "2026-10", "2026-10-24", "说明.txt"), "utf8")).toContain("视频 1 段 → 文件夹「14.00 在望京开会」");

    // 再开照片：同步范围里存过视频的时刻再列一次，只补照片
    await archive(k, { archive: "settings", photos: "true" });
    await sync(k);
    const p = await until(k, (q) => idle(q) && q.saved.photos === 2, "补上两张照片");
    expect(p.saved).toMatchObject({ photos: 2, clips: 1, journals: 0, vlogs: 0 });
    expect(fake.downloads.toSorted()).toEqual(["c-1", "p-1", "p-2"]);
  });

  it("关着不存；位置改成别处后新的存到新位置，已经存的不搬", async () => {
    const { fake, k, home } = await setup();
    script(fake);
    await connect(k);
    await archive(k, { archive: "settings", on: "false" });
    expect(panel(k).on).toBe(false);
    await sync(k);
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(fake.downloads).toEqual([]);
    const elsewhere = path.join(makeTempDir("ergo-looki-elsewhere-"), "我的 Looki");
    await archive(k, { archive: "settings", on: "true", folder: `"${elsewhere}"` });
    expect(panel(k)).toMatchObject({ on: true, folder: elsewhere, defaultFolder: home });
    expect(panel(k).refused).toBeUndefined();
    await sync(k);
    await until(k, (p) => idle(p) && p.saved.photos === 2, "新位置存下昨天的两张照片");
    expect(listAll(elsewhere)).toContain("2026-10/2026-10-24/14.00 在望京开会/14.00.05-p1.jpg");
    expect(listAll(home)).toEqual([]);
    // 改回默认位置：空的就是默认
    await archive(k, { archive: "settings", folder: "" });
    expect(panel(k).folder).toBe(home);
  });
});

describe("没存齐的接着补", () => {
  it("下载失败：记着没存齐、说明里写明；下次同步接着补（不在这次同步的日子里也补）", async () => {
    const { fake, k, home } = await setup();
    script(fake);
    fake.brokenMedia.add("p-0");
    await connect(k);
    await sync(k);
    const first = await until(k, (p) => idle(p) && p.saved.photos === 2 && p.pending === 1, "10-20 那张没存下");
    expect(first.failed).toBe(0);
    expect(fs.readFileSync(path.join(home, "2026-10", "2026-10-20", "说明.txt"), "utf8")).toContain("还没存齐，下次同步接着存");
    // 修好了；下次同步只拉 10-23、10-24（从上次同步那天往前两天），10-20 那个时刻照样接着补
    fake.brokenMedia.clear();
    const asked = daysAsked(fake).length;
    await sync(k);
    await until(k, (p) => idle(p) && p.saved.photos === 3 && p.pending === 0, "接着补上 10-20 那张");
    expect(daysAsked(fake).slice(asked)).toEqual(["2026-10-23", "2026-10-24"]);
    expect(listAll(home)).toContain("2026-10/2026-10-20/12.00 吃火锅/12.10.00-p0.jpg");
    expect(fs.readFileSync(path.join(home, "2026-10", "2026-10-20", "说明.txt"), "utf8")).not.toContain("还没存齐");
  });

  it("连着 5 次不行不再自动试（说明里写明）；\"现在接着存\"再试", async () => {
    const { fake, k, home } = await setup();
    script(fake);
    fake.brokenMedia.add("p-0");
    await connect(k);
    for (let i = 0; i < 5; i += 1) {
      await sync(k);
      await until(k, idle, `第 ${i + 1} 次同步存完`);
      await new Promise((resolve) => setTimeout(resolve, 30));
      await until(k, idle, `第 ${i + 1} 次同步存完`);
    }
    const p = await until(k, (q) => idle(q) && q.failed === 1, "10-20 那个时刻试够了");
    expect(p.pending).toBe(0);
    expect(fs.readFileSync(path.join(home, "2026-10", "2026-10-20", "说明.txt"), "utf8")).toContain("试了几次都没存下来");
    const listed = filesListed(fake, "m-0");
    await sync(k);
    await until(k, idle, "再同步一次");
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(filesListed(fake, "m-0")).toBe(listed);
    fake.brokenMedia.clear();
    await archive(k, { archive: "retry" });
    await until(k, (q) => idle(q) && q.failed === 0 && q.saved.photos === 3, "现在接着存补上");
  });

  it("一个时刻的文件分几页列：都存下", async () => {
    const { fake, k, home } = await setup();
    fake.filesPageSize = 2;
    fake.moments.set("2026-10-24", [fakeMoment({ id: "m-9", date: "2026-10-24", start: "08:00", end: "09:00", title: "早饭", description: "包子" })]);
    fake.files.set(
      "m-9",
      [1, 2, 3, 4, 5].map((i) => fakePhoto(`p-9${i}`, `2026-10-24T08:0${i}:00+08:00`)),
    );
    await connect(k);
    await sync(k);
    await until(k, (p) => idle(p) && p.saved.photos === 5, "五张都存下");
    expect(listAll(path.join(home, "2026-10", "2026-10-24", "08.00 早饭"))).toHaveLength(5);
    expect(filesListed(fake, "m-9")).toBe(3);
  });

  it("索引丢了：再存同一天不重下、日记不重复写", async () => {
    const { fake, k, home } = await setup();
    script(fake);
    await connect(k);
    await vlogsOn(k);
    await sync(k);
    await until(k, (p) => idle(p) && p.saved.photos === 3 && p.saved.vlogs === 1, "存完");
    const before = fake.downloads.length;
    const journal = fs.readFileSync(path.join(home, "2026-10", "2026-10-24", "日记.md"), "utf8");
    fs.rmSync(path.join(k.dir, "looki-archive"), { recursive: true, force: true });
    await archive(k, { archive: "backfill", from: "2026-10-20", to: "2026-10-24" });
    await until(k, (p) => idle(p) && p.backfill?.state === "done", "补存完");
    expect(fake.downloads.length).toBe(before);
    expect(fs.readFileSync(path.join(home, "2026-10", "2026-10-24", "日记.md"), "utf8")).toBe(journal);
    expect(panel(k).saved).toMatchObject({ photos: 3, vlogs: 1 });
  });
});

describe("停下来写明", () => {
  it("磁盘满：停下、写明原因、什么都不写；同步照样导入记录；腾出地方后\"现在接着存\"", async () => {
    let free = 10 * 1024 * 1024;
    const { fake, k, home } = await setup({ freeSpace: () => free });
    script(fake);
    await connect(k);
    const result = await sync(k);
    // 两个时刻、一篇日记；vlog 默认不勾，它那一条不当日记导入
    expect(result.added).toBe(3);
    const p = await until(k, (q) => idle(q) && q.problem !== undefined, "停下写明");
    expect(p.problem).toContain("磁盘满了");
    expect(p.problem).toContain(home);
    expect(listAll(home)).toEqual([]);
    expect(fake.downloads).toEqual([]);
    free = 50 * 1024 ** 3;
    await archive(k, { archive: "retry" });
    const done = await until(k, (q) => idle(q) && q.saved.photos === 3 && q.pending === 0, "腾出地方后没轮到的也补上");
    expect(done.problem).toBeUndefined();
  });

  it("位置不是文件夹、写的是相对路径、放进二狗的数据目录：不改，写明原因", async () => {
    const { k, home } = await setup();
    const blocker = path.join(makeTempDir("ergo-looki-blocker-"), "一个文件");
    fs.writeFileSync(blocker, "不是文件夹");
    await archive(k, { archive: "settings", folder: path.join(blocker, "Looki") });
    expect(panel(k).refused).toMatch(/不是文件夹|写不进/);
    expect(panel(k).folder).toBe(home);
    await archive(k, { archive: "settings", folder: "Looki\\照片" });
    expect(panel(k).refused).toContain("完整的路径");
    await archive(k, { archive: "settings", folder: path.join(k.dir, "looki-photos") });
    expect(panel(k).refused).toContain("数据目录");
    expect(panel(k).folder).toBe(home);
    // 下一次做成了：原因清掉
    await archive(k, { archive: "settings", vlogs: "false" });
    expect(panel(k).refused).toBeUndefined();
  });

  it("默认位置的上一级文件夹不在：不自己建，写明", async () => {
    const missing = path.join(makeTempDir("ergo-looki-nohome-"), "Documents", "Looki");
    const { fake, k } = await setup({ home: missing });
    script(fake);
    await connect(k);
    await sync(k);
    const p = await until(k, (q) => idle(q) && q.problem !== undefined, "写明上一级文件夹不在");
    expect(p.problem).toContain("上一级文件夹不在");
    expect(fs.existsSync(path.dirname(missing))).toBe(false);
  });
});

describe("补存（把以前的也存下来）", () => {
  it("默认最近 30 天、往回一天一批；一直限速时等着（写明在等），能停、能接着补、补完", async () => {
    const { fake, k, home } = await setup();
    script(fake);
    fake.moments.set("2026-09-26", [fakeMoment({ id: "m-old", date: "2026-09-26", start: "10:00", end: "11:00", title: "爬山", description: "香山" })]);
    fake.files.set("m-old", [fakePhoto("p-old", "2026-09-26T10:30:00+08:00")]);
    // 没连上不让补
    await archive(k, { archive: "backfill" });
    expect(panel(k).refused).toContain("先连上 Looki");
    await connect(k);
    // 日期不对不让补
    await archive(k, { archive: "backfill", from: "2026-10-24", to: "2026-10-20" });
    expect(panel(k).refused).toContain("日期");
    await archive(k, { archive: "backfill", from: "2026-10-01", to: "2026-10-25" });
    expect(panel(k).refused).toContain("日期");

    // 一直限速：等着（写明在等）
    fake.mode = "rate_limited";
    await archive(k, { archive: "backfill" });
    const waiting = await until(k, (p) => p.working?.waiting === true, "限速了在等");
    expect(waiting.backfill).toMatchObject({ from: "2026-09-25", to: "2026-10-24", next: "2026-10-24", doneDays: 0, totalDays: 30, state: "running" });
    expect(waiting.working).toMatchObject({ kind: "backfill", day: "2026-10-24" });
    // 停下
    await archive(k, { archive: "stop" });
    const stopped = await until(k, (p) => idle(p) && p.backfill?.state === "stopped", "停下了");
    expect(stopped.backfill?.next).toBe("2026-10-24");
    // 接着补：从停下的那天往回，补完
    fake.mode = "ok";
    await archive(k, { archive: "resume" });
    const done = await until(k, (p) => idle(p) && p.backfill?.state === "done", "补完");
    // 四张照片、日记.md 里一段；vlog 默认不勾：视频不下、它那一条也不写进 日记.md
    expect(done.backfill).toMatchObject({ doneDays: 30, totalDays: 30, files: 5 });
    expect(done.backfill?.next).toBeUndefined();
    const asked = daysAsked(fake);
    expect(asked[0]).toBe("2026-10-24");
    expect(asked.at(-1)).toBe("2026-09-25");
    expect(listAll(home)).toContain("2026-09/2026-09-26/10.00 爬山/10.30.00-pold.jpg");
    expect(done.saved).toMatchObject({ photos: 4, journals: 1, vlogs: 0 });
    expect(fake.downloads).not.toContain("vf-1");
    // 补完了再接着补：没有要补的
    await archive(k, { archive: "resume" });
    expect(panel(k).refused).toContain("没有要停下或者接着补的");
  });

  it("停用插件、断开时正在补的停下（已暂停），存下的不删", async () => {
    const { fake, k, home } = await setup();
    script(fake);
    await connect(k);
    await sync(k);
    await until(k, (p) => idle(p) && p.saved.photos === 3, "同步后存完");
    fake.mode = "rate_limited";
    await archive(k, { archive: "backfill", from: "2026-10-01", to: "2026-10-10" });
    await until(k, (p) => p.working?.waiting === true, "在等");
    await k.dataSources.act(LOOKI_SOURCE_ID, { action: "disconnect", purge: false, idempotencyKey: key() });
    const paused = panel(k);
    expect(paused.backfill?.state).toBe("paused");
    expect(paused.working).toBeUndefined();
    expect(listAll(home).filter((f) => f.endsWith(".jpg"))).toHaveLength(3);
    // 重连后接着补
    fake.mode = "ok";
    await connect(k);
    await archive(k, { archive: "resume" });
    await until(k, (p) => idle(p) && p.backfill?.state === "done", "接着补完");
    // 停用插件时正在补的也停下
    fake.mode = "rate_limited";
    await archive(k, { archive: "backfill", from: "2026-09-01", to: "2026-09-05" });
    await until(k, (p) => p.working?.waiting === true, "又在等");
    await k.settings.act(LOOKI_PLUGIN, { action: "disable", idempotencyKey: key() });
    expect(view(k).available).toBe(false);
    const state = JSON.parse(fs.readFileSync(path.join(k.dir, "looki-archive", "state.json"), "utf8")) as { backfill: { state: string } };
    expect(state.backfill.state).toBe("paused");
  });
});

/** 问过 /journals 的参数（同步自己的、存到本地列 vlog 的都在里面） */
const journalAsks = (fake: FakeLooki) => fake.keyed().filter((r) => r.path === "/api/v1/journals").map((r) => r.query);

describe("vlog 从 /journals 取（424：/for_you/items 停用了）", () => {

  it("日记里的 DAILY_VLOG：视频存下来，封面不下；再同步不重复存；老接口一次都不调", async () => {
    const { fake, k, home } = await setup();
    script(fake);
    const vlogBytes = fake.vlogs[0]!.file.bytes;
    await connect(k);
    await vlogsOn(k);
    await sync(k);
    const p = await until(k, (q) => idle(q) && q.saved.vlogs === 1 && q.saved.photos === 3, "存下 vlog");
    expect(p.problem).toBeUndefined();
    expect(fs.readFileSync(path.join(home, "2026-10", "2026-10-24", "vlog 周六.mp4")).equals(vlogBytes)).toBe(true);
    expect(fs.readFileSync(path.join(home, "2026-10", "2026-10-24", "说明.txt"), "utf8")).toContain("vlog：vlog 周六.mp4");
    expect(fake.downloads.filter((id) => id === "vf-1")).toHaveLength(1);
    expect(fake.downloads.some((id) => id.endsWith("-cover"))).toBe(false);
    // 列 vlog：从同步范围最后一天的后一天往前要，多要一天（cursor_date 含不含那一天都不漏）
    expect(journalAsks(fake)).toContainEqual({ cursor_date: "2026-10-25", max_days: "8", sort_order: "desc" });
    // 再同步：不重下
    await sync(k);
    await until(k, idle, "再同步一次存完");
    await new Promise((resolve) => setTimeout(resolve, 50));
    await until(k, idle, "再同步一次存完");
    expect(fake.downloads.filter((id) => id === "vf-1")).toHaveLength(1);
    expect(panel(k).saved.vlogs).toBe(1);
    expect(fake.requests.some((r) => r.path === "/api/v1/for_you/items")).toBe(false);
  });

  it("vlog 的下载链接过期了：重新列一次那天的日记、拿新链接再下", async () => {
    const { fake, k, home } = await setup();
    script(fake);
    fake.expireOnce.add("vf-1");
    await connect(k);
    await vlogsOn(k);
    await sync(k);
    await until(k, (q) => idle(q) && q.saved.vlogs === 1, "重新取链接后存下");
    expect(fake.downloads.filter((id) => id === "vf-1")).toHaveLength(1);
    expect(fs.existsSync(path.join(home, "2026-10", "2026-10-24", "vlog 周六.mp4"))).toBe(true);
    expect(k.logs.some((line) => line.includes("vlog v-1 的下载链接过期了，重新取一次"))).toBe(true);
    expect(journalAsks(fake)).toContainEqual({ cursor_date: "2026-10-25", max_days: "2", sort_order: "desc" });
  });

  it("空列表：什么都不存、不报错；翻页：一页只给两天也一页页翻到范围最前头", async () => {
    const empty = await setup();
    await connect(empty.k);
    await vlogsOn(empty.k);
    await sync(empty.k);
    await until(empty.k, idle, "空的也做完");
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(panel(empty.k)).toMatchObject({ saved: { vlogs: 0 }, pending: 0 });
    expect(panel(empty.k).problem).toBeUndefined();
    expect(journalAsks(empty.fake).length).toBeGreaterThan(0);

    const { fake, k, home } = await setup();
    fake.journalsPageDays = 2;
    fake.vlogs.push({ id: "v-24", type: "DAILY_VLOG", title: "周六", description: "高光", recorded_date: "2026-10-24", created_at: "2026-10-25T01:00:00+08:00", file: fakeVideo("vf-24", "2026-10-25T01:00:00+08:00") });
    fake.vlogs.push({ id: "v-19", type: "DAILY_VLOG", title: "周一", description: "高光", recorded_date: "2026-10-19", created_at: "2026-10-20T01:00:00+08:00", file: fakeVideo("vf-19", "2026-10-20T01:00:00+08:00") });
    // 范围外的（10-16）不要
    fake.vlogs.push({ id: "v-16", type: "DAILY_VLOG", title: "周五", description: "高光", recorded_date: "2026-10-16", created_at: "2026-10-17T01:00:00+08:00", file: fakeVideo("vf-16", "2026-10-17T01:00:00+08:00") });
    await connect(k);
    await vlogsOn(k);
    await sync(k);
    await until(k, (q) => idle(q) && q.saved.vlogs === 2, "两个 vlog 都存下");
    expect(listAll(home).filter((f) => f.endsWith(".mp4")).toSorted()).toEqual(["2026-10/2026-10-19/vlog 周一.mp4", "2026-10/2026-10-24/vlog 周六.mp4"]);
    expect(fake.downloads).not.toContain("vf-16");
    // 第一页从 10-25 起，之后照 next_cursor_id 往前翻，翻过 10-18（范围最前头）就停
    const cursors = journalAsks(fake).filter((q) => q.max_days === "8").map((q) => q.cursor_date);
    expect(cursors).toEqual(["2026-10-25", "2026-10-23", "2026-10-21", "2026-10-19"]);
  });

  it("以前从 for_you 存下的 vlog：标题一样、或那天只有一个旧的也只来一个新的，认成同一个，不重下、文件不动", async () => {
    const { fake, k, home } = await setup();
    // 以前存下的两个（索引里没标 api）：10-24 "周六"、10-23 "周五"
    const old24 = path.join(home, "2026-10", "2026-10-24", "vlog 周六.mp4");
    const old23 = path.join(home, "2026-10", "2026-10-23", "vlog 周五.mp4");
    for (const [file, text] of [
      [old24, "old-vlog-24"],
      [old23, "old-vlog-23"],
    ] as const) {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, text);
    }
    const days = path.join(k.dir, "looki-archive", "days");
    fs.mkdirSync(days, { recursive: true });
    const legacy = (date: string, id: string, title: string, size: number) =>
      fs.writeFileSync(path.join(days, `${date}.json`), JSON.stringify({ format: 1, date, moments: {}, journals: {}, vlogs: { [id]: { path: `2026-10/${date}/vlog ${title}.mp4`, size, title } } }));
    legacy("2026-10-24", "fy-24", "周六", 11);
    legacy("2026-10-23", "fy-23", "周五", 11);
    // 换到 /journals 后 id 都变了；10-23 的标题也变了；10-22 是新的
    fake.vlogs.push({ id: "j-v24", type: "DAILY_VLOG", title: "周六", description: "高光", recorded_date: "2026-10-24", created_at: "2026-10-25T01:00:00+08:00", file: fakeVideo("vf-24", "2026-10-25T01:00:00+08:00") });
    fake.vlogs.push({ id: "j-v23", type: "DAILY_VLOG", title: "忙碌的周五", description: "高光", recorded_date: "2026-10-23", created_at: "2026-10-24T01:00:00+08:00", file: fakeVideo("vf-23", "2026-10-24T01:00:00+08:00") });
    fake.vlogs.push({ id: "j-v22", type: "DAILY_VLOG", title: "周四", description: "高光", recorded_date: "2026-10-22", created_at: "2026-10-23T01:00:00+08:00", file: fakeVideo("vf-22", "2026-10-23T01:00:00+08:00") });
    await connect(k);
    await vlogsOn(k);
    await sync(k);
    await until(k, (q) => idle(q) && q.saved.vlogs === 3, "三个都在");
    expect(fake.downloads).toEqual(["vf-22"]);
    expect(fs.readFileSync(old24, "utf8")).toBe("old-vlog-24");
    expect(fs.readFileSync(old23, "utf8")).toBe("old-vlog-23");
    expect(listAll(home).filter((f) => f.endsWith(".mp4")).toSorted()).toEqual(["2026-10/2026-10-22/vlog 周四.mp4", "2026-10/2026-10-23/vlog 周五.mp4", "2026-10/2026-10-24/vlog 周六.mp4"]);
    const index = JSON.parse(fs.readFileSync(path.join(days, "2026-10-23.json"), "utf8")) as { vlogs: Record<string, { path: string; api?: string }> };
    expect(index.vlogs).toEqual({ "j-v23": { path: "2026-10/2026-10-23/vlog 周五.mp4", size: 11, title: "周五", api: "journals" } });
    // 再同步：照样不下
    await sync(k);
    await until(k, idle, "再同步一次");
    await new Promise((resolve) => setTimeout(resolve, 50));
    await until(k, idle, "再同步一次");
    expect(fake.downloads).toEqual(["vf-22"]);
    expect(panel(k).saved.vlogs).toBe(3);
  });

  it("Looki 回\"接口停用了\"（400、code 105）：那一块写明 Looki 换了接口（原话带上），照片、日记照常；好了清掉", async () => {
    const { fake, k } = await setup();
    script(fake);
    fake.journalsRetired = true;
    await connect(k);
    await vlogsOn(k);
    await sync(k);
    const p = await until(k, (q) => idle(q) && q.saved.photos === 3 && q.problem !== undefined, "写明换了接口");
    expect(p.problem).toContain("vlog 没存");
    expect(p.problem).toContain("Looki 换了接口");
    expect(p.problem).toContain("This endpoint is deprecated");
    expect(p.saved.vlogs).toBe(0);
    expect(k.logs.some((line) => line.includes("vlog 没列出来"))).toBe(true);
    fake.journalsRetired = false;
    await sync(k);
    const fixed = await until(k, (q) => idle(q) && q.saved.vlogs === 1, "接口好了存下 vlog");
    expect(fixed.problem).toBeUndefined();
  });

  it("vlog 不勾（默认）：整条不要——不下视频、不当日记导入、不写进 日记.md、说明.txt 不列；勾上以后下次同步都有", async () => {
    const { fake, k, home } = await setup();
    script(fake);
    fake.vlogs[0] = { ...fake.vlogs[0]!, title: "周六的高光", description: "一天的剪辑" };
    await connect(k);
    expect(panel(k).kinds.vlogs).toBe(false);
    expect(await sync(k)).toMatchObject({ added: 3 });
    await until(k, (q) => idle(q) && q.saved.photos === 3, "照片存完");
    const imported = () => k.store.read(LOOKI_CHANNEL, 0, LOOKI_JOURNAL).map((e) => (e.payload as { journalId: string }).journalId);
    expect(imported()).toEqual(["j-1"]);
    const journalFile = path.join(home, "2026-10", "2026-10-24", "日记.md");
    const readme = path.join(home, "2026-10", "2026-10-24", "说明.txt");
    expect(fs.readFileSync(journalFile, "utf8")).not.toContain("周六的高光");
    expect(fs.readFileSync(readme, "utf8")).not.toMatch(/周六的高光|vlog：/);
    expect(panel(k).saved).toMatchObject({ vlogs: 0, journals: 1 });
    expect(fake.downloads).not.toContain("vf-1");
    // 不勾时存到本地这边连 vlog 都不去列（列 vlog 的那种请求从同步范围后一天起）
    expect(journalAsks(fake).some((q) => q.cursor_date === "2026-10-25")).toBe(false);

    // 勾上：下次同步存视频，那一条也当日记导入、写进 日记.md、说明.txt 列上
    await vlogsOn(k);
    expect(await sync(k)).toMatchObject({ added: 1 });
    await until(k, (q) => idle(q) && q.saved.vlogs === 1, "勾上后存下 vlog");
    expect(imported()).toEqual(["j-1", "v-1"]);
    expect(fs.readFileSync(journalFile, "utf8")).toContain("周六的高光");
    expect(fs.readFileSync(readme, "utf8")).toContain("vlog：vlog 周六的高光.mp4");
    expect(panel(k).saved).toMatchObject({ vlogs: 1, journals: 2 });
  });

  it("设置里没写 vlog 这一项（改成默认不勾以前就在用的）按不勾算；写了 true 的照旧勾着", () => {
    const dir = makeTempDir("ergo-looki-settings-");
    const settingsFile = path.join(dir, "looki-archive.json");
    const store = () => createArchiveStore({ settingsFile, stateDir: path.join(dir, "state"), log: () => {} });
    expect(store().settings().kinds).toEqual({ photos: true, journals: true, vlogs: false, clips: false });
    fs.writeFileSync(settingsFile, JSON.stringify({ format: 1, on: true, kinds: { photos: true, journals: true, clips: false } }));
    expect(store().settings().kinds.vlogs).toBe(false);
    fs.writeFileSync(settingsFile, JSON.stringify({ format: 1, on: true, kinds: { photos: true, journals: true, vlogs: true, clips: false } }));
    expect(store().settings().kinds.vlogs).toBe(true);
  });

  it("客户端：400 / 410 / 包里 code 105 说接口停用了的，认成 retired（种类仍是回的不对），原因写 Looki 换了接口", async () => {
    const fake = await startFakeLooki();
    fake.journalsRetired = true;
    const client = createLookiClient({ base: fake.base, key: LOOKI_TEST_KEY });
    const err = await client.journalPage("2026-10-25", 2).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(LookiError);
    expect(err).toMatchObject({ failure: "response", retired: true });
    expect((err as LookiError).message).toBe("Looki 换了接口：这个接口停用了（HTTP 400：This endpoint is deprecated. Please use GET /journals/v2 instead.）");
    // 别的 4xx 照旧是"没接这个请求"
    fake.journalsRetired = false;
    fake.journalsRejected = true;
    const other = await client.journalPage("2026-10-25", 2).catch((e: unknown) => e);
    expect(other).toMatchObject({ failure: "response", retired: false });
    expect((other as LookiError).message).toContain("Looki 没接这个请求（HTTP 422）");
  });
});
