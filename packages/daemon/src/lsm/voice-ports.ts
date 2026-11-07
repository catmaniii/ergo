// 二狗在用的语音服务的本机端口：认"和二狗有关的服务"第 3 条要用（@ergo/protocol 的 ergo-related.ts；设置 · 服务一页 428、
// 体检的"托管的服务" 410 共用）。语音插件启用着才算在用：合成是 voice.speech.url；识别是服务管家托管的那条（mode lsm 的
// recognizer.url）或 audio.cpp 上的（mode audiocpp，和合成同一个服务、同一个端口），二狗自己拉起的 Python（spawn）不归服务管家。
// 地址不是本机的（局域网、别的机器）不算：服务管家只管这台电脑上的。
import { localPortOf } from "@ergo/protocol";
import type { VoiceConfig } from "../config/config.ts";

export interface VoicePortsInUse {
  speechPort?: number;
  recognizerPort?: number;
}

/** voiceOn：语音插件启用着；speechUrl：测试换掉的合成地址（不给用配置里的） */
export function voicePortsInUse(voice: Pick<VoiceConfig, "speech" | "recognizer">, options: { voiceOn: boolean; speechUrl?: string | undefined }): VoicePortsInUse {
  if (!options.voiceOn) return {};
  const speechPort = localPortOf(options.speechUrl ?? voice.speech.url);
  const { mode, url } = voice.recognizer;
  const recognizerPort = mode === "lsm" ? localPortOf(url) : mode === "audiocpp" ? speechPort : undefined;
  return { ...(speechPort === undefined ? {} : { speechPort }), ...(recognizerPort === undefined ? {} : { recognizerPort }) };
}
