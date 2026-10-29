// 推理库（rg.db）→ 节点和依赖的 YAML（253 号票；256 号票补了三处；267 号票把导出规则挪进 @ergo/memory 的
// exportReasoningTemplate——这里只剩读参数、只读打开库、写文件）。
//
// 用途：把二狗现在记的东西导出成一份通用的有向无环图（每个节点 id、kind、statement、deps、status），给人看图、
// 拿别的工具查。每晚校验不用它（326 号票起是直接查库的图谱自检，@ergo/memory 的 graph-check.ts）。
// 只读：`openReadonlyDatabase`（WAL 下不写、不建库、不动 manifest）。
//
//   npm run memory:dump-template                          # 全部结论 + 它们依赖的事实 + 开着的问题
//   npm run memory:dump-template -- --out rg.yaml --tiers need,value
//   npm run memory:dump-template -- --all-facts --no-questions
//   npm run memory:dump-template -- --with-evidence        # 连证据层一起导（图里多出一层）
//
// 映射见 packages/memory/src/rg/template-export.ts 的开头（和 docs/memory-vocabulary.md 那张对照表一致）。
// 这一版是单向导出（rg.db → YAML）；反向导入另说。
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { exportReasoningTemplate } from "@ergo/memory";
import { dataDirLayout } from "../../src/config/data-dir.ts";
import { openReadonlyDatabase } from "../../src/storage/sqlite.ts";

/** 命令行参数 */
function args(): { dataDir?: string; out: string; tiers?: string[]; allFacts: boolean; questions: boolean; withEvidence: boolean; limit?: number } {
  const argv = process.argv.slice(2);
  const value = (name: string) => {
    const i = argv.indexOf(`--${name}`);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const tiers = value("tiers");
  return {
    ...(value("data-dir") === undefined ? {} : { dataDir: value("data-dir")! }),
    out: value("out") ?? "memory-graph.yaml",
    ...(tiers === undefined ? {} : { tiers: tiers.split(",").map((t) => t.trim()).filter(Boolean) }),
    ...(value("limit") === undefined ? {} : { limit: Number(value("limit")) }),
    allFacts: argv.includes("--all-facts"),
    questions: !argv.includes("--no-questions"),
    withEvidence: argv.includes("--with-evidence"),
  };
}

const options = args();
const layout = dataDirLayout(options.dataDir ?? (process.env.ERGO_DATA_DIR ?? path.join(os.homedir(), ".ergo")));
// 338 号票：推理库的位置按数据目录布局算（会意插件自己的目录），不在这里拼 db/rg.db
const file = layout.rgDb;
if (!fs.existsSync(file) || fs.statSync(file).size === 0) {
  console.log(`还没有推理库：${file}（跑过每晚整理才有）`);
  process.exit(1);
}

const db = openReadonlyDatabase(file);
const exported = exportReasoningTemplate(db, {
  ...(options.tiers === undefined ? {} : { tiers: options.tiers }),
  ...(options.limit === undefined ? {} : { limit: options.limit }),
  allFacts: options.allFacts,
  questions: options.questions,
  withEvidence: options.withEvidence,
  sourceLabel: `${file}（只读打开）`,
});
db.close();

fs.mkdirSync(path.dirname(path.resolve(options.out)), { recursive: true });
fs.writeFileSync(options.out, exported.yaml, "utf8");

const c = exported.counts;
console.log(`写出 ${path.resolve(options.out)}`);
console.log(`  证据 ${c.evidence} 条、事实 ${c.facts} 条、结论 ${c.claims} 条（其中 ${c.claimsWithoutPremises} 条没前提，按 fact 导；${c.provisional} 条是临时结论）、问题 ${c.questions} 条`);
console.log("  整张图的规矩每晚整理完由图谱自检查（整理报告里的\"每晚校验\"那一行），这份只是给人看的。");
