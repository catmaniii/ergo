// 工具包里的 skill 交给 Claude Code（问"二狗的 skill 能不能自动配给单独的一个 Claude 进程去用"）：
// SDK 的 plugins 选项能加载本地插件目录（{ type: "local", path }，插件里可以带 skills）。适配子进程每次起 query 之前、工具包变了的时候，
// 按这个负责人的工具包（装配参数 skillPaths：skill 库里的目录）在它的运行时目录（装配参数 runtimeDir，数据目录缓存区下每个 agent 一格）里
// 拼一个本地插件：
//   <runtimeDir>/ergo/.claude-plugin/plugin.json   插件清单（名字 ergo）
//   <runtimeDir>/ergo/skills/<目录名>/...          skill 从 skill 库复制进来
// - 复制，不硬链接：Claude 改了插件里的文件也改不到 skill 库的原件。依赖目录（skill 库里的 node_modules、.venv、venv 是指向来源的目录联接，
//   skills/library.ts）照样建一个联接指到同一个地方，不复制；别的链接不跟（skill 库导入时已经拒绝了）；
// - 目录名：skill 目录自己的名字（skill 库导入时已规范成小写、不带空格）；工具包里两个 skill 的目录名相同时，后面的加 -2、-3……（按工具包的先后）。
//   Claude Code 里插件的 skill 带插件名：斜杠命令是 /ergo:<目录名>（SKILL.md 的 name 写了别的时以 Claude Code 报回的为准，见 Comments）；
// - 每个 skill 记一个指纹（来源目录、各文件的相对路径、大小、修改时间）：没变的不重复复制，变了的整个重拷，不在工具包里的删掉；
// - 二狗只写这个目录，不写用户的 ~/.claude、项目的 .claude/（用户自己的 skill 照常由 Claude Code 自己加载）。
// 守护进程这边也用 pluginSkillNames 算斜杠命令（runtime.ts 的 toolkitSkillCommands：输入框的 / 补全），和子进程拼目录用同一套名字。
// @i18n-ignore-file log：日志；插件清单里的说明是给 Claude Code 看的
import fs from "node:fs";
import path from "node:path";
import { skillDirNames, syncSkillDirs } from "../runtime/skill-dirs.ts";

/** 插件名：Claude Code 里插件的 skill 写成 ergo:<目录名>，定了别改 */
export const ERGO_PLUGIN = "ergo";

/** 插件清单的位置（Claude Code 认的） */
const MANIFEST = path.join(".claude-plugin", "plugin.json");
/** 记各 skill 指纹的文件（插件根目录下，Claude Code 不看它） */
const STAMPS = "ergo-skills.json";

/** 工具包里的 skill 在插件里的目录名（和 skillDirs 一一对应、同样的先后）：目录自己的名字，重名的后面加 -2、-3…… */
export const pluginSkillNames = skillDirNames;

/** Claude Code 里这个 skill 的斜杠命令（不带 /） */
export const pluginSkillCommand = (name: string): string => `${ERGO_PLUGIN}:${name}`;

/** 拼好的插件：根目录（交给 query 的 plugins）、各 skill 的目录名，这次和上次比 skill 有没有变 */
export interface BuiltSkillPlugin {
  root: string;
  names: string[];
  changed: boolean;
}

/**
 * 拼（或更新）插件目录：插件根目录是 <runtimeDir>/ergo。skill 没变的不动；变了的、新加的整个重拷；不在工具包里的删掉。
 * 读不了的 skill（目录没了）跳过、记日志。返回 changed：和目录里原来的比，skill 有增减或内容变了。
 */
export function buildSkillPlugin(runtimeDir: string, skillDirs: readonly string[], log: (line: string) => void = () => {}): BuiltSkillPlugin {
  const root = path.join(runtimeDir, ERGO_PLUGIN);
  const skillsDir = path.join(root, "skills");
  fs.mkdirSync(path.join(root, ".claude-plugin"), { recursive: true });
  fs.mkdirSync(skillsDir, { recursive: true });
  const manifest = path.join(root, MANIFEST);
  const manifestText = `${JSON.stringify({ name: ERGO_PLUGIN, version: "1.0.0", description: "二狗交给这个会话的 skill（负责人工具包里的）" }, null, 2)}\n`;
  if (readText(manifest) !== manifestText) fs.writeFileSync(manifest, manifestText);

  const { names, changed } = syncSkillDirs(skillsDir, skillDirs, log, path.join(root, STAMPS));
  return { root, names, changed };
}

function readText(file: string): string | undefined {
  try {
    return fs.readFileSync(file, "utf8");
  } catch {
    return undefined;
  }
}
