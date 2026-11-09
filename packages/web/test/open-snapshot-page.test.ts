// 打开页面不再把全部历史过一遍（388）：照 vite.config.ts 构建安装版，由假守护进程（test/open-snapshot/fake-daemon.ts，127.0.0.1 上
// 系统挑的端口）提供页面和 /ws，补发一份照用户那台二狗的量级编的事件日志（一万多条、十来 MB），在真的 Chrome 里打开：
// - 冷打开（本机没快照）：一万多条补发攒着一次交，补发在路上时界面不画中间状态（React 的提交次数，挂开发者工具的钩子数）；
// - 热打开（本机有快照）：先用快照把界面画出来（补发还没到时就看得到上次的内容），订阅带快照的游标，只补增量；
// - 网页升级后第一次打开不用旧快照，用本机存的事件重新折一遍（452）：订阅只带会话频道以外的游标，守护进程只补增量（加秘书会话最近一页），
//   补完存下的快照和一台新设备冷打开存下的一样；
// - 设备被吊销、回到配对页时本机快照和事件都删掉；
// - 冷补发只发最新的（456）：守护进程补合并后的，新设备冷打开、换了一版再打开存下的快照和守护进程全补时的一模一样，本机存的是合并后的。
// 不碰真的守护进程、~/.ergo、固定端口。本机没有 Chrome（或 Edge）时跳过。
import { type Browser, chromium, type Page } from "playwright-core";
import { build, type Rolldown } from "vite";
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import { fileURLToPath } from "node:url";
import { findChrome } from "../build/chrome.ts";
import { compactChannel, keepsOpenEvents } from "../src/state/index.ts";
import { type FakeDaemon, startFakeDaemon } from "./open-snapshot/fake-daemon.ts";
import { MEASURE_SCRIPT, storedEventCounts, storedSnapshot, storedSnapshotFull, waitOpened, waitStored } from "./open-snapshot/measure.ts";
import { type SyntheticLog, syntheticIncrement, syntheticLog, USER_SCALE } from "./open-snapshot/synthetic.ts";

const CHROME = findChrome();
const WEB_ROOT = fileURLToPath(new URL("..", import.meta.url));

let html = "";
let browser: Browser | undefined;
const daemons: FakeDaemon[] = [];

beforeAll(async () => {
  if (!CHROME) return;
  // 和 npm run build:web 一样按生产环境构建（vitest 把 NODE_ENV 设成了 test）
  vi.stubEnv("NODE_ENV", "production");
  try {
    const result = await build({ root: WEB_ROOT, configFile: `${WEB_ROOT}/vite.config.ts`, logLevel: "silent", build: { write: false } });
    const outputs = (Array.isArray(result) ? result : [result]) as Rolldown.RolldownOutput[];
    const page = outputs.flatMap((o) => o.output).find((f) => f.fileName === "index.html");
    if (page?.type !== "asset") throw new Error("构建产物里没有 index.html");
    html = String(page.source);
  } finally {
    vi.unstubAllEnvs();
  }
  browser = await chromium.launch({ executablePath: CHROME });
}, 300_000);

afterAll(async () => {
  await browser?.close();
  for (const d of daemons) await d.close();
});

async function open(log: SyntheticLog, existing?: FakeDaemon, options: { compact?: boolean } = {}): Promise<{ daemon: FakeDaemon; page: Page; errors: string[] }> {
  const daemon = existing ?? (await startFakeDaemon(html, log, undefined, options));
  if (!existing) daemons.push(daemon);
  const context = await browser!.newContext({ viewport: { width: 390, height: 844 } });
  const page = await context.newPage();
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  await page.addInitScript(MEASURE_SCRIPT);
  return { daemon, page, errors };
}

/** 秘书会话里第 no 轮用户说的那句（synthetic.ts 的 secretaryTurn）：等它画出来 */
const shown = (page: Page, no: number, timeout = 10_000) => page.getByText(`合成的第 ${no} 句话`, { exact: true }).waitFor({ state: "visible", timeout });

describe.skipIf(!CHROME)("打开页面：补发攒着一次放、本机快照只补增量（388）", () => {
  test("冷打开一次交、不画中间状态；热打开先画上次的样子、只补增量", async () => {
    const log = syntheticLog();
    // 守护进程不合并（456 之前）：一万多帧的冷补发照样攒着一次交
    const { daemon, page, errors } = await open(log, undefined, { compact: false });
    await page.goto(daemon.url);
    const cold = await waitOpened(page);
    const coldConn = daemon.connections.at(-1)!;
    expect(coldConn.frames).toBeGreaterThan(10_000);
    expect(cold.frames).toBe(coldConn.frames);
    // 改之前一万多帧要画几十上百遍（每收几帧画一遍）；现在补发在路上时最多是连上、"正在同步"这一两下，补完一次画好
    expect(cold.commitsWhileCatchingUp).toBeLessThanOrEqual(3);
    expect(cold.commits).toBeLessThanOrEqual(20);
    const lastTurn = USER_SCALE.secretaryMessages / 2;
    await shown(page, lastTurn);

    // 存下来的快照：各频道游标是收到的最后一条，秘书会话只留最近一页
    const cursors = Object.fromEntries([...log.channels.keys()].map((c) => [c, log.lastSeq(c)]));
    const stored = await waitStored(page, cursors);
    expect(stored.conversations.secretary!.messages).toHaveLength(50);

    // 关掉期间又发生了一点事；补发先压着 1.5 秒：这时候界面已经是上次的样子
    const base = log.lastSeq("secretary");
    const added = syntheticIncrement(log, 3);
    daemon.holdReplay(1500);
    await page.reload();
    await shown(page, lastTurn, 1200);
    expect(daemon.connections.at(-1)!.frames).toBe(0);
    daemon.holdReplay(0);
    const hot = await waitOpened(page);
    const hotConn = daemon.connections.at(-1)!;
    expect(hotConn.cursors).toMatchObject(cursors);
    expect(hotConn.frames).toBe(added);
    expect(hot.frames).toBe(added);
    expect(hot.commitsWhileCatchingUp).toBeLessThanOrEqual(3);
    // 新的那几轮补上了
    await shown(page, 100_000 + base + 3);
    expect(errors).toEqual([]);
  }, 180_000);

  test("网页升级后再打开：快照不用，本机存的事件重新折一遍，只补增量；补完存的和新设备冷打开存的一样（452）", async () => {
    const log = syntheticLog();
    const { daemon, page, errors } = await open(log);
    await page.goto(daemon.url);
    await waitOpened(page);
    const kept = [...log.channels.keys()].filter((c) => c !== "secretary");
    const lastOf = (channels: string[]) => Object.fromEntries(channels.map((c) => [c, log.lastSeq(c)]));
    const before = await waitStored(page, lastOf(kept));
    // 会话频道以外的事件存下了：守护进程补的合并后的那些（456）
    await expect.poll(() => storedEventCounts(page), { timeout: 10_000, interval: 300 }).toEqual(mergedCounts(log, kept));

    // 关掉期间又发生了一点事；网页换了一版
    const through = lastOf(kept);
    const base = log.lastSeq("secretary");
    syntheticIncrement(log, 3);
    daemon.setWebVersion("0123456789abcdef");
    await page.reload();
    const reopened = await waitOpened(page);
    const conn = daemon.connections.at(-1)!;
    // 存了事件的频道带着游标、只补增量；秘书会话游标 0，补最近一页（50 条消息起的那一段）
    expect(conn.cursors).toEqual({ ...Object.fromEntries(Object.keys(conn.cursors!).map((c) => [c, 0])), ...through });
    expect(conn.cursors!.secretary).toBe(0);
    const keptAdded = kept.reduce((n, c) => n + log.lastSeq(c) - through[c]!, 0);
    const secretaryPage = log.channels.get("secretary")!.filter((f) => f.seq > firstPageAfter(log)).length;
    expect(conn.frames).toBe(keptAdded + secretaryPage);
    expect(reopened.frames).toBe(conn.frames);
    expect(reopened.commitsWhileCatchingUp).toBeLessThanOrEqual(3);
    await shown(page, 100_000 + base + 3);

    // 补完存下的是新版本的快照，事件接着存全了
    const all = lastOf([...log.channels.keys()]);
    await waitStored(page, all);
    const after = await storedSnapshotFull(page);
    expect(after!.webVersion).toBe("0123456789abcdef");
    expect(before.webVersion).not.toBe(after!.webVersion);
    // 增量是一条不少补来的，存的时候接着合并：存着的和这时冷补发会发的一样多
    await expect.poll(() => storedEventCounts(page), { timeout: 10_000, interval: 300 }).toEqual(mergedCounts(log, kept));

    // 一台新设备（空的浏览器）冷打开同一个守护进程：补全部，存下的快照和上面那台一模一样
    const fresh = await open(log, daemon);
    await fresh.page.goto(daemon.url);
    await waitOpened(fresh.page);
    expect(Object.values(daemon.connections.at(-1)!.cursors!).every((n) => n === 0)).toBe(true);
    await waitStored(fresh.page, all);
    const cold = await storedSnapshotFull(fresh.page);
    expect(after!.snapshot).toEqual(cold!.snapshot);
    expect(errors).toEqual([]);
    expect(fresh.errors).toEqual([]);
  }, 240_000);

  test("冷补发只发最新的（456）：新设备冷打开只收合并后的，存下的和守护进程全补时一模一样；换了一版再打开只补增量，也一样", async () => {
    const log = syntheticLog();
    const all = () => Object.fromEntries([...log.channels.keys()].map((c) => [c, log.lastSeq(c)]));
    const kept = [...log.channels.keys()].filter(keepsOpenEvents);
    // 改之前：守护进程从第一条起全补
    const plain = await open(log, undefined, { compact: false });
    await plain.page.goto(plain.daemon.url);
    const plainOpened = await waitOpened(plain.page);
    await waitStored(plain.page, all());
    const plainStored = await storedSnapshotFull(plain.page);

    // 改之后：另一台新设备，守护进程补合并后的
    const merged = await open(log);
    await merged.page.goto(merged.daemon.url);
    const mergedOpened = await waitOpened(merged.page);
    const secretaryPage = log.channels.get("secretary")!.filter((f) => f.seq > firstPageAfter(log)).length;
    const mergedFrames = kept.reduce((n, c) => n + compactChannel(log.channels.get(c)!).length, 0) + secretaryPage;
    expect(merged.daemon.connections.at(-1)!.frames).toBe(mergedFrames);
    expect(mergedOpened.frames).toBe(mergedFrames);
    expect(mergedFrames).toBeLessThan(plainOpened.frames / 5);
    await waitStored(merged.page, all());
    const mergedStored = await storedSnapshotFull(merged.page);
    expect(mergedStored!.snapshot).toEqual(plainStored!.snapshot);
    await expect.poll(() => storedEventCounts(merged.page), { timeout: 10_000, interval: 300 }).toEqual(mergedCounts(log, kept));

    // 关掉期间又发生了一点事，网页换了一版：两台都再打开（一台的守护进程全补、一台合并），只补增量，存下的还是一样
    syntheticIncrement(log, 3);
    for (const d of [plain.daemon, merged.daemon]) d.setWebVersion("0123456789abcdef");
    await plain.page.reload();
    await merged.page.reload();
    await waitOpened(plain.page);
    const reopened = await waitOpened(merged.page);
    expect(Object.entries(merged.daemon.connections.at(-1)!.cursors!).filter(([, n]) => n > 0).length).toBe(kept.length);
    expect(reopened.frames).toBeLessThan(200);
    await waitStored(plain.page, all());
    await waitStored(merged.page, all());
    expect((await storedSnapshotFull(merged.page))!.snapshot).toEqual((await storedSnapshotFull(plain.page))!.snapshot);
    await expect.poll(() => storedEventCounts(merged.page), { timeout: 10_000, interval: 300 }).toEqual(mergedCounts(log, kept));
    expect(plain.errors).toEqual([]);
    expect(merged.errors).toEqual([]);
  }, 240_000);

  test("设备被吊销、回到配对页：本机快照删掉", async () => {
    const log = syntheticLog({ ...USER_SCALE, tasks: 20, activityEvents: 50, readMarks: 20, cards: 20, inboxItems: 20, deviceEvents: 8, projectEvents: 20 });
    const { daemon, page } = await open(log);
    await page.goto(daemon.url);
    await waitOpened(page);
    await waitStored(page, { board: log.lastSeq("board") });
    await expect.poll(async () => Object.keys(await storedEventCounts(page)).length, { timeout: 10_000, interval: 300 }).toBeGreaterThan(0);
    daemon.revoke();
    await page.locator(".pair-page").waitFor({ timeout: 15_000 });
    await expect.poll(() => storedSnapshot(page), { timeout: 5000, interval: 200 }).toBeNull();
    expect(await storedEventCounts(page)).toEqual({});
    // 刷新之后还在配对页，也没有快照
    await page.reload();
    await page.locator(".pair-page").waitFor({ timeout: 15_000 });
    expect(await storedSnapshot(page)).toBeNull();
    expect(await storedEventCounts(page)).toEqual({});
  }, 180_000);
});

/** 各频道合并后留几条（守护进程这时冷补发会发的；456） */
function mergedCounts(log: SyntheticLog, channels: readonly string[]): Record<string, number> {
  return Object.fromEntries(channels.map((c) => [c, compactChannel(log.channels.get(c) ?? []).length]));
}

/** 游标为 0 时秘书会话从哪条之后补（照 fake-daemon.ts：最近一页消息起的） */
function firstPageAfter(log: SyntheticLog): number {
  const messages = log.channels.get("secretary")!.filter((f) => f.type === "message");
  return messages.length < 50 ? 0 : messages[messages.length - 50]!.seq - 1;
}
