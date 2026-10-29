// 数据源（295 号票，issue 25 生活数据源）：外面的数据（挂脖相机、日历、邮件、账单……）经"数据源插件"接进来。每种数据源一个插件，
// 插件在数据契约里登记它的数据源（守护进程 data-sources/），设置里一页"数据源"一处列出全部（GET /api/data-sources，DataSourcesView）：
// 名字、连接状态、上次同步时间和条数、立即同步、断开（留着已导入的 / 连已导入的一起彻底删除）、用到的敏感类别、两种用法各开没开
// （按需查：秘书被问到时现查，不存；导入：同步、整理成摘要进素材或交给别的插件）。数据源只产素材、不产结论（理解仍由记忆管理员做）。
// 另有一个共用的"导入文件夹"（数据目录下）：手动导出的文件放进去，二狗按数据源插件登记的"认哪种文件"交给对应的插件导入，
// 导完挪到"已导入"，认不出的留在原地、在数据源页提示。请求体见 data-sources-schema.ts。不引用 TypeBox。
// 299 号票加了"设备交来的"（trigger device：手机上的二狗 App 读本机的通讯录、日历，经网页 POST /api/data-sources/<id>/push 交来）、
// 每次同步"进来的是什么"那一句（summary，数据源写）。
// 300 号票加了"原始数据"（raw：插件自己存储里的、不进素材的原始数据——手机位置的原始坐标点、照片的时间地点——按天列出、能按天清掉）。

/** 两种用法：按需查（给秘书工具，现查不存）、导入（同步进来：进素材或者交给别的插件） */
export const DATA_SOURCE_USAGES = ["query", "import"] as const;
export type DataSourceUsage = (typeof DATA_SOURCE_USAGES)[number];

/**
 * 连接状态：没连、连着、出错（带原因）；manual 是没有"连接"这回事的数据源（只靠导入文件夹，手动导出的账单、vCard……）
 */
export const DATA_SOURCE_CONNECTIONS = ["not_connected", "connected", "error", "manual"] as const;
export type DataSourceConnection = (typeof DATA_SOURCE_CONNECTIONS)[number];

/** 一次同步从哪来：点了"立即同步"、定期导入到点了、导入文件夹里的一个文件、设备交来的（299 号票：手机上的二狗 App） */
export const DATA_SOURCE_SYNC_TRIGGERS = ["manual", "scheduled", "file", "device"] as const;
export type DataSourceSyncTrigger = (typeof DATA_SOURCE_SYNC_TRIGGERS)[number];

/** 数据源用到的一类敏感内容（对上记忆的敏感类别开关：默认只记录、不用于推断） */
export interface DataSourceSensitiveView {
  /** 敏感类别（health、finance、location、relationship……，记忆配置 memory.sensitiveCategories 里写的） */
  id: string;
  /** 给人看的名字（守护进程按当前语言写） */
  title: string;
  /** 记忆那边这一类打开了"用来推断"没有（默认没有：只记录、检索得到） */
  inferable: boolean;
}

/** 一次同步（或导入一个文件）的结果 */
export interface DataSourceSyncView {
  /** 什么时候（带时区偏移的 ISO 时间） */
  at: string;
  trigger: DataSourceSyncTrigger;
  /** 新进来几条（出错的没有） */
  added?: number;
  /** 出错的原因（给人看的；密钥在里面的已经换掉） */
  error?: string;
  /** 导入的文件名（trigger 是 file 的） */
  file?: string;
  /** 这次进来的是什么（给人看的一句，数据源按当前语言写："2 位联系人：王小明、妈妈"；299 号票） */
  summary?: string;
}

/** 一种用法和它开没开 */
export interface DataSourceUsageView {
  usage: DataSourceUsage;
  on: boolean;
}

/** 数据源下面的一样（297 号票：Google 日历订阅的几个日历）：名字、一句说明（打了码的地址）、它自己出的错 */
export interface DataSourceItemView {
  /** 插件自己认的 id（插件画的设置那一块按它删掉这一样） */
  id: string;
  title: string;
  detail?: string;
  problem?: string;
}

/** 设置 · 数据源里的一个数据源：给人看的字都按守护进程当前的语言写好 */
export interface DataSourceView {
  /** 数据源的 id（小写英文、数字和连字符，插件登记的，定了不改） */
  id: string;
  title: string;
  /** 一句话说它是什么、进来什么 */
  summary: string;
  /** 登记它的插件（插件名）和插件给人看的名字（同一个插件的几个数据源在页面上排在一起） */
  plugin: string;
  pluginTitle: string;
  /** 插件在运行没有：没在运行时不能同步、按需查，unavailable 写明"X插件没启用" */
  available: boolean;
  unavailable?: string;
  connection: DataSourceConnection;
  /** 出错的原因（connection 是 error 的） */
  problem?: string;
  /** 连的是哪个账号（插件给的、给人看的，比如打了码的邮箱；没有就不写） */
  account?: string;
  /** 一句提示、不算出错（297 号票："日历插件没启用：同步来的事件现在在日历里看不到"） */
  note?: string;
  /** 它下面的几样（297 号票：订阅的几个日历）；插件没在运行、没有的不写 */
  items?: DataSourceItemView[];
  /** 它提供的用法和各开没开（没提供的不在里面） */
  usages: DataSourceUsageView[];
  /** 用到的敏感类别 */
  sensitive: DataSourceSensitiveView[];
  /** 现在已经导入了几条（它拥有的、还没删掉的记录） */
  count: number;
  /** 上次同步（断开之后从头算；还没同步过没有） */
  lastSync?: DataSourceSyncView;
  /** 正在同步 */
  syncing: boolean;
  /** 现在能"立即同步"：插件在运行、导入开着、连着（或者不用连） */
  canSync: boolean;
  /** 出错了、内核每小时自动替它再试一次（306 号票：页面上写明"每小时自动再试一次，也可以重新填"）；不是的不写 */
  autoRetry?: true;
  /** 定期导入的时间（给人看的，"每天 04:00"、"每 30 分钟"）；不定期的没有 */
  schedule?: string;
  /** 导入的东西去哪（给人看的，297 号票："显示在日历里，不进素材"）；不写是整理成素材 */
  destination?: string;
  /** 它认导入文件夹里哪种文件（给人看的，"vCard 联系人（.vcf）"） */
  files: string[];
  /** 能在这一页填设置（API Key、地址……）、测试连接：网页插件在 dataSources 插槽里画那一块 */
  configurable: boolean;
  /** 数据由设备交来（299 号票：手机上的二狗 App 读本机交过来，导入这种用法的说法跟着变）；不是的没有 */
  fromDevice?: true;
  /**
   * 插件画的设置那一块要的数据（307 号票：Looki 的"存一份到本地"——位置、存哪几类、已存多少、补存进度，样子见 looki.ts）。
   * 核心不看、原样交给那一块；插件没在运行、没有的不写
   */
  panel?: unknown;
  /**
   * 断开时要说一句的（307 号票："存到本地的照片、日记、vlog 不删……"），断开的确认框里写；没有不写。
   * 306 号票起没有密钥、不进素材的数据源（手机日历、通讯录、Google 联系人）用它说实际会删什么（外部日程、没处理的档案候选）
   */
  disconnectNote?: string;
  /** 这台电脑的密钥区里有它填过的（API Key、密码、私密地址），断开时删掉（306 号票：确认框才说"填过的密钥从这台电脑上删掉"）；没有不写 */
  hasSecrets?: true;
  /** 它导入的记录会整理成素材（它的记录登记了素材来源；306 号票：确认框才说"素材照样在""由它们整理出的素材"）；不进素材的不写 */
  toMaterials?: true;
  /** 插件自己存储里的原始数据（300 号票）：按天列出、能按天清掉；没有这回事的、插件没在运行的没有 */
  raw?: DataSourceRawView;
}

/** 原始数据里的一天 */
export interface DataSourceRawDay {
  /** 哪一天（本地日期 YYYY-MM-DD） */
  date: string;
  /** 这一天有几条（几个位置点、几张照片） */
  count: number;
  /** 这一天整理成摘要了没有（还没整理的清掉了就不会再有这一天的摘要） */
  summarized: boolean;
}

/** 插件自己存储里的原始数据（300 号票：只在二狗的数据目录里、不进素材；整理成摘要的那一份在素材里） */
export interface DataSourceRawView {
  /** 给人看的：这是什么（"原始位置点"） */
  title: string;
  /** 有哪几天（新的在前） */
  days: DataSourceRawDay[];
}

/** 导入文件夹里没导入的文件为什么没导入 */
export const IMPORT_FILE_PROBLEMS = ["unrecognized", "ambiguous", "plugin_off", "import_off", "failed", "busy"] as const;
export type ImportFileProblem = (typeof IMPORT_FILE_PROBLEMS)[number];

/** 导入文件夹里留着的一个文件和原因 */
export interface ImportFileHint {
  name: string;
  size: number;
  problem: ImportFileProblem;
  /** 给人看的一句（守护进程按当前语言写；导入出错的带原因） */
  text: string;
}

/** 最近导入的一个文件 */
export interface ImportedFileView {
  name: string;
  source: string;
  sourceTitle: string;
  at: string;
  added: number;
}

/** 共用的导入文件夹 */
export interface ImportFolderView {
  /** 文件夹在电脑上的路径（放文件进去的地方） */
  path: string;
  /** 导完挪到哪（"已导入"） */
  importedPath: string;
  /** 留在文件夹里没导入的（认不出、几个数据源都认、插件没启用、导入关着、出错了、还在写） */
  pending: ImportFileHint[];
  /** 最近导入的（新的在前，最多 IMPORTED_SHOWN 个） */
  recent: ImportedFileView[];
  /** 上次看文件夹是什么时候（还没看过没有） */
  scannedAt?: string;
}

/** 最近导入的文件最多列几个 */
export const IMPORTED_SHOWN = 10;

/** GET /api/data-sources：全部数据源（按插件清单的先后、同一个插件按登记的先后）和导入文件夹 */
export interface DataSourcesView {
  sources: DataSourceView[];
  folder: ImportFolderView;
}

/**
 * 对一个数据源做的事：立即同步、断开、开关一种用法、填设置（测试连接）、清掉几天的原始数据（300 号票）、在电脑上打开它的文件夹
 * （307 号票：Looki 存到本地的位置，和导入文件夹的"在电脑上打开"同一个做法）
 */
export const DATA_SOURCE_ACTIONS = ["sync", "disconnect", "usage", "configure", "clear_raw", "open"] as const;
export type DataSourceAction = (typeof DATA_SOURCE_ACTIONS)[number];

/** 断开时连已导入的一起删了几条 */
export interface DataSourcePurgeCounts {
  /** 它导入的记录（整条换成"已删除"标记），连同同步记录 */
  events: number;
  /** 由这些记录采成的素材（彻底删除：素材、索引、原文副本） */
  materials: number;
  /** "已导入"里它的文件 */
  files: number;
}

/** POST /api/data-sources/<id> 的结果：做完之后的整页，连同这一下的结果 */
export interface DataSourceActionResult {
  view: DataSourcesView;
  /** 立即同步：新进来几条（还在同步的没有，view 里 syncing 是真） */
  added?: number;
  /** 立即同步出错的原因；在电脑上打开没打开的原因（307 号票） */
  error?: string;
  /** 断开并连已导入的一起删：删了几条 */
  purged?: DataSourcePurgeCounts;
  /** 清掉原始数据（300 号票）：清掉了几条 */
  cleared?: number;
  /** 在电脑上打开它的文件夹（307 号票）：打开了没有（没打开的原因在 error） */
  opened?: boolean;
}

/**
 * POST /api/data-sources/<id>/push 的结果（299 号票：设备交来的，手机上的二狗 App 读本机的通讯录、日历）：做完之后的整页、
 * 新进来几条、这次进来的是什么（给人看的一句）、数据源交回的（各数据源自己的样子，比如通讯录选人交回候选核对卡的编号）；
 * 出错的带原因（拒收的回 400，不在这里）
 */
export interface DataSourcePushResult {
  view: DataSourcesView;
  added?: number;
  summary?: string;
  reply?: unknown;
  error?: string;
}

/** 对导入文件夹做的事：现在看一遍（认不出的、出错的也再试一次）、在电脑上打开 */
export const IMPORT_FOLDER_ACTIONS = ["scan", "open"] as const;
export type ImportFolderAction = (typeof IMPORT_FOLDER_ACTIONS)[number];

/** POST /api/import-folder 的结果 */
export interface ImportFolderActionResult {
  view: DataSourcesView;
  /** 在电脑上打开了没有（没打开的带原因） */
  opened?: boolean;
  error?: string;
}
