// 326 号票：记忆系统不依赖本机的 skill，公开的代码里也不提它们——用到的方法写成方法本身（四档关联强度、
// 置信上限按层封顶、独立复核员只从证据重推……），每晚校验是记忆系统自己的图谱自检。
// 查记忆包（src、test）和守护进程里记忆插件那一块（src/memory、test/memory、test/main/memory-*）。
// 要找的词拆开写（免得这个文件自己被查到）；领域词"推理图谱"、模块名 rg/reasoning-graph.ts 照用。
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const REPO = fileURLToPath(new URL("../../../", import.meta.url));
const SELF = fileURLToPath(import.meta.url);

/** 不该出现的：两个 skill 的名字、找本机 skill 的路径和环境变量、skill 的校验脚本 */
const FORBIDDEN: ReadonlyArray<{ what: string; pattern: RegExp }> = [
  { what: "意图挖掘那个 skill 的名字", pattern: new RegExp(["intent", "mining"].join("-"), "i") },
  { what: "推理图谱那个 skill", pattern: new RegExp(`${["reasoning", "graph"].join("-")}(?: skill|/|\\\\| 模板)`, "i") },
  { what: "本机的 skill 目录", pattern: new RegExp(`\\.claude[/\\\\]${"skills"}`, "i") },
  { what: "找 skill 的环境变量", pattern: new RegExp(["ERGO", "RG", "SKILL", "DIR"].join("_")) },
  { what: "skill 的校验脚本", pattern: new RegExp(`rg_${"validate"}|rg_${"render"}|rg_${"audit"}`) },
  { what: "说成 skill 的规矩", pattern: new RegExp(`推理图谱 ${"skill"}`) },
];

const ROOTS = ["packages/memory/src", "packages/memory/test", "packages/daemon/src/memory", "packages/daemon/test/memory"];

function files(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((d) => {
    const full = path.join(dir, d.name);
    if (d.isDirectory()) return files(full);
    return /\.(ts|json|md)$/.test(d.name) ? [full] : [];
  });
}

/** 一段文字里撞上的（哪一行、撞上哪条） */
export function hits(text: string): string[] {
  return text.split(/\r?\n/).flatMap((line, i) => FORBIDDEN.filter((f) => f.pattern.test(line)).map((f) => `第 ${i + 1} 行：${f.what}`));
}

/** 测试用的样例也拆开拼 */
const sample = (parts: string[]) => parts.join("");

describe("记忆系统不依赖、不提本机的 skill", () => {
  it("记忆包和守护进程的记忆插件里一处都没有", () => {
    const mainTests = files(path.join(REPO, "packages/daemon/test/main")).filter((f) => path.basename(f).startsWith("memory-"));
    const all = [...ROOTS.flatMap((root) => files(path.join(REPO, root))), ...mainTests].filter((f) => f !== SELF);
    expect(all.length).toBeGreaterThan(100);
    const problems = all.flatMap((f) => hits(fs.readFileSync(f, "utf8")).map((h) => `${path.relative(REPO, f)} ${h}`));
    expect(problems).toEqual([]);
  });

  it("检查本身管用：skill 名、本机路径、环境变量、校验脚本都抓得到；领域词和模块名不算", () => {
    expect(hits(sample(["照 ", "intent", "-mining", " 的 M2"]))).toHaveLength(1);
    expect(hits(sample(["~/.claude", "/skills/", "reasoning", "-graph/scripts"]))).toHaveLength(2);
    expect(hits(sample(["ERGO", "_RG_SKILL_DIR"]))).toHaveLength(1);
    expect(hits(sample(["python rg", "_validate.py"]))).toHaveLength(1);
    expect(hits(sample(["按推理图谱 ", "skill 的规矩"]))).toHaveLength(1);
    expect(hits('import { ReasoningGraph } from "./rg/reasoning-graph.ts"; // 推理图谱的规矩')).toEqual([]);
  });
});
