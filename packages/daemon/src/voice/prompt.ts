// 语音插件在系统提示里贡献的（214 号票，ADR-0027，照提醒、记忆插件的写法）：
// - 条件"语音"：语音插件在运行时成立。秘书的默认提示（prompts/secretary.md）里讲"问要不要念、用 send_voice 念"的那几句包在它里面
//   （任务做完、跑完自动播报、维护者来信）；插件停用时秘书的提示里就没有这几句（它也没有发语音工具）；
// - send_voice 的工具名占位符（{{send_voice}}）：插件停用也认得、也有值，用户改过的提示里写了不至于出错；
// - 没有片段：要讲的只有几句话，包在条件里就够了。口语总结工具的规矩不在系统提示里（用户发语音时跟在输入后面交给 agent）。
// 说明在设置 · 系统提示里给人看，跟着当前语言（取值函数）；条件的名字是提示文件里的写法（数据），不翻。
import { t } from "@ergo/protocol";
import type { PluginPrompts } from "../prompts/index.ts";
import { SEND_VOICE_TOOL } from "../voice-records/index.ts";

export const voicePrompts: PluginPrompts = {
  plugin: "voice",
  flag: {
    name: "语音", // @i18n-ignore data：条件的名字
    get description() {
      return t("voice.prompt.flag");
    },
  },
  placeholders: [
    {
      name: SEND_VOICE_TOOL,
      value: SEND_VOICE_TOOL,
      get description() {
        return t("voice.prompt.toolName");
      },
    },
  ],
  fragments: [],
};
