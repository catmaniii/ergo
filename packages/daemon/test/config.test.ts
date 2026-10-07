import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { loadConfig, modelVision } from "../src/config/config.ts";
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
});
