// 语音的数据契约（214 号票：语音拆成插件之后留在内核的那部分）。语音插件（voice/）停用了、没装上，这些照样在：
// - 两个派生视图：用户的语音对象（voices，views.ts）、agent 的语音对象（agent_voices，agent-views.ts）——内核登记（daemon.ts），
//   插件停用时也照样更新、彻底删除时照样重放：历史里的语音气泡照样投影成识别出的文字、带上合成好的音频（主会话定的第 2、3 条）；
// - 读取函数：会话的投影（conversation/agent-input.ts：语音换成识别出的文字，没有结局的按识别失败）、历史分页、排队交出去时
//   只有识别失败的语音的消息不进输入队列（message-queue.ts）、用户的原话（user-words.ts）、快速动作里用户说的话、任务做完时
//   上一轮念过没有（secretary/task-done.ts）；
// - 素材来源、彻底删除的改写函数（contract.ts）：语音插件在它的数据契约里登记（ADR-0027，停用也不撤）；设置里成批删除时
//   范围里没有素材的语音（voicePurgeTargets）内核直接用；
// - 名字（names.ts）：发语音工具在调用记录里的名字。
// 语音挡不挡输入队列（208、210 号票的规矩）、识别、合成、语音回复都是插件的；插件不在时输入队列的挡板见 conversation/input-gate.ts。
// 会话那几个模块（conversation/）直接从 views.ts、agent-views.ts、names.ts 取：contract.ts 要用会话的视图，经这里会绕成循环 import。
export {
  failedVoiceOnlyMessage,
  getVoice,
  lateVoicesIn,
  onlyVoiceParts,
  unsettledVoices,
  unsettledVoicesOf,
  voicesIn,
  voicesOfMessages,
  voicesView,
} from "./views.ts";
export { agentVoicesIn, agentVoicesOfMessages, agentVoicesView, getAgentVoice, recentToolVoices, toolVoicesAwaitingTurnEnd, toolVoicesOfTurn, unsettledAgentVoices } from "./agent-views.ts";
export { purgedVoice, VOICE_TRANSCRIPT_CONTEXT, voiceMaterialSource, voicePurge, voicePurgeTargets, voiceRetryNoticeKey } from "./contract.ts";
export { SEND_VOICE_TOOL } from "./names.ts";
