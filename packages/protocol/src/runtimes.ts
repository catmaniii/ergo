// agent 运行时（286 号票，ADR-0027 的"运行时"贡献点）：维护者用哪个 agent 运行时跑它的会话——内核自带的 pi，或者插件登记的
// （Claude Code、以后 Codex……）。每个运行时是一个实现宿主协议的子进程入口（ADR-0004），守护进程只认宿主协议，网页只认二狗自己的事件。
// 守护进程把登记了的运行时连同能力清单交给网页（GET /api/runtimes，RuntimesView）：界面和守护进程按能力清单决定显示什么、走哪条路
// （一套界面几种运行时：取交集，没有的不显示或由二狗间接补，issue 24 第三节）。286 号票只接通、没有界面：
// 289 号票起新建任务、项目时选运行时，⚙ 按它显示；290 号票接管已有会话（列本机会话、标出被占着的、从选中的建任务或项目，
// 二狗管着期间只有一个进程写它，交还后才放开）；292 号票的 Remote Control 照它显示；293 号票的撤回、切分支照它显示（撤回的确认框按
// branch_summary、rewind_files 说清分支摘要谁写、文件恢复不恢复）。
// 不引用 TypeBox。

/** 内核自带的运行时 pi 的 id：维护者没写运行时（Task.runtime、Project.runtime 没有）就是它 */
export const PI_RUNTIME_ID = "pi";

/**
 * 能力清单的项：和运行时绑得紧、某个运行时可能没有的会话操作（调研 33 的 ★ 项、调研 31 第 8 节、issue 24 第三节）。
 * 宿主协议里人人都得实现的（启动、输入、中止、守卫、宿主工具、用量、轮次结束、上下文块和钩子……）不在这里。
 * - interject：回合中插话（宿主协议 interject：运行时的催促、秘书转达）；
 * - compact：现在压缩（⚙ 的按钮，宿主协议 compact）；
 * - rollback：撤回到某条输入、某次工具调用之前（navigate_session 的 beforeInput / beforeCall / afterCall，150、152 号票）；
 * - branch_switch：切回废弃分支（navigate_session 的 entry，151 号票）；
 * - branch_summary：撤回时运行时自己给被放弃的那段写分支摘要（没有的由二狗按自己记下的事件、用这个维护者的二狗模型另起一次写，293 号票）；
 * - rewind_files：撤回时运行时把它改过的文件也恢复到撤回点（293 号票：Claude Code 的文件检查点，只追它自己的 Write、Edit 改的文件，
 *   Bash 改的追不到；撤回到一次工具调用前后（阶段、步骤开始前）时不恢复——检查点只按整条输入记）。pi 没有：撤回不动文件；
 * - model_handoff：换模型时原来的模型写交接摘要、新开会话（start.handoff，83 号票）；
 * - thinking_levels：能选思考档位；
 * - slash_passthrough：输入框里的斜杠命令原样交给运行时执行（289 号票；pi 没有：二狗自己把 /目录名 展开成 skill）；
 * - take_over：接管本机已有的会话（290 号票：列会话、从选中的接着）；
 * - purge_rewrite：彻底删除时改写运行时自己的会话记录（ADR-0008）；
 * - yield：工具包变了，做完手头这一步就停下、按新的装配接着（宿主协议 yield，ADR-0018）；
 * - live_toolkit：工具包变了当场换（291 号票，宿主协议 toolkit：守护进程代为执行的工具、工具包里的 skill 整份换掉，不停下、不重新拉起；
 *   Claude Code 有，pi 没有——pi 按 yield 停下重新装配）；
 * - scope_review：在会话里做范围审视（宿主协议 scope_review、压缩时审视，ADR-0016）；
 * - remote_control：交给官方 App 接着、再收回来（292 号票：⚙ 里"交给官方 App"、"收回到二狗"，在官方 App 里时二狗只读跟随）
 */
export const RUNTIME_OPERATIONS = [
  "interject",
  "compact",
  "rollback",
  "branch_switch",
  "branch_summary",
  "rewind_files",
  "model_handoff",
  "thinking_levels",
  "slash_passthrough",
  "take_over",
  "purge_rewrite",
  "yield",
  "live_toolkit",
  "scope_review",
  "remote_control",
] as const;
export type RuntimeOperation = (typeof RUNTIME_OPERATIONS)[number];

/** 能力清单：每一项能不能做（每个运行时都要逐项写明，加了新的一项各运行时都得表态） */
export type RuntimeCapabilities = Readonly<Record<RuntimeOperation, boolean>>;

/** 运行时的一个可选模型（289 号票的 ⚙ 里列）：运行时自己的模型 id、给人看的名字 */
export interface RuntimeModelView {
  id: string;
  title: string;
}

/** 运行时的一个设置项（289 号票的 ⚙ 里列：权限模式、思考档位……）：从几个里选一个，有默认的那个 */
export interface RuntimeSettingView {
  id: string;
  title: string;
  options: Array<{ value: string; title: string }>;
  default: string;
}

/** 一个运行时给网页的样子（给人看的字按守护进程当前的语言写好） */
export interface AgentRuntimeView {
  id: string;
  title: string;
  /** 登记它的插件（插件名）；内核自带的（pi）没有 */
  plugin?: string;
  /** 现在能不能用：登记它的插件在运行（pi 一直能用） */
  available: boolean;
  /** 不能用的原因（"Claude Code插件没启用"）；能用时没有 */
  unavailable?: string;
  capabilities: RuntimeCapabilities;
  /** 可选的模型；没有这一项是按设置 · 模型（二狗自己的模型目录，pi 就是这样） */
  models?: RuntimeModelView[];
  /** 设置项（没有是空的） */
  settings: RuntimeSettingView[];
  /**
   * 新建时能选工作文件夹（305 号票，Claude Code 有、pi 没有）：新建它的任务、项目时多"在哪个文件夹做"；defaultFolder 是设置里定的
   * 新建时的默认文件夹（新的任务、项目默认在它下面新开一个子文件夹；没设没有，照旧用二狗给任务开的工作目录）
   */
  workFolder?: { defaultFolder?: string };
}

/** GET /api/runtimes：登记了的全部运行时，pi 在最前，插件的按插件清单的先后（停用了的插件的也在，available 是 false） */
export interface RuntimesView {
  runtimes: AgentRuntimeView[];
}

/**
 * 维护者给它用的运行时选的值（289 号票，⚙ 里；任务、项目上记着 runtimeOptions）：运行时自己的模型 id（没写是跟运行时自己的设置，
 * pi 不用这一项：pi 的模型在 ⚙ 的"模型"一块，照 120 号票）、设置项的值（设置项 id → 选的 value；没写的是那一项默认的）。
 * 守护进程拉起维护者时原样交给子进程（宿主协议的装配参数 runtimeOptions），子进程按自己的运行时翻译（Claude Code：model、effort、permissionMode）
 */
export interface RuntimeChoice {
  model?: string;
  settings?: Record<string, string>;
}

/**
 * 换运行时到哪了（289 号票，⚙ 里写）：waiting 等手头这一条做完；handoff 原来的运行时在写交接摘要。换完了没有这一项
 */
export const RUNTIME_SWITCH_STATES = ["waiting", "handoff"] as const;
export type RuntimeSwitchState = (typeof RUNTIME_SWITCH_STATES)[number];

/** 维护者用的运行时 id：没写是 pi（Task.runtime、Project.runtime 的规矩） */
export const runtimeIdOf = (runtime: string | undefined): string => runtime ?? PI_RUNTIME_ID;

/** 卡上要不要标出运行时（289 号票）：默认的 pi 不标，插件登记的才标 */
export const runtimeShown = (runtime: string | undefined): runtime is string => runtime !== undefined && runtime !== PI_RUNTIME_ID;

/** 运行时给人看的名字：登记表里有就用它的，没有（插件移除了、网页还没取到）原样写 id */
export function runtimeTitleOf(runtimes: readonly Pick<AgentRuntimeView, "id" | "title">[] | undefined, id: string | undefined): string {
  const runtime = runtimeIdOf(id);
  return runtimes?.find((r) => r.id === runtime)?.title ?? runtime;
}

/** 新建项目、任务时能选的运行时（289 号票）：现在能用的（pi 一直能用，插件登记的要插件在运行） */
export const selectableRuntimes = <T extends Pick<AgentRuntimeView, "available">>(runtimes: readonly T[] | undefined): T[] => (runtimes ?? []).filter((r) => r.available);

/** 本机一个能接管的会话（290 号票）：运行时列出来的 */
export interface ResumableSessionView {
  /** 运行时自己的会话 id */
  id: string;
  title: string;
  /** 会话原来的工作目录（接管后维护者就在这里干活） */
  cwd: string;
  /** git 分支（有就写） */
  branch?: string;
  /** 最近一次活动的时间（协议时间，带时区偏移） */
  updatedAt: string;
  /** 会话记录多大（字节；有就写） */
  bytes?: number;
  /**
   * 现在正被占着：给人看的说明（"在终端里开着"、"后台会话在跑"、"二狗的任务 t-3「…」在管"、查不到占没占时也写上）；空闲的没有。
   * 被占着的不能直接接管（终端里开着的不锁，接了会分叉、丢轮），先在那边关掉，或者分叉一份接管
   */
  busy?: string;
  /** 二狗自己的任务、项目在管它（写入锁，交还之前别的不能接管）：是哪个 */
  heldBy?: { kind: TakeoverKind; id: string; title: string; maintainerId: string };
}

/** GET /api/runtimes/<运行时>/sessions（290 号票）：本机能接管的会话，最近活动的在前 */
export interface RuntimeSessionsView {
  sessions: ResumableSessionView[];
}

/** 从已有的会话接管成什么（290 号票）：任务（普通任务）或项目 */
export const TAKEOVER_KINDS = ["task", "project"] as const;
export type TakeoverKind = (typeof TAKEOVER_KINDS)[number];

/**
 * 接管来的会话的动作（290 号票，⚙ 里）：交还给运行时（二狗不再写它）、收回到二狗（核对过没在别处开着）。
 * 292 号票加了 remote：交给官方 App（Remote Control）——二狗打断、关掉自己的进程，开（或唤醒）运行时自己的后台会话、连上官方 App；
 * 收回到二狗（reclaim）同一个动作，先停掉那边的后台会话。二狗自己开的会话（不是接管来的）也能交给官方 App
 */
export const TAKEOVER_ACTIONS = ["return", "reclaim", "remote"] as const;
export type TakeoverAction = (typeof TAKEOVER_ACTIONS)[number];

/**
 * 一个运行时会话现在在哪边（292 号票，任务、项目上记着的 RuntimeTakeover 算出来的，二狗以自己的记录为准）：
 * - ergo：二狗接管着（只有二狗的维护者写它）；
 * - remote：在官方 App 里（运行时自己的后台会话连着 Remote Control，二狗不写它，只读跟随、把那边的进度补记进维护者的会话）；
 * - returned：交还了、空着（二狗不写它，用户可以回终端里用）
 */
export const TAKEOVER_PLACES = ["ergo", "remote", "returned"] as const;
export type TakeoverPlace = (typeof TAKEOVER_PLACES)[number];

/** 任务、项目上记着的接管（RuntimeTakeover）现在在哪边：没交还的是二狗接管着；交还了、还在官方 App 里的是 remote；别的是空着 */
export function takeoverPlaceOf(takeover: { returnedAt?: string | undefined; remote?: { since?: string | undefined } | undefined }): TakeoverPlace {
  if (takeover.returnedAt === undefined) return "ergo";
  return takeover.remote?.since !== undefined ? "remote" : "returned";
}

/** 核对一个已有的文件夹（POST /api/runtimes/<运行时>/work-folder，305 号票）：能用的真实路径 */
export interface WorkFolderCheckResult {
  folder: string;
}

/** 按标题生成的子文件夹名最多几个字（305 号票） */
export const WORK_FOLDER_NAME_MAX = 60;

/** 文件夹名里不能有的字符（Windows 的规矩，另加控制字符） */
const BAD_FOLDER_CHARS = '<>:"/\\|?*';

/** Windows 上不能当文件名的（不分大小写，带扩展名的也不行） */
const RESERVED_FOLDER_NAME = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i;

/**
 * 新开的子文件夹叫什么（305 号票，"在默认文件夹下新开一个"）：取标题第一行，不合法的字符（< > : " / \ | ? * 和控制字符）换成 "-"，
 * 空白并成一个，前后的点和空格去掉，最多 WORK_FOLDER_NAME_MAX 个字；Windows 保留的名字（CON、NUL……）后面加 "-"。
 * 什么都不剩的是空字符串（调用方另起名）。重名加序号由守护进程在建的时候做
 */
export function workFolderName(title: string): string {
  const line = title.split(/\r?\n/)[0] ?? "";
  const cleaned = [...line]
    .map((c) => (c.charCodeAt(0) < 32 || BAD_FOLDER_CHARS.includes(c) ? "-" : c))
    .join("")
    .replace(/\s+/g, " ")
    .replace(/-{2,}/g, "-")
    .trim();
  const clipped = [...cleaned].slice(0, WORK_FOLDER_NAME_MAX).join("");
  const name = clipped.replace(/^[.\s]+|[.\s]+$/g, "");
  return RESERVED_FOLDER_NAME.test(name) ? `${name}-` : name;
}

