// 语音气泡播放条的尺寸（42 号票）：每套风格的 voice-* token 是像素，页面换算成数算框宽、波形格数（state/voice.ts），
// styles/voice.css 按同样的 token 画。经典的取值就是原来写死的那一套（state/voice.ts 的 BASE_VOICE_BAR），表现不变。
// 风格清单里以后加的风格自动算进来。
import { describe, expect, test } from "vitest";
import { BASE_VOICE_BAR } from "../../src/state/index.ts";
import { BASE_STYLE, pxOf, VISUAL_STYLES, voiceBarSizes, voiceBarSizesOf } from "../../src/visual-styles/index.ts";

describe("播放条的尺寸", () => {
  test("经典的 voice-* token 就是状态层的经典尺寸（69 号票写死的那一套：内边距 13、竖线 3、播放键 16、间隔 8、竖条 2 隔 2）", () => {
    expect(voiceBarSizes(BASE_STYLE, BASE_STYLE)).toEqual(BASE_VOICE_BAR);
  });

  test.each(VISUAL_STYLES.map((s) => [s.name, s] as const))("%s：每个尺寸都写成像素、浅深一样，换算得出来", (_name, style) => {
    const sizes = voiceBarSizes(style, BASE_STYLE);
    for (const value of Object.values(sizes)) expect(value).toBeGreaterThanOrEqual(0);
    expect(sizes.bar).toBeGreaterThan(0);
  });

  test("软糖圆角照设计稿 d-chat：播放键 36 的圆、和波形隔 10，竖条 4 隔 3，没有竖线", () => {
    expect(voiceBarSizesOf("candy", VISUAL_STYLES, BASE_STYLE)).toMatchObject({ key: 36, gap: 10, bar: 4, barGap: 3, line: 0 });
  });

  test("不在清单里的风格按经典", () => {
    expect(voiceBarSizesOf("retired-style", VISUAL_STYLES, BASE_STYLE)).toEqual(BASE_VOICE_BAR);
  });

  test.each([
    ["12px", 12],
    ["0", 0],
    ["0px", 0],
    ["2.5px", 2.5],
    ["12", undefined],
    ["1em", undefined],
    ["calc(2px + 1px)", undefined],
  ] as const)("尺寸的写法：%s → %s", (value, px) => {
    expect(pxOf(value)).toBe(px);
  });
});
