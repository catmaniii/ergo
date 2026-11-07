// 打开页面不崩（2026-10-18 用户要求：改了代码起码自己用网页打开看一下）：照 vite.config.ts 按生产环境构建一遍演示页（--mode demo），存成临时文件，
// 用 file:// 在真 Chrome 里打开（不经守护进程，前端走原型的假数据），手机宽、电脑宽各一遍，挨个切到每一页（主导航各项、"更多"
// 下面各页、任务和项目的详情），再开一遍侧边栏模式（?ergo=side）。页面抛出没接住的错误（React 崩了整页白屏——
// 比如 useSyncExternalStore 的 snapshot 每次给新对象、无限重渲）或某一页一个字都没有，就算失败。
// 原型打开时取不到的媒体文件（ERR_FILE_NOT_FOUND）不算。本机没有 Chrome（或 Edge）时跳过。
// 英文再走一遍（原型地址带 ?lang=en）：同样每一页都打得开、有字、不报错，已经迁成多语言的地方（EN_DONE）一个中文字都不能有；
// 再在中文下打开设置 · 语言点 English，导航不刷新就换成英文。迁完一块就往 EN_DONE 里加。
// 再走一遍停用记忆、提醒插件的（原型地址带 ?demo-plugins-off=memory,reminders）。
// 日历也是插件：停用日历插件（?demo-plugins-off=calendar）后导航、"更多"、工作日规则、待办里都没有去日历的入口，#/calendar 写没启用。
// 语音也是插件：停用语音插件（?demo-plugins-off=voice）后输入框没有话筒、设置里没有语音，#/more/voice 写没启用，每一页照样打得开。
// 加了停用浏览插件的（"浏览"、侧边栏模式写没启用）。
// 每套风格量聊天里工具调用、来信、回忆记忆的横条（和"在想什么"同一列、右边留空、窄窗口下箭头露全点得到），
// 侧边栏模式收到交来的外观马上换风格。
// 小屏和手机上，会话缩小后点开的分支整块留在视口里。
// 标题上的"等你……"手机、电脑都看得到、点得到，点了跳到要处理的那张卡、闪一下，再点一次再闪；卡在别的页的跳过去；答完就不再等你。
// 同一个 agent 不管从哪进去都是同一个对话框（标题栏、阶段条、输入框都在）；老的 #/tasks/<任务> 跳过去并定位；做完收成一行；背后的 agent 的列表和只读对话。
// 安装版（不带 --mode demo）被直接打开：只有一句"要经二狗打开"，中英跟系统语言，一个请求都不往外发。
// 手机 App 太旧（假的 ergoNative）：页面顶上一条提示，点了去下载或看教程；够新、不在 App 里没有；设备页写 App 的版本。
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

/** 挨个切到的页：主导航各项、"更多"下面各页、任务和项目的详情（原型假数据里有的）、内置浏览器里渲染的文件 */
const PAGES = [
  "#/secretary",
  "#/apps/demo/README.md",
  "#/secretary",
  "#/tasks",
  "#/tasks/t-photos",
  "#/projects",
  "#/projects/p-ledger",
  "#/projects/p-ledger/chat",
  // 规范上线之前建的旧作品集网站，"规范"一块下有一张等你选的"补齐规范文档"卡
  "#/projects/p-oldsite",
  // 项目内部任务的老地址换到项目的对话框；跨项目、不属于项目的任务有自己的页面
  "#/tasks/t-ledger-v1",
  "#/tasks/t-newpc",
  "#/tasks/t-bills",
  "#/inbox",
  "#/browse",
  "#/calendar",
  "#/more",
  ...MORE_PAGES.map((p) => `#/more/${p}`),
  // 记忆（是记忆插件的页面）、它的几栏（档案、结论、问题箱、素材）、记忆管理员的整页对话（会话、
  // 回忆了 N 条记忆、每晚整理日记）、成批删除
  "#/more/memory",
  ...MEMORY_ITEMS.map((i) => `#/more/memory/${i}`),
  // 档案里点开的一个人（原型的假档案）：本人、家人
  "#/more/memory/files/me",
  "#/more/memory/files/p-fake-mom",
  // 素材里点开的一条（原型的假素材）、成批删除里点开的一条
  "#/more/memory/materials/mat-fake-stale",
  "#/more/memory/materials-delete/mat-fake-recent-7",
  // 你存的网页（原型的假素材）：标题、网址、存下的正文
  "#/more/memory/materials/mat-fake-webpage",
  "#/more/memory/materials/mat-fake-recent-17",
  // 结论里点开的一条（证据与推理，并进结论；原型的假结论）：证据链、支持/反证、竞争解释、修订
  "#/more/memory/claims/cl-0001",
  "#/more/memory/claims/cl-0002",
  // 证据与推理的旧地址：换到结论
  "#/more/memory/evidence",
  "#/more/memory/evidence/cl-0001",
  // 个人档案（原型的假档案）：记忆插件在用时换到记忆 · 档案，停用时就是"更多"里的这一页
  "#/more/files/me",
  "#/more/files/p-fake-mom",
  // 数据源详情（原型编的数据源）：连着的、没连的、手机来的、没有这个的；共用的导入文件夹
  "#/more/data-sources/google-calendar",
  "#/more/data-sources/looki",
  // 地图（地图插件）：地图页、地址里带位置（新加坡）、设置 · 数据源 · 高德地图
  "#/more/data-sources/amap",
  "#/more/map",
  "#/more/map/1.2834%2C103.8607%2C14",
  "#/more/data-sources/phone-location",
  "#/more/data-sources/没有这个",
  // 设备配对的二维码界面
  "#/more/devices/qr",
  "#/more/data-sources/import_folder",
  // 设置里删除素材的旧地址：跳到记忆 · 素材
  "#/more/materials",
  "#/more/materials/mat-fake-recent-1",
];

/**
 * 英文下已经迁好的地方：在这一页上，这个元素里（去掉 except 挑出来的还没迁的部分、用户的内容）不能有中文。
 * 迁完一块就往这里加一行
 */
const EN_DONE: { hash: string; selector: string; except?: string; wideOnly?: boolean }[] = [
  // 外壳——导航（竖栏、横栏连同量长度的样本）、设置列表的各项（外观与风格的副标题是状态层的 appearanceSummary 加风格名）、"更多"、设置 · 语言（本地名"中文"、用户起的名字除外）
  { hash: "#/secretary", selector: "nav" },
  { hash: "#/more/settings", selector: ".topbar .title" },
  { hash: "#/more/settings", selector: "button[data-page]", except: '[data-page="appearance"] small' },
  // 四组的组标题（身份、能力、规则、数据与设备）
  { hash: "#/more/settings", selector: ".settings-group-head" },
  { hash: "#/more", selector: ".menu" },
  { hash: "#/more/language", selector: ".topbar .title" },
  { hash: "#/more/language", selector: ".language-page", except: '[lang="zh-CN"], .assistant-name' },
  // 界面组件（ui/、model/）——卡片的种类签、日期分隔、附件按钮、"详情"这类小链接、输入框（秘书的名字标签除外）、
  // 任务详情的阶段栏和待你处理的条、卡片上处理过的结果、立项要求变更的前后对照、提醒的浏览器通知开关。
  // 卡片的标题、正文、阶段名是二狗存下的内容（假数据的内容下面单独查），状态名、处置名是状态层和协议包的，不在这里查
  { hash: "#/secretary", selector: ".xcard-tag" },
  { hash: "#/secretary", selector: ".day-sep" },
  { hash: "#/secretary", selector: ".att-btns" },
  { hash: "#/secretary", selector: ".thinking-more, .tool-more, .card-more, .bubble-more" },
  { hash: "#/secretary", selector: ".composer", except: ".assistant-name" },
  { hash: "#/tasks/t-photos", selector: ".composer" },
  { hash: "#/tasks/t-photos", selector: ".ibar-n" },
  { hash: "#/tasks/t-photos", selector: ".stage-prog" },
  // 标题栏上的入口、背后的 agent 的说法（手机上入口只有图标和个数，全称在说明里）
  { hash: "#/tasks/t-newpc", selector: ".bg-entry-text", wideOnly: true },
  { hash: "#/projects/p-ledger/chat", selector: ".xcard-tag" },
  { hash: "#/projects/p-ledger/chat", selector: ".auth-result, .charter-diff-k" },
  { hash: "#/inbox", selector: ".notify-permission" },
  // 待办通知的动作按钮：存的是中文原字（按字认），显示时换成当前语言（协议包的 inboxActionText）
  { hash: "#/inbox/i-sjob", selector: ".auth-actions" },
  { hash: "#/inbox/i-backup", selector: ".auth-actions" },
  { hash: "#/inbox/i-app-outdated", selector: ".auth-actions" },
  // pages/ 里的字——各页的标题栏、分节标题、说明（名字标签是用户起的名字）。从状态层、ui/ 来的字（状态名、阶段名、标签、
  // 外观与风格的副标题、时间日期……）不算，原型的演示数据（任务名、项目名、素材……）是内容，这几处选得避开它们
  { hash: "#/browse", selector: ".chat-col" },
  { hash: "#/tasks", selector: ".topbar .title" },
  { hash: "#/tasks", selector: ".topbar .btn.primary" },
  { hash: "#/projects", selector: ".topbar" },
  { hash: "#/projects", selector: ".pwall-sum-row:last-child" },
  { hash: "#/projects", selector: ".pwall > .hint", except: ".assistant-name" },
  // 项目详情在档案里，手机上要点开才有（下面单独查）
  { hash: "#/projects/p-ledger", selector: ".sec-head", wideOnly: true },
  // 项目页上的"规范"一块（文档名、写了 / 只有模板 / 缺都是协议包的说法）
  { hash: "#/projects/p-ledger", selector: ".proj-standard", wideOnly: true },
  // "补齐规范文档"卡上的说明、缺的几份、两个按钮（项目名是内容，不在这里查）
  { hash: "#/projects/p-oldsite", selector: ".xcard-standard_backfill .xcard-body, .xcard-standard_backfill .auth-actions", wideOnly: true },
  { hash: "#/calendar", selector: ".cal-title" },
  { hash: "#/inbox", selector: ".topbar .title" },
  // 设置：身份组里的"我的名字"那一行（"个人助理的名字"2026-10-23 起不单独设了，改成默认角色的名字）
  { hash: "#/more/settings", selector: ".user-name-setting", except: ".assistant-name" },
  { hash: "#/more/settings", selector: ".tool-call-storage .btn" },
  // 设置里的"备份"；单独一页，状态、位置、时间、快照、按钮都在里面
  { hash: "#/more/settings", selector: "[data-page=backup]" },
  { hash: "#/more/backup", selector: ".backup-page .btn.primary" },
  { hash: "#/more/backup", selector: ".backup-place .btn" },
  { hash: "#/more/backup", selector: ".backup-verify" },
  { hash: "#/more/usage", selector: ".sec-head" },
  // 设置 · 插件（原型的假守护进程按打开时的语言给插件的说法）
  { hash: "#/more/plugins", selector: ".plugins-page" },
  // 设置 · Codex（和设置 · Claude Code 同一个页面，文字跟运行时走）
  { hash: "#/more/codex", selector: ".runtime-folder-page" },
  // 设置 · 组件——分节标题、上面那一排按钮、每块的状况小签、几行的键、按钮、清单签没签名（组件名、说明、值是守护进程给的内容，原型编的是中文）
  { hash: "#/more/components", selector: ".components-page .sec-head, .component-toolbar, .component-head .chip, .component-line dt, .component-actions, .component-manifest" },
  // 数据源一级页的组里"共用"、导入文件夹的小字；详情的分节标题、标签、现查那一行、设置里的开关名（名字、一句话是守护进程给的内容，原型编的是中文）
  { hash: "#/more/data-sources", selector: '.ds-card[data-source="import_folder"]' },
  { hash: "#/more/data-sources/google-calendar", selector: ".ds-detail .sec-head, .ds-detail .seg" },
  { hash: "#/more/data-sources/phone-contacts", selector: "[data-from-device]" },
  // 319b：设置 · 体检——八项的名字、事实、怎么修都是网页按语言拼的（演示页的数据是编的，路径和时间不是中文）
  { hash: "#/more/doctor", selector: ".doctor-page" },
  { hash: "#/more/memory", selector: ".memory-layers", except: ".assistant-name" },
  { hash: "#/more/memory/materials", selector: ".mat-search, .mat-count, .mat-range-nav button" },
  // 结论、证据与推理、问题箱——状态筛、顶上那几行、详情里的分节标题（结论的陈述、原话是内容，不在这里查）
  { hash: "#/more/memory/claims", selector: ".mem-filters" },
  { hash: "#/more/memory/claims", selector: ".mem-head" },
  { hash: "#/more/memory/claims/cl-0001", selector: ".dt-section h4" },
  // 记忆页顶上"和记忆管理员聊"那张卡、记忆管理员对话里输入框上面那一行、档案的四组
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
  // 授权的文件夹单独一页
  { hash: "#/more/authorized-folders", selector: ".sec-head" },
  { hash: "#/more/authorized-folders", selector: ".sys-note" },
  // 目录授权：说明、每条授权的标签和为什么给、使用记录（个人助理的名字是用户起的，不算）
  { hash: "#/more/folder-grants", selector: ".sec-head", except: ".assistant-name" },
  { hash: "#/more/folder-grants", selector: ".sys-note" },
  { hash: "#/more/folder-grants", selector: ".fg-row", except: ".assistant-name" },
  { hash: "#/more/folder-grants", selector: ".fg-use", except: ".assistant-name" },
  { hash: "#/more/browsing", selector: ".settings-link-row small" },
  { hash: "#/more/skills", selector: ".sec-head", except: ".assistant-name" },
  { hash: "#/more/debug", selector: ".page-placeholder" },
  // 状态层出的字——秘书页标题的前缀、工具调用组那一行（"调用了 N 个工具"）、外观的三个选项、搜索引擎、
  // 工具调用的完整内容占多大和保留规则（设置列表里那一项的两行小字）
  { hash: "#/secretary", selector: ".secretary-title-lead" },
  { hash: "#/secretary", selector: ".tool-sum-text" },
  { hash: "#/projects/p-ledger/chat", selector: ".tool-sum-text" },
  { hash: "#/more/appearance", selector: ".appearance-choice" },
  { hash: "#/more/browsing", selector: ".seg" },
  { hash: "#/more/settings", selector: ".tool-call-storage small" },
  { hash: "#/more/backup", selector: ".backup-lines" },
  // 协议包的说法——模型设置里各 agent 的名字（秘书那一行是名字标签）、怎么开会话的说明、思考档位，关注类别的各种处置
  { hash: "#/more/models", selector: ".model-agent-head > b", except: ".assistant-name" },
  { hash: "#/more/models", selector: ".model-agent-head small.muted:first-of-type" },
  { hash: "#/more/models", selector: ".model-agent-selects select" },
  // 2026-10-30：API key 按服务商逐条列出（每行的名字和"配没配"、从哪来）和连通测试那个按钮
  { hash: "#/more/models", selector: ".model-key-row, .model-test-actions" },
  { hash: "#/more/watch", selector: ".cat-row select" },
  // 个人档案——列表的说明和分节标题、一份档案里的字段名、分节标题、按钮（值、称呼、记下的事是内容，不在这里查）
  { hash: "#/more/files", selector: ".pf-intro, .pf-page .sec-head", except: ".assistant-name" },
  { hash: "#/more/files/p-fake-mom", selector: ".pf-label, .pf-page .sec-head, .pf-actions", except: ".assistant-name" },
  { hash: "#/secretary", selector: ".xcard-personal_file .auth-actions" },
];

/**
 * 英文演示里有意留的中文：选语言那里中文的本地名、配对页上中英并列的"语言 / Language"、
 * Looki 存到本地的真实文件名（语言文件里照实写的）、这里特地打开的不存在的数据源
 */
const EN_KEEPS_CHINESE = ["中文", "语言 / Language", "日记.md", "说明.txt", "没有这个"];

/** 英文演示里不查的：关于页的更新日志（CHANGELOG.md 只有中文，不是假数据）、名字记号之外的页面脚本和样式 */
const EN_SKIPS_CHINESE = ".about-log, script, style";

/** 中文（汉字、中文标点、全角符号） */
const CJK = /[　-〿㐀-䶿一-鿿豈-﫿！-｠]/;

let browser: Browser | undefined;
let pageUrl = "";
/** 安装版那份（不带 --mode demo）的 file:// 地址 */
let installUrl = "";
let tempDir = "";

/** 照 vite.config.ts 构建一份，不写盘；mode 是 demo 时是演示页那份 */
async function buildPage(mode?: string): Promise<string> {
  const result = await build({ root: WEB_ROOT, configFile: `${WEB_ROOT}/vite.config.ts`, logLevel: "silent", ...(mode ? { mode } : {}), build: { write: false } });
  const outputs = (Array.isArray(result) ? result : [result]) as Rolldown.RolldownOutput[];
  const page = outputs.flatMap((o) => o.output).find((f) => f.fileName === "index.html");
  if (page?.type !== "asset") throw new Error("构建产物里没有 index.html");
  return String(page.source);
}

beforeAll(async () => {
  if (!CHROME) return;
  // 和 npm run build:web、build:demo 一样按生产环境构建（vitest 把 NODE_ENV 设成了 test，Vite 会照它打开发版）
  vi.stubEnv("NODE_ENV", "production");
  let html: string;
  let installHtml: string;
  try {
    html = await buildPage("demo");
    installHtml = await buildPage();
  } finally {
    vi.unstubAllEnvs();
  }
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "ergo-page-opens-"));
  const file = path.join(tempDir, "index.html");
  fs.writeFileSync(file, html);
  pageUrl = pathToFileURL(file).href;
  const installFile = path.join(tempDir, "install.html");
  fs.writeFileSync(installFile, installHtml);
  installUrl = pathToFileURL(installFile).href;
  browser = await chromium.launch({ executablePath: CHROME });
}, 120_000);

// 关 Chrome 在机器忙（同时跑几份全量测试）时会超过默认的 10 秒，测试本身全过却挂在收尾上
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
    // 缺句子的提示（key 写错了，或者在模块顶层取了 t()——那时还没装上语言）也算报错
    if (m.type() === "warning" && m.text().startsWith("[i18n]")) errors.push(`缺句子：${m.text()}`);
  });
  await page.goto(pageUrl + search);
  return { page, errors };
}

async function bodyText(page: Page): Promise<string> {
  return (await page.innerText("body")).trim();
}

/** 手机宽上阶段条的把手现在的正中间 */
async function handleAt(page: Page) {
  const box = await page.locator(".md-grab").boundingBox();
  return { x: box!.x + box!.width / 2, y: box!.y + box!.height / 2 };
}

/** 抽屉到了这一档，松手之后不再跟手 */
async function expectMode(page: Page, mode: "half" | "full") {
  await page.locator(`.md.md-m-${mode}`).waitFor({ timeout: 5000 });
  expect(await page.locator(".md[data-drag]").count()).toBe(0);
}

/**
 * 网页上去日历的入口——导航和"更多"里的日历、#/calendar 那一页（日历还是"没启用"）、工作日规则里的"日历"链接、
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


describe.skipIf(!CHROME)("安装版被直接打开（file://）", () => {
  for (const { locale, title, how } of [
    { locale: "zh-CN", title: "这个页面要经二狗打开", how: "先在命令行运行 ergo start，再用浏览器打开 http://127.0.0.1:8810" },
    { locale: "en-US", title: "This page has to be opened through ergo", how: "Run ergo start in a terminal, then open http://127.0.0.1:8810 in your browser" },
  ]) {
    test(`${locale}：只有一句怎么打开，跟系统语言，没有导航、没有假数据，一个请求都不往外发`, async () => {
      const context = await browser!.newContext({ locale, viewport: { width: 390, height: 844 } });
      const page = await context.newPage();
      const errors: string[] = [];
      const outside: string[] = [];
      page.on("pageerror", (e) => errors.push(String(e)));
      page.on("console", (m) => {
        if ((m.type() === "error" && !m.text().startsWith("Failed to load resource")) || m.text().startsWith("[i18n]")) errors.push(m.text());
      });
      page.on("request", (r) => {
        if (!r.url().startsWith("file:") && !r.url().startsWith("data:")) outside.push(r.url());
      });
      page.on("websocket", (ws) => outside.push(ws.url()));
      await page.goto(installUrl);
      await page.locator('[data-testid="open-through-ergo"]').waitFor({ timeout: 10_000 });
      const text = await bodyText(page);
      expect(text).toContain(title);
      expect(text).toContain(how);
      expect(await page.locator("nav").count()).toBe(0);
      expect(await page.locator('a[href="http://127.0.0.1:8810"]').count()).toBe(1);
      // 等一下：真要连东西的话这时候也连了
      await page.waitForTimeout(500);
      expect(errors).toEqual([]);
      expect(outside).toEqual([]);
      await context.close();
    });
  }
});

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

  // 停用记忆、提醒插件（原型地址带 ?demo-plugins-off=…，假连接照守护进程报"在配置里停用了"）后每一页照样打得开；
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
    // 记忆页没了，"更多"里列出个人档案，#/more/files 就是那一页（能加人、点进去）
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

  // 记忆的结论、证据与推理、问题箱——空数据（?demo-memory-empty，库在、还没整理出东西）和
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
      // 证据与推理的旧地址换到结论
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

  // 2026-10-23 用户报过：记忆管理员的整页对话里"回忆了 N 条记忆""Agent 的想法"点整条没反应、行尾的 › 也没有——
  // 那一页当时没接详情（Conversation 没给 onDetail），行是灰的。这条守着：行能点、有 ›、点了右边开出"这次用到的记忆"
  test("记忆管理员的整页对话：回忆了 N 条记忆那一行能点、有 ›，点了右边开出这次用到的记忆", async () => {
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

  // 数据源分两层——一级是卡片（没有输入框、操作按钮），点卡片进单独全屏的详情（宽屏也不留设置的左栏），有返回、刷新后还在
  for (const [name, viewport, wide] of [
    ["手机宽", { width: 390, height: 844 }, false],
    ["电脑宽", { width: 1280, height: 800 }, true],
  ] as const) {
    test(`${name}：数据源一级 → 点卡片 → 二级（状态、设置、数据）→ 返回；已获取的点开到素材详情；现在能查到的现查、刷新；手机来的没有现查`, async () => {
      const { page, errors } = await open(viewport);
      const hash = () => page.evaluate("window.location.hash");
      await page.evaluate(`window.location.hash = "#/more/data-sources"`);
      await page.waitForSelector('.ds-card[data-source="google-calendar"]', { timeout: 5000 });
      // 一级：没有输入框和操作按钮；按插件分组；键盘能到
      expect(await page.locator(".data-sources-page input, .data-sources-page select, .data-sources-page textarea").count()).toBe(0);
      expect(await page.locator(".data-sources-page button:not(.ds-card)").count()).toBe(0);
      expect(await page.locator('.ds-group[data-plugin="google"] .ds-card').count()).toBe(3);
      await page.locator('.ds-card[data-source="looki"]').focus();
      await page.keyboard.press("Enter");
      await page.waitForSelector('[data-source-detail="looki"]', { timeout: 5000 });
      expect(await hash()).toBe("#/more/data-sources/looki");
      await page.locator(".topbar .icon-btn").first().click();
      await page.waitForSelector('.ds-card[data-source="google-calendar"]', { timeout: 5000 });
      expect(await hash()).toBe("#/more/data-sources");

      // 点卡片进二级：全屏（宽屏也没有设置的左栏）、三块、刷新后还在这一页
      await page.locator('.ds-card[data-source="google-calendar"]').click();
      await page.waitForSelector('[data-source-detail="google-calendar"]', { timeout: 5000 });
      expect(await hash()).toBe("#/more/data-sources/google-calendar");
      expect(await page.locator(".pane-list").count()).toBe(0);
      expect(await page.locator(".settings-group-head").count()).toBe(0);
      expect(await page.locator(".ds-detail .sec-head h3").allInnerTexts()).toEqual(["状态", "设置", "数据"]);
      expect(await page.locator('.topbar .title').first().innerText()).toContain("Google · 日历");
      // 够宽时两栏（数据在右边），窄屏纵向排（数据在下面）
      const side = (await page.locator(".ds-detail-side").boundingBox())!;
      const data = (await page.locator(".ds-detail-data").boundingBox())!;
      expect(wide ? data.x >= side.x + side.width : data.y >= side.y + side.height).toBe(true);
      await page.reload();
      await page.waitForSelector('[data-source-detail="google-calendar"]', { timeout: 5000 });
      expect(await page.locator('[role="switch"]').count()).toBe(2);
      expect(await page.locator('[data-block="settings"] .source-panel').count()).toBe(1);

      // 两个标签：已获取的（默认）、现在能查到的（切过去才现查，写明不存，能刷新）
      expect(await page.locator(".ds-detail .seg button").allInnerTexts()).toEqual(["已获取的", "现在能查到的"]);
      await page.waitForSelector(".ds-stored .ds-item", { timeout: 5000 });
      await page.locator(".ds-detail .seg button", { hasText: "现在能查到的" }).click();
      await page.waitForSelector(".ds-live .ds-item", { timeout: 5000 });
      expect(await page.locator(".ds-live-note").innerText()).toContain("不会存进二狗");
      await page.locator('[data-action="live-refresh"]').click();
      await page.waitForSelector(".ds-live .ds-item", { timeout: 5000 });

      // 导入开关、立即同步能用
      await page.locator('[role="switch"]').first().click();
      await page.waitForSelector('[role="status"]', { timeout: 5000 });
      await page.locator('[data-block="status"] .btn.primary').click();
      await page.waitForFunction(`document.querySelector('[data-block="status"]')?.textContent?.includes("同步好了")`, undefined, { timeout: 5000 });

      // 断开要确认：确认框出来，取消后还在
      await page.locator('[data-block="settings"] .plugin-actions .btn', { hasText: "断开" }).click();
      await page.waitForSelector(".modal", { timeout: 5000 });
      await page.locator(".modal .btn.ghost").click();
      expect(await page.locator(".modal").count()).toBe(0);

      // Gmail：列表没有正文，点开一封才取
      await page.evaluate(`window.location.hash = "#/more/data-sources/google-gmail"`);
      await page.waitForSelector('[data-source-detail="google-gmail"]', { timeout: 5000 });
      await page.locator(".ds-detail .seg button", { hasText: "现在能查到的" }).click();
      await page.waitForSelector(".ds-live .ds-item-box", { timeout: 5000 });
      expect(await page.locator(".ds-item-text").count()).toBe(0);
      await page.locator(".ds-live .ds-item-box .ds-item").first().click();
      await page.waitForSelector(".ds-item-text", { timeout: 5000 });
      // 344：再加一个账号，现查一个账号一组；断开一个要确认，确认框写的是那个账号，另一个还在
      await page.locator('.gmail-panel input[type="email"]').fill("work.mail@example.org");
      await page.locator('.gmail-panel input[type="password"]').fill("abcd efgh ijkl mnop");
      await page.locator(".gmail-panel .btn.primary").click();
      await page.waitForFunction(`document.querySelectorAll(".gmail-account").length === 2`, undefined, { timeout: 5000 });
      await page.locator('[data-action="live-refresh"]').click();
      await page.waitForFunction(`document.querySelectorAll("[data-live-group]").length === 2`, undefined, { timeout: 5000 });
      await page.locator('.gmail-account [aria-label="断开账号 work.mail@example.org"]').click();
      await page.waitForSelector(".modal", { timeout: 5000 });
      expect(await page.locator(".modal").innerText()).toContain("别的账号不受影响");
      await page.locator(".modal .btn.primary").click();
      await page.waitForFunction(`document.querySelectorAll(".gmail-account").length === 1`, undefined, { timeout: 5000 });

      // 进素材的：点开到素材详情，‹ 回到这里
      await page.evaluate(`window.location.hash = "#/more/data-sources/demo-camera"`);
      await page.waitForSelector('[data-source-detail="demo-camera"]', { timeout: 5000 });
      await page.waitForSelector(".ds-stored button.ds-item", { timeout: 5000 });
      await page.locator(".ds-stored button.ds-item").first().click();
      await page.waitForSelector(".mat-detail", { timeout: 5000 });
      expect(await hash()).toMatch(/^#\/more\/memory\/materials\/mat-fake-source-/);
      await page.locator(".topbar .icon-btn").last().click();
      await page.waitForSelector('[data-source-detail="demo-camera"]', { timeout: 5000 });

      // 手机来的：只有已获取的，写明数据由手机交来；原始数据能按天清（点两下）
      await page.evaluate(`window.location.hash = "#/more/data-sources/phone-location"`);
      await page.waitForSelector('[data-source-detail="phone-location"]', { timeout: 5000 });
      expect(await page.locator(".ds-detail .seg").count()).toBe(0);
      expect(await page.locator("[data-from-device]").innerText()).toContain("数据由手机上的二狗 App 交来");
      expect(await page.locator(".ds-live").count()).toBe(0);
      await page.locator('[data-raw="phone-location"] summary').click();
      const days = await page.locator(".source-raw-days li").count();
      await page.locator(".source-raw-days li .btn").first().click();
      await page.locator(".source-raw-days li .btn").first().click();
      await page.waitForFunction(`document.querySelectorAll(".source-raw-days li").length === ${days - 1}`, undefined, { timeout: 5000 });

      // 导入文件夹：Google · 联系人的详情里有，一级页最后一张卡也进得去；id 不存在写一句、能回去
      await page.evaluate(`window.location.hash = "#/more/data-sources/google-contacts"`);
      await page.waitForSelector('[data-folder="google-contacts"]', { timeout: 5000 });
      await page.evaluate(`window.location.hash = "#/more/data-sources/import_folder"`);
      await page.waitForSelector(".import-path", { timeout: 5000 });
      await page.evaluate(`window.location.hash = "#/more/data-sources/没有这个"`);
      await page.waitForSelector("[data-missing-source]", { timeout: 5000 });
      await page.locator("[data-missing-source] .btn").click();
      await page.waitForSelector('.ds-card[data-source="google-calendar"]', { timeout: 5000 });
      await page.close();
      expect(errors).toEqual([]);
    }, 60_000);
  }

  test("停用记忆插件（?demo-plugins-off=memory）：数据源详情里点开一条素材去内核的素材详情，‹ 回到数据源详情", async () => {
    const { page, errors } = await open({ width: 1280, height: 800 }, "?demo-plugins-off=memory");
    await page.evaluate(`window.location.hash = "#/more/data-sources"`);
    await page.waitForSelector('.ds-card[data-source="demo-camera"]', { timeout: 5000 });
    await page.locator('.ds-card[data-source="demo-camera"]').click();
    await page.waitForSelector(".ds-stored button.ds-item", { timeout: 5000 });
    await page.locator(".ds-stored button.ds-item").first().click();
    await page.waitForSelector(".mat-detail", { timeout: 5000 });
    expect(await page.evaluate("window.location.hash")).toMatch(/^#\/more\/materials-delete\/mat-fake-source-/);
    await page.locator('.topbar [aria-label="返回"]').last().click();
    await page.waitForSelector('[data-source-detail="demo-camera"]', { timeout: 5000 });
    await page.close();
    expect(errors).toEqual([]);
  }, 60_000);

  // 记忆页的栏目重排（看过对照图定的）
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

  // 地图页（429）：演示页里当作填了高德 Key，国内那一处用假的高德（占位底图），新加坡用 OpenStreetMap（占位瓦片）；
  // 点地点、地址里带位置都会自动换底图；OSM 有署名角标；深色时 OSM 的瓦片加滤镜；一个请求都不往外发（不连高德、不连 OSM）
  for (const [name, viewport] of [
    ["手机宽", { width: 390, height: 844 }],
    ["电脑宽", { width: 1280, height: 800 }],
  ] as const) {
    test(`地图页${name}：国内高德、新加坡 OpenStreetMap，点地点、改地址自动换底图，有署名，深色加滤镜，不往外发请求`, async () => {
      const { page, errors } = await open(viewport);
      const outside: string[] = [];
      page.on("request", (r) => {
        if (!/^(?:file|data|blob):/.test(r.url())) outside.push(r.url());
      });
      await page.evaluate(`window.location.hash = "#/more/map"`);
      const canvas = page.locator(".map-canvas");
      await page.locator('.map-canvas[data-basemap="amap"]').waitFor({ timeout: 5000 });
      expect(await page.locator(".map-badge").innerText()).toBe("高德地图");
      await page.locator('[data-engine="amap"] .map-tiles img').first().waitFor({ timeout: 5000 });
      expect(await page.locator('[data-engine="amap"] .map-mark[data-id="demo-west-lake"]').count()).toBe(1);
      // 点新加坡：换成 OpenStreetMap，右下角有署名
      await page.locator('[data-place="demo-marina-bay"]').click();
      await page.locator('.map-canvas[data-basemap="osm"]').waitFor({ timeout: 5000 });
      expect(await page.locator(".map-badge").innerText()).toBe("OpenStreetMap");
      expect(await page.locator(".map-attribution").innerText()).toContain("© OpenStreetMap 贡献者");
      await page.locator('[data-engine="osm"] .map-tiles img').first().waitFor({ timeout: 5000 });
      // 放大一级：还是新加坡、还是 OSM
      await page.locator('.map-zoom button[aria-label="放大"]').click();
      expect(await canvas.getAttribute("data-basemap")).toBe("osm");
      // 点回西湖：换回高德
      await page.locator('[data-place="demo-west-lake"]').click();
      await page.locator('.map-canvas[data-basemap="amap"]').waitFor({ timeout: 5000 });
      // 地址里带着新加坡：跳过去、换成 OSM
      await page.evaluate(`window.location.hash = "#/more/map/1.29%2C103.85%2C13"`);
      await page.locator('.map-canvas[data-basemap="osm"]').waitFor({ timeout: 5000 });
      // 深色：OSM 的瓦片那一层加滤镜
      await page.evaluate(`localStorage.setItem("ergo-theme", "dark")`);
      await page.reload();
      await page.evaluate(`window.location.hash = "#/more/map/1.29%2C103.85%2C13"`);
      await page.locator('.map-canvas[data-basemap="osm"]').waitFor({ timeout: 5000 });
      expect(await page.evaluate(`getComputedStyle(document.querySelector(".map-osm.dark .map-tiles")).filter`)).toContain("invert");
      await page.evaluate(`localStorage.removeItem("ergo-theme")`);
      await page.close();
      expect(outside).toEqual([]);
      expect(errors).toEqual([]);
    }, 60_000);
  }

  // 我的足迹（430）：演示页里今天空着，自己跳到昨天（三处停留、照片小点、常去的地方的圈、轨迹）；手机宽点停留点出详情卡、点概况看列表，
  // 电脑宽左边列这一天、点一行展开详情；前一天空着写"这一天没有足迹"、给最近有足迹的一天；"足迹"开关关了不画；一个请求都不往外发
  /** 手机宽：点停留点出详情卡，关上，点概况看列表 */
  async function footprintCard(page: Page) {
    await page.locator('.map-mark[data-kind="stay"]').nth(2).click();
    const card = page.locator(".map-day-card");
    await card.waitFor({ timeout: 5000 });
    expect(await card.innerText()).toMatch(/杭州市西湖区北山街[\s\S]*18:10–20:30[\s\S]*待了 2 小时 20 分[\s\S]*这里拍了 4 张照片/);
    await card.locator('button[aria-label="关上"]').click();
    await page.locator("button.map-day-summary").click();
    expect(await page.locator('.map-day-card .map-day-entry[data-kind="stay"]').count()).toBe(3);
  }
  /** 电脑宽：左边列这一天，点一行展开详情 */
  async function footprintPanel(page: Page) {
    const entries = page.locator('.map-day-panel .map-day-entry[data-kind="stay"]');
    expect(await entries.count()).toBe(3);
    await entries.nth(1).locator("button").click();
    expect(await page.locator(".map-day-panel .map-day-detail").innerText()).toMatch(/公司[\s\S]*杭州市西湖区天目山路[\s\S]*待了 8 小时 40 分/);
  }
  for (const [name, viewport, details] of [
    ["手机宽", { width: 390, height: 844 }, footprintCard],
    ["电脑宽", { width: 1280, height: 800 }, footprintPanel],
  ] as const) {
    test(`地图页的足迹${name}：自己跳到最近有足迹的一天，停留、照片、范围圈都画上，点停留看详情，换日期、关开关，不往外发请求`, async () => {
      const { page, errors } = await open(viewport);
      const outside: string[] = [];
      page.on("request", (r) => {
        if (!/^(?:file|data|blob):/.test(r.url())) outside.push(r.url());
      });
      await page.evaluate(`window.location.hash = "#/more/map"`);
      const stays = page.locator('.map-mark[data-kind="stay"]');
      await stays.first().waitFor({ timeout: 5000 });
      const yesterday = (await page.evaluate(`(() => { const d = new Date(); d.setDate(d.getDate() - 1); return [d.getFullYear(), String(d.getMonth() + 1).padStart(2, "0"), String(d.getDate()).padStart(2, "0")].join("-"); })()`)) as string;
      expect(await page.locator(".map-day-date").inputValue()).toBe(yesterday);
      expect(await stays.count()).toBe(3);
      expect(await page.locator('.map-mark[data-kind="photo"]').count()).toBeGreaterThanOrEqual(3);
      expect(await page.locator('.map-mark[data-id^="fp-place-"]').innerText()).toBe("健身房");
      expect(await page.locator(".map-shapes circle").count()).toBe(3);
      expect(await page.locator(".map-shapes polyline").count()).toBe(1);
      expect(await page.locator(".map-day-summary").innerText()).toContain("待过 3 个地方");
      await details(page);
      // 前一天：空着，给最近有足迹的一天（四天前：家、健身房）
      await page.locator('.map-day-pick button[aria-label="前一天"]').click();
      await page.getByText("这一天没有足迹").waitFor({ timeout: 5000 });
      expect(await stays.count()).toBe(0);
      await page.locator(".map-day-note .btn").click();
      await page.locator('.map-mark[data-id="fp-stay-demo-fp-gym"]').waitFor({ timeout: 5000 });
      expect(await stays.count()).toBe(2);
      // "足迹"开关：关了不画，开回来又有
      await page.locator(".map-day-layer").click();
      expect(await page.locator(".map-day-layer").getAttribute("aria-pressed")).toBe("false");
      expect(await page.locator('.map-mark[data-id^="fp-"]').count()).toBe(0);
      await page.locator(".map-day-layer").click();
      await stays.first().waitFor({ timeout: 5000 });
      await page.close();
      expect(outside).toEqual([]);
      expect(errors).toEqual([]);
    }, 60_000);
  }

  // 日历插件停用时网页上没有日历入口；默认全开时都在
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

  // 语音插件停用时输入框没有话筒（一律打字）、设置里没有语音；默认全开时都在
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

  test.each([
    ["手机", { width: 390, height: 844 }],
    ["电脑", { width: 1280, height: 800 }],
  ])("%s宽：标题上的等你回答提问看得到、能点，点了定位到提问卡；相册库的等你批准跳到任务里那张卡；答完不再等你", async (_what, viewport) => {
    const { page, errors } = await open(viewport);
    const go = (hash: string) => page.evaluate(`window.location.hash = ${JSON.stringify(hash)}`);
    const hash = () => page.evaluate("window.location.hash");
    const flashed = page.locator(".dp-flash, .flash").first();
    try {
      await go("#/secretary");
      const jump = page.locator(".topbar a.act-jump");
      await jump.waitFor();
      expect(await jump.getAttribute("href")).toBe("#/secretary/at/c-q-1");
      expect(await jump.locator(".act-text").textContent()).toBe("等你回答提问");
      // 整个看得到（没有被挤出标题栏），有 ›，有下划线
      const box = (await jump.boundingBox())!;
      expect(box.x + box.width).toBeLessThanOrEqual(viewport.width);
      expect(await page.evaluate(`getComputedStyle(document.querySelector(".topbar a.act-jump .act-text")).textDecorationLine`)).toBe("underline");
      expect(await jump.locator(".act-go").textContent()).toBe("›");
      expect(await jump.locator(".act-text").evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
      // 手机上名字也放得下（标题栏挤，发起任务只留 ＋）
      expect(await page.locator(".topbar .secretary-title .assistant-name").evaluate((el) => el.scrollWidth <= el.clientWidth + 1)).toBe(true);

      await jump.click();
      expect(await hash()).toBe("#/secretary/at/c-q-1");
      await flashed.waitFor({ timeout: 5000 });
      // 确认按钮就在眼前
      const answer = page.locator('.xcard:has-text("去几天") button:has-text("全按推荐")').first();
      const composerTop = (await page.locator(".composer").first().boundingBox())!.y;
      await expect.poll(async () => {
        const btn = (await answer.boundingBox())!;
        return btn.y >= 0 && btn.y + btn.height <= composerTop;
      }, { timeout: 5000 }).toBe(true);

      // 闪完了再点一次：地址没变，照样再闪一下
      await flashed.waitFor({ state: "detached", timeout: 5000 });
      await jump.click();
      await flashed.waitFor({ timeout: 5000 });
      expect(await hash()).toBe("#/secretary/at/c-q-1");

      // 待办里有对应的一条，"去看看"到同一个地方
      await go("#/inbox/i-q");
      await page.locator('.inbox-jump a[href="#/secretary/at/c-q-1"]').waitFor();

      // 相册库的负责人等你批准：卡在任务「家庭照片整理与去重」里，跳过去
      await go("#/projects/p-photos");
      const approval = page.locator("a.act-jump").first();
      await approval.waitFor();
      expect(await approval.getAttribute("href")).toBe("#/tasks/t-photos/at/c-appr-1");
      await approval.click();
      await flashed.waitFor({ timeout: 5000 });
      // 项目内部任务没有单独的页面，换到项目的对话框、定位到这个任务和那张卡
      expect(await hash()).toBe("#/projects/p-photos/tasks/t-photos/at/c-appr-1");

      // 答完：标题不再说等你，不再是链接
      await go("#/secretary");
      await jump.waitFor();
      await answer.click();
      await jump.waitFor({ state: "detached", timeout: 5000 });
      expect(await page.locator(".topbar .act").first().getAttribute("class")).toContain("act-sleeping");
      expect(errors).toEqual([]);
    } finally {
      await page.close();
    }
  }, 60_000);

  // 不管点哪里进去，同一个 agent 的对话框看起来都一样
  test.each([
    ["手机", { width: 390, height: 844 }],
    ["电脑", { width: 1280, height: 800 }],
  ])("%s宽：项目内部任务从项目卡片、任务链接、待办进去是同一个界面（标题栏、阶段条、输入框都在）；老的 #/tasks/<任务> 跳过去并定位", async (_what, viewport) => {
    const { page, errors } = await open(viewport);
    const go = (to: string) => page.evaluate(`window.location.hash = ${JSON.stringify(to)}`);
    const hash = () => page.evaluate("window.location.hash");
    /** 对话框的样子：标题、阶段标签、输入框 */
    const dialog = async () => {
      await page.locator("[data-agent-dialog] .composer").waitFor();
      return {
        agent: await page.locator("[data-agent-dialog]").getAttribute("data-agent-dialog"),
        title: await page.locator(".topbar .th-name").first().innerText(),
        stage: await page.locator('[data-stage-bar="live"] .stage-chip').count(),
        // 手机是顶部的阶段条，宽屏是左边栏里的整张图
        rail: await page.locator(".stage-bar-line + .md .rail, .md-side-graph").count(),
        composer: await page.locator(".composer textarea").count(),
      };
    };
    try {
      await go("#/projects");
      await page.locator('.pfile:has-text("相册库") .pfile-hit').click();
      expect(await hash()).toBe("#/projects/p-photos");
      const fromCard = await dialog();
      expect(fromCard).toEqual({ agent: "project-photos", title: "相册库", stage: 1, rail: 1, composer: 1 });

      // 老的任务链接：跳到项目的对话框、定位到这个任务（同一个界面）
      await go("#/tasks/t-photos");
      await page.waitForFunction(`window.location.hash === "#/projects/p-photos/tasks/t-photos"`, undefined, { timeout: 5000 });
      expect(await dialog()).toEqual(fromCard);
      // 带 at 的定位到那一条
      await go("#/tasks/t-photos/at/c-appr-1");
      await page.waitForFunction(`window.location.hash === "#/projects/p-photos/tasks/t-photos/at/c-appr-1"`, undefined, { timeout: 5000 });
      expect(await dialog()).toEqual(fromCard);
      await page.locator(".dp-flash, .flash").first().waitFor({ timeout: 5000 });
      // 待办里的"去看看 ›"：地址还是任务的，点了到同一个界面
      await go("#/inbox/i-appr");
      await page.locator('.inbox-jump a[href^="#/tasks/t-photos"]').click();
      await page.waitForFunction(`window.location.hash.startsWith("#/projects/p-photos/tasks/t-photos")`, undefined, { timeout: 5000 });
      expect(await dialog()).toEqual(fromCard);

      // 手机上不再多一层项目页：档案点标题滑进来；宽屏就在左边。档案里有项目的详情和内部任务（排队的也在），点了定位到它
      const phone = viewport.width < 900;
      expect(await page.locator(".proj-side").count()).toBe(phone ? 0 : 1);
      // 宽屏：在做的任务左边栏先是阶段进展，点"项目档案"换过来
      await page.locator(phone ? ".th-name-link" : ".proj-side-chip").click();
      await page.locator(phone ? ".dp-page.at-detail .proj-head" : ".proj-side .proj-head").waitFor();
      expect(await page.locator("[data-task-brief=t-photos]").count()).toBe(1);

      // 跨项目的、不属于项目的任务：自己的页面，同一个组件
      await go("#/tasks/t-newpc");
      await page.locator("[data-agent-dialog] .composer").waitFor();
      expect(await hash()).toBe("#/tasks/t-newpc");
      // 宽屏刚才换成了档案，这台设备记住了，这里左边栏也先是档案
      expect(await dialog()).toMatchObject({ title: "换新电脑：把旧电脑的资料搬过去", stage: 1, rail: phone ? 1 : 0, composer: 1 });
      // 原型的假任务也是
      await go("#/tasks/t-bills");
      await page.locator("[data-agent-dialog]").waitFor();
      expect(errors).toEqual([]);
    } finally {
      await page.close();
    }
  }, 60_000);

  test.each([
    ["手机", { width: 390, height: 844 }],
    ["电脑", { width: 1280, height: 800 }],
  ])("%s宽：阶段进展（手机在对话框顶部，宽屏在左边栏），点一个阶段看交付件和验收标准；做完收起来，点开能看；没有任务不占地方", async (_what, viewport) => {
    const { page, errors } = await open(viewport);
    const go = (to: string) => page.evaluate(`window.location.hash = ${JSON.stringify(to)}`);
    try {
      // 记账本：首个建设任务做完了，收成一行
      await go("#/projects/p-ledger");
      const done = page.locator('[data-stage-bar="done"] .stage-chip');
      await done.waitFor();
      expect(await done.innerText()).toContain("首版已完成");
      const phone = viewport.width < 900;
      const graph = phone ? ".md .rail" : ".md-side-graph";
      expect(await page.locator(graph).count()).toBe(0);
      await done.click();
      await page.locator(graph).waitFor();
      await page.locator(phone ? '.rail-node:has-text("按月出报表")' : '.md-side-graph :text("按月出报表")').first().click();
      const stage = viewport.width < 900 ? page.locator(".dp-page.at-detail") : page.locator(".pane-detail");
      await stage.waitFor();
      await expect.poll(() => stage.innerText(), { timeout: 5000 }).toContain("九月份月报的合计和银行对账单对得上");
      expect(await stage.innerText()).toContain("月报模板");
      // 没有任务（家庭网盘）：阶段条不占地方，标题栏写项目的状态
      await go("#/projects/p-netdisk");
      await page.locator('[data-agent-dialog="project-netdisk"] .composer').waitFor();
      expect(await page.locator(".stage-bar-line").count()).toBe(0);
      expect(await page.locator(".topbar .pst").count()).toBe(1);
      expect(errors).toEqual([]);
    } finally {
      await page.close();
    }
  }, 60_000);

  // 宽屏的阶段进展和档案抢一个左边栏，不同时显示；两边用同一个宽度，× 了就都不占
  test("电脑宽：阶段进展和档案共用左边栏，点谁显示谁，× 了空出来，刷新后记得", async () => {
    const { page, errors } = await open({ width: 1280, height: 800 });
    const head = () => page.locator(".md-side .md-side-head span").first().innerText();
    const chip = page.locator(".topbar .stage-head-chip .stage-chip");
    try {
      await page.evaluate(`window.location.hash = "#/tasks/t-newpc"`);
      await page.locator(".md-side-graph").waitFor();
      expect(await page.locator(".md-side").count()).toBe(1);
      expect(await head()).toBe("阶段进展");
      expect(await page.locator(".stage-bar-line").count()).toBe(0);
      // 点档案：顶替阶段进展
      await page.locator(".proj-side-chip").click();
      await expect.poll(head).toBe("任务档案");
      expect(await page.locator(".md-side").count()).toBe(1);
      expect(await page.locator(".md-side-graph").count()).toBe(0);
      // 点阶段标签：换回来
      await chip.click();
      await page.locator(".md-side-graph").waitFor();
      expect(await page.locator(".md-side").count()).toBe(1);
      // 换来换去宽度不变
      const width = await page.locator(".md-side").evaluate((el) => el.getBoundingClientRect().width);
      await page.locator(".proj-side-chip").click();
      await expect.poll(head).toBe("任务档案");
      expect(await page.locator(".md-side").evaluate((el) => el.getBoundingClientRect().width)).toBe(width);
      // ×：左边栏空出来，再进来也是空的
      await page.locator(".md-side-close").click();
      await expect.poll(() => page.locator(".md-side").count()).toBe(0);
      await page.reload();
      await page.locator("[data-agent-dialog] .composer").waitFor();
      expect(await page.locator(".md-side").count()).toBe(0);
      // 点阶段标签打开，刷新后还是它
      await chip.click();
      await page.locator(".md-side-graph").waitFor();
      await page.reload();
      await page.locator(".md-side-graph").waitFor();
      expect(errors).toEqual([]);
    } finally {
      await page.close();
    }
  }, 60_000);

  // 把手没有 pointer capture 时，鼠标拖出把手（约 80px）松手，松手算不到它头上，整个计划打不开，抽屉还停在跟手的位置
  test("手机宽：阶段条的把手用鼠标拖出把手再松手，整个计划能打开、能推回；只有手指时也一样", async () => {
    const viewport = { width: 390, height: 844 };

    // 鼠标
    const { page, errors } = await open(viewport);
    try {
      await page.evaluate(`window.location.hash = "#/tasks/t-newpc"`);
      await page.locator(".md.md-m-half .md-grab").waitFor();
      const mouseDrag = async (dy: number) => {
        const from = await handleAt(page);
        await page.mouse.move(from.x, from.y);
        await page.mouse.down();
        await page.mouse.move(from.x, from.y + dy, { steps: 12 });
        await page.mouse.up();
      };
      await mouseDrag(120);
      await expectMode(page, "full");
      await mouseDrag(-120);
      await expectMode(page, "half");
      // 拖一小段同样算数；拖过之后那一下 click 不算点击（不会又缩回去）
      await mouseDrag(24);
      await expectMode(page, "full");
      // 没怎么动就是点了一下：全开缩回半开
      const tap = await handleAt(page);
      await page.mouse.click(tap.x, tap.y);
      await expectMode(page, "half");
      expect(errors).toEqual([]);
    } finally {
      await page.close();
    }

    // 手指
    const touch = await browser!.newPage({ viewport, hasTouch: true, isMobile: true });
    try {
      await touch.goto(pageUrl);
      await touch.evaluate(`window.location.hash = "#/tasks/t-newpc"`);
      await touch.locator(".md.md-m-half .md-grab").waitFor();
      const cdp = await touch.context().newCDPSession(touch);
      const fingerDrag = async (dy: number) => {
        const from = await handleAt(touch);
        const point = (y: number) => [{ x: from.x, y }];
        await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: point(from.y) });
        for (let i = 1; i <= 12; i++) await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: point(from.y + (dy * i) / 12) });
        await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
      };
      await fingerDrag(120);
      await expectMode(touch, "full");
      await fingerDrag(-120);
      await expectMode(touch, "half");
    } finally {
      await touch.close();
    }
  }, 60_000);

  // 计划卡上没勾的操作那句话要按"有风险的事先问我"现在开没开写（新装时关着，超出授权的直接做）
  test("计划卡：没勾的操作怎样，按开关现在的状态写；阶段一律自动验收，卡上不再有由你验收", async () => {
    const { page, errors } = await open({ width: 1280, height: 800 });
    const go = (to: string) => page.evaluate(`window.location.hash = ${JSON.stringify(to)}`);
    try {
      await go("#/inbox/i-plan");
      const card = page.locator(".xcard-plan");
      await card.waitFor();
      await expect.poll(() => card.innerText(), { timeout: 5000 }).toContain("现在关着：超出授权的也直接做");
      expect(await card.innerText()).not.toContain("执行到那一步再问你");
      expect(await card.innerText()).not.toContain("由你验收");
      // 关着时勾掉一项也不算停点，"还会在 N 处停下来"这句压根不出现
      expect(await card.innerText()).not.toContain("处停下来");
      await card.locator(".grant-row input[type=checkbox]").first().uncheck();
      expect(await card.innerText()).not.toContain("处停下来");
      await card.locator(".grant-row input[type=checkbox]").first().check();

      await go("#/more/watch");
      await page.locator('[data-switch="conversationApprovals"] input').check();
      await go("#/inbox/i-plan");
      await expect.poll(() => page.locator(".xcard-plan").innerText(), { timeout: 5000 }).toContain("没勾的操作，执行到那一步再问你");
      expect(await page.locator(".xcard-plan").innerText()).not.toContain("现在关着");
      // 开着时一处停点都没有也不写"0 处"，勾掉一项才写 1 处
      expect(await page.locator(".xcard-plan").innerText()).not.toContain("处停下来");
      await page.locator(".xcard-plan .grant-row input[type=checkbox]").first().uncheck();
      expect(await page.locator(".xcard-plan").innerText()).toContain("授权后还会在 1 处停下来");
      expect(await page.locator(".xcard-plan").innerText()).toContain("勾掉了，不算授权");
      expect(errors).toEqual([]);
    } finally {
      await page.close();
    }
  }, 60_000);

  // 对话框里选项目建的内部任务不上任务看板，只有运营方案建的才上；不选项目的才在运营中一组
  test("发起任务：选了一个项目的定时、事件触发的不说在看板上，普通任务说结果在项目里看", async () => {
    const { page, errors } = await open({ width: 1280, height: 800 });
    try {
      await page.evaluate(`window.location.hash = "#/tasks"`);
      await page.locator(".topbar .btn.primary").click();
      const dialog = page.locator(":has(> .sc-actions)");
      await dialog.waitFor();
      const hints = () => dialog.locator(".hint").allInnerTexts().then((all) => all.join("\n"));
      const when = (name: string) => dialog.locator(".when-seg .seg-btn", { hasText: name }).click();
      const kind = (name: string) => dialog.locator(".sc-mode", { hasText: name }).first().click();
      const project = dialog.locator("label.check-row", { hasText: "记账本" });
      for (const [how, whenName] of [
        ["流程", "定时"],
        ["流程", "事件发生时"],
        ["普通任务", "定时"],
        ["普通任务", "事件发生时"],
      ] as const) {
        await kind(how);
        await when(whenName);
        await project.locator("input").uncheck();
        expect(await hints()).toContain("在看板的运营中一组");
        await project.locator("input").check();
        const inside = await hints();
        expect(inside).toContain("不上任务看板");
        expect(inside).not.toContain("在看板的运营中一组");
      }
      await kind("普通任务");
      await when("现在");
      await project.locator("input").check();
      const plain = await hints();
      expect(plain).toContain("只说一句做完了");
      expect(plain).not.toContain("转告");
      expect(errors).toEqual([]);
    } finally {
      await page.close();
    }
  }, 60_000);

  // 手机上项目页这一层没了，已归档的项目照它写的走得到取消归档
  test("手机宽：已归档的项目，点标题打开档案，里面有取消归档", async () => {
    const { page, errors } = await open({ width: 390, height: 844 });
    try {
      await page.evaluate(`window.location.hash = "#/projects/p-english"`);
      const note = page.locator(".composer-note");
      await note.waitFor();
      expect(await note.innerText()).toContain("点标题打开项目档案");
      expect(await note.innerText()).not.toContain("项目页");
      await page.locator(".th-name-link").click();
      await page.locator('.dp-page.at-detail button:has-text("取消归档")').waitFor({ timeout: 5000 });
      expect(errors).toEqual([]);
    } finally {
      await page.close();
    }
  }, 60_000);

  // 演示版演的是现在的行为
  describe("手机 App 的版本", () => {
    const HARMONY_UA = "Mozilla/5.0 (Phone; OpenHarmony 5.0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/114.0.0.0 Safari/537.36 ArkWeb/4.1.6.1 Mobile";
    const ANDROID_UA = "Mozilla/5.0 (Linux; Android 14; Pixel 8; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/120.0.0.0 Mobile Safari/537.36";
    const PHONE = { width: 390, height: 844 };

    /** 开一页；version 给了就是开在 App 里（假的原生桥），undefined 是手机浏览器 */
    async function openInApp(version: string | undefined, userAgent: string, search = "") {
      const context = await browser!.newContext({ viewport: PHONE, userAgent });
      if (version !== undefined) await context.addInitScript(`window.ergoNative = { appVersion: () => ${JSON.stringify(version)}, log() {} };`);
      const page = await context.newPage();
      const errors: string[] = [];
      page.on("pageerror", (e) => errors.push(String(e)));
      await page.goto(pageUrl + search);
      await page.locator("nav").first().waitFor();
      return { context, page, errors };
    }

    // 原型里二狗带着安卓安装包（假的 GET /api/app-update），安卓的按钮是"更新"：这个假原生桥没有 installAppUpdate（旧 App），是从二狗直接下载的链接
    test.each([
      ["安卓", ANDROID_UA, "", "更新", /^\/api\/app-update\/android\.apk$/, "二狗 App 需要升级到"],
      ["鸿蒙", HARMONY_UA, "", "看安装教程", /docs\/user-guide\/mobile\.md#%E9%B8%BF%E8%92%99-app$|mobile\.md#鸿蒙-app$/, "二狗 App 需要升级到"],
      ["安卓（英文）", ANDROID_UA, "?lang=en", "Update", /^\/api\/app-update\/android\.apk$/, "The ergo app needs updating to"],
      ["鸿蒙（英文）", HARMONY_UA, "?lang=en", "Installation guide", /mobile\.en\.md#harmonyos-app$/, "The ergo app needs updating to"],
    ])("太旧的 App，%s：手机宽上一条提示，按钮去对的地方、放得下", async (_name, ua, search, label, href, text) => {
      const { context, page, errors } = await openInApp("0.0.1", ua, search);
      try {
        const bar = page.locator(".app-upgrade-bar");
        await bar.waitFor();
        expect(await bar.innerText()).toContain(text);
        const link = bar.locator("a");
        expect((await link.innerText()).trim()).toBe(label);
        expect(await link.getAttribute("href")).toMatch(href);
        const box = (await link.boundingBox())!;
        expect(box.x + box.width).toBeLessThanOrEqual(PHONE.width);
        expect(errors).toEqual([]);
      } finally {
        await context.close();
      }
    }, 60_000);

    test("读不到版本的 App 算最旧：也有提示", async () => {
      const { context, page } = await openInApp("", ANDROID_UA);
      try {
        await page.locator(".app-upgrade-bar").waitFor();
        expect(await page.locator(".app-upgrade-bar a").getAttribute("href")).toMatch(/^\/api\/app-update\/android\.apk$/);
      } finally {
        await context.close();
      }
    }, 60_000);

    test("新版安卓 App（原生桥上有 installAppUpdate）：提示条的'更新'交给 App 装，进度写在按钮后面", async () => {
      const context = await browser!.newContext({ viewport: PHONE, userAgent: ANDROID_UA });
      await context.addInitScript(
        `window.ergoNative = { appVersion: () => "0.0.1", log() {}, installAppUpdate(json) { window.__sent = json; window.__ergoAppUpdate('{"state":"downloading","percent":40}'); return new Promise(() => {}); } };`,
      );
      const page = await context.newPage();
      const errors: string[] = [];
      page.on("pageerror", (e) => errors.push(String(e)));
      try {
        await page.goto(pageUrl);
        const button = page.locator(".app-upgrade-bar button[data-action=app-update]");
        await button.waitFor();
        expect((await button.innerText()).trim()).toBe("更新");
        await button.click();
        await page.locator(".app-upgrade-bar .app-update-note", { hasText: "40%" }).waitFor();
        expect(await button.isDisabled()).toBe(true);
        const sent = JSON.parse((await page.evaluate("window.__sent")) as string) as { url: string; sha256: string; version: string; code: number };
        expect(sent.url).toMatch(/\/api\/app-update\/android\.apk$/);
        expect(sent).toMatchObject({ version: "0.4.3", code: 1003 });
        expect(sent.sha256).toMatch(/^[0-9a-f]{64}$/);
        const box = (await button.boundingBox())!;
        expect(box.x + box.width).toBeLessThanOrEqual(PHONE.width);
        expect(errors).toEqual([]);
      } finally {
        await context.close();
      }
    }, 60_000);

    test.each([
      ["够新的 App", "99.0.0", ANDROID_UA],
      ["手机浏览器", undefined, ANDROID_UA],
    ])("%s：没有提示", async (_name, version, ua) => {
      const { context, page } = await openInApp(version, ua);
      try {
        expect(await page.locator(".update-bar.app-upgrade-bar").count()).toBe(0);
      } finally {
        await context.close();
      }
    }, 60_000);

    test.each([
      ["", "App 0.4.2", "App 0.4.0", "要升级到"],
      ["?lang=en", "App 0.4.2", "App 0.4.0", "needs updating to"],
    ])("设备页（%s）：写 App 的版本，太旧的标要升级；浏览器那几台不写", async (search, fresh, old, mark) => {
      const { page, errors } = await open(PHONE, search);
      try {
        await page.evaluate("location.hash = '#/more/devices'");
        const rows = page.locator(".device-row .device-text");
        await rows.first().waitFor();
        const texts = await rows.allInnerTexts();
        const freshRow = texts.find((row) => row.includes(fresh))!;
        const oldRow = texts.find((row) => row.includes(old))!;
        expect(freshRow).not.toContain(mark);
        expect(oldRow).toContain(mark);
        expect(texts.filter((row) => row.includes("Safari") || row.includes("Edge")).every((row) => !row.includes("App "))).toBe(true);
        // 二狗带着 0.4.3 的安卓包：安卓那台写"有新版"，鸿蒙那台（0.4.2）不写
        const update = search === "" ? "有新版 0.4.3" : "new version 0.4.3";
        expect(oldRow).toContain(update);
        expect(freshRow).not.toContain(update);
        expect(errors).toEqual([]);
      } finally {
        await page.close();
      }
    }, 60_000);

    test("待办里那条：去升级是外部链接（按那台手机是哪种 App），知道了是按钮", async () => {
      const { page, errors } = await open({ width: 1280, height: 800 });
      try {
        await page.evaluate("location.hash = '#/inbox/i-app-outdated'");
        const upgrade = page.locator(".auth-actions a", { hasText: "去升级" });
        await upgrade.waitFor();
        expect(await upgrade.getAttribute("href")).toMatch(/ergo-android-debug\.apk$/);
        expect(await upgrade.getAttribute("target")).toBe("_blank");
        expect(await page.locator(".auth-actions button", { hasText: "知道了" }).count()).toBe(1);
        expect(errors).toEqual([]);
      } finally {
        await page.close();
      }
    }, 60_000);
  });

  test("演示数据：待办没有等你验收，提醒和越界通知和真实的一样，长程任务没有由你过目的阶段，界面上没有 LSM", async () => {
    const { page, errors } = await open({ width: 1280, height: 800 });
    const go = (to: string) => page.evaluate(`window.location.hash = ${JSON.stringify(to)}`);
    try {
      await go("#/inbox");
      await page.locator(".topbar .title").waitFor();
      await expect.poll(() => bodyText(page), { timeout: 5000 }).toContain("提醒：交房租");
      const inbox = await bodyText(page);
      for (const old of ["等你验收", "由你验收", "该交房租了"]) expect(inbox).not.toContain(old);
      // 越界通知只有"知道了"
      await go("#/inbox/i-scope");
      const actions = page.locator(".auth-actions button");
      await expect.poll(() => actions.allInnerTexts(), { timeout: 5000 }).toEqual(["知道了"]);

      await go("#/tasks/t-newpc");
      await page.locator(".md-side-graph").waitFor();
      await expect.poll(() => bodyText(page), { timeout: 5000 }).toContain("写搬迁说明");
      const task = await bodyText(page);
      for (const old of ["你在新电脑上过目", "请你过目", "你验收通过了", "由你验收"]) expect(task).not.toContain(old);

      // 项目的工单写的是定时任务，运营方案变更说的是服务管家
      await go("#/projects/p-ledger");
      await page.locator("[data-agent-dialog] .composer").waitFor();
      expect(await bodyText(page)).not.toContain("定时作业");
      await go("#/projects/p-recipes");
      await page.locator("[data-agent-dialog] .composer").waitFor();
      expect(await bodyText(page)).not.toContain("LSM");
      expect(errors).toEqual([]);
    } finally {
      await page.close();
    }
  }, 60_000);

  // 向导的"手机配对""安全默认值"两步，副标题和步骤内容各画了一次同一句说明
  test("设置向导：每一步的说明只显示一遍", async () => {
    const { page, errors } = await open({ width: 1280, height: 800 });
    try {
      await page.evaluate(`window.location.hash = "#/more/setup"`);
      await page.locator(".setup-rail").waitFor();
      for (const [step, sentence] of [
        ["language", "界面用哪种语言、怎么称呼你、助手叫什么"],
        ["model", "没有 key 就回不了话"],
        ["capabilities", "勾上的在后台下载或者打开"],
        ["phone", "扫下面的码"],
        ["safety", "这两项默认不勾"],
      ] as const) {
        await page.click(`.setup-rail [data-step="${step}"]`);
        await expect.poll(() => page.locator(".setup-page").innerText(), { timeout: 5000 }).toContain(sentence);
        const times = (await page.locator(".setup-page").innerText()).split(sentence).length - 1;
        expect({ step, times }).toEqual({ step, times: 1 });
      }
      expect(errors).toEqual([]);
    } finally {
      await page.close();
    }
  }, 60_000);

  test.each([
    ["手机", { width: 390, height: 844 }],
    ["电脑", { width: 1280, height: 800 }],
  ])("%s宽：标题栏有背后的 agent 的入口，列表运行中的在前，点开只读对话没有输入框；老的写明没记下它说的话；从来没有过的不显示入口", async (_what, viewport) => {
    const { page, errors } = await open(viewport);
    const go = (to: string) => page.evaluate(`window.location.hash = ${JSON.stringify(to)}`);
    const pane = viewport.width < 900 ? page.locator(".dp-page.at-detail") : page.locator(".pane-detail");
    try {
      await go("#/projects/p-photos");
      const entry = page.locator("[data-bg-entry]");
      await entry.waitFor();
      expect(await entry.getAttribute("aria-label")).toBe("背后有 2 个 agent 在干活");
      await entry.click();
      await pane.locator("[data-bg-agent]").first().waitFor();
      expect(await pane.locator("[data-bg-agent]").evaluateAll((els) => els.map((e) => e.getAttribute("data-bg-agent")))).toEqual(["sa-4", "sa-3", "sa-2", "review-t-photos-s1-1", "sa-1"]);
      const first = await pane.locator('[data-bg-agent="sa-4"]').innerText();
      for (const part of ["运行中", "按年份给 2024 年的照片建事件目录", "按事件新建目录", "工具调用 14 次", "8.6 万 token"]) expect(first).toContain(part);
      expect(first).toMatch(/运行 group_by_event\.py|python group_by_event/);

      // 做完的：对话能看（收到的指令、说的话、工具调用、结果），没有输入框、没有继续
      await pane.locator('[data-bg-agent="sa-2"]').click();
      await pane.locator("[data-bg-chat=done]").waitFor();
      expect(await pane.locator("[data-bg-entry-kind]").evaluateAll((els) => els.map((e) => e.getAttribute("data-bg-entry-kind")))).toEqual(["input", "said", "tool_call", "tool_call", "said", "result"]);
      expect(await pane.locator(".composer, textarea, button:has-text('继续')").count()).toBe(0);
      expect(await pane.innerText()).toContain("不能再叫它接着做");
      // 工具调用点开现取完整内容（原型取不到时退回摘要）
      await pane.locator("[data-bg-entry-kind=tool_call] > summary").first().click();
      await pane.locator(".bg-call .dt-pre").first().waitFor();

      // 老的：写明没记下
      await pane.locator(".detail-bar .icon-btn").click();
      await pane.locator('[data-bg-agent="sa-1"]').click();
      await pane.locator("[data-bg-chat=stopped]").waitFor();
      expect(await pane.innerText()).toContain("这次运行没有记下它说的话");

      // 从来没有过的不显示入口
      await go("#/projects/p-netdisk");
      await page.locator('[data-agent-dialog="project-netdisk"] .composer').waitFor();
      await page.waitForTimeout(300);
      expect(await entry.count()).toBe(0);
      expect(errors).toEqual([]);
    } finally {
      await page.close();
    }
  }, 60_000);

  test("缩小后撤回箭头的尖刚好碰到条的左沿，不插进去", async () => {
    const { page, errors } = await open({ width: 1280, height: 860 });
    await page.evaluate(`window.location.hash = "#/secretary"`);
    await page.waitForTimeout(300);
    const box = await page.locator(".zh").first().boundingBox();
    await page.mouse.move(box!.x + box!.width / 2, box!.y + box!.height / 2);
    await page.keyboard.down("Control");
    for (let i = 0; i < 40 && (await page.locator(".zh").first().getAttribute("data-level")) === "0"; i++) {
      await page.mouse.wheel(0, 120);
      await page.waitForTimeout(120);
    }
    await page.keyboard.up("Control");
    await page.waitForTimeout(800);
    const gaps = (await page.evaluate(
      `[...document.querySelectorAll(".zd-rollback")].filter((b) => b.getClientRects().length > 0).map((b) => b.closest(".zi").getBoundingClientRect().left - b.querySelector(".zd-rb-leader path").getBoundingClientRect().right)`,
    )) as number[];
    expect(gaps.length).toBeGreaterThan(0);
    for (const gap of gaps) {
      expect(gap).toBeGreaterThanOrEqual(0);
      expect(gap).toBeLessThan(2);
    }
    await page.close();
    expect(errors).toEqual([]);
  }, 60_000);

  // 面板原来和主线一样宽，从主线右边接着画，要点层哪个宽度都伸出视口右边（900 宽超出 145px，字被裁）
  for (const [name, viewport, besideMain] of [
    ["小屏 900×562（收窄，放在主线旁边）", { width: 900, height: 562 }, true],
    ["795×562（收窄，放在主线旁边）", { width: 795, height: 562 }, true],
    ["手机 360×780（旁边太窄，往左挪）", { width: 360, height: 780 }, false],
  ] as const) {
    test(`${name}：缩小后点开的分支整块留在视口里，字不被裁`, async () => {
      const { page, errors } = await open(viewport);
      await page.evaluate(`window.location.hash = "#/secretary"`);
      await page.waitForTimeout(300);
      const box = await page.locator(".zh").first().boundingBox();
      await page.mouse.move(box!.x + box!.width / 2, box!.y + box!.height / 2);
      await page.keyboard.down("Control");
      for (let i = 0; i < 40 && (await page.locator(".zh").first().getAttribute("data-level")) === "0"; i++) {
        await page.mouse.wheel(0, 120);
        await page.waitForTimeout(120);
      }
      await page.keyboard.up("Control");
      await page.waitForTimeout(800);
      await page.locator(".zd-ab-dot").first().click();
      await page.locator(".zd-ab-strip .zi").first().waitFor();
      await page.waitForTimeout(300);
      const m = (await page.evaluate(`(() => {
        const span = (el) => { const r = el.getBoundingClientRect(); return { left: r.left, right: r.right }; };
        const panel = document.querySelector(".zd-abandoned");
        const vp = document.querySelector(".zh-viewport");
        return {
          vp: span(vp),
          scroll: vp.scrollWidth - vp.clientWidth,
          main: span(panel.closest(".zi")),
          strip: span(panel.querySelector(".zd-ab-strip")),
          parts: [...panel.querySelectorAll(".zd-ab-label, .zd-ab-switch, .zd-ab-strip, .zd-ab-strip .zi")].filter((el) => el.getClientRects().length > 0).map(span),
        };
      })()`)) as { vp: Span; scroll: number; main: Span; strip: Span; parts: Span[] };
      expect(m.parts.length).toBeGreaterThan(3);
      for (const part of m.parts) {
        expect(part.left).toBeGreaterThanOrEqual(m.vp.left);
        expect(part.right).toBeLessThanOrEqual(m.vp.right);
      }
      expect(m.scroll).toBe(0);
      // 放得下时主线不被盖住，还能对照；放不下才往左挪，盖住一点主线
      expect(m.strip.left >= m.main.right).toBe(besideMain);
      // 不为了塞进去收得一行看不了几个字：至少 180，本来就比它窄的（手机）和主线一样宽
      expect(m.strip.right - m.strip.left).toBeGreaterThanOrEqual(Math.min(180, m.main.right - m.main.left));
      await page.close();
      expect(errors).toEqual([]);
    }, 60_000);
  }

  test("电脑上回车发送、组合键换行，设置里能换键；组字时的回车不发；触屏上回车还是换行", async () => {
    const { page, errors } = await open({ width: 1280, height: 800 });
    const at = async (hash: string) => {
      await page.evaluate(`window.location.hash = ${JSON.stringify(hash)}`);
      await page.waitForTimeout(300);
    };
    await at("#/secretary");
    const box = page.locator(".composer textarea").first();
    await box.fill("第一行");
    await box.press("Control+Enter");
    await box.pressSequentially("第二行");
    expect(await box.inputValue()).toBe("第一行\n第二行");
    // 输入法组字时的回车是选词，不发出去
    await page.evaluate(`document.querySelector(".composer textarea").dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true, isComposing: true }))`);
    expect(await box.inputValue()).toBe("第一行\n第二行");
    await box.press("Enter");
    expect(await box.inputValue()).toBe("");
    // 空的回车什么也不做，也不留下换行
    await box.press("Enter");
    expect(await box.inputValue()).toBe("");

    // 设置里换成 Shift：Shift + 回车换行，Ctrl + 回车发送
    await at("#/more/settings");
    await page.locator(".enter-key-setting [role=radio]").nth(1).click();
    await at("#/secretary");
    await box.fill("一");
    await box.press("Shift+Enter");
    await box.pressSequentially("二");
    expect(await box.inputValue()).toBe("一\n二");
    await box.press("Control+Enter");
    expect(await box.inputValue()).toBe("");
    // 记住了：刷新以后还是 Shift
    await page.reload();
    await page.waitForTimeout(300);
    expect(await page.evaluate(`window.localStorage.getItem("ergo-composer-newline")`)).toBe("shift");
    await page.close();
    expect(errors).toEqual([]);

    const touch = await browser!.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
    const phone = await touch.newPage();
    await phone.goto(pageUrl);
    await phone.evaluate(`window.location.hash = "#/secretary"`);
    await phone.waitForTimeout(300);
    const phoneBox = phone.locator(".composer textarea").first();
    await phoneBox.fill("一");
    await phoneBox.press("Enter");
    await phoneBox.pressSequentially("二");
    expect(await phoneBox.inputValue()).toBe("一\n二");
    await phone.evaluate(`window.location.hash = "#/more/settings"`);
    await phone.waitForTimeout(300);
    expect(await phone.locator(".enter-key-setting").count()).toBe(0);
    await touch.close();
  }, 60_000);

  for (const [name, viewport] of [
    ["手机宽", { width: 390, height: 844 }],
    ["电脑宽", { width: 1280, height: 800 }],
  ] as const) {
    test(`英文（?lang=en）${name}：每一页都打得开、有字、不报错，迁好的地方没有中文`, async () => {
      const { page, errors } = await open(viewport, "?lang=en");
      expect(await page.evaluate("document.documentElement.lang")).toBe("en");
      const empty: string[] = [];
      // 英文界面叫 owner，一个 maintainer 都不能露出来（impl.type 的写法只在出错时的提示里，这些页上没有）
      const maintainerWords: string[] = [];
      // 原型没起过名，英文下名字标签一律是默认的 ergo，不是二狗（下面查中文时名字标签是除外的，得单独看）
      const names = new Set<string>();
      for (const hash of PAGES) {
        await page.evaluate(`window.location.hash = ${JSON.stringify(hash)}`);
        await page.waitForTimeout(150);
        const shown = await bodyText(page);
        if (shown === "") empty.push(hash);
        for (const hit of shown.matchAll(/.{0,30}maintainer.{0,30}/gi)) maintainerWords.push(`${hash}：${hit[0]}`);
        for (const tag of (await page.evaluate(`Array.from(document.querySelectorAll(".assistant-name"), (el) => el.textContent)`)) as string[]) names.add(tag);
      }
      expect([...names]).toEqual(["ergo"]);
      const leaks: string[] = [];
      for (const { hash, selector, except, wideOnly } of EN_DONE) {
        if (wideOnly && viewport.width < 900) continue;
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
      expect(maintainerWords).toEqual([]);
    }, 60_000);
  }

  for (const [name, viewport] of [
    ["手机宽", { width: 390, height: 844 }],
    ["电脑宽", { width: 1280, height: 800 }],
  ] as const) {
    test(`英文演示（?lang=en）${name}：每一页的正文都没有中文（假数据也是英文，有意留的除外）`, async () => {
      const { page, errors } = await open(viewport, "?lang=en");
      const found: string[] = [];
      for (const hash of PAGES) {
        await page.evaluate(`window.location.hash = ${JSON.stringify(hash)}`);
        await page.waitForTimeout(150);
        const text = (await page.evaluate(
          `(() => { const copy = document.body.cloneNode(true); copy.querySelectorAll(${JSON.stringify(EN_SKIPS_CHINESE)}).forEach((e) => e.remove()); return copy.textContent; })()`,
        )) as string;
        const rest = EN_KEEPS_CHINESE.reduce((left, kept) => left.replaceAll(kept, ""), text);
        const at = rest.search(/[　-〿㐀-䶿一-鿿豈-﫿！-｠]/u);
        if (at >= 0) found.push(`${hash}: ${rest.slice(Math.max(0, at - 20), at + 40)}`);
      }
      await page.close();
      expect(errors).toEqual([]);
      expect(found).toEqual([]);
    }, 120_000);
  }

  test("英文演示：秘书页是英文的对话，任务、项目、记忆的内容跟着是英文；中文下原样是中文", async () => {
    const titles = async (search: string) => {
      const { page, errors } = await open({ width: 1280, height: 800 }, search);
      await page.evaluate(`window.location.hash = "#/projects"`);
      await page.waitForTimeout(300);
      const projects = await bodyText(page);
      await page.evaluate(`window.location.hash = "#/more/memory/claims"`);
      await page.waitForTimeout(300);
      const claims = await bodyText(page);
      await page.close();
      expect(errors).toEqual([]);
      return { projects, claims };
    };
    const en = await titles("?lang=en");
    expect(en.projects).toContain("Ledger");
    expect(en.claims).toContain("Needs to plan own weekends");
    const zh = await titles("");
    expect(zh.projects).toContain("记账本");
    expect(zh.claims).toContain("周末需要自己安排时间");
  }, 60_000);

  test("换语言后假数据的内容马上跟着换：中文下点 English，项目名变英文；点回中文变回中文", async () => {
    const { page, errors } = await open({ width: 1280, height: 800 });
    const switchTo = async (label: string) => {
      await page.evaluate(`window.location.hash = "#/more/language"`);
      await page.locator(".language-page button, .language-page label", { hasText: label }).first().click();
      await page.waitForTimeout(600);
      await page.evaluate(`window.location.hash = "#/projects"`);
      await page.waitForTimeout(400);
      return bodyText(page);
    };
    expect(await switchTo("English")).toContain("Ledger");
    const back = await switchTo("中文");
    expect(back).toContain("记账本");
    expect(back).not.toContain("Ledger");
    await page.close();
    expect(errors).toEqual([]);
  }, 60_000);

  test("中文下打开设置 · 语言点 English：导航、设置列表不刷新就换成英文，再点中文换回来", async () => {
    const { page, errors } = await open({ width: 1280, height: 800 });
    await page.evaluate(`window.location.hash = "#/more/language"`);
    await page.waitForSelector(".language-list");
    expect(await page.innerText("nav")).toContain("秘书");
    // 没起过名时默认名跟语言走，开着的页面不刷新也跟着换（取回的角色表里那份要重取，不然停在旧语言）
    const nameTag = () => page.innerText(".language-page .assistant-name");
    expect(await nameTag()).toBe("二狗");
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
    expect(await nameTag()).toBe("ergo");
    await page.click('.language-list [role="radio"]:has-text("中文")');
    await page.waitForFunction(`document.documentElement.lang === "zh-CN"`);
    await page.waitForTimeout(200);
    expect(await page.innerText("nav")).toContain("秘书");
    expect(await railWidth()).toBe(43);
    expect(await nameTag()).toBe("二狗");
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

  // 停用浏览插件（假连接照守护进程报"在配置里停用了"）："浏览"的地址、侧边栏模式写"内置浏览器插件没启用"，别的页照样打得开
  test("停用浏览插件（?demo-plugins-off=browsing）：#/browse 和侧边栏模式写没启用、不报错，别的页照样打得开", async () => {
    const { page, errors } = await open({ width: 390, height: 844 }, "?demo-plugins-off=browsing");
    const empty: string[] = [];
    const texts = new Map<string, string>();
    for (const hash of ["#/secretary", "#/browse", "#/more/settings", "#/more/browsing", "#/more/authorized-folders", "#/more/plugins"]) {
      await page.evaluate(`window.location.hash = ${JSON.stringify(hash)}`);
      await page.waitForTimeout(200);
      texts.set(hash, await bodyText(page));
      if (texts.get(hash) === "") empty.push(hash);
    }
    await page.close();
    expect(texts.get("#/browse")).toContain("内置浏览器插件没启用，这一页暂时看不到");
    // 授权的文件夹是内核的页面，浏览插件停用时照样在；设置列表里也有它
    expect(texts.get("#/more/authorized-folders")).toContain("添加文件夹");
    expect(texts.get("#/more/authorized-folders")).not.toContain("没启用");
    expect(texts.get("#/more/settings")).toContain("授权的文件夹");
    const side = await open({ width: 390, height: 844 }, "?ergo=side&demo-plugins-off=browsing");
    await side.page.waitForTimeout(300);
    const sideText = await bodyText(side.page);
    await side.page.close();
    expect([...errors, ...side.errors]).toEqual([]);
    expect(empty).toEqual([]);
    expect(sideText).toContain("内置浏览器插件没启用，这一页暂时看不到");
  }, 60_000);

  // 工具调用、来信（负责人来信……）、回忆了 N 条记忆这几种横条照"在想什么"那条——和它在同一列
  // （左边对齐，糖果、纸张的头像位也让出来），宽度跟着内容走、最宽到对话气泡那么宽（右边留空），窄窗口下右边不超出、
  // 行尾的箭头（›、详情 ›）整个露在横条里、紧跟着字、点得到。每套风格量：秘书页、负责人会话页（窄 340）、秘书页（电脑宽）、侧边栏模式（320）
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
      await check("负责人会话页 340", ["tool"]);
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

  // 侧边栏模式那一页收到"浏览"页交来的外观（App 转的 window.__ergoSide），马上换风格、深浅色、主色；不写这一页的存储
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

  // 2026-10-25：手机宽时 ⚙ 是底部弹层，套在它里面的确认框被它的滚动区裁掉、看不见（只剩一层灰）。
  // ⚙ 里的确认框——恢复用通用模板、清空当前对话（重置负责人）、换运行时——都挂到 body 上：不在 ⚙ 的弹层里，两个按钮整个露在屏幕里、点得到
  test("手机宽：⚙ 里的确认框挂在最外层，不被底部弹层裁掉，按钮看得见、点得到", async () => {
    const { page, errors } = await open({ width: 390, height: 844 });
    await page.evaluate(`window.location.hash = "#/projects/p-ledger/chat"`);
    await page.click(".topbar .th-more");
    await page.getByRole("menuitem", { name: "这个 agent 的设置" }).click();
    await page.waitForSelector(".agent-panel");
    const confirms: [string, () => Promise<unknown>][] = [
      ["恢复用通用模板", () => page.click('.agent-panel .prompt-actions button:has-text("恢复用通用模板")')],
      ["清空当前对话（重置负责人）", () => page.click('.agent-panel button:has-text("清空当前对话（重置负责人）")')],
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

  // 2026-10-30 重排这一页（用户说结构"是拼上去的"、并且"选了自定义还只看到 DeepSeek 的 key"）：
  // - API key 按服务商逐条列出（一个服务商一行，各有一个输入框和保存），换 key 不用先换服务商——给"另一个服务商"填 key 也在这里；
  // - 连通测试挪到 API key 那一块的底部（按钮是"测一下当前服务商"），测的是设置里选中的那个（自定义时连它那块的草稿一起）；
  // - 选自定义：接口地址、模型 id、接口类型和那句诚实的提示展开，拉列表（原型不联网，回几个编的 id）之后模型 id 变成下拉；
  //   默认模型不再显示只读的模型 id 框和思考档位、各个 agent 和看图能力整段收起（各留一句）；
  // - 切回 DeepSeek：agent 行、看图行、思考档位都回来，已经填的自定义那一块不丢；首次设置向导的模型那一步是同一套。
  test("设置 · 模型：key 逐条列出、给别的服务商填 key、连通测试在新位置；选自定义收起几段、切回都回来", async () => {
    const { page, errors } = await open({ width: 1280, height: 800 });
    const at = async (hash: string) => {
      await page.evaluate(`window.location.hash = ${JSON.stringify(hash)}`);
      await page.waitForTimeout(400);
    };
    const testSays = async (text: string) => {
      await page.waitForSelector(".model-test", { timeout: 10_000 });
      expect(await page.locator(".model-test").innerText()).toContain(text);
    };
    /** 这一页上看得见的字（查"整段收起只留一句"） */
    const pageText = () => page.locator(".models-page").innerText();

    // 设置 · 模型：API key 按服务商逐条列出，两行各有自己的输入框和保存按钮
    await at("#/more/models");
    await page.waitForSelector('input[name="model-provider"][value="custom"]');
    expect(await page.locator(".model-custom").count()).toBe(0);
    expect(await page.locator(".model-key-setting").evaluateAll((els) => els.map((e) => e.getAttribute("data-provider")))).toEqual(["deepseek", "custom"]);
    expect(await page.locator('input[name="model-api-key"]').count()).toBe(2);
    expect(await page.locator(".model-key-setting .model-key-form button").count()).toBe(2);
    // 换 key 不用先切服务商：当前还是 DeepSeek，直接给自定义那一行填、保存，那一行说存好了，服务商没变
    await page.fill('input[name="model-api-key"][data-provider="custom"]', "sk-demo-custom-abcdef");
    await page.click('.model-key-setting[data-provider="custom"] button:has-text("保存 key")');
    await page.waitForSelector('.model-key-setting[data-provider="custom"] .model-key-saved', { timeout: 10_000 });
    expect(await page.locator('input[name="model-provider"][value="deepseek"]').isChecked()).toBe(true);
    // 连通测试在 API key 那一块的底部（不是服务商那一块），只有一个，写"测一下当前服务商"
    expect(await page.locator(".model-test-actions").count()).toBe(1);
    expect(
      await page.evaluate(`(() => {
        const sec = Array.from(document.querySelectorAll(".models-page .sec")).find((s) => s.querySelector(".model-key-setting"));
        return sec !== undefined && sec.lastElementChild !== null && sec.lastElementChild.classList.contains("model-test-actions");
      })()`),
    ).toBe(true);
    await page.click('.model-test-actions button:has-text("测一下当前服务商")');
    await testSays("通了：deepseek-flash");

    // 选自定义：出现接口地址、模型 id、接口类型和诚实的那句提示
    await page.click('input[name="model-provider"][value="custom"]');
    await page.waitForSelector(".model-custom");
    expect(await page.locator('input[name="model-custom-base-url"]').getAttribute("placeholder")).toBe("https://api.openai.com/v1");
    const block = await page.locator(".model-custom").innerText();
    expect(block).toContain("要填到 /v1 这一层");
    expect(block).toContain("记忆整理、联网搜索和读网页仍然要用 DeepSeek 的 key");
    expect(block).toContain("OpenAI responses");
    // 填好地址和模型 id，离开输入框就存（原型只记在内存里）
    await page.fill('input[name="model-custom-base-url"]', "https://api.example.com/v1");
    await page.fill('input[name="model-custom-model-id"]', "my-model");
    await page.locator('input[name="model-custom-model-id"]').blur();
    // 默认模型：不再重复显示模型 id 的只读框，改一句灰字；思考档位、各个 agent、看图能力都不显示了
    await page.waitForFunction(`document.querySelector(".models-page")?.innerText.includes("用服务商那里填的模型：my-model")`, undefined, { timeout: 10_000 });
    expect(await page.locator(".model-choice").count()).toBe(0);
    expect(await page.locator(".models-page .seg").count()).toBe(0);
    expect(await page.locator(".model-agent-row").count()).toBe(0);
    expect(await page.locator(".model-vision-row").count()).toBe(0);
    const collapsed = await pageText();
    expect(collapsed).toContain("自定义服务商只有一个模型，这里不用逐个指定");
    expect(collapsed).toContain("这家服务商收不收图片，二狗不知道");
    // 拉列表：模型 id 变成下拉，里面是编的几个 id（现在填的那个补在第一项）
    await page.click('.model-custom button:has-text("拉取列表")');
    await page.waitForSelector('select[aria-label="模型 id"]', { timeout: 10_000 });
    expect(await page.locator('select[aria-label="模型 id"] option').evaluateAll((els) => els.map((e) => e.getAttribute("value")))).toEqual(["my-model", "fake-chat-pro", "fake-chat-mini", "fake-reasoner"]);
    await page.selectOption('select[aria-label="模型 id"]', "fake-chat-mini");
    await page.waitForTimeout(300);
    // 连通测试还是那个位置、还是测当前服务商：这次测的是自定义那边的模型 id（原型的假结果）
    await page.click('.model-test-actions button:has-text("测一下当前服务商")');
    await testSays("通了：fake-chat-mini");

    // 切回 DeepSeek：自定义那几项收起；agent 行、看图行、默认模型的下拉和思考档位都回来
    await page.click('input[name="model-provider"][value="deepseek"]');
    await page.waitForTimeout(300);
    expect(await page.locator(".model-custom").count()).toBe(0);
    expect(await page.locator(".model-agent-row").count()).toBeGreaterThan(0);
    expect(await page.locator(".model-vision-row").count()).toBeGreaterThan(0);
    expect(await page.locator(".models-page .seg").count()).toBe(1);
    expect(await pageText()).not.toContain("自定义服务商只有一个模型");
    // 再选回自定义：地址和挑的模型 id 都还在（切回 DeepSeek 不清空）
    await page.click('input[name="model-provider"][value="custom"]');
    await page.waitForSelector(".model-custom");
    expect(await page.locator('input[name="model-custom-base-url"]').inputValue()).toBe("https://api.example.com/v1");
    expect(await page.locator('select[aria-label="模型 id"]').inputValue()).toBe("fake-chat-mini");

    // 首次设置向导：步骤数没变（五步 + 外网访问，第③步换成"能力"），"以后再说"还在；模型那一步是同一套（服务商 → key → 连通测试），
    // key 只列当前那个服务商，切回 DeepSeek 就收起，填完能测连通
    await at("#/more/setup");
    expect(await page.locator(".setup-rail [data-step]").count()).toBe(6);
    // 能力那一步：插件、组件都列出来，有开始按钮、现在装了什么、开机自启
    await page.click('.setup-rail [data-step="capabilities"]');
    await page.waitForSelector('[data-capability="component:bge-m3"]', { timeout: 10_000 });
    expect(await page.locator('[data-capability^="plugin:"]').count()).toBe(5);
    expect(await page.locator('[data-capability^="component:"]').count()).toBe(3);
    expect(await page.locator("[data-capability-start]").count()).toBe(1);
    expect(await page.locator(".capability-now").count()).toBe(1);
    await page.waitForSelector('.capability-autostart[data-autostart="on"]', { timeout: 10_000 });
    await page.click('.setup-rail [data-step="model"]');
    await page.waitForSelector('input[name="model-provider"][value="custom"]', { timeout: 10_000 });
    expect(await page.locator(".setup-actions button").count()).toBe(2);
    expect(await page.locator(".model-key-setting").count()).toBe(1);
    expect(await page.locator('input[name="model-api-key"]').count()).toBe(1);
    await page.click('input[name="model-provider"][value="deepseek"]');
    await page.waitForTimeout(300);
    expect(await page.locator(".model-custom").count()).toBe(0);
    expect(await page.locator(".model-key-setting").evaluateAll((els) => els.map((e) => e.getAttribute("data-provider")))).toEqual(["deepseek"]);
    await page.click('input[name="model-provider"][value="custom"]');
    await page.waitForSelector(".model-custom");
    expect(await page.locator('input[name="model-custom-base-url"]').inputValue()).toBe("https://api.example.com/v1");
    // 向导里没有拉过列表：模型 id 还是手填的输入框，值是上次挑的那个
    expect(await page.locator('input[name="model-custom-model-id"]').inputValue()).toBe("fake-chat-mini");
    expect(await page.locator(".model-key-setting").evaluateAll((els) => els.map((e) => e.getAttribute("data-provider")))).toEqual(["custom"]);
    await page.click('.model-test-actions button:has-text("测一下当前服务商")');
    await testSays("通了：fake-chat-mini");
    await page.close();
    expect(errors).toEqual([]);
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

/** 一个元素在屏幕上的左右缘（CSS 像素） */
interface Span {
  left: number;
  right: number;
}

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

/** 一条横条哪里不对 */
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
