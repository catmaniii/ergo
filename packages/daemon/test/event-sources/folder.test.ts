// 本机文件夹变化（77 号票）：用真的 fs.watch 监视测试建的临时目录，计时器用手动拨的钟——
// 连续变化合成一次、整个子文件夹没了按里面每个文件算、文件名模式、比对底子和开机补发（去重键按看出的先后编号，推出去了没存上底子的再比出来编号一样）、
// 不许监视的地方（大小写、尾斜杠、相对写法、UNC 和设备路径、目录联接都绕不过去；子文件夹里的目录联接不跟进）、
// 文件夹看不到时不报删除、隔一会儿再看（开机时暂时不在、删了又建都接着监视）。
import fs from "node:fs";
import path from "node:path";
import { type EventTrigger } from "@ergou/protocol";
import { describe, expect, it } from "vitest";
import { createFolderSource, type EventSubscription, type SourceEvent } from "../../src/event-sources/index.ts";
import { realPathOf } from "../../src/util/real-path.ts";
import { ManualClock } from "../helpers/clock.ts";
import { waitUntil } from "../helpers/process.ts";
import { makeTempDir } from "../helpers/temp-dir.ts";

const SETTLE = 300;
const RETRY = 5_000;
const folderOf = (prefix: string) => realPathOf(makeTempDir(prefix))!;

function subscription(folder: string, events: string[], extra: Record<string, string | boolean> = {}): EventSubscription {
  const trigger: EventTrigger = { kind: "event", source: "folder", events, filter: { path: folder, ...extra } };
  return { id: "j-1", kind: "task", trigger, taskId: "t-1", active: true };
}

function harness(stateDir: string, forbidden: { dir: string; title: string }[] = []) {
  const clock = new ManualClock(new Date(2026, 9, 8, 9, 0));
  const emitted: SourceEvent[] = [];
  const logs: string[] = [];
  const source = createFolderSource({ ctx: { emit: (_sub, e) => emitted.push(e), log: (l) => logs.push(l) }, clock, stateDir, forbidden: () => forbidden, settleMs: SETTLE, retryMs: RETRY });
  /** 等 fs.watch 报上来 n 处变化，再拨时钟让它们安静 */
  const settle = async (n = 1) => {
    await waitUntil(() => (source.pending?.() ?? 0) >= n, { timeoutMs: 20_000, describe: () => `等看到 ${n} 处变化（现在 ${source.pending?.()}）` });
    clock.advance(SETTLE + 1);
  };
  return { clock, emitted, logs, source, settle };
}

describe("合成一次", () => {
  it("第一次监视只记下现在的样子；同一个文件连写几次只算一次新增，再改一次算一次修改；对不上模式的不推", async () => {
    const folder = folderOf("ergou-folder-");
    fs.writeFileSync(path.join(folder, "原来就有.txt"), "旧");
    const stateDir = makeTempDir("ergou-state-");
    const h = harness(stateDir);
    h.source.sync([subscription(folder, ["added", "changed", "removed"], { pattern: "*.txt" })]);
    expect(h.emitted).toEqual([]);

    const file = path.join(folder, "新的.txt");
    for (let i = 0; i < 5; i++) fs.appendFileSync(file, `第 ${i} 行\n`);
    fs.writeFileSync(path.join(folder, "图.png"), "png");
    await h.settle(2);
    expect(h.emitted.map((e) => [e.event, e.data?.name, e.key])).toEqual([["added", "新的.txt", "folder:1:added:新的.txt"]]);
    expect(h.emitted[0]).toMatchObject({ source: "folder", summary: `新增文件 新的.txt（${folder}）`, data: { path: file, relativePath: "新的.txt", folder, change: "新增", size: 50 } });

    fs.appendFileSync(file, "再加一行\n");
    await h.settle();
    expect(h.emitted.map((e) => [e.event, e.data?.name])).toEqual([
      ["added", "新的.txt"],
      ["changed", "新的.txt"],
    ]);
    h.source.stop();
  }, 60_000);

  it("含子文件夹：子文件夹里的变化也算；整个子文件夹删掉，按里面每个文件各算一次删除", async () => {
    const folder = folderOf("ergou-folder-deep-");
    const sub = path.join(folder, "子");
    fs.mkdirSync(sub);
    fs.writeFileSync(path.join(sub, "a.txt"), "a");
    fs.writeFileSync(path.join(sub, "b.txt"), "b");
    const h = harness(makeTempDir("ergou-state-"));
    h.source.sync([subscription(folder, ["added", "removed"], { recursive: true })]);

    fs.writeFileSync(path.join(sub, "c.txt"), "c");
    await h.settle();
    expect(h.emitted.map((e) => [e.event, e.data?.relativePath])).toEqual([["added", path.join("子", "c.txt")]]);

    fs.rmSync(sub, { recursive: true });
    await h.settle();
    expect(
      h.emitted
        .slice(1)
        .map((e) => [e.event, e.data?.relativePath])
        .toSorted(),
    ).toEqual([
      ["removed", path.join("子", "a.txt")],
      ["removed", path.join("子", "b.txt")],
      ["removed", path.join("子", "c.txt")],
    ]);
    h.source.stop();
  }, 60_000);
});

describe("比对底子和开机补发", () => {
  it("停掉之后的变化，再开始监视时比一遍补发；推出去了、底子没存上的，再比出来编号一样（只收一次）；删了又放进来的是新的编号", async () => {
    const folder = folderOf("ergou-folder-restart-");
    const stateDir = makeTempDir("ergou-state-");
    const first = harness(stateDir);
    first.source.sync([subscription(folder, ["added", "removed"])]);
    first.source.stop();

    fs.writeFileSync(path.join(folder, "停机时来的.txt"), "x");
    const baseline = fs.readFileSync(path.join(stateDir, "folders", "j-1.json"), "utf8");
    const second = harness(stateDir);
    second.source.sync([subscription(folder, ["added", "removed"])]);
    expect(second.emitted.map((e) => [e.event, e.data?.name, e.key])).toEqual([["added", "停机时来的.txt", "folder:1:added:停机时来的.txt"]]);
    expect(second.logs.some((l) => l.includes("停机期间有 1 处变化"))).toBe(true);
    second.source.stop();

    // 推出去了、底子没存上就停了机：再比一遍，编号一样（交出去时按它去重）
    fs.writeFileSync(path.join(stateDir, "folders", "j-1.json"), baseline);
    const third = harness(stateDir);
    third.source.sync([subscription(folder, ["added", "removed"])]);
    expect(third.emitted.map((e) => e.key)).toEqual(["folder:1:added:停机时来的.txt"]);

    // 删了又放进来（内容、修改时间都一样）：照样是两处新的变化
    const again = path.join(folder, "停机时来的.txt");
    const stat = fs.statSync(again);
    fs.rmSync(again);
    await third.settle();
    fs.writeFileSync(again, "x");
    fs.utimesSync(again, stat.atime, stat.mtime);
    await third.settle();
    expect(third.emitted.map((e) => e.key)).toEqual(["folder:1:added:停机时来的.txt", "folder:2:removed:停机时来的.txt", "folder:3:added:停机时来的.txt"]);
    third.source.stop();

    // 不要了的订阅：停掉，底子删掉
    const fourth = harness(stateDir);
    fourth.source.sync([subscription(folder, ["added"])]);
    fourth.source.sync([]);
    expect(fs.existsSync(path.join(stateDir, "folders", "j-1.json"))).toBe(false);
  }, 60_000);
});

describe("不许监视的地方", () => {
  it("在不能监视的地方里面的不行；含子文件夹时里面有的也不行；要完整路径、要在、要是文件夹", () => {
    const parent = folderOf("ergou-forbid-");
    const data = path.join(parent, "data");
    const secrets = path.join(data, "secrets");
    fs.mkdirSync(secrets, { recursive: true });
    const file = path.join(parent, "一个文件.txt");
    fs.writeFileSync(file, "x");
    const h = harness(makeTempDir("ergou-state-"), [
      { dir: secrets, title: "数据目录的密钥区" },
      { dir: data, title: "二狗的数据目录" },
    ]);
    const check = (folder: string, extra: Record<string, string | boolean> = {}) => h.source.check(subscription(folder, ["added"], extra).trigger);
    expect(check(secrets)).toEqual([`不能监视 ${secrets}：它在数据目录的密钥区里（二狗的数据目录、密钥区、受保护区域不能监视）`]);
    expect(check(data)[0]).toContain("它在二狗的数据目录里");
    expect(check(parent, { recursive: true })[0]).toContain(`不能含子文件夹监视 ${parent}：它里面有二狗的数据目录`);
    expect(check(parent)).toEqual([]);
    expect(check("相对的")[0]).toContain("文件夹要写完整路径");
    expect(check(path.join("..", "相对的"))[0]).toContain("文件夹要写完整路径");
    expect(check(path.join(parent, "没有"))[0]).toContain("文件夹不在");
    expect(check(file)[0]).toContain("这不是文件夹");
  });

  it("换个写法绕不过去：大小写不同、尾斜杠、绕一圈的写法、UNC 和设备路径、目录联接指进去的", () => {
    const parent = folderOf("ergou-forbid-bypass-");
    const data = path.join(parent, "Data");
    const secrets = path.join(data, "Secrets");
    fs.mkdirSync(secrets, { recursive: true });
    const h = harness(makeTempDir("ergou-state-"), [
      { dir: secrets, title: "数据目录的密钥区" },
      { dir: data, title: "二狗的数据目录" },
    ]);
    const check = (folder: string, extra: Record<string, string | boolean> = {}) => h.source.check(subscription(folder, ["added"], extra).trigger);
    // 大小写不同、尾斜杠、绕一圈的写法
    expect(check(secrets.toUpperCase())[0]).toContain("它在数据目录的密钥区里");
    expect(check(secrets.toLowerCase())[0]).toContain("它在数据目录的密钥区里");
    expect(check(`${secrets}\\`)[0]).toContain("它在数据目录的密钥区里");
    expect(check(`${parent}\\Data\\..\\Data\\Secrets\\`)[0]).toContain("它在数据目录的密钥区里");
    // UNC（\\localhost\C$\…）、设备路径（\\?\C:\…）：只能监视本机盘上的文件夹
    const drive = secrets.slice(0, 1);
    expect(check(`\\\\localhost\\${drive}$${secrets.slice(2)}`)[0]).toContain("只能监视本机盘上的文件夹");
    expect(check(`\\\\127.0.0.1\\${drive}$${data.slice(2)}`, { recursive: true })[0]).toContain("只能监视本机盘上的文件夹");
    expect(check(`\\\\?\\${secrets}`)[0]).toContain("只能监视本机盘上的文件夹");
    expect(check(`//localhost/${drive}$${secrets.slice(2).replaceAll("\\", "/")}`)[0]).toContain("只能监视本机盘上的文件夹");
    // 目录联接：外面一个联接指到密钥区（真实路径、目录的身份都在里面）
    const outside = folderOf("ergou-forbid-link-");
    const link = path.join(outside, "看着像普通文件夹");
    fs.symlinkSync(secrets, link, "junction");
    expect(check(link)[0]).toContain("它在数据目录的密钥区里");
    // 联接指到数据目录的上一级：含子文件夹时里面有数据目录；不含子文件夹的可以
    const up = path.join(outside, "上一级");
    fs.symlinkSync(parent, up, "junction");
    expect(check(up, { recursive: true })[0]).toContain("它里面有二狗的数据目录");
    expect(check(up)).toEqual([]);
  });

  it("子文件夹里的目录联接不跟进：联接指到不许监视的地方，里面的文件不报", async () => {
    const parent = folderOf("ergou-forbid-inner-");
    const data = path.join(parent, "data");
    fs.mkdirSync(data);
    fs.writeFileSync(path.join(data, "密钥.json"), "{}");
    const watched = path.join(parent, "watched");
    fs.mkdirSync(watched);
    const h = harness(makeTempDir("ergou-state-"), [{ dir: data, title: "二狗的数据目录" }]);
    h.source.sync([subscription(watched, ["added", "changed", "removed"], { recursive: true })]);
    // 监视开始之后放进一个联接（fs.watch 报它新增了一项）：联接本身不算文件，也不顺着它扫进数据目录
    fs.symlinkSync(data, path.join(watched, "联接"), "junction");
    fs.writeFileSync(path.join(watched, "正常.txt"), "x");
    await h.settle(2);
    expect(h.emitted.map((e) => e.data?.relativePath)).toEqual(["正常.txt"]);
    // 数据目录里又多了文件：不报；监视的文件夹里的照常报
    fs.writeFileSync(path.join(data, "又一个.json"), "{}");
    fs.writeFileSync(path.join(watched, "再一个.txt"), "y");
    await h.settle();
    expect(h.emitted.map((e) => e.data?.relativePath)).toEqual(["正常.txt", "再一个.txt"]);
    // 重新开始监视（整个扫一遍记下底子）：联接照样不跟进，底子里只有监视的文件夹里的两个文件
    h.source.stop();
    const stateDir = makeTempDir("ergou-state-");
    const again = harness(stateDir, [{ dir: data, title: "二狗的数据目录" }]);
    again.source.sync([subscription(watched, ["added"], { recursive: true })]);
    const baseline = JSON.parse(fs.readFileSync(path.join(stateDir, "folders", "j-1.json"), "utf8")) as { files: Record<string, unknown> };
    expect(Object.keys(baseline.files).toSorted()).toEqual(["再一个.txt", "正常.txt"]);
    again.source.stop();
  }, 60_000);
});

describe("看不到时接着监视", () => {
  it("开机时文件夹暂时不在：不报删除，隔一会儿再看；回来了（文件一样）不报，之后的变化照常报", async () => {
    const parent = folderOf("ergou-folder-away-");
    const folder = path.join(parent, "收件箱");
    fs.mkdirSync(folder);
    fs.writeFileSync(path.join(folder, "旧的.txt"), "x");
    const stateDir = makeTempDir("ergou-state-");
    const first = harness(stateDir);
    first.source.sync([subscription(folder, ["added", "removed"])]);
    first.source.stop();

    // 守护进程停着时文件夹被挪走（比如移动硬盘没插）
    const away = path.join(parent, "挪走了");
    fs.renameSync(folder, away);
    const h = harness(stateDir);
    h.source.sync([subscription(folder, ["added", "removed"])]);
    expect(h.emitted).toEqual([]);
    expect(h.logs.some((l) => l.includes("现在看不到（文件夹不在）") && l.includes("不算删除"))).toBe(true);
    h.clock.advance(RETRY + 1);
    expect(h.emitted).toEqual([]);

    // 挪回来：和底子比没变化；之后放进的文件照常报
    fs.renameSync(away, folder);
    h.clock.advance(RETRY + 1);
    expect(h.logs.some((l) => l.includes("又能看到了"))).toBe(true);
    expect(h.emitted).toEqual([]);
    fs.writeFileSync(path.join(folder, "新的.txt"), "y");
    await h.settle();
    expect(h.emitted.map((e) => [e.event, e.data?.name])).toEqual([["added", "新的.txt"]]);
    h.source.stop();
  }, 60_000);

  it("监视着的文件夹删掉了：不报成全部删除；重新建出来接着监视，和底子比一遍补上真的变化", async () => {
    const parent = folderOf("ergou-folder-gone-");
    const folder = path.join(parent, "收件箱");
    fs.mkdirSync(folder);
    fs.writeFileSync(path.join(folder, "a.txt"), "a");
    fs.writeFileSync(path.join(folder, "b.txt"), "b");
    const h = harness(makeTempDir("ergou-state-"));
    h.source.sync([subscription(folder, ["added", "removed"])]);

    fs.rmSync(folder, { recursive: true, force: true });
    // fs.watch 报出错、或者报了变化而看的时候文件夹已经不在：都算看不到，不报删除
    await waitUntil(
      () => {
        h.clock.advance(SETTLE + 1);
        return h.logs.some((l) => l.includes("现在看不到"));
      },
      { timeoutMs: 20_000, describe: () => `等看不到的日志（${h.logs.join(" / ")}）` },
    );
    expect(h.emitted).toEqual([]);

    // 重新建出来：a.txt 放回去了、b.txt 没了、多了 c.txt
    fs.mkdirSync(folder);
    fs.writeFileSync(path.join(folder, "a.txt"), "a");
    fs.writeFileSync(path.join(folder, "c.txt"), "c");
    h.clock.advance(RETRY + 1);
    expect(h.logs.some((l) => l.includes("又能看到了"))).toBe(true);
    expect(
      h.emitted
        .filter((e) => e.data?.name !== "a.txt")
        .map((e) => [e.event, e.data?.name])
        .toSorted(),
    ).toEqual([
      ["added", "c.txt"],
      ["removed", "b.txt"],
    ]);
    // 之后照常监视
    fs.writeFileSync(path.join(folder, "d.txt"), "d");
    await h.settle();
    expect(h.emitted.at(-1)).toMatchObject({ event: "added", data: { name: "d.txt" } });
    h.source.stop();
  }, 60_000);
});
