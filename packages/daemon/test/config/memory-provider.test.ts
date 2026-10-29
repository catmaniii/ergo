// 337 号票：配置里的 memory.provider——用哪一套记忆系统。
// 这一段只加配置项（不接线）：不写、写坏了都当默认（会意 / subtext），绝不因为这一项拦启动；写了认的就是选的 id。
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { DEFAULT_MEMORY_PROVIDER, loadConfig } from "../../src/config/config.ts";
import { makeTempDir } from "../helpers/temp-dir.ts";

function writeConfigFile(dataDir: string, content: unknown): void {
  fs.mkdirSync(path.join(dataDir, "config"), { recursive: true });
  fs.writeFileSync(path.join(dataDir, "config", "ergo.json"), JSON.stringify(content));
}

function load(dataDir: string) {
  return loadConfig({ env: { ERGO_DATA_DIR: dataDir }, homeDir: makeTempDir() });
}

describe("配置：记忆系统用哪一套（337 号票）", () => {
  it("不写这一项也照常跑，默认是会意（subtext）", () => {
    const dataDir = makeTempDir();
    expect(DEFAULT_MEMORY_PROVIDER).toBe("subtext");
    const config = load(dataDir);
    // 不写就不出这个键（现有配置一个字没写，读的人用默认值）
    expect(config.memory.provider).toBeUndefined();
    expect(config.memory.provider ?? DEFAULT_MEMORY_PROVIDER).toBe("subtext");
  });

  it("写了就是选的那一套（两边空格去掉）", () => {
    const dataDir = makeTempDir();
    writeConfigFile(dataDir, { memory: { provider: " fake-b " } });
    expect(load(dataDir).memory.provider).toBe("fake-b");
  });

  it("写坏了（不是字符串、空的、不像 id 的）当默认，不拦启动", () => {
    const dataDir = makeTempDir();
    for (const bad of [42, "", "   ", "../escape", "Fake A", "fake/a", "subtext;rm"]) {
      writeConfigFile(dataDir, { memory: { provider: bad } });
      expect(() => load(dataDir), `写的是 ${JSON.stringify(bad)}`).not.toThrow();
      expect(load(dataDir).memory.provider, `写的是 ${JSON.stringify(bad)}`).toBeUndefined();
    }
  });
});
