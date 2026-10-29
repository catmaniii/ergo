// 浏览插件的边界（212 号票，ADR-0027，照提醒插件、记忆插件的 boundary.test.ts）：
// 1. 组合根（daemon.ts）里不出现浏览插件的内部：设备通路、网页候选卡、秘书的网页工具、存进素材、取件码、缩略图、悬浮按钮的语音、
//    交给秘书的输入后面那段网页上下文都不在这里建（只从 browsing/api.ts 取服务名 BROWSING，按名字现取）；
// 2. browsing/ 之外只 import browsing/api.ts（服务名、类型、数据契约里读得出的、网页工具的名字）。写明的例外：插件清单列它；
// 3. 交给秘书的输入不再认浏览（conversation/agent-input.ts 不 import 浏览插件，那段是插件的输入附注）；
// 4. 浏览插件不直接 import 语音模块（悬浮按钮上说话的识别经内核给的 KERNEL.speech；语音拆成插件后由它提供，214 号票）；
// 5. 授权的文件夹（folders/）是内核的：不 import 浏览插件；
// 6. 原来的 page-commands/ 目录没有了（浏览插件的在 browsing/，授权的文件夹在 folders/）。
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

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

/** 去掉注释（注释里提到不算） */
const withoutComments = (code: string) => code.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/.*$/gm, "$1");

/** 一个文件 import 的（相对路径换成 src 下的路径） */
const importsOf = (f: { path: string; content: string }) =>
  [...f.content.matchAll(/from\s+["'](\.[^"']+)["']/g)].map((m) => path.posix.normalize(path.posix.join(path.posix.dirname(f.path), m[1]!)));

/** 写明的例外：谁 → 浏览插件的哪个文件 */
const ALLOWED = ["plugins/manifest.ts → browsing/plugin.ts"];

describe("浏览插件的边界", () => {
  const files = sourceFiles(srcRoot);

  it("组合根里不出现浏览插件的内部（只从 browsing/api.ts 取服务名）", () => {
    const root = files.find((f) => f.path === "daemon.ts")!;
    const code = withoutComments(root.content);
    expect(code).not.toMatch(/createBrowserLinks|browsePickCardType|browsingTools|browsingTurnOf|createSavedPages|webPageSaved|createPageFileTokens|createPageThumbnails|createPageVoice|browsingInputNote/);
    expect(importsOf(root).filter((i) => i.startsWith("browsing/"))).toEqual(["browsing/api.ts"]);
    expect(code).toContain("PLUGIN_MANIFEST");
  });

  it("browsing/ 之外只 import browsing/api.ts（例外写明）", () => {
    const imports = files.filter((f) => !f.path.startsWith("browsing/")).flatMap((f) => importsOf(f).filter((i) => i.startsWith("browsing/")).map((i) => `${f.path} → ${i}`));
    expect(imports.filter((i) => !i.endsWith("→ browsing/api.ts") && !ALLOWED.includes(i))).toEqual([]);
    // 检查本身有效：确实有经 api.ts 取的（网关、记忆插件）
    expect(imports).toContain("gateway/gateway.ts → browsing/api.ts");
    expect(imports).toContain("memory/search-tool.ts → browsing/api.ts");
    expect(imports).toContain("plugins/manifest.ts → browsing/plugin.ts");
  });

  it("交给秘书的输入不再认浏览：agent-input.ts 不 import 浏览插件", () => {
    const input = files.find((f) => f.path === "conversation/agent-input.ts")!;
    expect(importsOf(input).filter((i) => i.startsWith("browsing/"))).toEqual([]);
    expect(withoutComments(input.content)).not.toMatch(/browsing/);
  });

  it("浏览插件只经语音插件的 voice/api.ts 取识别（214 号票）；授权的文件夹（内核的）不 import 浏览插件；page-commands/ 没有了", () => {
    const browsing = files.filter((f) => f.path.startsWith("browsing/"));
    expect(browsing.length).toBeGreaterThan(10);
    expect(browsing.flatMap((f) => importsOf(f).filter((i) => i.startsWith("voice/") && i !== "voice/api.ts").map((i) => `${f.path} → ${i}`))).toEqual([]);
    expect(browsing.filter((f) => importsOf(f).includes("voice/api.ts")).map((f) => f.path).toSorted()).toEqual(["browsing/page-voice.ts", "browsing/plugin.ts"]);
    expect(files.filter((f) => f.path.startsWith("folders/")).flatMap((f) => importsOf(f).filter((i) => i.startsWith("browsing/")))).toEqual([]);
    expect(files.filter((f) => f.path.startsWith("page-commands/"))).toEqual([]);
  });
});
