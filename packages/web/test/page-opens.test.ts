// 打开页面不崩（2026-10-18 用户要求：改了代码起码自己用网页打开看一下）：照 vite.config.ts 按生产环境构建一遍，存成临时文件，
// 用 file:// 在真 Chrome 里打开（不经守护进程，前端走原型的假数据），手机宽、电脑宽各一遍，挨个切到每一页（主导航各项、"更多"
// 下面各页、任务和项目的详情），再开一遍侧边栏模式（?ergo=side，147 号票）。页面抛出没接住的错误（React 崩了整页白屏——
// 比如 useSyncExternalStore 的 snapshot 每次给新对象、无限重渲）或某一页一个字都没有，就算失败。
// 原型打开时取不到的媒体文件（ERR_FILE_NOT_FOUND）不算。本机没有 Chrome（或 Edge）时跳过。
// 168 号票起英文再走一遍（原型地址带 ?lang=en）：同样每一页都打得开、有字、不报错，已经迁成多语言的地方（EN_DONE）一个中文字都不能有；
// 再在中文下打开设置 · 语言点 English，导航不刷新就换成英文。169–175 号票迁完一块就往 EN_DONE 里加。
// 193 号票起再走一遍停用记忆、提醒插件的（原型地址带 ?demo-plugins-off=memory,reminders）。
// 213 号票起日历也是插件：停用日历插件（?demo-plugins-off=calendar）后导航、"更多"、工作日规则、待办里都没有去日历的入口，#/calendar 写没启用。
// 214 号票起语音也是插件：停用语音插件（?demo-plugins-off=voice）后输入框没有话筒、设置里没有语音，#/more/voice 写没启用，每一页照样打得开。
// 212 号票加了停用浏览插件的（"浏览"、侧边栏模式写没启用）。
// 275 号票：每套风格量聊天里工具调用、来信、回忆记忆的横条（和"在想什么"同一列、右边留空、窄窗口下箭头露全点得到），
// 侧边栏模式收到交来的外观马上换风格。
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { type Browser, chromium, type Page } from "playwright-core";
import { build, type Rolldown } from "vite";
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import { MORE_PAGES } from "../src/app/route-hash.ts";
import { MEMORY_ITEMS } from "../src/plugins/memory/route.ts";
import { LANGUAGE_SETTING_TITLE } from "../src/state/index.ts";
import { VISUAL_STYLES } from "../src/visual-styles/index.ts";
import { findChrome } from "../build/chrome.ts";

const CHROME = findChrome();
const WEB_ROOT = fileURLToPath(new URL("..", import.meta.url));

/** 挨个切到的页：主导航各项、"更多"下面各页、任务和项目的详情（原型假数据里有的）、内置浏览器里渲染的文件（160 号票） */
const PAGES = [
  "#/secretary",
  "#/apps/demo/README.md",
  "#/secretary",
  "#/tasks",
  "#/tasks/t-photos",
  "#/projects",
  "#/projects/p-ledger",
  "#/projects/p-ledger/chat",
  // 262 号票：规范上线之前建的旧作品集网站，"规范"一块下有一张等你选的"补齐规范文档"卡
  "#/projects/p-oldsite",
  "#/inbox",
  "#/browse",
  "#/calendar",
  "#/more",
  ...MORE_PAGES.map((p) => `#/more/${p}`),
  // 记忆（193 号票起是记忆插件的页面）、它的几栏（285 号票：档案、结论、问题箱、素材）、记忆管理员的整页对话（242/243 号票：会话、
  // 回忆了 N 条记忆、每晚整理日记）、成批删除（167 号票）
  "#/more/memory",
  ...MEMORY_ITEMS.map((i) => `#/more/memory/${i}`),
  // 档案里点开的一个人（285 号票，原型的假档案）：本人、家人
  "#/more/memory/files/me",
  "#/more/memory/files/p-fake-mom",
  // 素材里点开的一条（158 号票，原型的假素材）、成批删除里点开的一条
  "#/more/memory/materials/mat-fake-stale",
  "#/more/memory/materials-delete/mat-fake-recent-7",
  // 你存的网页（165 号票，原型的假素材）：标题、网址、存下的正文
  "#/more/memory/materials/mat-fake-webpage",
  // 结论里点开的一条（233 号票的证据与推理，285 号票并进结论；原型的假结论）：证据链、支持/反证、竞争解释、修订
  "#/more/memory/claims/cl-0001",
  "#/more/memory/claims/cl-0002",
  // 证据与推理的旧地址（285 号票之前）：换到结论
  "#/more/memory/evidence",
  "#/more/memory/evidence/cl-0001",
  // 个人档案（281 号票，原型的假档案）：记忆插件在用时换到记忆 · 档案，停用时就是"更多"里的这一页
  "#/more/files/me",
  "#/more/files/p-fake-mom",
  // 设置里删除素材的旧地址（167 号票之前）：跳到记忆 · 素材
  "#/more/materials",
  "#/more/materials/mat-fake-recent-1",
];

/**
 * 英文下已经迁好的地方：在这一页上，这个元素里（去掉 except 挑出来的还没迁的部分、用户的内容）不能有中文。
 * 迁移票迁完一块就往这里加一行
 */
const EN_DONE: { hash: string; selector: string; except?: string }[] = [
  // 168 号票：外壳——导航（竖栏、横栏连同量长度的样本）、设置列表的各项（外观与风格的副标题是状态层的 appearanceSummary 加风格名，170、169 号票的）、"更多"、设置 · 语言（本地名"中文"、用户起的名字除外）
  { hash: "#/secretary", selector: "nav" },
  { hash: "#/more/settings", selector: ".topbar .title" },
  { hash: "#/more/settings", selector: "button[data-page]", except: '[data-page="appearance"] small' },
  // 247 号票：四组的组标题（身份、能力、规则、数据与设备）
  { hash: "#/more/settings", selector: ".settings-group-head" },
  { hash: "#/more", selector: ".menu" },
  { hash: "#/more/language", selector: ".topbar .title" },
  { hash: "#/more/language", selector: ".language-page", except: '[lang="zh-CN"], .assistant-name' },
  // 169 号票：界面组件（ui/、model/）——卡片的种类签、日期分隔、附件按钮、"详情"这类小链接、输入框（秘书的名字标签除外）、
  // 任务详情的阶段栏和待你处理的条、卡片上处理过的结果、立项要求变更的前后对照、提醒的浏览器通知开关。
  // 卡片的标题、正文、阶段名是二狗存下的内容（原型的假数据是中文），状态名、处置名是状态层和协议包的（170、172 号票），不在这里查
  { hash: "#/secretary", selector: ".xcard-tag" },
  { hash: "#/secretary", selector: ".day-sep" },
  { hash: "#/secretary", selector: ".att-btns" },
  { hash: "#/secretary", selector: ".thinking-more, .tool-more, .card-more, .bubble-more" },
  { hash: "#/secretary", selector: ".composer", except: ".assistant-name" },
  { hash: "#/tasks/t-photos", selector: ".composer" },
  { hash: "#/tasks/t-photos", selector: ".ibar-n" },
  { hash: "#/tasks/t-photos", selector: ".md-side-wait, .md-counts, .stage-prog" },
  { hash: "#/projects/p-ledger/chat", selector: ".xcard-tag" },
  { hash: "#/projects/p-ledger/chat", selector: ".auth-result, .charter-diff-k" },
  { hash: "#/inbox", selector: ".notify-permission" },
  // 待办通知的动作按钮：存的是中文原字（按字认），显示时换成当前语言（协议包的 inboxActionText，172 号票）
  { hash: "#/inbox/i-sjob", selector: ".auth-actions" },
  { hash: "#/inbox/i-backup", selector: ".auth-actions" },
  // 171 号票：pages/ 里的字——各页的标题栏、分节标题、说明（名字标签是用户起的名字）。从状态层、ui/ 来的字（状态名、阶段名、标签、
  // 外观与风格的副标题、时间日期……）归 169、170、172 号票，原型的演示数据（任务名、项目名、素材……）是内容，这几处选得避开它们
  { hash: "#/browse", selector: ".chat-col" },
  { hash: "#/tasks", selector: ".topbar .title" },
  { hash: "#/tasks", selector: ".topbar .btn.primary" },
  { hash: "#/projects", selector: ".topbar" },
  { hash: "#/projects", selector: ".pwall-sum-row:last-child" },
  { hash: "#/projects", selector: ".pwall > .hint", except: ".assistant-name" },
  { hash: "#/projects/p-ledger", selector: ".sec-head" },
  // 258 号票：项目页上的"规范"一块（文档名、写了 / 只有模板 / 缺都是协议包的说法）
  { hash: "#/projects/p-ledger", selector: ".proj-standard" },
  // 262 号票："补齐规范文档"卡上的说明、缺的几份、两个按钮（项目名是内容，不在这里查）
  { hash: "#/projects/p-oldsite", selector: ".xcard-standard_backfill .xcard-body, .xcard-standard_backfill .auth-actions" },
  { hash: "#/calendar", selector: ".cal-title" },
  { hash: "#/inbox", selector: ".topbar .title" },
  // 设置：身份组里的"我的名字"那一行（43 号票的"个人助理的名字"2026-10-23 起不单独设了，改成默认角色的名字）
  { hash: "#/more/settings", selector: ".user-name-setting", except: ".assistant-name" },
  { hash: "#/more/settings", selector: ".tool-call-storage .btn" },
  // 335 号票：设置里的"备份"一小节（同步目录、最近一次、立即备份）
  { hash: "#/more/settings", selector: "[data-section=backup] .btn" },
  { hash: "#/more/usage", selector: ".sec-head" },
  // 211 号票：设置 · 插件（原型的假守护进程按打开时的语言给插件的说法）
  { hash: "#/more/plugins", selector: ".plugins-page" },
  // 323 号票：设置 · 组件——分节标题、上面那一排按钮、每块的状况小签、几行的键、按钮、清单签没签名（组件名、说明、值是守护进程给的内容，原型编的是中文）
  { hash: "#/more/components", selector: ".components-page .sec-head, .component-toolbar, .component-head .chip, .component-line dt, .component-actions, .component-manifest" },
  // 319b：设置 · 体检——八项的名字、事实、怎么修都是网页按语言拼的（演示页的数据是编的，路径和时间不是中文）
  { hash: "#/more/doctor", selector: ".doctor-page" },
  { hash: "#/more/memory", selector: ".memory-layers", except: ".assistant-name" },
  { hash: "#/more/memory/materials", selector: ".mat-search, .mat-count, .mat-range-nav button" },
  // 233 号票：结论、证据与推理、问题箱——状态筛、顶上那几行、详情里的分节标题（结论的陈述、原话是内容，不在这里查）
  { hash: "#/more/memory/claims", selector: ".mem-filters" },
  { hash: "#/more/memory/claims", selector: ".mem-head" },
  { hash: "#/more/memory/claims/cl-0001", selector: ".dt-section h4" },
  // 285 号票：记忆页顶上"和记忆管理员聊"那张卡、记忆管理员对话里输入框上面那一行、档案的四组
  { hash: "#/more/memory", selector: ".mem-keeper-card" },
  { hash: "#/more/memory/curator", selector: ".mem-interview-bar" },
  { hash: "#/more/memory/files", selector: ".pf-page .sec-head, .topbar .btn", except: ".assistant-name" },
  { hash: "#/more/memory/questions", selector: ".mem-head" },
  { hash: "#/more/memory/materials-delete", selector: ".sec-head" },
  { hash: "#/more/memory/materials-delete", selector: ".mat-page > .muted:first-child", except: ".assistant-name" },
  { hash: "#/more/about", selector: ".about-head" },
  { hash: "#/more/about", selector: ".about-facts dt" },
  { hash: "#/more/about", selector: ".about-log .sec-head" },
  ...["devices", "voice", "watch", "models", "workday-rules", "browsing", "appearance"].map((p) => ({ hash: `#/more/${p}`, selector: ".sec-head" })),
  { hash: "#/more/skills", selector: ".sec-head", except: ".assistant-name" },
  { hash: "#/more/debug", selector: ".page-placeholder" },
  // 170 号票：状态层出的字——秘书页标题的前缀、工具调用组那一行（"调用了 N 个工具"）、外观的三个选项、搜索引擎、
  // 工具调用的完整内容占多大和保留规则（设置列表里那一项的两行小字）
  { hash: "#/secretary", selector: ".secretary-title-lead" },
  { hash: "#/secretary", selector: ".tool-sum-text" },
  { hash: "#/projects/p-ledger/chat", selector: ".tool-sum-text" },
  { hash: "#/more/appearance", selector: ".appearance-choice" },
  { hash: "#/more/browsing", selector: ".seg" },
  { hash: "#/more/settings", selector: ".tool-call-storage small" },
  { hash: "#/more/settings", selector: "[data-section=backup] small" },
  // 172 号票：协议包的说法——模型设置里各 agent 的名字（秘书那一行是名字标签）、怎么开会话的说明、思考档位，关注类别的各种处置
  { hash: "#/more/models", selector: ".model-agent-head > b", except: ".assistant-name" },
  { hash: "#/more/models", selector: ".model-agent-head small.muted:first-of-type" },
  { hash: "#/more/models", selector: ".model-agent-selects select" },
  { hash: "#/more/watch", selector: ".cat-row select" },
  // 281 号票：个人档案——列表的说明和分节标题、一份档案里的字段名、分节标题、按钮（值、称呼、记下的事是内容，不在这里查）
  { hash: "#/more/files", selector: ".pf-intro, .pf-page .sec-head", except: ".assistant-name" },
  { hash: "#/more/files/p-fake-mom", selector: ".pf-label, .pf-page .sec-head, .pf-actions", except: ".assistant-name" },
  { hash: "#/secretary", selector: ".xcard-personal_file .auth-actions" },
];

/** 中文（汉字、中文标点、全角符号） */
const CJK = /[　-〿㐀-䶿一-鿿豈-﫿！-｠]/;

let browser: Browser | undefined;
let pageUrl = "";
let tempDir = "";

beforeAll(async () => {
  if (!CHROME) return;
  // 和 npm run build:web 一样按生产环境构建（vitest 把 NODE_ENV 设成了 test，Vite 会照它打开发版）
  vi.stubEnv("NODE_ENV", "production");
  let html: string;
  try {
    const result = await build({ root: WEB_ROOT, configFile: `${WEB_ROOT}/vite.config.ts`, logLevel: "silent", build: { write: false } });
    const outputs = (Array.isArray(result) ? result : [result]) as Rolldown.RolldownOutput[];
    const page = outputs.flatMap((o) => o.output).find((f) => f.fileName === "index.html");
    if (page?.type !== "asset") throw new Error("构建产物里没有 index.html");
    html = String(page.source);
  } finally {
    vi.unstubAllEnvs();
  }
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "ergo-page-opens-"));
  const file = path.join(tempDir, "index.html");
  fs.writeFileSync(file, html);
  pageUrl = pathToFileURL(file).href;
  browser = await chromium.launch({ executablePath: CHROME });
}, 120_000);

// 关 Chrome 在机器忙（几个工作槽同时跑全量）时会超过默认的 10 秒，测试本身全过却挂在收尾上
afterAll(async () => {
  await browser?.close();
  if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
}, 60_000);

/** 开一页，记下没接住的错误和控制台报错（取不到的文件不算） */
async function open(viewport: { width: number; height: number }, search = ""): Promise<{ page: Page; errors: string[] }> {
  const page = await browser!.newPage({ viewport });
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(`没接住的错误：${String(e)}`));
  page.on("console", (m) => {
    if (m.type() === "error" && !m.text().startsWith("Failed to load resource")) errors.push(`控制台报错：${m.text()}`);
    // 170 号票：缺句子的提示（key 写错了，或者在模块顶层取了 t()——那时还没装上语言）也算报错
    if (m.type() === "warning" && m.text().startsWith("[i18n]")) errors.push(`缺句子：${m.text()}`);
  });
  await page.goto(pageUrl + search);
  return { page, errors };
}

async function bodyText(page: Page): Promise<string> {
  return (await page.innerText("body")).trim();
}

/**
 * 213 号票：网页上去日历的入口——导航和"更多"里的日历、#/calendar 那一页（日历还是"没启用"）、工作日规则里的"日历"链接、
 * 手动标记那句话、待办里到点的提醒（i-rent）的"去看看"
 */
async function calendarEntries(viewport: { width: number; height: number }, search: string) {
  const { page, errors } = await open(viewport, search);
  const at = async (hash: string) => {
    await page.evaluate(`window.location.hash = ${JSON.stringify(hash)}`);
    await page.waitForTimeout(300);
  };
  await at("#/secretary");
  const nav = await page.locator('nav .nav-list [data-nav="calendar"]').count();
  await at("#/more");
  const more = await page.locator('.menu [data-nav="calendar"]').count();
  await at("#/calendar");
  const calendar = (await page.locator(".cal-title").count()) > 0 ? "日历" : (await bodyText(page)).includes("日历插件没启用，这一页暂时看不到") ? "没启用" : "?";
  await at("#/more/workday-rules");
  const rules = await page.locator('.hint button.link:text-is("日历")').count();
  const manual = (await bodyText(page)).includes("是手动标记，不是规则");
  await at("#/inbox/i-rent");
  const jump = await page.locator('.inbox-jump a[href^="#/calendar"]').count();
  await page.close();
  expect(errors).toEqual([]);
  return { nav: nav + more, calendar, rules, manual, jump };
}

describe.skipIf(!CHROME)("打开页面不崩（构建产物在真的 Chrome 里）", () => {
  for (const [name, viewport] of [
    ["手机宽", { width: 390, height: 844 }],
    ["电脑宽", { width: 1280, height: 800 }],
  ] as const) {
    test(`${name}：每一页都打得开、有字、不报错`, async () => {
      const { page, errors } = await open(viewport);
      const empty: string[] = [];
      for (const hash of PAGES) {
        await page.evaluate(`window.location.hash = ${JSON.stringify(hash)}`);
        await page.waitForTimeout(150);
        if ((await bodyText(page)) === "") empty.push(hash);
      }
      await page.close();
      expect(errors).toEqual([]);
      expect(empty).toEqual([]);
    }, 60_000);
  }

  // 193 号票：停用记忆、提醒插件（原型地址带 ?demo-plugins-off=…，假连接照守护进程报"在配置里停用了"）后每一页照样打得开；
  // 导航里没有记忆、记忆的地址写没启用、设置里列出内核的"删除素材"、看板上的提醒成了占位、对话里的那几条成了占位
  test("停用记忆、提醒插件（?demo-plugins-off=memory,reminders）电脑宽：每一页都打得开、有字、不报错，它们的东西不出现、旧条目占位", async () => {
    const { page, errors } = await open({ width: 1280, height: 800 }, "?demo-plugins-off=memory,reminders");
    const empty: string[] = [];
    for (const hash of PAGES) {
      await page.evaluate(`window.location.hash = ${JSON.stringify(hash)}`);
      await page.waitForTimeout(150);
      if ((await bodyText(page)) === "") empty.push(hash);
    }
    const at = async (hash: string) => {
      await page.evaluate(`window.location.hash = ${JSON.stringify(hash)}`);
      await page.waitForTimeout(300);
    };
    await at("#/secretary");
    expect(await page.locator('nav .nav-list [data-nav="memory"]').count()).toBe(0);
    expect(await page.locator(".recall-line, .xcard-reminder, .xcard-memory_delete").count()).toBe(0);
    expect(await page.locator(".msg-unavailable").count()).toBeGreaterThan(0);
    await at("#/more/memory");
    expect(await bodyText(page)).toContain("记忆插件没启用，这一页暂时看不到");
    await at("#/more/settings");
    expect(await page.locator('[data-page="materials-delete"]').count()).toBe(1);
    // 285 号票：记忆页没了，"更多"里列出个人档案，#/more/files 就是那一页（能加人、点进去）
    await at("#/more");
    expect(await page.locator(".pf-menu-icon").count()).toBe(1);
    await at("#/more/files/p-fake-mom");
    expect(await page.evaluate("window.location.hash")).toBe("#/more/files/p-fake-mom");
    expect(await page.locator(".pf-name").count()).toBe(1);
    await at("#/more/files");
    expect(await page.locator('.topbar [data-action="add-person"]').count()).toBe(1);
    expect(await page.locator(".pf-group-title").count()).toBe(4);
    await at("#/tasks");
    expect(await page.locator(".bcard-reminder").count()).toBe(0);
    expect(await page.locator(".bgroup-unavailable").count()).toBeGreaterThan(0);
    await at("#/calendar");
    expect(await page.locator(".cal-mk-r").count()).toBe(0);
    await page.close();
    expect(errors).toEqual([]);
    expect(empty).toEqual([]);
  }, 60_000);

  // 233 号票：记忆的结论、证据与推理、问题箱——空数据（?demo-memory-empty，库在、还没整理出东西）和
  // 推理库读不到（?demo-memory-off）时每一页都打得开、有空数据的说明或原因，不是空白、不报错
  test("记忆的结论、证据与推理、问题箱：空数据和推理库读不到时都有说明，不崩", async () => {
    for (const [search, expected] of [
      ["?demo-memory-empty", "还没有结论"],
      ["?demo-memory-off", "推理库这会儿正被每晚整理占着"],
    ] as const) {
      const { page, errors } = await open({ width: 1280, height: 800 }, search);
      const at = async (hash: string) => {
        await page.evaluate(`window.location.hash = ${JSON.stringify(hash)}`);
        await page.waitForTimeout(250);
      };
      await at("#/more/memory");
      expect(await page.locator(".memory-layers").count()).toBe(1);
      await at("#/more/memory/claims");
      expect(await bodyText(page)).toContain(expected);
      // 证据与推理的旧地址换到结论（285 号票）
      await at("#/more/memory/evidence");
      expect(await page.evaluate("window.location.hash")).toBe("#/more/memory/claims");
      expect(await bodyText(page)).toContain(search === "?demo-memory-empty" ? "还没有结论" : expected);
      await at("#/more/memory/questions");
      expect(await bodyText(page)).toContain(search === "?demo-memory-empty" ? "问题箱是空的" : expected);
      await page.close();
      expect(errors).toEqual([]);
    }
    // 有数据时：结论按层分组、点开一条看证据链和竞争解释
    const { page, errors } = await open({ width: 1280, height: 800 });
    const at = async (hash: string) => {
      await page.evaluate(`window.location.hash = ${JSON.stringify(hash)}`);
      await page.waitForTimeout(250);
    };
    await at("#/more/memory/claims");
    expect(await page.locator(".mem-tier").count()).toBeGreaterThan(0);
    expect(await page.locator(".mem-row-chips").count()).toBeGreaterThan(0);
    await at("#/more/memory/claims/cl-0001");
    expect(await page.locator(".mem-chain-row").count()).toBeGreaterThan(0);
    expect(await page.locator(".topbar .title", { hasText: "证据与推理" }).count()).toBe(1);
    expect(await page.locator(".mem-quote-text").count()).toBeGreaterThan(0);
    await at("#/more/memory/questions");
    expect(await page.locator(".mem-question").count()).toBeGreaterThan(0);
    await page.close();
    expect(errors).toEqual([]);
  }, 60_000);

  // 2026-10-23 用户报过：记忆 · 管理员那一层里"回忆了 N 条记忆""Agent 的想法"点整条没反应、行尾的 › 也没有——
  // 那一页当时没接详情（Conversation 没给 onDetail），行是灰的。这条守着：行能点、有 ›、点了右边开出"这次用到的记忆"
  test("记忆 · 管理员：回忆了 N 条记忆那一行能点、有 ›，点了右边开出这次用到的记忆", async () => {
    const { page, errors } = await open({ width: 1280, height: 800 });
    await page.evaluate(`window.location.hash = "#/more/memory/curator"`);
    await page.waitForSelector(".recall-line", { timeout: 10_000 });
    const line = page.locator(".recall-line").first();
    expect(await line.isDisabled()).toBe(false);
    expect(await line.locator(".tool-more").count()).toBe(1);
    await line.click();
    await page.waitForTimeout(400);
    expect(await page.locator(".pane-detail").count()).toBe(1);
    expect(await bodyText(page)).toContain("这次用到的记忆");
    await page.close();
    expect(errors).toEqual([]);
  }, 60_000);

  // 285 号票：记忆页的栏目重排（用户 2026-10-26 看过对照图定的）
  for (const [name, viewport] of [
    ["手机宽", { width: 390, height: 844 }],
    ["电脑宽", { width: 1280, height: 800 }],
  ] as const) {
    test(`${name}：记忆页顶上是"和记忆管理员聊"、四栏是档案 结论 问题箱 素材；记忆管理员是整页对话，里面能开访谈；个人档案搬进记忆 · 档案`, async () => {
      const { page, errors } = await open(viewport);
      const at = async (hash: string) => {
        await page.evaluate(`window.location.hash = ${JSON.stringify(hash)}`);
        await page.waitForTimeout(300);
      };
      await at("#/more/memory");
      expect(await page.locator(".mem-keeper-card").count()).toBe(1);
      expect(await page.locator(".memory-layers [data-layer]").evaluateAll((els) => els.map((e) => e.getAttribute("data-layer")))).toEqual(["files", "claims", "questions", "materials"]);
      expect(await page.locator('[data-action="interview"]').count()).toBe(0);
      // 宽屏没选栏时右边是档案（手机上先只列首页）
      expect(await page.locator(".pf-group-title").count()).toBe(viewport.width > 600 ? 4 : 0);
      await page.locator(".mem-keeper-card").click();
      await page.waitForTimeout(300);
      expect(await page.evaluate("window.location.hash")).toBe("#/more/memory/curator");
      // 整页对话：不留栏目；标题、输入框写的是记忆管理员
      expect(await page.locator(".memory-layers").count()).toBe(0);
      expect(await page.locator(".topbar .title").first().innerText()).toMatch(/^记忆管理员/);
      expect(await page.locator(".composer textarea").getAttribute("placeholder")).toBe("和记忆管理员说…");
      expect(await page.locator(".composer-placeholder").count()).toBe(0);
      await page.waitForSelector(".mem-interview-bar", { timeout: 5000 });
      expect(await page.locator(".mem-interview-bar").innerText()).toContain("了解你访谈");
      await page.locator('.mem-interview-bar [data-action="interview"]').click();
      await page.waitForTimeout(300);
      expect(await page.locator(".mem-interview-bar").innerText()).toContain("正在访谈");
      expect(await page.locator('[data-action="interview"]').count()).toBe(0);
      // 个人档案：记忆插件在用时"更多"里不列，旧地址换到记忆 · 档案；四组
      await at("#/more/files/p-fake-mom");
      expect(await page.evaluate("window.location.hash")).toBe("#/more/memory/files/p-fake-mom");
      expect(await page.locator(".pf-name").count()).toBe(1);
      await at("#/more");
      expect(await page.locator(".pf-menu-icon").count()).toBe(0);
      await at("#/more/memory/files");
      expect(await page.locator(".pf-group-title").evaluateAll((els) => els.map((e) => e.getAttribute("data-group")))).toEqual(["me", "family", "important", "others"]);
      await page.close();
      expect(errors).toEqual([]);
    }, 60_000);
  }

  test("默认全开电脑宽：导航里有记忆，设置里不列删除素材（在记忆页里），看板上有提醒卡", async () => {
    const { page, errors } = await open({ width: 1280, height: 800 });
    await page.evaluate(`window.location.hash = "#/more/settings"`);
    await page.waitForTimeout(300);
    expect(await page.locator('nav .nav-list [data-nav="memory"]').count()).toBe(1);
    expect(await page.locator('[data-page="materials-delete"]').count()).toBe(0);
    await page.evaluate(`window.location.hash = "#/tasks"`);
    await page.waitForTimeout(300);
    expect(await page.locator(".bcard-reminder").count()).toBeGreaterThan(0);
    expect(await page.locator(".bgroup-unavailable").count()).toBe(0);
    await page.close();
    expect(errors).toEqual([]);
  }, 60_000);

  // 213 号票：日历插件停用时网页上没有日历入口；默认全开时都在（和以前一样）
  for (const [name, viewport] of [
    ["手机宽", { width: 390, height: 844 }],
    ["电脑宽", { width: 1280, height: 800 }],
  ] as const) {
    test(`停用日历插件（?demo-plugins-off=calendar）${name}：导航、"更多"里没有日历，#/calendar 写没启用，工作日规则、到点的提醒里没有去日历的链接；默认全开时都在`, async () => {
      // 手机宽时日历在不在导航里看量出来的宽度，电脑宽时直接在导航里：导航和"更多"两处加起来是 1
      expect(await calendarEntries(viewport, "")).toEqual({ nav: 1, calendar: "日历", rules: 2, manual: true, jump: 1 });
      expect(await calendarEntries(viewport, "?demo-plugins-off=calendar")).toEqual({ nav: 0, calendar: "没启用", rules: 0, manual: true, jump: 0 });
    }, 60_000);
  }

  // 214 号票：语音插件停用时输入框没有话筒（一律打字）、设置里没有语音；默认全开时都在
  test("停用语音插件（?demo-plugins-off=voice）手机宽：每一页都打得开；输入框没有话筒，设置里没有语音，#/more/voice 写没启用；默认全开时都在", async () => {
    const on = await open({ width: 390, height: 844 });
    await on.page.evaluate(`window.location.hash = "#/secretary"`);
    await on.page.waitForTimeout(300);
    expect(await on.page.locator(".voice-toggle").count()).toBe(1);
    await on.page.evaluate(`window.location.hash = "#/more/settings"`);
    await on.page.waitForTimeout(300);
    expect(await on.page.locator('[data-page="voice"]').count()).toBe(1);
    await on.page.close();
    expect(on.errors).toEqual([]);

    const { page, errors } = await open({ width: 390, height: 844 }, "?demo-plugins-off=voice");
    const empty: string[] = [];
    for (const hash of PAGES) {
      await page.evaluate(`window.location.hash = ${JSON.stringify(hash)}`);
      await page.waitForTimeout(150);
      if ((await bodyText(page)) === "") empty.push(hash);
    }
    await page.evaluate(`window.location.hash = "#/secretary"`);
    await page.waitForTimeout(300);
    expect(await page.locator(".voice-toggle").count()).toBe(0);
    expect(await page.locator(".composer textarea").count()).toBeGreaterThan(0);
    await page.evaluate(`window.location.hash = "#/more/settings"`);
    await page.waitForTimeout(300);
    expect(await page.locator('[data-page="voice"]').count()).toBe(0);
    await page.evaluate(`window.location.hash = "#/more/voice"`);
    await page.waitForTimeout(300);
    expect(await bodyText(page)).toContain("语音插件没启用");
    await page.close();
    expect(errors).toEqual([]);
    expect(empty).toEqual([]);
  }, 60_000);

  for (const [name, viewport] of [
    ["手机宽", { width: 390, height: 844 }],
    ["电脑宽", { width: 1280, height: 800 }],
  ] as const) {
    test(`英文（?lang=en）${name}：每一页都打得开、有字、不报错，迁好的地方没有中文`, async () => {
      const { page, errors } = await open(viewport, "?lang=en");
      expect(await page.evaluate("document.documentElement.lang")).toBe("en");
      const empty: string[] = [];
      for (const hash of PAGES) {
        await page.evaluate(`window.location.hash = ${JSON.stringify(hash)}`);
        await page.waitForTimeout(150);
        if ((await bodyText(page)) === "") empty.push(hash);
      }
      const leaks: string[] = [];
      for (const { hash, selector, except } of EN_DONE) {
        await page.evaluate(`window.location.hash = ${JSON.stringify(hash)}`);
        await page.waitForTimeout(200);
        // 每个匹配的元素去掉 except 挑出来的部分之后的字（:not(*) 什么都不挑）
        const texts = (await page.evaluate(
          `Array.from(document.querySelectorAll(${JSON.stringify(selector)}), (el) => { const copy = el.cloneNode(true); for (const x of copy.querySelectorAll(${JSON.stringify(except ?? ":not(*)")})) x.remove(); return copy.textContent ?? ""; })`,
        )) as string[];
        if (texts.length === 0) leaks.push(`${hash} ${selector}：一个都没找到`);
        // 故意中英并列的"语言 / Language"（选错了语言也找得回来）不算
        for (const text of texts) if (CJK.test(text.replaceAll(LANGUAGE_SETTING_TITLE, ""))) leaks.push(`${hash} ${selector}：${text.slice(0, 120)}`);
      }
      await page.close();
      expect(errors).toEqual([]);
      expect(empty).toEqual([]);
      expect(leaks).toEqual([]);
    }, 60_000);
  }

  test("中文下打开设置 · 语言点 English：导航、设置列表不刷新就换成英文，再点中文换回来", async () => {
    const { page, errors } = await open({ width: 1280, height: 800 });
    await page.evaluate(`window.location.hash = "#/more/language"`);
    await page.waitForSelector(".language-list");
    expect(await page.innerText("nav")).toContain("秘书");
    // 中文时竖栏和原来一样宽（经典：两个字 11px × 2 + 21px），英文时按最长的那项名字加宽
    const railWidth = async () => (await page.evaluate(`document.querySelector("nav.siderail").getBoundingClientRect().width`)) as number;
    expect(await railWidth()).toBe(43);
    await page.click('.language-list [role="radio"]:has-text("English")');
    await page.waitForFunction(`document.documentElement.lang === "en"`);
    await page.waitForTimeout(200);
    const nav = await page.innerText("nav");
    expect(nav).toContain("Secretary");
    expect(CJK.test(nav)).toBe(false);
    expect(await railWidth()).toBeGreaterThan(55);
    expect(await page.innerText(".pane-list")).toContain("Settings");
    await page.click('.language-list [role="radio"]:has-text("中文")');
    await page.waitForFunction(`document.documentElement.lang === "zh-CN"`);
    await page.waitForTimeout(200);
    expect(await page.innerText("nav")).toContain("秘书");
    expect(await railWidth()).toBe(43);
    await page.close();
    expect(errors).toEqual([]);
  }, 30_000);

  test("侧边栏模式（?ergo=side）打得开、有字、不报错", async () => {
    const { page, errors } = await open({ width: 390, height: 844 }, "?ergo=side");
    await page.waitForTimeout(300);
    const text = await bodyText(page);
    await page.close();
    expect(errors).toEqual([]);
    expect(text).toContain("现在在看");
  }, 30_000);

  // 212 号票：停用浏览插件（假连接照守护进程报"在配置里停用了"）："浏览"的地址、侧边栏模式写"内置浏览器插件没启用"，别的页照样打得开
  test("停用浏览插件（?demo-plugins-off=browsing）：#/browse 和侧边栏模式写没启用、不报错，别的页照样打得开", async () => {
    const { page, errors } = await open({ width: 390, height: 844 }, "?demo-plugins-off=browsing");
    const empty: string[] = [];
    const texts = new Map<string, string>();
    for (const hash of ["#/secretary", "#/browse", "#/more/settings", "#/more/browsing", "#/more/plugins"]) {
      await page.evaluate(`window.location.hash = ${JSON.stringify(hash)}`);
      await page.waitForTimeout(200);
      texts.set(hash, await bodyText(page));
      if (texts.get(hash) === "") empty.push(hash);
    }
    await page.close();
    expect(texts.get("#/browse")).toContain("内置浏览器插件没启用，这一页暂时看不到");
    const side = await open({ width: 390, height: 844 }, "?ergo=side&demo-plugins-off=browsing");
    await side.page.waitForTimeout(300);
    const sideText = await bodyText(side.page);
    await side.page.close();
    expect([...errors, ...side.errors]).toEqual([]);
    expect(empty).toEqual([]);
    expect(sideText).toContain("内置浏览器插件没启用，这一页暂时看不到");
  }, 60_000);

  // 275 号票（用户 2026-10-25）：工具调用、来信（维护者来信……）、回忆了 N 条记忆这几种横条照"在想什么"那条——和它在同一列
  // （左边对齐，糖果、纸张的头像位也让出来），宽度跟着内容走、最宽到对话气泡那么宽（右边留空），窄窗口下右边不超出、
  // 行尾的箭头（›、详情 ›）整个露在横条里、紧跟着字、点得到。每套风格量：秘书页、维护者会话页（窄 340）、秘书页（电脑宽）、侧边栏模式（320）
  for (const style of VISUAL_STYLES.map((s) => s.id)) {
    test(`${style}：工具调用、来信、回忆记忆的横条和"在想什么"同一列、右边不超出，箭头露全、点得到`, async () => {
      const { page, errors } = await open({ width: 340, height: 800 });
      await page.evaluate(`localStorage.setItem("ergo-style", ${JSON.stringify(style)})`);
      const problems: string[] = [];
      const check = async (where: string, kinds: string[]) => {
        await page.waitForSelector(".msg .tool-sum", { timeout: 10_000 });
        await page.waitForTimeout(200);
        const found = (await page.evaluate(MEASURE_ROWS)) as RowMeasure;
        if (found.thinkingLeft === undefined) problems.push(`${where}：没找到"在想什么"那一行`);
        for (const kind of kinds) if (!found.rows.some((r) => r.kind === kind)) problems.push(`${where}：没找到 ${kind} 横条`);
        for (const r of found.rows) problems.push(...rowProblems(`${where} ${r.kind}「${r.text}」`, r, found.thinkingLeft));
      };
      await page.reload();
      await page.evaluate(`window.location.hash = "#/secretary"`);
      await check("秘书页 340", ["tool", "letter", "recall"]);
      await page.evaluate(`window.location.hash = "#/projects/p-ledger/chat"`);
      await check("维护者会话页 340", ["tool"]);
      await page.setViewportSize({ width: 1280, height: 800 });
      await page.evaluate(`window.location.hash = "#/secretary"`);
      await check("秘书页 1280", ["tool", "letter", "recall"]);
      await page.setViewportSize({ width: 320, height: 800 });
      await page.goto(`${pageUrl}?ergo=side`);
      await check("侧边栏模式 320", ["tool", "letter"]);
      await page.close();
      expect(errors).toEqual([]);
      expect(problems).toEqual([]);
    }, 60_000);
  }

  // 275 号票：侧边栏模式那一页收到"浏览"页交来的外观（App 转的 window.__ergoSide），马上换风格、深浅色、主色；不写这一页的存储
  test("侧边栏模式：收到交来的外观马上换风格、深浅色、主色，不写存储", async () => {
    const { page, errors } = await open({ width: 390, height: 844 }, "?ergo=side");
    await page.waitForTimeout(300);
    const root = async () => (await page.evaluate(`["data-style", "data-theme", "data-accent"].map((n) => document.documentElement.getAttribute(n))`)) as (string | null)[];
    const bg = async () => (await page.evaluate(`getComputedStyle(document.body).backgroundColor`)) as string;
    expect(await root()).toEqual(["classic", null, "blue"]);
    const before = await bg();
    const push = (appearance: object) => page.evaluate(`window.__ergoSide(${JSON.stringify(JSON.stringify({ open: true, browser: "b-0123456789abcdef", appearance }))})`);
    await push({ theme: "dark", style: "candy" });
    expect(await root()).toEqual(["candy", "dark", null]);
    expect(await bg()).not.toBe(before);
    await push({ theme: "system", style: "classic", accent: "orange" });
    expect(await root()).toEqual(["classic", null, "orange"]);
    expect(await page.evaluate(`[localStorage.getItem("ergo-style"), localStorage.getItem("ergo-theme"), localStorage.getItem("ergo-accent")]`)).toEqual([null, null, null]);
    await page.close();
    expect(errors).toEqual([]);
  }, 60_000);

  // 289 号票顺手发现（2026-10-25）：手机宽时 ⚙ 是底部弹层，套在它里面的确认框被它的滚动区裁掉、看不见（只剩一层灰）。
  // ⚙ 里的确认框——恢复用通用模板、清空当前对话（重置维护者）、换运行时——都挂到 body 上：不在 ⚙ 的弹层里，两个按钮整个露在屏幕里、点得到
  test("手机宽：⚙ 里的确认框挂在最外层，不被底部弹层裁掉，按钮看得见、点得到", async () => {
    const { page, errors } = await open({ width: 390, height: 844 });
    await page.evaluate(`window.location.hash = "#/projects/p-ledger/chat"`);
    await page.click(".agent-gear");
    await page.waitForSelector(".agent-panel");
    const confirms: [string, () => Promise<unknown>][] = [
      ["恢复用通用模板", () => page.click('.agent-panel .prompt-actions button:has-text("恢复用通用模板")')],
      ["清空当前对话（重置维护者）", () => page.click('.agent-panel button:has-text("清空当前对话（重置维护者）")')],
      ["换运行时", () => page.selectOption(".agent-panel .agent-runtime-choice select", { label: "Claude Code" })],
    ];
    const found: unknown[] = [];
    for (const [name, show] of confirms) {
      await show();
      await page.waitForFunction(`document.querySelectorAll('[role="dialog"]').length === 2`, undefined, { timeout: 5_000 });
      await page.waitForTimeout(200);
      found.push({ name, ...((await page.evaluate(MEASURE_GEAR_CONFIRM)) as object) });
      // 不经点击判定直接点"取消"（裁掉时点不到，不能让它卡住）：确认框关掉，⚙ 还开着
      await page.evaluate(`Array.from(document.querySelectorAll('[role="dialog"]')).find((d) => !d.querySelector(".agent-panel")).querySelector(".btn.ghost").click()`);
      await page.waitForFunction(`document.querySelectorAll('[role="dialog"]').length === 1`, undefined, { timeout: 5_000 });
      expect(await page.locator(".agent-panel").count()).toBe(1);
    }
    await page.close();
    expect(errors).toEqual([]);
    const ok = { inGear: false, onBody: true, buttons: [{ inView: true, hit: true }, { inView: true, hit: true }] };
    expect(found).toEqual(confirms.map(([name]) => ({ name, ...ok })));
  }, 60_000);
});

/**
 * ⚙ 开着时另一个弹层（确认框）：在不在 ⚙ 的弹层里、遮罩是不是直接挂在 body 上；它底下那排按钮是不是整个在屏幕里、
 * 按钮正中点下去落在它自己身上（没被裁掉、没被盖住）
 */
const MEASURE_GEAR_CONFIRM = `(() => {
  const gear = document.querySelector(".agent-panel").closest('[role="dialog"]');
  const dialog = Array.from(document.querySelectorAll('[role="dialog"]')).find((d) => d !== gear);
  const buttons = Array.from(dialog.querySelectorAll(".auth-actions button"), (b) => {
    const r = b.getBoundingClientRect();
    const inView = r.width > 0 && r.height > 0 && r.top >= 0 && r.left >= 0 && r.bottom <= innerHeight && r.right <= innerWidth;
    const hitEl = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    return { inView, hit: !!hitEl && b.contains(hitEl) };
  });
  return { inGear: gear.contains(dialog), onBody: dialog.parentElement.parentElement === document.body, buttons };
})()`;

/** 一条横条量出来的（CSS 像素，相对视口）：横条、它那一列（内容框）、行尾箭头、箭头前面那个、会话视口的右边 */
interface RowBox {
  kind: "tool" | "letter" | "recall";
  text: string;
  left: number;
  right: number;
  colLeft: number;
  colRight: number;
  viewportRight: number;
  /** 行尾的箭头（›、详情 ›）；点不开的行没有 */
  arrow?: { left: number; right: number; width: number; hit: boolean; gap: number | undefined };
  overflow: number;
}

interface RowMeasure {
  thinkingLeft: number | undefined;
  rows: RowBox[];
}

/**
 * 在页面里量会话里看得见的每一条横条（.tool-sum：工具调用、来信、回忆记忆）和第一条"在想什么"（.thinking）的左边。
 * 横条先滚到视口中间再量箭头点不点得到（elementFromPoint 落在这条横条里）；gap 是箭头和它前面那个之间的空（同一行时）
 */
const MEASURE_ROWS = `(() => {
  const vis = (el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
  const thinking = Array.from(document.querySelectorAll(".msg .thinking")).find(vis);
  const rows = [];
  for (const row of document.querySelectorAll(".msg .tool-sum")) {
    if (!vis(row)) continue;
    row.scrollIntoView({ block: "center" });
    const r = row.getBoundingClientRect();
    const col = row.parentElement;
    const cs = getComputedStyle(col);
    const cr = col.getBoundingClientRect();
    const colLeft = cr.left + parseFloat(cs.borderLeftWidth) + parseFloat(cs.paddingLeft);
    const colRight = cr.right - parseFloat(cs.borderRightWidth) - parseFloat(cs.paddingRight);
    const viewport = row.closest(".zh-viewport") ?? document.documentElement;
    const kind = row.classList.contains("letter-line") ? "letter" : row.classList.contains("recall-line") ? "recall" : "tool";
    const box = { kind, text: row.textContent.trim().slice(0, 24), left: r.left, right: r.right, colLeft, colRight, viewportRight: viewport.getBoundingClientRect().right, overflow: row.scrollWidth - row.clientWidth };
    const arrow = row.querySelector(".tool-more, .letter-more");
    if (arrow) {
      const a = arrow.getBoundingClientRect();
      const hitEl = document.elementFromPoint(a.left + a.width / 2, a.top + a.height / 2);
      const prev = arrow.previousElementSibling ? arrow.previousElementSibling.getBoundingClientRect() : undefined;
      const sameLine = prev && Math.abs(prev.top + prev.height / 2 - (a.top + a.height / 2)) < a.height / 2;
      box.arrow = { left: a.left, right: a.right, width: a.width, hit: !!hitEl && hitEl.closest(".tool-sum") === row, gap: sameLine ? a.left - prev.right : undefined };
    }
    rows.push(box);
  }
  return { thinkingLeft: thinking ? thinking.getBoundingClientRect().left : undefined, rows };
})()`;

/** 对话气泡最宽占那一列的几成（styles/pages.css 的 .msg.assistant .part-text） */
const BUBBLE_SHARE = 0.92;

/** 两个位置差不到 1 像素（亚像素取整） */
const near = (a: number, b: number) => Math.abs(a - b) <= 1;

/** 一条横条哪里不对（275 号票） */
function rowProblems(name: string, r: RowBox, thinkingLeft: number | undefined): string[] {
  const out: string[] = [];
  if (thinkingLeft !== undefined && !near(r.left, thinkingLeft)) out.push(`${name}：左边 ${r.left.toFixed(1)}，"在想什么"那条是 ${thinkingLeft.toFixed(1)}，不在同一列`);
  const bubbleRight = r.colLeft + (r.colRight - r.colLeft) * BUBBLE_SHARE;
  if (r.right > bubbleRight + 1) out.push(`${name}：右边 ${r.right.toFixed(1)} 超过了对话气泡最宽处 ${bubbleRight.toFixed(1)}（右边没留空）`);
  if (r.right > r.viewportRight) out.push(`${name}：右边 ${r.right.toFixed(1)} 超出了会话视口 ${r.viewportRight.toFixed(1)}`);
  if (r.overflow > 1) out.push(`${name}：里面的东西比横条宽 ${r.overflow} 像素（被挤出去了）`);
  const a = r.arrow;
  if (a) {
    if (a.width <= 0 || a.left < r.left - 0.5 || a.right > r.right + 0.5) out.push(`${name}：箭头 ${a.left.toFixed(1)}..${a.right.toFixed(1)} 没整个露在横条 ${r.left.toFixed(1)}..${r.right.toFixed(1)} 里`);
    if (!a.hit) out.push(`${name}：箭头点不到（被别的东西盖住了）`);
    if (a.gap !== undefined && a.gap > 16) out.push(`${name}：箭头离前面的字 ${a.gap.toFixed(1)} 像素，没紧跟着字`);
  }
  return out;
}
