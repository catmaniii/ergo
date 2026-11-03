// 打开页面不再把全部历史过一遍（388）：照 vite.config.ts 构建安装版，由假守护进程（test/open-snapshot/fake-daemon.ts，127.0.0.1 上
// 系统挑的端口）提供页面和 /ws，补发一份照用户那台二狗的量级编的事件日志（一万多条、十来 MB），在真的 Chrome 里打开：
// - 冷打开（本机没快照）：一万多条补发攒着一次交，补发在路上时界面不画中间状态（React 的提交次数，挂开发者工具的钩子数）；
// - 热打开（本机有快照）：先用快照把界面画出来（补发还没到时就看得到上次的内容），订阅带快照的游标，只补增量；
// - 网页升级后第一次打开不用旧快照，从头补；
// - 设备被吊销、回到配对页时本机快照删掉。
// 不碰真的守护进程、~/.ergo、固定端口。本机没有 Chrome（或 Edge）时跳过。
import { type Browser, chromium, type Page } from "playwright-core";
import { build, type Rolldown } from "vite";
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import { fileURLToPath } from "node:url";
import { findChrome } from "../build/chrome.ts";
import { type FakeDaemon, startFakeDaemon } from "./open-snapshot/fake-daemon.ts";
import { MEASURE_SCRIPT, storedSnapshot, waitOpened, waitStored } from "./open-snapshot/measure.ts";
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

async function open(log: SyntheticLog): Promise<{ daemon: FakeDaemon; page: Page; errors: string[] }> {
  const daemon = await startFakeDaemon(html, log);
  daemons.push(daemon);
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
    const { daemon, page, errors } = await open(log);
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

  test("网页升级后第一次打开不用旧快照，从头补；补完存的是新版本的", async () => {
    const log = syntheticLog();
    const { daemon, page } = await open(log);
    await page.goto(daemon.url);
    await waitOpened(page);
    const before = await waitStored(page, { board: log.lastSeq("board") });
    daemon.setWebVersion("0123456789abcdef");
    await page.reload();
    await waitOpened(page);
    const conn = daemon.connections.at(-1)!;
    expect(Object.values(conn.cursors!).every((n) => n === 0)).toBe(true);
    expect(conn.frames).toBeGreaterThan(10_000);
    const after = await waitStored(page);
    expect(after.webVersion).toBe("0123456789abcdef");
    expect(before.webVersion).not.toBe(after.webVersion);
  }, 180_000);

  test("设备被吊销、回到配对页：本机快照删掉", async () => {
    const log = syntheticLog({ ...USER_SCALE, tasks: 20, activityEvents: 50, readMarks: 20, cards: 20, inboxItems: 20, deviceEvents: 8, projectEvents: 20 });
    const { daemon, page } = await open(log);
    await page.goto(daemon.url);
    await waitOpened(page);
    await waitStored(page, { board: log.lastSeq("board") });
    daemon.revoke();
    await page.locator(".pair-page").waitFor({ timeout: 15_000 });
    await expect.poll(() => storedSnapshot(page), { timeout: 5000, interval: 200 }).toBeNull();
    // 刷新之后还在配对页，也没有快照
    await page.reload();
    await page.locator(".pair-page").waitFor({ timeout: 15_000 });
    expect(await storedSnapshot(page)).toBeNull();
  }, 180_000);
});
