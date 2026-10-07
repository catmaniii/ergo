// 测试用的卡片类型：本票只登记了简单提醒卡，卡片和待我处理的通用机制要一张"要用户处理、能关掉"的卡来测。
// 这里用一个替身登记"建议发起任务"卡（正式的由 12 号票登记；测试里按 replace 登记，正式的登记后照样能用）。
import { Type } from "@ergou/protocol";
import { defineCardType } from "../../src/cards/registry.ts";

export const SuggestTaskFixturePayload = Type.Object({ title: Type.String(), why: Type.String() });

/** 替身："建议发起任务"卡：发起任务（已处理）、不用了（已关闭）；纯文本降级是"建议发起任务：标题（理由）" */
export const suggestTaskFixture = defineCardType({
  type: "suggest_task",
  version: 1,
  payload: SuggestTaskFixturePayload,
  actions: {
    start_task: { run: () => ({ status: "handled" }) },
    dismiss: { run: () => ({ status: "dismissed" }) },
  },
  toText: (p) => `建议发起任务：${p.title}（${p.why}）`,
});
