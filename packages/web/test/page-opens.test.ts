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
// 每套风格量聊天里收成一行的那几种（一样宽、和对话气泡最宽处一样宽、左边对齐、行尾 › 在同一条竖线上、窄窗口下露全点得到），
// 侧边栏模式收到交来的外观马上换风格；"浏览"页把浏览侧边栏开合交给页面桥（关着悬浮按钮常驻右下角）。
// 小屏和手机上，会话缩小后点开的分支整块留在视口里。
// 标题上的"等你……"手机、电脑都看得到、点得到，点了跳到要处理的那张卡、闪一下，再点一次再闪；卡在别的页的跳过去；答完就不再等你。
// 同一个 agent 不管从哪进去都是同一个对话框（标题栏、阶段条、输入框都在）；老的 #/tasks/<任务> 跳过去并定位；做完收成一行；背后的 agent 的列表和只读对话。
// 安装版（不带 --mode demo）被直接打开：只有一句"要经二狗打开"，中英跟系统语言，一个请求都不往外发。
// 手机 App 太旧（假的 ergoNative）：页面顶上一条提示，点了去下载或看教程；够新、不在 App 里没有；设备页写 App 的版本。
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { type Browser, type BrowserContext, chromium, type Page } from "playwright-core";
import { build, type Rolldown } from "vite";
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import { MORE_PAGES } from "../src/app/route-hash.ts";
import { MEMORY_ITEMS } from "../src/plugins/memory/route.ts";
import { demoMapDay } from "../src/prototype/fake-footprints.ts";
import { LANGUAGE_SETTING_TITLE, localDate, shiftMapDate, wgsToGcj } from "../src/state/index.ts";
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
  "#/more/data-sources/google-maps",
  "#/more/map",
  "#/more/map/1.2834%2C103.8607%2C14",
  "#/more/data-sources/phone-location",
  "#/more/data-sources/没有这个",
  // 设备配对的二维码界面；定位到这台手机的"更新"（原型里这台不是安卓 App，照常是设备配对）
  "#/more/devices/qr",
  "#/more/devices/update",
  // 设置 · 服务定位到一个服务（体检里点过来的样子，原型编的服务管家）
  "#/more/services/ergo-daemon--p-ledger-web",
  "#/more/data-sources/import_folder",
  // 设置里删除素材的旧地址：跳到记忆 · 素材
  "#/more/materials",
  "#/more/materials/mat-fake-recent-1",
];

/**
 * 英文下已经迁好的地方：在这一页上，这个元素里（去掉 except 挑出来的还没迁的部分、用户的内容）不能有中文。
 * 迁完一块就往这里加一行
 */
const EN_DONE: { hash: string; selector: string; except?: string; wideOnly?: boolean; open?: string }[] = [
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
  { hash: "#/secretary", selector: ".chat-line .line-title, .xcard-tag" },
  { hash: "#/secretary", selector: ".day-sep" },
  { hash: "#/secretary", selector: ".att-btns" },
  { hash: "#/secretary", selector: ".tool-more, .bubble-more" },
  { hash: "#/secretary", selector: ".composer", except: ".assistant-name" },
  { hash: "#/tasks/t-photos", selector: ".composer" },
  { hash: "#/tasks/t-photos", selector: ".ibar-n" },
  { hash: "#/tasks/t-photos", selector: ".stage-prog" },
  // 标题栏上的入口、背后的 agent 的说法（手机上入口只有图标和个数，全称在说明里）
  { hash: "#/tasks/t-newpc", selector: ".bg-entry-text", wideOnly: true },
  { hash: "#/projects/p-ledger/chat", selector: ".chat-line .line-title, .xcard-tag" },
  // 等你确认的立项要求变更在对话里整张画（462），前后对照就在对话里
  { hash: "#/projects/p-ledger/chat", selector: ".charter-diff-k" },
  // 处理过的卡在对话里收成一行，卡上处理过的结果在详情里：先点开那一行（open）
  { hash: "#/projects/p-ledger/chat", selector: ".auth-result", open: '.chat-line[data-card-type="mcp_change"]' },
  { hash: "#/inbox", selector: ".notify-permission" },
  // 待办通知的动作按钮：存的是中文原字（按字认），显示时换成当前语言（协议包的 inboxActionText）
  { hash: "#/inbox/i-sjob", selector: ".auth-actions" },
  { hash: "#/inbox/i-backup", selector: ".auth-actions" },
  { hash: "#/inbox/i-app-outdated", selector: ".auth-actions" },
  { hash: "#/inbox/i-phone-calendar", selector: ".auth-actions" },
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
  // 428：设置 · 服务——状态、用途、受保护的原因、按钮、开关都是网页按语言拼的；原型编的服务名、出错原因、服务管家的话经假数据的英文表
  { hash: "#/more/services", selector: ".services-page" },
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
  // 目录授权：最上面授权的文件夹（"添加文件夹"那一排），说明、每条授权的标签和为什么给、使用记录（个人助理的名字是用户起的，不算）
  { hash: "#/more/folder-grants", selector: ".af-actions" },
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
  // 记进档案的卡（等你核对：对话里整张画，按钮在卡上，462）
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
  // 地图页的隔离框（453）：构建时 public/ 原样拷进产物（不写盘的构建里没有它），这里照样挨着页面放一份
  fs.copyFileSync(path.join(WEB_ROOT, "public", "map-frame.html"), path.join(tempDir, "map-frame.html"));
  installUrl = pathToFileURL(installFile).href;
  browser = await chromium.launch({ executablePath: CHROME });
}, 120_000);

// 关 Chrome 在机器忙（同时跑几份全量测试）时会超过默认的 10 秒，测试本身全过却挂在收尾上
afterAll(async () => {
  await browser?.close();
  if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
}, 60_000);

/** 开一页，记下没接住的错误和控制台报错（取不到的文件不算） */
/**
 * 隔离框里记下收到的每一条消息（453）：页面加载前装进每一个框（Playwright 的 init 脚本也进 sandbox 的框），之后从框里读出来，
 * 看外层交给谷歌那一边的有没有足迹、点、线
 */
const FRAME_SPY = `if (window !== window.top) { window.__got = []; window.addEventListener("message", (e) => { try { window.__got.push(JSON.stringify(e.data)); } catch (err) { window.__got.push(String(err)); } }, true); }`;
/**
 * 交给谷歌隔离框的每一条消息只能是这几种、只带这几样（453）：init 是代码和设置，别的是视野指令。点、线、足迹没有地方放——
 * 加了别的字段（比如把画什么交进去）这里就红
 */
const FRAME_MESSAGE_FIELDS: Record<string, readonly string[]> = {
  init: ["code", "config"],
  setView: ["lat", "lng", "zoom"],
  zoomBy: ["delta"],
  panBy: ["dx", "dy"],
  setDark: ["dark"],
};
const FRAME_CONFIG_FIELDS = ["authFailed", "dark", "key", "language", "lat", "lng", "maxZoom", "minZoom", "scriptUrl", "timeoutMs", "unreachable", "version", "zoom"];
/** 同 expectOnlyViewMessages，不抛错：交回不对的地方（458 的跟手测试一并收集） */
function frameMessageProblems(got: readonly string[]): string[] {
  if (got.length === 0) return ["框里一条消息都没收到"];
  const out: string[] = [];
  for (const text of got) {
    const m = JSON.parse(text) as { type: string; config?: Record<string, unknown> };
    const fields = FRAME_MESSAGE_FIELDS[m.type];
    if (!fields) {
      out.push(`框收到不认识的消息：${text.slice(0, 120)}`);
      continue;
    }
    const keys = Object.keys(m)
      .filter((k) => k !== "type" && k !== "ergoMapFrame")
      .toSorted();
    if (keys.join(",") !== fields.toSorted().join(",")) out.push(`框收到的 ${m.type} 多了或少了字段：${keys.join(",")}`);
    if (m.type === "init" && Object.keys(m.config ?? {}).toSorted().join(",") !== FRAME_CONFIG_FIELDS.join(",")) out.push(`init 的设置多了或少了字段：${Object.keys(m.config ?? {}).join(",")}`);
  }
  return out;
}
function expectOnlyViewMessages(got: readonly string[]) {
  expect(got.length).toBeGreaterThan(0);
  for (const text of got) {
    const m = JSON.parse(text) as { type: string; config?: Record<string, unknown> };
    const fields = FRAME_MESSAGE_FIELDS[m.type];
    // 框只许收这几种指令（不认识的种类当场红，带上那条消息）
    expect({ type: m.type, known: fields !== undefined, text: text.slice(0, 120) }).toMatchObject({ known: true });
    expect(Object.keys(m).filter((k) => k !== "type" && k !== "ergoMapFrame").toSorted()).toEqual(fields!.toSorted());
    // init 那条的 config 也只许这几个字段（别的种类没有 config，按空的比）
    expect(m.type === "init" ? Object.keys(m.config!).toSorted() : FRAME_CONFIG_FIELDS).toEqual(FRAME_CONFIG_FIELDS);
  }
}
/** 地图页上谷歌那一种的隔离框（Playwright 的 Frame：能在框里跑脚本） */
async function googleFrame(page: Page) {
  const frame = await (await page.locator('[data-engine="google"] iframe.map-frame').elementHandle())!.contentFrame();
  if (!frame) throw new Error("没有谷歌的隔离框");
  return frame;
}

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

// 回到我现在的位置（442）：地图右下角一个钮，高德、OpenStreetMap 两种底图上都有。位置都是假的：浏览器定位用 playwright 的假定位
// （给了权限、没给），或者换掉 navigator.geolocation（超时、记下有没有被问）；鸿蒙 App 用假的原生桥（phonePlaceHere）；
// 手机最近交来的点是原型的（12 分钟前、西湖边），?demo-plugins-off=phone 时没有。一个请求都不往外发
/**
 * 开一个地图页：geo 是浏览器定位给的位置（给了就给权限），init 是页面加载前跑的脚本；footprintsOff 关掉"足迹"（国内看高德；444 起本来就默认关着，
 * 照旧写明），footprintsOn 打开"足迹"
 */
async function openMap(
  viewport: { width: number; height: number },
  opts: {
    geo?: { latitude: number; longitude: number; accuracy: number };
    init?: string;
    search?: string;
    footprintsOff?: boolean;
    footprintsOn?: boolean;
    touch?: boolean;
    /** 开页面之前对 context 做的（458：拦请求） */
    beforeOpen?: (context: BrowserContext) => Promise<unknown>;
    /** 不等底图出来（458：真谷歌要联网，慢） */
    noWait?: boolean;
  } = {},
) {
  const context = await browser!.newContext({
    viewport,
    ...(opts.geo ? { geolocation: opts.geo, permissions: ["geolocation"] } : {}),
    // 手指（458：CDP 发触摸事件模拟双指捏合）；时区和这边一样（演示页的足迹按"今天"排日子，这边照同一天算点的经纬度）
    ...(opts.touch ? { hasTouch: true, isMobile: true, timezoneId: Intl.DateTimeFormat().resolvedOptions().timeZone } : {}),
  });
  if (opts.init) await context.addInitScript(opts.init);
  await opts.beforeOpen?.(context);
  const page = await context.newPage();
  const errors: string[] = [];
  const outside: string[] = [];
  page.on("pageerror", (e) => errors.push(`没接住的错误：${String(e)}`));
  page.on("console", (m) => {
    if (m.type() === "error" && !m.text().startsWith("Failed to load resource")) errors.push(`控制台报错：${m.text()}`);
  });
  page.on("request", (r) => {
    if (!/^(?:file|data|blob):/.test(r.url())) outside.push(r.url());
  });
  await page.goto(pageUrl + (opts.search ?? ""));
  if (opts.footprintsOff) await page.evaluate(`localStorage.setItem("ergo-map-footprints", "off")`);
  if (opts.footprintsOn) await page.evaluate(`localStorage.setItem("ergo-map-footprints", "on")`);
  await page.evaluate(`window.location.hash = "#/more/map"`);
  if (!opts.noWait) await page.locator(".map-canvas:not([data-basemap=loading])").waitFor({ timeout: 5000 });
  return { context, page, errors, outside };
}
/** 字框、引线怎么量（在页面里跑；这个文件不带 DOM 的类型，写成字符串）：交回 labelReport 那几样 */
const LABEL_REPORT = `(scope) => {
  const canvas = document.querySelector(scope).getBoundingClientRect();
  const seen = (el) => el.checkVisibility({ visibilityProperty: true });
  const labels = [...document.querySelectorAll(scope + " .map-mark-label")].filter((l) => {
    const r = l.getBoundingClientRect();
    return seen(l) && r.width > 0 && r.right > canvas.left && r.left < canvas.right && r.bottom > canvas.top && r.top < canvas.bottom;
  });
  const rects = labels.map((l) => ({ text: l.textContent || "", r: l.getBoundingClientRect() }));
  const hits = [];
  for (let i = 0; i < rects.length; i++) {
    for (let j = i + 1; j < rects.length; j++) {
      const a = rects[i].r;
      const b = rects[j].r;
      if (a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom) hits.push(rects[i].text + " × " + rects[j].text);
    }
  }
  const leaders = [...document.querySelectorAll(scope + " .map-leader")].filter(seen);
  const bad = [];
  const moved = labels.filter((l) => l.dataset.moved !== undefined);
  for (const l of moved) {
    const mark = l.closest(".map-mark");
    const line = leaders.find((x) => x.getAttribute("data-id") === mark.dataset.id);
    if (!line) {
      bad.push(l.textContent + "：没有引线");
      continue;
    }
    const svg = line.ownerSVGElement.getBoundingClientRect();
    const at = (n) => Number(line.getAttribute(n));
    const start = { x: svg.left + at("x1"), y: svg.top + at("y1") };
    const end = { x: svg.left + at("x2"), y: svg.top + at("y2") };
    // 另一头在点上：点的元素底边正中
    const m = mark.getBoundingClientRect();
    if (Math.abs(end.x - (m.left + m.width / 2)) > 1.5 || Math.abs(end.y - m.bottom) > 1.5) bad.push(l.textContent + "：引线没连到点");
    // 起点在字框的边上
    const r = l.getBoundingClientRect();
    const inside = start.x >= r.left - 1.5 && start.x <= r.right + 1.5 && start.y >= r.top - 1.5 && start.y <= r.bottom + 1.5;
    const onEdge = Math.min(Math.abs(start.x - r.left), Math.abs(start.x - r.right), Math.abs(start.y - r.top), Math.abs(start.y - r.bottom)) <= 1.5;
    if (!inside || !onEdge) bad.push(l.textContent + "：引线不是从字框边上起的");
  }
  return { labels: rects.length, moved: moved.length, leaders: leaders.length, hits, bad };
}`;
/**
 * 地图上点旁边的字（451 补：字不互相盖住）：地图那块里看得见的字框（屏幕坐标）两两相交的、一共几个、挪开了几个（data-moved）、
 * 看得见的引线几条；挪开了却没有引线的、引线不是从字框边上连到点（针尖、圆点中心）的。scope 是看哪一块（静态大图盖着时看它）
 */
async function labelReport(page: Page, scope = ".map-canvas") {
  return (await page.evaluate(`(${LABEL_REPORT})(${JSON.stringify(scope)})`)) as { labels: number; moved: number; leaders: number; hits: string[]; bad: string[] };
}
/** 字排稳了再量（一帧最多排一次：等几帧） */
async function labelsSettled(page: Page, scope?: string) {
  await page.evaluate(`new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(() => requestAnimationFrame(done))))`);
  await page.waitForTimeout(150);
  return labelReport(page, scope);
}
/** 世界坐标（第 20 级的 Web 墨卡托像素，256 一张瓦片） */
const WORLD_ZOOM = 20;
function worldOf(p: { lat: number; lon: number }): { x: number; y: number } {
  const size = 256 * 2 ** WORLD_ZOOM;
  const s = Math.sin((p.lat * Math.PI) / 180);
  return { x: ((p.lon + 180) / 360) * size, y: (0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * size };
}
/**
 * 底图此刻把世界坐标画在哪（在页面或框里跑）：屏幕 = k · 世界 + o。瓦片的 img 上写着 data-tile="z/x/y"（OpenStreetMap、假高德、假谷歌），
 * 真谷歌的瓦片地址里带着（!1i z !2i x !3i y）；取张数最多的那一级，按瓦片左上角最小二乘拟合（缩放共用一个 k）
 */
const TILE_TRUTH = `((root) => {
  const ZR = ${WORLD_ZOOM};
  const rows = [];
  for (const img of document.querySelectorAll(root + " img")) {
    let z, x, y;
    if (img.dataset.tile) [z, x, y] = img.dataset.tile.split("/").map(Number);
    else {
      const m = /!1i(\\d+)!2i(\\d+)!3i(\\d+)/.exec(img.src);
      if (!m) continue;
      [z, x, y] = [Number(m[1]), Number(m[2]), Number(m[3])];
    }
    const r = img.getBoundingClientRect();
    if (r.width < 4 || img.classList.contains("broken")) continue;
    rows.push({ z, X: x * 256 * 2 ** (ZR - z), Y: y * 256 * 2 ** (ZR - z), L: r.left, T: r.top });
  }
  const count = new Map();
  for (const r of rows) count.set(r.z, (count.get(r.z) || 0) + 1);
  const best = [...count].sort((a, b) => b[1] - a[1])[0];
  if (!best || best[1] < 2) return undefined;
  const use = rows.filter((r) => r.z === best[0]);
  let mX = 0, mL = 0, mY = 0, mT = 0;
  for (const r of use) { mX += r.X; mL += r.L; mY += r.Y; mT += r.T; }
  mX /= use.length; mL /= use.length; mY /= use.length; mT /= use.length;
  let num = 0, den = 0;
  for (const r of use) { num += (r.X - mX) * (r.L - mL) + (r.Y - mY) * (r.T - mT); den += (r.X - mX) ** 2 + (r.Y - mY) ** 2; }
  if (!(den > 0)) return undefined;
  const k = num / den;
  return { k, ox: mL - k * mX, oy: mT - k * mY };
})`;
/** 看得见的点（选择器）的针尖（元素底边正中），按 data-id */
const MARK_TIPS = `((sel) => {
  const out = {};
  for (const el of document.querySelectorAll(sel)) {
    if (el.hidden) continue;
    const r = el.getBoundingClientRect();
    if (r.width > 0) out[el.dataset.id] = { x: r.left + r.width / 2, y: r.bottom };
  }
  return out;
})`;
const ONE_FRAME = `new Promise((done) => requestAnimationFrame(() => done()))`;
const TWO_FRAMES = `new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(() => done())))`;
/** 真的谷歌（458 页面测试）：框里拦下演示页的假谷歌（它装 google 时不收），小桥就去加载谷歌的脚本 */
const REAL_GOOGLE_INIT = `if (window !== window.top) {
  let real;
  Object.defineProperty(window, "google", { configurable: true, get() { return real; }, set(v) {
    if (!real && v && v.maps && typeof v.maps.importLibrary === "function") return;
    real = v;
  } });
}`;

/**
 * 458：在地图页上用手指捏、松手、双击、甩，量二狗画的点和底图差多少（见用到它的那几条测试）。skipped 是跳过的原因（只有真谷歌会跳过）
 */
async function followCheck(kind: "google" | "amap" | "osm" | "google-real"): Promise<{ skipped?: string; problems: string[] }> {
  /** 不对的地方（一条一句，测试里断言它是空的） */
  const problems: string[] = [];
  const google = kind === "google" || kind === "google-real";
  const basemap = google ? "google" : kind;
  const yesterday = shiftMapDate(localDate(new Date()), -1);
  // 点的世界坐标：演示页昨天的足迹里停留（每一处按第一段停留的位置，地图页那一层这样画）和没去的常去地方（家、公司、西湖边、健身房，
  // 隔着几公里），高德、谷歌在大陆里用 GCJ-02。照片那几个挨着西湖边，不量（这个文件不带 DOM 的类型，不引地图插件的整理函数）
  const day = demoMapDay(yesterday);
  const worlds = new Map<string, { x: number; y: number }>();
  const conv = (p: { lat: number; lon: number }) => (kind === "osm" ? p : wgsToGcj(p));
  for (const s of day.stays.toSorted((a, b) => Date.parse(a.from) - Date.parse(b.from))) {
    if (!worlds.has(`fp-stay-${s.spot}`)) worlds.set(`fp-stay-${s.spot}`, worldOf(conv(s)));
  }
  const visited = new Set(day.stays.flatMap((s) => (s.placeId === undefined ? [] : [s.placeId])));
  for (const p of day.places) if (!visited.has(p.id)) worlds.set(`fp-place-${p.id}`, worldOf(conv(p)));
  const init = [
    basemap === "amap" ? "" : `if (window === window.top) localStorage.setItem("ergo-map-choice", JSON.stringify({ mainland: "${basemap}" }))`,
    google ? FRAME_SPY : "",
    kind === "google-real" ? REAL_GOOGLE_INIT : "",
  ].join("\n");
  // 真谷歌：地址里去掉演示页的假 Key（不带 Key 谷歌照样出图）；别的请求照常。加载要联网、慢，打开时不等它
  const beforeOpen =
    kind === "google-real"
      ? (c: BrowserContext) =>
          c.route(/maps\.googleapis\.com\/maps\/api\/js/, (route) => {
            const u = new URL(route.request().url());
            u.searchParams.delete("key");
            return route.continue({ url: u.href });
          })
      : undefined;
  const { context, page, errors, outside } = await openMap({ width: 390, height: 844 }, { footprintsOn: true, touch: true, init, ...(beforeOpen ? { beforeOpen, noWait: true } : {}) });
  try {
    await page.evaluate(`window.location.hash = "#/more/map/${yesterday}"`);
    if (kind === "google-real") {
      try {
        await page.locator('.map-google[data-state="ready"]').waitFor({ timeout: 25_000 });
      } catch {
        return { skipped: "连不上谷歌（这台机器上不了谷歌，或谷歌不给不带 Key 的出图），这一条跳过", problems };
      }
    } else if (google) await page.locator('.map-google[data-state="ready"]').waitFor({ timeout: 8000 });
    await page.locator(`.map-canvas[data-basemap="${basemap}"]`).waitFor({ timeout: 8000 });
    const marksSel = kind === "osm" ? '[data-engine="osm"] .map-marks .map-mark' : ".map-page-overlay .map-mark";
    await expect.poll(() => page.locator(`${marksSel}[data-kind="stay"]`).count(), { timeout: 8000 }).toBe(3);
    const frame = google ? await googleFrame(page) : undefined;
    const truth = async () =>
      (frame ? await frame.evaluate(`(${TILE_TRUTH})("")`) : await page.evaluate(`(${TILE_TRUTH})(${JSON.stringify(kind === "osm" ? '[data-engine="osm"]' : '[data-engine="amap-demo"]')})`)) as
        | { k: number; ox: number; oy: number }
        | undefined;
    if (kind === "google-real") {
      // 没 Key 时谷歌弹的那一框：点掉（不点也不挡下面的地图，只是挡手指）
      await frame!
        .locator("button.dismissButton")
        .click({ timeout: 5000 })
        .catch(() => undefined);
      for (let i = 0; i < 60 && (await truth()) === undefined; i++) await page.waitForTimeout(250);
      if ((await truth()) === undefined) return { skipped: "谷歌出了图，但瓦片地址里认不出 z/x/y（谷歌改了格式），量不了，这一条跳过", problems };
    }
    const canvas = (await page.locator(".map-canvas").boundingBox())!;
    const frameBox = frame ? (await page.locator('[data-engine="google"] iframe.map-frame').boundingBox())! : { x: 0, y: 0 };
    const cdp = await context.newCDPSession(page);
    const touch = (type: "touchStart" | "touchMove" | "touchEnd", pts: ReadonlyArray<{ x: number; y: number }>) =>
      cdp.send("Input.dispatchTouchEvent", { type, touchPoints: pts.map((p, id) => ({ x: p.x, y: p.y, id, radiusX: 4, radiusY: 4, force: 1 })) });
    const nextFrames = async () => {
      if (frame) await frame.evaluate(ONE_FRAME);
      await page.evaluate(TWO_FRAMES);
    };
    /** 量一次：底图此刻 vs 我们画的；谷歌的框和外层是分开读的，读的中间框里又动了就不算这一次 */
    const samples: Array<{ at: string; worst: number; n: number }> = [];
    let k = 0;
    const measure = async (at: string) => {
      const t1 = await truth();
      const ours = (await page.evaluate(`(${MARK_TIPS})(${JSON.stringify(marksSel)})`)) as Record<string, { x: number; y: number }>;
      if (!t1) return;
      if (frame) {
        const t2 = await truth();
        if (!t2 || Math.abs(t2.k / t1.k - 1) > 1e-4 || Math.abs(t2.ox - t1.ox) > 0.05 || Math.abs(t2.oy - t1.oy) > 0.05) return;
      }
      k = t1.k;
      let worst = 0;
      let n = 0;
      for (const [id, w] of worlds) {
        const o = ours[id];
        if (!o) continue;
        const tx = frameBox.x + t1.ox + t1.k * w.x;
        const ty = frameBox.y + t1.oy + t1.k * w.y;
        if (tx < canvas.x || ty < canvas.y || tx > canvas.x + canvas.width || ty > canvas.y + canvas.height) continue;
        n += 1;
        worst = Math.max(worst, Math.hypot(o.x - tx, o.y - ty));
      }
      if (n > 0) samples.push({ at, worst: Math.round(worst * 10) / 10, n });
    };
    const watch = async (at: string, ms: number) => {
      const until = Date.now() + ms;
      while (Date.now() < until) {
        await page.evaluate(ONE_FRAME);
        await measure(at);
      }
    };
    await measure("开始");
    const k0 = k;
    // 两指边捏边挪：两指中间从 (0.4, 0.55) 往右上挪 (60, -80)，两指间距 90 → 260
    const fx = canvas.x + canvas.width * 0.4;
    const fy = canvas.y + canvas.height * 0.55;
    const fingers = (d: number, f: number) => [
      { x: fx - d + 60 * f, y: fy - 80 * f },
      { x: fx + d + 60 * f, y: fy - 80 * f },
    ];
    await touch("touchStart", fingers(45, 0));
    for (let i = 1; i <= 12; i++) {
      await touch("touchMove", fingers(45 + (85 * i) / 12, i / 12));
      await nextFrames();
      await measure(`捏第 ${i} 步`);
    }
    await touch("touchEnd", []);
    await watch("松手后", 700);
    // 放大了（约 3 倍，谷歌回弹到整数级）
    if (!(k / k0 > 1.9)) problems.push(`捏合没放大：${(k / k0).toFixed(2)} 倍`);
    // 双击（挑一处空地：不落在点、字、按钮上）
    const spot = (await page.evaluate(`(() => {
      const c = ${JSON.stringify(canvas)};
      for (const [fx, fy] of [[0.6, 0.35], [0.3, 0.3], [0.7, 0.6], [0.25, 0.7], [0.5, 0.45], [0.75, 0.25]]) {
        const x = c.x + c.width * fx, y = c.y + c.height * fy;
        const el = document.elementFromPoint(x, y);
        if (el && !el.closest(".map-mark, button, a, .map-hint, .map-badge")) return { x, y };
      }
      return { x: c.x + c.width * 0.6, y: c.y + c.height * 0.35 };
    })()`)) as { x: number; y: number };
    const kTap = k;
    for (let i = 0; i < 2; i++) {
      await touch("touchStart", [spot]);
      await page.waitForTimeout(30);
      await touch("touchEnd", []);
      await page.waitForTimeout(80);
    }
    await watch("双击后", 700);
    if (!(k / kTap > 1.4)) problems.push(`双击没放大：${(k / kTap).toFixed(2)} 倍`);
    // 一指甩一下（谷歌、高德松手后接着滑；OpenStreetMap 自己不滑）
    const sx = canvas.x + canvas.width * 0.5;
    const sy = canvas.y + canvas.height * 0.6;
    await touch("touchStart", [{ x: sx, y: sy }]);
    for (let i = 1; i <= 5; i++) {
      await touch("touchMove", [{ x: sx - 30 * i, y: sy + 15 * i }]);
      await page.waitForTimeout(16);
    }
    await touch("touchEnd", []);
    await watch("甩完", 700);
    // 每一次都量到了点（一开始四处都在屏幕上），过程中、动画里不差过 2 像素
    if (samples[0]?.at !== "开始" || samples[0].n !== 4) problems.push(`一开始没量到四处：${JSON.stringify(samples[0])}`);
    if (samples.length <= 30) problems.push(`量到的太少：${samples.length} 次`);
    for (const s of samples) if (s.worst > 2) problems.push(`${s.at}：差 ${s.worst} 像素（量了 ${s.n} 处）`);
    // 停下来字照样两两不相交（缩放途中字跟着点走、不每帧重排，停下来再排）
    await page.waitForTimeout(300);
    const labels = await labelsSettled(page);
    problems.push(...labels.hits.map((h) => `字叠在一起：${h}`), ...labels.bad);
    // 交给谷歌框的照旧只有设置和视野（458 没加新的消息），见 FRAME_MESSAGE_FIELDS
    if (frame) problems.push(...frameMessageProblems((await frame.evaluate("window.__got")) as string[]));
    if (kind === "google-real") {
      // 发给谷歌的请求里没有足迹的经纬度（停留、照片、常去的地方；WGS-84、GCJ-02 都查，四位小数）
      const coords = [...day.stays, ...day.photos, ...day.places].flatMap((m) => {
        const g = wgsToGcj(m);
        return [m.lat, m.lon, g.lat, g.lon].map((v) => v.toFixed(4));
      });
      for (const url of outside) for (const c of coords) if (url.includes(c)) problems.push(`发给谷歌的请求里有足迹的坐标 ${c}：${url.slice(0, 160)}`);
    } else problems.push(...outside.map((u) => `往外发了请求：${u}`));
  } finally {
    await context.close();
  }
  // 真谷歌没 Key 时自己会在控制台报错（还有它框里一处 SecurityError），不算
  if (kind !== "google-real") problems.push(...errors);
  return { problems };
}

/** 演示页六天前那一天（绕西湖走一圈，字很挤）的地址：按页面里的今天算 */
async function walkDayHash(page: Page): Promise<string> {
  return (await page.evaluate(
    `(() => { const d = new Date(); d.setDate(d.getDate() - 6); return "#/more/map/" + [d.getFullYear(), String(d.getMonth() + 1).padStart(2, "0"), String(d.getDate()).padStart(2, "0")].join("-"); })()`,
  )) as string;
}
/** 点"回到我现在的位置"，等它取完 */
async function locate(page: Page, label = "回到我现在的位置") {
  await page.locator(`.map-locate button[aria-label="${label}"]`).click();
  await page.locator(".map-locate button:not([aria-busy])").waitFor({ timeout: 15_000 });
}
/** 蓝点在不在地图那块正中间（差几个像素以内）、右边离左边那一栏多远 */
async function dotOffset(page: Page) {
  const dot = (await page.locator('.map-mark[data-kind="me"] .map-pin').boundingBox())!;
  const canvas = (await page.locator(".map-canvas").boundingBox())!;
  return { dx: dot.x + dot.width / 2 - (canvas.x + canvas.width / 2), dy: dot.y + dot.height / 2 - (canvas.y + canvas.height / 2), x: dot.x };
}
/** 量一个元素（没有是 undefined） */
const boxOf = async (page: Page, selector: string) => (await page.locator(selector).first().boundingBox()) ?? undefined;
/** 地图页的标题栏一行（444）：标题栏里的东西都在右边以内、不比标题栏高 */
async function titleBarOneLine(page: Page, width: number) {
  const bar = (await boxOf(page, ".map-page > .topbar"))!;
  const inside = (await page.evaluate(`[...document.querySelectorAll(".map-page > .topbar *")].map((e) => e.getBoundingClientRect()).filter((r) => r.width > 0).map((r) => [r.right, r.bottom])`)) as Array<[number, number]>;
  expect(Math.max(...inside.map(([r]) => r))).toBeLessThanOrEqual(width);
  expect(Math.max(...inside.map(([, b]) => b))).toBeLessThanOrEqual(bar.y + bar.height + 1);
}
// 地图的二狗按钮按住说话只依赖语音插件（444 追加）：浏览插件停用时照样能说（识别走内核的 /api/talk-voice，演示页里是假的识别）；
// 语音插件停用时长按写一句"语音插件没启用"，点一下照样打字。麦克风是假的：getUserMedia 换成一个振荡器的声音
const FAKE_MIC = [
  `navigator.mediaDevices.getUserMedia = async () => {`,
  `  const ctx = new AudioContext(); const osc = ctx.createOscillator(); const dest = ctx.createMediaStreamDestination();`,
  `  osc.frequency.value = 440; osc.connect(dest); osc.start(); return dest.stream;`,
  `};`,
].join("\n");
/** 按住二狗按钮 ms 毫秒再松开 */
async function holdFab(page: Page, ms: number) {
  const fab = (await boxOf(page, ".map-fab"))!;
  await page.mouse.move(fab.x + fab.width / 2, fab.y + fab.height / 2);
  await page.mouse.down();
  await page.waitForTimeout(ms);
  await page.mouse.up();
}
const WEST_LAKE = { latitude: 30.2604, longitude: 120.1433, accuracy: 40 };
/** 停用谷歌地图插件（446）：429、442、445 那几条照没有谷歌时的样子测（新加坡"自动"是 OpenStreetMap） */
const NO_GOOGLE = "?demo-plugins-off=google-maps";
const MARINA_BAY = { latitude: 1.2847, longitude: 103.8591, accuracy: 30 };

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
    expect(await page.locator('.recall-line, .xcard-reminder, .xcard-memory_delete, [data-card-type="reminder"], [data-card-type="memory_delete"]').count()).toBe(0);
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

  // Codex 接入（454）：演示页默认是从组件页装好了（插件页写登录的完整命令）；?demo-codex=missing 时组件没装、插件没装上（写怎么装）、新建任务时 Codex 灰着
  test("设置 · 组件里有 Codex 接入一行；设置 · 插件里 Codex 写登录的完整命令；没装时写怎么装、能从组件页装", async () => {
    const { page, errors } = await open({ width: 1280, height: 800 });
    await page.evaluate(`window.location.hash = "#/more/components"`);
    await page.locator('[data-component="codex"]').waitFor();
    const row = await page.locator('[data-component="codex"]').innerText();
    expect(row).toContain("Codex 接入");
    expect(row).toContain("0.166.0");
    expect(row).toContain("Apache-2.0");
    await page.evaluate(`window.location.hash = "#/more/plugins"`);
    await page.locator('[data-plugin="codex"] .plugin-note-command').waitFor();
    expect(await page.locator('[data-plugin="codex"] .plugin-note').innerText()).toContain("在这台电脑的 PowerShell 里运行下面这条命令");
    expect(await page.locator('[data-plugin="codex"] .plugin-note-command').innerText()).toMatch(/^& '.+node\.exe' '.+components\\codex\\node_modules\\@openai\\codex\\bin\\codex\.js' login$/);
    await page.close();

    const missing = await open({ width: 390, height: 844 }, "?demo-codex=missing");
    await missing.page.evaluate(`window.location.hash = "#/more/plugins"`);
    await missing.page.locator('[data-plugin="codex"]').waitFor();
    const plugin = await missing.page.locator('[data-plugin="codex"]').innerText();
    expect(plugin).toContain("没装");
    expect(plugin).toContain("到设置 · 组件里装「Codex 接入」");
    expect(await missing.page.locator('[data-plugin="codex"] .plugin-note').count()).toBe(0);
    await missing.page.evaluate(`window.location.hash = "#/more/components"`);
    await missing.page.locator('[data-component="codex"]').waitFor();
    expect(await missing.page.locator('[data-component="codex"] .component-actions').innerText()).toContain("安装");
    await missing.page.close();
    expect([...errors, ...missing.errors]).toEqual([]);
  }, 60_000);

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

  // 地图页（429）：演示页里当作填了高德 Key，国内那一处用假的高德（占位底图）；点地点、地址里带位置都会自动换底图；
  // OSM 有署名角标；深色时 OSM 的瓦片加滤镜；一个请求都不往外发（不连高德、不连 OSM）。446 起演示页也"填好了"谷歌地图
  // （新加坡"自动"用谷歌）：这几条停用谷歌地图插件（?demo-plugins-off=google-maps）测；谷歌在的样子见后面 446 的几条。
  // 451：国外没填谷歌时"自动"是高德（高德国外的优先级 30）；高德还在加载时不先画 OpenStreetMap（中性的空底和一句"正在加载"）；
  // 国外手动选了 OpenStreetMap 才是 OpenStreetMap
  for (const [name, viewport] of [
    ["手机宽", { width: 390, height: 844 }],
    ["电脑宽", { width: 1280, height: 800 }],
  ] as const) {
    test(`地图页${name}：国内高德、新加坡没填谷歌也是高德（不先闪 OpenStreetMap），国外选了 OpenStreetMap 才换，点地点、改地址自动换底图，有署名，深色加滤镜，不往外发请求`, async () => {
      const { page, errors } = await open(viewport, NO_GOOGLE);
      const outside: string[] = [];
      page.on("request", (r) => {
        if (!/^(?:file|data|blob):/.test(r.url())) outside.push(r.url());
      });
      await page.evaluate(`localStorage.setItem("ergo-map-footprints", "off")`);
      // 记下地图那块画过哪几种底图：高德加载着的那一会儿是 loading，不是 osm
      await page.evaluate(`(() => { window.__basemaps = []; new MutationObserver(() => { const c = document.querySelector(".map-canvas"); const b = c && c.getAttribute("data-basemap"); if (b && window.__basemaps.at(-1) !== b) window.__basemaps.push(b); }).observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ["data-basemap"] }); })()`);
      await page.evaluate(`window.location.hash = "#/more/map"`);
      const canvas = page.locator(".map-canvas");
      await page.locator('.map-canvas[data-basemap="amap"]').waitFor({ timeout: 5000 });
      expect(await page.evaluate(`window.__basemaps`)).toEqual(["loading", "amap"]);
      expect(await page.locator(".map-badge").innerText()).toBe("高德地图");
      await page.locator('[data-engine="amap"] .map-tiles img').first().waitFor({ timeout: 5000 });
      // 453：点画在盖在高德上面的自己那一层，高德那一块里一个点都没有
      expect(await page.locator('.map-page-overlay .map-mark[data-id="demo-west-lake"]').count()).toBe(1);
      expect(await page.locator('[data-engine="amap"] .map-mark').count()).toBe(0);
      // 点新加坡：没填谷歌，"自动"照样是高德（同一张高德地图挪过去）
      await page.locator('[data-place="demo-marina-bay"]').click();
      await page.waitForTimeout(800);
      expect(await canvas.getAttribute("data-basemap")).toBe("amap");
      expect(await page.locator('.map-page-overlay .map-mark[data-id="demo-marina-bay"]').count()).toBe(1);
      expect(await page.evaluate(`window.__basemaps`)).toEqual(["loading", "amap"]);
      // 国外选 OpenStreetMap（记在这台设备上）：换成 OpenStreetMap，右下角有署名
      await page.evaluate(`localStorage.setItem("ergo-map-choice", JSON.stringify({ abroad: "osm" }))`);
      await page.reload();
      await page.evaluate(`window.location.hash = "#/more/map/1.2834%2C103.8607%2C14"`);
      await page.locator('.map-canvas[data-basemap="osm"]').waitFor({ timeout: 5000 });
      expect(await page.locator(".map-badge").innerText()).toBe("OpenStreetMap");
      expect(await page.locator(".map-attribution").innerText()).toContain("© OpenStreetMap 贡献者");
      await page.locator('[data-engine="osm"] .map-tiles img').first().waitFor({ timeout: 5000 });
      // 放大一级：还是新加坡、还是 OSM
      await page.locator('.map-zoom button[aria-label="放大"]').click();
      expect(await canvas.getAttribute("data-basemap")).toBe("osm");
      // 点回西湖：国内照旧自动，换回高德
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
      expect(await page.evaluate(`getComputedStyle(document.querySelector(".map-tiled.dark .map-tiles")).filter`)).toContain("invert");
      await page.evaluate(`localStorage.removeItem("ergo-theme")`);
      await page.evaluate(`localStorage.removeItem("ergo-map-choice")`);
      await page.close();
      expect(outside).toEqual([]);
      expect(errors).toEqual([]);
    }, 60_000);
  }

  // 地图切换（445）：标题栏最右边，手机宽收进 ⋮（底部弹层）、电脑宽一个下拉。演示页里登记了高德（假的）、OpenStreetMap 两家（停用谷歌）：
  // 国内列"自动 / 高德地图 / OpenStreetMap"，451 起国外也列高德（"自动（现在是高德地图）/ 高德地图 / OpenStreetMap"）；
  // 选了记在这台设备上、国内国外分开记，刷新还在；记着的那一家在这里用不了时退回"自动"、说一句；一个请求都不往外发
  test("地图切换手机宽：国内选 OpenStreetMap 换底图、记在这台设备上（刷新还在），国外照旧自动（没填谷歌是高德）、只列能用的；选回自动换回高德", async () => {
    const { page, errors } = await open({ width: 390, height: 844 }, NO_GOOGLE);
    const outside: string[] = [];
    page.on("request", (r) => {
      if (!/^(?:file|data|blob):/.test(r.url())) outside.push(r.url());
    });
    await page.evaluate(`localStorage.setItem("ergo-map-footprints", "off")`);
    await page.evaluate(`window.location.hash = "#/more/map"`);
    const canvas = page.locator(".map-canvas");
    await page.locator('.map-canvas[data-basemap="amap"]').waitFor({ timeout: 5000 });
    // ⋮ 在标题栏最右边那一格里，不出右边
    const more = page.locator('.topbar .map-bar-tools button.map-switch-more[aria-label="地图：自动"]');
    await more.click();
    const sheet = page.locator(".map-switch-sheet");
    await sheet.waitFor({ timeout: 5000 });
    expect(await sheet.locator(".map-switch-head").innerText()).toBe("在国内用哪家地图");
    expect(await sheet.locator(".map-switch-item").evaluateAll((els) => els.map((e) => e.getAttribute("data-id")))).toEqual(["auto", "amap", "osm"]);
    expect(await sheet.locator('.map-switch-item[aria-checked="true"]').getAttribute("data-id")).toBe("auto");
    expect(await sheet.locator('.map-switch-item[data-id="auto"]').innerText()).toContain("现在是高德地图");
    expect(await sheet.innerText()).toContain("地图页、足迹、聊天里的地图卡片都用这一家当底图，查地点、算路线也先用它");
    // 453：足迹和二狗画的点、线只在这台设备上画
    expect(await sheet.innerText()).toContain("足迹和二狗画的点、线只在这台设备上画，这一家只知道你在看哪一片");
    expect(await sheet.innerText()).not.toContain("一律用 OpenStreetMap");
    await sheet.locator('.map-switch-item[data-id="osm"]').click();
    await page.locator('.map-canvas[data-basemap="osm"][data-choice="osm"]').waitFor({ timeout: 5000 });
    expect(await page.locator(".map-switch-sheet").count()).toBe(0);
    expect(await page.evaluate(`localStorage.getItem("ergo-map-choice")`)).toBe('{"mainland":"osm"}');
    // 国外：照旧自动——没填谷歌，是高德；列"自动 / 高德地图 / OpenStreetMap"
    await page.locator('[data-place="demo-marina-bay"]').click();
    await page.locator('.map-canvas[data-choice="auto"][data-basemap="amap"]').waitFor({ timeout: 5000 });
    await page.locator('button.map-switch-more[aria-label="地图：自动"]').click();
    expect(await sheet.locator(".map-switch-head").innerText()).toBe("在国外用哪家地图");
    expect(await sheet.locator(".map-switch-item").evaluateAll((els) => els.map((e) => e.getAttribute("data-id")))).toEqual(["auto", "amap", "osm"]);
    expect(await sheet.locator('.map-switch-item[data-id="auto"]').innerText()).toContain("现在是高德地图");
    await page.locator('.modal button[aria-label="关闭"]').click();
    // 回国内：记着的 OpenStreetMap；刷新还在
    await page.locator('[data-place="demo-west-lake"]').click();
    await page.locator('.map-canvas[data-choice="osm"][data-basemap="osm"]').waitFor({ timeout: 5000 });
    await page.reload();
    await page.evaluate(`window.location.hash = "#/more/map"`);
    await page.locator('.map-canvas[data-choice="osm"][data-basemap="osm"]').waitFor({ timeout: 5000 });
    // 选回自动：换回高德
    await page.locator('button.map-switch-more[aria-label="地图：OpenStreetMap"]').click();
    await page.locator('.map-switch-sheet .map-switch-item[data-id="auto"]').click();
    await page.locator('.map-canvas[data-choice="auto"][data-basemap="amap"]').waitFor({ timeout: 5000 });
    expect(await page.evaluate(`localStorage.getItem("ergo-map-choice")`)).toBeNull();
    expect(await canvas.getAttribute("data-basemap")).toBe("amap");
    await page.close();
    expect(outside).toEqual([]);
    expect(errors).toEqual([]);
  }, 60_000);

  // 455：OpenStreetMap、高德地图、谷歌地图各是一个插件。停用高德：地图切换里没有它，国内"自动"是 OpenStreetMap；
  // 三家都停了：地图那块空着，说"没有能用的地图，去设置 · 插件里启用一家"，点了去设置 · 插件；聊天里的地图卡片只有字
  test("455 停用高德地图插件：地图切换里没有高德、国内自动是 OpenStreetMap；记着选高德的退回自动", async () => {
    const { page, errors } = await open({ width: 1280, height: 800 }, "?demo-plugins-off=amap,google-maps");
    await page.evaluate(`localStorage.setItem("ergo-map-footprints", "off")`);
    await page.evaluate(`localStorage.setItem("ergo-map-choice", JSON.stringify({ mainland: "amap" }))`);
    await page.evaluate(`window.location.hash = "#/more/map"`);
    await page.locator('.map-canvas[data-basemap="osm"]').waitFor({ timeout: 5000 });
    expect(await page.locator(".map-canvas").getAttribute("data-basemap-amap")).toBeNull();
    const btn = page.locator(".topbar .map-bar-tools button.map-switch-btn");
    await btn.click();
    const menu = page.locator(".popup.map-switch-menu");
    await menu.waitFor({ timeout: 5000 });
    expect(await menu.locator(".map-switch-item").evaluateAll((els) => els.map((e) => e.getAttribute("data-id")))).toEqual(["auto", "osm"]);
    expect(await menu.locator('.map-switch-item[data-id="auto"]').innerText()).toContain("现在是OpenStreetMap");
    expect(await page.locator(".map-attribution a").innerText()).toBe("© OpenStreetMap");
    await page.close();
    expect(errors).toEqual([]);
  }, 60_000);

  test("455 三家地图插件都停了：地图页说没有能用的地图、去启用进设置 · 插件；地图卡片只有字；英文", async () => {
    const OFF = "?demo-plugins-off=openstreetmap,amap,google-maps";
    const { page, errors } = await open({ width: 390, height: 844 }, OFF);
    await page.evaluate(`localStorage.setItem("ergo-map-footprints", "off")`);
    await page.evaluate(`window.location.hash = "#/more/map"`);
    await page.locator('.map-canvas[data-basemap="none"]').waitFor({ timeout: 5000 });
    const hint = page.locator(".map-hint[data-no-map]");
    await hint.waitFor({ timeout: 5000 });
    expect(await hint.innerText()).toContain("没有能用的地图，去设置 · 插件里启用一家");
    // 没有底图：没有放大缩小、没有署名、没有底图名字
    expect(await page.locator(".map-zoom").count()).toBe(0);
    expect(await page.locator(".map-attribution").count()).toBe(0);
    expect(await page.locator(".map-badge").count()).toBe(0);
    await hint.locator("button").click();
    await page.waitForFunction(`window.location.hash === "#/more/plugins"`, undefined, { timeout: 5000 });
    for (const name of ["map", "openstreetmap", "amap", "google-maps"]) expect(await page.locator(`.plugin-row[data-plugin="${name}"]`).count()).toBe(1);
    // 聊天里的地图卡片：足迹、点画不了图，只有字
    await page.evaluate(`window.location.hash = "#/more/map/card/c-map-points"`);
    await page.locator('.map-canvas[data-basemap="none"]').waitFor({ timeout: 5000 });
    await page.close();
    const en = await open({ width: 1280, height: 800 }, `${OFF}&lang=en`);
    await en.page.evaluate(`window.location.hash = "#/more/map"`);
    await en.page.locator(".map-hint[data-no-map]").waitFor({ timeout: 5000 });
    expect(await en.page.locator(".map-hint[data-no-map]").innerText()).toContain("Settings · Plugins");
    await en.page.close();
    expect(errors).toEqual([]);
    expect(en.errors).toEqual([]);
  }, 60_000);

  // 451：高德国外也能用了，"记着的那一家用不了"改用谷歌扮：演示页扮这台设备连不上谷歌（?demo-google=unreachable，过一会儿加载失败）
  test("地图切换电脑宽：标题栏一个下拉\"地图：自动\"，贴着它弹出；选了写它的名字；记着的那一家在这里用不了时退回自动、说一句能关上；英文", async () => {
    const UNREACHABLE = "?demo-google=unreachable";
    const { page, errors } = await open({ width: 1280, height: 800 }, UNREACHABLE);
    await page.evaluate(`localStorage.setItem("ergo-map-footprints", "off")`);
    // 记着在国外用谷歌（这台设备连不上谷歌）
    await page.evaluate(`localStorage.setItem("ergo-map-choice", JSON.stringify({ abroad: "google" }))`);
    await page.evaluate(`window.location.hash = "#/more/map"`);
    await page.locator('.map-canvas[data-basemap="amap"]').waitFor({ timeout: 5000 });
    const btn = page.locator(".topbar .map-bar-tools button.map-switch-btn");
    expect(await btn.innerText()).toBe("地图：自动");
    await btn.click();
    const menu = page.locator(".popup.map-switch-menu");
    await menu.waitFor({ timeout: 5000 });
    // 国内："自动"会挑的高德、OpenStreetMap 在前，只能手动选的谷歌在后
    expect(await menu.locator(".map-switch-item").evaluateAll((els) => els.map((e) => e.getAttribute("data-id")))).toEqual(["auto", "amap", "osm", "google"]);
    await menu.locator('.map-switch-item[data-id="osm"]').click();
    await page.locator('.map-canvas[data-basemap="osm"]').waitFor({ timeout: 5000 });
    expect(await btn.innerText()).toBe("地图：OpenStreetMap");
    // 去新加坡：记着的谷歌这台设备加载不上（加载着时不先画 OpenStreetMap），退回自动（高德）、说一句；能关上
    await page.locator('[data-place="demo-marina-bay"]').click();
    await page.locator('.map-canvas[data-pending="google"]').waitFor({ timeout: 5000 });
    expect(await page.locator(".map-loading-basemap").innerText()).toBe("正在加载谷歌地图…");
    const note = page.locator(".map-hint[data-fell-back]");
    await note.waitFor({ timeout: 5000 });
    expect(await note.innerText()).toContain("谷歌地图现在用不了，换回了“自动”");
    await page.locator('.map-canvas[data-choice="auto"][data-basemap="amap"]').waitFor({ timeout: 5000 });
    expect(await page.evaluate(`localStorage.getItem("ergo-map-choice")`)).toBe('{"mainland":"osm"}');
    await note.locator('button[aria-label="关上"]').click();
    expect(await page.locator(".map-hint[data-fell-back]").count()).toBe(0);
    // 照"自动"画着高德：说一句谷歌没加载上、先用高德（451）
    await expect.poll(() => page.locator(".map-hint").innerText(), { timeout: 5000 }).toMatch(/^谷歌地图没加载上（连不上谷歌[\s\S]*），先用高德地图$/);
    // 英文
    await page.goto(pageUrl + `${UNREACHABLE}&lang=en`);
    await page.evaluate(`window.location.hash = "#/more/map"`);
    await page.locator(".map-canvas:not([data-basemap=loading])").waitFor({ timeout: 5000 });
    expect(await page.locator(".topbar button.map-switch-btn").innerText()).toBe("Map: OpenStreetMap");
    await page.close();
    expect(errors).toEqual([]);
  }, 60_000);

  // 谷歌地图（446）：演示页"填好了"谷歌地图的 Key（谷歌是假的、瓦片是编的占位图）。新加坡"自动"用谷歌（优先级 50 高于 OpenStreetMap）；
  // 地图切换里国外列"自动 / 谷歌地图 / OpenStreetMap"，国内也列谷歌（手动选它时大陆的点转 GCJ-02，点照样画得上）；
  // 谷歌说 Key 不对（扮谷歌在框里叫 gm_authFailure）：退回"自动"、说一句，切换里标"连不上"；一个请求都不往外发。
  // 453：谷歌关在隔离框里（sandbox="allow-scripts"，读不到地图页），点画在外面自己那一层；拖地图的手势穿过那一层落到框里的谷歌上；
  // 交给框的消息里没有点（只有设置和视野）
  test("谷歌地图手机宽：新加坡自动用谷歌（关在隔离框里）、切换里国内国外都列它；国内手动选谷歌点照样画上；交给谷歌的没有点；谷歌拒了 Key 退回自动、标连不上", async () => {
    const { page, errors } = await open({ width: 390, height: 844 });
    await page.context().addInitScript(FRAME_SPY);
    const outside: string[] = [];
    page.on("request", (r) => {
      if (!/^(?:file|data|blob):/.test(r.url())) outside.push(r.url());
    });
    await page.evaluate(`localStorage.setItem("ergo-map-footprints", "off")`);
    await page.evaluate(`window.location.hash = "#/more/map"`);
    await page.locator('.map-canvas[data-basemap="amap"]').waitFor({ timeout: 5000 });
    // 新加坡：自动用谷歌
    await page.locator('[data-place="demo-marina-bay"]').click();
    await page.locator('.map-canvas[data-basemap="google"][data-choice="auto"]').waitFor({ timeout: 5000 });
    expect(await page.locator(".map-badge").innerText()).toBe("谷歌地图");
    const frame = page.frameLocator('[data-engine="google"] iframe.map-frame');
    await frame.locator('[data-fake-google="google"] img').first().waitFor({ timeout: 5000 });
    expect(await page.locator('[data-engine="google"] iframe.map-frame').getAttribute("sandbox")).toBe("allow-scripts");
    // 框里读不到地图页（不透明来源）
    const inFrame = await googleFrame(page);
    expect(await inFrame.evaluate(`(() => { try { return String(parent.document.title); } catch (e) { return e.name; } })()`)).toBe("SecurityError");
    expect(await inFrame.evaluate(`(() => { try { localStorage.length; return "ok"; } catch (e) { return e.name; } })()`)).toBe("SecurityError");
    // 点在外面自己那一层，框里一个点都没有
    const pin = page.locator('.map-page-overlay .map-mark[data-id="demo-marina-bay"]');
    expect(await pin.count()).toBe(1);
    expect(await frame.locator(".map-mark").count()).toBe(0);
    // 在地图空处拖：手势穿过那一层落到框里的谷歌上，点跟着挪
    const before = (await pin.boundingBox())!;
    const mapBox = (await page.locator(".map-canvas").boundingBox())!;
    await page.mouse.move(mapBox.x + 60, mapBox.y + mapBox.height - 120);
    await page.mouse.down();
    for (let i = 1; i <= 10; i++) await page.mouse.move(mapBox.x + 60 + i * 8, mapBox.y + mapBox.height - 120 - i * 4);
    await page.mouse.up();
    await expect.poll(async () => Math.round((await pin.boundingBox())!.x - before.x), { timeout: 5000 }).toBeGreaterThanOrEqual(70);
    // 交给框的：init（代码和设置）和视野指令，没有点的编号、名字、坐标
    const got = (await inFrame.evaluate("window.__got")) as string[];
    expectOnlyViewMessages(got);
    for (const m of got) {
      expect(m).not.toContain("demo-marina-bay");
      expect(m).not.toContain("滨海湾");
    }
    // OpenStreetMap 的署名不画（谷歌自己画它的标志）
    expect(await page.locator(".map-attribution a").count()).toBe(0);
    const sheet = page.locator(".map-switch-sheet");
    await page.locator('button.map-switch-more[aria-label="地图：自动"]').click();
    await sheet.waitFor({ timeout: 5000 });
    expect(await sheet.locator(".map-switch-head").innerText()).toBe("在国外用哪家地图");
    // 451：国外谷歌（50）> 高德（30）> OpenStreetMap
    expect(await sheet.locator(".map-switch-item").evaluateAll((els) => els.map((e) => e.getAttribute("data-id")))).toEqual(["auto", "google", "amap", "osm"]);
    expect(await sheet.locator('.map-switch-item[data-id="auto"]').innerText()).toContain("现在是谷歌地图");
    await page.locator('.modal button[aria-label="关闭"]').click();
    // 国内：自动照旧高德；切换里也列谷歌，选了它就用谷歌（大陆的点转 GCJ-02 画上）
    await page.locator('[data-place="demo-west-lake"]').click();
    await page.locator('.map-canvas[data-basemap="amap"]').waitFor({ timeout: 5000 });
    await page.locator('button.map-switch-more[aria-label="地图：自动"]').click();
    // 国内："自动"会挑的高德、OpenStreetMap 在前，只能手动选的谷歌在后（451）
    expect(await sheet.locator(".map-switch-item").evaluateAll((els) => els.map((e) => e.getAttribute("data-id")))).toEqual(["auto", "amap", "osm", "google"]);
    await sheet.locator('.map-switch-item[data-id="google"]').click();
    await page.locator('.map-canvas[data-basemap="google"][data-choice="google"]').waitFor({ timeout: 5000 });
    expect(await page.evaluate(`localStorage.getItem("ergo-map-choice")`)).toBe('{"mainland":"google"}');
    await page.locator('.map-page-overlay .map-mark[data-id="demo-west-lake"]').waitFor({ timeout: 5000 });
    // 谷歌说 Key 不对（在框里叫它）：退回自动、说一句；切换里谷歌标"连不上"、点不了
    await (await googleFrame(page)).evaluate(`window.gm_authFailure()`);
    await page.locator('.map-canvas[data-basemap="amap"][data-choice="auto"]').waitFor({ timeout: 5000 });
    expect(await page.locator(".map-hint[data-fell-back]").innerText()).toContain("谷歌地图现在用不了，换回了“自动”");
    await page.locator('button.map-switch-more[aria-label="地图：自动"]').click();
    const google = sheet.locator('.map-switch-item[data-id="google"]');
    expect(await google.innerText()).toContain("连不上");
    expect(await google.isDisabled()).toBe(true);
    await page.close();
    expect(outside).toEqual([]);
    expect(errors).toEqual([]);
  }, 60_000);

  // 453：国内手动选了谷歌、开着足迹：足迹画在框外自己那一层，框里一个点都没有；交给框的只有设置和视野（拖、放大以后也是）
  test("谷歌当底图看足迹手机宽：足迹画在隔离框外面那一层，交给谷歌的消息里只有设置和视野", async () => {
    const { page, errors } = await open({ width: 390, height: 844 });
    await page.context().addInitScript(FRAME_SPY);
    await page.evaluate(`localStorage.setItem("ergo-map-choice", JSON.stringify({ mainland: "google" }))`);
    await page.evaluate(`localStorage.setItem("ergo-map-footprints", "on")`);
    await page.reload();
    await page.evaluate(`window.location.hash = "#/more/map"`);
    await page.locator('.map-canvas[data-basemap="google"][data-choice="google"]').waitFor({ timeout: 8000 });
    await page.locator('.map-google[data-state="ready"]').waitFor({ timeout: 8000 });
    const stays = page.locator('.map-page-overlay .map-mark[data-kind="stay"]');
    await stays.first().waitFor({ timeout: 8000 });
    expect(await stays.count()).toBe(3);
    expect(await page.locator(".map-page-overlay polyline, .map-page-overlay path").count()).toBeGreaterThan(0);
    expect(await page.frameLocator('[data-engine="google"] iframe.map-frame').locator(".map-mark").count()).toBe(0);
    // 放大一级、拖一下：视野指令照样只有视野
    await page.locator(".map-zoom button[aria-label='放大']").click();
    const box = (await page.locator(".map-canvas").boundingBox())!;
    await page.mouse.move(box.x + 60, box.y + box.height - 160);
    await page.mouse.down();
    await page.mouse.move(box.x + 140, box.y + box.height - 200, { steps: 8 });
    await page.mouse.up();
    await page.waitForTimeout(300);
    const got = (await (await googleFrame(page)).evaluate("window.__got")) as string[];
    expectOnlyViewMessages(got);
    expect(got.some((m) => m.includes('"type":"zoomBy"'))).toBe(true);
    for (const m of got) expect(m).not.toContain("北山街");
    await page.evaluate(`localStorage.removeItem("ergo-map-choice")`);
    await page.close();
    expect(errors).toEqual([]);
  }, 60_000);

  test("谷歌地图电脑宽：新加坡用谷歌，深色时重建成深色；停用谷歌地图插件退回高德（451：国外没填谷歌默认高德）；英文的名字", async () => {
    const { page, errors } = await open({ width: 1280, height: 800 });
    await page.evaluate(`localStorage.setItem("ergo-map-footprints", "off")`);
    await page.evaluate(`localStorage.setItem("ergo-theme", "dark")`);
    await page.reload();
    await page.evaluate(`window.location.hash = "#/more/map/1.2834%2C103.8607%2C14"`);
    await page.locator('.map-canvas[data-basemap="google"]').waitFor({ timeout: 5000 });
    await page.frameLocator('[data-engine="google"] iframe.map-frame').locator('[data-fake-google="googleDark"]').waitFor({ timeout: 5000 });
    expect(await page.locator(".topbar button.map-switch-btn").innerText()).toBe("地图：自动");
    await page.evaluate(`localStorage.removeItem("ergo-theme")`);
    // 停用谷歌地图插件：新加坡退回高德
    await page.goto(pageUrl + NO_GOOGLE);
    await page.evaluate(`window.location.hash = "#/more/map/1.2834%2C103.8607%2C14"`);
    await page.locator('.map-canvas[data-basemap="amap"]').waitFor({ timeout: 5000 });
    // 英文
    await page.goto(pageUrl + "?lang=en");
    await page.evaluate(`window.location.hash = "#/more/map/1.2834%2C103.8607%2C14"`);
    await page.locator('.map-canvas[data-basemap="google"]').waitFor({ timeout: 5000 });
    expect(await page.locator(".map-badge").innerText()).toBe("Google Maps");
    await page.close();
    expect(errors).toEqual([]);
  }, 60_000);

  // 设置 · 数据源 · 谷歌地图（446）：两个密码框、加限制的说明、每一项的用量、"超了还接着用"；测试并保存（原型里填什么都算过）；
  // 停用谷歌地图插件时写"没启用"
  test("设置 · 数据源 · 谷歌地图电脑宽：两个 Key、限制的说明、这个月的用量、超了还接着用；英文；插件停用时那一块不画", async () => {
    const { page, errors } = await open({ width: 1280, height: 800 });
    await page.evaluate(`window.location.hash = "#/more/data-sources/google-maps"`);
    const panel = page.locator("[data-google-maps-panel]");
    await panel.waitFor({ timeout: 5000 });
    expect(await panel.locator('input[type="password"]').count()).toBe(2);
    expect(await panel.innerText()).toMatch(/浏览器用的 Key[\s\S]*网站限制[\s\S]*服务端用的 Key[\s\S]*IP 地址/);
    expect(await panel.locator(".google-maps-usage-rows li").count()).toBe(7);
    expect(await panel.locator('[data-sku="textSearch"]').innerText()).toMatch(/搜地点\s*23 \/ 5,000/);
    // 451：卡片预览图（Maps Static API）一项用量、服务端 Key 下面一行"能用"
    expect(await panel.locator('[data-sku="staticMaps"]').innerText()).toMatch(/卡片预览图（静态地图）\s*58 \/ 10,000/);
    expect(await panel.locator('.google-maps-static[data-static-map="ok"]').innerText()).toBe("卡片预览图（Maps Static API）：能用");
    expect(await panel.locator('[data-field="serverKey"] .hint').first().innerText()).toContain("Maps Static API");
    await panel.locator('[data-field="serverKey"] input').fill("AIza-demo-typed-key-not-real-000000");
    await panel.locator("button.primary").click();
    await panel.locator(".hint[role=status]").waitFor({ timeout: 5000 });
    expect(await panel.locator(".hint[role=status]").innerText()).toContain("测过了，存好了");
    expect(await panel.locator('[data-field="serverKey"] input').inputValue()).toBe("");
    const overage = panel.locator('[data-field="allowOverage"] input');
    expect(await overage.isChecked()).toBe(false);
    await overage.click();
    await expect.poll(() => overage.isChecked(), { timeout: 5000 }).toBe(true);
    await page.goto(pageUrl + "?lang=en");
    await page.evaluate(`window.location.hash = "#/more/data-sources/google-maps"`);
    await page.locator("[data-google-maps-panel]").waitFor({ timeout: 5000 });
    expect(await page.locator("[data-google-maps-panel]").innerText()).toContain("Google Maps keys saved");
    // 扮 Maps Static API 没开：标"没开"，照样存着（不挡保存）
    await page.goto(pageUrl + "?demo-map-preview=google-off");
    await page.evaluate(`window.location.hash = "#/more/data-sources/google-maps"`);
    await page.locator('.google-maps-static[data-static-map="off"]').waitFor({ timeout: 5000 });
    expect(await page.locator('.google-maps-static[data-static-map="off"]').innerText()).toContain("卡片预览图（Maps Static API）：没开");
    // 停用谷歌地图插件：这一页照样打得开，填 Key 的那一块不画（网页那一半撤了）
    await page.goto(pageUrl + NO_GOOGLE);
    await page.evaluate(`window.location.hash = "#/more/data-sources/google-maps"`);
    await page.locator('[data-block="status"]').waitFor({ timeout: 5000 });
    expect(await page.locator("[data-google-maps-panel]").count()).toBe(0);
    await page.close();
    expect(errors).toEqual([]);
  }, 60_000);

  // "附近的 hawker centre"的回答（446）：演示的秘书主线里谷歌查的那一段——一段话、一张谷歌查的地图卡（451 起有谷歌的静态预览图，
  // 写"数据来自 Google 地图"），点开进地图页、画在谷歌底图上；Maps Static API 没开时（?demo-map-preview=google-off）卡片只有字、
  // 一句原因和"在谷歌地图上看"
  test("附近的 hawker centre 手机宽：回答里一张谷歌查的地图卡，有谷歌的预览图、写数据来自 Google 地图；点开画在谷歌底图上；预览图没开时只有字和原因", async () => {
    const { page, errors } = await open({ width: 390, height: 844 });
    const outside: string[] = [];
    page.on("request", (r) => {
      if (!/^(?:file|data|blob):/.test(r.url())) outside.push(r.url());
    });
    await page.evaluate(`window.location.hash = "#/secretary"`);
    const card = page.locator('.xcard-map[data-show="lookup"][data-state="ready"]').filter({ hasText: "附近的 hawker centre" });
    await card.waitFor({ timeout: 5000 });
    await card.scrollIntoViewIfNeeded();
    await card.locator('.map-card-thumb[data-provider="google"][data-preview="ready"] img.map-card-img').waitFor({ timeout: 5000 });
    expect(await card.locator(".map-card-img").getAttribute("alt")).toBe("谷歌地图上的「附近的 hawker centre」");
    expect(await card.innerText()).toMatch(/Maxwell Food Centre[\s\S]*数据来自 Google 地图/);
    expect(await card.locator(".map-card-go").count()).toBe(0);
    expect(await bodyText(page)).toContain("附近有 4 个 hawker centre，最近的是");
    await card.locator(".map-card-open").click();
    await page.locator('.map-canvas[data-basemap="google"][data-own-results="shown"]').waitFor({ timeout: 5000 });
    // 461：手机宽标题栏放不下几个字的概况整个不显示（不留半个字），这里看标题栏里写了什么，不看露没露出来
    expect(await page.locator(".map-card-bar").textContent()).toMatch(/附近的 hawker centre[\s\S]*数据来自 Google 地图/);
    await page.locator('.map-page-overlay .map-mark[data-kind="search"]').first().waitFor({ timeout: 5000 });
    expect(await page.locator('.map-page-overlay .map-mark[data-kind="search"]').count()).toBe(4);
    // Maps Static API 没开：卡片只有字、一句原因、"在谷歌地图上看"
    await page.goto(pageUrl + "?demo-map-preview=google-off");
    await page.evaluate(`window.location.hash = "#/secretary"`);
    const hawker = page.locator(".xcard-map").filter({ hasText: "附近的 hawker centre" });
    await hawker.waitFor({ timeout: 5000 });
    await hawker.scrollIntoViewIfNeeded();
    const off = page.locator('.xcard-map[data-thumb="none"]').filter({ hasText: "附近的 hawker centre" });
    await off.waitFor({ timeout: 5000 });
    expect(await off.locator(".map-card-thumb").count()).toBe(0);
    expect(await off.innerText()).toMatch(/数据来自 Google 地图[\s\S]*预览图没出来：谷歌的 Maps Static API 没开[\s\S]*在谷歌地图上看/);
    await page.close();
    expect(outside).toEqual([]);
    expect(errors).toEqual([]);
  }, 60_000);

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
      // "足迹"默认关着（444）：这里先打开
      await page.evaluate(`localStorage.setItem("ergo-map-footprints", "on")`);
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
      // 选日期的那一组在标题栏里、和"地图"一行（442 追加）：手机宽写短的（"3 处 · 6 张"、11/06 这样的日期，开关只剩图标）
      const phone = viewport.width < 600;
      expect(await page.locator(".topbar .map-day-bar").count()).toBe(1);
      expect(await page.locator(".map-page > .map-day-bar").count()).toBe(0);
      expect(await page.locator(".map-day-summary").innerText()).toContain(phone ? "3 处 · 6 张" : "待过 3 个地方 · 6 张照片");
      expect(await page.locator(".map-day-short").allInnerTexts()).toEqual(phone ? [yesterday.slice(5).replace("-", "/")] : []);
      expect((await page.locator(".map-day-layer").innerText()).trim()).toBe(phone ? "" : "足迹");
      // 一行放得下：标题栏里的东西都不出右边
      const barRight = await page.evaluate(`Math.max(...[...document.querySelectorAll(".map-page > .topbar *")].map((e) => e.getBoundingClientRect().right))`);
      expect(barRight).toBeLessThanOrEqual(viewport.width);
      // 451 起看足迹也用当前地图（演示页当作填了高德 Key：国内是高德），足迹画在高德上
      expect(await page.locator(".map-canvas").getAttribute("data-basemap")).toBe("amap");
      expect(await page.locator(".map-canvas").getAttribute("data-basemap-amap")).toBe("ready");
      // 453：足迹画在盖在高德上面的自己那一层，不交给高德（高德那一块里一个点都没有）
      expect(await page.locator('.map-page-overlay .map-mark[data-kind="stay"]').count()).toBe(3);
      expect(await page.locator('[data-engine="amap"] .map-mark').count()).toBe(0);
      await details(page);
      // 前一天：空着，给最近有足迹的一天（四天前：家、健身房）
      await page.locator('.map-day-pick button[aria-label="前一天"]').click();
      await expect.poll(() => page.locator(".map-day-summary").innerText(), { timeout: 5000 }).toBe(phone ? "没有足迹" : "这一天没有足迹");
      expect(await page.locator(".map-day-note .btn").innerText()).toMatch(phone ? /^看 \d\d-\d\d$/ : /^看 \d\d-\d\d 那天$/);
      expect(await stays.count()).toBe(0);
      await page.locator(".map-day-note .btn").click();
      await page.locator('.map-mark[data-id="fp-stay-demo-fp-gym"]').waitFor({ timeout: 5000 });
      expect(await stays.count()).toBe(2);
      // "足迹"开关：关了不画（底图照旧高德），标题栏上不放选日期的那一组（444）；开回来又有（还是高德）
      await page.locator(".map-day-layer").click();
      expect(await page.locator(".map-day-layer").getAttribute("aria-pressed")).toBe("false");
      expect(await page.locator('.map-mark[data-id^="fp-"]').count()).toBe(0);
      expect(await page.locator(".map-day-bar").count()).toBe(0);
      await page.locator('.map-canvas[data-basemap="amap"]').waitFor({ timeout: 5000 });
      await page.locator(".map-day-layer").click();
      await stays.first().waitFor({ timeout: 5000 });
      await page.locator('.map-canvas[data-basemap="amap"]').waitFor({ timeout: 5000 });
      await page.close();
      expect(outside).toEqual([]);
      expect(errors).toEqual([]);
    }, 60_000);
  }

  // 点开别家查到的卡片（451）：这一屏临时用查它的那家（不改这台设备记着的选择），地图上面写一句；关了卡片回到记着的那家
  test("点开高德查的卡片手机宽：国内选了 OpenStreetMap，这一屏临时用高德画、写一句，不改记着的选择；关了回到 OpenStreetMap；英文", async () => {
    const { page, errors } = await open({ width: 390, height: 844 });
    await page.evaluate(`localStorage.setItem("ergo-map-footprints", "off")`);
    await page.evaluate(`localStorage.setItem("ergo-map-choice", JSON.stringify({ mainland: "osm" }))`);
    await page.evaluate(`window.location.hash = "#/more/map/card/c-map-route"`);
    await page.locator('.map-canvas[data-basemap="amap"][data-temporary="amap"][data-own-source="amap"][data-own-results="shown"]').waitFor({ timeout: 5000 });
    expect(await page.locator(".map-own-note").innerText()).toBe("这些是高德地图查的，所以用高德地图显示");
    expect(await page.locator(".map-canvas .map-shapes polyline").count()).toBe(2);
    expect(await page.locator(".map-hint").count()).toBe(0);
    expect(await page.evaluate(`localStorage.getItem("ergo-map-choice")`)).toBe('{"mainland":"osm"}');
    expect(await page.locator('button.map-switch-more').getAttribute("aria-label")).toBe("地图：OpenStreetMap");
    // 关了卡片：回到记着的 OpenStreetMap，那一句没了
    await page.locator('.map-card-bar button[aria-label="不看这张了"]').click();
    await page.locator('.map-canvas[data-basemap="osm"]:not([data-temporary])').waitFor({ timeout: 5000 });
    expect(await page.locator(".map-own-note").count()).toBe(0);
    // 英文
    await page.goto(pageUrl + "?lang=en");
    await page.evaluate(`window.location.hash = "#/more/map/card/c-map-route"`);
    await page.locator('.map-canvas[data-temporary="amap"]').waitFor({ timeout: 5000 });
    expect(await page.locator(".map-own-note").innerText()).toBe("These came from AMap, so they're shown on AMap");
    await page.evaluate(`localStorage.removeItem("ergo-map-choice")`);
    await page.close();
    expect(errors).toEqual([]);
  }, 60_000);

  // 谷歌查的卡片点开、这台设备连不上谷歌（451，演示页 ?demo-google=unreachable 扮设备在大陆）：等谷歌那一会儿不先画 OpenStreetMap，
  // 加载失败后地图那块放这张卡的静态预览大图（和卡片同一个接口），说一句；静态图也取不到（Maps Static API 没开）时退回原来那一句
  test("谷歌加载不了时点开谷歌查的卡手机宽：地图那块放静态预览大图、说连不上先给你看一张图；静态图也取不到时说画不上去", async () => {
    const { page, errors } = await open({ width: 390, height: 844 }, "?demo-google=unreachable");
    const outside: string[] = [];
    page.on("request", (r) => {
      if (!/^(?:file|data|blob):/.test(r.url())) outside.push(r.url());
    });
    await page.evaluate(`localStorage.setItem("ergo-map-footprints", "off")`);
    await page.evaluate(`window.location.hash = "#/more/map/card/c-map-hawker"`);
    await page.locator('.map-canvas[data-pending="google"]').waitFor({ timeout: 5000 });
    expect(await page.locator(".map-loading-basemap").innerText()).toBe("正在加载谷歌地图…");
    await page.locator('.map-canvas[data-own-results="static"]').waitFor({ timeout: 10_000 });
    await page.locator('.map-static[data-preview="ready"] img').waitFor({ timeout: 5000 });
    expect(await page.locator(".map-static img").getAttribute("src")).toMatch(/^data:image\/svg\+xml/);
    expect(await page.locator(".map-hint").innerText()).toBe("这台设备连不上谷歌地图，先给你看一张图");
    // 盖着静态图：不放放大缩小、不写底图的名字
    expect(await page.locator(".map-zoom").count()).toBe(0);
    expect(await page.locator(".map-badge").count()).toBe(0);
    // 静态大图上点旁边写名字（和地图页别的底图一样，451 补），字互相让开：两两不相交
    await expect.poll(async () => (await labelsSettled(page, ".map-static")).labels, { timeout: 5000 }).toBeGreaterThanOrEqual(4);
    expect(await page.locator(".map-static .map-mark-label").allInnerTexts()).toContain("Maxwell Food Centre");
    const labels = await labelsSettled(page, ".map-static");
    expect(labels.hits).toEqual([]);
    expect(labels.bad).toEqual([]);
    // Maps Static API 也没开：退回原来那一句（地图照常）
    await page.goto(pageUrl + "?demo-google=unreachable&demo-map-preview=google-off");
    await page.evaluate(`window.location.hash = "#/more/map/card/c-map-hawker"`);
    await page.locator('.map-canvas[data-own-results="hidden"]').waitFor({ timeout: 10_000 });
    await expect.poll(() => page.locator(".map-hint").innerText(), { timeout: 5000 }).toMatch(/谷歌地图没加载上（连不上谷歌[\s\S]*），谷歌地图查来的地点和路线画不上去/);
    expect(await page.locator(".map-static").count()).toBe(0);
    await page.close();
    expect(outside).toEqual([]);
    expect(errors).toEqual([]);
  }, 60_000);

  // 聊天里的地图卡片（431）：秘书主线里一张足迹卡（下面写概况）、一张高德查的路线卡（写走法和"数据来自高德地图"）、一组点；
  // 451 起都有预览图、跟着当前地图：国内是高德的静态图（演示页拿占位瓦片拼的），看到了才取；这台设备国内选了 OpenStreetMap 时
  // 足迹卡、点的卡退回自己画 OpenStreetMap，高德查的路线卡照旧高德（只能画在高德地图上）。路线卡点开：地图页那一条写标题，路线画在
  // （假的）高德底图上，"×"回到地图；足迹卡点开：看那一天，底图也是高德；一个请求都不往外发
  for (const [name, viewport] of [
    ["手机宽", { width: 390, height: 844 }],
    ["电脑宽", { width: 1280, height: 800 }],
  ] as const) {
    test(`聊天里的地图卡片${name}：足迹卡、点的卡、高德查的路线卡都是高德的预览图；选了 OpenStreetMap 时足迹卡自己画；点开进地图页看那一天、画这张卡`, async () => {
      const { page, errors } = await open(viewport);
      const outside: string[] = [];
      page.on("request", (r) => {
        if (!/^(?:file|data|blob):/.test(r.url())) outside.push(r.url());
      });
      await page.evaluate(`window.location.hash = "#/secretary"`);
      const day = page.locator('.xcard-map[data-show="day"]');
      await day.waitFor({ timeout: 5000 });
      // 看到了才取：聊天停在最底下，上面的足迹卡还没进屏幕，预览图还没取
      await page.waitForTimeout(600);
      expect(await day.locator(".map-card-thumb").getAttribute("data-preview")).toBe("loading");
      await day.scrollIntoViewIfNeeded();
      await day.locator('.map-card-thumb[data-provider="amap"][data-preview="ready"] img.map-card-img').waitFor({ timeout: 5000 });
      expect(await day.locator(".map-card-img").getAttribute("src")).toMatch(/^data:image\/svg\+xml/);
      // 453：图只是底图，停留的点（写着序号）、轨迹在本机画在上面那一层
      const overlay = day.locator(".map-static-overlay");
      await overlay.locator('.map-mark[data-kind="stay"]').first().waitFor({ timeout: 5000 });
      expect(await overlay.locator('.map-mark[data-kind="stay"] .map-mark-num').allInnerTexts()).toEqual(["1", "2", "3"]);
      expect(await overlay.locator("polyline.map-line-track").count()).toBeGreaterThan(0);
      // 点落在图里（没被裁到外面）、没盖住最下面标志那一条
      const thumbBox = (await day.locator(".map-card-thumb").boundingBox())!;
      const overlayBox = (await overlay.boundingBox())!;
      expect(overlayBox.y + overlayBox.height).toBeLessThanOrEqual(thumbBox.y + thumbBox.height - 20);
      for (const pin of await overlay.locator('.map-mark[data-kind="stay"]').all()) {
        const b = (await pin.boundingBox())!;
        expect(b.x).toBeGreaterThanOrEqual(thumbBox.x);
        expect(b.x + b.width).toBeLessThanOrEqual(thumbBox.x + thumbBox.width);
      }
      expect(await day.locator(".map-tiles").count()).toBe(0);
      expect(await day.locator(".map-attribution").count()).toBe(0);
      expect(await day.innerText()).toMatch(/待过 3 个地方 · 6 张照片[\s\S]*家、公司、杭州市西湖区北山街/);
      // 宽屏上预览图最宽 640（不把小图放大糊掉）
      expect((await day.locator(".map-card-thumb").boundingBox())!.width).toBeLessThanOrEqual(640);
      // 446 起演示里还有一张谷歌查的卡（附近的 hawker centre）：按标题挑路线这一张
      const route = page.locator('.xcard-map[data-show="lookup"][data-state="ready"]').filter({ hasText: "从公司到西湖边" });
      await route.waitFor({ timeout: 5000 });
      await route.scrollIntoViewIfNeeded();
      await route.locator('.map-card-thumb[data-provider="amap"][data-preview="ready"] img').waitFor({ timeout: 5000 });
      expect(await route.innerText()).toMatch(/从公司到西湖边[\s\S]*步行、开车[\s\S]*数据来自高德地图/);
      expect(await route.locator(".map-card-go").count()).toBe(0);
      const points = page.locator('.xcard-map[data-show="points"]');
      await points.scrollIntoViewIfNeeded();
      await points.locator('.map-card-thumb[data-provider="amap"][data-preview="ready"] img').waitFor({ timeout: 5000 });
      expect(await points.innerText()).toContain("灵隐寺、龙井村、九溪烟树");

      // 这台设备国内选了 OpenStreetMap：足迹卡、点的卡自己画 OpenStreetMap，高德查的路线卡照旧高德
      await page.evaluate(`localStorage.setItem("ergo-map-choice", JSON.stringify({ mainland: "osm" }))`);
      await page.reload();
      await page.evaluate(`window.location.hash = "#/secretary"`);
      await day.waitFor({ timeout: 5000 });
      await day.scrollIntoViewIfNeeded();
      await day.locator(".map-tiles img").first().waitFor({ timeout: 5000 });
      expect(await day.locator('.map-host[data-basemap="osm"]').count()).toBe(1);
      expect(await day.locator('.map-mark[data-kind="stay"]').count()).toBe(3);
      expect(await day.locator(".map-attribution").innerText()).toContain("© OpenStreetMap 贡献者");
      await route.scrollIntoViewIfNeeded();
      await route.locator('.map-card-thumb[data-provider="amap"][data-preview="ready"] img').waitFor({ timeout: 5000 });
      await page.evaluate(`localStorage.removeItem("ergo-map-choice")`);
      await page.reload();
      await page.evaluate(`window.location.hash = "#/secretary"`);
      await route.waitFor({ timeout: 5000 });
      await route.scrollIntoViewIfNeeded();
      await route.locator('.map-card-thumb[data-preview="ready"]').waitFor({ timeout: 5000 });

      // 路线卡点开：画这张卡（高德查的只画在高德底图上）
      await route.locator(".map-card-open").click();
      await page.locator('.map-canvas[data-own-source="amap"][data-own-results="shown"]').waitFor({ timeout: 5000 });
      expect(await page.evaluate("location.hash")).toBe("#/more/map/card/c-map-route");
      // 461：手机宽放不下几个字的概况整个不显示，这里看标题栏里写了什么
      expect(await page.locator(".map-card-bar").textContent()).toMatch(/从公司到西湖边[\s\S]*数据来自高德地图/);
      expect(await page.locator(".map-canvas").getAttribute("data-basemap")).toBe("amap");
      expect(await page.locator(".map-canvas .map-shapes polyline").count()).toBe(2);
      expect(await page.locator(".map-day-bar").count()).toBe(0);
      // 卡片的标题和概况在标题栏里（444：原来是标题栏下面单独一条）
      expect(await page.locator(".map-page > .topbar .map-card-bar").count()).toBe(1);
      // "×"：回到地图（"足迹"默认关着，444）
      await page.locator('.map-card-bar button[aria-label="不看这张了"]').click();
      await page.locator(".map-day-layer").waitFor({ timeout: 5000 });
      expect(await page.evaluate("location.hash")).toBe("#/more/map");

      // 足迹卡点开：看那一天，底图是当前地图（高德）
      await page.evaluate(`window.location.hash = "#/secretary"`);
      await day.scrollIntoViewIfNeeded();
      await page.locator('.xcard-map[data-show="day"] .map-card-open').click();
      await page.locator('.map-canvas .map-mark[data-kind="stay"]').first().waitFor({ timeout: 5000 });
      const yesterday = (await page.evaluate(`(() => { const d = new Date(); d.setDate(d.getDate() - 1); return [d.getFullYear(), String(d.getMonth() + 1).padStart(2, "0"), String(d.getDate()).padStart(2, "0")].join("-"); })()`)) as string;
      expect(await page.evaluate("location.hash")).toBe(`#/more/map/${yesterday}`);
      expect(await page.locator(".map-day-date").inputValue()).toBe(yesterday);
      await page.locator('.map-canvas[data-basemap="amap"]').waitFor({ timeout: 5000 });
      await page.close();
      expect(outside).toEqual([]);
      expect(errors).toEqual([]);
    }, 60_000);
  }

  // 回到我现在的位置（442）：帮手 openMap、locate、dotOffset 在文件上面
  test("回到我现在的位置手机宽：高德底图上有钮，浏览器给了位置就挪过去放大到街道级，画蓝点和精度圈；在新加坡定到的换成 OpenStreetMap、钮照样在", async () => {
    const { context, page, errors, outside } = await openMap({ width: 390, height: 844 }, { geo: WEST_LAKE, footprintsOff: true });
    try {
      await page.locator('.map-canvas[data-basemap="amap"]').waitFor({ timeout: 5000 });
      const button = page.locator('.map-locate button[aria-label="回到我现在的位置"]');
      expect(await button.count()).toBe(1);
      expect(await page.locator('.map-mark[data-kind="me"]').count()).toBe(0);
      await locate(page);
      // 还在国内：照样是高德（演示页的假高德），蓝点、精度圈画在盖在高德上面的自己那一层上（453），在地图正中
      expect(await page.locator(".map-canvas").getAttribute("data-basemap")).toBe("amap");
      // 蓝点、精度圈在挪过去之后的下一帧才画上：等它们出来再数
      await expect.poll(() => page.locator('.map-page-overlay .map-mark[data-kind="me"]').count(), { timeout: 5000 }).toBe(1);
      await expect.poll(() => page.locator('.map-page-overlay .map-shapes circle.map-circle-accuracy').count(), { timeout: 5000 }).toBe(1);
      // 挪过去、重画在下一帧：等它停下来再量
      await expect.poll(async () => { const at = await dotOffset(page); return Math.max(Math.abs(at.dx), Math.abs(at.dy)); }, { timeout: 5000 }).toBeLessThan(3);
      expect(await page.locator(".map-locate-note").count()).toBe(0);
      expect(await button.getAttribute("data-located")).toBe("");
      // 拖开再点：一分钟内直接回到那里（不再问浏览器）
      await page.locator(".map-zoom button[aria-label='缩小']").click();
      await page.mouse.move(200, 500);
      await page.mouse.down();
      await page.mouse.move(80, 380, { steps: 5 });
      await page.mouse.up();
      await expect.poll(async () => Math.abs((await dotOffset(page)).dx), { timeout: 5000 }).toBeGreaterThan(50);
      await locate(page);
      await expect.poll(async () => Math.abs((await dotOffset(page)).dx), { timeout: 5000 }).toBeLessThan(3);
      await context.close();

      // 人在新加坡（国外选了 OpenStreetMap；451 起没填谷歌时国外"自动"是高德）：挪过去后底图换成 OpenStreetMap，钮还在原处
      const sg = await openMap({ width: 390, height: 844 }, { geo: MARINA_BAY, footprintsOff: true, search: NO_GOOGLE, init: `localStorage.setItem("ergo-map-choice", JSON.stringify({ abroad: "osm" }))` });
      await sg.page.locator('.map-canvas[data-basemap="amap"]').waitFor({ timeout: 5000 });
      await locate(sg.page);
      await sg.page.locator('.map-canvas[data-basemap="osm"]').waitFor({ timeout: 5000 });
      await expect.poll(() => sg.page.locator('[data-engine="osm"] .map-mark[data-kind="me"]').count(), { timeout: 5000 }).toBe(1);
      await expect.poll(() => sg.page.locator('[data-engine="osm"] .map-shapes circle.map-circle-accuracy').count(), { timeout: 5000 }).toBe(1);
      expect(await sg.page.locator('.map-locate button[aria-label="回到我现在的位置"]').count()).toBe(1);
      await sg.context.close();
      expect(sg.outside).toEqual([]);
      expect(sg.errors).toEqual([]);
    } finally {
      await context.close();
    }
    expect(outside).toEqual([]);
    expect(errors).toEqual([]);
  }, 60_000);

  // 451 起看足迹也用当前地图：这里国内选 OpenStreetMap（照原样测 OSM 底图上让开左边那一栏、深色）
  test("藏起二狗画的标记手机宽：开着足迹（高德），右上第三个钮（眼睛）一点点、线、停留圈都看不见，「当前位置」照旧；再点又出来；地图照样能拖", async () => {
    const { context, page, errors, outside } = await openMap({ width: 390, height: 844 }, { geo: WEST_LAKE, footprintsOn: true });
    try {
      const canvas = page.locator(".map-canvas");
      const stay = page.locator('.map-mark[data-kind="stay"]').first();
      await stay.waitFor({ timeout: 8000 });
      await locate(page);
      const toggle = page.locator(".map-marks-toggle");
      expect(await toggle.getAttribute("aria-pressed")).toBe("false");
      expect(await toggle.getAttribute("aria-label")).toBe("先藏起二狗画的标记和路线，看底下的地图");
      await toggle.click();
      expect(await canvas.getAttribute("data-marks")).toBe("hidden");
      expect(await toggle.getAttribute("aria-pressed")).toBe("true");
      await expect.poll(async () => stay.isVisible()).toBe(false);
      expect(await page.locator(".map-line").first().isVisible()).toBe(false);
      expect(await page.locator('.map-mark[data-kind="me"]').isVisible()).toBe(true);
      // 藏着时照样能拖：视野变了，再显示时点照样在
      const box = (await canvas.boundingBox())!;
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
      await page.mouse.down();
      await page.mouse.move(box.x + box.width / 2 + 60, box.y + box.height / 2 + 40, { steps: 6 });
      await page.mouse.up();
      await toggle.click();
      expect(await canvas.getAttribute("data-marks")).toBeNull();
      await expect.poll(async () => stay.isVisible()).toBe(true);
    } finally {
      await context.close();
    }
    expect(outside).toEqual([]);
    expect(errors).toEqual([]);
  }, 60_000);
  // 458：双指捏合、松手回弹、双击放大、一指甩出去的惯性，这些过程中二狗画的那一层（足迹的点）跟着底图走、不漂（用户 11-09：
  // "缩放过程中标记漂移，停下来才对齐"）。用 CDP 发触摸事件：两指边捏边挪（放大约 3 倍、挪开几十像素），每一步量；松手后回弹的
  // 每一帧量；再双击、再甩一下，动画的每一帧量。量的是我们画的点（针尖）和底图此刻把同一个经纬度画在哪（瓦片 img 上写着 z/x/y，
  // 按瓦片的屏幕位置拟合"世界坐标 → 屏幕"）差多少像素：不超过 2。点的经纬度照演示页昨天的足迹在这边算（大陆里高德、谷歌用 GCJ-02）。
  // 谷歌是假的、关在隔离框里，照真谷歌的样子动（捏合时整块拉伸、getZoom 不跟，回弹、双击、惯性时 getZoom/getCenter 先跳到终点；
  // 458 修好以前这里差到上百像素）；高德是假的（自己一帧一帧画）；OpenStreetMap 自己画。停下来字照样两两不相交；交给谷歌框的照旧
  // 只有设置和视野；一个请求都不往外发。
  for (const kind of ["google", "amap", "osm"] as const) {
    test(`捏合、回弹、双击、惯性的过程中点跟着底图走手机宽（${kind === "google" ? "谷歌，隔离框" : kind === "amap" ? "高德" : "OpenStreetMap"}）`, async () => {
      const r = await followCheck(kind);
      expect(r.skipped).toBeUndefined();
      expect(r.problems).toEqual([]);
    }, 90_000);
  }
  // 同上，用真的谷歌脚本（不带 Key：谷歌照样出图、带"仅供开发"的水印；演示页的假谷歌在框里拦下，请求里去掉演示的假 Key）。
  // 要联网：连不上谷歌、谷歌不出图、瓦片地址认不出 z/x/y 时跳过并写明。另外查：发给谷歌的请求里没有足迹的经纬度
  test("捏合、回弹、双击、惯性的过程中点跟着底图走手机宽（真的谷歌，不带 Key，要联网）", async ({ skip }) => {
    const r = await followCheck("google-real");
    if (r.skipped) skip(r.skipped);
    expect(r.problems).toEqual([]);
  }, 120_000);

  // 地图上的字不互相盖住（451 补，用户 11-09）：演示页六天前绕西湖走了一圈（八处停留，中间五处挨得很近，一路拍照），字很挤——
  // 照旧在针的右边，挤的挪到针旁边别处或挪开、挪开的从字框边上画一条引线连到点；地图那块里看得见的字框两两不相交。
  // 高德（盖在上面的那一层）、OpenStreetMap、谷歌（隔离框外面那一层）、手机宽电脑宽、缩小一级以后都这样；「当前位置」的字一起让；
  // 眼睛钮藏起二狗画的那一层时引线一起藏（「当前位置」的字回到右边）；一个请求都不往外发
  for (const [name, viewport, choice] of [
    ["手机宽、高德", { width: 390, height: 844 }, undefined],
    ["手机宽、OpenStreetMap", { width: 390, height: 844 }, "osm"],
    ["电脑宽、谷歌", { width: 1280, height: 800 }, "google"],
  ] as const) {
    test(`地图上的字不互相盖住${name}：字很挤的一天字框两两不相交、挪开的有引线连到点，缩小一级照样；「当前位置」一起让；眼睛钮藏起来时引线也藏`, async () => {
      // 只在地图页本身设（init 脚本也进谷歌的隔离框，框里读不了 localStorage）
      const init = choice === undefined ? undefined : `if (window === window.top) localStorage.setItem("ergo-map-choice", JSON.stringify({ mainland: "${choice}" }))`;
      const { context, page, errors, outside } = await openMap(viewport, { footprintsOn: true, ...(init ? { init } : {}) });
      try {
        await page.evaluate(`window.location.hash = ${JSON.stringify(await walkDayHash(page))}`);
        const stays = page.locator('.map-mark[data-kind="stay"]');
        await expect.poll(() => stays.count(), { timeout: 8000 }).toBe(8);
        await page.locator(`.map-canvas[data-basemap="${choice ?? "amap"}"]`).waitFor({ timeout: 8000 });
        // 高德、谷歌：字画在盖在底图上面的自己那一层；OpenStreetMap 自己画
        expect(await page.locator(choice === "osm" ? '[data-engine="osm"] .map-leaders' : ".map-page-overlay .map-leaders").count()).toBe(1);
        await expect.poll(async () => (await labelsSettled(page)).labels, { timeout: 5000 }).toBeGreaterThanOrEqual(12);
        const first = await labelsSettled(page);
        // 手机宽一打开就挤（有挪开的）；电脑宽地方大，挪到针旁边就够了
        expect(viewport.width >= 600 || first.moved > 0).toBe(true);
        expect(first.hits).toEqual([]);
        expect(first.bad).toEqual([]);
        expect(first.leaders).toBe(first.moved);
        // 不挤的照旧在右边、不画线：最东边的断桥离别的远
        const bridge = page.locator('.map-mark[data-kind="stay"]').filter({ hasText: "断桥" }).locator(".map-mark-label");
        expect(await bridge.getAttribute("data-moved")).toBeNull();
        expect(await bridge.evaluate((l) => l.style.transform)).toBe("");
        // 缩小一级：更挤了，重排后照样不相交
        await page.locator('.map-zoom button[aria-label="缩小"]').click();
        await expect.poll(async () => (await labelsSettled(page)).moved, { timeout: 5000 }).toBeGreaterThan(first.moved);
        const out = await labelsSettled(page);
        expect(out.hits).toEqual([]);
        expect(out.bad).toEqual([]);
        expect(out.leaders).toBe(out.moved);
        // 眼睛钮：二狗画的连同引线都藏起来；再点又出来，引线也回来
        expect(out.leaders).toBeGreaterThan(0);
        await page.locator(".map-marks-toggle").click();
        await expect.poll(async () => (await labelsSettled(page)).leaders, { timeout: 5000 }).toBe(0);
        expect((await labelsSettled(page)).labels).toBe(0);
        await page.locator(".map-marks-toggle").click();
        await expect.poll(async () => (await labelsSettled(page)).leaders, { timeout: 5000 }).toBeGreaterThan(0);
        const back = await labelsSettled(page);
        expect(back.hits).toEqual([]);
        expect(back.leaders).toBe(back.moved);
        // 「当前位置」（浏览器没给权限，用手机 12 分钟前交来的点，西湖边、旁边写"手机 · 几点"）的字一起让
        await locate(page);
        const me = page.locator('.map-mark[data-kind="me"] .map-mark-label');
        expect(await me.innerText()).toMatch(/^手机 · \d\d:\d\d$/);
        await expect.poll(async () => (await labelsSettled(page)).labels, { timeout: 5000 }).toBeGreaterThan(1);
        const withMe = await labelsSettled(page);
        expect(withMe.hits).toEqual([]);
        expect(withMe.bad).toEqual([]);
        expect(withMe.leaders).toBe(withMe.moved);
        // 藏起来时只剩「当前位置」：它的字回到右边、没有引线
        await page.locator(".map-marks-toggle").click();
        await expect.poll(async () => (await labelsSettled(page)).labels, { timeout: 5000 }).toBe(1);
        expect((await labelsSettled(page)).leaders).toBe(0);
        expect(await me.isVisible()).toBe(true);
        await expect.poll(() => me.evaluate((l) => l.style.transform), { timeout: 5000 }).toBe("");
        expect(await me.getAttribute("data-moved")).toBeNull();
      } finally {
        await context.close();
      }
      expect(outside).toEqual([]);
      expect(errors).toEqual([]);
    }, 60_000);
  }

  test("回到我现在的位置电脑宽：开着足迹（选了 OpenStreetMap、左边列这一天），挪过去时让开左边那一栏；深色下钮、蓝点照样在", async () => {
    const { context, page, errors, outside } = await openMap({ width: 1280, height: 800 }, { geo: WEST_LAKE, init: `localStorage.setItem("ergo-theme", "dark"); localStorage.setItem("ergo-map-choice", JSON.stringify({ mainland: "osm" }))`, footprintsOn: true });
    try {
      await page.locator(".map-day-panel").waitFor({ timeout: 5000 });
      await locate(page);
      expect(await page.locator(".map-canvas").getAttribute("data-basemap")).toBe("osm");
      const panel = (await page.locator(".map-day-panel").boundingBox())!;
      // 蓝点在左边那一栏右边那块的正中：比整块的正中往右挪半栏（重画在下一帧：等它停下来再量）
      await expect.poll(async () => Math.abs((await dotOffset(page)).dx - 316 / 2), { timeout: 5000 }).toBeLessThan(4);
      expect((await dotOffset(page)).x).toBeGreaterThan(panel.x + panel.width);
      expect(await page.locator('.map-mark[data-kind="me"]').count()).toBe(1);
      expect(await page.locator(".map-tiled.dark").count()).toBe(1);
    } finally {
      await context.close();
    }
    expect(outside).toEqual([]);
    expect(errors).toEqual([]);
  }, 60_000);

  test("回到我现在的位置：浏览器没给权限，用手机 12 分钟前交来的点、说一句、点旁边写几点交来的，能关上；足迹的详情卡盖住下面时钮往上让", async () => {
    const { context, page, errors, outside } = await openMap({ width: 390, height: 844 }, { footprintsOn: true });
    try {
      // 开着足迹：点一个停留出详情卡，钮挪到卡片上面
      await page.locator('.map-mark[data-kind="stay"]').nth(2).click();
      const card = page.locator(".map-day-card");
      await card.waitFor({ timeout: 5000 });
      await page.waitForTimeout(200);
      const cardBox = (await card.boundingBox())!;
      const buttonBox = (await page.locator(".map-locate button").boundingBox())!;
      expect(buttonBox.y + buttonBox.height).toBeLessThanOrEqual(cardBox.y);
      await card.locator('button[aria-label="关上"]').click();
      await locate(page);
      const note = page.locator(".map-locate-note");
      expect(await note.innerText()).toBe("没拿到这台设备的位置（没给定位权限），这是 12 分钟前手机交来的位置");
      expect(await page.locator('.map-mark[data-kind="me"] .map-mark-label').innerText()).toMatch(/^手机 · \d\d:\d\d$/);
      expect(await page.locator("circle.map-circle-accuracy").count()).toBe(1);
      await note.locator('button[aria-label="关上"]').click();
      expect(await note.count()).toBe(0);
      expect(await page.locator('.map-mark[data-kind="me"]').count()).toBe(1);
    } finally {
      await context.close();
    }
    expect(outside).toEqual([]);
    expect(errors).toEqual([]);
  }, 60_000);

  test("回到我现在的位置：浏览器超时（英文）、什么都没有（手机插件停用）各说一句", async () => {
    const timeout = `navigator.geolocation.getCurrentPosition = (ok, fail) => setTimeout(() => fail({ code: 3, message: "timeout" }), 10);`;
    const en = await openMap({ width: 390, height: 844 }, { init: timeout, search: "?lang=en" });
    try {
      await locate(en.page, "Show my location");
      expect(await en.page.locator(".map-locate-note").innerText()).toBe("Couldn't get this device's location (timed out). This is where your phone was 12 minutes ago");
      expect(await en.page.locator('.map-mark[data-kind="me"] .map-mark-label').innerText()).toMatch(/^Phone · \d\d:\d\d$/);
    } finally {
      await en.context.close();
    }
    expect(en.outside).toEqual([]);
    expect(en.errors).toEqual([]);

    const none = await openMap({ width: 390, height: 844 }, { search: "?demo-plugins-off=phone", footprintsOff: true });
    try {
      await locate(none.page);
      expect(await none.page.locator(".map-locate-note").innerText()).toBe("拿不到你现在的位置：这台设备没给（没给定位权限），手机也还没交来过位置");
      expect(await none.page.locator('.map-mark[data-kind="me"]').count()).toBe(0);
    } finally {
      await none.context.close();
    }
    expect(none.outside).toEqual([]);
    expect(none.errors).toEqual([]);
  }, 60_000);

  test("回到我现在的位置：在鸿蒙 App 里（假的原生桥）用 App 的定位，不问浏览器；App 不报精度，只画蓝点", async () => {
    const app = [
      `window.__asked = 0;`,
      `navigator.geolocation.getCurrentPosition = (ok, fail) => { window.__asked += 1; fail({ code: 1 }); };`,
      `const no = () => Promise.resolve(JSON.stringify({ ok: false, state: "unavailable" }));`,
      `window.ergoNative = { appVersion: () => "9.9.9", log() {}, phoneContactsPick: no, phoneCalendarState: () => JSON.stringify({ granted: false, asked: false }), phoneCalendarPrepare: no, phoneCalendarRead: no,`,
      `  phonePlaceHere: () => Promise.resolve(JSON.stringify({ ok: true, lat: 30.2604, lon: 120.1433, address: { spot: "北山街" } })), phonePlaceFind: no };`,
    ].join("\n");
    const { context, page, errors, outside } = await openMap({ width: 390, height: 844 }, { init: app, footprintsOff: true });
    try {
      await locate(page);
      expect(await page.locator('.map-mark[data-kind="me"]').count()).toBe(1);
      expect(await page.locator("circle.map-circle-accuracy").count()).toBe(0);
      expect(await page.locator(".map-locate-note").count()).toBe(0);
      expect(await page.evaluate("window.__asked")).toBe(0);
      expect(await page.locator(".map-canvas").getAttribute("data-basemap")).toBe("amap");
    } finally {
      await context.close();
    }
    expect(outside).toEqual([]);
    expect(errors).toEqual([]);
  }, 60_000);

  // 地图页的二狗（444）：标题栏最右边的二狗按钮开合右边的聊天窗（秘书本人），关着时地图右下角是二狗悬浮按钮（"回到我现在的位置"在它上面），
  // 点一下打字、发出去带地图上下文（会话里写"在地图上用悬浮按钮打字"）；气泡里"展开到右边"；窄的时候聊天窗整屏盖住，宽的时候挤压地图、
  // 分隔条能拖、宽度和开合记在这台设备上；左边这一天的列表能收起、关掉（也记着），手机上的卡是能拖低、能关的抽屉；"足迹"默认关着；
  // 标题栏一行。一个请求都不往外发

  test("地图页的二狗手机宽：足迹默认关着（高德）、标题栏一行；右下角二狗按钮在定位钮下面，点了打字发出去带地图上下文；展开到右边整屏盖住，收起回到地图", async () => {
    const { context, page, errors, outside } = await openMap({ width: 390, height: 844 });
    try {
      await page.locator('.map-canvas[data-basemap="amap"]').waitFor({ timeout: 5000 });
      expect(await page.locator(".map-day-layer").getAttribute("aria-pressed")).toBe("false");
      expect(await page.locator(".map-day-bar").count()).toBe(0);
      expect(await page.locator('.map-bar-tools button[aria-label="在右边和二狗聊"]').count()).toBe(1);
      await titleBarOneLine(page, 390);
      // 二狗按钮在最右下（离右边 16），定位钮在它上面
      const fab = (await boxOf(page, ".map-fab"))!;
      const stage = (await boxOf(page, ".map-stage"))!;
      expect(Math.round(stage.x + stage.width - (fab.x + fab.width))).toBe(16);
      expect(fab.width).toBe(36);
      const locateBox = (await boxOf(page, ".map-locate"))!;
      expect(locateBox.y + locateBox.height).toBeLessThanOrEqual(fab.y);
      expect(Math.abs(locateBox.x + locateBox.width / 2 - (fab.x + fab.width / 2))).toBeLessThan(2);
      // 点一下：气泡里打字，发出去
      await page.locator(".map-fab").click();
      const bubble = page.locator(".map-talk");
      await bubble.locator("textarea").waitFor({ timeout: 5000 });
      expect(await bubble.locator(".map-talk-label").innerText()).toBe("对二狗说");
      const bubbleBox = (await bubble.boundingBox())!;
      expect(bubbleBox.y + bubbleBox.height).toBeLessThanOrEqual(fab.y);
      await bubble.locator("textarea").fill("这附近有什么好吃的");
      await bubble.locator(".map-talk-send").click();
      await page.locator('.map-talk[data-kind="busy"]').waitFor({ timeout: 5000 });
      expect(await page.locator(".map-talk-thinking").innerText()).toContain("在想");
      // 展开到右边：窄的时候整屏盖住地图页，二狗按钮不在了；刚才那句在会话里，下面写着在地图上用悬浮按钮打的
      await page.locator('.map-talk button[aria-label="展开到右边"]').click();
      const chat = page.locator(".map-chat-cover");
      await chat.waitFor({ timeout: 5000 });
      expect(await page.locator(".map-fab").isVisible()).toBe(false);
      expect(await page.locator(".map-talk").count()).toBe(0);
      expect(await chat.locator(".browse-side-watch").innerText()).toMatch(/现在在看\s*地图/);
      await expect.poll(() => chat.innerText(), { timeout: 5000 }).toMatch(/这附近有什么好吃的[\s\S]*在地图上用悬浮按钮打字/);
      const cover = (await chat.boundingBox())!;
      const pageBox = (await boxOf(page, ".map-page"))!;
      expect(cover).toEqual(pageBox);
      // 聊天窗里发的：带地图上下文，写"在地图上说"
      await chat.locator(".composer textarea").fill("把昨天画出来");
      await chat.locator(".composer textarea").press("Enter");
      await expect.poll(() => chat.innerText(), { timeout: 5000 }).toMatch(/把昨天画出来[\s\S]*在地图上说/);
      // 记着开着：刷新还开着；收起回到地图，二狗按钮回来
      expect(await page.evaluate(`localStorage.getItem("ergo-map-chat")`)).toBe("open");
      await page.reload();
      await page.evaluate(`window.location.hash = "#/more/map"`);
      await page.locator(".map-chat-cover").waitFor({ timeout: 5000 });
      await page.locator('.map-chat-cover button[aria-label="收起右边的聊天窗"]').click();
      await page.locator(".map-fab:not([hidden])").waitFor({ timeout: 5000 });
      expect(await page.locator(".map-chat").count()).toBe(0);
      expect(await page.evaluate(`localStorage.getItem("ergo-map-chat")`)).toBeNull();
    } finally {
      await context.close();
    }
    expect(outside).toEqual([]);
    expect(errors).toEqual([]);
  }, 60_000);

  test("地图页的二狗电脑宽：聊天窗挤压地图、分隔条拖宽、宽度和开合记在这台设备上；左边这一天的列表收成小按钮、关掉、从标题栏打开；深色", async () => {
    const { context, page, errors, outside } = await openMap({ width: 1280, height: 800 }, { footprintsOn: true });
    try {
      await page.locator(".map-day-panel").waitFor({ timeout: 5000 });
      await titleBarOneLine(page, 1280);
      // 打开聊天窗：地图 | 分隔条 | 聊天窗，不重叠，聊天窗 400 宽；二狗按钮不在
      await page.locator('.map-bar-tools button[aria-label="在右边和二狗聊"]').click();
      await page.locator(".map-chat").waitFor({ timeout: 5000 });
      expect(await page.locator(".map-chat-cover").count()).toBe(0);
      expect(await page.locator(".map-bar-tools .map-chat-toggle").getAttribute("aria-pressed")).toBe("true");
      const chat = (await boxOf(page, ".map-chat"))!;
      const stage = (await boxOf(page, ".map-stage"))!;
      expect(chat.width).toBe(400);
      expect(stage.x + stage.width).toBeLessThanOrEqual(chat.x);
      expect(await page.locator(".map-fab").isVisible()).toBe(false);
      expect(await page.locator(".map-chat .browse-side-watch").innerText()).toMatch(/现在在看\s*地图 · \d\d\/\d\d 的足迹/);
      // 拖分隔条往左 100：聊天窗 500 宽，地图跟着变窄；刷新后还是 500、还开着
      const split = (await boxOf(page, ".map-body > .splitter"))!;
      await page.mouse.move(split.x + split.width / 2, split.y + split.height / 2);
      await page.mouse.down();
      await page.mouse.move(split.x + split.width / 2 - 100, split.y + split.height / 2, { steps: 5 });
      await page.mouse.up();
      await expect.poll(async () => (await boxOf(page, ".map-chat"))!.width, { timeout: 5000 }).toBe(500);
      expect((await boxOf(page, ".map-stage"))!.width).toBeLessThan(stage.width - 90);
      expect(await page.evaluate(`localStorage.getItem("ergo-map-chat-width")`)).toBe("500");
      await page.reload();
      await page.evaluate(`window.location.hash = "#/more/map"`);
      await page.locator(".map-chat").waitFor({ timeout: 5000 });
      expect((await boxOf(page, ".map-chat"))!.width).toBe(500);
      // 收起聊天窗：二狗按钮回来
      await page.locator('.map-bar-tools button[aria-label="收起右边的聊天窗"]').click();
      await page.locator(".map-fab:not([hidden])").waitFor({ timeout: 5000 });
      // 左边那一栏：收起成左上角的小按钮（记着），点它打开；关掉，点标题栏上的概况再打开
      await page.locator('.map-day-panel button[aria-label="收起这一栏"]').click();
      await page.locator(".map-day-panel-tab").waitFor({ timeout: 5000 });
      expect(await page.locator(".map-day-panel").count()).toBe(0);
      expect(await page.locator(".map-day-panel-tab").innerText()).toMatch(/这一天\s*\d+/);
      await page.reload();
      await page.evaluate(`window.location.hash = "#/more/map"`);
      await page.locator(".map-day-panel-tab").waitFor({ timeout: 5000 });
      await page.locator(".map-day-panel-tab").click();
      await page.locator(".map-day-panel").waitFor({ timeout: 5000 });
      await page.locator('.map-day-panel button[aria-label="关掉这一栏"]').click();
      expect(await page.locator(".map-day-panel, .map-day-panel-tab").count()).toBe(0);
      expect(await page.evaluate(`localStorage.getItem("ergo-map-panel")`)).toBe("closed");
      await page.locator("button.map-day-summary").click();
      await page.locator(".map-day-panel").waitFor({ timeout: 5000 });
      expect(await page.evaluate(`localStorage.getItem("ergo-map-panel")`)).toBeNull();
      // 深色：聊天窗、二狗按钮照样在
      await page.evaluate(`localStorage.setItem("ergo-theme", "dark")`);
      await page.reload();
      await page.evaluate(`window.location.hash = "#/more/map"`);
      await page.locator(".map-fab:not([hidden])").waitFor({ timeout: 5000 });
      await page.locator('.map-bar-tools button[aria-label="在右边和二狗聊"]').click();
      await page.locator(".map-chat .composer").waitFor({ timeout: 5000 });
    } finally {
      await context.close();
    }
    expect(outside).toEqual([]);
    expect(errors).toEqual([]);
  }, 60_000);

  // 地图的二狗按钮按住说话只依赖语音插件（444 追加）：假麦克风 FAKE_MIC、按住的帮手 holdFab 在文件上面
  test("地图的二狗按钮：浏览插件停用、语音插件开着时按住说话照样认出来、发进对话（标着是说的）；语音插件停用时只能打字", async () => {
    const on = await openMap({ width: 390, height: 844 }, { search: "?demo-plugins-off=browsing", init: FAKE_MIC });
    try {
      const { page } = on;
      // 按住：先是在听（波形、秒数），松开送识别，认出来的字发出去，气泡里"在想"
      const fab = (await boxOf(page, ".map-fab"))!;
      await page.mouse.move(fab.x + fab.width / 2, fab.y + fab.height / 2);
      await page.mouse.down();
      await page.locator('.map-talk[data-kind="listening"]').waitFor({ timeout: 5000 });
      expect(await page.locator(".map-talk-hint").innerText()).toBe("松开发送，上滑取消");
      await page.waitForTimeout(900);
      await page.mouse.up();
      await expect.poll(() => page.locator(".map-talk-said").first().innerText().catch(() => ""), { timeout: 10_000 }).toBe("西湖边有什么好吃的");
      expect(await page.locator(".map-talk-text[data-failed]").count()).toBe(0);
      await page.locator('.map-talk button[aria-label="展开到右边"]').click();
      const chat = page.locator(".map-chat-cover");
      await chat.waitFor({ timeout: 5000 });
      await expect.poll(() => chat.innerText(), { timeout: 5000 }).toMatch(/西湖边有什么好吃的[\s\S]*在地图上用悬浮按钮说/);
    } finally {
      await on.context.close();
    }
    expect(on.outside).toEqual([]);
    expect(on.errors).toEqual([]);

    const off = await openMap({ width: 390, height: 844 }, { search: "?demo-plugins-off=voice", init: FAKE_MIC });
    try {
      const { page } = off;
      // 按钮的读屏说明不说"按住说话"；长按写一句没启用，不录
      expect(await page.locator(".map-fab").evaluate((host) => host.shadowRoot?.querySelector(".fab")?.getAttribute("aria-label"))).toBe("让二狗帮忙：点一下打字");
      await holdFab(page, 900);
      await page.locator('.map-talk[data-kind="reply"] .map-talk-text[data-failed]').waitFor({ timeout: 5000 });
      expect(await page.locator(".map-talk-text").innerText()).toBe("语音插件没启用：点一下按钮打字");
      expect(await page.locator('.map-talk[data-kind="listening"]').count()).toBe(0);
      // 点一下：照样打字
      await page.locator(".map-fab").click();
      await page.locator(".map-talk textarea").waitFor({ timeout: 5000 });
    } finally {
      await off.context.close();
    }
    expect(off.outside).toEqual([]);
    expect(off.errors).toEqual([]);
  }, 60_000);

  // 二狗在地图上画的直接出现在地图上，不用再点卡片（461）：演示页里在地图页上说带"标"字的话（英文带 mark），原型回一张标了几个点的
  // 地图卡片（附近的咖啡馆、地铁站、公司轮着来，"只看""换成"的替掉之前画的）。打开前的旧卡不画；叠加、标题栏"共 N 样"、"×"一次清掉；
  // 手机窄屏聊天窗整屏盖着时二狗画了就收起、气泡里接着显示这一轮；宽屏聊天窗不收；点卡片"看大地图"照旧只看它。一个请求都不往外发
  const drawnMarks = ".map-page-overlay .map-mark[data-id^='card-']";

  test("461 手机宽：悬浮按钮说一句，二狗画的直接在地图上、气泡里是它的话、顶上不另弹；再说一句叠上去（标题栏共 2 样）；×一次清掉；打开前的旧卡不画", async () => {
    const { context, page, errors, outside } = await openMap({ width: 390, height: 844 });
    try {
      await page.locator('.map-canvas[data-basemap="amap"]').waitFor({ timeout: 5000 });
      // 演示里聊天中已有的几张地图卡片（打开前的）不自动画
      await page.waitForTimeout(500);
      expect(await page.locator(".map-card-bar").count()).toBe(0);
      expect(await page.locator(drawnMarks).count()).toBe(0);
      // 悬浮按钮上说一句：卡片不用点，点直接画在地图上；气泡里是二狗这一轮说的
      await page.locator(".map-fab").click();
      await page.locator(".map-talk textarea").fill("把附近的咖啡馆标出来");
      await page.locator(".map-talk-send").click();
      await page.locator('.map-talk[data-kind="reply"]').waitFor({ timeout: 8000 });
      expect(await page.locator(".map-talk-text").innerText()).toBe("（原型）标好了：附近 3 家咖啡馆，都在地图上了。");
      await expect.poll(() => page.locator(drawnMarks).count(), { timeout: 5000 }).toBe(3);
      expect(await page.locator(".map-card-bar b").innerText()).toBe("附近的咖啡馆");
      expect(await page.locator(".map-card-bar").getAttribute("data-count")).toBe("1");
      expect(await page.locator(".map-card-bar-note").textContent()).toBe("湖边咖啡、转角咖啡、书店咖啡");
      expect(await page.locator(".map-card-bar-count").count()).toBe(0);
      expect(await page.evaluate("location.hash")).toBe("#/more/map");
      // 回话就在气泡里：顶上不另弹"二狗：……"盖住标题栏
      expect(await page.locator(".alert-stack .alert-banner").count()).toBe(0);
      await titleBarOneLine(page, 390);
      // 新画的都在地图那一块里（视野挪过去看全了）
      const stage = (await boxOf(page, ".map-stage"))!;
      const allInStage = async () => {
        for (const box of await page.locator(drawnMarks).evaluateAll((els) => els.map((e) => e.getBoundingClientRect().toJSON() as { x: number; y: number }))) {
          expect(box.x).toBeGreaterThanOrEqual(stage.x);
          expect(box.x).toBeLessThanOrEqual(stage.x + stage.width);
          expect(box.y).toBeGreaterThanOrEqual(stage.y);
          expect(box.y).toBeLessThanOrEqual(stage.y + stage.height);
        }
      };
      await allInStage();
      // 标题栏里的概况：要么至少放得下几个字，要么整个折到第二行藏起来，不留半个字
      const noteFit = `(() => { const e = document.querySelector(".map-card-bar-note"); const r = e.getBoundingClientRect();
        return getComputedStyle(e).display === "none" ? "hidden" : r.width >= parseFloat(getComputedStyle(e).fontSize) * 4 - 1 ? "shown" : "sliver"; })()`;
      expect(await page.evaluate(noteFit)).not.toBe("sliver");
      // 再说一句：叠上去，前面的不冲掉；标题栏写最新那张和"共 2 样"
      await page.locator(".map-talk-close").click();
      await page.locator(".map-fab").click();
      await page.locator(".map-talk textarea").fill("再把地铁站标上");
      await page.locator(".map-talk-send").click();
      await page.locator('.map-talk[data-kind="reply"]').waitFor({ timeout: 8000 });
      await expect.poll(() => page.locator(drawnMarks).count(), { timeout: 5000 }).toBe(5);
      expect(await page.locator(".map-card-bar b").innerText()).toBe("附近的地铁站");
      expect(await page.locator(".map-card-bar-count").innerText()).toBe("共 2 样");
      expect(await page.locator(".map-card-bar-note").textContent()).toBe("地铁站 · 东口、地铁站 · 西口");
      // 手机上标题栏窄："共 2 样"整个露着（不被省略号吃掉）；后面的概况放不下几个字就整个不显示，不留半个字
      const count = (await boxOf(page, ".map-card-bar-count"))!;
      const barText = (await boxOf(page, ".map-card-bar-text"))!;
      expect(count.x + count.width).toBeLessThanOrEqual(barText.x + barText.width + 1);
      expect(count.y + count.height).toBeLessThanOrEqual(barText.y + barText.height + 1);
      expect(await page.locator(".map-card-bar-count").evaluate((e) => e.scrollWidth <= e.clientWidth + 1)).toBe(true);
      expect(await page.evaluate(noteFit)).not.toBe("sliver");
      // 视野看全叠着的两组（咖啡馆、地铁站都在地图那一块里）
      await allInStage();
      expect(await page.locator(".map-card-bar").getAttribute("data-count")).toBe("2");
      await titleBarOneLine(page, 390);
      // "×"：一次清掉，回到地图
      await page.locator('.map-card-bar button[aria-label="清掉这 2 样"]').click();
      await page.locator(".map-day-layer").waitFor({ timeout: 5000 });
      expect(await page.locator(".map-card-bar").count()).toBe(0);
      expect(await page.locator(drawnMarks).count()).toBe(0);
    } finally {
      await context.close();
    }
    expect(outside).toEqual([]);
    expect(errors).toEqual([]);
  }, 60_000);

  test("461 手机宽：聊天窗整屏盖着时在聊天窗里说，二狗画了就收起聊天窗、露出地图，气泡里接着显示这一轮；英文", async () => {
    const { context, page, errors, outside } = await openMap({ width: 390, height: 844 }, { search: "?lang=en" });
    try {
      await page.locator(".map-bar-tools .map-chat-toggle").click();
      const chat = page.locator(".map-chat-cover");
      await chat.locator(".composer textarea").waitFor({ timeout: 5000 });
      await chat.locator(".composer textarea").fill("Mark the cafés nearby");
      await chat.locator(".composer textarea").press("Enter");
      // 二狗画了：聊天窗收起（记成收着），点在地图上，悬浮按钮的气泡里是你说的那句和二狗这一轮最后说的那句
      await chat.waitFor({ state: "detached", timeout: 8000 });
      await page.locator(".map-fab:not([hidden])").waitFor({ timeout: 5000 });
      expect(await page.evaluate(`localStorage.getItem("ergo-map-chat")`)).toBeNull();
      await expect.poll(() => page.locator(drawnMarks).count(), { timeout: 5000 }).toBe(3);
      expect(await page.locator(".map-talk-said").innerText()).toBe("Mark the cafés nearby");
      await page.locator('.map-talk[data-kind="reply"]').waitFor({ timeout: 8000 });
      expect(await page.locator(".map-talk-text").innerText()).toBe("(Demo) Done: 3 cafés nearby, all on the map now.");
      expect(await page.locator(".map-card-bar b").innerText()).toBe("Cafés nearby");
      expect(await page.locator(drawnMarks).evaluateAll((els) => els.map((e) => e.querySelector(".map-mark-label")?.textContent))).toEqual(["Lakeside Café", "Corner Café", "Bookshop Café"]);
      expect(await page.locator(".alert-stack .alert-banner").count()).toBe(0);
      // 再说一句叠上去：英文的"共 N 样"、"×"
      await page.locator(".map-talk-close").click();
      await page.locator(".map-fab").click();
      await page.locator(".map-talk textarea").fill("Now mark the metro");
      await page.locator(".map-talk-send").click();
      await expect.poll(() => page.locator(drawnMarks).count(), { timeout: 8000 }).toBe(5);
      expect(await page.locator(".map-card-bar-count").innerText()).toBe("2 on the map");
      expect(await page.locator(".map-card-bar button").getAttribute("aria-label")).toBe("Clear all 2");
    } finally {
      await context.close();
    }
    expect(outside).toEqual([]);
    expect(errors).toEqual([]);
  }, 60_000);

  test("461 电脑宽：聊天窗开着说，聊天里一张卡、左边地图上已经画好（聊天窗不收）；换成的替掉之前画的；点卡片看大地图照旧只看它", async () => {
    const { context, page, errors, outside } = await openMap({ width: 1280, height: 800 });
    try {
      await page.locator(".map-bar-tools .map-chat-toggle").click();
      const chat = page.locator(".map-chat");
      const say = async (text: string) => {
        await chat.locator(".composer textarea").fill(text);
        await chat.locator(".composer textarea").press("Enter");
      };
      await chat.locator(".composer textarea").waitFor({ timeout: 5000 });
      await say("把附近的咖啡馆标出来");
      await expect.poll(() => page.locator(drawnMarks).count(), { timeout: 8000 }).toBe(3);
      // 聊天里照常留着那张卡；宽屏聊天窗在旁边，不收
      const card = chat.locator(".xcard-map").filter({ hasText: "附近的咖啡馆" });
      await card.waitFor({ timeout: 5000 });
      expect(await card.locator(".xcard-title").innerText()).toBe("附近的咖啡馆");
      await expect.poll(() => chat.innerText(), { timeout: 8000 }).toContain("（原型）标好了：附近 3 家咖啡馆，都在地图上了。");
      expect(await page.locator(".map-chat").count()).toBe(1);
      expect(await page.locator(".map-fab").isVisible()).toBe(false);
      expect(await chat.locator(".browse-side-watch").innerText()).toMatch(/现在在看\s*地图 · 附近的咖啡馆/);
      // 叠一张，再"只看"：替掉之前画的
      await say("再把地铁站标上");
      await expect.poll(() => page.locator(drawnMarks).count(), { timeout: 8000 }).toBe(5);
      await expect.poll(() => chat.innerText(), { timeout: 8000 }).toContain("两个地铁站也标上了");
      await say("只看公司，标一下");
      await expect.poll(() => page.locator(".map-card-bar b").innerText(), { timeout: 8000 }).toBe("公司");
      expect(await page.locator(drawnMarks).count()).toBe(1);
      expect(await page.locator(".map-card-bar").getAttribute("data-count")).toBe("1");
      // 点聊天里第一张卡的"看大地图"：照旧只看它（地址是这张卡）
      await card.scrollIntoViewIfNeeded();
      await card.locator(".map-card-open").click();
      await expect.poll(() => page.evaluate("location.hash"), { timeout: 5000 }).toMatch(/^#\/more\/map\/card\/c-proto-map-/);
      await expect.poll(() => page.locator(".map-card-bar b").innerText(), { timeout: 5000 }).toBe("附近的咖啡馆");
      expect(await page.locator(drawnMarks).count()).toBe(3);
      await page.locator('.map-card-bar button[aria-label="不看这张了"]').click();
      await expect.poll(() => page.evaluate("location.hash"), { timeout: 5000 }).toBe("#/more/map");
      expect(await page.locator(".map-card-bar").count()).toBe(0);
    } finally {
      await context.close();
    }
    expect(outside).toEqual([]);
    expect(errors).toEqual([]);
  }, 60_000);

  test("地图页手机宽的抽屉：点停留出详情卡，点把手拖低（只露标题那一行，记着，二狗按钮跟着往下），往下拖关掉；英文", async () => {
    const { context, page, errors, outside } = await openMap({ width: 390, height: 844 }, { footprintsOn: true, search: "?lang=en" });
    try {
      await page.locator('.map-mark[data-kind="stay"]').nth(2).click();
      const card = page.locator(".map-day-card");
      await card.waitFor({ timeout: 5000 });
      await page.waitForTimeout(200);
      const tall = (await card.boundingBox())!;
      const fabHigh = (await boxOf(page, ".map-fab"))!;
      expect(fabHigh.y + fabHigh.height).toBeLessThanOrEqual(tall.y);
      expect(await page.locator(".map-drawer-grip").getAttribute("aria-label")).toBe("Lower this card (drag down; drag again to close)");
      await page.locator(".map-drawer-grip").click();
      await page.locator('.map-day-card[data-drawer="low"]').waitFor({ timeout: 5000 });
      await page.waitForTimeout(200);
      const low = (await card.boundingBox())!;
      expect(low.height).toBeLessThan(tall.height - 40);
      expect(await page.evaluate(`localStorage.getItem("ergo-map-drawer")`)).toBe("low");
      const fabLow = (await boxOf(page, ".map-fab"))!;
      expect(fabLow.y).toBeGreaterThan(fabHigh.y + 40);
      expect(fabLow.y + fabLow.height).toBeLessThanOrEqual(low.y);
      // 拖低了再往下拖：关掉
      const grip = (await boxOf(page, ".map-drawer-grip"))!;
      await page.mouse.move(grip.x + grip.width / 2, grip.y + grip.height / 2);
      await page.mouse.down();
      await page.mouse.move(grip.x + grip.width / 2, grip.y + grip.height / 2 + 80, { steps: 5 });
      await page.mouse.up();
      await expect.poll(() => page.locator(".map-day-card").count(), { timeout: 5000 }).toBe(0);
      expect(await page.locator('.map-bar-tools button[aria-label="Chat with ergo on the right"]').count()).toBe(1);
    } finally {
      await context.close();
    }
    expect(outside).toEqual([]);
    expect(errors).toEqual([]);
  }, 60_000);

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
  ])("%s宽：标题上的等你回答提问看得到、能点，点了定位到那张提问卡（整张画着）；相册库的等你批准跳到任务里那张卡；在对话里直接答，答完不再等你、收成一行写已回答", async (_what, viewport) => {
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
      // 提问卡等你回答：在对话里整张画、按钮在卡上（462），定位到它、卡头就在眼前
      const asking = page.locator('.conv .xcard-questions:has-text("去几天")').first();
      const composerTop = (await page.locator(".composer").first().boundingBox())!.y;
      await expect.poll(async () => {
        const cardBox = (await asking.boundingBox())!;
        return cardBox.y >= 0 && cardBox.y < composerTop;
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

      // 在对话里那张卡上直接答；答完：标题不再说等你，不再是链接，那张卡收成一行写已回答
      await go("#/secretary");
      await jump.waitFor();
      await asking.locator('button:has-text("全按推荐")').click();
      await jump.waitFor({ state: "detached", timeout: 5000 });
      expect(await page.locator(".topbar .act").first().getAttribute("class")).toContain("act-sleeping");
      const row = page.locator('.chat-line[data-card-type="questions"]:has-text("去几天")').first();
      await expect.poll(async () => row.locator(".tool-sum-tag").textContent(), { timeout: 5000 }).toContain("已回答");
      expect(await row.getAttribute("class")).not.toContain("tool-sum-you");
      expect(await page.locator('.conv .xcard-questions:has-text("去几天")').count()).toBe(0);
      expect(errors).toEqual([]);
    } finally {
      await page.close();
    }
  }, 60_000);

  // 462：立项书让你确认时整张展开、排在这一轮最后（负责人交了立项书又想了想、回了一段话，立项书在那段话下面），
  // 打开会话停在最下面，"确认并开工"不用点详情就看得到、点得到
  test.each([
    ["手机", { width: 390, height: 844 }],
    ["电脑", { width: 1280, height: 800 }],
  ])("%s宽：等你确认的立项书在聊天最下面整张展开，在负责人最后那段回复下面，滚到底看得到“确认并开工”", async (_what, viewport) => {
    const { page, errors } = await open(viewport);
    try {
      await page.evaluate(`window.location.hash = "#/projects/p-appliance"`);
      const charter = page.locator(".conv .xcard-charter");
      await charter.waitFor();
      const start = charter.locator('button:has-text("确认并开工")');
      // 最后一条就是它，上面是负责人那段思考和回复
      const lastTwo = await page.locator(".conv .zi").evaluateAll((els) => els.slice(-2).map((el) => ({ card: el.querySelector(".xcard-charter") !== null, reply: el.querySelector(".part-text") !== null })));
      expect(lastTwo).toEqual([
        { card: false, reply: true },
        { card: true, reply: false },
      ]);
      const reply = page.locator(".conv .zi .part-text").last();
      expect(await reply.innerText()).toContain("立项书交上来了");
      expect(await page.locator('.conv .chat-line[data-card-type="charter"]').count()).toBe(0);
      // 滚到底（打开就在底部）：按钮整个在可视区里、输入框上面，在那段回复下面
      const composerTop = (await page.locator(".composer").first().boundingBox())!.y;
      await expect.poll(async () => {
        const b = await start.boundingBox();
        return b !== null && b.y >= 0 && b.y + b.height <= composerTop;
      }, { timeout: 5000 }).toBe(true);
      expect((await start.boundingBox())!.y).toBeGreaterThan((await reply.boundingBox())!.y);
      expect(await charter.locator('button:has-text("只确认，稍后开工")').isVisible()).toBe(true);
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
        expect(await upgrade.getAttribute("data-system-browser")).toBeNull();
        expect(await page.locator(".auth-actions button", { hasText: "知道了" }).count()).toBe(1);
        expect(errors).toEqual([]);
      } finally {
        await page.close();
      }
    }, 60_000);

    test("新版安卓 App（原生桥上有 openSystemBrowser）：待办里的'去升级'交给手机的系统浏览器，页面不跳走（票 386）", async () => {
      const context = await browser!.newContext({ viewport: PHONE, userAgent: ANDROID_UA });
      await context.addInitScript(
        `window.__opened = []; window.ergoNative = { appVersion: () => "99.0.0", log() {}, openSystemBrowser(url) { window.__opened.push(url); return Promise.resolve("ok"); } };`,
      );
      const page = await context.newPage();
      const errors: string[] = [];
      page.on("pageerror", (e) => errors.push(String(e)));
      const popups: string[] = [];
      context.on("page", (p) => popups.push(p.url()));
      try {
        await page.goto(pageUrl);
        await page.locator("nav").first().waitFor();
        await page.evaluate("location.hash = '#/inbox/i-app-outdated'");
        const upgrade = page.locator(".auth-actions a", { hasText: "去升级" });
        await upgrade.waitFor();
        expect(await upgrade.getAttribute("data-system-browser")).not.toBeNull();
        const before = page.url();
        await upgrade.click();
        await expect.poll(() => page.evaluate("window.__opened"), { timeout: 5000 }).toEqual(["https://github.com/catmaniii/ergo/releases/latest/download/ergo-android-debug.apk"]);
        expect(page.url()).toBe(before);
        expect(popups).toEqual([]);
        expect(errors).toEqual([]);
      } finally {
        await context.close();
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

  // 面板原来和主线一样宽，从主线右边接着画，要点层哪个宽度都伸出视口右边（900 宽超出 145px，字被裁）。
  // 手机上缩小后条往左挪、要点层收窄（zoom.ts 的 shiftAt、NARROW_GIST_SCALE），旁边也放得下了，不再盖住主线
  for (const [name, viewport, besideMain] of [
    ["小屏 900×562（收窄，放在主线旁边）", { width: 900, height: 562 }, true],
    ["795×562（收窄，放在主线旁边）", { width: 795, height: 562 }, true],
    ["手机 360×780（条往左挪了，放在主线旁边）", { width: 360, height: 780 }, true],
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
      for (const { hash, selector, except, wideOnly, open: row } of EN_DONE) {
        if (wideOnly && viewport.width < 900) continue;
        await page.evaluate(`window.location.hash = ${JSON.stringify(hash)}`);
        await page.waitForTimeout(200);
        // 手机上前一项开着的详情页盖在对话上面：直接给那一行的按钮发 click（不按坐标点），等详情里的东西出来
        if (row) {
          await page.locator(row).last().dispatchEvent("click");
          await page.waitForSelector(selector, { state: "attached", timeout: 5000 }).catch(() => undefined);
        }
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
    for (const hash of ["#/secretary", "#/browse", "#/more/settings", "#/more/browsing", "#/more/folder-grants", "#/more/plugins"]) {
      await page.evaluate(`window.location.hash = ${JSON.stringify(hash)}`);
      await page.waitForTimeout(200);
      texts.set(hash, await bodyText(page));
      if (texts.get(hash) === "") empty.push(hash);
    }
    await page.close();
    expect(texts.get("#/browse")).toContain("内置浏览器插件没启用，这一页暂时看不到");
    // 授权的文件夹在目录授权那一页（内核的页面），浏览插件停用时照样在；设置列表里也有它
    expect(texts.get("#/more/folder-grants")).toContain("添加文件夹");
    expect(texts.get("#/more/folder-grants")).not.toContain("没启用");
    expect(texts.get("#/more/settings")).toContain("目录授权");
    const side = await open({ width: 390, height: 844 }, "?ergo=side&demo-plugins-off=browsing");
    await side.page.waitForTimeout(300);
    const sideText = await bodyText(side.page);
    await side.page.close();
    expect([...errors, ...side.errors]).toEqual([]);
    expect(empty).toEqual([]);
    expect(sideText).toContain("内置浏览器插件没启用，这一页暂时看不到");
  }, 60_000);

  // 对话里收成一行的那几种（思考、工具调用、调用记忆、来信、卡片、记录、说明、回退）：每行一样宽、都和对话气泡最宽处一样宽
  // （糖果、纸张的头像位也让出来，左边对齐），行尾的 › 在最右端、几行的 › 在同一条竖线上，整个露在行里、点得到，窄窗口下右边不超出，
  // 里面的字放不下省略（不挤出去）。每套风格量：秘书页、负责人会话页（窄 340）、秘书页（电脑宽）、侧边栏模式（320）
  for (const style of VISUAL_STYLES.map((s) => s.id)) {
    test(`${style}：对话里收成一行的几种一样宽（对话气泡最宽处）、左边对齐，行尾 › 在同一条竖线上、露全、点得到，右边不超出`, async () => {
      const { page, errors } = await open({ width: 340, height: 800 });
      await page.evaluate(`localStorage.setItem("ergo-style", ${JSON.stringify(style)})`);
      const problems: string[] = [];
      const check = async (where: string, kinds: string[]) => {
        await page.waitForSelector(".msg .tool-sum", { timeout: 10_000 });
        await page.waitForTimeout(200);
        const found = (await page.evaluate(MEASURE_ROWS)) as RowMeasure;
        for (const kind of kinds) if (!found.rows.some((r) => r.kind === kind)) problems.push(`${where}：没找到 ${kind} 那一行`);
        problems.push(...rowProblems(where, found));
      };
      await page.reload();
      await page.evaluate(`window.location.hash = "#/secretary"`);
      await check("秘书页 340", ["thinking", "tool", "letter", "recall", "card", "note", "branch"]);
      await page.evaluate(`window.location.hash = "#/projects/p-ledger/chat"`);
      await check("负责人会话页 340", ["thinking", "tool", "letter", "recall", "card", "record", "note", "branch"]);
      await page.setViewportSize({ width: 1280, height: 800 });
      await page.evaluate(`window.location.hash = "#/secretary"`);
      await check("秘书页 1280", ["thinking", "tool", "letter", "recall", "card", "note", "branch"]);
      await page.setViewportSize({ width: 320, height: 800 });
      await page.goto(`${pageUrl}?ergo=side`);
      await check("侧边栏模式 320", ["tool", "letter", "card"]);
      await page.close();
      expect(errors).toEqual([]);
      expect(problems).toEqual([]);
    }, 60_000);
  }

  // 浏览页把浏览侧边栏开合交给页面桥：假的原生桥（有内置浏览器、页面桥那一组、侧边栏），记下交给页面桥的那几句（texts）。
  // 页面桥装上（报一次没选中）后交的 fab.corner 是"侧边栏关着"（悬浮按钮常驻右下角）；点顶栏的二狗按钮展开侧边栏重交、变成不常驻，再点收起变回来
  test("浏览页：浏览侧边栏开合交给页面桥（关着悬浮按钮常驻右下角，开着不常驻）", async () => {
    const context = await browser!.newContext({ viewport: { width: 390, height: 844 } });
    await context.addInitScript(`
      window.__texts = [];
      window.ergoNative = {
        appVersion: () => "9.9.9",
        log() {},
        browserAttach: () => JSON.stringify({ url: "", title: "", progress: 0, loading: false, canGoBack: false, canGoForward: false }),
        browserLayout() {},
        browserLoad() {},
        browserNav() {},
        browserPage(op, args) {
          if (op === "texts") window.__texts.push(JSON.parse(args)[0]);
          return Promise.resolve(op === "bubble" || op === "texts" ? '{"ok":true}' : "");
        },
        browserFileChunk: () => Promise.resolve('{"ok":true}'),
        browserFiles: () => Promise.resolve('{"ok":true}'),
        browserChooser: () => Promise.resolve('{"ok":true}'),
        browserSide() {},
      };`);
    const page = await context.newPage();
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(String(e)));
    try {
      await page.goto(`${pageUrl}#/browse`);
      const toggle = page.locator(".browse-side-toggle");
      await toggle.waitFor();
      // 页面桥装上：报一次没选中（App 原样转过来）
      const bridgeSays = (event: object) => page.evaluate(`window.__ergoBrowser(${JSON.stringify(JSON.stringify({ type: "page", json: JSON.stringify({ nonce: "n", ...event }) }))})`);
      await bridgeSays({ type: "selected", field: null, page: { title: "示例", url: "https://example.cn/a" } });
      const lastFab = async () => (await page.evaluate(`(() => { const t = window.__texts.at(-1); return t ? JSON.parse(t).fab : null; })()`)) as unknown;
      expect(await lastFab()).toEqual({ corner: true, inset: 0 });
      await toggle.click();
      expect(await toggle.getAttribute("aria-pressed")).toBe("true");
      expect(await lastFab()).toEqual({ corner: false, inset: 0 });
      await toggle.click();
      expect(await lastFab()).toEqual({ corner: true, inset: 0 });
      expect(errors).toEqual([]);
    } finally {
      await context.close();
    }
  }, 60_000);


  // 浏览侧边栏（App 另开的 Web 组件，?ergo=side）里的地图卡片点开（447）：侧边栏这一页不认地址里的 #，记下要去的地址、调 App 的"收起"，
  // App 把收起转给"浏览"页那一份（这里扮 App：侧边栏的 ergoSide.close 转成主页面的 __ergoBrowser side close），主页面跳到地图页画这张卡。
  // 主页面的存储事件拦掉（真 App 里两个 Web 组件之间不一定有），只靠收起这条路也要跳得过去；侧边栏这一页自己的地址不变
  test("浏览侧边栏里点地图卡片：侧边栏记下地址再收起，浏览页那一份跳到地图页画这张卡", async () => {
    const context = await browser!.newContext({ viewport: { width: 390, height: 844 } });
    let main: Page | undefined;
    const closes: string[] = [];
    await context.exposeBinding("__appSideClose", async () => {
      closes.push("close");
      await main?.evaluate(`window.__ergoBrowser(JSON.stringify({ type: "side", action: "close" }))`);
    });
    await context.addInitScript(`
      if (new URLSearchParams(location.search).get("ergo") === "side") {
        window.ergoSide = { close() { window.__appSideClose(); }, clearSelection() {}, ready() {} };
      } else {
        window.addEventListener("storage", (e) => e.stopImmediatePropagation(), true);
        window.ergoNative = {
          appVersion: () => "9.9.9",
          log() {},
          browserAttach: () => JSON.stringify({ url: "", title: "", progress: 0, loading: false, canGoBack: false, canGoForward: false }),
          browserLayout() {},
          browserLoad() {},
          browserNav() {},
          browserPage: (op) => Promise.resolve(op === "bubble" || op === "texts" ? '{"ok":true}' : ""),
          browserFileChunk: () => Promise.resolve('{"ok":true}'),
          browserFiles: () => Promise.resolve('{"ok":true}'),
          browserChooser: () => Promise.resolve('{"ok":true}'),
          browserSide() {},
        };
      }`);
    const errors: string[] = [];
    try {
      main = await context.newPage();
      main.on("pageerror", (e) => errors.push(`主页面：${String(e)}`));
      await main.goto(`${pageUrl}#/browse`);
      await main.locator(".browse-side-toggle").waitFor();
      const side = await context.newPage();
      side.on("pageerror", (e) => errors.push(`侧边栏：${String(e)}`));
      await side.goto(`${pageUrl}?ergo=side`);
      // 高德查的路线卡：451 起有高德的预览图，点右上"看大地图"（446 起演示里还有一张谷歌查的卡"附近的 hawker centre"：按标题挑路线这一张）
      const route = side.locator('.xcard-map[data-show="lookup"][data-state="ready"]').filter({ hasText: "从公司到西湖边" });
      await route.waitFor({ timeout: 10_000 });
      await route.scrollIntoViewIfNeeded();
      await route.locator('.map-card-thumb[data-preview="ready"] .map-card-open').click();
      await main.locator('.map-canvas[data-own-source="amap"][data-own-results="shown"]').waitFor({ timeout: 5000 });
      expect(await main.evaluate("location.hash")).toBe("#/more/map/card/c-map-route");
      expect(await main.locator(".map-card-bar").innerText()).toMatch(/从公司到西湖边/);
      expect(closes).toEqual(["close"]);
      expect(await side.evaluate("location.hash")).toBe("");
      expect(await main.evaluate(`localStorage.getItem("ergo-side-goto")`)).toBeNull();
      // 足迹卡的缩略图右上"看大地图"：看那一天
      await main.evaluate(`window.location.hash = "#/browse"`);
      await main.locator(".browse-side-toggle").waitFor();
      const day = side.locator('.xcard-map[data-show="day"]');
      await day.scrollIntoViewIfNeeded();
      await day.locator(".map-card-img").waitFor({ timeout: 5000 });
      await day.locator(".map-card-open").click();
      await main.locator('.map-canvas .map-mark[data-kind="stay"]').first().waitFor({ timeout: 5000 });
      expect(await main.evaluate("location.hash")).toMatch(/^#\/more\/map\/\d{4}-\d{2}-\d{2}$/);
      expect(closes).toEqual(["close", "close"]);
      // 不是二狗自己的地址（外部网页链接）不归这里管：主页面不跳
      await main.evaluate(`window.location.hash = "#/browse"`);
      await side.evaluate(`localStorage.setItem("ergo-side-goto", JSON.stringify({ hash: "https://example.cn/", at: Date.now() }))`);
      await main.evaluate(`window.__ergoBrowser(JSON.stringify({ type: "side", action: "close" }))`);
      await main.waitForTimeout(1000);
      expect(await main.evaluate("location.hash")).toBe("#/browse");
      expect(errors).toEqual([]);
    } finally {
      await context.close();
    }
  }, 60_000);

  // 网页上选中地址点"在地图上看"（447）：假的原生桥扮 App 和页面桥。浏览页交给页面桥的那几句带 map（地图插件开着；停用了不带）；
  // 页面桥报 element-map show：气泡里"在地图上找"，原型的假接口查到（带汉字的"高德"查到西湖边），浏览页跳到地图页看查到的那一处
  // （#/more/map/lookup/<编号>，高德查的画在高德底图上，标题栏写查的那段字）；返回回到"浏览"。合了 446：不带汉字的谷歌查、画在谷歌底图上
  test("浏览页：选中地址点在地图上看，不经对话直接跳到地图页看查到的那一处；地图插件停用时不给那两个按钮", async () => {
    const fake = `
      window.__texts = [];
      window.__bubbles = [];
      window.ergoNative = {
        appVersion: () => "9.9.9",
        log() {},
        browserAttach: () => JSON.stringify({ url: "https://shop.example.cn/store", title: "门店 · 示例", progress: 1, loading: false, canGoBack: false, canGoForward: false }),
        browserLayout() {},
        browserLoad() {},
        browserNav() {},
        browserPage(op, args) {
          if (op === "texts") window.__texts.push(JSON.parse(args)[0]);
          if (op === "bubble") window.__bubbles.push(JSON.parse(JSON.parse(args)[0]));
          return Promise.resolve(op === "bubble" || op === "texts" || op === "mark" ? '{"ok":true}' : "");
        },
        browserFileChunk: () => Promise.resolve('{"ok":true}'),
        browserFiles: () => Promise.resolve('{"ok":true}'),
        browserChooser: () => Promise.resolve('{"ok":true}'),
        browserSide() {},
      };`;
    const context = await browser!.newContext({ viewport: { width: 390, height: 844 } });
    await context.addInitScript(fake);
    const page = await context.newPage();
    const errors: string[] = [];
    const outside: string[] = [];
    page.on("pageerror", (e) => errors.push(String(e)));
    page.on("request", (r) => {
      if (!/^(?:file|data|blob):/.test(r.url())) outside.push(r.url());
    });
    try {
      await page.goto(`${pageUrl}#/browse`);
      await page.locator(".browse-side-toggle").waitFor();
      const bridgeSays = (event: object) => page.evaluate(`window.__ergoBrowser(${JSON.stringify(JSON.stringify({ type: "page", json: JSON.stringify({ nonce: "n", ...event }) }))})`);
      const where = { title: "门店 · 示例", url: "https://shop.example.cn/store" };
      await bridgeSays({ type: "selected", field: null, page: where });
      const lastTexts = async () => (await page.evaluate(`(() => { const t = window.__texts.at(-1); return t ? JSON.parse(t) : null; })()`)) as { map?: boolean; "bridge.map.show"?: string } | null;
      await page.waitForFunction(`window.__texts.length > 0`);
      expect(await lastTexts()).toMatchObject({ map: true, "bridge.map.show": "在地图上看" });
      const element = { id: "x4", kind: "text", selected: true, text: { text: "地址：杭州市西湖区示例路 478 号", total: 19 } };
      await bridgeSays({ type: "element", element });
      await bridgeSays({ type: "element-map", action: "show", element, page: where });
      await page.waitForFunction(`window.__bubbles.some((b) => b.kind === "busy" && b.text === "在地图上找这个地方……")`);
      await page.locator('.map-canvas[data-own-source="amap"][data-own-results="shown"]').waitFor({ timeout: 5000 });
      expect(await page.evaluate("location.hash")).toMatch(/^#\/more\/map\/lookup\/amap-p\d+$/);
      // 461：手机宽放不下几个字的概况整个不显示，这里看标题栏里写了什么
      expect(await page.locator(".map-card-bar").textContent()).toMatch(/杭州市西湖区示例路 478 号[\s\S]*数据来自高德地图/);
      expect(await page.locator(".map-canvas").getAttribute("data-basemap")).toBe("amap");
      expect(await page.evaluate(`window.__bubbles.at(-1).kind`)).toBe("none");
      // 返回回到"浏览"
      await page.goBack();
      await page.locator(".browse-side-toggle").waitFor();
      expect(await page.evaluate("location.hash")).toBe("#/browse");
      // 合了 446：不带汉字的（国外的地址）——演示页"填好了"谷歌的 Key，按"自动"谷歌查的（编号 google-p…），画在谷歌底图上
      const abroad = { id: "x5", kind: "text", selected: true, text: { text: "10 Bayfront Avenue, Singapore 018956", total: 36 } };
      await bridgeSays({ type: "element", element: abroad });
      await bridgeSays({ type: "element-map", action: "show", element: abroad, page: where });
      await page.locator('.map-canvas[data-basemap="google"][data-own-results="shown"]').waitFor({ timeout: 5000 });
      expect(await page.evaluate("location.hash")).toMatch(/^#\/more\/map\/lookup\/google-p\d+$/);
      expect(await page.locator(".map-card-bar").textContent()).toMatch(/10 Bayfront Avenue, Singapore 018956[\s\S]*数据来自 Google 地图/);
      await page.locator('.map-page-overlay .map-mark[data-kind="search"]').first().waitFor({ timeout: 5000 });
      expect(await page.locator('.map-page-overlay .map-mark[data-kind="search"]').count()).toBe(1);
      await page.goBack();
      await page.locator(".browse-side-toggle").waitFor();
      expect(outside).toEqual([]);
      expect(errors).toEqual([]);
    } finally {
      await context.close();
    }
    // 地图插件停用：不带 map（页面桥不给那两个按钮）
    const off = await browser!.newContext({ viewport: { width: 390, height: 844 } });
    await off.addInitScript(fake);
    try {
      const p2 = await off.newPage();
      await p2.goto(`${pageUrl}?demo-plugins-off=map#/browse`);
      await p2.locator(".browse-side-toggle").waitFor();
      await p2.evaluate(`window.__ergoBrowser(${JSON.stringify(JSON.stringify({ type: "page", json: JSON.stringify({ nonce: "n", type: "selected", field: null, page: { title: "x", url: "https://shop.example.cn/" } }) }))})`);
      await p2.waitForFunction(`window.__texts.length > 0`);
      expect(await p2.evaluate(`JSON.parse(window.__texts.at(-1)).map`)).toBeUndefined();
    } finally {
      await off.close();
    }
  }, 60_000);

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

  // 420：设置 · 模型里"自动压缩"的默认值（内置 70 万）——边改边查、存了跟随默认的 agent 的 ⚙ 跟着变、单独设了的不变、恢复默认
  test("设置 · 模型：自动压缩点能改、写错的不让存，跟随默认的 agent 跟着变，能恢复默认", async () => {
    const { page, errors } = await open({ width: 1280, height: 800 });
    const at = async (hash: string) => {
      await page.evaluate(`window.location.hash = ${JSON.stringify(hash)}`);
      await page.waitForTimeout(400);
    };
    const section = () => page.locator(".models-page .sec", { has: page.locator('input[name="model-auto-compact"]') });
    await at("#/more/models");
    await page.waitForSelector('input[name="model-auto-compact"]');
    expect(await page.locator('input[name="model-auto-compact"]').inputValue()).toBe("700000");
    expect(await section().innerText()).toContain("现在：70 万 token（默认）");
    // 原型里记账本的负责人单独设了 30 万
    expect(await section().innerText()).toContain("1 个 agent 在自己的 ⚙ 里单独设了，不跟这个变");
    expect(await section().locator('button:has-text("恢复默认（70 万）")').isDisabled()).toBe(true);
    // 写错的：说清最少多少，保存点不了
    await page.fill('input[name="model-auto-compact"]', "40000");
    expect(await section().locator(".field-error").innerText()).toContain("最少 50,000 token");
    expect(await section().locator('button:has-text("保存")').isDisabled()).toBe(true);
    // 改成 50 万：存了
    await page.fill('input[name="model-auto-compact"]', "500000");
    await section().locator('button:has-text("保存")').click();
    await page.waitForFunction(`document.querySelector(".model-auto-compact-current")?.textContent === "现在：50 万 token（默认是 70 万）"`, undefined, { timeout: 10_000 });

    // 跟随默认的（秘书）跟着变；单独设了的（记账本的负责人）不变
    await at("#/secretary");
    await page.click(".agent-gear");
    await page.waitForSelector(".agent-auto-compact");
    expect(await page.locator(".agent-auto-compact-source").innerText()).toBe("跟随设置 · 模型里的默认：50 万 token");
    expect(await page.locator('input[name="agent-auto-compact"]').inputValue()).toBe("500000");
    await page.locator(".modal .sheet-head .icon-btn").click();
    await at("#/projects/p-ledger/chat");
    await page.click(".agent-gear");
    await page.waitForSelector(".agent-auto-compact");
    expect(await page.locator(".agent-auto-compact-source").innerText()).toBe("单独设的：30 万 token（默认是 50 万）");
    await page.locator(".modal .sheet-head .icon-btn").click();

    // 恢复默认：回到内置的 70 万
    await at("#/more/models");
    await section().locator('button:has-text("恢复默认（70 万）")').click();
    await page.waitForFunction(`document.querySelector(".model-auto-compact-current")?.textContent === "现在：70 万 token（默认）"`, undefined, { timeout: 10_000 });
    expect(await page.locator('input[name="model-auto-compact"]').inputValue()).toBe("700000");
    await page.close();
    expect(errors).toEqual([]);
  }, 60_000);

  // 420：⚙ → 上下文用量里的自动压缩点——单独设过的写默认是多少、能恢复默认改回跟随；能改成别的数（超过这个模型的上限不让存）；
  // Claude Code 跑的灰掉、写明它自己管
  test("手机宽：⚙ 里自动压缩点单独设的能恢复默认、能改，写错的不让存；Claude Code 的灰掉", async () => {
    const { page, errors } = await open({ width: 390, height: 844 });
    const openGear = async (hash: string) => {
      await page.evaluate(`window.location.hash = ${JSON.stringify(hash)}`);
      await page.waitForTimeout(400);
      await page.click(".topbar .th-more");
      await page.getByRole("menuitem", { name: "这个 agent 的设置" }).click();
      await page.waitForSelector(".agent-auto-compact");
    };
    const source = () => page.locator(".agent-auto-compact-source").innerText();
    const field = page.locator('input[name="agent-auto-compact"]');
    const block = page.locator(".agent-auto-compact");
    await openGear("#/projects/p-ledger/chat");
    expect(await source()).toBe("单独设的：30 万 token（默认是 70 万）");
    expect(await field.inputValue()).toBe("300000");
    // 恢复默认：改回跟随
    await block.locator('button:has-text("恢复默认")').click();
    await page.waitForFunction(`document.querySelector(".agent-auto-compact-source")?.textContent === "跟随设置 · 模型里的默认：70 万 token"`, undefined, { timeout: 10_000 });
    expect(await field.inputValue()).toBe("700000");
    expect(await block.locator('button:has-text("恢复默认")').isDisabled()).toBe(true);
    // 超过这个模型的上限（窗口 100 万减 16384）：不让存
    await field.fill("990000");
    expect(await block.locator(".field-error").innerText()).toContain("最多设到 983,616 token");
    expect(await block.locator('button:has-text("保存")').isDisabled()).toBe(true);
    // 改成 20 万：单独设的
    await field.fill("200000");
    await block.locator('button:has-text("保存")').click();
    await page.waitForFunction(`document.querySelector(".agent-auto-compact-source")?.textContent === "单独设的：20 万 token（默认是 70 万）"`, undefined, { timeout: 10_000 });
    // 上面那句"离自动压缩还有……"按新的点算
    expect(await page.locator(".agent-panel").innerText()).toContain("用量超过 20 万 token 时自动压缩");
    await page.locator(".modal .sheet-head .icon-btn").click();

    // Claude Code 跑的（个人博客的负责人）：灰掉、写明它自己管
    await openGear("#/projects/p-blog/chat");
    expect(await field.isDisabled()).toBe(true);
    expect(await block.innerText()).toContain("由 Claude Code 自己管压缩，这里设的压缩点对它不起作用");
    await page.close();
    expect(errors).toEqual([]);
  }, 60_000);

  test("手机宽：模型服务忙时聊天末尾一行\"正在重试（第 N 次）\"，停下就收起；重试用完写清服务商那边忙、可以等一会儿再问或换模型（中英）", async () => {
    const send = sendInSecretary;
    const line = retryLine;
    // 一直在重试：第 1 次、第 2 次，输入框上是"停止"；点停止就收起
    const busy = await open({ width: 390, height: 844 }, "?demo-model-busy=retrying");
    await send(busy.page, "问个问题");
    await busy.page.waitForFunction(`document.querySelector(".model-retry")?.textContent === "模型服务忙，正在重试（第 1 次）…"`, undefined, { timeout: 10_000 });
    await busy.page.waitForFunction(`document.querySelector(".model-retry")?.textContent === "模型服务忙，正在重试（第 2 次）…"`, undefined, { timeout: 10_000 });
    expect(await line(busy.page).locator(".icon").count()).toBe(1);
    // 在会话里、在屏幕里（输入框上面）
    const box = await line(busy.page).boundingBox();
    expect(box!.width).toBeGreaterThan(0);
    expect(box!.x + box!.width).toBeLessThanOrEqual(390);
    await busy.page.locator(".composer-stop").click();
    await line(busy.page).waitFor({ state: "detached", timeout: 10_000 });
    await busy.page.close();
    expect(busy.errors).toEqual([]);

    // 重试用完：那一行收起，会话里一条说明
    for (const [search, note] of [
      ["?demo-model-busy=failed", "这次没能回复：模型服务商那边忙，自动重试了 3 次还是没成（503 Service Unavailable）。可以等一会儿再问，或者在设置 · 模型里换一个模型"],
      ["?demo-model-busy=failed&lang=en", "couldn't reply this time: The model provider is busy; retried 3 times and it still failed (503 Service Unavailable). Wait a bit and ask again, or switch to another model in Settings · Models"],
    ] as const) {
      const { page, errors } = await open({ width: 390, height: 844 }, search);
      await send(page, "ask again");
      await line(page).waitFor({ timeout: 10_000 });
      await page.waitForFunction(`document.querySelector(".conv")?.textContent?.includes(${JSON.stringify(note)}) === true`, undefined, { timeout: 15_000 });
      expect(await line(page).count()).toBe(0);
      // 会话里的话不写"秘书"（导航上那一项除外，不在会话里）
      const said = await page.locator(".conv").innerText();
      expect(said).not.toContain("秘书");
      expect(said).not.toContain("待我处理");
      await page.close();
      expect(errors).toEqual([]);
    }
  }, 60_000);
});

/** 秘书会话里打一句、回车发出去 */
async function sendInSecretary(page: Page, text: string): Promise<void> {
  await page.evaluate(`window.location.hash = "#/secretary"`);
  await page.waitForTimeout(300);
  const box = page.locator(".composer textarea").first();
  await box.fill(text);
  await box.press("Enter");
}

/** 会话末尾"正在重试"那一行 */
const retryLine = (page: Page) => page.locator(".model-retry");

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

/** 收成一行的一条量出来的（CSS 像素，相对视口）：这一行、它那一格的最宽（max-width）、行尾的 ›、会话视口的右边 */
interface RowBox {
  /** 哪一种（line-<种类>）：thinking、tool、recall、letter、card、record、note、branch */
  kind: string;
  text: string;
  left: number;
  right: number;
  /** 这一行那一格（.part-line）的最宽，和对话气泡（.part-text）的最宽比 */
  maxWidth: string;
  viewportRight: number;
  /** 行尾的 ›；点不开的行没有 */
  arrow?: { left: number; right: number; width: number; hit: boolean };
  overflow: number;
}

interface RowMeasure {
  /** 对话气泡（回复的 .part-text）的最宽；页面上没有回复是 undefined */
  bubbleMax: string | undefined;
  rows: RowBox[];
}

/**
 * 在页面里量会话里看得见的每一行（.msg .tool-sum）和对话气泡的最宽。
 * 每行先滚到视口中间再量 › 点不点得到（elementFromPoint 落在这一行里）
 */
const MEASURE_ROWS = `(() => {
  const vis = (el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
  const bubble = Array.from(document.querySelectorAll(".msg.assistant .part-text")).find(vis);
  const rows = [];
  for (const row of document.querySelectorAll(".msg .tool-sum")) {
    if (!vis(row)) continue;
    row.scrollIntoView({ block: "center" });
    const r = row.getBoundingClientRect();
    const viewport = row.closest(".zh-viewport") ?? document.documentElement;
    const kind = (Array.from(row.classList).find((c) => c.startsWith("line-")) ?? "line-?").slice(5);
    const box = { kind, text: row.textContent.trim().slice(0, 24), left: r.left, right: r.right, maxWidth: getComputedStyle(row.parentElement).maxWidth, viewportRight: viewport.getBoundingClientRect().right, overflow: row.scrollWidth - row.clientWidth };
    const arrow = row.querySelector(".tool-more");
    if (arrow) {
      const a = arrow.getBoundingClientRect();
      const hitEl = document.elementFromPoint(a.left + a.width / 2, a.top + a.height / 2);
      box.arrow = { left: a.left, right: a.right, width: a.width, hit: !!hitEl && hitEl.closest(".tool-sum") === row };
    }
    rows.push(box);
  }
  return { bubbleMax: bubble ? getComputedStyle(bubble).maxWidth : undefined, rows };
})()`;

/** 两个位置差不到 1 像素（亚像素取整） */
const near = (a: number, b: number) => Math.abs(a - b) <= 1;

/** 一页上收成一行的那几条哪里不对：每条各自的，加上几条之间（左边、右边、› 不在同一条竖线上） */
function rowProblems(where: string, found: RowMeasure): string[] {
  const out: string[] = [];
  const [first] = found.rows;
  const firstArrow = found.rows.find((r) => r.arrow)?.arrow;
  for (const r of found.rows) {
    const name = `${where} ${r.kind}「${r.text}」`;
    if (found.bubbleMax !== undefined && r.maxWidth !== found.bubbleMax) out.push(`${name}：最宽 ${r.maxWidth}，对话气泡最宽 ${found.bubbleMax}，不一样宽`);
    if (first && !near(r.left, first.left)) out.push(`${name}：左边 ${r.left.toFixed(1)}，第一行是 ${first.left.toFixed(1)}，不在同一列`);
    if (first && !near(r.right, first.right)) out.push(`${name}：右边 ${r.right.toFixed(1)}，第一行是 ${first.right.toFixed(1)}，不一样宽`);
    if (r.right > r.viewportRight) out.push(`${name}：右边 ${r.right.toFixed(1)} 超出了会话视口 ${r.viewportRight.toFixed(1)}`);
    if (r.overflow > 1) out.push(`${name}：里面的东西比这一行宽 ${r.overflow} 像素（被挤出去了）`);
    const a = r.arrow;
    if (a) {
      if (a.width <= 0 || a.left < r.left - 0.5 || a.right > r.right + 0.5) out.push(`${name}：› ${a.left.toFixed(1)}..${a.right.toFixed(1)} 没整个露在这一行 ${r.left.toFixed(1)}..${r.right.toFixed(1)} 里`);
      if (!a.hit) out.push(`${name}：› 点不到（被别的东西盖住了）`);
      if (firstArrow && !near(a.right, firstArrow.right)) out.push(`${name}：› 的右边 ${a.right.toFixed(1)}，别的行是 ${firstArrow.right.toFixed(1)}，不在同一条竖线上`);
    }
  }
  return out;
}
