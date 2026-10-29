// 原型的运营方案（130 号票）：读书笔记库的"首版做完了"卡上带的那一份（等你确认并转入使用），家庭菜谱现在生效的运营方案
// （项目页"运营方案"一节：在跑、暂停、没生效、要你手动各一条）和它等你确认的"运营方案变更"卡（改时间、加上、去掉、照旧）。
// 133 号票：运营手段"服务"——读书笔记库的方案里"随手翻页面"是要上线的服务；家庭菜谱的"菜谱网页"上线了（在线，有入口），它的上一张
// 变更卡（第 2 份，加上了这个服务）你确认过了、卡上带着入口，等你确认的那张改了它的启动命令；家庭网盘的服务挂了（项目卡上标红）。
// 140 号票：服务首页的缩略图（画好的假网页，fakeServiceThumbnail）——菜谱网页、网盘页面（挂了：灰着标"不在线"）各一张，停用了的
// 旧作品集网站留着最后一张；家庭菜谱两条定时任务的最近几次运行（时令菜提醒那次失败了）。
import {
  CHANNELS,
  EVENT_TYPES,
  maintainerChannel,
  type OperationItem,
  type OperationService,
  type OperationsChangeCardPayload,
  type OperationsPlanView,
  type ProjectOperations,
  type ProjectServiceView,
  type Task,
  type TaskEventPayload,
  type WorkOrder,
  type WorkOrderEventPayload,
} from "../state/index.ts";

const at = (md: string, hm: string) => `2026-${md}T${hm}:00+08:00`;

const item = (x: Pick<OperationItem, "key" | "name" | "triggerText" | "instructions"> & Partial<OperationItem>): OperationItem => ({
  means: "schedule",
  meansLabel: "定时触发的任务",
  automatic: true,
  approach: "plain",
  capabilities: {},
  ...x,
});

/** 读书笔记库的维护者建设期间交的（"首版做完了"卡上的"转入使用后会开起来的"） */
export const READING_OPERATIONS: OperationsPlanView = {
  revision: 1,
  why: "书摘每天都在进来：新书摘自动入库，每周日晚上出一份读书小结；随手翻页面要常开着给手机看。",
  items: [
    item({
      key: "weekly-digest",
      name: "每周读书小结",
      schedule: { kind: "weekly", time: "20:00", weekdays: [0] },
      triggerText: "每周日 20:00",
      instructions: "汇总这一周新进的书摘，按主题写一份读书小结 digest.md，挑三条值得回看的放在最前面",
      onFailure: "跳过这一周，下周一起汇总",
    }),
    item({
      key: "import-new",
      name: "新书摘自动入库",
      means: "event",
      meansLabel: "事件触发的任务",
      event: { kind: "event", source: "folder", events: ["added"], filter: { path: "/示例/书摘导出", pattern: "*.md" } },
      triggerText: "本机文件夹 /示例/书摘导出 里新增 *.md 文件",
      instructions: "用 import_notes.py 把新导出的书摘导进 notes.db，打好主题标签",
      capabilities: { bash: true },
    }),
    item({
      key: "page",
      name: "随手翻页面",
      means: "service",
      meansLabel: "项目自己的服务（登记到 LSM）",
      triggerText: "上线服务「随手翻页面」（端口 18640，开机自启）",
      instructions: "随手翻页面常开着，手机上随时能翻",
      service: {
        name: "page",
        app: "p-reading-page",
        command: "python -m http.server 18640",
        cwd: "/示例/项目/读书笔记库/workdir/site",
        env: [{ name: "NOTES_DB", value: "../notes.db" }],
        port: 18640,
        autostart: true,
        autoRestart: false,
        web: { home: "/", prefix: "strip" },
      },
    }),
  ],
};

/**
 * 259 号票：相册库的维护者提转入使用时带着的运营方案（"转入使用"确认卡上的那一份）：相册浏览页是要上线的服务——其他类的项目真有服务，
 * 检查清单照开发类查
 */
export const PHOTOS_OPERATIONS: OperationsPlanView = {
  revision: 1,
  why: "照片按事件归好了，浏览页常开着给手机看。",
  items: [
    item({
      key: "gallery",
      name: "相册浏览页",
      means: "service",
      meansLabel: "项目自己的服务（登记到 LSM）",
      triggerText: "上线服务「相册浏览页」（端口 18660，开机自启）",
      instructions: "相册浏览页常开着，手机上按事件翻照片",
      service: {
        name: "gallery",
        app: "p-photos-gallery",
        command: "node server.mjs",
        cwd: "/示例/项目/相册库/workdir/gallery",
        env: [{ name: "PHOTOS_DIR", value: "../photos" }],
        port: 18660,
        health: { path: "/health" },
        autostart: true,
        autoRestart: false,
        web: { home: "/", prefix: "strip" },
      },
    }),
  ],
};

/** 家庭菜谱的"菜谱网页"服务（第 2 份加上的） */
const recipesWeb = (command: string): OperationService => ({
  name: "web",
  app: "p-recipes-web",
  command,
  cwd: "/示例/项目/家庭菜谱/workdir/site",
  env: [
    { name: "PORT", value: "18650" },
    { name: "UNSPLASH_ACCESS_KEY", secret: "unsplash-key.txt" },
  ],
  port: 18650,
  health: { path: "/health" },
  autostart: true,
  autoRestart: true,
  web: { home: "/", prefix: "strip" },
});

const recipesWebItem = (command: string): OperationItem =>
  item({
    key: "web",
    name: "菜谱网页",
    means: "service",
    meansLabel: "项目自己的服务（登记到 LSM）",
    triggerText: "上线服务「菜谱网页」（端口 18650，开机自启，挂了自动重启）",
    instructions: "本周菜单、买菜清单和菜谱做成网页，手机上随时看",
    service: recipesWeb(command),
  });

/** 家庭菜谱现在生效的运营方案（第 2 份）：在跑、暂停、没生效、要你手动各一条 */
export const RECIPES_OPERATIONS: ProjectOperations = {
  revision: 2,
  confirmedAt: at("10-05", "21:12"),
  items: [
    {
      key: "weekly-menu",
      name: "本周菜单",
      means: "schedule",
      meansLabel: "定时触发的任务",
      automatic: true,
      triggerText: "每周六 09:00",
      schedule: { kind: "weekly", time: "09:00", weekdays: [6] },
      approach: "plain",
      instructions: "按季节和冰箱里剩的，排出下周的菜单和买菜清单",
      capabilities: { network: true },
      taskId: "t-recipes-menu",
    },
    {
      key: "seasonal",
      name: "时令菜提醒",
      means: "schedule",
      meansLabel: "定时触发的任务",
      automatic: true,
      triggerText: "每月 1 号 08:00",
      schedule: { kind: "monthly", time: "08:00", days: [1] },
      approach: "plain",
      instructions: "列出这个月的时令菜和三道推荐做法",
      capabilities: { network: true },
      taskId: "t-recipes-seasonal",
    },
    {
      key: "photo-import",
      name: "菜谱照片入库",
      means: "event",
      meansLabel: "事件触发的任务",
      automatic: true,
      triggerText: "本机文件夹 /示例/菜谱照片 里新增文件",
      approach: "plain",
      instructions: "识别照片里的菜谱，整理成一条做法记下来",
      capabilities: { bash: true },
      failed: "要的能力超出了项目现在的工具包（bash）",
    },
    { ...recipesWebItem("node server.mjs") },
    {
      key: "site",
      name: "菜谱网页的公网入口",
      means: "public_entry",
      meansLabel: "公网入口",
      automatic: false,
      triggerText: "公网入口",
      approach: "plain",
      instructions: "在外面买菜时不经二狗也能打开",
      capabilities: {},
      manual: "在隧道里给菜谱网页开一个入口（比如 recipes.example.com）",
    },
  ],
};

/** 家庭菜谱上一张"运营方案变更"卡（第 2 份）：加上了菜谱网页这个服务，你确认过了（卡上带着入口） */
export const RECIPES_OPERATIONS_ADD_WEB: OperationsChangeCardPayload = {
  projectId: "p-recipes",
  projectName: "家庭菜谱",
  revision: 2,
  baseRevision: 1,
  why: "你想在手机上随时看本周菜单和买菜清单：把菜谱做成网页，经 LSM 常开着，项目卡片上有入口。",
  added: [recipesWebItem("node server.mjs")],
  changed: [],
  removed: [],
  restored: [],
  kept: [{ key: "weekly-menu", name: "本周菜单", triggerText: "每周六 09:00" }],
  decided: { confirmed: true, at: at("10-05", "21:12"), results: [{ key: "web", name: "菜谱网页", outcome: "created" }, { key: "weekly-menu", name: "本周菜单", outcome: "kept", taskId: "t-recipes-menu" }] },
};

/** 原型里项目的服务（项目列表频道上的临时事件 project_services）：菜谱网页在线；家庭网盘的页面挂了；旧作品集网站随项目停用撤下了 */
export const FAKE_PROJECT_SERVICES: ProjectServiceView[] = [
  { projectId: "p-recipes", key: "web", title: "菜谱网页", name: "web", app: "p-recipes-web", port: 18650, autostart: true, url: "/apps/p-recipes-web/", rollout: "live", status: "online", thumbnailAt: at("10-07", "08:10") },
  { projectId: "p-netdisk", key: "web", title: "网盘页面", name: "web", app: "p-netdisk-web", port: 18660, autostart: true, url: "/apps/p-netdisk-web/", rollout: "live", status: "failed", detail: "进程退出了（退出码 1）", thumbnailAt: at("10-06", "22:00") },
  { projectId: "p-oldsite", key: "site", title: "作品集网站", name: "site", app: "p-oldsite-site", port: 18670, autostart: true, url: "/apps/p-oldsite-site/", rollout: "withdrawn", status: "unknown", thumbnailAt: at("09-30", "12:00") },
];

/** 一张画好的假网页（1280×800 的 SVG）：顶栏、标题、一排卡片 */
function fakePage(o: { bar: string; bg: string; title: string; sub: string; cards: Array<{ color: string; label: string }> }): string {
  const cards = o.cards
    .map((c, i) => {
      const x = 64 + i * 296;
      return `<rect x="${x}" y="300" width="272" height="380" rx="18" fill="#fff" stroke="#e5e7eb" stroke-width="2"/><rect x="${x}" y="300" width="272" height="170" rx="18" fill="${c.color}"/><text x="${x + 24}" y="530" font-size="30" font-family="sans-serif" fill="#111827">${c.label}</text><rect x="${x + 24}" y="566" width="200" height="16" rx="8" fill="#e5e7eb"/><rect x="${x + 24}" y="600" width="150" height="16" rx="8" fill="#e5e7eb"/>`;
    })
    .join("");
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1280 800" width="640" height="400"><rect width="1280" height="800" fill="${o.bg}"/><rect width="1280" height="88" fill="${o.bar}"/><circle cx="64" cy="44" r="18" fill="#fff" opacity=".85"/><rect x="100" y="34" width="180" height="20" rx="10" fill="#fff" opacity=".85"/><text x="64" y="190" font-size="56" font-weight="700" font-family="sans-serif" fill="#111827">${o.title}</text><text x="64" y="246" font-size="28" font-family="sans-serif" fill="#6b7280">${o.sub}</text>${cards}</svg>`;
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

const FAKE_THUMBNAILS: Record<string, string> = {
  "p-recipes-web": fakePage({
    bar: "#e8590c",
    bg: "#fff7ed",
    title: "本周菜单",
    sub: "10 月 7 日 – 10 月 13 日 · 买菜清单 12 样",
    cards: [
      { color: "#fb923c", label: "番茄炒蛋" },
      { color: "#4ade80", label: "清炒菠菜" },
      { color: "#facc15", label: "玉米排骨汤" },
      { color: "#f87171", label: "可乐鸡翅" },
    ],
  }),
  "p-netdisk-web": fakePage({
    bar: "#1d4ed8",
    bg: "#eff6ff",
    title: "家庭网盘",
    sub: "已用 1.2 TB / 4 TB · 昨晚备份成功",
    cards: [
      { color: "#93c5fd", label: "照片" },
      { color: "#a5b4fc", label: "文档" },
      { color: "#6ee7b7", label: "视频" },
      { color: "#fcd34d", label: "备份" },
    ],
  }),
  "p-oldsite-site": fakePage({
    bar: "#374151",
    bg: "#f9fafb",
    title: "作品集",
    sub: "2019 – 2024",
    cards: [
      { color: "#c4b5fd", label: "海报" },
      { color: "#f9a8d4", label: "插画" },
      { color: "#99f6e4", label: "网页" },
      { color: "#fde68a", label: "摄影" },
    ],
  }),
};

/** 原型的服务首页缩略图（140 号票）：按应用名给画好的假网页；没画的没有 */
export function fakeServiceThumbnail(app: string): string | undefined {
  return FAKE_THUMBNAILS[app];
}

const recipesMenu = (time: string, weekday: number, triggerText: string): OperationItem =>
  item({
    key: "weekly-menu",
    name: "本周菜单",
    schedule: { kind: "weekly", time, weekdays: [weekday] },
    triggerText,
    instructions: "按季节和冰箱里剩的，排出下周的菜单和买菜清单",
    capabilities: { network: true },
  });

/** 家庭菜谱的维护者交的新一份（第 3 份）：菜单改到周五晚上、时令菜提醒去掉、加上每天的剩菜提醒 */
export const RECIPES_OPERATIONS_CHANGE: OperationsChangeCardPayload = {
  projectId: "p-recipes",
  projectName: "家庭菜谱",
  revision: 3,
  baseRevision: 2,
  why: "你说周六早上来不及买菜、菜单提前到周五晚上，时令菜提醒不要了，冰箱里的剩菜每天提醒一次；菜谱网页加上缓存，手机上开得快一点。",
  added: [
    item({
      key: "leftovers",
      name: "剩菜提醒",
      schedule: { kind: "daily", time: "17:30" },
      triggerText: "每天 17:30",
      instructions: "看看冰箱清单里哪些剩菜明天就该吃掉了，给出今晚怎么用的建议",
      capabilities: { tellSecretary: true },
    }),
  ],
  changed: [
    { before: recipesMenu("09:00", 6, "每周六 09:00"), after: recipesMenu("20:00", 5, "每周五 20:00"), inPlace: true },
    { before: recipesWebItem("node server.mjs"), after: recipesWebItem("node server.mjs --cache"), inPlace: false },
  ],
  removed: [
    item({
      key: "seasonal",
      name: "时令菜提醒",
      schedule: { kind: "monthly", time: "08:00", days: [1] },
      triggerText: "每月 1 号 08:00",
      instructions: "列出这个月的时令菜和三道推荐做法",
      capabilities: { network: true },
    }),
  ],
  restored: [],
  kept: [{ key: "site", name: "菜谱网页的公网入口", triggerText: "公网入口" }],
  userWords: [
    {
      messageId: "msg-recipes-friday",
      text: "菜单提前到周五晚上吧，周六早上来不及买菜；时令菜那个不要了，剩菜每天提醒我一下",
      conversation: maintainerChannel("project-recipes"),
      where: "项目「家庭菜谱」的维护者会话",
      time: at("10-07", "18:38"),
      device: "本机",
    },
  ],
};

/** 一次运行（140 号票：项目页"现在"里的最近几次运行） */
const recipesRun = (jobId: string, n: number, state: "done" | "failed" | "partial", ended: string, reason?: string, summary?: string) => ({
  runId: `${jobId}-r${n}`,
  jobId,
  trigger: "scheduled" as const,
  dueAt: ended,
  state,
  queuedAt: ended,
  startedAt: ended,
  endedAt: ended,
  ...(reason ? { reason } : {}),
  ...(summary ? { summary } : {}),
});

/** 家庭菜谱运营方案里两条的触发登记（项目页上的状态照它算：一条在跑、一条你暂停了）；140 号票起带最近几次运行（runs，先跑的在前） */
export const RECIPES_JOBS = [
  {
    id: "sj-recipes-menu",
    ownerTaskId: "t-recipes-menu",
    title: "本周菜单",
    schedule: { kind: "weekly" as const, time: "09:00", weekdays: [6] },
    state: "active" as const,
    nextAt: at("10-10", "09:00"),
    // 176 号票：第 2 次部分完成（推送到手机那一步没等到你的批准，菜单和买菜清单照样做好了）
    runs: [
      recipesRun("sj-recipes-menu", 1, "done", at("09-26", "09:03")),
      recipesRun(
        "sj-recipes-menu",
        2,
        "partial",
        at("10-03", "09:12"),
        "有一步没等到你的批准：「通用 bash」（curl -s -X POST https://push.example.com/menu -d @menu.md）",
        "本周菜单和买菜清单做好了，在菜谱网页上；推送到手机那一步没等到批准，先跳过了。",
      ),
    ],
  },
  {
    id: "sj-recipes-seasonal",
    ownerTaskId: "t-recipes-seasonal",
    title: "时令菜提醒",
    schedule: { kind: "monthly" as const, time: "08:00", days: [1] },
    state: "paused" as const,
    runs: [recipesRun("sj-recipes-seasonal", 1, "failed", at("10-01", "08:02"), "时令菜的网站打不开（HTTP 503）")],
  },
];

/**
 * 141 号票：家庭菜谱运营方案里那两条生效成的内部任务（origin operations）——上任务看板的"运营中"，卡上标"家庭菜谱"，
 * 菜单里只有暂停 / 恢复和"这是项目「家庭菜谱」运营方案里的一条……"
 */
export const RECIPES_OPERATIONS_TASKS: Task[] = RECIPES_JOBS.map((j) => ({
  id: j.ownerTaskId,
  title: j.title,
  summary: j.title,
  state: "operating",
  origin: "operations",
  kind: "plain",
  trigger: { kind: "schedule", schedule: j.schedule },
  maintainerId: "project-recipes",
  projects: ["家庭菜谱"],
  projectIds: ["p-recipes"],
  projectScope: "single",
  internal: { projectId: "p-recipes", projectName: "家庭菜谱" },
  createdAt: at("09-20", "10:00"),
  updatedAt: at("10-06", "21:00"),
}));

// ───────────────────────── 140 号票：相册库建设中卡住的几样（项目页最上面的"现在"） ─────────────────────────

const PHOTOS = { projectId: "p-photos", projectName: "相册库" };

const photosTask = (id: string, x: Partial<Task>): Task => ({
  id,
  title: id,
  summary: "",
  state: "running",
  origin: "button",
  kind: "long_running",
  maintainerId: "project-photos",
  projects: ["相册库"],
  projectIds: ["p-photos"],
  projectScope: "single",
  internal: PHOTOS,
  createdAt: at("10-05", "20:00"),
  updatedAt: at("10-07", "09:20"),
  ...x,
});

const photosOrder = (id: string, x: Partial<WorkOrder> & { taskId: string; taskTitle: string }): WorkOrder =>
  ({ id, projectId: "p-photos", maintainerId: "project-photos", title: id, state: "in_progress", source: "user_task", kind: "execute", createdAt: at("10-06", "10:00"), updatedAt: at("10-07", "09:00"), ...x }) as WorkOrder;

/**
 * 相册库（建设中）：首个建设任务第 2 阶段等你批准一条会删备份端文件的 rsync（被拦）、"按人脸分相册"卡住求助（等你）、
 * "补全拍摄时间"的工单做不了（失败），"按事件新建目录"的工单正在做；第 1 阶段验收时写的那句是最近的进展
 */
export const PHOTOS_BUILD_EVENTS: { channel: string; type: string; payload: unknown }[] = [
  photosTask("t-photos", {
    title: "家庭照片整理与去重",
    state: "waiting_for_user",
    waitReason: "approval",
    waitNote: "rsync --delete 会删掉备份端多出来的 312 个文件",
    stages: {
      total: 4,
      current: 2,
      focus: "s2",
      list: [
        { stageId: "s1", title: "扫描重复照片", state: "accepted", dependsOn: [], acceptance: [], attempts: 1, summary: "找出 214 组重复照片，清单在 dup.md" },
        { stageId: "s2", title: "按事件新建目录", state: "waiting", dependsOn: ["s1"], acceptance: [], attempts: 0, waitReason: "approval" },
        { stageId: "s3", title: "去重", state: "pending", dependsOn: ["s2"], acceptance: [], attempts: 0 },
        { stageId: "s4", title: "同步到网盘", state: "pending", dependsOn: ["s3"], acceptance: [], attempts: 0 },
      ],
    },
  }),
  photosTask("t-photos-faces", { title: "按人脸分相册", state: "waiting_for_user", waitReason: "stuck", waitNote: "人脸识别要 GPU，项目的工具包里没开 bash", updatedAt: at("10-07", "08:40") }),
  photosTask("t-photos-exif", { title: "补全照片的拍摄时间", kind: "workflow", updatedAt: at("10-07", "08:10") }),
].map((task) => ({ channel: CHANNELS.board, type: EVENT_TYPES.task, payload: { task, change: "created", from: null, by: "user" } satisfies TaskEventPayload }));

PHOTOS_BUILD_EVENTS.push(
  ...[
    photosOrder("W-25", { title: "执行：按事件新建目录", taskId: "t-photos", taskTitle: "家庭照片整理与去重", updatedAt: at("10-07", "09:20") }),
    photosOrder("W-26", { title: "执行：补全照片的拍摄时间", taskId: "t-photos-exif", taskTitle: "补全照片的拍摄时间", state: "ended", outcome: "unable", reason: "有 37 张照片没有 EXIF，读不出拍摄时间", endedAt: at("10-07", "08:10"), updatedAt: at("10-07", "08:10") }),
  ].map((workOrder) => ({ channel: CHANNELS.projects, type: EVENT_TYPES.workOrder, payload: { workOrder, change: "created", from: null, by: "user" } satisfies WorkOrderEventPayload })),
);
