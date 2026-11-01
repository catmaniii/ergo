// 组件页的语音识别模型和配置里的接入方式：装好、接上之后指过来，删了指回去；**用户自己配的绝不改**。
// 这台开发机上用户真的配了 LSM 模式的 ergo-asr 和手动的 audiocpp，所以"已配的不被改"按字节核对配置文件。
import fs from "node:fs";
import path from "node:path";
import { describe, expect, test } from "vitest";
import { createRecognizerLink } from "../../src/components/recognizer-link.ts";
import { DEFAULT_VOICE_CONFIG, type ErgoConfig, type RecognizeMode, writeRecognizerMode } from "../../src/config/config.ts";
import { makeTempDir } from "../helpers/temp-dir.ts";

function setup(options: { file?: unknown; mode?: RecognizeMode; provided?: string } = {}) {
  const configFile = path.join(makeTempDir("ergo-link-"), "ergo.json");
  if (options.file !== undefined) fs.writeFileSync(configFile, `${JSON.stringify(options.file, null, 2)}\n`);
  const config = { voice: { recognizer: { ...DEFAULT_VOICE_CONFIG.recognizer, mode: options.mode ?? "spawn" } } } as unknown as ErgoConfig;
  const used: RecognizeMode[] = [];
  const lines: string[] = [];
  const link = createRecognizerLink({ config, configFile, provided: () => options.provided, useRecognizer: (mode) => used.push(mode), log: (l) => lines.push(l) });
  const read = () => JSON.parse(fs.readFileSync(configFile, "utf8")) as Record<string, unknown>;
  return { link, config, configFile, used, lines, read };
}

describe("语音识别模型装好、删掉", () => {
  test("没配别的：接上之后写 mode，语音插件当场换；配置文件里别的都留着", () => {
    const original = { ports: { local: 8810 }, voice: { recognizer: { language: "zh", stripPatterns: [] }, speech: { url: "http://127.0.0.1:8090" } } };
    const s = setup({ file: original });
    s.link.connected();
    expect(s.read()).toEqual({ ports: { local: 8810 }, voice: { recognizer: { language: "zh", stripPatterns: [], mode: "audiocpp" }, speech: { url: "http://127.0.0.1:8090" } } });
    expect(s.config.voice.recognizer.mode).toBe("audiocpp");
    expect(s.used).toEqual(["audiocpp"]);
    // 再接上一次（重启服务、点启动）不重复
    s.link.connected();
    expect(s.used).toEqual(["audiocpp"]);
  });

  test("配置文件还不在：新建，只有这一项", () => {
    const s = setup();
    s.link.connected();
    expect(s.read()).toEqual({ voice: { recognizer: { mode: "audiocpp" } } });
  });

  test("删了：写的这一项撤掉，回到默认，语音插件当场换回去；别的留着", () => {
    const s = setup({ file: { voice: { recognizer: { language: "zh", mode: "audiocpp" } } }, mode: "audiocpp" });
    s.link.removed();
    expect(s.read()).toEqual({ voice: { recognizer: { language: "zh" } } });
    expect(s.config.voice.recognizer.mode).toBe("spawn");
    expect(s.used).toEqual(["spawn"]);
  });

  test("删了、配置里只有这一项：连空的 voice 也不留", () => {
    const s = setup({ file: { ports: { local: 8810 }, voice: { recognizer: { mode: "audiocpp" } } }, mode: "audiocpp" });
    s.link.removed();
    expect(s.read()).toEqual({ ports: { local: 8810 } });
  });

  test("已配 LSM 模式的 ergo-asr：接上了也不改，配置文件一个字节都不动；模型删了同样不动", () => {
    const text = `${JSON.stringify({ voice: { recognizer: { mode: "lsm", url: "http://127.0.0.1:8091" } } }, null, 2)}\n`;
    const s = setup({ mode: "lsm", provided: "已有自己配的语音识别" });
    fs.writeFileSync(s.configFile, text);
    const stat = fs.statSync(s.configFile).mtimeMs;
    s.link.connected();
    s.link.removed();
    expect(fs.readFileSync(s.configFile, "utf8")).toBe(text);
    expect(fs.statSync(s.configFile).mtimeMs).toBe(stat);
    expect(s.config.voice.recognizer.mode).toBe("lsm");
    expect(s.used).toEqual([]);
    expect(s.lines.join("\n")).toContain("不改");
  });

  test("已配能用的 Python（spawn）：同样不改", () => {
    const text = `${JSON.stringify({ voice: { recognizer: { mode: "spawn", python: "D:\\\\py\\\\python.exe" } } }, null, 2)}\n`;
    const s = setup({ mode: "spawn", provided: "已有自己配的语音识别" });
    fs.writeFileSync(s.configFile, text);
    s.link.connected();
    s.link.removed();
    expect(fs.readFileSync(s.configFile, "utf8")).toBe(text);
    expect(s.used).toEqual([]);
  });

  test("写不进配置文件（比如是个目录）：记日志，这次运行照样换", () => {
    const s = setup();
    fs.mkdirSync(s.configFile);
    s.link.connected();
    expect(s.used).toEqual(["audiocpp"]);
    expect(s.lines.join("\n")).toContain("没写进配置文件");
  });

  test("configured 就是用户自己配的那句话", () => {
    expect(setup({ provided: "已有自己配的语音识别" }).link.configured()).toBe("已有自己配的语音识别");
    expect(setup().link.configured()).toBeUndefined();
  });
});

describe("写配置文件的 voice.recognizer.mode", () => {
  test("别的内容、别的键的先后都不动", () => {
    const configFile = path.join(makeTempDir("ergo-link-"), "ergo.json");
    fs.writeFileSync(configFile, JSON.stringify({ a: 1, voice: { speech: { url: "x" }, recognizer: { python: "p" }, reply: {} }, z: 2 }));
    writeRecognizerMode(configFile, "audiocpp");
    expect(JSON.parse(fs.readFileSync(configFile, "utf8"))).toEqual({ a: 1, voice: { speech: { url: "x" }, recognizer: { python: "p", mode: "audiocpp" }, reply: {} }, z: 2 });
    writeRecognizerMode(configFile, undefined);
    expect(JSON.parse(fs.readFileSync(configFile, "utf8"))).toEqual({ a: 1, voice: { speech: { url: "x" }, recognizer: { python: "p" }, reply: {} }, z: 2 });
  });
});
