// 数据源的统一外形（295 号票，issue 25；ADR-0027 的"数据源"贡献点）：插件写数据源时用的类型。
// 每种外部数据（挂脖相机、Google、手机、账单……）一个插件，插件在数据契约里 ctx.dataSources.register(数据源)：
// - 静态的：id、名字、一句话、用到的敏感类别、提供哪两种用法（按需查 / 导入）和默认开没开、定期导入的时间、它拥有的记录（事件）、
//   认导入文件夹里哪种文件——插件停用、没装上也认得（设置 · 数据源照样列出、写"X插件没启用"；断开并删照样删得掉、条数照样数得出）；
// - 要插件在运行才能做的（连接状态、填设置、同步、导入一个文件、断开时插件自己的清理、按需查的工具）写成函数，里面经 ctx.active
//   现取插件自己的服务（和运行时贡献点一样，见手册第 7 节）。内核只在插件在运行时叫它们。
// 规矩（issue 25 第 2、4 节）：数据源只产素材、不产结论——插件写自己的事件、经 ctx.materialSources.register 变成素材（ADR-0006；
// 303 号票起采集规则里用 material.ts 的 dataSourceMaterial 写成观察到的本人行为 / 别人写给你的 / 本人写的三种之一，带场景和敏感类别），
// 不碰推理图谱、不直接写个人档案；量大的（照片、位置点、心率）先整理成一段一段的摘要再写事件，原始数据留在来源那边或插件自己的存储里。
// 密钥（API Key、应用专用密码、私密地址）只经 ctx.secrets 存进数据目录的密钥区（data-sources/secrets.ts），不进仓库、日志、事件；
// 同步、导入出错的原因里要是带着密钥，内核记下之前换成 ***。
// 299 号票加了三样（"手机"插件用，别的设备上的数据源、外部日历同样能用）：
// - push：设备交来的（手机上的二狗 App 读本机的通讯录、日历，经网页 POST /api/data-sources/<id>/push）——内核按 schema 查、
//   记同步记录（trigger device），数据源写自己的记录；
// - calendar：交给日历插件显示的日程（外部日历：只读、不进素材），日历按月取时经内核现取；
// - count：数据源页的"共几条"由数据源自己数（记录是增量的，按记录条数数不对时）；同步结果多了一句 summary（这次进来的是什么）。
// 300 号票加了 raw：插件自己存储里的原始数据（手机位置的原始坐标点、照片的时间地点），数据源页按天列出、能按天清掉。
// 297 号票（Google 日历订阅）又加了几样：定期导入可以每隔几分钟（DataSourceSchedule）、导入的东西去哪（destination）、
// 连上以后马上同步一次（syncOnConnect）、连接状态带一句提示（note）和下面的几样（items：几个日历）。
// 307 号票（Looki 存一份到本地）：连接状态带插件那一块要的数据（panel）、断开时要说的一句（disconnectNote），
// 数据源可以有一个本机的文件夹（localFolder），数据源页上"在电脑上打开"它。
// 306 号票：按需查的工具只在连着时给秘书（连接状态用 status() 报的最近一次已知的，所以 status 要快、不连网，插件在同步、按需查时
// 碰到 Key 失效记在内存里、下一次 status 报出错）；数据源自己也能登记断开时要说的一句（disconnectNote，没有连接状态的数据源用）。
import type { CalendarExternalEntry, ReminderSchedule, TSchema } from "@ergo/protocol";
import type { HostTool } from "../agent-manager/host-tools.ts";
import type { SensitiveCategory } from "../config/config.ts";
import type { IntervalSchedule } from "../scheduler/internal-jobs.ts";

/**
 * 定期导入的时间：提醒那一套（每天 04:00、每周……），或者每隔几分钟（297 号票：Google 日历每 30 分钟拉一次，`{ kind: "every", minutes: 30 }`；
 * 每小时写 60）。每隔几分钟的从上一次同步往后数，守护进程停着时错过了，开机补一次
 */
export type DataSourceSchedule = ReminderSchedule | IntervalSchedule;

/** 一个数据源在密钥区里的那一格：名字 → 值（API Key、密码、私密地址……）。只有这个数据源自己的 */
export interface DataSourceSecrets {
  get(name: string): string | undefined;
  /** 存一项（马上写进密钥区） */
  set(name: string, value: string): void;
  delete(name: string): void;
  has(name: string): boolean;
}

/** 内核叫数据源的函数时交给它的 */
export interface DataSourceContext {
  /** 这个数据源在密钥区里的那一格 */
  readonly secrets: DataSourceSecrets;
  /** 写日志（给开发者看的；别把密钥写进去） */
  log(line: string): void;
}

/** 数据源下面的一样（297 号票：Google 日历订阅的几个日历）：给人看的名字、一句说明（打了码的地址）、它自己出的错 */
export interface DataSourceItem {
  /** 插件自己认的 id（网页插件在设置那一块里按它删掉这一样） */
  id: string;
  title: string;
  detail?: string;
  problem?: string;
}

/**
 * 连接状态（数据源报的）：没连、连着、出错（原因给人看）；account 是连的哪个账号（给人看的，打码的邮箱之类，可以不给）。
 * note 是一句提示、不算出错（297 号票："日历插件没启用：同步来的事件现在在日历里看不到"）；items 是它下面的几样（几个日历）
 */
export interface DataSourceStatus {
  connection: "not_connected" | "connected" | "error";
  problem?: string;
  account?: string;
  note?: string;
  items?: readonly DataSourceItem[];
  /** 插件画的设置那一块要的数据（307 号票：Looki 的"存一份到本地"），内核原样交给网页（DataSourceView.panel），不看里面 */
  panel?: unknown;
  /** 断开时要说一句的（307 号票：Looki 存到本地的文件不删），断开的确认框里写 */
  disconnectNote?: string;
}

/** 一次同步：为什么同步（点了"立即同步"、定期导入到点了）、上次成功同步是什么时候、中止信号（断开、插件停用、守护进程停时置位） */
export interface DataSourceSyncContext extends DataSourceContext {
  readonly trigger: "manual" | "scheduled";
  readonly lastSyncAt: string | undefined;
  readonly signal: AbortSignal;
}

/** 出错后再试时交给数据源的（306 号票）：中止信号（守护进程停时置位） */
export interface DataSourceRecheckContext extends DataSourceContext {
  readonly signal: AbortSignal;
}

/** 同步、导入一个文件的结果：新进来几条（写进了几条它拥有的记录）；summary 是这次进来的是什么（给人看的一句，走 t()） */
export interface DataSourceSyncResult {
  added: number;
  summary?: string;
}

/** 设备交来时交给数据源的（299 号票） */
export type DataSourcePushContext = DataSourceContext;

/** 设备交来的收下了：新进来几条、这次进来的是什么，reply 原样交回设备（各数据源自己的样子） */
export interface DataSourcePushOutcome extends DataSourceSyncResult {
  reply?: unknown;
}

/**
 * 设备交来的（299 号票）：body 是 data 的 schema（内核先按它查，不对回 400）；receive 写这个数据源拥有的记录。
 * 不收（比如没连着）抛 RequestRejected（回 400，不记同步记录）；别的错记进同步记录
 */
export interface DataSourcePush {
  readonly body: TSchema;
  receive(data: unknown, ctx: DataSourcePushContext): DataSourcePushOutcome | Promise<DataSourcePushOutcome>;
}

/** 交给日历插件显示的一条日程（外部日历；299 号票）：数据源和它的名字由内核补上 */
export type DataSourceCalendarEvent = Omit<CalendarExternalEntry, "source" | "sourceTitle">;

/** 导入文件夹里交给数据源的一个文件（已经挪进"已导入"，导入出错时内核挪回去） */
export interface ImportFile {
  /** 现在的完整路径 */
  readonly path: string;
  /** 用户放进来时的文件名 */
  readonly name: string;
  readonly size: number;
}

/** 导入一个文件时交给数据源的 */
export interface DataSourceImportContext extends DataSourceContext {
  readonly signal: AbortSignal;
}

/**
 * 数据源认的一种文件：扩展名、文件名、内容特征（开头一段）至少写一样，写了的都要对上才算认得。
 * 几个数据源都认得同一个文件时谁都不交，留在原地提示（用内容特征分开）
 */
export interface DataSourceFileType {
  /** 给人看的：这是什么文件（"vCard 联系人（.vcf）"），写成取值函数走 t() */
  readonly title: string;
  /** 扩展名（带点、小写，".vcf"） */
  readonly extensions?: readonly string[];
  /** 文件名 */
  readonly names?: RegExp;
  /** 内容特征：文件开头最多 4 KB */
  sniff?(head: Buffer, name: string): boolean;
  /** 导入：读文件、写这个数据源拥有的记录，交回新进来几条；抛错的留在导入文件夹、提示原因 */
  import(file: ImportFile, ctx: DataSourceImportContext): Promise<DataSourceSyncResult>;
}

/** 原始数据里的一天（300 号票）：哪一天（本地日期 YYYY-MM-DD）、几条、整理成摘要了没有 */
export interface DataSourceRawDay {
  readonly date: string;
  readonly count: number;
  readonly summarized: boolean;
}

/**
 * 插件自己存储里的原始数据（300 号票：手机位置的原始坐标点、照片的时间地点）：不在 records 里、不进素材（进素材的是整理好的摘要），
 * 数据源页按天列出、能按天清掉。断开并连已导入的一起删时由插件的 disconnect（purge）删
 */
export interface DataSourceRaw {
  /** 给人看的：这是什么（"原始位置点"），写成取值函数走 t() */
  readonly title: string;
  /** 有哪几天（新的在前）；插件在运行时打开数据源页才叫，要快 */
  days(ctx: DataSourceContext): readonly DataSourceRawDay[];
  /** 清掉这几天的，交回清掉了几条 */
  clear(dates: readonly string[], ctx: DataSourceContext): number;
}

/** 数据源拥有的一类记录（事件）：不写频道是所有频道里的这一类 */
export interface DataSourceRecords {
  readonly channel?: string;
  readonly type: string;
}

/** 一个数据源（插件在数据契约里登记） */
export interface DataSource {
  /** 小写英文、数字和连字符（"looki"、"google-calendar"），定了别改：用法开关、密钥区、同步记录都按它记 */
  readonly id: string;
  /** 给人看的名字（"Looki"、"Google · 日历"），写成取值函数走 t() */
  readonly title: string;
  /** 一句话：它是什么、进来什么 */
  readonly summary?: string;
  /**
   * 用到的敏感类别（健康、财务、位置、关系……）：对上记忆的敏感类别开关，页面上写明这几类默认只记录、不用于推断。
   * 303 号票：dataSourceMaterial 写的素材不写 sensitive 就带上这里的全部（保守），插件按记录写窄
   */
  readonly sensitive?: readonly SensitiveCategory[];
  /**
   * 提供哪两种用法、默认开没开：按需查（给秘书 tools，现查不存）、导入（sync 和 files；schedule 是定期导入的时间，不写就只在
   * 点"立即同步"、放文件时导入）。用户在数据源页上开关，存在配置区的 data-sources.json
   */
  readonly usages: {
    readonly query?: { readonly default: boolean };
    readonly import?: {
      readonly default: boolean;
      readonly schedule?: DataSourceSchedule;
      /**
       * 导入的东西去哪（给人看的，取值函数走 t()；297 号票："显示在日历里，不进素材"）。不写是"整理成素材"——数据源只产素材是默认，
       * 有的数据该直接给别的插件（issue 25 第 3 节：Google 日历的事件给日历插件）
       */
      readonly destination?: string;
      /** 填好设置、连上以后马上同步一次（导入开着时；297 号票：填了日历地址就该看到事件，不等下一次定期导入） */
      readonly syncOnConnect?: boolean;
    };
  };
  /** 它导入的记录（事件）：数据源页上的"共几条"按它数；断开时选了"连已导入的一起删"，这些整条换成"已删除"标记，由它们采成的素材彻底删除 */
  readonly records?: readonly DataSourceRecords[];
  /** 认导入文件夹里哪种文件 */
  readonly files?: readonly DataSourceFileType[];
  /** 连接状态（要快，打开数据源页时叫）；不给是"手动导入"的数据源（没有连接这回事） */
  status?(ctx: DataSourceContext): DataSourceStatus;
  /** 填设置、测试连接（网页插件在 dataSources 插槽里画那一块，经 POST /api/data-sources/<id> 交来）：值存进 ctx.secrets，交回连接状态 */
  configure?(values: Readonly<Record<string, string>>, ctx: DataSourceContext): Promise<DataSourceStatus>;
  /** 同步一次：拉新的、写它拥有的记录，交回新进来几条；抛错的记下原因（下次照常） */
  sync?(ctx: DataSourceSyncContext): Promise<DataSourceSyncResult>;
  /**
   * 出错后再试（306 号票）：status() 报出错时内核每小时叫一次，插件用存着的设置再测一次连接（不写记录、不用用户重填），
   * 更新自己记着的状态（好了就清掉出错），下一次 status() 报出来；Key 失效、密码错这种也照样叫（用户可能在别处修好了）。
   * 不给的、导入开着的照同步那样同步一次
   */
  recheck?(ctx: DataSourceRecheckContext): Promise<void>;
  /** 断开时插件自己的清理（停掉它自己开的、purge 时删它自己存储里的原始数据）；密钥区那一格、它拥有的记录由内核删 */
  disconnect?(ctx: DataSourceContext & { readonly purge: boolean }): void | Promise<void>;
  /**
   * 按需查的工具（给秘书）：按需查开着、插件在运行、连着（306 号票：status() 报的最近一次已知的连接状态）时才给；关掉、没连上了以后
   * 正在跑的一轮里再调回"关着""没连上 / 出错了"
   */
  tools?(ctx: DataSourceContext): readonly HostTool[];
  /** 设备交来的（299 号票：手机上的二狗 App）：算"导入"这种用法，导入关着时不收 */
  readonly push?: DataSourcePush;
  /** 现在共几条（插件在运行时代替按 records 数；299 号票：手机日历的记录是增量，按条数数不对） */
  count?(ctx: DataSourceContext): number;
  /** 交给日历插件显示的日程（外部日历，299 号票）：[from, to) 里的；插件在运行时日历按月取才叫，要快 */
  calendar?(range: { from: Date; to: Date }, ctx: DataSourceContext): readonly DataSourceCalendarEvent[];
  /**
   * 它在这台电脑上的文件夹（307 号票：Looki 存到本地的位置）：数据源页的"在电脑上打开"（open 动作）由内核用和导入文件夹同一个做法打开它。
   * 插件在运行时才叫；交回前插件自己建好，没有（还不能打开）交回 undefined 或者抛错（原因给人看）
   */
  localFolder?(ctx: DataSourceContext): string | undefined;
  /** 插件自己存储里的原始数据（300 号票）：数据源页按天列出、能按天清掉；插件在运行时才叫 */
  readonly raw?: DataSourceRaw;
  /**
   * 断开（只靠导入文件夹的是"删除已导入的"）时确认框里要说的一句，写成取值函数走 t()（306 号票）：没有密钥、导入的不进素材的数据源
   * （手机日历、通讯录、Google 联系人）说实际会删什么、会怎样——确认框里"填过的密钥从这台电脑上删掉""素材照样在"只在真有密钥、
   * 真进素材时才出现。插件停用也认得；插件在运行时 status() 报的 disconnectNote 优先（随状态变的：307 号票 Looki 存到本地的文件）
   */
  readonly disconnectNote?: string;
}
