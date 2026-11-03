// 目录授权（ADR-0049）：每个 agent 一份目录授权表——秘书一份、每个项目一份（项目的负责人在各段都用）、每个任务一份（任务的负责人用）；
// 子 agent、评审、记忆管理员没有。每条授权写明哪个目录（登记时取的真实路径）、能做哪几种操作（读、写、删可以组合，勾了删除不带写）、
// 到什么时候（不写是长期有效）、为什么给、谁什么时候加的。存在数据目录的配置区，只由运行时写，agent 改不了。
// 守卫按它放开登记了的那种操作（daemon 的 guard/judge.ts），因为它放行的每次调用记一条使用记录。
// 设置接口：GET / POST /api/folder-grants 看、加；DELETE /api/folder-grants/<id> 删一条；POST /api/folder-grants/clear 一次清掉几条；
// GET /api/folder-grants/uses 最近的使用记录。
import { type Static, Type } from "typebox";

/** 一条授权能做的操作：读、写、删（删除单独勾，勾了删除不自动带写） */
export const FOLDER_GRANT_MODES = ["read", "write", "delete"] as const;
export type FolderGrantMode = (typeof FOLDER_GRANT_MODES)[number];

/** 谁加的：用户在设置、⚙ 里加的，用户在审批卡上点"以后都允许"登记的 */
export const FOLDER_GRANT_ADDED_BY = ["user", "approval"] as const;
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
  /** 授权的文件夹（设置 · 授权的文件夹）：所有 agent · 只读 */
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

/** "目录授权快到期"事项（notice folder_grant_expiring）的 data */
export interface FolderGrantExpiringData {
  grantId: string;
  agentId: string;
  path: string;
  expiresAt: string;
}
