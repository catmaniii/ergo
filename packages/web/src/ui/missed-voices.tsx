/**
 * 不在时念的语音（109 号票）：秘书会话里有没看过、这台设备上也没放过的语音气泡（不在时到的，所以没自动播）时，
 * 输入框上面一条小栏："你不在时<名字>念了 1 段语音（1 分 06 秒）  ▶ 播放 · 定位"（名字是名字标签；窄屏放不下时两个按钮换到第二行）。点播放从第一段开始放（几段接着放），
 * 点定位滚到那条气泡；放过、或者用户自己点了那条气泡，小栏就没了（哪几段、写什么由状态层的 missedVoiceBar 算，
 * 什么时候收进来、拿掉在 app/secretary-unread.ts）。不直接自动播：用户可能在不方便出声的地方，浏览器也要点一下才肯出声。
 * 107 号票的"等你处理"栏也在输入框上面：都在时上下排着（各自 flex: none 占一行），不互相盖。
 */
import { type MissedVoiceBar, t } from "../state/index.ts";
import { NamedText } from "./assistant-name.tsx";

export function MissedVoices({ bar, onPlay, onLocate }: { bar: MissedVoiceBar; onPlay(): void; onLocate: (() => void) | undefined }) {
  return (
    <div className="missed-voices" role="status">
      <span className="missed-voices-text">
        <NamedText text={bar.text} />
      </span>
      <span className="missed-voices-acts">
        <button type="button" className="link" onClick={onPlay}>
          {t("ui.missedVoices.play")}
        </button>
        {onLocate && (
          <>
            <span aria-hidden="true">·</span>
            <button type="button" className="link" onClick={onLocate}>
              {t("ui.missedVoices.locate")}
            </button>
          </>
        )}
      </span>
    </div>
  );
}
