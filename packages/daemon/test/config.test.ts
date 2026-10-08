import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { loadConfig, modelVision, readTokenPrices } from "../src/config/config.ts";
import { DEFAULT_TASK_THRESHOLDS } from "../src/tasks/thresholds.ts";
import { makeTempDir } from "./helpers/temp-dir.ts";

const repoRoot = path.resolve(import.meta.dirname, "../../..");

function writeConfigFile(dataDir: string, content: unknown): void {
  fs.mkdirSync(path.join(dataDir, "config"), { recursive: true });
  fs.writeFileSync(path.join(dataDir, "config", "ergou.json"), JSON.stringify(content));
}

describe("配置", () => {
  it("没有指定时，数据目录默认是用户主目录下的 .ergou", () => {
    const home = makeTempDir();
    const config = loadConfig({ env: {}, homeDir: home });
    expect(config.dataDir).toBe(path.join(home, ".ergou"));
  });

  it("数据目录可以由 ERGOU_DATA_DIR 指定", () => {
    const home = makeTempDir();
    const dataDir = makeTempDir();
    const config = loadConfig({ env: { ERGOU_DATA_DIR: dataDir }, homeDir: home });
    expect(config.dataDir).toBe(dataDir);
  });

  it("数据目录里没有配置文件时，端口取默认值 8810 和 8811", () => {
    const dataDir = makeTempDir();
    const config = loadConfig({ env: { ERGOU_DATA_DIR: dataDir }, homeDir: makeTempDir() });
    expect(config.ports).toEqual({ local: 8810, external: 8811 });
  });

  it("端口号从数据目录里的配置文件读", () => {
    const dataDir = makeTempDir();
    writeConfigFile(dataDir, { ports: { local: 9100, external: 9101 } });
    const config = loadConfig({ env: { ERGOU_DATA_DIR: dataDir }, homeDir: makeTempDir() });
    expect(config.ports).toEqual({ local: 9100, external: 9101 });
  });

  it("配置文件只写一部分时，其余取默认值", () => {
    const dataDir = makeTempDir();
    writeConfigFile(dataDir, { ports: { external: 9201 } });
    const config = loadConfig({ env: { ERGOU_DATA_DIR: dataDir }, homeDir: makeTempDir() });
    expect(config.ports).toEqual({ local: 8810, external: 9201 });
  });

  it("仓库里的示例配置可以原样放进数据目录使用", () => {
    const dataDir = makeTempDir();
    const example = JSON.parse(fs.readFileSync(path.join(repoRoot, "config", "ergou.example.json"), "utf8"));
    writeConfigFile(dataDir, example);
    const config = loadConfig({ env: { ERGOU_DATA_DIR: dataDir }, homeDir: makeTempDir() });
    expect(config.ports).toEqual({ local: 8810, external: 8811 });
  });

  it("token 单价（24 号票）：默认 CNY、没有单价；示例配置里有 deepseek-flash 的；现读配置文件也能读；写错了报错", () => {
    const dataDir = makeTempDir();
    expect(loadConfig({ env: { ERGOU_DATA_DIR: dataDir }, homeDir: makeTempDir() }).tokenPrices).toEqual({ currency: "CNY", models: {} });
    writeConfigFile(dataDir, JSON.parse(fs.readFileSync(path.join(repoRoot, "config", "ergou.example.json"), "utf8")));
    const config = loadConfig({ env: { ERGOU_DATA_DIR: dataDir }, homeDir: makeTempDir() });
    expect(config.tokenPrices.models["deepseek/deepseek-flash"]).toEqual({ cacheHit: expect.any(Number), cacheMiss: expect.any(Number), output: expect.any(Number) });
    const configFile = path.join(dataDir, "config", "ergou.json");
    writeConfigFile(dataDir, { tokenPrices: { currency: "usd", models: { faux: { cacheHit: 0, cacheMiss: 1.5, output: 4 } } } });
    expect(readTokenPrices(configFile)).toEqual({ currency: "USD", models: { faux: { cacheHit: 0, cacheMiss: 1.5, output: 4 } } });
    writeConfigFile(dataDir, { tokenPrices: { models: { faux: { cacheHit: 0, cacheMiss: -1, output: 4 } } } });
    expect(() => readTokenPrices(configFile)).toThrow(/tokenPrices\.models\["faux"\]\.cacheMiss/);
    writeConfigFile(dataDir, { tokenPrices: { currency: "人民币" } });
    expect(() => loadConfig({ env: { ERGOU_DATA_DIR: dataDir }, homeDir: makeTempDir() })).toThrow(/tokenPrices\.currency/);
  });

  it("审批最多等多久：默认 5 分钟，可以在配置里改；写错了报错", () => {
    const dataDir = makeTempDir();
    expect(loadConfig({ env: { ERGOU_DATA_DIR: dataDir }, homeDir: makeTempDir() }).approvalWaitMs).toBe(5 * 60_000);
    writeConfigFile(dataDir, { approvals: { waitMinutes: 2 } });
    expect(loadConfig({ env: { ERGOU_DATA_DIR: dataDir }, homeDir: makeTempDir() }).approvalWaitMs).toBe(2 * 60_000);
    writeConfigFile(dataDir, { approvals: { waitMinutes: 0 } });
    expect(() => loadConfig({ env: { ERGOU_DATA_DIR: dataDir }, homeDir: makeTempDir() })).toThrow(/approvals\.waitMinutes/);
  });

  it("agent 子进程的资源限制：默认上限 8、闲置 10 分钟、模型调用 5 分钟、工具调用 10 分钟、每分钟回收孤儿；可以改；写错了报错", () => {
    const dataDir = makeTempDir();
    expect(loadConfig({ env: { ERGOU_DATA_DIR: dataDir }, homeDir: makeTempDir() }).agentLimits).toEqual({
      maxLive: 8,
      idleMs: 10 * 60_000,
      modelCallMs: 5 * 60_000,
      toolCallMs: 10 * 60_000,
      orphanSweepMs: 60_000,
    });
    writeConfigFile(dataDir, { agents: { maxLive: 3, idleMinutes: 0.5, orphanSweepSeconds: 5 } });
    expect(loadConfig({ env: { ERGOU_DATA_DIR: dataDir }, homeDir: makeTempDir() }).agentLimits).toMatchObject({ maxLive: 3, idleMs: 30_000, orphanSweepMs: 5000, modelCallMs: 5 * 60_000 });
    writeConfigFile(dataDir, { agents: { maxLive: 1 } });
    expect(() => loadConfig({ env: { ERGOU_DATA_DIR: dataDir }, homeDir: makeTempDir() })).toThrow(/agents\.maxLive/);
    writeConfigFile(dataDir, { agents: { toolCallMinutes: -1 } });
    expect(() => loadConfig({ env: { ERGOU_DATA_DIR: dataDir }, homeDir: makeTempDir() })).toThrow(/agents\.toolCallMinutes/);
  });

  it("任务的执行名额：默认全局 3 个，可以改；写错了报错", () => {
    const dataDir = makeTempDir();
    const load = () => loadConfig({ env: { ERGOU_DATA_DIR: dataDir }, homeDir: makeTempDir() }).tasks;
    expect(load().maxRunning).toBe(3);
    writeConfigFile(dataDir, { tasks: { maxRunning: 5 } });
    expect(load().maxRunning).toBe(5);
    writeConfigFile(dataDir, { tasks: { maxRunning: 0 } });
    expect(load).toThrow(/tasks\.maxRunning/);
    writeConfigFile(dataDir, { tasks: { maxRunning: 1.5 } });
    expect(load).toThrow(/tasks\.maxRunning/);
  });

  it("阈值（14 号票）：默认拉回 3 次、催促 3 次、停滞 20 分钟、验收退回 2 次、预算 1 倍说明 2 倍找用户、累计被拒 5 次、到期前 24 小时提醒续期；可以只改一部分；写错了报错", () => {
    const dataDir = makeTempDir();
    const load = () => loadConfig({ env: { ERGOU_DATA_DIR: dataDir }, homeDir: makeTempDir() }).tasks.thresholds;
    expect(load()).toEqual({ pullBacks: 3, nudges: 3, stallMs: 20 * 60_000, acceptanceReturns: 2, budgetExplainTimes: 1, budgetAskTimes: 2, rejections: 5, renewalLeadMs: 24 * 3_600_000 });
    expect(load()).toEqual(DEFAULT_TASK_THRESHOLDS);
    writeConfigFile(dataDir, { tasks: { thresholds: { pullBacks: 5, stallMinutes: 0.5, budgetAskTimes: 3, renewalLeadHours: 2 } } });
    expect(load()).toEqual({ ...DEFAULT_TASK_THRESHOLDS, pullBacks: 5, stallMs: 30_000, budgetAskTimes: 3, renewalLeadMs: 2 * 3_600_000 });
    for (const bad of [{ pullBacks: 0 }, { nudges: 1.5 }, { stallMinutes: -1 }, { rejections: "5" }, { budgetExplainTimes: 3, budgetAskTimes: 2 }, { renewalLeadHours: 0 }]) {
      writeConfigFile(dataDir, { tasks: { thresholds: bad } });
      expect(load).toThrow(/tasks\.thresholds/);
    }
  });

  it("节假日数据的检查：默认 12 月起、每月 1 日 09:00；可以改，只写一部分时其余取默认；写错了报错", () => {
    const dataDir = makeTempDir();
    const load = () => loadConfig({ env: { ERGOU_DATA_DIR: dataDir }, homeDir: makeTempDir() }).holidayCheck;
    expect(load()).toEqual({ fromMonth: 12, dayOfMonth: 1, time: "09:00" });
    writeConfigFile(dataDir, { holidayCheck: { fromMonth: 11, dayOfMonth: 20, time: "08:30" } });
    expect(load()).toEqual({ fromMonth: 11, dayOfMonth: 20, time: "08:30" });
    writeConfigFile(dataDir, { holidayCheck: { dayOfMonth: 15 } });
    expect(load()).toEqual({ fromMonth: 12, dayOfMonth: 15, time: "09:00" });
    writeConfigFile(dataDir, { holidayCheck: { fromMonth: 13 } });
    expect(load).toThrow(/holidayCheck\.fromMonth/);
    writeConfigFile(dataDir, { holidayCheck: { dayOfMonth: 31 } });
    expect(load).toThrow(/holidayCheck\.dayOfMonth/);
    writeConfigFile(dataDir, { holidayCheck: { time: "9 点" } });
    expect(load).toThrow(/holidayCheck\.time/);
  });

  it("带类型的 bash 工具：跑测试、启动构建、装依赖的单次调用超时默认 30 分钟；可以改；写错了报错", () => {
    const dataDir = makeTempDir();
    expect(loadConfig({ env: { ERGOU_DATA_DIR: dataDir }, homeDir: makeTempDir() }).shellTools).toEqual({ longCallMs: 30 * 60_000 });
    writeConfigFile(dataDir, { shellTools: { longCallMinutes: 45 } });
    expect(loadConfig({ env: { ERGOU_DATA_DIR: dataDir }, homeDir: makeTempDir() }).shellTools).toEqual({ longCallMs: 45 * 60_000 });
    writeConfigFile(dataDir, { shellTools: { longCallMinutes: "长一点" } });
    expect(() => loadConfig({ env: { ERGOU_DATA_DIR: dataDir }, homeDir: makeTempDir() })).toThrow(/shellTools\.longCallMinutes/);
  });

  it("语音识别（31 号票）：默认显卡上的 large-v3、int8_float16，退回 CPU 的 small，闲置 5 分钟退出，识别超时按时长和设备算；可以改，只写一部分时其余取默认；写错了报错", () => {
    const dataDir = makeTempDir();
    const load = () => loadConfig({ env: { ERGOU_DATA_DIR: dataDir }, homeDir: makeTempDir() }).voice;
    expect(load()).toMatchObject({
      recognizer: {
        python: "python",
        primary: { device: "cuda", model: "large-v3", computeType: "int8_float16" },
        fallback: { device: "cpu", model: "small", computeType: "int8" },
        idleMs: 5 * 60_000,
        timeout: { baseMs: 30_000, coldStartMs: 60_000, gpuPerAudioSecond: 1, cpuPerAudioSecond: 3 },
        language: "zh",
        initialPrompt: "以下是普通话的句子。",
      },
    });
    writeConfigFile(dataDir, {
      voice: {
        recognizer: { python: "D:\\py\\python.exe", device: "cpu", model: "small", computeType: "int8", fallback: null, idleMinutes: 1, timeout: { coldStartSeconds: 20, cpuPerAudioSecond: 2.5 } },
      },
    });
    expect(load()).toMatchObject({
      recognizer: {
        python: "D:\\py\\python.exe",
        primary: { device: "cpu", model: "small", computeType: "int8" },
        fallback: null,
        idleMs: 60_000,
        timeout: { baseMs: 30_000, coldStartMs: 20_000, gpuPerAudioSecond: 1, cpuPerAudioSecond: 2.5 },
        language: "zh",
      },
    });
    // 示例配置里的 Python 是占位符：配置照样能用，原样留着（识别时报"语音识别不可用"，待我处理里说明）
    writeConfigFile(dataDir, { voice: { recognizer: { python: "<装了 faster-whisper 的 python.exe 的绝对路径>" } } });
    expect(load().recognizer.python).toBe("<装了 faster-whisper 的 python.exe 的绝对路径>");
    for (const wrong of [
      { recognizer: { idleMinutes: 0 } },
      { recognizer: { device: "" } },
      { recognizer: { fallback: "cpu" } },
      { recognizer: { timeout: 300 } },
      { recognizer: { timeout: { gpuPerAudioSecond: 0 } } },
      { recognizer: "cpu" },
      "开",
    ]) {
      writeConfigFile(dataDir, { voice: wrong });
      expect(() => load()).toThrow(/voice/);
    }
  });

  it("语音合成和语音回复（32 号票）：默认用本机 8090 上 audio.cpp 的 tts 模型，超时按冷启动和语音时长算，口语稿超过约 60 秒（按字数估）算长；可以改，只写一部分时其余取默认；写错了报错", () => {
    const dataDir = makeTempDir();
    const load = () => loadConfig({ env: { ERGOU_DATA_DIR: dataDir }, homeDir: makeTempDir() }).voice;
    expect(load()).toMatchObject({
      speech: { url: "http://127.0.0.1:8090", model: "tts", timeout: { baseMs: 15_000, coldStartMs: 90_000, perSpeechSecond: 2 } },
      reply: { maxSeconds: 60, charsPerSecond: 4.5 },
    });
    writeConfigFile(dataDir, { voice: { speech: { url: "http://127.0.0.1:9123/", timeout: { coldStartSeconds: 30 } }, reply: { maxSeconds: 20 } } });
    expect(load()).toMatchObject({
      speech: { url: "http://127.0.0.1:9123", model: "tts", timeout: { baseMs: 15_000, coldStartMs: 30_000, perSpeechSecond: 2 } },
      reply: { maxSeconds: 20, charsPerSecond: 4.5 },
    });
    // 示例配置里的模型 id 是占位符（Fish-Audio S2 Pro 在服务上的模型 id）：配置照样能用，原样留着（合成时报清楚，退回只发文字）
    writeConfigFile(dataDir, JSON.parse(fs.readFileSync(path.join(repoRoot, "config", "ergou.example.json"), "utf8")));
    expect(load().speech.model).toMatch(/^<.*Fish-Audio S2 Pro.*>$/);
    for (const wrong of [
      { speech: { url: "不是地址" } },
      { speech: { url: "ftp://127.0.0.1:8090" } },
      { speech: { model: "" } },
      { speech: { timeout: { baseSeconds: -1 } } },
      { speech: "8090" },
      { reply: { maxSeconds: 0 } },
      { reply: { charsPerSecond: "快" } },
    ]) {
      writeConfigFile(dataDir, { voice: wrong });
      expect(() => load()).toThrow(/voice\.(speech|reply)/);
    }
  });

  it("端口号不合法时报错，并指出是哪个配置文件", () => {
    const dataDir = makeTempDir();
    writeConfigFile(dataDir, { ports: { local: "abc", external: 70000 } });
    expect(() => loadConfig({ env: { ERGOU_DATA_DIR: dataDir }, homeDir: makeTempDir() })).toThrow(/ergou\.json[\s\S]*ports\.local/);
  });

  it("媒体：单个上传文件的上限默认 200 MB，可以改；不合法时报错", () => {
    const dataDir = makeTempDir();
    expect(loadConfig({ env: { ERGOU_DATA_DIR: dataDir }, homeDir: makeTempDir() }).media).toEqual({ maxUploadBytes: 200 * 1024 * 1024 });
    writeConfigFile(dataDir, { media: { maxUploadBytes: 1024 } });
    expect(loadConfig({ env: { ERGOU_DATA_DIR: dataDir }, homeDir: makeTempDir() }).media).toEqual({ maxUploadBytes: 1024 });
    writeConfigFile(dataDir, { media: { maxUploadBytes: "大" } });
    expect(() => loadConfig({ env: { ERGOU_DATA_DIR: dataDir }, homeDir: makeTempDir() })).toThrow(/media\.maxUploadBytes/);
  });

  it("模型能力：支不支持图片输入按「provider/模型 id」配置，没配的一律当不支持", () => {
    const dataDir = makeTempDir();
    expect(modelVision(loadConfig({ env: { ERGOU_DATA_DIR: dataDir }, homeDir: makeTempDir() }), { kind: "catalog", provider: "deepseek", modelId: "deepseek-flash", thinkingLevel: "high" })).toBe(false);
    writeConfigFile(dataDir, { models: { "deepseek/deepseek-flash": { vision: true } } });
    const config = loadConfig({ env: { ERGOU_DATA_DIR: dataDir }, homeDir: makeTempDir() });
    expect(modelVision(config, { kind: "catalog", provider: "deepseek", modelId: "deepseek-flash", thinkingLevel: "high" })).toBe(true);
    expect(modelVision(config, { kind: "catalog", provider: "deepseek", modelId: "deepseek-v4-pro", thinkingLevel: "high" })).toBe(false);
    writeConfigFile(dataDir, { models: { "deepseek/deepseek-flash": { vision: "yes" } } });
    expect(() => loadConfig({ env: { ERGOU_DATA_DIR: dataDir }, homeDir: makeTempDir() })).toThrow(/models\["deepseek\/deepseek-flash"\]\.vision/);
  });

  it("时区（给模型看的消息时间标记用）：默认是本机时区，可以改成别的 IANA 时区名；不认识的报错", () => {
    const dataDir = makeTempDir();
    expect(loadConfig({ env: { ERGOU_DATA_DIR: dataDir }, homeDir: makeTempDir() }).timeZone).toBe(Intl.DateTimeFormat().resolvedOptions().timeZone);
    writeConfigFile(dataDir, { timeZone: "Asia/Singapore" });
    expect(loadConfig({ env: { ERGOU_DATA_DIR: dataDir }, homeDir: makeTempDir() }).timeZone).toBe("Asia/Singapore");
    writeConfigFile(dataDir, { timeZone: "Mars/Olympus" });
    expect(() => loadConfig({ env: { ERGOU_DATA_DIR: dataDir }, homeDir: makeTempDir() })).toThrow(/timeZone/);
  });

  it("本机端口和外网端口不能相同", () => {
    const dataDir = makeTempDir();
    writeConfigFile(dataDir, { ports: { local: 9300, external: 9300 } });
    expect(() => loadConfig({ env: { ERGOU_DATA_DIR: dataDir }, homeDir: makeTempDir() })).toThrow(/不能相同/);
  });

  it("建议卡、提问卡多少天没处理算回避：默认 7 天，可以在配置文件里改", () => {
    const dataDir = makeTempDir();
    expect(loadConfig({ env: { ERGOU_DATA_DIR: dataDir }, homeDir: makeTempDir() }).materials).toEqual({ staleCardDays: 7 });
    writeConfigFile(dataDir, { materials: { staleCardDays: 3 } });
    expect(loadConfig({ env: { ERGOU_DATA_DIR: dataDir }, homeDir: makeTempDir() }).materials).toEqual({ staleCardDays: 3 });
  });

  it("回避天数不合法时报错", () => {
    const dataDir = makeTempDir();
    writeConfigFile(dataDir, { materials: { staleCardDays: 0 } });
    expect(() => loadConfig({ env: { ERGOU_DATA_DIR: dataDir }, homeDir: makeTempDir() })).toThrow(/materials\.staleCardDays/);
  });
});

const load = (dataDir: string) => loadConfig({ env: { ERGOU_DATA_DIR: dataDir }, homeDir: makeTempDir() });

describe("备份的配置", () => {
  it("不配时每晚 03:30 备份，没有同步目录（只做本机备份）", () => {
    expect(load(makeTempDir()).backup).toEqual({ time: "03:30" });
  });

  it("时间和同步目录从配置文件读", () => {
    const dataDir = makeTempDir();
    const syncDir = makeTempDir("ergou-sync-");
    writeConfigFile(dataDir, { backup: { time: "02:15", syncDir } });
    expect(load(dataDir).backup).toEqual({ time: "02:15", syncDir });
  });

  it("示例配置里的同步目录是占位符：配置照样能用，原样留着（备份时在待我处理里提醒换掉）", () => {
    const dataDir = makeTempDir();
    writeConfigFile(dataDir, JSON.parse(fs.readFileSync(path.join(repoRoot, "config", "ergou.example.json"), "utf8")));
    expect(load(dataDir).backup).toEqual({ time: "03:30", syncDir: "<同步目录的绝对路径>" });
  });

  it("时间不是 HH:mm、同步目录不是绝对路径或者放在数据目录里：报错", () => {
    const dataDir = makeTempDir();
    writeConfigFile(dataDir, { backup: { time: "3:30" } });
    expect(() => load(dataDir)).toThrow(/backup\.time 必须是 HH:mm/);
    writeConfigFile(dataDir, { backup: { syncDir: "relative/dir" } });
    expect(() => load(dataDir)).toThrow(/backup\.syncDir 必须是绝对路径/);
    writeConfigFile(dataDir, { backup: { syncDir: path.join(dataDir, "sync") } });
    expect(() => load(dataDir)).toThrow(/backup\.syncDir 不能放在数据目录里/);
  });
});
