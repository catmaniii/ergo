// 组件的检测：on-path:<程序>（PATH 上有没有）、node-package:<包名>（程序的 node_modules 里有没有）、codex-cli（PATH 上有没有够版本的 codex）、
// 配置里的识别程序（LSM 模式、配置写的 Python 在不在）和合成服务。不联网、不跑模型；N 卡那一项要真跑 nvidia-smi，这里不测。
import fs from "node:fs";
import path from "node:path";
import { describe, expect, test } from "vitest";
import { createComponentProbes, findOnPath } from "../../src/components/probes.ts";
import type { ErgoConfig } from "../../src/config/config.ts";
import { makeTempDir } from "../helpers/temp-dir.ts";

function config(recognizer: { mode: "spawn" | "lsm" | "audiocpp"; python: string }): ErgoConfig {
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

  test("识别：LSM 模式算有；写了 audiocpp 算有；自己拉起的 Python 写的路径在、或者 PATH 上找得到才算有；合成服务看探到的", () => {
    expect(createComponentProbes({ config: config({ mode: "lsm", python: "python" }), env: {} }).provided("voice-recognizer")).toBe("已有自己配的语音识别，在用它（服务管家托管的识别服务 http://127.0.0.1:8091）");
    expect(createComponentProbes({ config: config({ mode: "audiocpp", python: "python" }), env: {} }).provided("voice-recognizer")).toBe("已有自己配的语音识别，在用它（audio.cpp 服务 http://127.0.0.1:8090）");
    const dir = makeTempDir();
    const python = path.join(dir, "python.exe");
    fs.writeFileSync(python, "");
    expect(createComponentProbes({ config: config({ mode: "spawn", python }), env: {} }).provided("voice-recognizer")).toBe(`已有自己配的语音识别，在用它（配置里的 Python：${python}）`);
    expect(createComponentProbes({ config: config({ mode: "spawn", python: path.join(dir, "missing.exe") }), env: {} }).provided("voice-recognizer")).toBeUndefined();
    expect(createComponentProbes({ config: config({ mode: "spawn", python: "python-not-on-path" }), env: { PATH: dir } }).provided("voice-recognizer")).toBeUndefined();
    // 合成：不再只看配置写了地址（默认就写着），由 audiocpp-host.ts 现探有没有用户自己配的服务，这里只取结果
    expect(createComponentProbes({ config: config({ mode: "spawn", python: "python" }), env: {} }).provided("voice-speech")).toBeUndefined();
    expect(createComponentProbes({ config: config({ mode: "spawn", python: "python" }), env: {}, speechProvided: () => "在用它" }).provided("voice-speech")).toBe("在用它");
  });

  test("识别：配置写的 Python 是 stat 不了的链接（WindowsApps 里商店版 Python 的应用执行别名那种）也算有，PATH 上找也一样", () => {
    const dir = makeTempDir();
    const alias = path.join(dir, "python.exe");
    // 链到不存在的地方：existsSync、stat 都说没有，lstat 看得到是个链接——和应用执行别名一样
    fs.symlinkSync(path.join(dir, "nowhere"), alias, "junction");
    expect(fs.existsSync(alias)).toBe(false);
    expect(createComponentProbes({ config: config({ mode: "spawn", python: alias }), env: {} }).provided("voice-recognizer")).toBe(`已有自己配的语音识别，在用它（配置里的 Python：${alias}）`);
    expect(createComponentProbes({ config: config({ mode: "spawn", python: "python" }), env: { PATH: dir, PATHEXT: ".exe" }, hasFasterWhisper: () => true }).provided("voice-recognizer")).toBe(`已有自己配的语音识别，在用它（配置里的 Python：${alias}）`);
  });

  test("识别：默认的 python 光在 PATH 上不算，要真的装了 faster-whisper；问一次记住。不然随便有个 Python 就装不了组件", () => {
    const dir = makeTempDir();
    const python = path.join(dir, "python.exe");
    fs.writeFileSync(python, "");
    const asked: string[] = [];
    const probes = (has: boolean) =>
      createComponentProbes({
        config: config({ mode: "spawn", python: "python" }),
        env: { PATH: dir, PATHEXT: ".exe" },
        hasFasterWhisper: (p) => {
          asked.push(p);
          return has;
        },
      });
    const without = probes(false);
    expect(without.provided("voice-recognizer")).toBeUndefined();
    expect(without.provided("voice-recognizer")).toBeUndefined();
    expect(asked).toEqual([python]);
    expect(probes(true).provided("voice-recognizer")).toBe(`已有自己配的语音识别，在用它（配置里的 Python：${python}）`);
  });

  test("识别：配置里的 Python 还是占位符（抄了示例没填）不算；真去问的那条，假的 Python 算没装（不抛错）", () => {
    const placeholder = "<装了 faster-whisper 的 python.exe 的绝对路径>";
    const never = () => {
      throw new Error("不该问");
    };
    expect(createComponentProbes({ config: config({ mode: "spawn", python: placeholder }), env: {}, hasFasterWhisper: never }).provided("voice-recognizer")).toBeUndefined();
    const dir = makeTempDir();
    fs.writeFileSync(path.join(dir, "python.exe"), "");
    expect(createComponentProbes({ config: config({ mode: "spawn", python: "python" }), env: { PATH: dir, PATHEXT: ".exe" } }).provided("voice-recognizer")).toBeUndefined();
  });
});

describe("codex-cli：PATH 上有用户自己装的、版本够的 codex 算别处已经有了（454）", () => {
  /** 编一个 npm 装好的 codex（codex.cmd、旁边的 codex.js、package.json 里的版本）：不起真的 codex */
  function npmInstall(version: string): string {
    const dir = makeTempDir("ergo-fake-npm-");
    const pkg = path.join(dir, "node_modules", "@openai", "codex");
    fs.mkdirSync(path.join(pkg, "bin"), { recursive: true });
    fs.writeFileSync(path.join(dir, process.platform === "win32" ? "codex.cmd" : "codex"), "");
    fs.writeFileSync(path.join(pkg, "bin", "codex.js"), "");
    fs.writeFileSync(path.join(pkg, "package.json"), JSON.stringify({ version }));
    return dir;
  }
  const probes = (env: NodeJS.ProcessEnv) => createComponentProbes({ config: config({ mode: "spawn", python: "python" }), env });

  test("版本够的：写明版本和在哪；太旧的、没有的不算（太旧的照样从组件页装）；组件区里装的不算别处", () => {
    const dir = npmInstall("0.170.2");
    expect(probes({ PATH: dir }).provided("codex-cli")).toBe(`本机已经装了 Codex 0.170.2，在用它（${path.join(dir, "node_modules", "@openai", "codex", "bin", "codex.js")}）`);
    expect(probes({ PATH: npmInstall("0.100.0") }).provided("codex-cli")).toBeUndefined();
    expect(probes({ PATH: makeTempDir("ergo-empty-path-") }).provided("codex-cli")).toBeUndefined();
    // 组件区里装的（ERGO_COMPONENTS_DIR 指着）不算"别处已经有了"：那就是这个组件本身
    const componentsDir = makeTempDir("ergo-components-");
    const script = path.join(componentsDir, "codex", "node_modules", "@openai", "codex", "bin", "codex.js");
    fs.mkdirSync(path.dirname(script), { recursive: true });
    fs.writeFileSync(script, "");
    fs.writeFileSync(path.join(path.dirname(script), "..", "package.json"), JSON.stringify({ version: "0.166.0" }));
    expect(probes({ PATH: makeTempDir("ergo-empty-path-"), ERGO_COMPONENTS_DIR: componentsDir }).provided("codex-cli")).toBeUndefined();
  });
});
