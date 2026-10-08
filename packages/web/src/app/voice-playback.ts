// 语音气泡的播放（规格第 22 节，31 号票）：点一下播放或暂停，同一时间只播一条（点另一条，正在播的停下）。
// 整个页面共用一个 <audio>；气泡用 useVoicePlaying 知道自己在不在播。
import { useSyncExternalStore } from "react";

let audio: HTMLAudioElement | undefined;
/** 正在播（或停在中途）的那一条（按语音的媒体 id 认） */
let current: string | undefined;
let playing = false;
const listeners = new Set<() => void>();

const notify = () => {
  for (const listener of listeners) listener();
};

/** 播放或暂停这一条；在播别的就先停下那条 */
export function toggleVoice(id: string, url: string): void {
  if (current === id && audio) {
    const same = audio;
    if (same.paused) void same.play().catch(() => stopped(same));
    else audio.pause();
    return;
  }
  audio?.pause();
  const next = new Audio(url);
  audio = next;
  current = id;
  // 上一条停下的 pause 事件可能比这一条的 play 晚到：只认现在这一条的
  next.addEventListener("play", () => {
    if (audio !== next) return;
    playing = true;
    notify();
  });
  next.addEventListener("pause", () => {
    if (audio !== next) return;
    playing = false;
    notify();
  });
  next.addEventListener("ended", () => stopped(next));
  next.addEventListener("error", () => stopped(next));
  void next.play().catch(() => stopped(next));
}

/** 这一条停了（播完、出错）；已经换成别的那条在播时不管 */
function stopped(which: HTMLAudioElement): void {
  if (audio !== which) return;
  playing = false;
  current = undefined;
  audio = undefined;
  notify();
}

/** 这一条在不在播 */
export function useVoicePlaying(id: string): boolean {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => current === id && playing,
  );
}
