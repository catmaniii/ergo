// 设置里的"关于二狗"（124 号票）要的构建信息，构建时写进页面：二狗的版本（仓库根目录 package.json 的 version，现在是 0.2.1）
// 和更新日志（仓库根目录的 CHANGELOG.md；取当前版本那一节在状态层 state/changelog.ts）。
// 更新日志里照领域术语写的"秘书"在这里换成 43 号票的名字占位（markAssistantName），页面显示时填现在的名字；界面上照字面写着
// "秘书"的两处（导航上那一项、"个人秘书："）不换。按 UTF-8 的 base64 写进去，页面上解回来（src/app/build-info.ts）：
// 不换的那几处还写着"秘书"，43 号票的构建测试查"页面里没有秘书"；写成 base64 也免得压缩工具改写转义后对不上，构建测试按
// base64 认它（test/build.test.ts）。
// 页面 import "virtual:ergo-build-info"（只在 src/app/build-info.ts 一处），开发服务器（vite dev）也一样；
// 两个文件变了开发服务器跟着重新加载。改了版本号、更新日志要重新 npm run build:web，页面构建（116 号票的版本号）也跟着变。
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ASSISTANT_DOMAIN_TERM, ASSISTANT_NAME_MARK } from "@ergo/protocol";
import type { Plugin } from "vite";

/** 仓库根目录 */
const REPO_ROOT = fileURLToPath(new URL("../../../", import.meta.url));

const VIRTUAL = "virtual:ergo-build-info";
const RESOLVED = "\0virtual:ergo-build-info";

/**
 * 更新日志里要换成名字的"秘书"，和界面上照字面写着"秘书"、不换的（89 号票：导航上那一项写"秘书"——日志里加了引号说它；
 * 秘书页的标题写"个人秘书：<名字>"）。长的写在前面，先认出来
 */
const SECRETARY_WORDS = /个人秘书：|"秘书"|“秘书”|「秘书」|秘书/g;

/**
 * 更新日志里的"秘书"换成名字占位（主会话 2026-10-14 定：关于页显示时换成用户起的名字，和界面上别处一样）。CHANGELOG.md 照领域
 * 术语写"秘书"；在构建时换成 43 号票的名字占位，页面按现在的名字填（state/changelog.ts 的 changelogWithName），页面代码里
 * 就不用写"秘书"。界面上照字面写着"秘书"的两处不换
 */
export function markAssistantName(markdown: string): string {
  return markdown.replace(SECRETARY_WORDS, (word) => (word === ASSISTANT_DOMAIN_TERM ? ASSISTANT_NAME_MARK : word));
}

/** 二狗的版本和更新日志（"秘书"换成了名字占位）的 base64（测试也用它，看的就是构建产物里那段） */
export function buildInfo(root: string = REPO_ROOT): { version: string; changelogBase64: string } {
  const packageJson = path.join(root, "package.json");
  const changelog = path.join(root, "CHANGELOG.md");
  const version = (JSON.parse(fs.readFileSync(packageJson, "utf8")) as { version?: unknown }).version;
  if (typeof version !== "string" || version === "") throw new Error(`${packageJson} 里没有 version`);
  // 没有更新日志也照常构建：关于页说没有这一版的记录
  const text = fs.existsSync(changelog) ? fs.readFileSync(changelog, "utf8") : "";
  return { version, changelogBase64: Buffer.from(markAssistantName(text), "utf8").toString("base64") };
}

/** 虚拟模块的代码 */
function buildInfoModule(): string {
  const { version, changelogBase64 } = buildInfo();
  return `export const APP_VERSION = ${JSON.stringify(version)};\nexport const CHANGELOG_BASE64 = ${JSON.stringify(changelogBase64)};\n`;
}

export function buildInfoPlugin(): Plugin {
  return {
    name: "ergo:build-info",
    resolveId: (id) => (id === VIRTUAL ? RESOLVED : undefined),
    load(id) {
      if (id !== RESOLVED) return undefined;
      this.addWatchFile(path.join(REPO_ROOT, "package.json"));
      this.addWatchFile(path.join(REPO_ROOT, "CHANGELOG.md"));
      return buildInfoModule();
    },
  };
}
