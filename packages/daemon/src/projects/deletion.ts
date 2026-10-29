// 删除项目（规格第 11 节，ADR-0010）：用户在待我处理里的二次确认上选了"确认删除"之后，按这个顺序做：
// 1. 先停维护者（马上不再接输入，之后来的输入也不唤起它），等它的子进程结束（内存里的原文随之没了）；
// 2. 复查：停下来的这段时间里用户取消了归档（或者项目已经不在了）就整个中止，什么都不删，维护者恢复成能唤起；
//    没变就在同一个事务里追加项目的 deleted，并改写属于这个项目的事件（和彻底删除同一个口子 appendBatch 的 purge，ADR-0008）；
// 3. 最后删项目档案和会话区里维护者的会话文件（项目已经删了，不再回头）。
// 改写哪些、换成什么由"删除参与方"登记表定（279 号票，deletion/participants.ts）：拥有属于项目的事件的模块各自登记——项目自己的
// （维护者会话整条换成标记、立项书和规范改写、说的是这个项目的卡、项目之外读过它的调用：projects/deletion-participants.ts）、工单
// （work-orders/purge.ts）、运营方案（operations/deletion.ts），内核里的任务（内部任务和它们的记录、卡片）、子 agent（并行）、触发底座
// （定时作业）、守卫接入（这个维护者的审批、效果日志、执行记录、完整内容）、范围审视（范围记录）、待我处理（属于项目的事项）、
// 素材库（内部任务由系统记下的记录，66 号票）。新加一种属于项目的事件，在拥有它的模块里登记就随项目删，不用改这里。
// 用户本人说过的话（维护者会话里的发言、投喂的材料、记忆命令）作为素材保留（原文副本，ADR-0006），维护者会话也不追加
// messages_purged（整条换成了标记，会话文件整个删掉）。
import type { Project } from "@ergo/protocol";
import { type DeletionParticipants, PROJECT_DELETION } from "../deletion/participants.ts";
import type { EventStore, NewEvent } from "../events/event-store.ts";
import { type ProjectRecordsPaths, removeProjectRecords } from "./records.ts";
import { getProjectRow } from "./views.ts";

/** 删除时要停、要恢复的项目维护者（项目维护者模块，在 daemon.ts 里接上） */
export interface MaintainerSuspension {
  /** 停掉这个维护者：马上不再接输入，之后来的输入也不唤起它；子进程结束后兑现 */
  suspend(maintainerId: string): Promise<void>;
  /** 恢复成能唤起（删除中止时）：有输入等着就唤起 */
  resume(maintainerId: string): void;
  /** 删掉它在会话区里的会话文件（项目已删除、子进程已结束之后） */
  removeSession(maintainerId: string): void;
}

export interface ProjectDeletionDeps {
  store: EventStore;
  /** "删除参与方"登记表：属于项目的事件改写成什么、同一事务追加什么 */
  participants: Pick<DeletionParticipants, "plan">;
  maintainers: MaintainerSuspension;
  records: (projectId: string) => ProjectRecordsPaths;
  /** 项目列表频道上那条 deleted 事件 */
  deletedEvent: (project: Project) => NewEvent;
  now: () => string;
  log: (line: string) => void;
}

/** 删除一个已归档的项目（确认删除之后）：中止了、或者项目已经不在已归档，什么都不删 */
export async function deleteProject(deps: ProjectDeletionDeps, projectId: string): Promise<void> {
  const { store, maintainers, log } = deps;
  const archived = () => {
    const row = getProjectRow(store.reader, projectId);
    return row && !row.deleted && row.project.state === "archived" ? row.project : undefined;
  };
  const project = archived();
  if (!project) {
    log(`项目 ${projectId} 已经不在已归档（或者已经删了），没有删`);
    return;
  }
  // 1. 先停维护者
  await maintainers.suspend(project.maintainerId);
  // 2. 复查：期间取消了归档就整个中止
  const current = archived();
  if (!current) {
    maintainers.resume(project.maintainerId);
    log(`删除项目 ${projectId}「${project.name}」中止了：停维护者的时候项目已经不在已归档，什么都没删`);
    return;
  }
  // 照彻底删除的口径改写，完整内容注明"已随项目删除"（66 号票）；没登记改写函数的事件类型在这里抛错，整个删除被拒
  const plan = deps.participants.plan(PROJECT_DELETION, { project: current }, { deletedAt: deps.now(), materialIds: new Set(), purgedBy: "project_deletion" });
  store.appendBatch([deps.deletedEvent(current), ...plan.events], { purge: plan.purge });
  // 3. 项目已经删了：再删参与方要提交之后删的、项目档案和会话文件
  if (getProjectRow(store.reader, projectId)?.deleted !== true) return;
  for (const step of plan.afterCommit) step();
  removeProjectRecords(deps.records(projectId));
  maintainers.removeSession(current.maintainerId);
  log(`删除了项目 ${projectId}「${current.name}」：项目档案、维护者会话和立项书正文（用户的话在素材的原文副本里）`);
}
