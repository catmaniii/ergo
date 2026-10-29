// 数据源的密钥（295 号票）：数据源插件经 ctx.secrets 存的 API Key、应用专用密码、私密地址，放在数据目录密钥区里的
// data-sources/<数据源 id>.json（{ format: 1, values: { 名字: 值 } }）。
// - 只由守护进程读写：不进仓库（数据目录在仓库外）、不进事件、不进日志（这里一个值都不打印）；agent 读不到（守卫把整个密钥区挡在外面）；
//   密钥区整个不进备份（nonBackupEntries），换机器要重新填。
// - 和模型 key 不同：模型 key 由 LSM 从密钥区注入守护进程的环境（config/secrets.ts）；这里是用户在设置 · 数据源里填的，守护进程直接写文件。
// - 写的时候先写临时文件再改名（写到一半断电不留半个文件）；POSIX 上权限 600。
// - 断开时整格删掉（clear）。同步、导入出错的原因里要是带着这一格里的值，服务记下之前换成 ***（valuesOf）。
import fs from "node:fs";
import path from "node:path";
import type { DataSourceSecrets } from "./api.ts";

export interface DataSourceSecretStore {
  /** 这个数据源那一格 */
  forSource(id: string): DataSourceSecrets;
  /** 断开：整格删掉 */
  clear(id: string): void;
  /** 这一格里有没有东西 */
  hasAny(id: string): boolean;
  /** 这一格里的全部值（把出错原因里的密钥换成 *** 用；不给别处） */
  valuesOf(id: string): string[];
}

interface SecretFile {
  format: 1;
  values: Record<string, string>;
}

export function createDataSourceSecrets(options: { dir: string; log: (line: string) => void }): DataSourceSecretStore {
  const fileOf = (id: string) => path.join(options.dir, `${id}.json`);
  const read = (id: string): Record<string, string> => {
    const file = fileOf(id);
    if (!fs.existsSync(file)) return {};
    try {
      const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as Partial<SecretFile>;
      return parsed.values && typeof parsed.values === "object" ? { ...parsed.values } : {};
    } catch (err) {
      // 不打印内容，只说哪个文件读不了
      options.log(`数据源 ${id} 的密钥文件读不了，当作空的：${err instanceof Error ? err.name : "未知错误"}`);
      return {};
    }
  };
  const write = (id: string, values: Record<string, string>) => {
    const file = fileOf(id);
    if (Object.keys(values).length === 0) {
      fs.rmSync(file, { force: true });
      return;
    }
    fs.mkdirSync(options.dir, { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ format: 1, values } satisfies SecretFile, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, file);
  };
  return {
    forSource(id) {
      return {
        get: (name) => read(id)[name],
        has: (name) => read(id)[name] !== undefined,
        set(name, value) {
          write(id, { ...read(id), [name]: value });
        },
        delete(name) {
          const values = read(id);
          delete values[name];
          write(id, values);
        },
      };
    },
    clear: (id) => fs.rmSync(fileOf(id), { force: true }),
    hasAny: (id) => Object.keys(read(id)).length > 0,
    valuesOf: (id) => Object.values(read(id)).filter((v) => v.length > 0),
  };
}

/** 一句话里出现的密钥换成 ***（长的先换，免得短的是长的一部分时只换掉一截） */
export function redactSecrets(text: string, secrets: readonly string[]): string {
  let out = text;
  for (const secret of [...secrets].filter((s) => s.length >= 4).toSorted((a, b) => b.length - a.length)) out = out.split(secret).join("***");
  return out;
}
