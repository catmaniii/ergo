// 要交进网页上传框的文件的取件码（134 号票）：秘书在网页工具里要交哪些文件（149 号票之前是页面助手）（素材里的附件、授权的文件夹里的），守护进程给每个发一个
// 一次指令用的取件码，网页凭它下载（GET /api/page-files/<取件码>，外网端口上照样要设备凭证）、给面板画缩略图，App 把它下到自己的目录
// 再交给网页。只有选中的文件有取件码，取件码猜不出来（24 个十六进制字），过了有效期就没了；文件发出去之前再看一眼还在不在、大小变没变。
import { randomBytes } from "node:crypto";
import fs from "node:fs";

/** 取件码多久有效（毫秒）：够用户在面板上看一眼、去掉几张再交 */
export const PAGE_FILE_TOKEN_TTL_MS = 15 * 60 * 1000;

/** 一个取件码对应的文件 */
export interface PageFileEntry {
  path: string;
  name: string;
  mime: string;
  size: number;
  image: boolean;
  expiresAt: number;
}

export interface PageFileTokens {
  issue(file: Omit<PageFileEntry, "expiresAt">): string;
  /** 取件码对应的文件；没有、过期、文件不在了或大小变了是 undefined */
  get(token: string): PageFileEntry | undefined;
}

export function createPageFileTokens(options: { now?: () => number; ttlMs?: number } = {}): PageFileTokens {
  const now = options.now ?? Date.now;
  const ttl = options.ttlMs ?? PAGE_FILE_TOKEN_TTL_MS;
  const entries = new Map<string, PageFileEntry>();
  const sweep = () => {
    const t = now();
    for (const [token, entry] of entries) if (entry.expiresAt <= t) entries.delete(token);
  };
  return {
    issue(file) {
      sweep();
      const token = randomBytes(12).toString("hex");
      entries.set(token, { ...file, expiresAt: now() + ttl });
      return token;
    },
    get(token) {
      sweep();
      const entry = /^[0-9a-f]{24}$/.test(token) ? entries.get(token) : undefined;
      if (!entry) return undefined;
      try {
        const stat = fs.statSync(entry.path);
        return stat.isFile() && stat.size === entry.size ? entry : undefined;
      } catch {
        return undefined;
      }
    },
  };
}
