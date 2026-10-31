// 组件页的语音识别模型和配置里的接入方式（346 号票，ADR-0039）：模型装好、服务接上之后把 voice.recognizer.mode 指向 audiocpp，告诉语音插件当场换；模型删了指回去。
// **绝不改用户自己配的**：配了 LSM 托管的 ergo-asr、配了能用的 Python（probes.ts 的 voice-recognizer 说了算）时，这里什么都不写，组件也不让装。
// 只碰配置文件的 voice.recognizer.mode 这一项；写不进去（文件被占着……）只记日志、这次运行照样换，下次启动还是原来的，点一次"启动"会再写一遍。
import { DEFAULT_RECOGNIZE_MODE, type ErgoConfig, type RecognizeMode, writeRecognizerMode } from "../config/config.ts";

export interface RecognizerLink {
  /** 用户自己配了别的语音识别：给人看的那句话；没有是 undefined */
  configured(): string | undefined;
  /** 语音识别模型装好了、服务接上了：还没配别的就指过来 */
  connected(): void;
  /** 语音识别模型删了：指着 audiocpp 的话撤掉（回到默认） */
  removed(): void;
}

export function createRecognizerLink(options: {
  config: ErgoConfig;
  configFile: string;
  /** 用户自己配的语音识别（probes.ts 的 voice-recognizer） */
  provided: () => string | undefined;
  /** 语音插件（没启用是 undefined：下次装配时按配置建） */
  useRecognizer: (mode: RecognizeMode) => void;
  log: (line: string) => void;
}): RecognizerLink {
  const { recognizer } = options.config.voice;
  const point = (written: RecognizeMode | undefined, mode: RecognizeMode) => {
    try {
      writeRecognizerMode(options.configFile, written);
    } catch (err) {
      options.log(`语音识别的接入方式没写进配置文件（${err instanceof Error ? err.message : String(err)}），这次运行照样换`);
    }
    recognizer.mode = mode;
    options.useRecognizer(mode);
  };
  return {
    configured: options.provided,
    connected() {
      if (recognizer.mode === "audiocpp") return;
      const configured = options.provided();
      if (configured !== undefined) {
        options.log(`语音识别模型装好了，但已有自己配的（${configured}），不改`);
        return;
      }
      options.log("语音识别模型装好了、服务接上了：语音识别改走 audio.cpp");
      point("audiocpp", "audiocpp");
    },
    removed() {
      if (recognizer.mode !== "audiocpp") return;
      options.log("语音识别模型删了：语音识别的接入方式回到默认");
      point(undefined, DEFAULT_RECOGNIZE_MODE);
    },
  };
}
