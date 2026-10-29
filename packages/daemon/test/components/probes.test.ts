// 组件的检测（323 号票）：on-path:<程序>（PATH 上有没有）、node-package:<包名>（程序的 node_modules 里有没有）、
// 配置里的识别程序（LSM 模式、配置写的 Python 在不在）和合成服务。不联网、不跑模型；N 卡那一项要真跑 nvidia-smi，这里不测。
import fs from "node:fs";
import path from "node:path";
import { describe, expect, test } from "vitest";
import { createComponentProbes, findOnPath } from "../../src/components/probes.ts";
import type { ErgoConfig } from "../../src/config/config.ts";
import { makeTempDir } from "../helpers/temp-dir.ts";

function config(recognizer: { mode: "spawn" | "lsm"; python: string }): ErgoConfig {
  return { voice: { recognizer: { ...recognizer, url: "http://127.0.0.1:8091" }, speech: { url: "http://127.0.0.1:8090" } } } as unknown as ErgoConfig;
}

describe("检测", () => {
  test("on-path：PATH 上找得到才算检测到（Windows 按 PATHEXT 补扩展名），写明在哪", () => {
    const bin = makeTempDir();
    const exe = path.join(bin, process.platform === "win32" ? "claude.CMD" : "claude");
    fs.writeFileSync(exe, "");
    const env = { PATH: bin, PATHEXT: ".EXE;.CMD" };
    expect(findOnPath("claude", env)).toBe(exe);
    const probes = createComponentProbes({ config: config({ mode: "spawn", python: "python" }), env });
    expect(probes.detect("on-path:claude")).toBe(`检测到了：${exe}`);
    expect(probes.detect("on-path:nope-not-here")).toBeUndefined();
    expect(probes.detect("something-else")).toBeUndefined();
  });

  test("node-package：程序的 node_modules 里解析得到才算有", () => {
    const probes = createComponentProbes({ config: config({ mode: "spawn", python: "python" }), env: {} });
    expect(probes.provided("node-package:vitest")).toBe("随程序装好的（node_modules 里的 vitest）");
    expect(probes.provided("node-package:@ergo/not-a-real-package")).toBeUndefined();
  });

  test("识别：LSM 模式算有；自己拉起的 Python 写的路径在、或者 PATH 上找得到才算有；合成服务看配置的地址", () => {
    expect(createComponentProbes({ config: config({ mode: "lsm", python: "python" }), env: {} }).provided("voice-recognizer")).toBe("用的是 LSM 托管的识别服务（http://127.0.0.1:8091）");
    const dir = makeTempDir();
    const python = path.join(dir, "python.exe");
    fs.writeFileSync(python, "");
    expect(createComponentProbes({ config: config({ mode: "spawn", python }), env: {} }).provided("voice-recognizer")).toBe(`用的是配置里的识别程序（${python}）`);
    expect(createComponentProbes({ config: config({ mode: "spawn", python: path.join(dir, "missing.exe") }), env: {} }).provided("voice-recognizer")).toBeUndefined();
    expect(createComponentProbes({ config: config({ mode: "spawn", python: "python-not-on-path" }), env: { PATH: dir } }).provided("voice-recognizer")).toBeUndefined();
    expect(createComponentProbes({ config: config({ mode: "spawn", python: "python" }), env: {} }).provided("voice-speech")).toBe("用的是配置里的合成服务（http://127.0.0.1:8090）");
  });

  test("识别：配置写的 Python 是 stat 不了的链接（WindowsApps 里商店版 Python 的应用执行别名那种）也算有，PATH 上找也一样", () => {
    const dir = makeTempDir();
    const alias = path.join(dir, "python.exe");
    // 链到不存在的地方：existsSync、stat 都说没有，lstat 看得到是个链接——和应用执行别名一样
    fs.symlinkSync(path.join(dir, "nowhere"), alias, "junction");
    expect(fs.existsSync(alias)).toBe(false);
    expect(createComponentProbes({ config: config({ mode: "spawn", python: alias }), env: {} }).provided("voice-recognizer")).toBe(`用的是配置里的识别程序（${alias}）`);
    expect(createComponentProbes({ config: config({ mode: "spawn", python: "python" }), env: { PATH: dir, PATHEXT: ".exe" } }).provided("voice-recognizer")).toBe(`用的是配置里的识别程序（${alias}）`);
  });
});
