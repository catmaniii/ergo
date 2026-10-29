// Claude Code 插件的边界（287 号票，ADR-0027、ADR-0001，照日历插件的 test/calendar/boundary.test.ts 和 pi 的 test/pi-boundary.test.ts）：
// 1. 组合根（daemon.ts）里不出现它；插件目录之外只从 claude-code/api.ts 拿东西，写明的例外只有插件清单列它；
// 2. 子进程的模块（claude-code/child/）只由守护进程按路径拉起：src 里别的模块不 import 它们；
// 3. Agent SDK 只在子进程里：src 里只有 claude-code/child/ 引用 @anthropic-ai/claude-agent-sdk，真的 SDK 函数只在两个入口里引——适配子进程的
//    main.ts（query）、290 号票的一次性子进程 sessions-main.ts（listSessions、getSessionMessages、forkSession）；别处只引类型；
//    例外是 315 号票的 claude-code/sdk-installed.ts：只按包名找它装没装（SDK 是可选依赖），文件里没有 import 它；
// 4. 插件不拥有数据：没有视图，数据契约里只登记运行时（能力清单逐项写明），装配只备好接管用的会话来源（290 号票：要内核的一次性子进程）
//    和交给官方 App 用的命令行（292 号票：要守护进程自己的环境）。
import fs from "node:fs";
import path from "node:path";
import { RUNTIME_OPERATIONS } from "@ergo/protocol";
import { describe, expect, it } from "vitest";
import { CLAUDE_CODE_RUNTIME_ID } from "../../src/claude-code/api.ts";
import { claudeCodePlugin } from "../../src/claude-code/plugin.ts";
import type { ContractContext } from "../../src/plugins/host.ts";
import { KERNEL } from "../../src/plugins/kernel.ts";
import type { AgentRuntime } from "../../src/runtime/index.ts";

const srcRoot = path.resolve(import.meta.dirname, "../../src");
const SDK = "@anthropic-ai/claude-agent-sdk";

function sourceFiles(dir: string): Array<{ path: string; content: string }> {
  return fs
    .readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((d) => d.isFile() && d.name.endsWith(".ts"))
    .map((d) => {
      const file = path.join(d.parentPath, d.name);
      return { path: path.relative(srcRoot, file).split(path.sep).join("/"), content: fs.readFileSync(file, "utf8") };
    });
}

/** 去掉注释（注释里提到不算） */
const withoutComments = (code: string) => code.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/.*$/gm, "$1");

/** 写明的例外：谁 → 插件的哪个文件 */
const ALLOWED = ["plugins/manifest.ts → claude-code/plugin.ts"];

describe("Claude Code 插件的边界", () => {
  const files = sourceFiles(srcRoot);

  it("组合根里不出现 Claude Code 插件；插件目录之外只 import claude-code/api.ts（例外写明）", () => {
    const root = withoutComments(files.find((f) => f.path === "daemon.ts")!.content);
    expect(root).not.toMatch(/claudeCode|claude-code/);
    expect(root).toContain("PLUGIN_MANIFEST");
    const imports = files
      .filter((f) => !f.path.startsWith("claude-code/"))
      .flatMap((f) => [...f.content.matchAll(/from\s+["']([^"']*claude-code\/[^"']+)["']/g)].map((m) => `${f.path} → ${path.posix.normalize(path.posix.join(path.posix.dirname(f.path), m[1]!))}`));
    expect(imports.filter((i) => !i.endsWith("→ claude-code/api.ts") && !ALLOWED.includes(i))).toEqual([]);
    expect(imports).toContain("plugins/manifest.ts → claude-code/plugin.ts");
  });

  it("子进程的模块只由守护进程按路径拉起：src 里子进程目录之外不 import 它们", () => {
    const leaks = files
      .filter((f) => !f.path.startsWith("claude-code/child/"))
      .flatMap((f) => [...withoutComments(f.content).matchAll(/(?:from\s*|import\s*\(\s*)["']([^"']*child\/[^"']+)["']/g)].map((m) => ({ file: f.path, spec: m[1]! })))
      .filter(({ file, spec }) => path.posix.normalize(path.posix.join(path.posix.dirname(file), spec)).startsWith("claude-code/child/"))
      .map(({ file, spec }) => `${file} → ${spec}`);
    expect(leaks).toEqual([]);
  });

  it("Agent SDK 只在子进程里：src 里只有 claude-code/child/ 引用它（例外：只找它装没装的 sdk-installed.ts，不 import），真的 SDK 只经 child/load-sdk.ts 加载、两个入口用它", () => {
    const referencing = files.filter((f) => withoutComments(f.content).includes(SDK)).map((f) => f.path);
    expect(referencing.length).toBeGreaterThan(0);
    expect(referencing.filter((p) => !p.startsWith("claude-code/child/"))).toEqual(["claude-code/sdk-installed.ts"]);
    const finder = withoutComments(files.find((f) => f.path === "claude-code/sdk-installed.ts")!.content);
    expect(finder).not.toMatch(/(?:from\s*|import\s*\(\s*)["']@anthropic-ai\/claude-agent-sdk/);
    // 318 号票：静态 import 真的 SDK 的一个都没有（装好的程序里 node_modules 没有它，静态 import 会让子进程起不来）；
    // 只有 load-sdk.ts 动态 import 它（找不到再到组件区找），适配子进程、一次性子进程两个入口从那里拿
    const escaped = SDK.replace("/", "\\/");
    const valueImports = files.filter((f) => new RegExp(`import\\s+(?!type\\b)[^;]*from\\s+["']${escaped}["']`).test(withoutComments(f.content))).map((f) => f.path);
    expect(valueImports).toEqual([]);
    const dynamicImports = files.filter((f) => new RegExp(`(?<!typeof\\s)import\\s*\\(\\s*["']${escaped}["']`).test(withoutComments(f.content))).map((f) => f.path);
    expect(dynamicImports).toEqual(["claude-code/child/load-sdk.ts"]);
    const loaders = files.filter((f) => /await loadClaudeSdk\(\)/.test(withoutComments(f.content))).map((f) => f.path);
    expect(loaders.toSorted()).toEqual(["claude-code/child/main.ts", "claude-code/child/sessions-main.ts"]);
  });

  it("插件不拥有数据：没有视图；数据契约里只登记 Claude Code 运行时（能力清单逐项写明、子进程入口是 child/main）", () => {
    expect(claudeCodePlugin.views ?? []).toEqual([]);
    // 290 号票：接管已有会话的会话来源经内核的一次性子进程读本机会话；292 号票：交给官方 App 的命令行按守护进程自己的环境跑
    expect(claudeCodePlugin.needs ?? []).toEqual([KERNEL.oneShot, KERNEL.env]);
    const registered: AgentRuntime[] = [];
    const touched: string[] = [];
    const record = (name: string) => () => {
      touched.push(name);
    };
    const ctx = {
      plugin: claudeCodePlugin.name,
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
    claudeCodePlugin.contracts!(ctx);
    expect(touched).toEqual([]);
    expect(registered).toHaveLength(1);
    const [runtime] = registered;
    expect(runtime).toMatchObject({ id: CLAUDE_CODE_RUNTIME_ID, title: "Claude Code" });
    expect(Object.keys(runtime!.capabilities).toSorted()).toEqual([...RUNTIME_OPERATIONS].toSorted());
    expect(path.relative(srcRoot, runtime!.entry).split(path.sep).join("/")).toBe("claude-code/child/main.ts");
    expect(fs.existsSync(runtime!.entry)).toBe(true);
  });
});
