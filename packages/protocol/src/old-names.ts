// 312 号票：系统里的 ergou（拼音）换成了 ergo（代码、数据目录、LSM、浏览器存储）。兼容期旧名字照样认，规矩是：
// - 读的时候新旧都认，新的优先；写的时候只写新的（旧的读到了就换成新的写回，或者原样放着等迁移脚本改名）；
// - 旧名字一律用 oldNameOf 从新名字推出来，别处不写旧的拼法。`git grep -i ergou` 只剩这里、迁移脚本
//   （packages/daemon/src/migrate-ergo.ts）、鸿蒙 App 的 common/OldNames.ets、页面桥里给旧 App 留的口令占位和兼容的测试。
// 守护进程、网页、鸿蒙 App 认旧名字的地方见 docs/developer-guide.md 的"从 ergou 迁到 ergo"。

/** 旧的拼法 */
export const OLD_SPELLING = "ergou";

/**
 * 新名字对应的旧名字：里面的 ergo / Ergo / ERGO 换成 ergou / Ergou / ERGOU（大小写各自对应）。
 * ERGO_DATA_DIR → ERGOU_DATA_DIR，.ergo → .ergou，ergo.db → ergou.db，__Host-ergo-device → __Host-ergou-device，ergoNative → ergouNative
 */
export function oldNameOf(name: string): string {
  return name.replace(/ergo(?!u)/gi, (m) => m + (m === m.toUpperCase() ? "U" : "u"));
}

/** 旧名字换成新名字（读到旧的写法时归一）：ergou / Ergou / ERGOU 换成 ergo / Ergo / ERGO */
export function newNameOf(name: string): string {
  return name.replace(new RegExp(OLD_SPELLING, "gi"), (m) => m.slice(0, -1));
}

/** 是这个名字，或者它的旧名字 */
export function isNameOrOld(actual: unknown, name: string): boolean {
  return actual === name || actual === oldNameOf(name);
}
