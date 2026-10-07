// 原文副本（规格第 15 节）：来源为"本人"的切段另存一份原文，放在数据目录的素材区 originals/<年-月>/ 下，
// 一个切段一个文件，内容就是原文（UTF-8），写完设为只读。
// - 不可修改、只追加：只用"不存在才创建"的方式写；这里不提供任何改写的接口。删除只由用户发起（21 号票）；
// - 文件名里带素材 id、切段号和内容哈希：同一条素材重复处理（重启、从事件日志重建 memory.db）落到同一个文件，已经在就不再写。
// agent 的产出、附件和外部内容不在这里，素材里只存引用加内容哈希。
import fs from "node:fs";
import path from "node:path";
import type { OriginalCopy } from "./types.ts";

const ORIGINALS_DIR = "originals";

/** 写一份原文副本（已经在就不动它），返回它的引用 */
export function writeOriginal(materialsDir: string, input: { materialId: string; time: string; segment: number; text: string; sha256: string }): OriginalCopy {
  // 按素材的时间（原始记录的本地时间）分月存放
  const month = input.time.slice(0, 7);
  const relative = [ORIGINALS_DIR, month, `${input.materialId}-s${input.segment}-${input.sha256.slice(0, 12)}.txt`];
  const file = path.join(materialsDir, ...relative);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  try {
    fs.writeFileSync(file, input.text, { encoding: "utf8", flag: "wx" });
    fs.chmodSync(file, 0o444);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
  }
  return { segment: input.segment, path: relative.join("/"), sha256: input.sha256 };
}

/** 读一份原文副本 */
export function readOriginal(materialsDir: string, copy: OriginalCopy): string {
  const parts = copy.path.split("/");
  if (parts[0] !== ORIGINALS_DIR || parts.some((p) => p === ".." || p === "")) throw new Error(`不是原文副本的路径：${copy.path}`);
  return fs.readFileSync(path.join(materialsDir, ...parts), "utf8");
}
