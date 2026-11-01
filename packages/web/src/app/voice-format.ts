// 守护进程这边的语音识别要什么格式：走 audio.cpp 时服务只收 WAV（VoiceModelsView.recognizerInput），录音那边（voice-browser.ts）据此先转好再交出去。
// 单独一个小文件：store 记、录音读，两边不用互相 import。
import type { VoiceModelsView } from "../state/index.ts";

let wantsWav = false;

/** 语音模型的状态来了：记下要不要先转 WAV */
export function noteRecognizerInput(view: Pick<VoiceModelsView, "recognizerInput"> | undefined): void {
  wantsWav = view?.recognizerInput === "wav";
}

/** 现在的语音识别只认 WAV */
export const recognizerWantsWav = (): boolean => wantsWav;
