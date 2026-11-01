// 测试用的卡片类型：这里只登记了简单提醒卡，卡片和待我处理的通用机制要一张"要用户处理、能关掉"的卡来测。
// 这里用一个替身登记"建议发起任务"卡（正式的由任务模块登记；测试里按 replace 登记，正式的登记后照样能用）。
import { Type } from "@ergo/protocol";
import { defineCardType } from "../../src/cards/registry.ts";

export const SuggestTaskFixturePayload = Type.Object({ title: Type.String(), why: Type.String() });

/** 替身："建议发起任务"卡：发起任务（已处理）、不用了（已关闭）；纯文本降级是"建议发起任务：标题（理由）" */
export const suggestTaskFixture = defineCardType({
  type: "suggest_task",
  // 和共享协议包的 CARD_TYPE_VERSIONS 一致（2：卡上可以写涉及的项目，3：两个按钮"作为流程""作为长程任务"，
  // 4：项目的负责人给的建议卡带着项目，替身不用）
  version: 4,
  payload: SuggestTaskFixturePayload,
  actions: {
    start_workflow: { input: undefined, run: () => ({ status: "handled" }) },
    start_task: { input: undefined, run: () => ({ status: "handled" }) },
    dismiss: { input: undefined, run: () => ({ status: "dismissed" }) },
  },
  toText: (p) => `建议发起任务：${p.title}（${p.why}）`,
});
