// 语音挡不挡 agent 的输入队列（31、208、210 号票的规矩；214 号票起由语音插件回答内核的挡板，见 conversation/input-gate.ts）。
// 只看语音对象（内核的数据契约 voice-records/），守护进程重启后一样。
import { isVoiceSettled, type MessageEnvelope, voiceIdsOf } from "@ergo/protocol";
import type { InputGate } from "../conversation/input-gate.ts";
import type { ReadonlyDatabase } from "../storage/sqlite.ts";
import { getVoice } from "../voice-records/index.ts";

/**
 * 一条消息里的语音这时怎么挡 agent 的输入队列（31、210 号票）：
 * - ready：语音都识别出了结局（完成或失败），能交给 agent。没有语音的消息总是；语音对象找不到的（不该发生）不拦着，交给 agent 时按识别失败投影；
 * - waiting：有语音还在第一次识别（排队、识别中；手动重新识别的也算）：这条等着，后面的也不越过它，保证 agent 按用户说话的先后看
 *   （31 号票"识别完成前这条输入在输入队列里等着"，第一次识别平常几秒钟）；
 * - deferred：没有在第一次识别的，有语音进了自动重试、还没结局（208 号票：等着重试、正在重试）：这条照旧等着，但不再挡后面的——
 *   排在它后面的照先后先交（210 号票，用户 2026-10-20："语音重试期间，我发的文字可以先发给二狗"）；它有了结局，
 *   作为一条新输入排到那时输入队列的末尾（conversation/views.ts 的 agent_inputs），交过去时带一句几点说的、识别晚了（agent-input.ts）
 */
export function voiceGateOf(db: ReadonlyDatabase, message: Pick<MessageEnvelope, "parts">): InputGate {
  let gate: InputGate = "ready";
  for (const voiceId of voiceIdsOf(message.parts)) {
    const voice = getVoice(db, voiceId);
    if (!voice || isVoiceSettled(voice.status)) continue;
    if (voice.autoRetry === undefined) return "waiting";
    gate = "deferred";
  }
  return gate;
}
