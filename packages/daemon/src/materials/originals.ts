// 原文副本（规格第 15 节、ADR-0006）：本人素材的真相。
// - 本人素材（来源本人，或者里面有本人的话）连同信封（素材 id、类型、说或做、时间、来源会话、任务或项目、来源等级、
//   指向原始记录的引用、情境标签、切段——本人切段里就是原文）存成素材区的一个文件：originals/<年-月>/<素材 id>.json；
// - 不可修改、只追加：只用"不存在才创建"的方式写，写完设为只读；不提供改写的接口。
//   删除只由用户发起（21 号票的忘掉、彻底删除：素材模块处理记忆命令时调 deleteOriginal，先去掉只读属性）；
// - 同一条素材重复处理（重启、从事件日志重建 materials.db）落到同一个文件，已经在就不动它；
// - materials.db 重建时，事件日志里已经没有原始事件的本人素材（删项目时删掉了维护者会话）从这里补回来。
// agent 的产出、附件和外部内容不另存，素材里只有引用加内容哈希。
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { CapturedMaterial, Material, OriginalCopy } from "./types.ts";

const ORIGINALS_DIR = "originals";
const RECORD_FORMAT = 1;
const RECORD_FILE = /^(mat-[0-9a-f]+)\.json$/;

/** 原文副本文件的内容 */
export interface OriginalRecord {
  format: typeof RECORD_FORMAT;
  /** 同一条事件里的第几条素材（重建后排序用） */
  position: number;
  material: CapturedMaterial;
}

/** 这条素材要不要原文副本：本人做的、本人说的，或者里面有本人的话 */
export function needsOriginal(material: Pick<Material, "source" | "segments">): boolean {
  return material.source === "self" || material.segments.some((s) => s.source === "self");
}

const sha256 = (content: string) => createHash("sha256").update(content, "utf8").digest("hex");

/** 写一份原文副本（已经在就不动它），返回它的引用 */
export function writeOriginal(materialsDir: string, material: CapturedMaterial, position: number): OriginalCopy {
  // 按素材的时间（原始记录的本地时间）分月存放
  const relative = [ORIGINALS_DIR, material.time.slice(0, 7), `${material.id}.json`];
  const file = path.join(materialsDir, ...relative);
  const record: OriginalRecord = { format: RECORD_FORMAT, position, material };
  let content = `${JSON.stringify(record)}\n`;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  try {
    fs.writeFileSync(file, content, { encoding: "utf8", flag: "wx" });
    fs.chmodSync(file, 0o444);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
    // 已经在：那是第一次采到时存下的，原样留着
    content = fs.readFileSync(file, "utf8");
  }
  return { path: relative.join("/"), sha256: sha256(content) };
}

/** 素材区里全部原文副本：素材 id 和路径（只看文件名，不读内容） */
export function listOriginals(materialsDir: string): Array<{ id: string; path: string }> {
  const root = path.join(materialsDir, ORIGINALS_DIR);
  if (!fs.existsSync(root)) return [];
  const found: Array<{ id: string; path: string }> = [];
  for (const month of fs.readdirSync(root, { withFileTypes: true })) {
    if (!month.isDirectory()) continue;
    for (const name of fs.readdirSync(path.join(root, month.name))) {
      const match = RECORD_FILE.exec(name);
      if (match) found.push({ id: match[1]!, path: [ORIGINALS_DIR, month.name, name].join("/") });
    }
  }
  return found;
}

/** 读一份原文副本 */
export function readOriginal(materialsDir: string, relative: string): { record: OriginalRecord; copy: OriginalCopy } {
  const parts = relative.split("/");
  if (parts[0] !== ORIGINALS_DIR || parts.some((p) => p === ".." || p === "")) throw new Error(`不是原文副本的路径：${relative}`); // @i18n-ignore log：编程错误
  const content = fs.readFileSync(path.join(materialsDir, ...parts), "utf8");
  const record = JSON.parse(content) as OriginalRecord;
  if (record.format !== RECORD_FORMAT) throw new Error(`原文副本 ${relative} 的格式 ${String(record.format)} 不认识`); // @i18n-ignore log：编程错误
  return { record, copy: { path: relative, sha256: sha256(content) } };
}

/** 删掉一份原文副本（用户忘掉、彻底删除了这条素材）：先去掉只读属性再删；已经不在就算了 */
export function deleteOriginal(materialsDir: string, relative: string): void {
  const parts = relative.split("/");
  if (parts[0] !== ORIGINALS_DIR || parts.some((p) => p === ".." || p === "")) throw new Error(`不是原文副本的路径：${relative}`); // @i18n-ignore log：编程错误
  const file = path.join(materialsDir, ...parts);
  try {
    fs.chmodSync(file, 0o644);
    fs.rmSync(file);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
}
