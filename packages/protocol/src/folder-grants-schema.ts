// 目录授权（ADR-0049）：每个 agent 一份目录授权表——秘书一份、每个项目一份（项目的负责人在各段都用）、每个任务一份（任务的负责人用）；
// 子 agent、评审、记忆管理员没有。每条授权写明哪个目录（登记时取的真实路径）、能做哪几种操作（读、写、删可以组合，勾了删除不带写）、
// 到什么时候（不写是长期有效）、为什么给、谁什么时候加的。存在数据目录的配置区，只由运行时写，agent 改不了。
// 守卫按它放开登记了的那种操作（daemon 的 guard/judge.ts），因为它放行的每次调用记一条使用记录。
// 设置接口：GET / POST /api/folder-grants 看、加；DELETE /api/folder-grants/<id> 删一条；POST /api/folder-grants/clear 一次清掉几条；
// GET /api/folder-grants/uses 最近的使用记录。
// 464：有表的 agent 也能自己申请（工具 request_folder_grant）：发一张"目录授权申请"卡（folder_grant_request），用户在卡上
// 收窄（去掉几样操作、改多久）后点同意才登记，谁加的记"它申请、你同意的"（request）。
import { type Static, Type } from "typebox";

/** 一条授权能做的操作：读、写、删（删除单独勾，勾了删除不自动带写） */
export const FOLDER_GRANT_MODES = ["read", "write", "delete"] as const;
export type FolderGrantMode = (typeof FOLDER_GRANT_MODES)[number];

/** 谁加的：用户在设置、⚙ 里加的，用户在审批卡上点"以后都允许"登记的，agent 申请、用户在申请卡上同意的 */
export const FOLDER_GRANT_ADDED_BY = ["user", "approval", "request"] as const;
export type FolderGrantAddedBy = (typeof FOLDER_GRANT_ADDED_BY)[number];

/** 一条授权现在的样子：有效、已过期、目录找不到了 */
export const FOLDER_GRANT_STATES = ["active", "expired", "missing"] as const;
export type FolderGrantState = (typeof FOLDER_GRANT_STATES)[number];

/** 一个 agent 最多登记几条 */
export const FOLDER_GRANTS_PER_AGENT_MAX = 50;
/** 到期前多久在待办里提示一次（毫秒）：3 天 */
export const FOLDER_GRANT_REMIND_BEFORE_MS = 3 * 24 * 60 * 60 * 1000;
/** 使用记录一次最多取几条 */
export const FOLDER_GRANT_USES_MAX = 500;
/** 使用记录默认取几条 */
export const FOLDER_GRANT_USES_DEFAULT = 100;
/** agent 申请时最多能要几天（不写是长期有效）；申请卡上改多久也是这个范围 */
export const FOLDER_GRANT_REQUEST_DAYS_MAX = 3650;
/** 申请的理由最多几个字（和设置里"为什么给"一样长） */
export const FOLDER_GRANT_REASON_MAX = 500;

const Modes = Type.Array(Type.Enum(FOLDER_GRANT_MODES), { minItems: 1, maxItems: 3, uniqueItems: true });

/** 一条授权（设置页、⚙ 里看的） */
export const FolderGrantView = Type.Object({
  id: Type.String(),
  /** 哪个 agent 的表：secretary、项目负责人的 pm-<n>、任务负责人的 tm-<n> */
  agentId: Type.String(),
  /** 给人看的：秘书是名字占位（界面上换成用户起的名字）、项目「…」的负责人、任务「…」的负责人；这个 agent 已经没有了时为空 */
  agentLabel: Type.Optional(Type.String()),
  /** 登记的目录（真实路径） */
  path: Type.String(),
  modes: Modes,
  /** 到期时间；不写是长期有效 */
  expiresAt: Type.Optional(Type.String()),
  note: Type.String(),
  addedBy: Type.Enum(FOLDER_GRANT_ADDED_BY),
  addedAt: Type.String(),
  state: Type.Enum(FOLDER_GRANT_STATES),
});
export type FolderGrantView = Static<typeof FolderGrantView>;

/** GET /api/folder-grants（加、删、清之后回的也是它）：全部 agent 的授权，连同所有 agent 都能读的授权的文件夹 */
export const FolderGrantsView = Type.Object({
  grants: Type.Array(FolderGrantView),
  /** 授权的文件夹（设置 · 目录授权）：所有 agent · 只读 */
  authorizedFolders: Type.Array(Type.String()),
});
export type FolderGrantsView = Static<typeof FolderGrantsView>;

/**
 * 加一条（POST /api/folder-grants）：给哪个 agent、哪个目录（绝对路径、要在、要是目录，存它的真实路径）、哪几种操作、
 * 到什么时候（不写是长期有效，要是以后的时间）、为什么给。同一个 agent 同一个目录已经有的，换成这一条
 */
export const FolderGrantAddBody = Type.Object(
  {
    agentId: Type.String({ minLength: 1, maxLength: 100 }),
    path: Type.String({ minLength: 1, maxLength: 1000 }),
    modes: Modes,
    expiresAt: Type.Optional(Type.String({ minLength: 10, maxLength: 40 })),
    note: Type.Optional(Type.String({ maxLength: 500 })),
  },
  { additionalProperties: false },
);
export type FolderGrantAddBody = Static<typeof FolderGrantAddBody>;

/** 一次清掉几条（POST /api/folder-grants/clear）：给 ids 清这几条，expired 为 true 清掉全部已过期的；agentId 只清这个 agent 的 */
export const FolderGrantsClearBody = Type.Object(
  {
    ids: Type.Optional(Type.Array(Type.String({ minLength: 1 }), { maxItems: 1000 })),
    expired: Type.Optional(Type.Literal(true)),
    agentId: Type.Optional(Type.String({ minLength: 1, maxLength: 100 })),
  },
  { additionalProperties: false, minProperties: 1 },
);
export type FolderGrantsClearBody = Static<typeof FolderGrantsClearBody>;

/**
 * 一条使用记录：因为目录授权放行、执行了的一次调用碰到的一个路径。文件工具的读、写能拿到字节数的写上；
 * bash 拆出来的（viaShell）只记守卫看得到的路径参数，不是程序实际读写了哪些文件
 */
export const FolderGrantUseView = Type.Object({
  at: Type.String(),
  agentId: Type.String(),
  agentLabel: Type.Optional(Type.String()),
  grantId: Type.String(),
  /** 登记的目录 */
  dir: Type.String(),
  /** 碰到的路径 */
  path: Type.String(),
  mode: Type.Enum(FOLDER_GRANT_MODES),
  /** 工具（bash 拆出来的是伪工具的名字） */
  tool: Type.String(),
  viaShell: Type.Boolean(),
  bytes: Type.Optional(Type.Integer({ minimum: 0 })),
  /** 放行了、执行出错的 */
  failed: Type.Optional(Type.Boolean()),
});
export type FolderGrantUseView = Static<typeof FolderGrantUseView>;

/** GET /api/folder-grants/uses[?limit=…]：最近的使用记录，新的在前 */
export const FolderGrantUsesView = Type.Object({ uses: Type.Array(FolderGrantUseView) });
export type FolderGrantUsesView = Static<typeof FolderGrantUsesView>;

/**
 * 审批卡上"以后都允许"要登记的：对话里因为越出项目目录要问的那次调用，碰到的都在同一个目录里、都是能登记的读写删，
 * 点了就把这个目录按这次要的操作登记成这个 agent 的长期授权，同时批准这一次
 */
export const ApprovalFolderGrant = Type.Object({ path: Type.String(), modes: Modes });
export type ApprovalFolderGrant = Static<typeof ApprovalFolderGrant>;

const RequestDays = Type.Integer({ minimum: 1, maximum: FOLDER_GRANT_REQUEST_DAYS_MAX });

/** 一条登记的样子（申请卡上写的已有的、同意之后登记成的）：操作、到期时间（不写是长期有效） */
const GrantShape = { modes: Modes, expiresAt: Type.Optional(Type.String()) };

/**
 * "目录授权申请"卡（folder_grant_request）：有目录授权表的 agent（个人助理、项目和任务的负责人）用 request_folder_grant 申请的。
 * 出在它自己的会话里、进待办；卡上写哪个 agent、目录、要的操作、多久、为什么，这个目录已经登记过的写明已有什么，
 * 在所有 agent 都能读的文件夹里的写明"读本来就行"。用户能去掉几样操作、改多久再同意；同意了才登记（已有的那条只会变宽），
 * 结果作为一条通知交回这个 agent
 */
export const FolderGrantRequestCardPayload = Type.Object({
  /** 谁申请的：secretary、项目负责人的 pm-<n>、任务负责人的 tm-<n> */
  agentId: Type.String(),
  /** 给人看的：个人助理是名字占位（界面上换成用户起的名字）、项目「…」的负责人、任务「…」的负责人 */
  agentLabel: Type.String(),
  /** 目录（发卡时查过的真实路径） */
  path: Type.String(),
  /** 要的操作 */
  modes: Modes,
  /** 要几天；不写是长期有效 */
  days: Type.Optional(RequestDays),
  /** 为什么要 */
  why: Type.String(),
  /** 发卡时这个目录（或它的上级）已经登记了的那一条：path 是登记的目录，expired 是已经过期了 */
  existing: Type.Optional(Type.Object({ path: Type.String(), ...GrantShape, expired: Type.Boolean() })),
  /** 在所有 agent 都能读的文件夹（授权的文件夹）里：读本来就行 */
  readable: Type.Optional(Type.Literal(true)),
  /**
   * 处理之后：同意了没有、什么时候、用户附的那句话；同意的还有这次给的（勾着的操作、选的多久换成的到期时间）和登记之后那一条的样子
   * （并进已有的之后：操作取并集、到期取更晚的）
   */
  decided: Type.Optional(
    Type.Object({
      approved: Type.Boolean(),
      at: Type.String(),
      note: Type.Optional(Type.String()),
      granted: Type.Optional(Type.Object(GrantShape)),
      grant: Type.Optional(Type.Object(GrantShape)),
    }),
  ),
});
export type FolderGrantRequestCardPayload = Static<typeof FolderGrantRequestCardPayload>;

/**
 * 申请卡上"同意"的输入：勾着的操作（只能是申请里要的那几种，去掉几样）、多久（天数；null 是长期有效）。
 * 不写的照申请的；整个不给就是原样同意
 */
export const FolderGrantRequestApproveInput = Type.Union([
  Type.Undefined(),
  Type.Object(
    {
      modes: Type.Optional(Modes),
      days: Type.Optional(Type.Union([RequestDays, Type.Null()])),
    },
    { additionalProperties: false },
  ),
]);
export type FolderGrantRequestApproveInput = Static<typeof FolderGrantRequestApproveInput>;

/** "目录授权快到期"事项（notice folder_grant_expiring）的 data */
export interface FolderGrantExpiringData {
  grantId: string;
  agentId: string;
  path: string;
  expiresAt: string;
}
