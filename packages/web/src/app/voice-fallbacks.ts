// 语音模式里开着的麦克风可能影响 agent 语音的播放：两种兜底（36 号票评审时加，默认都不开，用户在手机上实测后再定）。
// 37 号票起语音模式期间麦克风一直开着（预热），回声消除也开着。浏览器为了回声消除可能把整个页面的音频切进"通话"模式：
// 安卓上播放走通话音量、甚至走听筒；蓝牙耳机切到 SCO（通话音质）；iOS 上录音会话开着时播放的声音变小。
// 要真机对比时改下面的值、重新构建；两种都不开时就是 37 号票原样的"按下即录"。
//   (a) releaseMicWhilePlaying：有语音在播（点气泡或者自动播放）时先关麦克风，播完再预热。
//       代价：播放期间按下"按住 说话"要等"准备中"（麦克风重新打开）；iOS 上反复开关麦克风，系统设置里没有一直允许时
//       可能多弹权限框。
//   (b) disableEchoCancellation：要麦克风时关掉回声消除（降噪、自动增益照旧开着）。
//       代价：外放时可能把正在播的 agent 语音录进自己的语音里。
// 用到它们的是 app/voice-session.ts（经 VoiceSessionEnv.fallbacks，测试里直接给）；真的浏览器的那一份在 voice-browser.ts。

export interface VoiceFallbacks {
  /** (a) 有语音在播时关麦克风，播完再预热 */
  releaseMicWhilePlaying: boolean;
  /** (b) 要麦克风时关掉回声消除 */
  disableEchoCancellation: boolean;
}

/** 页面上用的：默认都不开 */
export const VOICE_FALLBACKS: VoiceFallbacks = {
  releaseMicWhilePlaying: false,
  disableEchoCancellation: false,
};
