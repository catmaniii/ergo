// 从 ergou 迁到 ergo 的命令（312 号票，做法见 migrate/ergo-rename.ts）。切换时先在 LSM 里停掉旧的守护进程，再跑：
//   npm run migrate:ergo -- [--data-dir <旧的数据目录>] [--dry-run]
// 不给 --data-dir 是用户主目录下旧名字的数据目录。--dry-run 只列要做什么。做过的步骤重跑时跳过。
// 跑完照打印出来的几步在 LSM 里换登记、重新启动；脚本自己不启停任何服务、不碰 LSM。
// @i18n-ignore-file log：命令行工具的输出
import os from "node:os";
import { migrateToErgo } from "./migrate/ergo-rename.ts";

const USAGE = [
  "用法：npm run migrate:ergo -- [--data-dir <旧的数据目录>] [--dry-run]",
  "  不给 --data-dir：用户主目录下旧名字的数据目录；--dry-run：只列要做什么",
  "跑之前先在 Local Service Manager 里停掉旧的守护进程。",
].join("\n");

const args = process.argv.slice(2);
let dataDir: string | undefined;
let dryRun = false;
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === "--dry-run") dryRun = true;
  else if (a === "--data-dir" && args[i + 1] !== undefined) dataDir = args[++i];
  else {
    console.error(USAGE);
    process.exit(a === "--help" || a === "-h" ? 0 : 2);
  }
}

const result = await migrateToErgo({ ...(dataDir === undefined ? {} : { dataDir }), homeDir: os.homedir(), dryRun });
const MARK = { done: "✓ 做了", skipped: "· 跳过", planned: "○ 要做", failed: "✗ 没做成" } as const;
console.log(`${dryRun ? "（dry-run，只列要做什么）" : ""}旧的数据目录 ${result.oldDir} → 新的 ${result.newDir}`);
for (const step of result.steps) console.log(`${MARK[step.state]}  ${step.what}${step.detail ? `（${step.detail}）` : ""}`);
console.log("\nLSM 那边接着做（lsm = 在 LSM 目录下 node bin\\lsm.mjs）：");
result.lsmSteps.forEach((line, i) => console.log(`${i + 1}. ${line}`));
process.exit(result.ok ? 0 : 1);
