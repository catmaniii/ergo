// 取元素内容时放进草稿区的那一份放在哪、叫什么；记下来的文件忘掉、彻底删除时，这一份也按这里的写法找到删掉（memory/after-purge.ts）。
import fs from "node:fs";
import path from "node:path";
import { sanitizeName } from "../media/media-store.ts";

/** 放进草稿区的子文件夹 */
export const ELEMENT_SCRATCH_FOLDER = "element-files";

const prefixOf = (mediaId: string) => `${mediaId.slice(0, 8)}-`;

/** 放进草稿区时的文件名：媒体编号的开头加原来的名字 */
export const elementScratchName = (mediaId: string, name: string): string => `${prefixOf(mediaId)}${sanitizeName(name)}`;

/** 删掉这份媒体放在草稿区里的那一份；没放过就算了 */
export function removeElementScratch(scratchDir: string, mediaId: string): void {
  const dir = path.join(scratchDir, ELEMENT_SCRATCH_FOLDER);
  if (!fs.existsSync(dir)) return;
  for (const name of fs.readdirSync(dir)) {
    if (name.startsWith(prefixOf(mediaId))) fs.rmSync(path.join(dir, name), { force: true });
  }
}
