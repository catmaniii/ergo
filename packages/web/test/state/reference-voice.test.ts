// 设置 · 语音里参考音色的几句话（472）：长录音导入时自动截一段，音色那一行写"从 2 分 10 秒的录音里截了开头 14.6 秒"，
// 导入成功的提示也说一句；导入框的说明写清长录音会自动截、文件最大多少 MB。中英都有。
import { afterEach, describe, expect, test } from "vitest";
import {
  activeLocaleFrom,
  DEFAULT_LANGUAGE,
  recordingLengthLabel,
  REFERENCE_VOICE_MAX_BYTES,
  referenceVoiceImportedNote,
  referenceVoiceImportHint,
  referenceVoiceTrimNote,
  setActiveLocale,
} from "../../src/state/index.ts";
import { TEST_LOCALES } from "../setup-locales.ts";

const english = () => setActiveLocale(activeLocaleFrom(TEST_LOCALES, "en"));
afterEach(() => setActiveLocale(activeLocaleFrom(TEST_LOCALES, DEFAULT_LANGUAGE)));

const TRIMMED = { name: "示例音色", durationMs: 14_600, trimmedFromMs: 130_000 };

describe("参考音色截过的说法", () => {
  test("原来的录音多长：不到一分钟写秒，一小时以内写几分几秒（整分钟写几分钟），再长只写分钟", () => {
    expect(recordingLengthLabel(45_400)).toBe("45 秒");
    expect(recordingLengthLabel(130_000)).toBe("2 分 10 秒");
    expect(recordingLengthLabel(180_200)).toBe("3 分钟");
    expect(recordingLengthLabel(4_512_000)).toBe("75 分钟");
    english();
    expect(recordingLengthLabel(130_000)).toBe("2 min 10s");
    expect(recordingLengthLabel(45_000)).toBe("45s");
  });

  test("音色那一行和导入成功的提示：截过的写原来多长、截了多少；没截过的照旧", () => {
    expect(referenceVoiceTrimNote(TRIMMED)).toBe("从 2 分 10 秒的录音里截了开头 14.6 秒");
    expect(referenceVoiceImportedNote(TRIMMED)).toBe("已导入参考音色「示例音色」：录音有 2 分 10 秒，自动截了开头 14.6 秒当参考");
    expect(referenceVoiceTrimNote({ durationMs: 8_500 })).toBeUndefined();
    expect(referenceVoiceImportedNote({ name: "示例音色", durationMs: 8_500 })).toBe("已导入参考音色「示例音色」");
    english();
    expect(referenceVoiceTrimNote(TRIMMED)).toBe("First 14.6s of a 2 min 10s recording");
    expect(referenceVoiceImportedNote(TRIMMED)).toBe('Imported reference voice "示例音色": the recording was 2 min 10s, so the first 14.6s were kept as the reference');
  });

  test("导入框的说明：长录音自动截一段（30 秒以上、截 15 秒左右），文件最大多少 MB，不再说「录音要 1–30 秒」", () => {
    const maxMb = REFERENCE_VOICE_MAX_BYTES / 1024 / 1024;
    const zh = referenceVoiceImportHint();
    expect(zh).toContain(`文件最大 ${maxMb} MB`);
    expect(zh).toContain("超过 30 秒的自动截一段");
    expect(zh).toContain("15 秒左右");
    expect(zh).toContain("只有一个人在说话");
    expect(zh).not.toContain("1–30");
    english();
    const en = referenceVoiceImportHint();
    expect(en).toContain(`up to ${maxMb} MB`);
    expect(en).toContain("over 30 seconds is trimmed automatically");
    expect(en).not.toContain("must be");
  });
});
