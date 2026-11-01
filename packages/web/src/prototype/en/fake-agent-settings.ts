// fake-agent-settings.ts 里的字对应的英文。左边是中文原文（有插值的地方写 {}），右边是英文
import type { Phrases } from "./phrases.ts";

export const EN_AGENT_SETTINGS: Phrases = {
  "金额一律保留两位小数；说到「{{项目名}}」的报表时先说本月合计，再和上个月比。": "Amounts always keep two decimals. When talking about reports for “{{project name}}”, give this month's total first, then compare with last month.",
  "【项目档案】（原型里的示例）\n立项书：{}——{}\n进展：最近一次运行 10-06 21:00，甲银行接口 403，等用户重新授权。": "[Project records] (demo sample)\nCharter: {} — {}\nProgress: last run 10-06 21:00, Bank A's API returned 403, waiting for the user to authorize again.",
  "小明": "Xiaoming",
  "个人助理的模型在设置 · 模型里改": "The personal assistant's model is set in Settings · Models",
  "单独配的模型：DeepSeek 的模型目录里没有 {}": "Separately set model: DeepSeek's model catalog doesn't have {}",
  "个人助理一直用 pi": "The personal assistant always uses pi",
  "没有运行时「{}」": "No runtime “{}”",
  "{}没有模型「{}」": "{} has no model “{}”",
  "它用的运行时不能交给官方 App": "Its runtime can't be handed to the official app",
  "它不是从已有的会话接管来的": "It wasn't taken over from an existing session",
  "没有这个参考音色：{}": "No such reference voice: {}",
  "没有这个角色：{}": "No such role: {}",
  "默认角色不能删：先把别的角色设成默认角色": "The default role can't be deleted. Make another role the default first",
  "这个角色还有 agent 在用：{}": "Agents are still using this role: {}",
  "、": ",",
  "没存：\n{}": "Not saved:\n{}",
  "项目「{}」的负责人": "Owner of project “{}”",
  "项目已归档，这里只能看：取消归档后才能改提示词、重置或压缩": "The project is archived, so this is view-only. Unarchive it to change the prompt, reset or compact",
  "{} {}「{}」的负责人": "Owner of {} {} “{}”",
  "任务已经结束，这里只能看：不能改提示词、清空或压缩": "The task has ended, so this is view-only. The prompt can't be changed, cleared or compacted",
};
