// 配置文件里的"本机来的也要配对"（469，pairing.localRequestsNeedPairing）：不写是关着；只认 true / false；
// 设置页、ergo local-pairing off 改它时别的内容原样留着，关掉时这一项（节空了整节）去掉。还有本机程序的令牌：每次起来换一份，只比摘要。
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { loadConfig, readPairingConfig, writePairingConfig } from "../../src/config/config.ts";
import { dataDirLayout } from "../../src/config/data-dir.ts";
import { createLocalPairingSetting, issueLocalToken, readLocalToken } from "../../src/pairing/local-access.ts";
import { makeTempDir } from "../helpers/temp-dir.ts";

function configIn(content: unknown): { dataDir: string; file: string } {
  const dataDir = makeTempDir("ergo-data-");
  const file = dataDirLayout(dataDir).configFile;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  if (content !== undefined) fs.writeFileSync(file, JSON.stringify(content));
  return { dataDir, file };
}

const read = (file: string) => JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>;

describe("配置文件里的本机来的也要配对", () => {
  it("不写、写 false 是关着，写 true 是开着；别的写法拒绝启动", () => {
    expect(loadConfig({ env: { ERGO_DATA_DIR: configIn(undefined).dataDir }, homeDir: makeTempDir("h-") }).pairing).toEqual({ localRequestsNeedPairing: false });
    expect(loadConfig({ env: { ERGO_DATA_DIR: configIn({ pairing: {} }).dataDir }, homeDir: makeTempDir("h-") }).pairing).toEqual({ localRequestsNeedPairing: false });
    expect(loadConfig({ env: { ERGO_DATA_DIR: configIn({ pairing: { localRequestsNeedPairing: true } }).dataDir }, homeDir: makeTempDir("h-") }).pairing).toEqual({ localRequestsNeedPairing: true });
    expect(() => loadConfig({ env: { ERGO_DATA_DIR: configIn({ pairing: true }).dataDir }, homeDir: makeTempDir("h-") })).toThrow("pairing 必须是一个对象");
    expect(() => loadConfig({ env: { ERGO_DATA_DIR: configIn({ pairing: { localRequestsNeedPairing: 1 } }).dataDir }, homeDir: makeTempDir("h-") })).toThrow("必须是 true 或 false");
  });

  it("开、关只动这一项：别的内容原样留着；关掉时去掉这一项，节空了整节去掉；写坏了的也能关掉", () => {
    const { file } = configIn({ ports: { local: 18810, external: 18811 }, pairing: { note: "留着" } });
    writePairingConfig(file, { localRequestsNeedPairing: true });
    expect(read(file)).toEqual({ ports: { local: 18810, external: 18811 }, pairing: { note: "留着", localRequestsNeedPairing: true } });
    expect(readPairingConfig(file)).toEqual({ localRequestsNeedPairing: true });
    writePairingConfig(file, { localRequestsNeedPairing: false });
    expect(read(file)).toEqual({ ports: { local: 18810, external: 18811 }, pairing: { note: "留着" } });
    const broken = configIn({ timeZone: "Asia/Shanghai", pairing: { localRequestsNeedPairing: "yes" } }).file;
    expect(() => readPairingConfig(broken)).toThrow("pairing.localRequestsNeedPairing");
    writePairingConfig(broken, { localRequestsNeedPairing: false });
    expect(read(broken)).toEqual({ timeZone: "Asia/Shanghai" });
  });

  it("设置：改了写进配置、叫订阅的；没变不写", () => {
    const { file } = configIn({});
    const changes: boolean[] = [];
    const setting = createLocalPairingSetting({ configFile: file, initial: false, log: () => undefined });
    setting.onChange((on) => changes.push(on));
    expect(setting.set(false)).toBe(false);
    expect(setting.set(true)).toBe(true);
    expect(setting.on()).toBe(true);
    expect(read(file)).toEqual({ pairing: { localRequestsNeedPairing: true } });
    setting.set(false);
    expect(changes).toEqual([true, false]);
  });
});

describe("本机程序的令牌", () => {
  it("每次起来换一份新的、写进密钥区；只认这一份，旧的、改过的、空的都不认", () => {
    const { dataDir } = configIn(undefined);
    const file = dataDirLayout(dataDir).localTokenFile;
    expect(path.relative(dataDir, file).split(path.sep)).toEqual(["secrets", "local-token"]);
    const first = issueLocalToken(file, () => undefined);
    const firstValue = readLocalToken(file)!;
    expect(firstValue).toBe(first.value());
    expect(first.matches(firstValue)).toBe(true);
    const second = issueLocalToken(file, () => undefined);
    expect(readLocalToken(file)).toBe(second.value());
    expect(second.matches(firstValue)).toBe(false);
    for (const wrong of [undefined, "", `${second.value()}x`, second.value().slice(1)]) expect(second.matches(wrong)).toBe(false);
  });

  it("写不进密钥区：记一行（不带令牌），守护进程照常用它", () => {
    const { dataDir } = configIn(undefined);
    const layout = dataDirLayout(dataDir);
    // 密钥区的位置被一个文件占着：目录建不起来
    fs.writeFileSync(layout.secrets, "not a folder");
    const lines: string[] = [];
    const token = issueLocalToken(layout.localTokenFile, (line) => lines.push(line));
    expect(lines).toHaveLength(1);
    expect(lines[0]).not.toContain(token.value());
    expect(token.matches(token.value())).toBe(true);
    expect(readLocalToken(layout.localTokenFile)).toBeUndefined();
  });
});
