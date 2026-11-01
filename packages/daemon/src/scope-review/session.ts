// 两个负责人模块（项目负责人 projects/maintainers.ts、任务自己的负责人 maintainers/maintainers.ts）共用的范围审视接线：
// 拉起会话时交给 AgentSession 的 scopeReview（审视用的模型、审视的说明、此刻的对照物、压缩时的结果存成范围记录），
// 和总是一起传的几样（审视的服务、模型、审视的说明、工单结束时等多久）打成一包。
import type { SessionScopeReviewOptions } from "../conversation/scope-reviews.ts";
import type { PromptRenderer } from "../prompts/index.ts";
import type { ModelSpec } from "../runtime/index.ts";
import type { ScopeOwner, ScopeReview } from "./scope-review.ts";
import { scopeReviewInstructions } from "./texts.ts";

/** 负责人模块要的范围审视 */
export interface MaintainerScopeReview {
  /** 对照物、近期范围记录、存审视的结果 */
  service: ScopeReview;
  /**
   * 审视用的模型（便宜模型；按设置里的"模型"，每次审视时现取）；spawn 是这是它第几次被唤起
   * （和负责人的模型一起数，测试按它给 faux 剧本）
   */
  model: (maintainerId: string, spawn: number) => ModelSpec;
  /** 审视的说明在系统提示的文件里：每次拉起负责人时现读 */
  prompts: PromptRenderer;
  /** 工单结束时的范围审视最多等多久（毫秒） */
  timeoutMs: number;
}

/** 一个负责人会话的范围审视（AgentSession 的 scopeReview）：owner 给出此刻这段工作属于谁 */
export function sessionScopeReview(review: MaintainerScopeReview, maintainerId: string, owner: () => ScopeOwner): SessionScopeReviewOptions {
  return {
    model: (spawn) => review.model(maintainerId, spawn),
    instructions: () => scopeReviewInstructions(review.prompts),
    context: () => review.service.context(owner().ownership),
    // 压缩会话时子进程自己做的审视：存成范围记录（归属是这时的）
    onCompactionReview: (result) => review.service.save(owner(), "compaction", result),
  };
}
