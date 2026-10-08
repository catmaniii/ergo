// 被杀后的恢复（23 号票，规格第 17 节）：LSM 每次重启都连带杀掉守护进程，Job 对象把所有子进程一起清掉；
// 守护进程重新起来后，正在做的事按规则恢复，不乱、也不悄悄重做有副作用的操作。分两步：
//
// 1. scanBeforeStart（任何 agent 会话开始之前）：记下谁被杀时正处理到一半——任务自己的维护者里有输入开始了、
//    还没结束的（agent 会话 start() 时会把它标成"中断"出队，所以要先看）。
// 2. recoverAfterRestart（各模块都接上之后：执行控制器订阅好事件、agent 会话标好中断的输入）：
//    - 待审批的事项从审批表恢复：还待处理、没挂起过的记成挂起（approval_suspended）——审批卡还是原来那张、仍待处理，
//      不新建卡、不再提示用户；任务里的由执行控制器让这一支停下（都在等时任务转等我）。用户事后批准照 07 号票
//      记成一次性授权、唤起 agent 重试（按调用指纹，放行一次）。这次调用不算"说不清做没做完"；
//    - 被杀时正在执行的有副作用的调用（guard-runtime/executions.ts 记着还没结束的）记成中断：任务里的由执行控制器让任务
//      转为等我（原因"中断：不确定 X 是否已执行"），不属于任务的（秘书会话）在待我处理里放一条同样写法的事项；不自动重做；
//    - 被打断的任务维护者（任务还在规划中、执行中，又没有别的输入等着唤起它）：给它一条通知，接着做刚才的事。
//      只读或幂等的调用被打断的，会话文件里补着"这次调用被中断了"，由模型决定要不要重做。
// 会话文件的修补（去掉写到一半的一行、给被中断的工具调用补上结果）在 agent 子进程那一层，重新拉起时做
// （runtime/agent-child/session-recovery.ts；补上的说法由 guard-runtime/executions.ts 的 interruptedToolResults 给）。
// 秘书被打断的那条消息照 04 号票不重送（会话里一条系统说明），排着的输入按原顺序接着处理。
import { hasOwnMaintainer, maintainerChannel, type TaskState } from "@ergou/protocol";
import type { ApprovalService } from "../approvals/approvals.ts";
import { appendAgentNotice } from "../conversation/messages.ts";
import { pendingInputs, startedInputs } from "../conversation/views.ts";
import type { EventStore } from "../events/event-store.ts";
import { interruptionEvents, runningExecutions } from "../guard-runtime/executions.ts";
import type { InboxService } from "../inbox/inbox.ts";
import { taskMessageScope } from "../tasks/stages.ts";
import type { TaskService } from "../tasks/tasks.ts";

/** 被杀时正在处理一条输入的任务维护者 */
export interface InterruptedTurn {
  maintainerId: string;
  taskId: string;
  /** 被打断的那条输入 */
  inputMessageId: string;
}

export interface RestartScan {
  interruptedTurns: InterruptedTurn[];
}

/** 被打断之后接着做：任务还在这两种状态里的，维护者原本就在干活 */
const WAKE_STATES: readonly TaskState[] = ["planning", "running"];

/** 交给被打断的维护者的通知（它的会话里，带上任务） */
export const RESTART_WAKE_TEXT =
  "守护进程重启了，你上一轮没做完就被打断了。会话里被打断的工具调用已经补上了\"被中断\"的结果：只读的查询需要的话再做一次；" +
  "有副作用、说不清做没做完的，运行时已经交给用户确认，不要自己重做。接着刚才的事做。";

/** 第 1 步：任何 agent 会话开始之前，记下被杀时正处理到一半的任务维护者 */
export function scanBeforeStart(store: EventStore, tasks: TaskService): RestartScan {
  const interruptedTurns: InterruptedTurn[] = [];
  for (const task of tasks.list()) {
    if (!hasOwnMaintainer(task)) continue;
    for (const input of startedInputs(store.reader, maintainerChannel(task.maintainerId))) {
      interruptedTurns.push({ maintainerId: task.maintainerId, taskId: task.id, inputMessageId: input.messageId });
    }
  }
  return { interruptedTurns };
}

export interface RecoveryOptions {
  store: EventStore;
  approvals: ApprovalService;
  inbox: InboxService;
  tasks: TaskService;
  now: () => string;
  log: (line: string) => void;
}

/** 恢复了什么（写日志用，测试也看） */
export interface RecoveryReport {
  /** 记成挂起的审批 */
  suspendedApprovals: string[];
  /** 记成中断的有副作用的调用 */
  interruptedCalls: string[];
  /** 唤起接着做的维护者 */
  wokenMaintainers: string[];
}

/** 第 2 步：各模块都接上之后按规则恢复 */
export function recoverAfterRestart(options: RecoveryOptions, scan: RestartScan): RecoveryReport {
  const { store, approvals, inbox, tasks, now, log } = options;
  const report: RecoveryReport = { suspendedApprovals: [], interruptedCalls: [], wokenMaintainers: [] };

  // 待审批的：还待处理、没挂起过的记成挂起（不新建卡、不再提示）
  for (const approval of approvals.list("pending")) {
    if (approval.suspended) continue;
    approvals.suspend(approval.approvalId);
    report.suspendedApprovals.push(approval.approvalId);
  }

  // 被杀时正在执行的有副作用的调用：记成中断（任务里的转等我，秘书会话里的放一条待我处理事项）
  for (const execution of runningExecutions(store.reader)) {
    store.appendBatch(interruptionEvents(inbox, execution, now()));
    report.interruptedCalls.push(execution.toolCallId);
  }

  // 被打断的任务维护者：任务还在规划中、执行中，又没有别的输入等着唤起它，给它一条通知接着做
  for (const turn of scan.interruptedTurns) {
    const task = tasks.get(turn.taskId);
    if (!task || !WAKE_STATES.includes(task.state)) continue;
    const conversation = maintainerChannel(turn.maintainerId);
    if (pendingInputs(store.reader, conversation).length > 0) continue;
    appendAgentNotice(store, conversation, RESTART_WAKE_TEXT, `restart-wake:${turn.inputMessageId}`, taskMessageScope(task));
    report.wokenMaintainers.push(turn.maintainerId);
  }

  const { suspendedApprovals: a, interruptedCalls: c, wokenMaintainers: w } = report;
  if (a.length + c.length + w.length > 0) {
    log(`被杀后的恢复：${a.length} 条审批记成挂起（审批卡仍待处理），${c.length} 次有副作用的调用记成中断，唤起 ${w.length} 个被打断的维护者接着做`);
  }
  return report;
}
