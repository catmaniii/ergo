// "先问我"在子进程这一侧（规格第 9 节"审批流程"）：判定为"先问我"（或"计划里列了才做"而计划里没列）的调用，
// - 先看有没有一次性授权：事后批准的、同一个 agent、同样的调用指纹（指纹里有阶段，授权只在所属阶段有效），
//   并且这次判定命中的关注类别都在当初批准过的类别里——有就用掉、放行一次；
// - 没有就提交审批（审批服务先写审批表、再建审批卡、通知前端），子进程里的这次调用最多等 approvalWaitMs（默认 5 分钟）。
//   期间批准 → 接着执行；拒绝 → 拦下，模型收到"用户拒绝"；超时 → 以"已提交审批，等待用户"拦下，记挂起事件；
// - 不在等的审批（已挂起，或等的时候回合中止了）之后被决定：批准记成一次性授权，往会话里给 agent 递"……已获批准，可以重试"；
//   拒绝同样递一条"……已被用户拒绝"，免得它以为还在等。
// 时钟可注入（等审批的 5 分钟跟着它走）。被杀重启后从审批表恢复在 23 号票。
import type { ApprovalService } from "../approvals/approvals.ts";
import { appendAgentNotice } from "../conversation/messages.ts";
import type { EventStore } from "../events/event-store.ts";
import type { GuardVerdict } from "../runtime/index.ts";
import type { Clock } from "../scheduler/clock.ts";
import { type ApprovalDecidedPayload, type CallOrigin, GUARD_CHANNEL, GUARD_EVENTS } from "./events.ts";
import type { CallState } from "./tool-call-record.ts";

export interface AskRequest {
  origin: CallOrigin;
  state: CallState;
  /** 调用指纹（describe.ts 的 callFingerprint） */
  fingerprint: string;
  /** 这次判定命中的关注类别：id 用来比对一次性授权、记进审批表，名字显示在卡上 */
  categories: { id: string; title: string }[];
  toolTitle: string;
  argsSummary: string;
  /** 守卫的说明 */
  reason: string;
  /** 回子进程的判定 */
  reply: (verdict: GuardVerdict) => void;
  /** 属于哪个接上的会话（回合结束、子进程退出时撤掉它的等待） */
  owner: object;
}

export interface ApprovalWaits {
  /** 有一次性授权就用掉、放行；没有就提交审批，等用户 */
  ask(request: AskRequest): void;
  /** 这次调用不再等了（等的时候回合中止，子进程已按不放行处理）：审批照旧待处理，之后批准就是一次性授权 */
  abandon(state: CallState): void;
  /** 撤掉一个会话的所有等待（回合结束、子进程退出） */
  dropOwner(owner: object): void;
  /** 停止：不再听审批决定，撤掉计时器 */
  stop(): void;
}

export interface ApprovalWaitsOptions {
  store: EventStore;
  approvals: ApprovalService;
  clock: Clock;
  /** 子进程里等审批最多等多久（毫秒） */
  approvalWaitMs: number;
}

interface Wait {
  approvalId: string;
  state: CallState;
  reply: (verdict: GuardVerdict) => void;
  cancelTimer: () => void;
  owner: object;
}

export function createApprovalWaits(options: ApprovalWaitsOptions): ApprovalWaits {
  const { store, approvals, clock, approvalWaitMs } = options;
  const waits = new Map<string, Wait>();
  const waitLabel = approvalWaitMs >= 60_000 ? `${Math.round(approvalWaitMs / 60_000)} 分钟` : `${Math.round(approvalWaitMs / 1000)} 秒`;

  /** 不再等这条审批（审批本身不动） */
  const finish = (wait: Wait) => {
    wait.cancelTimer();
    waits.delete(wait.approvalId);
    approvals.unmarkWaiting(wait.approvalId);
  };

  const onDecided = (p: ApprovalDecidedPayload) => {
    const wait = waits.get(p.approvalId);
    if (wait) {
      finish(wait);
      if (p.decision === "denied") {
        wait.state.outcome = "denied";
        if (p.note !== undefined) wait.state.note = p.note;
        wait.reply({ allow: false, reason: `用户拒绝了这次调用${p.note ? `：${p.note}` : ""}。不要换个写法绕过；需要的话问问用户怎么办。` });
      } else {
        wait.state.outcome = "allowed";
        wait.reply({ allow: true });
      }
      return;
    }
    // 没有调用在等：给 agent 递一条通知
    const conversation = p.origin.conversation;
    if (conversation === null) return;
    const approval = approvals.get(p.approvalId);
    const what = approval ? `${approval.toolTitle}「${approval.argsSummary}」` : `「${p.argsSummary}」`;
    if (p.decision === "denied") {
      appendAgentNotice(
        store,
        conversation,
        `${what}已被用户拒绝${p.note ? `：${p.note}` : ""}。不用再等了，也不要换个写法绕过；需要的话问问用户怎么办。`,
        `approval-denied:${p.approvalId}`,
      );
      return;
    }
    appendAgentNotice(store, conversation, `${what}已获用户批准，可以重试：原样再调用一次会直接放行（只放行一次）。`, `approval-ready:${p.approvalId}`);
  };

  const unsubscribe = store.onAppend((event) => {
    if (event.channel === GUARD_CHANNEL && event.type === GUARD_EVENTS.approvalDecided) onDecided(event.payload as ApprovalDecidedPayload);
  });

  return {
    ask(request) {
      const { origin, state, reply } = request;
      const grant = approvals.oneTimeGrant(
        origin.agentId,
        request.fingerprint,
        request.categories.map((c) => c.id),
      );
      if (grant) {
        approvals.consume(grant.approvalId, state.toolCallId);
        state.outcome = "allowed";
        state.approvalId = grant.approvalId;
        reply({ allow: true });
        return;
      }
      const approval = approvals.request({
        origin,
        toolCallId: state.toolCallId,
        tool: state.toolName,
        args: state.args,
        toolTitle: request.toolTitle,
        argsSummary: request.argsSummary,
        fingerprint: request.fingerprint,
        categories: request.categories,
        reason: request.reason,
      });
      state.outcome = "waiting";
      state.approvalId = approval.approvalId;
      approvals.markWaiting(approval.approvalId);
      const wait: Wait = {
        approvalId: approval.approvalId,
        state,
        reply,
        owner: request.owner,
        cancelTimer: clock.setTimer(clock.now() + approvalWaitMs, () => {
          if (waits.get(approval.approvalId) !== wait) return;
          finish(wait);
          state.outcome = "suspended";
          approvals.suspend(approval.approvalId);
          reply({
            allow: false,
            reason:
              `已提交审批，等待用户：用户 ${waitLabel}内没有处理这次调用（${approval.toolTitle}「${approval.argsSummary}」），这次先不执行。` +
              `审批卡还在待我处理里；用户批准后你会收到"已获批准，可以重试"的通知，到时候原样重试。现在不要换个写法绕过，告诉用户在等他批准。`,
          });
        }),
      };
      waits.set(approval.approvalId, wait);
    },
    abandon(state) {
      const wait = state.approvalId === undefined ? undefined : waits.get(state.approvalId);
      if (wait) finish(wait);
      state.outcome = "aborted";
    },
    dropOwner(owner) {
      // 边遍历边删：Map 的 for…of 会跳过已删掉的项，不会漏也不会重复
      for (const wait of waits.values()) if (wait.owner === owner) finish(wait);
    },
    stop() {
      unsubscribe();
      for (const wait of waits.values()) finish(wait);
    },
  };
}
