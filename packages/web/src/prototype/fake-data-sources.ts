// 原型里的设置 · 数据源（295 号票）：直接打开构建产物（file://）时没有守护进程，这里编几个数据源和导入文件夹看样子——
// 297 号票起第一个是真插件的 Google · 日历（连着两个日历，每 30 分钟同步、显示在日历里），后面是示例的：
// 一个连着、定期导入的（带敏感内容），298 号票的 Google · Gmail（没连：按需查开着、导入我发出的邮件关着，原来那个"示例邮箱"换成了它），
// 一个只靠导入文件夹的；文件夹里一个认不出的、一个最近导入的。
// 动作只改内存里的样子（立即同步多 3 条、断开、开关用法），和守护进程一样要一会儿。真的数据源由各数据源插件登记（296 起）。
// 299 号票：加了手机插件的两个（通讯录选人、手机日历：连着，这台是 HUAWEI Pura 90），设备交来的只记一句。
// 301 号票：加了 Google · 联系人（只靠导入文件夹，上次导了一份编的 contacts.vcf）。
// 300 号票：加了手机插件的照片的时间地点、位置（连着，带几天原始数据；清掉原始数据只改内存里的样子）。
// 296 号票：Google 后面是真插件的 Looki（开头没连：下面是 Looki 插件画的填 Key 的那一块；填了 Key 测试连接就连上，
// Key 写 bad 回"不认"，连着时新填 bad 是"还在用原来的"）。
// 307 号票：Looki 带"存一份到本地"那一块（panel）：开头默认开着、还没存过；连上以后编一份已存的数（照片、日记、vlog）；改设置、补存、
// 停下、接着补、现在接着存只改内存里的样子（位置要写成 D:\… 这样的完整路径，不然回"要写完整的路径"），打开文件夹回"原型里打不开"。
// 306 号票：每个数据源带断开确认框要的 hasSecrets（填过密钥的）、toMaterials（导入的进素材的）；手机日历、通讯录、Google 日历、
// Google 联系人带数据源报的那一句（disconnectNote），和守护进程的说法一样。
// 308 号票："手机 · 位置"带"常去的地方"那一块（panel）：起了名的家、公司，常待还没起名的两处（一处有地名、一处只有坐标）；
// 起名、改名、删、加一处只改内存里的样子（重名的、名字空着的回原因）。
// 343 号票：数据源详情里看数据——已获取的（进素材的按 fake-materials 里编的数据源素材列，点开跳素材详情；不进素材的这里编）、现在能查到的
// （日历、Gmail、Looki 编的上游：现查要一会儿；Gmail 点开才有正文；没连着的写明）。全是编的，没有真实信息。Gmail 开头就连着，好看现查的样子。
import type {
  DataSourceActionBody,
  DataSourceActionResult,
  DataSourceDataItem,
  DataSourceItemView,
  DataSourceLiveBody,
  DataSourceLiveResult,
  DataSourcePushBody,
  DataSourcePushResult,
  DataSourcesView,
  DataSourceStoredBody,
  DataSourceStoredPage,
  DataSourceView,
  ImportFolderActionBody,
  ImportFolderActionResult,
  LookiArchiveView,
  PhonePlacesView,
} from "../state/index.ts";
import { DATA_SOURCE_STORED_PAGE, LOOKI_ARCHIVE_DEFAULT_KINDS, LOOKI_ARCHIVE_KINDS, nowIso } from "../state/index.ts";
import { fakeMaterialsIn } from "./fake-materials.ts";

/** 原型里"存一份到本地"的默认位置（和守护进程的默认一样：「文档」下的 Looki） */
const LOOKI_HOME = "C:\\Users\\me\\Documents\\Looki";

/** Looki 的"存一份到本地"那一块：默认开着、还没存过 */
function lookiArchive(): LookiArchiveView {
  return {
    on: true,
    folder: LOOKI_HOME,
    defaultFolder: LOOKI_HOME,
    kinds: { ...LOOKI_ARCHIVE_DEFAULT_KINDS },
    saved: { photos: 0, clips: 0, journals: 0, vlogs: 0, bytes: 0, days: 0 },
    pending: 0,
    failed: 0,
  };
}

const today = (time: string) => `${nowIso().slice(0, 10)}T${time}:00.000+08:00`;

/** "手机 · 位置"下面"常去的地方"那一块（308 号票）：起了名的两处、常待还没起名的两处 */
function phonePlaces(): PhonePlacesView {
  return {
    kind: "phone-places",
    places: [
      { id: "place-home", name: "家", lat: 30.28, lon: 120.1, radius: 200, address: "杭州市西湖区文三路", visits: 14 },
      { id: "place-work", name: "公司", lat: 30.2741, lon: 120.1551, radius: 300, address: "杭州市西湖区黄龙路", visits: 9 },
    ],
    suggestions: [
      { key: "30.25900,120.13000", lat: 30.259, lon: 120.13, label: "杭州市西湖区北山街", address: "杭州市西湖区北山街", visits: 4, days: 3 },
      { key: "30.29050,120.07600", lat: 30.2905, lon: 120.076, label: "北纬 30.29°、东经 120.08° 一带", visits: 2, days: 2 },
    ],
    days: 14,
  };
}
/** 往前第 n 天的日期（YYYY-MM-DD） */
const daysAgo = (n: number) => nowIso(new Date(Date.now() - n * 86_400_000)).slice(0, 10);

/** 编的 Gmail 账号（344 号票）：一行的样子和守护进程给的一样 */
function gmailAccount(address: string, off = false): DataSourceItemView {
  const id = `a${[...address].reduce((n, c) => (n * 31 + c.charCodeAt(0)) >>> 0, 7).toString(16).padStart(10, "0").slice(0, 10)}`;
  return { id, title: address, detail: `${off ? "关着" : "连着"} · 已导入 0 封`, count: 0, removable: true, ...(off ? { off: true as const } : {}) };
}

function initial(): DataSourcesView {
  return {
    sources: [
      {
        id: "google-calendar",
        title: "Google · 日历",
        summary: "Google 日历的私密 iCal 地址（只读，不用建 Google Cloud 项目）：定时拉事件显示在日历里，问到安排时现查",
        plugin: "google",
        pluginTitle: "Google",
        available: true,
        connection: "connected",
        account: "yourname@gmail.com",
        items: [
          { id: "g3f2a9c01de", title: "工作", detail: "calendar.google.com · yourname@gmail.com · 2 个事件" },
          { id: "g7b11e40c2a", title: "家里", detail: "calendar.google.com · f***@group.calendar.google.com · 2 个事件" },
        ],
        usages: [
          { usage: "query", on: true },
          { usage: "import", on: true },
        ],
        sensitive: [],
        count: 4,
        lastSync: { at: today("10:00"), trigger: "scheduled", added: 2 },
        syncing: false,
        canSync: true,
        schedule: "每 30 分钟",
        destination: "显示在日历里（只读），不进素材",
        files: [],
        configurable: true,
        disconnectNote: "同步来的 Google 日程不再显示在二狗的日历里；Google 日历那边不动。",
        hasSecrets: true,
        hasStored: true,
        hasLive: true,
      },
      {
        id: "google-contacts",
        title: "Google · 联系人",
        summary: "从 Google 联系人导出的 vCard（.vcf）放进导入文件夹：有生日、纪念日、关系的人和档案里已有的人进档案候选，你逐条确认才写进档案；不进记忆",
        plugin: "google",
        pluginTitle: "Google",
        available: true,
        connection: "manual",
        usages: [{ usage: "import", on: true }],
        sensitive: [],
        count: 4,
        lastSync: { at: today("09:20"), trigger: "file", added: 4, file: "contacts.vcf", summary: "4 人进档案候选；另有 37 人没进候选（没有生日、纪念日、关系，档案里也还没有）" },
        syncing: false,
        canSync: false,
        destination: "进档案候选核对卡（逐条确认才写），不进素材",
        files: ["Google 联系人导出的 vCard（.vcf）"],
        configurable: false,
        disconnectNote: "从 Google 联系人导入、档案候选里还没处理的一起作废，候选核对卡跟着改；已经写进个人档案的不动，Google 联系人那边也不动。",
        hasStored: true,
      },
      {
        id: "looki",
        title: "Looki",
        summary: "挂脖相机每天的时刻（时间、地点、标题和描述）整理成素材；AI 日记只进检索；照片、视频不导入",
        plugin: "looki",
        pluginTitle: "Looki",
        available: true,
        connection: "not_connected",
        usages: [
          { usage: "query", on: true },
          { usage: "import", on: true },
        ],
        sensitive: [
          { id: "location", title: "位置", inferable: false },
          { id: "emotion", title: "情绪", inferable: false },
          { id: "health", title: "健康", inferable: false },
        ],
        count: 0,
        syncing: false,
        canSync: false,
        schedule: "每天 02:30",
        files: [],
        configurable: true,
        panel: lookiArchive(),
        disconnectNote: `存到本地的照片、日记、vlog（${LOOKI_HOME}）不删：那是你自己的档案，要删自己去文件夹里删`,
        toMaterials: true,
        hasStored: true,
        hasLive: true,
      },
      {
        id: "demo-camera",
        title: "示例相机",
        summary: "挂脖相机每天的时刻（时间、地点、在做什么），整理成一段一段的摘要进素材",
        plugin: "demo-camera",
        pluginTitle: "示例相机",
        available: true,
        connection: "connected",
        account: "d***@example.com",
        usages: [
          { usage: "query", on: true },
          { usage: "import", on: true },
        ],
        sensitive: [
          { id: "location", title: "位置", inferable: false },
          { id: "relationship", title: "关系", inferable: false },
        ],
        count: 5,
        lastSync: { at: today("04:00"), trigger: "scheduled", added: 2 },
        syncing: false,
        canSync: true,
        schedule: "每天 04:00",
        files: [],
        configurable: true,
        hasSecrets: true,
        toMaterials: true,
        hasStored: true,
      },
      {
        id: "google-gmail",
        title: "Google · Gmail",
        summary: "用 Gmail 的应用专用密码只读地连邮箱（IMAP）：被问到时现搜、现读邮件，不发信、不删信、不改已读；可以选择导入你发出的邮件",
        plugin: "google",
        pluginTitle: "Google",
        available: true,
        connection: "connected",
        account: "yourname@gmail.com",
        items: [gmailAccount("yourname@gmail.com")],
        usages: [
          { usage: "query", on: true },
          { usage: "import", on: false },
        ],
        sensitive: [
          { id: "finance", title: "财务", inferable: false },
          { id: "health", title: "健康", inferable: false },
        ],
        count: 0,
        syncing: false,
        canSync: false,
        schedule: "每小时",
        destination: "只导入你发出的邮件（本人写的，去掉引用的原文），整理成素材；收到的邮件不导入",
        files: [],
        configurable: true,
        toMaterials: true,
        hasSecrets: true,
        hasStored: true,
        hasLive: true,
      },
      {
        id: "demo-bills",
        title: "示例账单",
        summary: "每月手动导出的账单，放进导入文件夹自动导入",
        plugin: "demo-bills",
        pluginTitle: "示例账单",
        available: true,
        connection: "manual",
        usages: [{ usage: "import", on: true }],
        sensitive: [{ id: "finance", title: "财务", inferable: false }],
        count: 2,
        lastSync: { at: today("09:30"), trigger: "file", added: 2, file: "账单-10月.csv" },
        syncing: false,
        canSync: false,
        files: ["账单（.csv）"],
        configurable: false,
        toMaterials: true,
        hasStored: true,
      },
      {
        id: "phone-contacts",
        title: "手机 · 通讯录选人",
        summary: "在手机上的二狗 App 里从系统通讯录挑人（不读整个通讯录、不要通讯录权限），挑的人的称呼、电话、生日、地址放进档案候选，你逐条确认才写进档案；不进记忆",
        plugin: "phone",
        pluginTitle: "手机",
        available: true,
        connection: "manual",
        usages: [{ usage: "import", on: true }],
        sensitive: [],
        count: 2,
        lastSync: { at: today("09:40"), trigger: "device", added: 2, summary: "2 位联系人：王小明和妈妈" },
        syncing: false,
        canSync: false,
        files: [],
        configurable: false,
        fromDevice: true,
        disconnectNote: "从手机通讯录挑来、档案候选里还没处理的一起作废，候选核对卡跟着改；已经写进个人档案的不动，手机上的通讯录也不动。",
        hasStored: true,
      },
      {
        id: "phone-calendar",
        title: "手机 · 日历",
        summary: "手机上的二狗 App 只读手机日历里的日程，App 开着时每 30 分钟同步一次，放进二狗的日历（标出来自手机）；不进记忆",
        plugin: "phone",
        pluginTitle: "手机",
        available: true,
        connection: "connected",
        account: "HUAWEI Pura 90",
        usages: [{ usage: "import", on: true }],
        sensitive: [],
        count: 3,
        lastSync: { at: today("10:00"), trigger: "device", added: 3, summary: "3 条日程（新 3、改 0、删 0）" },
        syncing: false,
        canSync: false,
        files: [],
        configurable: false,
        fromDevice: true,
        disconnectNote: "断开后，同步来的手机日程不再显示在二狗的日历里，手机上的日历不动；选「连已导入的一起删」，这些日程在二狗这边的记录也删掉。",
        hasStored: true,
      },
      {
        id: "phone-photos",
        title: "手机 · 照片的时间地点",
        summary: "手机上的二狗 App 只读相册里照片的拍摄时间和地点（不传照片本身），App 开着时读最近几天拍的，按天整理成一条摘要（哪个时段拍了几张，地点放场景）进记忆",
        plugin: "phone",
        pluginTitle: "手机",
        available: true,
        connection: "connected",
        account: "HUAWEI Pura 90",
        usages: [{ usage: "import", on: true }],
        sensitive: [{ id: "location", title: "位置", inferable: false }],
        count: 1,
        lastSync: { at: today("10:00"), trigger: "device", added: 1, summary: `读到 23 张照片的时间地点，新的 9 张；整理出 ${daysAgo(1).slice(5)} 的摘要；今天的过完这一天再整理` },
        syncing: false,
        canSync: false,
        files: [],
        configurable: false,
        fromDevice: true,
        toMaterials: true,
        hasStored: true,
        raw: {
          title: "原始的照片时间地点",
          days: [
            { date: daysAgo(0), count: 3, summarized: false },
            { date: daysAgo(1), count: 9, summarized: true },
            { date: daysAgo(3), count: 11, summarized: true },
          ],
        },
      },
      {
        id: "phone-location",
        title: "手机 · 位置",
        summary: "手机上的二狗 App 定时记位置（低功耗定位），App 开着时把记下的点交过来；原始坐标点存在二狗这里、能按天清掉，按天整理成「去过哪、待了多久」一条摘要进记忆",
        plugin: "phone",
        pluginTitle: "手机",
        available: true,
        connection: "connected",
        account: "HUAWEI Pura 90 · App 开着时记",
        panel: phonePlaces(),
        usages: [{ usage: "import", on: true }],
        sensitive: [{ id: "location", title: "位置", inferable: false }],
        count: 2,
        lastSync: { at: today("10:00"), trigger: "device", added: 1, summary: `收到 41 个位置点，新的 41 个；整理出 ${daysAgo(1).slice(5)} 的摘要；今天的过完这一天再整理` },
        syncing: false,
        canSync: false,
        files: [],
        configurable: false,
        fromDevice: true,
        toMaterials: true,
        hasStored: true,
        raw: {
          title: "原始位置点",
          days: [
            { date: daysAgo(0), count: 12, summarized: false },
            { date: daysAgo(1), count: 68, summarized: true },
            { date: daysAgo(2), count: 54, summarized: true },
          ],
        },
      },
    ],
    folder: {
      path: "C:\\Users\\you\\.ergo\\imports",
      importedPath: "C:\\Users\\you\\.ergo\\imports\\imported",
      pending: [{ name: "takeout-2026.zip", size: 1_048_576, problem: "unrecognized", text: "认不出是哪个数据源的文件，留在这里" }],
      recent: [{ name: "账单-10月.csv", source: "demo-bills", sourceTitle: "示例账单", at: today("09:30"), added: 2 }],
      scannedAt: today("10:05"),
    },
  };
}

const later = <T>(value: () => T): Promise<T> => new Promise((resolve) => setTimeout(() => resolve(value()), 300));

/** 这一刻往后 hours 小时（负的是往前） */
const inHours = (hours: number) => nowIso(new Date(Date.now() + hours * 3_600_000));

/** 不进素材的，已获取的（343 号票）：同步来的日程、挑过的人、手机日程，新的在前 */
function storedItems(id: string): DataSourceDataItem[] {
  switch (id) {
    case "google-calendar":
      return [
        { id: "ev-1", title: "季度复盘", subtitle: "工作 · 三楼会议室", time: inHours(30), end: inHours(31), body: "带上上季度的数据。" },
        { id: "ev-2", title: "周会", subtitle: "工作", time: inHours(6), end: inHours(7), labels: ["重复"] },
        { id: "ev-3", title: "带孩子打疫苗", subtitle: "家里 · 社区医院", time: inHours(-20), end: inHours(-19) },
        { id: "ev-4", title: "搬家", subtitle: "家里", time: `${daysAgo(9)}T00:00:00.000+08:00`, allDay: true },
      ];
    case "google-contacts":
      return [
        { id: "c-mom", title: "妈妈", subtitle: "母亲 · 03-02", time: today("09:20") },
        { id: "c-wang", title: "老王", subtitle: "同事 · 138 0000 0000", time: today("09:20") },
        { id: "c-li", title: "李雷", subtitle: "朋友 · 12-08", time: today("09:20") },
        { id: "c-han", title: "韩梅梅", subtitle: "朋友 · 139 0000 0000", time: today("09:20") },
      ];
    case "phone-contacts":
      return [
        { id: "pc-2", title: "妈妈", subtitle: "139 0000 0000 · 03-02", time: today("09:40") },
        { id: "pc-1", title: "王小明", subtitle: "138 0000 0000", time: today("09:40") },
      ];
    case "phone-calendar":
      return [
        { id: "pe-3", title: "牙医复诊", subtitle: "我的日历 · 口腔诊所", time: inHours(50), end: inHours(51) },
        { id: "pe-2", title: "交房租", subtitle: "我的日历", time: inHours(26), end: inHours(26.5) },
        { id: "pe-1", title: "放假", subtitle: "节假日", time: `${daysAgo(2)}T00:00:00.000+08:00`, allDay: true },
      ];
    default:
      return [];
  }
}

/** 编的 Gmail：列表只有发件人、主题、时间 */
const FAKE_MAIL: ReadonlyArray<DataSourceDataItem & { text: string }> = [
  { id: "all-1-105", title: "十月的账单", subtitle: "示例银行 <bill@bank.example.com>", time: inHours(-3), openable: true, labels: ["财务"], text: "您本月的账单已出，应还 1,280.00 元，到期日 11 月 8 日。\n\n这是一封示例邮件。" },
  { id: "all-1-104", title: "周五的会改到下午三点", subtitle: "张三 <zhangsan@example.com>", time: inHours(-9), openable: true, text: "大家好，\n\n周五的会改到下午三点，地点不变。\n\n张三" },
  { id: "all-1-103", title: "机票行程单：11 月 2 日 杭州-北京", subtitle: "示例航空 <noreply@air.example.com>", time: inHours(-28), openable: true, text: "尊敬的旅客：您预订的航班已出票，请提前两小时到达机场。\n\n附件：行程单.pdf" },
  { id: "all-1-102", title: "体检报告已出", subtitle: "示例医院 <report@clinic.example.com>", time: inHours(-52), openable: true, labels: ["健康"], text: "您的体检报告已经出来了，登录网站查看。" },
  { id: "all-1-101", title: "你订阅的周刊", subtitle: "周刊 <weekly@example.com>", time: inHours(-75), openable: true, text: "本周看点：……" },
];

/** 编的 Gmail 现查：开着的账号一个一组（344 号票），都是同一份编的邮件 */
function gmailLive(source: DataSourceView | undefined): Omit<DataSourceLiveResult, "state" | "at"> {
  const on = (source?.items ?? []).filter((item) => !item.off);
  return {
    scope: on.length > 1 ? "每个账号全部邮件里最新的 30 封" : `全部邮件里最新的 ${FAKE_MAIL.length} 封`,
    ...(on.length > 1 ? {} : { total: 1284 }),
    groups: on.map((item) => ({ id: item.id, title: item.title, total: 1284 })),
    items: on.flatMap((item) => FAKE_MAIL.map(({ text: _text, ...mail }) => ({ ...mail, id: `${item.id}.${mail.id}`, group: item.id }))),
  };
}

/** 编的上游，现查回来的（343 号票）；日历有一个没拉到 */
function liveAnswer(id: string, source?: DataSourceView): Omit<DataSourceLiveResult, "state" | "at"> | undefined {
  switch (id) {
    case "google-calendar":
      return {
        scope: "未来 30 天的日程",
        items: [
          { id: "lv-1", title: "周会", subtitle: "工作", time: inHours(6), end: inHours(7) },
          { id: "lv-2", title: "刚加的：和设计师对稿", subtitle: "工作 · 线上", time: inHours(20), end: inHours(21), body: "这一条在 Google 日历里刚加上，还没同步进二狗。" },
          { id: "lv-3", title: "季度复盘", subtitle: "工作 · 三楼会议室", time: inHours(30), end: inHours(31) },
          { id: "lv-4", title: "家庭聚餐", subtitle: "家里", time: inHours(55), end: inHours(57) },
        ],
        notes: ["「家里」这一次没拉到：连不上，过一会儿再试"],
      };
    case "google-gmail":
      return gmailLive(source);
    case "looki":
      return {
        scope: "最近 3 天的时刻（含今天）",
        items: [
          { id: "m-3", title: "上午在公司开会", subtitle: "公司", time: inHours(-2), end: inHours(-1), body: "和同事讨论下季度计划，白板上画了流程图。", labels: ["照片"] },
          { id: "m-2", title: "傍晚沿河边跑步", subtitle: "河边步道", time: inHours(-20), end: inHours(-19), labels: ["照片", "视频"] },
          { id: "m-1", title: "中午吃面", subtitle: "公司楼下", time: inHours(-26), end: inHours(-25.5) },
        ],
      };
    default:
      return undefined;
  }
}

export class FakeDataSources {
  private state: DataSourcesView = initial();

  view(): Promise<DataSourcesView> {
    return Promise.resolve(structuredClone(this.state));
  }

  act(id: string, body: DataSourceActionBody): Promise<DataSourceActionResult> {
    const source = this.state.sources.find((s) => s.id === id);
    if (!source) return Promise.reject(new Error(`没有数据源 ${id}`));
    return later(() => {
      const change = (next: Partial<DataSourceView>) => Object.assign(source, next, { id });
      switch (body.action) {
        case "sync":
          change({ count: source.count + 3, lastSync: { at: nowIso(), trigger: "manual", added: 3 } });
          return { view: structuredClone(this.state), added: 3 };
        case "usage":
          change({ usages: source.usages.map((u) => (u.usage === body.usage ? { ...u, on: body.on } : u)) });
          change({ canSync: source.connection === "connected" && source.usages.some((u) => u.usage === "import" && u.on) });
          return { view: structuredClone(this.state) };
        case "configure": {
          if (id === "looki") return body.values.archive === undefined ? this.configureLooki(source, body.values) : this.archiveLooki(source, body.values);
          if (id === "phone-location") return this.phonePlaces(source, body.values);
          if (id === "google-gmail") return this.configureGmail(source, body.values);
          change({ connection: "connected", account: id.startsWith("google-") ? "yourname@gmail.com" : "y***@example.com", hasSecrets: true, canSync: source.usages.some((u) => u.usage === "import" && u.on) });
          return { view: structuredClone(this.state) };
        }
        case "clear_raw": {
          const gone = (source.raw?.days ?? []).filter((d) => body.dates.includes(d.date));
          if (source.raw) source.raw.days = source.raw.days.filter((d) => !body.dates.includes(d.date));
          return { view: structuredClone(this.state), cleared: gone.reduce((n, d) => n + d.count, 0) };
        }
        case "open":
          return { view: structuredClone(this.state), opened: false, error: "打不开：原型里打不开电脑上的文件夹" };
        case "disconnect": {
          if (body.item !== undefined) return this.disconnectGmailAccount(source, body.item, body.purge);
          const manual = source.connection === "manual";
          const purged = body.purge ? { events: source.count, materials: source.count, files: manual ? 1 : 0 } : undefined;
          delete source.lastSync;
          delete source.problem;
          delete source.account;
          delete source.items;
          delete source.hasSecrets;
          if (body.purge && source.raw) source.raw.days = [];
          if (body.purge && id === "phone-location") source.panel = { ...phonePlaces(), places: [], suggestions: [], days: 0 };
          change({ connection: manual ? "manual" : "not_connected", canSync: false, count: body.purge ? 0 : source.count });
          return { view: structuredClone(this.state), ...(purged ? { purged } : {}) };
        }
      }
    });
  }

  /** Gmail（344 号票）：加一个账号（密码写 bad 回"不认"，已有的不动）、换密码、开关一个；什么都不填是再测一次；已有的账号密码写 revoked 看"登录不再通过"那一行的样子 */
  private configureGmail(source: DataSourceView, values: Readonly<Record<string, string>>): DataSourceActionResult {
    const items = [...(source.items ?? [])];
    const settle = (next: DataSourceItemView[]) => {
      const on = next.filter((item) => !item.off);
      delete source.problem;
      if (!next.some((item) => item.problem !== undefined)) delete source.needsAuth;
      Object.assign(source, { items: next, account: next.map((item) => item.title).join("、"), connection: on.length > 0 ? "connected" : "not_connected", hasSecrets: true, canSync: on.length > 0 && source.usages.some((u) => u.usage === "import" && u.on) });
    };
    if (values.account !== undefined) {
      settle(items.map((item) => (item.id === values.account ? gmailAccount(item.title, values.enabled === "off") : item)));
      return { view: structuredClone(this.state) };
    }
    const address = values.address?.trim() ?? "";
    if (address === "" && !values.password) return { view: structuredClone(this.state) };
    if (values.password === "revoked") {
      Object.assign(source, { needsAuth: true });
      settle(items.map((item) => (item.title.toLowerCase() === address.toLowerCase() ? { ...item, detail: "要重新填密码 · 已导入 0 封", problem: "登录 Gmail 没通过：邮箱地址或应用专用密码不对。改过 Google 账号密码的话，旧的应用专用密码都会失效，要重新生成一个" } : item)));
      return { view: structuredClone(this.state) };
    }
    if (values.password === "bad" || address === "") {
      Object.assign(source, { problem: address === "" ? "先填 Gmail 地址" : "登录 Gmail 没通过：邮箱地址或应用专用密码不对。要填应用专用密码（16 位字母），不是 Google 账号的密码" });
      return { view: structuredClone(this.state) };
    }
    settle(items.some((item) => item.title.toLowerCase() === address.toLowerCase()) ? items.map((item) => (item.title.toLowerCase() === address.toLowerCase() ? gmailAccount(item.title, item.off === true) : item)) : [...items, gmailAccount(address)]);
    return { view: structuredClone(this.state) };
  }

  /** 断开一个 Gmail 账号（344 号票）：别的账号不动，最后一个断开就是没连 */
  private disconnectGmailAccount(source: DataSourceView, item: string, purge: boolean): DataSourceActionResult {
    const next = (source.items ?? []).filter((one) => one.id !== item);
    const on = next.filter((one) => !one.off);
    if (next.length === 0) {
      delete source.account;
      delete source.items;
      delete source.hasSecrets;
    } else Object.assign(source, { items: next, account: next.map((one) => one.title).join("、") });
    delete source.problem;
    Object.assign(source, { connection: on.length > 0 ? "connected" : "not_connected", canSync: on.length > 0 && source.usages.some((u) => u.usage === "import" && u.on) });
    return { view: structuredClone(this.state), ...(purge ? { purged: { events: 0, materials: 0, files: 0 } } : {}) };
  }

  /** Looki 的测试连接（296 号票）：Key 写 bad 回"不认"（原来连着的还在用原来的）；区域不填沿用账号那一行写着的（编的数据） */
  private configureLooki(source: DataSourceView, values: Readonly<Record<string, string>>): DataSourceActionResult {
    const key = values.key ?? "";
    const refused = "Looki 不认这个 Key：看看有没有复制全、区域选得对不对（中国区和海外的 Key 不通用）";
    if (key === "bad" && source.connection === "connected") {
      Object.assign(source, { problem: `新填的没通过（${refused}），还在用原来的 Key` });
      return { view: structuredClone(this.state) };
    }
    if (key === "bad" || (key === "" && source.account === undefined)) {
      Object.assign(source, { connection: "error", problem: key === "" ? "先填 API Key（Looki 网页版 → API 密钥里建的，lk- 开头）" : refused });
      return { view: structuredClone(this.state) };
    }
    const region = values.region ?? (source.account?.includes("海外") ? "global" : "cn");
    delete source.problem;
    Object.assign(source, { connection: "connected", account: `d***@example.com（${region === "global" ? "海外" : "中国区"}）`, hasSecrets: true, canSync: source.usages.some((u) => u.usage === "import" && u.on) });
    // 编一份已经存下的（像同步过几天）
    const archive = source.panel as LookiArchiveView;
    if (archive.saved.photos === 0) {
      Object.assign(archive, { saved: { photos: 1286, clips: 0, journals: 9, vlogs: 9, bytes: 3_412_000_000, days: 9 }, lastSavedAt: today("02:41"), pending: 2 });
      Object.assign(source, { count: 214, lastSync: { at: today("02:30"), trigger: "scheduled", added: 31 } });
    }
    return { view: structuredClone(this.state) };
  }

  /** Looki 的"存一份到本地"（307 号票）：改设置、补存、停下、接着补、现在接着存（编的，只改内存里的样子） */
  private archiveLooki(source: DataSourceView, values: Readonly<Record<string, string>>): DataSourceActionResult {
    const a = source.panel as LookiArchiveView;
    delete a.refused;
    const connected = source.connection === "connected";
    switch (values.archive) {
      case "settings": {
        if (values.on !== undefined) a.on = values.on === "true";
        for (const k of LOOKI_ARCHIVE_KINDS) if (values[k] !== undefined) a.kinds[k] = values[k] === "true";
        if (values.folder !== undefined) {
          const typed = values.folder.trim();
          if (typed === "") a.folder = a.defaultFolder;
          else if (!/^[A-Za-z]:[\\/]/.test(typed)) a.refused = "位置要写完整的路径，比如 D:\\Looki";
          else a.folder = typed;
        }
        break;
      }
      case "backfill": {
        if (!connected) a.refused = "先连上 Looki（上面填好 API Key）";
        else {
          const from = values.from ?? "";
          const to = values.to ?? "";
          const total = Math.max(1, Math.round((Date.parse(to) - Date.parse(from)) / 86_400_000) + 1);
          a.backfill = { from, to, next: to, doneDays: 3, totalDays: total, state: "running", files: 412 };
          a.working = { kind: "backfill", day: to };
        }
        break;
      }
      case "stop":
        if (a.backfill) a.backfill.state = "stopped";
        delete a.working;
        break;
      case "resume":
        if (a.backfill) a.backfill.state = "running";
        break;
      case "retry":
        delete a.problem;
        a.pending = 0;
        a.failed = 0;
        break;
    }
    return { view: structuredClone(this.state) };
  }

  /** 常去的地方（308 号票）：起名、改名、删、加一处只改内存里的样子 */
  private phonePlaces(source: DataSourceView, values: Readonly<Record<string, string>>): DataSourceActionResult {
    const view = source.panel as PhonePlacesView;
    delete view.refused;
    const name = (values.name ?? "").trim();
    const taken = (self?: string) => view.places.some((p) => p.id !== self && p.name === name);
    switch (values.places) {
      case "add": {
        if (name === "") view.refused = "名字不能空着";
        else if (taken()) view.refused = `已经有一处叫「${name}」了`;
        else {
          const lat = Number(values.lat);
          const lon = Number(values.lon);
          const suggestion = view.suggestions.find((s) => s.lat === lat && s.lon === lon);
          view.places.push({ id: `place-${Date.now().toString(36)}`, name, lat, lon, radius: Number(values.radius ?? 200), ...(values.address ? { address: values.address } : {}), visits: suggestion?.visits ?? 0 });
          if (suggestion) view.suggestions = view.suggestions.filter((s) => s !== suggestion);
        }
        break;
      }
      case "rename": {
        const place = view.places.find((p) => p.id === values.id);
        if (!place) view.refused = "没有这一处（可能已经删了）";
        else if (name === "") view.refused = "名字不能空着";
        else if (taken(place.id)) view.refused = `已经有一处叫「${name}」了`;
        else Object.assign(place, { name, radius: Number(values.radius ?? place.radius) });
        break;
      }
      case "remove":
        view.places = view.places.filter((p) => p.id !== values.id);
        break;
    }
    return { view: structuredClone(this.state) };
  }

  /** 设备交来的（299 号票）：原型里不在 App 里交不过来，只记一句 */
  push(id: string, body: DataSourcePushBody): Promise<DataSourcePushResult> {
    const source = this.state.sources.find((s) => s.id === id);
    if (!source) return Promise.reject(new Error(`没有数据源 ${id}`));
    const contacts = (body.data as { contacts?: Array<{ name: string }> }).contacts;
    return later(() => {
      const summary = contacts ? `${contacts.length} 位联系人：${contacts.map((c) => c.name).join("、")}` : "同步好了";
      Object.assign(source, { lastSync: { at: nowIso(), trigger: "device", added: contacts?.length ?? 0, summary } });
      return { view: structuredClone(this.state), added: contacts?.length ?? 0, summary, ...(contacts ? { reply: { names: contacts.map((c) => c.name) } } : {}) };
    });
  }

  /** 已获取的（343 号票）：进素材的按素材的出处列（和守护进程一样），不进素材的是编的；Gmail 没导入过 */
  stored(id: string, body: DataSourceStoredBody, deleted: ReadonlySet<string>): Promise<DataSourceStoredPage> {
    const source = this.state.sources.find((s) => s.id === id);
    if (!source) return Promise.reject(new Error(`没有数据源 ${id}`));
    const offset = body.offset ?? 0;
    const limit = body.limit ?? DATA_SOURCE_STORED_PAGE;
    return later(() => {
      const found: DataSourceDataItem[] = source.toMaterials
        ? fakeMaterialsIn(undefined, deleted, { dataSource: id }).map((m) => ({ id: m.id, title: m.excerpt, subtitle: m.kind, time: m.time, materialId: m.id }))
        : storedItems(id);
      // 断开时连已导入的一起删了：没有了
      const kept = source.count === 0 ? [] : found;
      return { total: kept.length, items: kept.slice(offset, offset + limit) };
    });
  }

  /** 现在能查到的（343 号票）：编的上游，只读、什么都不改；没连着的写明 */
  live(id: string, body: DataSourceLiveBody): Promise<DataSourceLiveResult> {
    const source = this.state.sources.find((s) => s.id === id);
    if (!source) return Promise.reject(new Error(`没有数据源 ${id}`));
    if (!source.hasLive) return Promise.reject(new Error(`${source.title}不能现查`));
    return later(() => {
      const at = nowIso();
      if (source.connection === "not_connected") return { state: "not_connected", at, items: [], problem: `${source.title}还没连上` };
      if (body.open !== undefined) {
        const mail = FAKE_MAIL.find((m) => body.open?.endsWith(m.id));
        if (!mail) return { state: "error", at, items: [], problem: "没有这封邮件（可能已经删了或者挪走了）" };
        const { text, openable: _openable, ...item } = mail;
        return { state: "ok", at, items: [{ ...item, body: text }] };
      }
      return { state: "ok", at, ...(liveAnswer(id, source) ?? { items: [] }) };
    });
  }

  folder(body: ImportFolderActionBody): Promise<ImportFolderActionResult> {
    return later(() => {
      if (body.action === "open") return { view: structuredClone(this.state), opened: false, error: "原型里打不开电脑上的文件夹" };
      this.state.folder.scannedAt = nowIso();
      return { view: structuredClone(this.state) };
    });
  }
}
