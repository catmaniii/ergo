// agent 运行时的请求体和 ⚙ 里那一块（289 号票），用 TypeBox 定义；名字、能力清单、登记表给网页的样子在 runtimes.ts（不引用 TypeBox）。
// - RuntimeOptions：维护者给它的运行时选的值（任务、项目上记着的 runtimeOptions；宿主协议的装配参数原样带上）；
// - AgentRuntimeBody：PUT /api/agents/<agent id>/runtime——用哪个运行时、选的模型和设置项；
// - AgentRuntimeStateView：⚙ 面板（AgentSettingsView.runtime）里运行时一块。
// 290 号票（从运行时已有的会话接管）：
// - RuntimeTakeover：任务、项目上记着的"接管自哪个会话"（Task.takeover、Project.takeover），也是二狗的写入锁；
// - TakeOverBody / TakeOverResult：POST /api/runtimes/<运行时>/take-over——从选中的会话建任务或项目；
// - TakeoverActionBody：POST /api/agents/<agent id>/takeover——交还给运行时（释放写入锁）、收回到二狗；292 号票加了交给官方 App
//   （Remote Control，RuntimeTakeover.remote 记着后台会话和链接）。
// 305 号票（新建时选工作文件夹）：
// - WorkFolderChoice：发起任务、新建项目、建议立项卡上"在哪个文件夹做"；
// - RuntimeFolderBody：PUT /api/runtimes/<运行时>/work-folder——设置里定的新建时的默认文件夹。
import { type Static, Type } from "typebox";
import { RUNTIME_SWITCH_STATES, TAKEOVER_ACTIONS, TAKEOVER_KINDS, TAKEOVER_PLACES } from "./runtimes.ts";

/** 设置项的值：设置项 id → 选的 value */
const RuntimeSettingValues = Type.Record(Type.String({ minLength: 1, maxLength: 80 }), Type.String({ minLength: 1, maxLength: 200 }));

/** 维护者给它的运行时选的值（runtimes.ts 的 RuntimeChoice）：模型没写是跟运行时自己的设置，设置项没写的是默认那个 */
export const RuntimeOptions = Type.Object({
  model: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })),
  settings: Type.Optional(RuntimeSettingValues),
});
export type RuntimeOptions = Static<typeof RuntimeOptions>;

/**
 * 项目、任务的维护者用哪个运行时、给它选的值（PUT /api/agents/<agent id>/runtime）：runtime 要是现在能用的；模型要在这个运行时的模型列表里
 * （它没有模型列表的不能写），设置项的值要是它给的选项之一。换了运行时、没写模型和设置项的，按新运行时的默认
 */
export const AgentRuntimeBody = Type.Object({
  runtime: Type.String({ minLength: 1, maxLength: 80 }),
  model: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })),
  settings: Type.Optional(RuntimeSettingValues),
});
export type AgentRuntimeBody = Static<typeof AgentRuntimeBody>;

/** ⚙ 里运行时一块（只有项目、任务的维护者有）：现在用的、选的模型和设置项、正在换成哪个 */
export const AgentRuntimeStateView = Type.Object({
  /** 现在用的运行时（没写的是 pi） */
  id: Type.String(),
  /** 给人看的名字 */
  title: Type.String(),
  /** 选的模型；跟运行时自己的设置时没有 */
  model: Type.Optional(Type.String()),
  /** 选了的设置项（没选的是默认那个） */
  settings: RuntimeSettingValues,
  /** 正在换运行时（手头这一条做完、原来的写好交接摘要才换）：换成哪个、到哪了 */
  switching: Type.Optional(Type.Object({ to: Type.String(), title: Type.String(), state: Type.Enum(RUNTIME_SWITCH_STATES) })),
  /** 现在用的运行时不能用（"Claude Code插件没启用"）；能用是没有 */
  unavailable: Type.Optional(Type.String()),
  /**
   * 接管自运行时已有的会话（290 号票）：哪个会话、工作目录、交还了没有（交还了的维护者不拉起，收回后接着）。不是接管来的没有
   */
  takeover: Type.Optional(
    Type.Object({
      sessionId: Type.String(),
      title: Type.String(),
      cwd: Type.String(),
      forkedFrom: Type.Optional(Type.String()),
      /** 二狗接管着以外的（交还了、在官方 App 里）都是 true */
      returned: Type.Boolean(),
      /** 现在在哪边（292 号票：二狗接管 / 官方 App / 空着） */
      place: Type.Enum(TAKEOVER_PLACES),
      /** 二狗自己开的会话（292 号票：交给官方 App 时才记下的，不能"交还"） */
      own: Type.Optional(Type.Literal(true)),
      /** 官方 App 里接着它的链接（292 号票，在官方 App 里、拿到了才有） */
      url: Type.Optional(Type.String()),
    }),
  ),
  /** 能交给官方 App（292 号票：运行时的能力清单 remote_control）；不是接管来的会话也能交（还没开始的交的时候被拒） */
  remoteControl: Type.Optional(Type.Literal(true)),
  /** 维护者的工作文件夹（305 号票：能选工作文件夹的运行时才写；守卫的项目目录就是它） */
  workdir: Type.Optional(Type.String()),
});
export type AgentRuntimeStateView = Static<typeof AgentRuntimeStateView>;

/**
 * 新建能选工作文件夹的运行时（Claude Code）的任务、项目时"在哪个文件夹做"（305 号票）：
 * - new：在这个运行时的默认文件夹下新开一个子文件夹；name 是子文件夹名（不写按标题生成，workFolderName），不合法的字符换掉、重名加序号。
 *   还没设默认文件夹时照旧用二狗给任务开的工作目录（项目的在项目档案里）；
 * - existing：用一个已有的文件夹（绝对路径）：不存在、是文件、在数据目录或二狗程序目录里的被拒，写明原因。
 * 不写等于 new 不写名字。选定的文件夹就是维护者的工作目录（Claude Code 的 cwd），守卫的项目目录就是它；删任务、项目时不删它
 */
export const WorkFolderChoice = Type.Union([
  Type.Object({ kind: Type.Literal("new"), name: Type.Optional(Type.String({ minLength: 1, maxLength: 120 })) }),
  Type.Object({ kind: Type.Literal("existing"), path: Type.String({ minLength: 2, maxLength: 260 }) }),
]);
export type WorkFolderChoice = Static<typeof WorkFolderChoice>;

/** 设置里定的新建时的默认文件夹（PUT /api/runtimes/<运行时>/work-folder，305 号票）：null 是不设；响应是 RuntimesView */
export const RuntimeFolderBody = Type.Object({ folder: Type.Union([Type.String({ minLength: 2, maxLength: 260 }), Type.Null()]) });
export type RuntimeFolderBody = Static<typeof RuntimeFolderBody>;

/**
 * 从运行时已有的会话接管来的（290 号票，任务、项目上记着：Task.takeover、Project.takeover）。
 * 二狗的写入锁就是它：记着它、没交还、维护者还用这个运行时、任务 / 项目没删，二狗就管着这个会话——这期间只有这个维护者的子进程写它
 * （别的任务、项目再接管同一个会话被拒，只能分叉一份），交还以后维护者不拉起，收回（核对过它没在别处开着）才接着。
 * 维护者换了别的运行时（⚙ 里换运行时换完）就不再记着它（工作目录照旧）
 */
export const RuntimeTakeover = Type.Object({
  /** 哪个运行时的会话（插件登记的运行时 id，现在只有 claude-code） */
  runtime: Type.String({ minLength: 1, maxLength: 80 }),
  /** 运行时自己的会话 id（分叉接管的是分叉出来的那个） */
  sessionId: Type.String({ minLength: 1, maxLength: 200 }),
  /** 接管时会话的标题（给人看） */
  title: Type.String({ maxLength: 400 }),
  /** 分叉接管的：原来那个会话的 id（原会话不动） */
  forkedFrom: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })),
  /** 什么时候接管的（协议时间） */
  at: Type.String(),
  /** 交还了（协议时间）：维护者不拉起、二狗不再写它；收回时去掉。交给官方 App（292 号票）也记它（同样不拉起、不写），另有 remote.since */
  returnedAt: Type.Optional(Type.String()),
  /**
   * 二狗自己开的会话（292 号票）：不是从已有的会话接管来的，第一次交给官方 App 时才记下这一条（会话 id 是那时维护者接着的那个）。
   * 拉起时不按它恢复（照常接着会话目录里的），⚙ 里不给"交还"（那是接管来的才有的）
   */
  own: Type.Optional(Type.Literal(true)),
  /** 交给官方 App 过（292 号票，RuntimeRemote）：后台会话的短 id、链接；现在还在官方 App 里时有 since */
  remote: Type.Optional(
    Type.Object({
      /** 运行时自己的后台会话的短 id（Claude Code 的 `claude stop <短id>` 用它）；有了它，之后再交出去就是唤醒它（不带参数，带了会开出副本） */
      job: Type.String({ minLength: 1, maxLength: 80 }),
      /** 交出去的是哪个会话（中途 /clear 换过 id 的是新的那个；收回、跟随都按它） */
      sessionId: Type.String({ minLength: 1, maxLength: 200 }),
      /** 官方 App 里接着它的链接（Claude Code 是 claude.ai 上的，每次同一个）；还没拿到没有 */
      url: Type.Optional(Type.String({ maxLength: 500 })),
      /** 现在在官方 App 里：交出去的时间（协议时间）；收回后没有 */
      since: Type.Optional(Type.String()),
      /** 只读跟随从哪一条之后补记（交出去那一刻会话最后一条的 id）；会话还没有消息时没有 */
      from: Type.Optional(Type.String({ maxLength: 200 })),
    }),
  ),
});
export type RuntimeTakeover = Static<typeof RuntimeTakeover>;

/**
 * 从运行时已有的会话接管（POST /api/runtimes/<运行时>/take-over，290 号票）：建任务还是项目、哪个会话、要不要分叉一份接管。
 * - 会话正被别处占着（终端里开着、后台会话在跑、二狗的别的任务 / 项目在管）的，不分叉就被拒（409，写明在哪开着）；fork 为 true 时分叉一份新的接管，原会话不动；
 * - task：request 是接着让它做什么（普通任务，第一条输入就是它）；project：request 是项目要做成什么（一句话目标，可空，空的用会话标题）；
 * - 工作目录用会话原来的（守卫的项目目录就是它）；同一幂等键重发拿到第一次建出的
 */
export const TakeOverBody = Type.Object({
  sessionId: Type.String({ minLength: 1, maxLength: 200 }),
  as: Type.Enum(TAKEOVER_KINDS),
  request: Type.String({ maxLength: 4000 }),
  fork: Type.Optional(Type.Boolean()),
  idempotencyKey: Type.String({ minLength: 1, maxLength: 128 }),
});
export type TakeOverBody = Static<typeof TakeOverBody>;

/** 接管的结果：建出的任务或项目、接管的会话（分叉的是新的那个）、前情导进来几条 */
export const TakeOverResult = Type.Object({
  taskId: Type.Optional(Type.String()),
  projectId: Type.Optional(Type.String()),
  maintainerId: Type.String(),
  sessionId: Type.String(),
  prelude: Type.Integer({ minimum: 0 }),
});
export type TakeOverResult = Static<typeof TakeOverResult>;

/** 交还给运行时 / 收回到二狗（POST /api/agents/<agent id>/takeover，290 号票），响应是 ⚙ 面板（AgentSettingsView） */
export const TakeoverActionBody = Type.Object({ action: Type.Enum(TAKEOVER_ACTIONS) });
export type TakeoverActionBody = Static<typeof TakeoverActionBody>;
