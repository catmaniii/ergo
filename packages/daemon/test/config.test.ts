import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config/config.ts";
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

  it("本机端口和外网端口不能相同", () => {
    const dataDir = makeTempDir();
    writeConfigFile(dataDir, { ports: { local: 9300, external: 9300 } });
    expect(() => loadConfig({ env: { ERGOU_DATA_DIR: dataDir }, homeDir: makeTempDir() })).toThrow(/不能相同/);
  });
});
