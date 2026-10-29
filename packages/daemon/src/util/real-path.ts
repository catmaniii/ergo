// 真实路径：展开符号链接、目录联接和 8.3 短名（fs.realpathSync.native）。守卫看到的数据目录各区、agent 的工作目录、
// 判定前现取的文件事实（guard-runtime/facts.ts）、发附件时"文件在不在草稿区里"（media/attachment-tools.ts）都用它，
// 路径比较才对得上。
import fs from "node:fs";
import path from "node:path";

/**
 * 真实路径；还不存在的按最近的已有上级目录展开，再接上后面几段。连根都取不到时为 undefined。
 * 悬空的链接（链接本身在、指向的地方没了）也是 undefined：它指向哪里说不清，不能退回成写的路径（58 号票）
 */
export function realPathOf(p: string): string | undefined {
  const rest: string[] = [];
  let current = path.resolve(p);
  for (;;) {
    try {
      const real = fs.realpathSync.native(current);
      return rest.length === 0 ? real : path.join(real, ...rest.toReversed());
    } catch {
      // 这一段本身在（lstat 取得到）却展开不了：悬空的链接
      if (existsAsEntry(current)) return undefined;
      const parent = path.dirname(current);
      if (parent === current) return undefined;
      rest.push(path.basename(current));
      current = parent;
    }
  }
}

function existsAsEntry(p: string): boolean {
  try {
    fs.lstatSync(p);
    return true;
  } catch {
    return false;
  }
}
