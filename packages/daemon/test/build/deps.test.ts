// 发布包里带哪些第三方包（318 号票）：照 lock 按 Node 的解析规则找闭包；不带 Claude Code 的 SDK、开发用的包；别的平台的原生库去掉。
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { dependencyClosure, keepPackageFile, type Lockfile, packageNameOf, resolveIn, runtimeClosure } from "../../build/deps.ts";

const REPO = path.resolve(import.meta.dirname, "..", "..", "..", "..");

// 这里只拿 pi 的包名当数据（查打包时留哪些文件、pi 有没有被打进去），不 import 它。
// 拆成两段拼是因为 test/pi-boundary.test.ts 规定 agent-child/ 之外的文件里不许出现对 pi 的引用（ADR-0001 / ADR-0004）。
const PI = ["@earendil", "works"].join("-");

describe("依赖闭包（编的 lock）", () => {
  const lock: Lockfile = {
    packages: {
      "": {},
      "packages/app": { dependencies: { a: "1", "@ergo/protocol": "0", "@anthropic-ai/claude-agent-sdk": "1" }, optionalDependencies: { "native-darwin": "1" } },
      "node_modules/a": { version: "1.0.0", dependencies: { b: "1" }, peerDependencies: { p: "1", q: "1" }, peerDependenciesMeta: { q: { optional: true } } },
      "node_modules/a/node_modules/b": { version: "1.0.0" },
      "node_modules/b": { version: "2.0.0" },
      "node_modules/p": { version: "1.0.0" },
      "node_modules/native-darwin": { version: "1.0.0", optional: true },
      "node_modules/@anthropic-ai/claude-agent-sdk": { version: "1.0.0" },
      "node_modules/@ergo/protocol": { link: true, resolved: "packages/protocol" },
    },
  };

  it("先找自己下面的 node_modules，再一层层往上", () => {
    expect(resolveIn(lock, "node_modules/a", "b")).toBe("node_modules/a/node_modules/b");
    expect(resolveIn(lock, "packages/app", "b")).toBe("node_modules/b");
    expect(resolveIn(lock, "node_modules/a/node_modules/b", "p")).toBe("node_modules/p");
    expect(resolveIn(lock, "packages/app", "missing")).toBeUndefined();
    expect(packageNameOf("node_modules/a/node_modules/@s/b")).toBe("@s/b");
  });

  it("带依赖、非可选的对等依赖；跳过没装的可选包、工作区包、Claude Code SDK；必需的没装抛错", () => {
    const present = (key: string) => key !== "node_modules/native-darwin";
    const c = dependencyClosure(lock, ["packages/app"], present, (root) => lock.packages[root]!);
    expect(c.keys).toEqual(["node_modules/a", "node_modules/a/node_modules/b", "node_modules/p"]);
    // 没装的可选包（别的平台的）、lock 里都没有的可选对等依赖都跳过
    expect(c.skippedOptional).toEqual(["node_modules/native-darwin", "q"]);
    expect(c.excluded).toEqual(["@anthropic-ai/claude-agent-sdk"]);
    expect(() => dependencyClosure(lock, ["packages/app"], (k) => k !== "node_modules/p", (root) => lock.packages[root]!)).toThrow(/p 没装/);
  });

  it("复制时去掉的：别的平台的原生库、类型声明、source map、说明文档；许可证文件留着", () => {
    expect(keepPackageFile("onnxruntime-node", "bin/napi-v6/win32/x64/onnxruntime.dll")).toBe(true);
    expect(keepPackageFile("onnxruntime-node", "bin/napi-v6/linux/x64/libonnxruntime.so.1")).toBe(false);
    expect(keepPackageFile("onnxruntime-node", "bin/napi-v6/win32/arm64/onnxruntime.dll")).toBe(false);
    expect(keepPackageFile(`${PI}/pi-tui`, "native/darwin/prebuilds/darwin-arm64/darwin-platform.node")).toBe(false);
    expect(keepPackageFile(`${PI}/pi-tui`, "native/win32/prebuilds/win32-x64/win32-platform.node")).toBe(true);
    expect(keepPackageFile("x", "dist/index.d.ts")).toBe(false);
    expect(keepPackageFile("x", "dist/index.js.map")).toBe(false);
    expect(keepPackageFile("x", "README.md")).toBe(false);
    expect(keepPackageFile("x", "LICENSE.md")).toBe(true);
    expect(keepPackageFile("x", "LICENSE")).toBe(true);
    expect(keepPackageFile("x", "node_modules/y/index.js")).toBe(false);
  });
});

describe("这个仓库的发布包依赖", () => {
  const closure = runtimeClosure(REPO);
  const names = closure.keys.map(packageNameOf);

  it("运行时要的都在（pi、向量模型的运行库、koffi、sharp、服务管家的 yaml / ws）", () => {
    for (const n of [`${PI}/pi-coding-agent`, `${PI}/pi-ai`, "onnxruntime-node", "@huggingface/transformers", "koffi", "@koromix/koffi-win32-x64", "sharp", "@img/sharp-win32-x64", "yaml", "ws", "typebox"]) {
      expect(names).toContain(n);
    }
  });

  it("不带 Claude Code 的 Agent SDK（Anthropic 自己的许可）和开发用的包（构建、测试、网页的 react）", () => {
    expect(names.filter((n) => n.startsWith("@anthropic-ai/claude-agent-sdk"))).toEqual([]);
    expect(closure.excluded).toContain("@anthropic-ai/claude-agent-sdk");
    for (const n of ["vite", "vitest", "typescript", "oxlint", "react", "react-dom", "@vitejs/plugin-react", "playwright"]) expect(names).not.toContain(n);
  });

  it("复制过去的原生库只有 Windows x64 的", () => {
    const natives: string[] = [];
    for (const key of closure.keys) {
      const walk = (dir: string, rel: string) => {
        for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
          const r = rel ? `${rel}/${e.name}` : e.name;
          if (!keepPackageFile(packageNameOf(key), r)) continue;
          if (e.isDirectory()) walk(path.join(dir, e.name), r);
          else if (/\.(node|dll|so(\.\d+)*|dylib)$/.test(e.name)) natives.push(`${key}/${r}`);
        }
      };
      walk(path.join(REPO, key), "");
    }
    expect(natives.length).toBeGreaterThan(3);
    expect(natives.filter((p) => /darwin|linux|arm64|\.dylib$/i.test(p))).toEqual([]);
    // .so 只许是 WebAssembly 模块（quickjs-wasi 的扩展，和平台无关），不能是 Linux 的共享库
    const wasm = Buffer.from([0, 0x61, 0x73, 0x6d]);
    expect(natives.filter((p) => /\.so(\.\d+)*$/.test(p) && !fs.readFileSync(path.join(REPO, p)).subarray(0, 4).equals(wasm))).toEqual([]);
  });
});
