// 语音插件的边界（214 号票，ADR-0027，照提醒、记忆插件的 boundary.test.ts）：核心留口子，不 import 插件——
// 1. 组合根（daemon.ts）里不出现语音插件的内部：识别进程、识别、合成、语音回复、预热、参考音色、Debug 的语音组都不在这里建，
//    只按插件清单装、经 voice/api.ts 的服务名现取；
// 2. voice/ 之外只 import voice/api.ts（例外写明：插件清单列它；配置段 voice 还在内核的配置里解析，语速的类型从 spoken-text.ts 取）；
// 3. 语音的数据契约（内核的 voice-records/）不 import 语音插件：插件停用了它照样在。
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

/** 写明的例外：谁 → 语音插件的哪个文件 */
const ALLOWED = ["plugins/manifest.ts → voice/plugin.ts", "config/config.ts → voice/spoken-text.ts"];

/** 一个文件 import 的语音插件的文件（"谁 → voice/…"） */
const voiceImportsOf = (file: { path: string; content: string }) =>
  [...file.content.matchAll(/from\s+["']([^"']*\/voice\/[^"']+)["']/g)].map((m) => `${file.path} → ${path.posix.normalize(path.posix.join(path.posix.dirname(file.path), m[1]!))}`);

describe("语音插件的边界", () => {
  const files = sourceFiles(srcRoot);

  it("组合根里不出现语音插件的内部（识别、合成、语音回复、预热、参考音色、Debug 的语音组），只经 voice/api.ts", () => {
    const root = withoutComments(files.find((f) => f.path === "daemon.ts")!.content);
    expect(root).not.toMatch(
      /createVoiceService|createVoiceReplies|createProcessRecognizer|unavailableRecognizer|createVoiceWarmup|createAudioCppSynthesizer|openReferenceVoices|createDebugVoice|voicePlugin|RECOGNIZER_/,
    );
    expect(voiceImportsOf({ path: "daemon.ts", content: root })).toEqual(["daemon.ts → voice/api.ts"]);
    expect(root).toContain("PLUGIN_MANIFEST");
  });

  it("voice/ 之外只 import voice/api.ts（例外写明）", () => {
    const imports = files.filter((f) => !f.path.startsWith("voice/")).flatMap(voiceImportsOf);
    expect(imports.filter((i) => !i.endsWith("→ voice/api.ts") && !ALLOWED.includes(i))).toEqual([]);
    // 检查本身有效：确实有经 api.ts 取的、经清单列的
    expect(imports).toContain("gateway/http-api.ts → voice/api.ts");
    expect(imports).toContain("plugins/manifest.ts → voice/plugin.ts");
  });

  it("语音的数据契约（voice-records/）不 import 语音插件", () => {
    const records = files.filter((f) => f.path.startsWith("voice-records/"));
    expect(records.map((f) => f.path)).toContain("voice-records/views.ts");
    expect(records.flatMap(voiceImportsOf)).toEqual([]);
  });
});
