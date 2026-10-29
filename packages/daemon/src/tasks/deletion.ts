// 删除任务（186 号票，用户 2026-10-20 定"任务能删除，连会话和工作目录一起删"；照删项目的做法：ADR-0010、15 号票）。
// 用户在看板卡的菜单、任务详情的"⋯"、看板多选里点了删除（网页先确认一次），或者在秘书那里确认了快速动作 delete_task：
// 1. 能不能删（不能删的拒绝、写明原因，什么都不动）：项目在用时运营方案里的一条（141 号票，到项目里改运营方案）；项目内部任务、
//    转为项目了的、由还在的项目的维护者做的（照项目的规矩：项目还在时由项目管，协议包 taskDeleteRefusal）；以前的定时作业迁移成的
//    定时任务还在用它工作目录的（legacyJobsUsing）；
// 2. 先停：没结束的照现有的取消走（运营中的定时、事件触发的任务落到触发上：触发登记取消、排着的运行丢掉，子 agent 随任务结束停下）；
//    再停它的维护者——停稳手头这一轮（中止，等这一轮真的结束：运行记录跟着收口）、马上不再接输入、之后来的也不唤起，等子进程退出
//    （内存里的原文随之没了）；它还活着的子 agent 停下、等它们交回的说明落了盘；在跑的验收停下（宣布完成时的脚本和评审、交给评审的
//    验收、重做后复验）：验收脚本的进程杀掉、评审子 agent 结束，等它们收完尾（不然它们还在工作目录里跑，工作目录删不掉）；
// 3. 复查：停的这段时间里任务又开始做了（返工、重试）、被别处删了，整个中止，维护者恢复成能唤起，什么都不删；
// 4. 没变就在同一个事务里追加任务的 deleted（任务的文字换成删除标记，带 deleted：派生视图读任务时跳过它，网页收到时拿掉它和它的会话），
//    并改写属于这个任务的事件（和彻底删除、删项目同一个口子 appendBatch 的 purge：行和序号留着、派生视图整体重放、原文不留）：
//    - 任务自己的记录：看板频道上它的每条事件、现在生效的计划，任务书、计划、决定，并行的提议和决定，它的触发登记
//      （删项目时随项目删的内部任务也一样）；
//    - 维护者的会话频道（任务自己的维护者 tm-N、迁移来的定时任务的作业维护者 jm-N）上的事件整条换成"已删除"标记；
//      由项目的维护者做的、项目已经删了的不再碰（随项目删过了）；
//    - 卡片：负载里记着这个任务的（计划卡、流程计划卡、计划变更卡、并行确认卡、进度卡……），每个版本整条换成"已删除"标记；
//      在别人的会话里的不动（秘书的提问卡、建议发起任务卡、快速动作卡，项目维护者的提问卡，归档清单、工单卡：KEEP_CARD_TYPES）；
//      维护者和子 agent 的审批卡同样换掉；
//    - 维护者和子 agent 的审批（请求、决定）、效果日志、执行记录、调用另存的完整参数和返回（含评审子 agent 的）：照彻底删除的
//      改写函数字段级改写（ADR-0008，状态不变）；
//    - 这个任务的范围记录：照彻底删除的改写函数换掉摘要、说明、依据；
//    - 待我处理里属于这个任务的事项（数据、来处里记着它的，上面那些卡的，维护者和子 agent 的中断不确定）：标题、正文、来源换成删除标记，
//      再追加一版删掉的（待办里不再有）；
//    - 素材库里从上面改写了的事件采到的系统记录（任务的结局、计划和审批的决定、对产出的反应、回避信号……）：照删项目的口径
//      （66 号票）同一事务记一条彻底删除的记忆命令（出处 task_deletion，不产生"显式记忆命令"素材），素材和索引删掉、记下墓碑；
//      用户本人说过的话（在维护者会话里的发言、投喂的材料）不删：原文副本里有（ADR-0006），重建时补回；
//    改写哪些、换成什么由"删除参与方"登记表定（279 号票，deletion/participants.ts）：任务自己的记录、会话和卡片（tasks/deletion-participants.ts）、
//    并行（sub-agents/deletion.ts）、触发登记（scheduled-jobs/purge.ts）、审批和效果日志这些（guard-runtime/deletion.ts）、范围记录
//    （scope-review/purge.ts）、待我处理（inbox/deletion.ts）、素材（memory/deletion-participants.ts）各自登记，删项目时也走同一张表；
// 5. 最后删文件（任务已经删了，不再回头）：会话区里维护者和子 agent 的会话（pi 的会话文件整个删掉）、输出区里任务的工作目录
//    （outputs/<任务>，产出文件、子 agent 的 git worktree 都在里面）。删不掉的记日志（最坏是任务删了、文件还留着，不再有东西用到它们）。
// 不动的：消耗的账（照旧计在任务名下，网页写"t-3（已删除）"）；涉及多个项目的任务派给各项目的工单（项目的记录，项目维护者的会话里也有）；
// 秘书会话里提到它的（秘书据此说的话、做完时转告的结果、它读过的产出，照删项目时"秘书据此说过的话不改"）；备份快照里的一份。
import fs from "node:fs";
import { CHANNELS, ENDED_TASK_STATES, EVENT_TYPES, hasOwnMaintainer, maintainerChannel, type ScheduledJob, t, type Task, type TaskActionResult, taskDeleteRefusal, type TaskEventPayload } from "@ergo/protocol";
import { type DeletionParticipants, TASK_DELETION } from "../deletion/participants.ts";
import { RequestRejected } from "../errors.ts";
import type { EventStore } from "../events/event-store.ts";
import { isJobMaintainerId } from "../scheduled-jobs/jobs.ts";
import { listJobs } from "../scheduled-jobs/views.ts";
import { purgedTask } from "./material-sources.ts";
import { getTask, getTaskRecord } from "./views.ts";

/** 删除时要停、要恢复的维护者（任务自己的维护者模块、作业维护者模块，在 daemon.ts 里接上） */
export interface TaskMaintainerSuspension {
  /** 停稳手头这一轮、停掉它：马上不再接输入，之后来的输入也不唤起它；子进程结束后兑现 */
  suspend(maintainerId: string): Promise<void>;
  /** 恢复成能唤起（删除中止时）：有输入等着就唤起 */
  resume(maintainerId: string): void;
}

export interface TaskDeletionDeps {
  store: EventStore;
  /** "删除参与方"登记表：属于这个任务的事件改写成什么、同一事务追加什么 */
  participants: Pick<DeletionParticipants, "plan">;
  maintainers: TaskMaintainerSuspension;
  /** 子 agent（停下这个任务还活着的、它派过哪些）：子 agent 模块建在删除之后，现取 */
  subAgents: () => { stopTask(taskId: string): Promise<void>; agentsOf(taskId: string): string[] };
  /** 停下这个任务在跑的验收（执行控制器的 stopAcceptance：宣布完成时的、交给评审的、重做后复验）：脚本进程杀掉、评审子 agent 结束，收完尾才回 */
  stopAcceptance(taskId: string): Promise<void>;
  /** 还在（没删掉）的项目里由这个维护者维护的那一个：任务转为项目了的、由项目的维护者做的 */
  projectOf(maintainerId: string): { name: string } | undefined;
  /** 项目在用时运营方案里的一条（141 号票）：那句说明；不是的 undefined */
  operationsLock(task: Task): string | undefined;
  /** 取消一个没结束的任务（和 task_action 的取消同一条路：运营中的定时任务落到触发上） */
  cancel(taskId: string, idempotencyKey: string): unknown;
  /** 会话区里某个 agent 的会话目录 */
  sessionDir(agentId: string): string;
  /** 输出区里任务的工作目录（不建） */
  taskDir(taskId: string): string;
  now(): string;
  log(line: string): void;
}

export interface TaskDeletion {
  /** 现在能不能删：不能删的说明，能删的 undefined（网页菜单、秘书的快速动作提出时都按它） */
  refusal(task: Task): string | undefined;
  /** 删掉这个任务（见文件开头）；同一个幂等键重发拿到同一个结果，同一个任务同时删两次的第二次等第一次 */
  delete(taskId: string, idempotencyKey: string): Promise<TaskActionResult>;
}

/** 维护者的会话是不是这个任务自己的（任务自己的维护者、迁移来的定时任务的作业维护者）：是的才停、才删 */
const ownSession = (task: Task) => hasOwnMaintainer(task) || isJobMaintainerId(task.maintainerId);

export function createTaskDeletion(deps: TaskDeletionDeps): TaskDeletion {
  const { store, log } = deps;
  /** 正在删的（按任务）：同一个任务同时删两次的第二次等第一次 */
  const inFlight = new Map<string, Promise<TaskActionResult>>();

  /** 以前的定时作业（19 号票）迁移成了别的定时任务、还在用这个任务的工作目录（作业维护者在 outputs/<建它的任务> 里干活） */
  const legacyJobsUsing = (task: Task): ScheduledJob[] =>
    listJobs(store.reader).filter((j) => j.taskId === task.id && j.ownerTaskId !== undefined && j.ownerTaskId !== task.id && j.state !== "cancelled");

  const refusal = (task: Task): string | undefined => {
    const locked = deps.operationsLock(task);
    if (locked) return locked;
    const blocked = taskDeleteRefusal(task, deps.projectOf);
    if (blocked) return blocked;
    const legacy = legacyJobsUsing(task)[0];
    if (legacy?.ownerTaskId !== undefined) return t("tasks.deletion.legacyJob", { task: legacy.ownerTaskId, title: legacy.title });
    return undefined;
  };

  const remove = async (taskId: string, key: string): Promise<TaskActionResult> => {
    const found = getTask(store.reader, taskId);
    if (!found) throw new RequestRejected("not_found", t("tasks.tasks.noTask", { id: taskId }));
    const why = refusal(found);
    if (why) throw new RequestRejected("not_allowed", why);
    // 1. 先停：没结束的照现有的取消走（取消不了的抛出，什么都不删）
    if (!ENDED_TASK_STATES.includes(found.state)) await deps.cancel(taskId, `${key}#cancel`);
    const own = ownSession(found);
    if (own) await deps.maintainers.suspend(found.maintainerId);
    await deps.subAgents().stopTask(taskId);
    await deps.stopAcceptance(taskId);
    // 2. 复查：停的时候又开始做了（返工、重试）、被别处删了的，整个中止
    const current = getTask(store.reader, taskId);
    if (!current || !ENDED_TASK_STATES.includes(current.state) || refusal(current) !== undefined) {
      if (own) deps.maintainers.resume(found.maintainerId);
      if (!current) throw new RequestRejected("not_found", t("tasks.tasks.noTask", { id: taskId }));
      throw new RequestRejected("conflict", t("tasks.deletion.aborted", { id: taskId }));
    }
    const agents = deps.subAgents().agentsOf(taskId);
    // 改写哪些由登记表定（见文件开头）；没登记改写函数的事件类型在这里抛错，整个删除被拒
    const deletedAt = deps.now();
    const subject = { task: current, conversation: own ? maintainerChannel(current.maintainerId) : undefined, agents: new Set([...(own ? [current.maintainerId] : []), ...agents]) };
    const plan = deps.participants.plan(TASK_DELETION, subject, { deletedAt, materialIds: new Set() });
    const deleted: TaskEventPayload = { task: { ...purgedTask(current), deleted: true, updatedAt: deletedAt }, change: "deleted", from: current.state, by: "user" };
    store.appendBatch([{ channel: CHANNELS.board, type: EVENT_TYPES.task, payload: deleted, idempotencyKey: key }, ...plan.events], { purge: plan.purge });
    for (const step of plan.afterCommit) step();
    // 3. 任务已经删了：再删会话文件和工作目录
    const dirs = [...(own ? [deps.sessionDir(current.maintainerId)] : []), ...agents.map((id) => deps.sessionDir(id)), deps.taskDir(taskId)];
    for (const dir of dirs) {
      try {
        fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
      } catch (err) {
        log(`删除任务 ${taskId} 时删不掉 ${dir}：${err instanceof Error ? err.message : String(err)}`);
      }
    }
    log(`删除了任务 ${taskId}：任务的记录、维护者${own ? ` ${current.maintainerId}` : ""}和子 agent 的会话、工作目录（用户的话在素材的原文副本里）`);
    return { taskId, state: current.state };
  };

  return {
    refusal,
    delete(taskId, key) {
      const done = store.eventByIdempotencyKey(key);
      if (done) {
        const p = done.payload as Partial<TaskEventPayload>;
        if (p.task) return Promise.resolve({ taskId: p.task.id, state: p.task.state });
      }
      // 删过了（别的键删的）：没有这个任务
      const record = getTaskRecord(store.reader, taskId);
      if (record?.deleted && !inFlight.has(taskId)) return Promise.reject(new RequestRejected("not_found", t("tasks.tasks.noTask", { id: taskId })));
      const running = inFlight.get(taskId);
      if (running) return running;
      const job = remove(taskId, key).finally(() => inFlight.delete(taskId));
      inFlight.set(taskId, job);
      return job;
    },
  };
}
