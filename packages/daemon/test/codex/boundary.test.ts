// Codex 插件的边界（照 test/claude-code/boundary.test.ts）：
// 1. 组合根里不出现它；插件目录之外只从 codex/api.ts 拿东西，写明的例外只有插件清单列它；
// 2. 子进程的模块（codex/child/）只由守护进程按路径拉起：src 里别的模块不 import 它们；钩子脚本、MCP 中转只引 node 自带的模块（每次调用都要起一个进程）；
// 3. 不读 ~/.codex：src 里没有拼 .codex 路径、没有 auth.json；真的 codex 只在两个入口里起；不加 npm 依赖；
// 4. 插件不拥有数据：没有视图，数据契约里只登记运行时（能力清单逐项写明）。
import fs from "node:fs";
import path from "node:path";
import { RUNTIME_OPERATIONS } from "@ergo/protocol";
import { describe, expect, it } from "vitest";
import { CODEX_RUNTIME_ID } from "../../src/codex/api.ts";
import { codexPlugin } from "../../src/codex/plugin.ts";
import { CODEX_CAPABILITIES } from "../../src/codex/runtime.ts";
import type { ContractContext } from "../../src/plugins/host.ts";
import { KERNEL } from "../../src/plugins/kernel.ts";
import type { AgentRuntime } from "../../src/runtime/index.ts";

const srcRoot = path.resolve(import.meta.dirname, "../../src");

function sourceFiles(dir: string): Array<{ path: string; content: string }> {
  return fs
    .readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((d) => d.isFile() && d.name.endsWith(".ts"))
    .map((d) => {
      const file = path.join(d.parentPath, d.name);
      return { path: path.relative(srcRoot, file).split(path.sep).join("/"), content: fs.readFileSync(file, "utf8") };
    });
}

const withoutComments = (code: string) => code.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/.*$/gm, "$1");

const ALLOWED = ["plugins/manifest.ts → codex/plugin.ts"];

describe("Codex 插件的边界", () => {
  const files = sourceFiles(srcRoot);

  it("组合根里不出现 Codex 插件；插件目录之外只 import codex/api.ts（例外写明）", () => {
    const root = withoutComments(files.find((f) => f.path === "daemon.ts")!.content);
    expect(root).not.toMatch(/codexPlugin|codex\//);
    const imports = files
      .filter((f) => !f.path.startsWith("codex/"))
      .flatMap((f) => [...f.content.matchAll(/from\s+["']([^"']*codex\/[^"']+)["']/g)].map((m) => `${f.path} → ${path.posix.normalize(path.posix.join(path.posix.dirname(f.path), m[1]!))}`));
    expect(imports.filter((i) => !i.endsWith("→ codex/api.ts") && !ALLOWED.includes(i))).toEqual([]);
    expect(imports).toContain("plugins/manifest.ts → codex/plugin.ts");
  });

  it("子进程的模块只由守护进程按路径拉起：src 里子进程目录之外不 import 它们", () => {
    const leaks = files
      .filter((f) => !f.path.startsWith("codex/child/"))
      .flatMap((f) => [...withoutComments(f.content).matchAll(/(?:from\s*|import\s*\(\s*)["']([^"']*child\/[^"']+)["']/g)].map((m) => ({ file: f.path, spec: m[1]! })))
      .filter(({ file, spec }) => path.posix.normalize(path.posix.join(path.posix.dirname(file), spec)).startsWith("codex/child/"))
      .map(({ file, spec }) => `${file} → ${spec}`);
    expect(leaks).toEqual([]);
  });

  it("Codex 拉起的两个小程序（钩子、中转）只引 node 自带的模块和 bridge-client.ts", () => {
    for (const name of ["guard-hook.ts", "mcp-relay.ts", "bridge-client.ts"]) {
      const code = withoutComments(files.find((f) => f.path === `codex/child/${name}`)!.content);
      const imported = [...code.matchAll(/from\s+["']([^"']+)["']/g)].map((m) => m[1]!);
      expect(imported.filter((spec) => !spec.startsWith("node:") && spec !== "./bridge-client.ts")).toEqual([]);
    }
  });

  it("不读 ~/.codex：src 里没有 auth.json、没有拼 .codex 目录；codex 只在两个入口里起", () => {
    const code = files.filter((f) => f.path.startsWith("codex/")).map((f) => ({ path: f.path, code: withoutComments(f.content) }));
    expect(code.filter((f) => /auth\.json|["'`/\\]\.codex["'`/\\]|config\.toml/.test(f.code)).map((f) => f.path)).toEqual([]);
    const starters = code.filter((f) => /spawnCodexServer\(/.test(f.code)).map((f) => f.path).toSorted();
    expect(starters).toEqual(["codex/child/app-server.ts", "codex/child/main.ts", "codex/child/sessions-main.ts"]);
    // 不引 npm 的 Codex 包
    expect(code.filter((f) => /from\s+["']@openai\//.test(f.code)).map((f) => f.path)).toEqual([]);
  });

  it("插件不拥有数据：没有视图；数据契约里只登记 Codex 运行时（能力清单逐项写明、子进程入口是 child/main）", () => {
    expect(codexPlugin.views ?? []).toEqual([]);
    expect(codexPlugin.needs ?? []).toEqual([KERNEL.oneShot]);
    const registered: AgentRuntime[] = [];
    const touched: string[] = [];
    const record = (name: string) => () => {
      touched.push(name);
    };
    const ctx = {
      plugin: codexPlugin.name,
      cardTypes: { register: record("cardTypes") },
      purge: { register: record("purge"), registerQuotes: record("purgeQuotes") },
      materialSources: { register: record("materialSources") },
      requests: { register: record("requests") },
      removal: { declare: record("removal") },
      runtimes: { register: (runtime: AgentRuntime) => registered.push(runtime) },
      active: () => {
        throw new Error("不该取服务");
      },
    } as unknown as ContractContext;
    codexPlugin.contracts!(ctx);
    expect(touched).toEqual([]);
    expect(registered).toHaveLength(1);
    const [runtime] = registered;
    expect(runtime).toMatchObject({ id: CODEX_RUNTIME_ID, title: "Codex", workFolder: true, recordedScopeReview: true });
    expect(Object.keys(runtime!.capabilities).toSorted()).toEqual([...RUNTIME_OPERATIONS].toSorted());
    expect(path.relative(srcRoot, runtime!.entry).split(path.sep).join("/")).toBe("codex/child/main.ts");
    expect(fs.existsSync(runtime!.entry)).toBe(true);
  });

  it("能力清单照实：能做的、不做的逐项", () => {
    expect(CODEX_CAPABILITIES).toEqual({
      interject: true,
      compact: true,
      rollback: true,
      branch_switch: true,
      branch_summary: false,
      rewind_files: false,
      model_handoff: true,
      thinking_levels: true,
      slash_passthrough: false,
      take_over: true,
      purge_rewrite: false,
      yield: false,
      live_toolkit: false,
      scope_review: true,
      remote_control: false,
    });
  });
});
