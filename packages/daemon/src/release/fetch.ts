// 取发布包（318 号票，ergo update 用；安装脚本 install.ps1 里有同样的一份 PowerShell 写的）：
//   1. 发布的索引 latest.json：{ version, node, nodeTested, files: { zip, sums, signature } }；
//   2. 校验值清单 SHA256SUMS（sha256sum 的格式）和它的签名 SHA256SUMS.minisig（发布钥匙签的）；
//   3. 发布包 ergo-<版本>-win-x64.zip（按清单里的 sha256 下，断了接着下）。
// 从哪儿下（挑快的，一个不行换另一个）：
//   - GitHub Releases：<仓库>/releases/latest/download/latest.json，文件在 <仓库>/releases/download/v<版本>/；
//   - npmmirror（国内快）：平台包 ergo-ai-win32-x64 的 tgz 里放着同样这几个文件（npm 官方发了以后 npmmirror 自己同步）；
//   - 自己给的地址（--from、ERGO_RELEASE_URL，测试和自己搭发布地址的人用）：<地址>/latest.json，文件在同一个目录；指定版本时 <地址>/<版本>/latest.json。
// 下好以后先验签名（verifyRelease），对了才解开。
// @i18n-ignore-file log：出错原因给开发者看（命令行另有给人看的一句）
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { DownloadError, downloadFile, sha256File } from "../components/downloader.ts";
import { extractTar } from "../components/tar.ts";
import type { Transport } from "../components/transport.ts";
import { type MinisignPublicKey, verify } from "./minisign.ts";

/** 公开仓库（317 号票定名；改名时改这里，安装脚本里也有一份） */
export const GITHUB_REPO_URL = "https://github.com/catmaniii/ergo";
/** npm 上放发布包的平台包 */
export const NPM_PLATFORM_PACKAGE = "ergo-ai-win32-x64";
export const NPMMIRROR_REGISTRY = "https://registry.npmmirror.com";

/** 发布的索引（latest.json） */
export interface ReleaseIndex {
  format: 1;
  version: string;
  /** 包里自带的 Node 版本 */
  node: string;
  /** 测过、放行的 Node 版本（安装脚本的 -NodeVersion 只认这些） */
  nodeTested: string[];
  files: { zip: string; sums: string; signature: string };
  /** 发布包多大（字节） */
  zipSize?: number;
  publishedAt?: string;
}

export type ReleaseSourceId = "github" | "npmmirror" | "url";

export interface ReleaseSource {
  id: ReleaseSourceId;
  title: string;
  /** 取索引；version 不给是最新的 */
  index(transport: Transport, signal: AbortSignal, version?: string): Promise<ReleaseIndex>;
  /** 把这一版的几个文件下到 dir（latest.json、校验值清单、签名、发布包） */
  download(index: ReleaseIndex, transport: Transport, dir: string, ctx: FetchContext): Promise<void>;
}

export interface FetchContext {
  signal: AbortSignal;
  log(line: string): void;
  onBytes?(done: number, total: number): void;
}

/** GET 一个小文件（索引、清单），整个读进来 */
export async function getBytes(transport: Transport, url: string, signal: AbortSignal, limit = 4 * 1024 * 1024): Promise<Buffer> {
  const res = await transport(url, { signal });
  if (res.status !== 200) {
    res.destroy();
    throw new Error(`${url}：HTTP ${res.status}`);
  }
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of res.body) {
    size += chunk.length;
    if (size > limit) {
      res.destroy();
      throw new Error(`${url}：太大了（超过 ${limit} 字节）`);
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

/** 读、查一份索引 */
export function parseIndex(raw: unknown): ReleaseIndex {
  const r = raw as Partial<ReleaseIndex> | null;
  const files = r?.files;
  const ok =
    r !== null &&
    typeof r === "object" &&
    typeof r.version === "string" &&
    /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(r.version) &&
    typeof r.node === "string" &&
    Array.isArray(r.nodeTested) &&
    typeof files?.zip === "string" &&
    typeof files.sums === "string" &&
    typeof files.signature === "string" &&
    [files.zip, files.sums, files.signature].every((f) => /^[A-Za-z0-9._-]+$/.test(f));
  if (!ok) throw new Error("发布的索引（latest.json）格式不对");
  return {
    format: 1,
    version: r.version!,
    node: r.node!,
    nodeTested: r.nodeTested!.map(String),
    files: { zip: files!.zip, sums: files!.sums, signature: files!.signature },
    ...(typeof r.zipSize === "number" && r.zipSize > 0 ? { zipSize: r.zipSize } : {}),
    ...(typeof r.publishedAt === "string" ? { publishedAt: r.publishedAt } : {}),
  };
}

/** 校验值清单：sha256sum 的格式（<64 位十六进制>  <文件名>，文件名前可以有 *） */
export function parseSums(text: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const line of text.split(/\r?\n/)) {
    const m = /^([0-9a-fA-F]{64})\s+\*?(.+?)\s*$/.exec(line);
    if (m) out.set(m[2]!, m[1]!.toLowerCase());
  }
  return out;
}

/** 写校验值清单 */
export function formatSums(entries: Iterable<[name: string, sha256: string]>): string {
  return [...entries].map(([name, sha]) => `${sha}  ${name}\n`).join("");
}

/** 远处的文件多大：要第 0 个字节，看 Content-Range（不认 Range 的看 Content-Length） */
async function remoteSize(transport: Transport, url: string, signal: AbortSignal): Promise<number> {
  const res = await transport(url, { signal, rangeStart: 0, rangeEnd: 0 });
  res.destroy();
  if (res.status !== 200 && res.status !== 206) throw new Error(`${url}：HTTP ${res.status}`);
  const total = Number(/\/(\d+)$/.exec(String(res.headers["content-range"] ?? ""))?.[1] ?? res.headers["content-length"] ?? 0);
  if (!(total > 0)) throw new Error(`${url}：不知道多大`);
  return total;
}

/** 下一个小文件存到 dir 里 */
async function saveSmall(transport: Transport, url: string, file: string, signal: AbortSignal): Promise<Buffer> {
  const data = await getBytes(transport, url, signal);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, data);
  return data;
}

/** 按"文件都在同一个目录"的地址下：先下清单、签名，再按清单里的 sha256 下发布包（断了接着下） */
async function downloadFlat(fileUrl: (name: string) => string, sourceTitle: string, index: ReleaseIndex, transport: Transport, dir: string, ctx: FetchContext): Promise<void> {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "latest.json"), `${JSON.stringify(index, null, 2)}\n`);
  const sums = parseSums((await saveSmall(transport, fileUrl(index.files.sums), path.join(dir, index.files.sums), ctx.signal)).toString("utf8"));
  await saveSmall(transport, fileUrl(index.files.signature), path.join(dir, index.files.signature), ctx.signal);
  const sha = sums.get(index.files.zip);
  if (!sha) throw new Error(`校验值清单里没有 ${index.files.zip}`);
  const total = index.zipSize ?? (await remoteSize(transport, fileUrl(index.files.zip), ctx.signal));
  const dest = path.join(dir, index.files.zip);
  await downloadFile(
    { name: index.files.zip, urls: [{ sourceId: sourceTitle, title: sourceTitle, url: fileUrl(index.files.zip) }], size: total, sha256: sha, part: `${dest}.part`, dest },
    { transport, signal: ctx.signal, stallMs: 60_000, log: ctx.log, onBytes: (done) => ctx.onBytes?.(done, total) },
  );
}

/** 自己给的地址：<base>/latest.json（或 <base>/<版本>/latest.json），文件在索引的同一个目录 */
export function urlSource(base: string): ReleaseSource {
  const root = base.replace(/\/+$/, "");
  const dirOf = (version?: string) => (version ? `${root}/${version}` : root);
  let fetchedDir = root;
  return {
    id: "url",
    title: root,
    async index(transport, signal, version) {
      fetchedDir = dirOf(version);
      return parseIndex(JSON.parse((await getBytes(transport, `${fetchedDir}/latest.json`, signal)).toString("utf8")));
    },
    download(index, transport, dir, ctx) {
      return downloadFlat((name) => `${fetchedDir}/${name}`, root, index, transport, dir, ctx);
    },
  };
}

/** GitHub Releases */
export function githubSource(repoUrl: string = GITHUB_REPO_URL): ReleaseSource {
  return {
    id: "github",
    title: "GitHub",
    async index(transport, signal, version) {
      const url = version ? `${repoUrl}/releases/download/v${version}/latest.json` : `${repoUrl}/releases/latest/download/latest.json`;
      return parseIndex(JSON.parse((await getBytes(transport, url, signal)).toString("utf8")));
    },
    download(index, transport, dir, ctx) {
      return downloadFlat((name) => `${repoUrl}/releases/download/v${index.version}/${name}`, "GitHub", index, transport, dir, ctx);
    },
  };
}

/** npmmirror：平台包的 tgz 里放着 latest.json、清单、签名、发布包 */
export function npmmirrorSource(registry: string = NPMMIRROR_REGISTRY, pkg: string = NPM_PLATFORM_PACKAGE): ReleaseSource {
  const meta = new Map<string, { tarball: string; integrity?: string }>();
  return {
    id: "npmmirror",
    title: "npmmirror",
    async index(transport, signal, version) {
      const doc = JSON.parse((await getBytes(transport, `${registry}/${pkg}/${version ?? "latest"}`, signal)).toString("utf8")) as {
        version?: string;
        dist?: { tarball?: string; integrity?: string };
        ergo?: unknown;
      };
      if (!doc.version || !doc.dist?.tarball) throw new Error(`${registry} 上没有 ${pkg}${version ? `@${version}` : ""}`);
      meta.set(doc.version, { tarball: doc.dist.tarball, ...(doc.dist.integrity ? { integrity: doc.dist.integrity } : {}) });
      // 平台包的 package.json 里带着同一份索引（"ergo" 字段）
      return parseIndex(doc.ergo);
    },
    async download(index, transport, dir, ctx) {
      const m = meta.get(index.version);
      if (!m) throw new Error(`没取过 ${pkg}@${index.version} 的索引`);
      fs.mkdirSync(dir, { recursive: true });
      const tgz = path.join(dir, `${pkg}-${index.version}.tgz`);
      const total = await remoteSize(transport, m.tarball, ctx.signal);
      await downloadFile(
        { name: path.basename(tgz), urls: [{ sourceId: "npmmirror", title: "npmmirror", url: m.tarball }], size: total, part: `${tgz}.part`, dest: tgz },
        { transport, signal: ctx.signal, stallMs: 60_000, log: ctx.log, onBytes: (done) => ctx.onBytes?.(done, total) },
      );
      if (m.integrity?.startsWith("sha512-")) {
        const got = `sha512-${crypto.createHash("sha512").update(fs.readFileSync(tgz)).digest("base64")}`;
        if (got !== m.integrity) {
          fs.rmSync(tgz, { force: true });
          throw new DownloadError("checksum", `${pkg}@${index.version} 的 tgz 和 npm 记的 integrity 对不上`);
        }
      }
      await extractTar(tgz, dir, { gzip: true, strip: 1, signal: ctx.signal });
      fs.rmSync(tgz, { force: true });
      fs.writeFileSync(path.join(dir, "latest.json"), `${JSON.stringify(index, null, 2)}\n`);
    },
  };
}

/**
 * 挑下载地址：给了自己的地址只用它；mirror 是 cn 先 npmmirror、github 先 GitHub；都没给就同时问两边的索引，先回的排前面
 */
export async function orderSources(options: { url?: string; mirror?: "cn" | "github"; transport: Transport; signal: AbortSignal; sources?: ReleaseSource[] }): Promise<ReleaseSource[]> {
  if (options.url) return [urlSource(options.url)];
  const [github, npm] = options.sources ?? [githubSource(), npmmirrorSource()];
  if (!github || !npm) throw new Error("要两个下载地址");
  if (options.mirror === "cn") return [npm, github];
  if (options.mirror === "github") return [github, npm];
  const timeout = AbortSignal.any([options.signal, AbortSignal.timeout(8_000)]);
  const timed = async (s: ReleaseSource) => {
    const start = Date.now();
    try {
      await s.index(options.transport, timeout);
      return { s, ms: Date.now() - start };
    } catch {
      return { s, ms: Number.POSITIVE_INFINITY };
    }
  };
  const results = await Promise.all([timed(github), timed(npm)]);
  return results.sort((a, b) => a.ms - b.ms).map((r) => r.s);
}

export type VerifyReleaseResult = { ok: true; zip: string; trustedComment: string } | { ok: false; reason: string };

/** 验下好的发布：签名（发布公钥验校验值清单）、发布包的 sha256 对上清单 */
export async function verifyRelease(dir: string, index: ReleaseIndex, publicKey: MinisignPublicKey | undefined, options: { allowUnsigned?: boolean } = {}): Promise<VerifyReleaseResult> {
  const sumsFile = path.join(dir, index.files.sums);
  const sigFile = path.join(dir, index.files.signature);
  const zip = path.join(dir, index.files.zip);
  let trustedComment = "";
  let sumsText: string;
  try {
    sumsText = fs.readFileSync(sumsFile, "utf8");
  } catch {
    return { ok: false, reason: `没有校验值清单 ${index.files.sums}` };
  }
  if (publicKey) {
    let sig: string;
    try {
      sig = fs.readFileSync(sigFile, "utf8");
    } catch {
      return { ok: false, reason: `没有签名 ${index.files.signature}` };
    }
    const result = verify(Buffer.from(sumsText, "utf8"), sig, publicKey);
    if (!result.ok) return { ok: false, reason: `签名验不过：${result.reason}` };
    trustedComment = result.trustedComment;
  } else if (!options.allowUnsigned) {
    return { ok: false, reason: "没有发布公钥，验不了签名" };
  }
  const expected = parseSums(sumsText).get(index.files.zip);
  if (!expected) return { ok: false, reason: `校验值清单里没有 ${index.files.zip}` };
  if (!fs.existsSync(zip)) return { ok: false, reason: `没有发布包 ${index.files.zip}` };
  const actual = await sha256File(zip);
  if (actual !== expected) return { ok: false, reason: `发布包的 sha256 对不上（${actual}，清单里是 ${expected}）` };
  return { ok: true, zip, trustedComment };
}
