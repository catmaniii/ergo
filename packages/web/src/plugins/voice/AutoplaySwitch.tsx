// "自动播放 agent 的语音"开关（36 号票）：默认开，只记在这台设备上（和外观一样），改了马上生效。
// 45 号票（用户 2026-10-09 定）从外观下面挪到设置 · 语音的"播放"里，行为不变（存储键照旧是 ergo-voice-autoplay）。
// 开着时，会话里新到的 agent 语音（页面在前台、开着那个会话）自动播放；翻历史、重连补发的不播。
import { pageAutoplaySetting, useAutoplayEnabled } from "../../app/page-voice.ts";
import { t } from "../../state/index.ts";

export function AutoplaySwitch() {
  const enabled = useAutoplayEnabled();
  return (
    <label className="menu-item autoplay-switch">
      <span className="menu-text">
        {t("pages.autoplay.title")}
        <small>{t("pages.autoplay.sub")}</small>
      </span>
      <input type="checkbox" role="switch" checked={enabled} onChange={(e) => pageAutoplaySetting().set(e.currentTarget.checked)} />
    </label>
  );
}
