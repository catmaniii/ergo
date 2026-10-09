// 测试用的卡片类型：本票只登记了简单提醒卡，卡片和待我处理的通用机制要一张"要用户处理、能关掉"的卡来测。
// 这里用一个替身登记"建议发起任务"卡（正式的由 12 号票登记；测试里按 replace 登记，正式的登记后照样能用）。
import { Type } from "@ergou/protocol";
import { defineCardType } from "../../src/cards/registry.ts";

export const SuggestTaskFixturePayload = Type.Object({ title: Type.String(), why: Type.String() });

/** 替身："建议发起任务"卡：发起任务（已处理）、不用了（已关闭）；纯文本降级是"建议发起任务：标题（理由）" */
export const suggestTaskFixture = defineCardType({
  type: "suggest_task",
  // 和共享协议包的 CARD_TYPE_VERSIONS 一致（2：卡上可以写涉及的项目，16 号票；3：两个按钮"作为流程""作为长程任务"，58 号票；
  // 4：项目的维护者给的建议卡带着项目，64 号票；替身不用）
  version: 4,
  payload: SuggestTaskFixturePayload,
  actions: {
    start_workflow: { input: undefined, run: () => ({ status: "handled" }) },
    start_task: { input: undefined, run: () => ({ status: "handled" }) },
    dismiss: { input: undefined, run: () => ({ status: "dismissed" }) },
  },
  toText: (p) => `建议发起任务：${p.title}（${p.why}）`,
});
