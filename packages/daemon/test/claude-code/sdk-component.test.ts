// Claude Code 的 Agent SDK 装在组件区（318 号票）：安装包、源码装的程序目录里没有 SDK（不随二狗分发），用的人在设置 · 组件里从 npm 官方下到
// <数据目录>\components\claude-code\node_modules。这里查：
//   - 插件的"没装"认组件区里的（宿主把组件区交给 missing）；装好的程序（转好的 .js）没装时说去组件里装，开发时说在程序目录 npm 装；
//   - 子进程的加载：包名找得到用包名的；找不到用组件区的（按文件路径 import，ESM 不认 NODE_PATH）；都没有抛原来的错；
//   - 组件清单里 claude-code 组件装到的地方和这里找的是同一个；守护进程给子进程带上组件区在哪。
// 用一个假的 SDK 包（只导出几个名字），不下真的 SDK。
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createClaudeCodePlugin } from "../../src/claude-code/plugin.ts";
import { loadClaudeSdk } from "../../src/claude-code/child/load-sdk.ts";
import { CLAUDE_SDK_PACKAGE, claudeSdkEntryIn, claudeSdkInstalled, claudeSdkMissing } from "../../src/claude-code/sdk-installed.ts";
import { loadManifest } from "../../src/components/manifest.ts";
import { COMPONENTS_DIR_ENV } from "../../src/process/child-env.ts";

const dirs: string[] = [];
function tmp(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ergo-sdk-comp-"));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

/** 在组件区摆一个假的 SDK 包（ESM，exports 只有 default 条件，和真的一样） */
function fakeSdkComponent(componentsDir: string): string {
  const pkg = path.join(componentsDir, "claude-code", "node_modules", ...CLAUDE_SDK_PACKAGE.split("/"));
  fs.mkdirSync(pkg, { recursive: true });
  fs.writeFileSync(path.join(pkg, "package.json"), JSON.stringify({ name: CLAUDE_SDK_PACKAGE, version: "0.0.1", type: "module", exports: { ".": { types: "./sdk.d.ts", default: "./sdk.mjs" } } }));
  fs.writeFileSync(path.join(pkg, "sdk.mjs"), 'export const query = () => "fake query";\nexport const listSessions = () => [];\nexport const forkSession = () => "fork";\nexport const getSessionMessages = () => [];\n');
  return path.join(pkg, "sdk.mjs");
}

const notFound = () => Promise.reject(Object.assign(new Error(`Cannot find package '${CLAUDE_SDK_PACKAGE}'`), { code: "ERR_MODULE_NOT_FOUND" }));

describe("组件区里的 SDK", () => {
  it("找得到入口（只看那个组件自己的 node_modules）；没装时是 undefined", () => {
    const components = tmp();
    expect(claudeSdkEntryIn(components)).toBeUndefined();
    const entry = fakeSdkComponent(components);
    expect(claudeSdkEntryIn(components)).toBe(entry);
    // 开发时仓库的 node_modules 里有 SDK：本来就算装了
    expect(claudeSdkInstalled()).toBe(true);
    expect(claudeSdkInstalled(components)).toBe(true);
  });

  it("子进程加载：包名找得到用包名的；找不到用组件区的；都没有抛原来的错；别的错照抛", async () => {
    const components = tmp();
    const env = { [COMPONENTS_DIR_ENV]: components };
    const real = await loadClaudeSdk({});
    expect(typeof real.query).toBe("function");
    await expect(loadClaudeSdk(env, { importPackage: notFound })).rejects.toThrow(/Cannot find package/);
    await expect(loadClaudeSdk({}, { importPackage: notFound })).rejects.toThrow(/Cannot find package/);
    fakeSdkComponent(components);
    const fromComponent = await loadClaudeSdk(env, { importPackage: notFound });
    expect((fromComponent.query as unknown as () => string)()).toBe("fake query");
    await expect(loadClaudeSdk(env, { importPackage: () => Promise.reject(new SyntaxError("broken")) })).rejects.toThrow(/broken/);
  });

  it("插件的“没装”：组件区里有就算装了；装好的程序没装时说去组件里装，开发时说在程序目录 npm 装", () => {
    const components = tmp();
    const plugin = createClaudeCodePlugin();
    // 开发时仓库里有 SDK：不缺
    expect(plugin.missing?.({ componentsDir: components })).toBeUndefined();
    const absent = () => false;
    expect(claudeSdkMissing(absent, false)).toMatch(/设置 · 组件里装「Claude Code 接入」.*ergo components add claude-code/);
    expect(claudeSdkMissing(absent, true)).toMatch(/npm install --no-save @anthropic-ai\/claude-agent-sdk@/);
    expect(claudeSdkMissing(() => claudeSdkEntryIn(components) !== undefined, false)).toBeDefined();
    fakeSdkComponent(components);
    expect(claudeSdkMissing(() => claudeSdkEntryIn(components) !== undefined, false)).toBeUndefined();
  });

  it("组件清单里 claude-code 装到 components/claude-code、解到 node_modules/<包名>：和这里找的是同一个地方", () => {
    const { manifest } = loadManifest();
    const component = manifest.components.find((c) => c.id === "claude-code")!;
    expect(component.target).toBe("components/claude-code");
    const tos = component.variants.flatMap((v) => v.parts.flatMap((p) => (p.files ?? []).map((f) => f.extract?.to)));
    expect(tos).toContain(`node_modules/${CLAUDE_SDK_PACKAGE}`);
  });
});
