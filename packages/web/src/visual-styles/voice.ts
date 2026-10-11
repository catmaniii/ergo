// 语音气泡播放条的尺寸（42 号票）：每套风格的 voice-* token（像素）换算成状态层算框宽、波形格数要的数
// （state/voice.ts 的 VoiceBarSizes）。styles/voice.css 按同样的 token 画，两边对得上；页面（ui/conversation/VoiceBubble.tsx）
// 按现在这套风格取。纯数据和纯函数。
import type { VoiceBarSizes } from "../state/voice.ts";
import { type BaseVisualStyle, effectiveTokens, type TokenName, tokenValue, type VisualStyle } from "./tokens.ts";

/** 每个尺寸对应的 token */
export const VOICE_BAR_TOKENS: Readonly<Record<keyof VoiceBarSizes, TokenName>> = {
  pad: "voice-pad",
  line: "voice-line",
  key: "voice-key",
  gap: "voice-gap",
  bar: "voice-bar",
  barGap: "voice-bar-gap",
};

/** 尺寸的写法："12px"、"0"（calc()、em 这类换算不成数）；别的写法给 undefined */
export function pxOf(value: string): number | undefined {
  const m = /^\s*(\d+(?:\.\d+)?)(px)?\s*$/.exec(value);
  if (!m || (m[2] === undefined && Number(m[1]) !== 0)) return undefined;
  return Number(m[1]);
}

/** 一套风格的播放条尺寸（没写的沿用经典的）；token 不是像素、浅深不一样就报错（test/visual-styles/voice.test.ts 查每套风格） */
export function voiceBarSizes(style: VisualStyle, base: BaseVisualStyle): VoiceBarSizes {
  const tokens = effectiveTokens(style, base);
  const sizes: Partial<Record<keyof VoiceBarSizes, number>> = {};
  for (const [key, name] of Object.entries(VOICE_BAR_TOKENS) as [keyof VoiceBarSizes, TokenName][]) {
    const value = tokenValue(tokens[name], "light");
    const px = pxOf(value);
    if (px === undefined || value !== tokenValue(tokens[name], "dark")) throw new Error(`${style.name}的 --${name} 是 ${value}：要写成像素，浅深一样`);
    sizes[key] = px;
  }
  return sizes as VoiceBarSizes;
}

/** 风格清单里按 id 找一套风格的播放条尺寸：清单里没有（删掉的风格、改过的值）就按经典 */
export function voiceBarSizesOf(styleId: string, styles: readonly VisualStyle[], base: BaseVisualStyle): VoiceBarSizes {
  return voiceBarSizes(styles.find((s) => s.id === styleId) ?? base, base);
}
