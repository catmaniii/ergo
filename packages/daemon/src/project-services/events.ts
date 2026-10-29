// 项目的服务（133 号票）在事件日志里的事件：守护进程内部的 operations 频道（和运营方案的事件放在一起：删除项目时这个项目在
// operations 频道上的事件整条换成"已删除"标记，服务的这两种跟着一起，不用另登记）。前端看到的是项目列表频道上的临时事件
// project_services（守护进程按这两种事件和 LSM 推来的状态现算）。
// - service_desired：这个服务该在 LSM 上（登记、启动、开机自启）还是撤下——运营手段"服务"生效（确认运营方案）、方案里去掉了、
//   项目停用（含使用中归档）、重新启用（含取消归档回到使用中）时，和卡片、项目的事件同一事务追加；真正去 LSM 登记、启动在事务之后
//   异步做（project-services.ts）；
// - service_rollout：异步做完的结果——上线了、上线失败（原因来自 LSM）、要你手动（LSM 版本不支持、二狗没接入 LSM）、撤下了、
//   撤下失败。对的是哪一条 service_desired（desiredSeq）写明：之后又变了的旧结果不算。269 号票：二狗接上 LSM 时把上线了、用户
//   没关、却没在跑的服务拉起来，结果也记在这里（revive: true；起来了是上线了，起不来是上线失败）。
// - service_outage：上线了的服务后来挂了（down: true，LSM 给的原因）、又好了（down: false），和给维护者的通知同一事务追加。
//   派生视图据此记着"这次故障报过了"：同一次故障只报一次，守护进程重启了也不重报；对的也是哪一条 service_desired。
// 257 号票：项目卡片、项目页上的"启动""关闭"（秘书也走同一个入口），按整个项目：
// - service_power：用户要这个项目的服务全部启动（on: true）还是全部关闭（on: false），点一下记一条，最新的那条算数——关了就一直关着
//   （取消开机自启），守护进程、电脑重启后也不拉起，直到再记一条启动；项目停用、重新启用照 133 号票原样，开关不变；
// - 每个服务照最新的开关做完：启动是整份重新登记（恢复开机自启）、启动，结果照"上线"记 service_rollout（带 powerSeq：照的是哪一条
//   service_power）；关闭是取消开机自启、强制停，结果记 service_power_done（关好了、没关成及原因）。之后又点了的旧结果不记。
import type { OperationService, ServiceRollout } from "@ergo/protocol";

export const PROJECT_SERVICE_EVENTS = {
  desired: "service_desired",
  rollout: "service_rollout",
  outage: "service_outage",
  power: "service_power",
  powerDone: "service_power_done",
} as const;

/** 为什么要上线 / 撤下：确认了运营方案（含方案改了、重新开起来）、方案里去掉了、项目停用（含使用中归档）、重新启用（含取消归档） */
export type ServiceDesiredWhy = "confirmed" | "removed" | "retired" | "reactivated";

/** 这个服务该在 LSM 上还是撤下 */
export interface ServiceDesiredPayload {
  projectId: string;
  /** 运营方案里这一条的 key */
  key: string;
  /** 这一条的名字（"打开「X」"的 X） */
  title: string;
  /** LSM 里的名字、转发的应用名（<项目编号>-<服务名>） */
  app: string;
  /** true：登记、启动；false：撤下 */
  present: boolean;
  /** 服务的定义（撤下时是原来上线的那一份，项目页上照样写得出端口） */
  service: OperationService;
  why: ServiceDesiredWhy;
  time: string;
}

/** 异步做完的结果（不会是 pending / withdrawing：那两种是"还没做完"） */
export type ServiceRolloutState = Exclude<ServiceRollout, "pending" | "withdrawing">;

export interface ServiceRolloutPayload {
  projectId: string;
  key: string;
  app: string;
  /** 对的是哪一条 service_desired（它的全局序号）：之后又变了的旧结果不算 */
  desiredSeq: number;
  state: ServiceRolloutState;
  /** 上线失败、要你手动、撤下失败的原因（来自 LSM） */
  reason?: string;
  /** LSM 里现在有没有它的登记（撤下时要不要去 LSM 撤） */
  registered: boolean;
  /** 257：上线时照的是哪一条 service_power（它的全局序号；从没点过启动、关闭的是 0）；撤下的不写 */
  powerSeq?: number;
  /** 269：二狗接上 LSM 时兜底拉起的结果（上线了、用户没关的服务，接上时它没在跑）；照运营方案、开关做的不写 */
  revive?: true;
  time: string;
}

/** 上线了的服务挂了 / 又好了（报给维护者的那一次） */
export interface ServiceOutagePayload {
  projectId: string;
  key: string;
  app: string;
  /** 对的是哪一条 service_desired（它的全局序号）：之后又变了的（改了、撤下了）不算 */
  desiredSeq: number;
  /** true：挂了；false：又好了 */
  down: boolean;
  /** 挂了的原因（LSM 给的） */
  reason?: string;
  time: string;
}

/** 谁点的启动、关闭（257）：用户在项目卡片、项目页上点的，秘书照用户说的 */
export type ServicePowerBy = "user" | "secretary";

/** 257：这个项目的服务全部启动还是全部关闭（最新的一条算数） */
export interface ServicePowerPayload {
  projectId: string;
  /** true：全部启动（恢复开机自启）；false：全部关闭（取消开机自启，一直关着） */
  on: boolean;
  by: ServicePowerBy;
  time: string;
}

/** 257：一个服务照某一条"全部关闭"做完了（启动的结果照"上线"记在 service_rollout 上） */
export interface ServicePowerDonePayload {
  projectId: string;
  key: string;
  app: string;
  /** 对的是哪一条 service_desired：之后改了的不算 */
  desiredSeq: number;
  /** 照的是哪一条 service_power（它的全局序号） */
  powerSeq: number;
  on: boolean;
  /** 做成了没有；没做成的写原因（来自 LSM） */
  ok: boolean;
  reason?: string;
  time: string;
}
