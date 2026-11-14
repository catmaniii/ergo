// @i18n-ignore-file model：出错时给 agent 看的一句（别的话在 ego-shim.ts 的 runEgoShim 里）
// agent 的 PATH 上那个 ego-browser 的入口（466 返修；ego-shim.ts 写的两个脚本都调它）：
//   node ego-browser-shim-main.ts <shim 目录> [ego-browser 的参数…]
// 先确保 ego lite 开着（没开就替用户打开、不在二狗的 Job 里），再把参数原样交给真的 ego-browser，退出码原样带回（见 runEgoShim）。
import { runEgoShim } from "./ego-shim.ts";

const [dir, ...args] = process.argv.slice(2);
runEgoShim({ dir: dir ?? ".", args }).then(
  (code) => process.exit(code),
  (err: unknown) => {
    process.stderr.write(`[二狗] ego-browser 的转接出错：${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  },
);
