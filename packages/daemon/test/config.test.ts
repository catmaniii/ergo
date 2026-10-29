import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { loadConfig, readTokenPrices, writePluginsConfig } from "../src/config/config.ts";
import { dataDirLayout } from "../src/config/data-dir.ts";
import { DEFAULT_REMINDER_THRESHOLDS } from "../src/reminders/thresholds.ts";
import { DEFAULT_EVENT_SOURCE_THRESHOLDS } from "../src/event-sources/index.ts";
import { DEFAULT_SCHEDULED_JOB_THRESHOLDS } from "../src/scheduled-jobs/index.ts";
import { DEFAULT_TASK_THRESHOLDS } from "../src/tasks/thresholds.ts";
import { makeTempDir } from "./helpers/temp-dir.ts";

const repoRoot = path.resolve(import.meta.dirname, "../../..");

function writeConfigFile(dataDir: string, content: unknown): void {
  fs.mkdirSync(path.join(dataDir, "config"), { recursive: true });
  fs.writeFileSync(path.join(dataDir, "config", "ergo.json"), JSON.stringify(content));
}

describe("配置", () => {
  it("没有指定时，数据目录默认是用户主目录下的 .ergo", () => {
    const home = makeTempDir();
    const config = loadConfig({ env: {}, homeDir: home });
    expect(config.dataDir).toBe(path.join(home, ".ergo"));
  });

  it("数据目录可以由 ERGO_DATA_DIR 指定", () => {
    const home = makeTempDir();
    const dataDir = makeTempDir();
    const config = loadConfig({ env: { ERGO_DATA_DIR: dataDir }, homeDir: home });
    expect(config.dataDir).toBe(dataDir);
  });

  it("数据目录里没有配置文件时，端口取默认值 8810 和 8811", () => {
    const dataDir = makeTempDir();
    const config = loadConfig({ env: { ERGO_DATA_DIR: dataDir }, homeDir: makeTempDir() });
    expect(config.ports).toEqual({ local: 8810, external: 8811 });
  });

  it("端口号从数据目录里的配置文件读", () => {
    const dataDir = makeTempDir();
    writeConfigFile(dataDir, { ports: { local: 9100, external: 9101 } });
    const config = loadConfig({ env: { ERGO_DATA_DIR: dataDir }, homeDir: makeTempDir() });
    expect(config.ports).toEqual({ local: 9100, external: 9101 });
  });

  it("配置文件只写一部分时，其余取默认值", () => {
    const dataDir = makeTempDir();
    writeConfigFile(dataDir, { ports: { external: 9201 } });
    const config = loadConfig({ env: { ERGO_DATA_DIR: dataDir }, homeDir: makeTempDir() });
    expect(config.ports).toEqual({ local: 8810, external: 9201 });
  });

  it("仓库里的示例配置可以原样放进数据目录使用", () => {
    const dataDir = makeTempDir();
    const example = JSON.parse(fs.readFileSync(path.join(repoRoot, "config", "ergo.example.json"), "utf8"));
    writeConfigFile(dataDir, example);
    const config = loadConfig({ env: { ERGO_DATA_DIR: dataDir }, homeDir: makeTempDir() });
    expect(config.ports).toEqual({ local: 8810, external: 8811 });
  });

  it("token 单价（24 号票）：默认 CNY、没有单价；示例配置里也不写（没写的用框架自带的价格表，94 号票）；现读配置文件也能读；写错了报错", () => {
    const dataDir = makeTempDir();
    expect(loadConfig({ env: { ERGO_DATA_DIR: dataDir }, homeDir: makeTempDir() }).tokenPrices).toEqual({ currency: "CNY", models: {} });
    writeConfigFile(dataDir, JSON.parse(fs.readFileSync(path.join(repoRoot, "config", "ergo.example.json"), "utf8")));
    const config = loadConfig({ env: { ERGO_DATA_DIR: dataDir }, homeDir: makeTempDir() });
    expect(config.tokenPrices).toEqual({ currency: "CNY", models: {} });
    const configFile = path.join(dataDir, "config", "ergo.json");
    writeConfigFile(dataDir, { tokenPrices: { currency: "usd", models: { faux: { cacheHit: 0, cacheMiss: 1.5, output: 4 } } } });
    expect(readTokenPrices(configFile)).toEqual({ currency: "USD", models: { faux: { cacheHit: 0, cacheMiss: 1.5, output: 4 } } });
    writeConfigFile(dataDir, { tokenPrices: { models: { faux: { cacheHit: 0, cacheMiss: -1, output: 4 } } } });
    expect(() => readTokenPrices(configFile)).toThrow(/tokenPrices\.models\["faux"\]\.cacheMiss/);
    writeConfigFile(dataDir, { tokenPrices: { currency: "人民币" } });
    expect(() => loadConfig({ env: { ERGO_DATA_DIR: dataDir }, homeDir: makeTempDir() })).toThrow(/tokenPrices\.currency/);
  });

  it("审批最多等多久：默认 5 分钟，可以在配置里改；写错了报错", () => {
    const dataDir = makeTempDir();
    expect(loadConfig({ env: { ERGO_DATA_DIR: dataDir }, homeDir: makeTempDir() }).approvalWaitMs).toBe(5 * 60_000);
    writeConfigFile(dataDir, { approvals: { waitMinutes: 2 } });
    expect(loadConfig({ env: { ERGO_DATA_DIR: dataDir }, homeDir: makeTempDir() }).approvalWaitMs).toBe(2 * 60_000);
    writeConfigFile(dataDir, { approvals: { waitMinutes: 0 } });
    expect(() => loadConfig({ env: { ERGO_DATA_DIR: dataDir }, homeDir: makeTempDir() })).toThrow(/approvals\.waitMinutes/);
  });

  it("agent 子进程的资源限制：默认上限 8、闲置 10 分钟、模型调用 5 分钟、工具调用 10 分钟、每分钟回收孤儿、agent-browser 闲 30 分钟回收；可以改；写错了报错", () => {
    const dataDir = makeTempDir();
    expect(loadConfig({ env: { ERGO_DATA_DIR: dataDir }, homeDir: makeTempDir() }).agentLimits).toEqual({
      maxLive: 8,
      idleMs: 10 * 60_000,
      modelCallMs: 5 * 60_000,
      toolCallMs: 10 * 60_000,
      orphanSweepMs: 60_000,
      browserIdleMs: 30 * 60_000,
    });
    writeConfigFile(dataDir, { agents: { maxLive: 3, idleMinutes: 0.5, orphanSweepSeconds: 5, browserIdleMinutes: 5 } });
    expect(loadConfig({ env: { ERGO_DATA_DIR: dataDir }, homeDir: makeTempDir() }).agentLimits).toMatchObject({
      maxLive: 3,
      idleMs: 30_000,
      orphanSweepMs: 5000,
      modelCallMs: 5 * 60_000,
      browserIdleMs: 5 * 60_000,
    });
    writeConfigFile(dataDir, { agents: { browserIdleMinutes: 0 } });
    expect(() => loadConfig({ env: { ERGO_DATA_DIR: dataDir }, homeDir: makeTempDir() })).toThrow(/agents\.browserIdleMinutes/);
    writeConfigFile(dataDir, { agents: { maxLive: 1 } });
    expect(() => loadConfig({ env: { ERGO_DATA_DIR: dataDir }, homeDir: makeTempDir() })).toThrow(/agents\.maxLive/);
    writeConfigFile(dataDir, { agents: { toolCallMinutes: -1 } });
    expect(() => loadConfig({ env: { ERGO_DATA_DIR: dataDir }, homeDir: makeTempDir() })).toThrow(/agents\.toolCallMinutes/);
  });

  it("任务的执行名额：默认全局 3 个，可以改；写错了报错", () => {
    const dataDir = makeTempDir();
    const load = () => loadConfig({ env: { ERGO_DATA_DIR: dataDir }, homeDir: makeTempDir() }).tasks;
    expect(load().maxRunning).toBe(3);
    writeConfigFile(dataDir, { tasks: { maxRunning: 5 } });
    expect(load().maxRunning).toBe(5);
    writeConfigFile(dataDir, { tasks: { maxRunning: 0 } });
    expect(load).toThrow(/tasks\.maxRunning/);
    writeConfigFile(dataDir, { tasks: { maxRunning: 1.5 } });
    expect(load).toThrow(/tasks\.maxRunning/);
  });

  it("阈值（14 号票）：默认拉回 3 次、催促 3 次、停滞 20 分钟、验收退回 2 次、预算 1 倍说明 2 倍找用户（93 号票起预算控制默认关）、累计被拒 5 次、到期前 24 小时提醒续期、结束超过 7 天进归档清单（19 号票）；可以只改一部分；写错了报错", () => {
    const dataDir = makeTempDir();
    const load = () => loadConfig({ env: { ERGO_DATA_DIR: dataDir }, homeDir: makeTempDir() }).tasks.thresholds;
    expect(load()).toEqual({ pullBacks: 3, nudges: 3, stallMs: 20 * 60_000, acceptanceReturns: 2, budgetExplainTimes: 1, budgetAskTimes: 2, budgetControl: false, rejections: 5, renewalLeadMs: 24 * 3_600_000, archiveAfterDays: 7 });
    expect(load()).toEqual(DEFAULT_TASK_THRESHOLDS);
    writeConfigFile(dataDir, { tasks: { thresholds: { pullBacks: 5, stallMinutes: 0.5, budgetAskTimes: 3, renewalLeadHours: 2 } } });
    expect(load()).toEqual({ ...DEFAULT_TASK_THRESHOLDS, pullBacks: 5, stallMs: 30_000, budgetAskTimes: 3, renewalLeadMs: 2 * 3_600_000 });
    // 预算控制（93 号票）：默认关，写 true 打开
    writeConfigFile(dataDir, { tasks: { thresholds: { budgetControl: true } } });
    expect(load()).toEqual({ ...DEFAULT_TASK_THRESHOLDS, budgetControl: true });
    for (const bad of [{ pullBacks: 0 }, { nudges: 1.5 }, { stallMinutes: -1 }, { rejections: "5" }, { budgetExplainTimes: 3, budgetAskTimes: 2 }, { renewalLeadHours: 0 }, { archiveAfterDays: "7" }, { budgetControl: "on" }]) {
      writeConfigFile(dataDir, { tasks: { thresholds: bad } });
      expect(load).toThrow(/tasks\.thresholds/);
    }
  });

  it("提醒和定时作业的阈值（06、19 号票）：默认晚了 60 分钟以内的提醒照发、定时作业连续失败 3 次自动暂停、任务结束超过 7 天进归档清单；各自可以改；写错了报错", () => {
    const dataDir = makeTempDir();
    const load = () => {
      const config = loadConfig({ env: { ERGO_DATA_DIR: dataDir }, homeDir: makeTempDir() });
      return { reminders: config.reminders, scheduledJobs: config.scheduledJobs, archiveAfterDays: config.tasks.thresholds.archiveAfterDays };
    };
    expect(load()).toEqual({ reminders: { lateLimitMinutes: 60 }, scheduledJobs: { jobFailures: 3 }, archiveAfterDays: 7 });
    expect(load()).toMatchObject({ reminders: DEFAULT_REMINDER_THRESHOLDS, scheduledJobs: DEFAULT_SCHEDULED_JOB_THRESHOLDS });
    writeConfigFile(dataDir, { reminders: { lateLimitMinutes: 30 }, scheduledJobs: { jobFailures: 5 }, tasks: { thresholds: { archiveAfterDays: 14 } } });
    expect(load()).toEqual({ reminders: { lateLimitMinutes: 30 }, scheduledJobs: { jobFailures: 5 }, archiveAfterDays: 14 });
    for (const [section, bad] of [
      ["reminders", []],
      ["reminders", { lateLimitMinutes: 0 }],
      ["scheduledJobs", { jobFailures: 1.5 }],
      ["scheduledJobs", "3"],
    ] as const) {
      writeConfigFile(dataDir, { [section]: bad });
      expect(load).toThrow(new RegExp(section));
    }
  });

  it("事件来源的阈值（77 号票，各归各的模块：eventSources）：文件夹的变化安静 2 秒才算、看不到时 30 秒再看、一次运行最多 100 步；可以改；写错了报错；以前写在 scheduledJobs 里的 folderSettleMs 照旧认", () => {
    const dataDir = makeTempDir();
    const load = () => loadConfig({ env: { ERGO_DATA_DIR: dataDir }, homeDir: makeTempDir() }).eventSources;
    expect(load()).toEqual({ folderSettleMs: 2000, folderRetryMs: 30_000, maxRunSteps: 100 });
    expect(load()).toEqual(DEFAULT_EVENT_SOURCE_THRESHOLDS);
    writeConfigFile(dataDir, { eventSources: { folderSettleMs: 500, folderRetryMs: 1000, maxRunSteps: 12 } });
    expect(load()).toEqual({ folderSettleMs: 500, folderRetryMs: 1000, maxRunSteps: 12 });
    // 77 号票开发时写在 scheduledJobs 里的：eventSources 里没写就照旧认，写了的以 eventSources 为准
    writeConfigFile(dataDir, { scheduledJobs: { jobFailures: 3, folderSettleMs: 700 } });
    expect(load().folderSettleMs).toBe(700);
    writeConfigFile(dataDir, { scheduledJobs: { folderSettleMs: 700 }, eventSources: { folderSettleMs: 900 } });
    expect(load().folderSettleMs).toBe(900);
    for (const bad of [[], { folderSettleMs: 0 }, { folderRetryMs: 1.5 }, { maxRunSteps: "100" }]) {
      writeConfigFile(dataDir, { eventSources: bad });
      expect(load).toThrow(/eventSources/);
    }
    writeConfigFile(dataDir, { scheduledJobs: { folderSettleMs: 0 } });
    expect(load).toThrow(/scheduledJobs\.folderSettleMs/);
  });

  it("节假日数据的检查：默认 12 月起、每月 1 日 09:00；可以改，只写一部分时其余取默认；写错了报错", () => {
    const dataDir = makeTempDir();
    const load = () => loadConfig({ env: { ERGO_DATA_DIR: dataDir }, homeDir: makeTempDir() }).holidayCheck;
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

  it("对话审批的开关（70 号票）：默认关着（off），可以改成 on；写错了报错", () => {
    const dataDir = makeTempDir();
    const load = () => loadConfig({ env: { ERGO_DATA_DIR: dataDir }, homeDir: makeTempDir() }).guard;
    expect(load()).toEqual({ conversationApprovals: "off" });
    writeConfigFile(dataDir, { guard: { conversationApprovals: "on" } });
    expect(load()).toEqual({ conversationApprovals: "on" });
    writeConfigFile(dataDir, { guard: { conversationApprovals: true } });
    expect(load).toThrow(/guard\.conversationApprovals 必须是 "off" 或 "on"/);
    writeConfigFile(dataDir, { guard: "off" });
    expect(load).toThrow(/guard 必须是一个对象/);
  });

  it("插件（126 号票）：默认全开（disabled、removed 是空的），写插件名停用、移除（211 号票）；示例配置里也是空的；写错了报错", () => {
    const dataDir = makeTempDir();
    const load = () => loadConfig({ env: { ERGO_DATA_DIR: dataDir }, homeDir: makeTempDir() }).plugins;
    expect(load()).toEqual({ disabled: [], removed: [] });
    writeConfigFile(dataDir, JSON.parse(fs.readFileSync(path.join(repoRoot, "config", "ergo.example.json"), "utf8")));
    expect(load()).toEqual({ disabled: [], removed: [] });
    writeConfigFile(dataDir, { plugins: { disabled: [" reminders "], removed: ["memory"] } });
    expect(load()).toEqual({ disabled: ["reminders"], removed: ["memory"] });
    for (const bad of [{ disabled: "reminders" }, { disabled: [1] }, { disabled: [""] }]) {
      writeConfigFile(dataDir, { plugins: bad });
      expect(load).toThrow(/plugins\.disabled 必须是插件名的数组/);
    }
    writeConfigFile(dataDir, { plugins: { removed: [2] } });
    expect(load).toThrow(/plugins\.removed 必须是插件名的数组/);
    writeConfigFile(dataDir, { plugins: ["reminders"] });
    expect(load).toThrow(/plugins 必须是一个对象/);
  });

  it("设置 · 插件写配置（211 号票）：只换 plugins 里的 disabled、removed，别的内容原样留着；两项都空时去掉；没有配置文件就新建", () => {
    const dataDir = makeTempDir();
    const file = dataDirLayout(dataDir).configFile;
    const load = () => loadConfig({ env: { ERGO_DATA_DIR: dataDir }, homeDir: makeTempDir() }).plugins;
    writePluginsConfig(file, { disabled: ["reminders"], removed: [] });
    expect(JSON.parse(fs.readFileSync(file, "utf8"))).toEqual({ plugins: { disabled: ["reminders"] } });
    writeConfigFile(dataDir, { ports: { local: 9810, external: 9811 }, plugins: { disabled: ["x"], note: "留着" } });
    writePluginsConfig(file, { disabled: ["reminders"], removed: ["memory"] });
    expect(JSON.parse(fs.readFileSync(file, "utf8"))).toEqual({ ports: { local: 9810, external: 9811 }, plugins: { note: "留着", disabled: ["reminders"], removed: ["memory"] } });
    expect(load()).toEqual({ disabled: ["reminders"], removed: ["memory"] });
    writePluginsConfig(file, { disabled: [], removed: [] });
    expect(JSON.parse(fs.readFileSync(file, "utf8"))).toEqual({ ports: { local: 9810, external: 9811 }, plugins: { note: "留着" } });
    writeConfigFile(dataDir, { ports: { local: 9810, external: 9811 }, plugins: { disabled: ["reminders"] } });
    writePluginsConfig(file, { disabled: [], removed: [] });
    expect(JSON.parse(fs.readFileSync(file, "utf8"))).toEqual({ ports: { local: 9810, external: 9811 } });
  });

  it("浏览器的路径（70 号票）：不写、写空、写占位符都当没写（按默认的顺序找）；写了要是绝对路径", () => {
    const dataDir = makeTempDir();
    const load = () => loadConfig({ env: { ERGO_DATA_DIR: dataDir }, homeDir: makeTempDir() }).web;
    expect(load()).toEqual({});
    for (const browserPath of ["", null, "<Chrome 或 Edge 的可执行文件的绝对路径（不写就自动找）>"]) {
      writeConfigFile(dataDir, { web: { browserPath } });
      expect(load()).toEqual({});
    }
    const exe = path.join(makeTempDir(), "chrome.exe");
    writeConfigFile(dataDir, { web: { browserPath: exe } });
    expect(load()).toEqual({ browserPath: exe });
    writeConfigFile(dataDir, { web: { browserPath: "chrome.exe" } });
    expect(load).toThrow(/web\.browserPath 必须是绝对路径/);
    writeConfigFile(dataDir, { web: { browserPath: 1 } });
    expect(load).toThrow(/web\.browserPath 必须是 Chrome 或 Edge/);
  });

  it("带类型的 bash 工具：跑测试、启动构建、装依赖的单次调用超时默认 30 分钟；可以改；写错了报错", () => {
    const dataDir = makeTempDir();
    expect(loadConfig({ env: { ERGO_DATA_DIR: dataDir }, homeDir: makeTempDir() }).shellTools).toEqual({ longCallMs: 30 * 60_000 });
    writeConfigFile(dataDir, { shellTools: { longCallMinutes: 45 } });
    expect(loadConfig({ env: { ERGO_DATA_DIR: dataDir }, homeDir: makeTempDir() }).shellTools).toEqual({ longCallMs: 45 * 60_000 });
    writeConfigFile(dataDir, { shellTools: { longCallMinutes: "长一点" } });
    expect(() => loadConfig({ env: { ERGO_DATA_DIR: dataDir }, homeDir: makeTempDir() })).toThrow(/shellTools\.longCallMinutes/);
  });

  it("语音识别（31 号票）：默认显卡上的 large-v3、int8_float16，退回 CPU 的 small，常驻不因闲置退出（45 号票），识别超时按时长和设备算，剔掉用户给的 5 条串词（180 号票），识别没做成时隔 15 秒、60 秒、3 分钟自动重试（208 号票）；默认自己拉起 Python（250 号票的 mode 默认 spawn），可以改成调 LSM 托管的服务；可以改，只写一部分时其余取默认；写错了报错", () => {
    const dataDir = makeTempDir();
    const load = () => loadConfig({ env: { ERGO_DATA_DIR: dataDir }, homeDir: makeTempDir() }).voice;
    expect(load()).toMatchObject({
      recognizer: {
        mode: "spawn",
        url: "http://127.0.0.1:8091",
        python: "python",
        primary: { device: "cuda", model: "large-v3", computeType: "int8_float16" },
        fallback: { device: "cpu", model: "small", computeType: "int8" },
        idleMs: 0,
        timeout: { baseMs: 30_000, coldStartMs: 60_000, gpuPerAudioSecond: 1, cpuPerAudioSecond: 3 },
        language: "zh",
        initialPrompt: "以下是普通话的句子。",
        stripPatterns: ["[请請]不吝?[点點][赞贊讚]", "[订訂][阅閱].{0,6}[转轉][发發]", "打[赏賞].{0,10}(明[镜鏡]|[点點][点點])", "支持(明[镜鏡]|[点點][点點]).{0,6}[栏欄]目", "字幕由.{0,10}提供"],
        autoRetryMs: [15_000, 60_000, 180_000],
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
    // 剔掉的串词（180 号票）：写了就整组换成写的，写 [] 不剔；正则写错的不在这里拦（识别那边启动时跳过、写日志）
    writeConfigFile(dataDir, { voice: { recognizer: { stripPatterns: ["感谢观看", "([写错的"] } } });
    expect(load().recognizer.stripPatterns).toEqual(["感谢观看", "([写错的"]);
    writeConfigFile(dataDir, { voice: { recognizer: { stripPatterns: [] } } });
    expect(load().recognizer.stripPatterns).toEqual([]);
    // 自动重试（208 号票）：每一项是第几次重试前等几秒，几项就最多重试几次；写 [] 不自动重试
    writeConfigFile(dataDir, { voice: { recognizer: { autoRetrySeconds: [5, 30.5] } } });
    expect(load().recognizer.autoRetryMs).toEqual([5_000, 30_500]);
    writeConfigFile(dataDir, { voice: { recognizer: { autoRetrySeconds: [] } } });
    expect(load().recognizer.autoRetryMs).toEqual([]);
    // 闲置退出可以写 0（常驻），不能是负数
    writeConfigFile(dataDir, { voice: { recognizer: { idleMinutes: 0 } } });
    expect(load().recognizer.idleMs).toBe(0);
    // 250 号票：换成正 LSM 托管的那条；地址去掉末尾的斜杠，认 http/https
    writeConfigFile(dataDir, { voice: { recognizer: { mode: "lsm", url: "http://127.0.0.1:9200/" } } });
    expect(load().recognizer).toMatchObject({ mode: "lsm", url: "http://127.0.0.1:9200" });
    for (const wrong of [
      { recognizer: { idleMinutes: -1 } },
      { recognizer: { idleMinutes: "常驻" } },
      { recognizer: { device: "" } },
      { recognizer: { fallback: "cpu" } },
      { recognizer: { timeout: 300 } },
      { recognizer: { timeout: { gpuPerAudioSecond: 0 } } },
      { recognizer: { stripPatterns: "请不吝?点赞" } },
      { recognizer: { stripPatterns: ["订阅", 1] } },
      { recognizer: { autoRetrySeconds: 15 } },
      { recognizer: { autoRetrySeconds: [15, 0] } },
      { recognizer: { autoRetrySeconds: [15, "1 分钟"] } },
      // 250 号票：mode 只有 spawn、lsm 两种（写错一个字母不能悄悄退回 spawn），url 要认得的地址
      { recognizer: { mode: "http" } },
      { recognizer: { mode: "" } },
      { recognizer: { mode: 1 } },
      { recognizer: { url: "127.0.0.1:8091" } },
      { recognizer: { url: "ftp://127.0.0.1:8091" } },
      { recognizer: "cpu" },
      "开",
    ]) {
      writeConfigFile(dataDir, { voice: wrong });
      expect(() => load()).toThrow(/voice/);
    }
  });

  it("语音合成和语音回复（32 号票）：默认用本机 8090 上 audio.cpp 的 tts 模型，超时按冷启动和语音时长算，每分钟看一次服务开没开（45 号票），口语稿超过约 60 秒（按字数估）算长；可以改，只写一部分时其余取默认；写错了报错", () => {
    const dataDir = makeTempDir();
    const load = () => loadConfig({ env: { ERGO_DATA_DIR: dataDir }, homeDir: makeTempDir() }).voice;
    expect(load()).toMatchObject({
      speech: { url: "http://127.0.0.1:8090", model: "tts", timeout: { baseMs: 15_000, coldStartMs: 90_000, perSpeechSecond: 2 }, probeMs: 60_000 },
      reply: { maxSeconds: 60, charsPerSecond: 4.5 },
    });
    writeConfigFile(dataDir, { voice: { speech: { url: "http://127.0.0.1:9123/", timeout: { coldStartSeconds: 30 }, probeSeconds: 30 }, reply: { maxSeconds: 20 } } });
    expect(load()).toMatchObject({
      speech: { url: "http://127.0.0.1:9123", model: "tts", timeout: { baseMs: 15_000, coldStartMs: 30_000, perSpeechSecond: 2 }, probeMs: 30_000 },
      reply: { maxSeconds: 20, charsPerSecond: 4.5 },
    });
    // 示例配置里的模型 id 是占位符（Fish-Audio S2 Pro 在服务上的模型 id）：配置照样能用，原样留着（合成时报清楚，退回只发文字）
    writeConfigFile(dataDir, JSON.parse(fs.readFileSync(path.join(repoRoot, "config", "ergo.example.json"), "utf8")));
    expect(load().speech.model).toMatch(/^<.*Fish-Audio S2 Pro.*>$/);
    for (const wrong of [
      { speech: { url: "不是地址" } },
      { speech: { url: "ftp://127.0.0.1:8090" } },
      { speech: { model: "" } },
      { speech: { timeout: { baseSeconds: -1 } } },
      { speech: { probeSeconds: 0 } },
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
    expect(() => loadConfig({ env: { ERGO_DATA_DIR: dataDir }, homeDir: makeTempDir() })).toThrow(/ergo\.json[\s\S]*ports\.local/);
  });

  it("媒体：单个上传文件的上限默认 200 MB，可以改；不合法时报错", () => {
    const dataDir = makeTempDir();
    expect(loadConfig({ env: { ERGO_DATA_DIR: dataDir }, homeDir: makeTempDir() }).media).toEqual({ maxUploadBytes: 200 * 1024 * 1024 });
    writeConfigFile(dataDir, { media: { maxUploadBytes: 1024 } });
    expect(loadConfig({ env: { ERGO_DATA_DIR: dataDir }, homeDir: makeTempDir() }).media).toEqual({ maxUploadBytes: 1024 });
    writeConfigFile(dataDir, { media: { maxUploadBytes: "大" } });
    expect(() => loadConfig({ env: { ERGO_DATA_DIR: dataDir }, homeDir: makeTempDir() })).toThrow(/media\.maxUploadBytes/);
  });

  it("模型能力（79 号票）：看图能力按「provider/模型 id」配置，写了的以配置为准（可以关掉），没写的不定（按模型目录）", () => {
    const dataDir = makeTempDir();
    // 不写配置：不定，由子进程按模型目录定（deepseek-flash 能看图，见 contract/vision.contract.test.ts）；设置页改的盖过这里（test/model-settings.test.ts）
    expect(loadConfig({ env: { ERGO_DATA_DIR: dataDir }, homeDir: makeTempDir() }).models).toEqual({});
    writeConfigFile(dataDir, { models: { "deepseek/deepseek-flash": { vision: false }, "deepseek/deepseek-v4-pro": { vision: true }, faux: {} } });
    const config = loadConfig({ env: { ERGO_DATA_DIR: dataDir }, homeDir: makeTempDir() });
    // 写了模型、没写 vision：同样不定
    expect(config.models).toEqual({ "deepseek/deepseek-flash": { vision: false }, "deepseek/deepseek-v4-pro": { vision: true }, faux: {} });
    writeConfigFile(dataDir, { models: { "deepseek/deepseek-flash": { vision: "yes" } } });
    expect(() => loadConfig({ env: { ERGO_DATA_DIR: dataDir }, homeDir: makeTempDir() })).toThrow(/models\["deepseek\/deepseek-flash"\]\.vision/);
  });

  it("时区（给模型看的消息时间标记用）：默认是本机时区，可以改成别的 IANA 时区名；不认识的报错", () => {
    const dataDir = makeTempDir();
    expect(loadConfig({ env: { ERGO_DATA_DIR: dataDir }, homeDir: makeTempDir() }).timeZone).toBe(Intl.DateTimeFormat().resolvedOptions().timeZone);
    writeConfigFile(dataDir, { timeZone: "Asia/Singapore" });
    expect(loadConfig({ env: { ERGO_DATA_DIR: dataDir }, homeDir: makeTempDir() }).timeZone).toBe("Asia/Singapore");
    writeConfigFile(dataDir, { timeZone: "Mars/Olympus" });
    expect(() => loadConfig({ env: { ERGO_DATA_DIR: dataDir }, homeDir: makeTempDir() })).toThrow(/timeZone/);
  });

  it("本机端口和外网端口不能相同", () => {
    const dataDir = makeTempDir();
    writeConfigFile(dataDir, { ports: { local: 9300, external: 9300 } });
    expect(() => loadConfig({ env: { ERGO_DATA_DIR: dataDir }, homeDir: makeTempDir() })).toThrow(/不能相同/);
  });

  it("建议卡、提问卡多少天没处理算回避：默认 7 天，可以在配置文件里改", () => {
    const dataDir = makeTempDir();
    expect(loadConfig({ env: { ERGO_DATA_DIR: dataDir }, homeDir: makeTempDir() }).materials).toEqual({ staleCardDays: 7 });
    writeConfigFile(dataDir, { materials: { staleCardDays: 3 } });
    expect(loadConfig({ env: { ERGO_DATA_DIR: dataDir }, homeDir: makeTempDir() }).materials).toEqual({ staleCardDays: 3 });
  });

  it("回避天数不合法时报错", () => {
    const dataDir = makeTempDir();
    writeConfigFile(dataDir, { materials: { staleCardDays: 0 } });
    expect(() => loadConfig({ env: { ERGO_DATA_DIR: dataDir }, homeDir: makeTempDir() })).toThrow(/materials\.staleCardDays/);
  });

  // 225 号票：每晚整理最多调几次模型（预算用完就停，下次接着做）；237 号票加墙钟上限
  it("记忆整理每次最多调几次模型：默认 200，可以在配置文件里改", () => {
    const dataDir = makeTempDir();
    expect(loadConfig({ env: { ERGO_DATA_DIR: dataDir }, homeDir: makeTempDir() }).memory).toEqual({ maxModelCalls: 200, extractor: "model", sensitiveCategories: [], enabled: true, nightlyTimeoutMinutes: 60, curator: { maxModelCalls: 8 } });
    writeConfigFile(dataDir, { memory: { maxModelCalls: 50 } });
    expect(loadConfig({ env: { ERGO_DATA_DIR: dataDir }, homeDir: makeTempDir() }).memory).toEqual({ maxModelCalls: 50, extractor: "model", sensitiveCategories: [], enabled: true, nightlyTimeoutMinutes: 60, curator: { maxModelCalls: 8 } });
  });

  it("记忆整理的预算不合法时报错", () => {
    const dataDir = makeTempDir();
    writeConfigFile(dataDir, { memory: { maxModelCalls: 0 } });
    expect(() => loadConfig({ env: { ERGO_DATA_DIR: dataDir }, homeDir: makeTempDir() })).toThrow(/memory\.maxModelCalls/);
  });

  // 237 号票：每一夜的墙钟上限（默认 60 分钟，0 = 不限）
  it("记忆整理每一夜的墙钟上限：默认 60 分钟，可以改、可以设 0 不限", () => {
    const dataDir = makeTempDir();
    expect(loadConfig({ env: { ERGO_DATA_DIR: dataDir }, homeDir: makeTempDir() }).memory.nightlyTimeoutMinutes).toBe(60);
    writeConfigFile(dataDir, { memory: { nightlyTimeoutMinutes: 15 } });
    expect(loadConfig({ env: { ERGO_DATA_DIR: dataDir }, homeDir: makeTempDir() }).memory.nightlyTimeoutMinutes).toBe(15);
    writeConfigFile(dataDir, { memory: { nightlyTimeoutMinutes: 0 } });
    expect(loadConfig({ env: { ERGO_DATA_DIR: dataDir }, homeDir: makeTempDir() }).memory.nightlyTimeoutMinutes).toBe(0);
  });

  it("墙钟上限不合法时报错", () => {
    const dataDir = makeTempDir();
    writeConfigFile(dataDir, { memory: { nightlyTimeoutMinutes: -1 } });
    expect(() => loadConfig({ env: { ERGO_DATA_DIR: dataDir }, homeDir: makeTempDir() })).toThrow(/memory\.nightlyTimeoutMinutes/);
  });

  // 236 号票：抽事实用模型版（默认，和评测一致）还是规则版（兜底、省钱）
  it("抽事实默认用模型版，可以在配置文件里换成规则版", () => {
    const dataDir = makeTempDir();
    expect(loadConfig({ env: { ERGO_DATA_DIR: dataDir }, homeDir: makeTempDir() }).memory.extractor).toBe("model");
    writeConfigFile(dataDir, { memory: { extractor: "rule" } });
    expect(loadConfig({ env: { ERGO_DATA_DIR: dataDir }, homeDir: makeTempDir() }).memory).toEqual({ maxModelCalls: 200, extractor: "rule", sensitiveCategories: [], enabled: true, nightlyTimeoutMinutes: 60, curator: { maxModelCalls: 8 } });
  });

  it("抽事实的开关只认 model 和 rule", () => {
    const dataDir = makeTempDir();
    writeConfigFile(dataDir, { memory: { extractor: "llm" } });
    expect(() => loadConfig({ env: { ERGO_DATA_DIR: dataDir }, homeDir: makeTempDir() })).toThrow(/memory\.extractor/);
  });

  // 234 号票：敏感类别默认允许记录、不用于推断；列表里写的是"允许用来推断的"
  it("敏感类别默认是空（都不用于推断），可以逐类打开", () => {
    const dataDir = makeTempDir();
    expect(loadConfig({ env: { ERGO_DATA_DIR: dataDir }, homeDir: makeTempDir() }).memory.sensitiveCategories).toEqual([]);
    writeConfigFile(dataDir, { memory: { sensitiveCategories: ["health", "emotion"] } });
    expect(loadConfig({ env: { ERGO_DATA_DIR: dataDir }, homeDir: makeTempDir() }).memory.sensitiveCategories).toEqual(["health", "emotion"]);
  });

  it("敏感类别写错了、写重了都报错", () => {
    const dataDir = makeTempDir();
    writeConfigFile(dataDir, { memory: { sensitiveCategories: ["health", "health"] } });
    expect(() => loadConfig({ env: { ERGO_DATA_DIR: dataDir }, homeDir: makeTempDir() })).toThrow(/memory\.sensitiveCategories/);
    writeConfigFile(dataDir, { memory: { sensitiveCategories: ["medical"] } });
    expect(() => loadConfig({ env: { ERGO_DATA_DIR: dataDir }, homeDir: makeTempDir() })).toThrow(/memory\.sensitiveCategories/);
  });

  // 235 号票：这台机器上跑不跑整理（和插件停用是两回事：插件停用连素材检索、简报一起没有）
  it("记忆整理默认开着，可以在这台机器上关掉（memory.enabled）", () => {
    const dataDir = makeTempDir();
    expect(loadConfig({ env: { ERGO_DATA_DIR: dataDir }, homeDir: makeTempDir() }).memory.enabled).toBe(true);
    writeConfigFile(dataDir, { memory: { enabled: false } });
    expect(loadConfig({ env: { ERGO_DATA_DIR: dataDir }, homeDir: makeTempDir() }).memory).toEqual({ maxModelCalls: 200, extractor: "model", sensitiveCategories: [], enabled: false, nightlyTimeoutMinutes: 60, curator: { maxModelCalls: 8 } });
  });

  it("memory.enabled 只收 true / false", () => {
    const dataDir = makeTempDir();
    writeConfigFile(dataDir, { memory: { enabled: "off" } });
    expect(() => loadConfig({ env: { ERGO_DATA_DIR: dataDir }, homeDir: makeTempDir() })).toThrow(/memory\.enabled/);
  });

  // 242 号票：记忆管理员每夜额外最多调几次模型（引擎那 200 次照旧是硬上限）
  it("记忆管理员每夜的预算：默认 8 次，可以在配置文件里改", () => {
    const dataDir = makeTempDir();
    expect(loadConfig({ env: { ERGO_DATA_DIR: dataDir }, homeDir: makeTempDir() }).memory.curator).toEqual({ maxModelCalls: 8 });
    writeConfigFile(dataDir, { memory: { curator: { maxModelCalls: 3 } } });
    expect(loadConfig({ env: { ERGO_DATA_DIR: dataDir }, homeDir: makeTempDir() }).memory.curator).toEqual({ maxModelCalls: 3 });
  });

  it("记忆管理员的预算不合法时报错（0、不是对象都不收）", () => {
    const dataDir = makeTempDir();
    writeConfigFile(dataDir, { memory: { curator: { maxModelCalls: 0 } } });
    expect(() => loadConfig({ env: { ERGO_DATA_DIR: dataDir }, homeDir: makeTempDir() })).toThrow(/memory\.curator\.maxModelCalls/);
    writeConfigFile(dataDir, { memory: { curator: 8 } });
    expect(() => loadConfig({ env: { ERGO_DATA_DIR: dataDir }, homeDir: makeTempDir() })).toThrow(/memory\.curator/);
  });
});

const load = (dataDir: string) => loadConfig({ env: { ERGO_DATA_DIR: dataDir }, homeDir: makeTempDir() });

describe("备份的配置", () => {
  it("不配时每晚 03:30 备份，没有同步目录（只做本机备份）", () => {
    expect(load(makeTempDir()).backup).toEqual({ time: "03:30", schedule: "internal" });
  });

  it("时间和同步目录从配置文件读", () => {
    const dataDir = makeTempDir();
    const syncDir = makeTempDir("ergo-sync-");
    writeConfigFile(dataDir, { backup: { time: "02:15", syncDir } });
    expect(load(dataDir).backup).toEqual({ time: "02:15", schedule: "internal", syncDir });
  });

  it("谁来定时（335 号票）：不写是 internal（守护进程每天到点自己做）；写 external 交给外部定时器；别的值报错", () => {
    const dataDir = makeTempDir();
    writeConfigFile(dataDir, { backup: { schedule: "external" } });
    expect(load(dataDir).backup).toEqual({ time: "03:30", schedule: "external" });
    writeConfigFile(dataDir, { backup: { schedule: "nightly" } });
    expect(() => load(dataDir)).toThrow(/backup\.schedule 只能是 "internal".*或 "external"/);
  });

  it("示例配置里的同步目录是占位符：配置照样能用，原样留着（备份时在待我处理里提醒换掉）", () => {
    const dataDir = makeTempDir();
    writeConfigFile(dataDir, JSON.parse(fs.readFileSync(path.join(repoRoot, "config", "ergo.example.json"), "utf8")));
    expect(load(dataDir).backup).toEqual({ time: "03:30", schedule: "internal", syncDir: "<同步目录的绝对路径>" });
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

describe("工具调用完整内容的保留期和总量上限（65 号票）", () => {
  it("不配时保留 90 天、总量上限 2 GB；示例配置里写的就是默认值", () => {
    expect(load(makeTempDir()).toolCallDetails).toEqual({ retentionDays: 90, maxBytes: 2 * 1024 ** 3 });
    const dataDir = makeTempDir();
    writeConfigFile(dataDir, JSON.parse(fs.readFileSync(path.join(repoRoot, "config", "ergo.example.json"), "utf8")));
    expect(load(dataDir).toolCallDetails).toEqual({ retentionDays: 90, maxBytes: 2 * 1024 ** 3 });
  });

  it("从配置文件读，可以带小数；不是正数报错", () => {
    const dataDir = makeTempDir();
    writeConfigFile(dataDir, { toolCallDetails: { retentionDays: 30, maxSizeGB: 0.5 } });
    expect(load(dataDir).toolCallDetails).toEqual({ retentionDays: 30, maxBytes: 512 * 1024 ** 2 });
    writeConfigFile(dataDir, { toolCallDetails: { maxSizeGB: 1 } });
    expect(load(dataDir).toolCallDetails).toEqual({ retentionDays: 90, maxBytes: 1024 ** 3 });
    writeConfigFile(dataDir, { toolCallDetails: { retentionDays: 0 } });
    expect(() => load(dataDir)).toThrow(/toolCallDetails\.retentionDays 必须是正数/);
    writeConfigFile(dataDir, { toolCallDetails: { maxSizeGB: "2" } });
    expect(() => load(dataDir)).toThrow(/toolCallDetails\.maxSizeGB 必须是正数/);
    writeConfigFile(dataDir, { toolCallDetails: 90 });
    expect(() => load(dataDir)).toThrow(/toolCallDetails 必须是一个对象/);
  });
});
