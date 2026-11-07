// 服务管家里登记在某个端口上的服务（413，src/lsm/registered.ts）：读临时目录里的注册表文件，不连服务管家——
// - 手工登记的（顶层 services/<id>.yaml，id 是文件里写的）、组件页经协议登记的（名下的 services/owned/ergo-daemon/audiocpp.yaml，
//   id 是"登记方--文件名"）都按 probe 段的 port 找得到，带上给人看的名字；
// - health 下面更深那层、别的段里的 port 不算；没有这个端口、目录不在、文件读不懂都是没有，不抛错。
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { parseRegistryEntry, registeredServiceOnPort } from "../../src/lsm/registered.ts";
import { makeTempDir } from "../helpers/temp-dir.ts";

/** 手工登记的那种（照 deploy/lsm/ergo-asr.example.yaml 的写法，端口是编的） */
const MANUAL = [
  "# 手写的注册表条目",
  "id: my-tts",
  "name: '用户自己的 audio.cpp（本机）'",
  "kind: managed",
  "",
  "probe:",
  "  # health 档",
  "  tier: health",
  "  port: 18090",
  "  health:",
  "    url: http://127.0.0.1:18090/health",
  "    timeoutMs: 3000",
  "",
  "hooks:",
  "  start:",
  "    argv: [audiocpp_server.exe]",
].join("\n");

/** 服务管家照协议写出来的（yaml 库的样子） */
const OWNED = [
  "# 由 ergo-daemon 经接入协议登记",
  "id: ergo-daemon--audiocpp",
  "name: 语音合成服务（audio.cpp）",
  "project: ergo-daemon",
  "owner: ergo-daemon",
  "probe:",
  "  tier: health",
  "  port: 18091",
  "  health:",
  "    url: http://127.0.0.1:18091/health",
  "    timeoutMs: 3000",
].join("\r\n");

function registry(): string {
  const svc = makeTempDir("ergo-lsm-registry-");
  const services = path.join(svc, "registry", "services");
  fs.mkdirSync(path.join(services, "owned", "ergo-daemon"), { recursive: true });
  fs.writeFileSync(path.join(services, "my-tts.yaml"), MANUAL);
  fs.writeFileSync(path.join(services, "owned", "ergo-daemon", "audiocpp.yaml"), OWNED);
  // 端口写在别的段、health 下面那层：都不算
  fs.writeFileSync(path.join(services, "tunnel.yaml"), "id: tunnel\nexposure:\n  localPort: 18092\nprobe:\n  tier: port\n  health:\n    port: 18093\n");
  fs.writeFileSync(path.join(services, "broken.yaml"), ":::\n\t- not yaml");
  return svc;
}

describe("服务管家里登记在某个端口上的服务", () => {
  it("手工登记的（顶层文件）和名下的（owned/<登记方>/）都按探活端口找得到，带名字", () => {
    const svc = registry();
    expect(registeredServiceOnPort(svc, 18090)).toEqual({ id: "my-tts", name: "用户自己的 audio.cpp（本机）" });
    expect(registeredServiceOnPort(svc, 18091)).toEqual({ id: "ergo-daemon--audiocpp", name: "语音合成服务（audio.cpp）" });
  });

  it("别的段里的端口、health 下面那层的不算；没有这个端口、目录不在都是没有", () => {
    const svc = registry();
    expect(registeredServiceOnPort(svc, 18092)).toBeUndefined();
    expect(registeredServiceOnPort(svc, 18093)).toBeUndefined();
    expect(registeredServiceOnPort(svc, 18094)).toBeUndefined();
    expect(registeredServiceOnPort(path.join(svc, "nope"), 18090)).toBeUndefined();
  });

  it("名下的服务 id 只看文件放在哪（登记方--文件名），不看文件里写的；顶层文件没写 id 按文件名", () => {
    const svc = makeTempDir("ergo-lsm-registry-");
    const services = path.join(svc, "registry", "services");
    fs.mkdirSync(path.join(services, "owned", "someone"), { recursive: true });
    fs.writeFileSync(path.join(services, "owned", "someone", "asr.yaml"), "id: pretend\nprobe:\n  port: 18095\n");
    fs.writeFileSync(path.join(services, "plain.yaml"), "name: \"没写 id\"\nprobe:\n    port: 18096\n");
    expect(registeredServiceOnPort(svc, 18095)).toEqual({ id: "someone--asr" });
    expect(registeredServiceOnPort(svc, 18096)).toEqual({ id: "plain", name: "没写 id" });
  });

  it("一份文件里读出的：顶层的 id、name（引号去掉），probe 段直接那层的 port", () => {
    expect(parseRegistryEntry(MANUAL)).toEqual({ id: "my-tts", name: "用户自己的 audio.cpp（本机）", port: 18090 });
    expect(parseRegistryEntry("name: 'it''s mine'  # 注释\n")).toEqual({ name: "it's mine" });
    expect(parseRegistryEntry("")).toEqual({});
  });
});
