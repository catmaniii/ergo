// 设置里外观下面的"自动播放 agent 的语音"开关（36 号票）：默认开，只记在这台设备上（和外观一样），改了马上生效。
// 开着时，会话里新到的 agent 语音（页面在前台、开着那个会话）自动播放；翻历史、重连补发的不播。
import { pageAutoplaySetting, useAutoplayEnabled } from "../../app/page-voice.ts";

export function AutoplaySwitch() {
  const enabled = useAutoplayEnabled();
  return (
    <label className="menu-item autoplay-switch">
      <span className="menu-text">
        自动播放 agent 的语音
        <small>只对这台设备生效；新到的语音回复自动播放，翻历史、重连补发的不播</small>
      </span>
      <input type="checkbox" role="switch" checked={enabled} onChange={(e) => pageAutoplaySetting().set(e.currentTarget.checked)} />
    </label>
  );
}
