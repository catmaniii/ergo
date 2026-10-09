// 配置区里的小 JSON 文件（工作日历的个人设置、个人助理的名字）：先写临时文件再改名，文件不会只写了一半。
import fs from "node:fs";
import path from "node:path";

export function writeJsonAtomic(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`);
  fs.renameSync(tmp, file);
}
