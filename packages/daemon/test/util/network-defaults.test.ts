// 出站连接的网络默认值：导入后每个地址的等待放宽；守护进程和会联网的子进程入口都最先导入它
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { AUTO_SELECT_FAMILY_ATTEMPT_TIMEOUT_MS } from "../../src/util/network-defaults.ts";

const src = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../src");

describe("网络默认值", () => {
  it("导入后每个地址等 2.5 秒，不是 Node 默认的 250 毫秒", () => {
    expect(AUTO_SELECT_FAMILY_ATTEMPT_TIMEOUT_MS).toBe(2500);
    expect(net.getDefaultAutoSelectFamilyAttemptTimeout()).toBe(AUTO_SELECT_FAMILY_ATTEMPT_TIMEOUT_MS);
  });

  it.each([
    "main.ts",
    "runtime/agent-child/main.ts",
    "runtime/agent-child/model-probe-main.ts",
    "runtime/agent-child/recorded-generation-main.ts",
    "runtime/agent-child/translate-main.ts",
  ])("%s 一开头就导入它", (entry) => {
    const text = fs.readFileSync(path.join(src, entry), "utf8");
    const imports = text.split("\n").filter((line) => line.startsWith("import "));
    expect(imports.slice(0, 2).some((line) => line.includes("util/network-defaults.ts"))).toBe(true);
  });
});
