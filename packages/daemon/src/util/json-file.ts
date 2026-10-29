// 配置区里的小 JSON 文件（工作日历的个人设置、个人助理的名字）：先写临时文件再改名，文件不会只写了一半；
// 改名碰上文件正被占着时等一会儿重试（265 号票，见 atomic-file.ts）。
import { writeFileAtomic } from "./atomic-file.ts";

export function writeJsonAtomic(file: string, value: unknown): void {
  writeFileAtomic(file, `${JSON.stringify(value, null, 2)}\n`);
}
