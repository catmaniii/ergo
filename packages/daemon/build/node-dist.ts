// 发布包里带的 Node（318 号票，ADR-0031：大版本跟着 pi 走，版本是构建参数）：
//   --node <目录>   已经有的官方 Node（目录里有 node.exe、LICENSE；比如解开的 node-v22.23.4-win-x64 目录）
//   --node <zip>    官方的 node-v<版本>-win-x64.zip
//   不给            从 nodejs.org（--node-dist 换地址，比如 npmmirror 的镜像）下官方 zip，按同一处的 SHASUMS256.txt 核对 sha256
// 只放行测过的版本（TESTED_NODE_VERSIONS）；要换版本先测、再改这里。
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { componentTransport } from "../src/components/index.ts";
import { downloadFile, sha256File } from "../src/components/downloader.ts";
import { getBytes, parseSums } from "../src/release/fetch.ts";
import { extractZip } from "../src/release/zip.ts";

/** 默认带的 Node（pi 的那条线的最新补丁） */
export const DEFAULT_NODE_VERSION = "22.23.4";
/** 测过、放行的 Node 版本（写进 latest.json 的 nodeTested，安装脚本的 -NodeVersion 只认这些） */
export const TESTED_NODE_VERSIONS: readonly string[] = ["22.23.4"];
export const NODE_DIST = "https://nodejs.org/dist";

export interface NodeBinary {
  exe: string;
  version: string;
  /** LICENSE 所在的目录 */
  licenseDir: string;
}

/** 跑一下 node.exe 问版本 */
export function nodeVersionOf(exe: string): string {
  return execFileSync(exe, ["--version"], { encoding: "utf8", windowsHide: true }).trim().replace(/^v/, "");
}

/** 按 --node 给的（目录或 zip）或者下载，拿到要带的 node.exe；scratch 是放临时文件的目录 */
export async function obtainNode(options: { from?: string; version?: string; dist?: string; scratch: string; log?: (line: string) => void }): Promise<NodeBinary> {
  const log = options.log ?? (() => {});
  const wanted = options.version ?? DEFAULT_NODE_VERSION;
  if (!TESTED_NODE_VERSIONS.includes(wanted)) throw new Error(`Node ${wanted} 没测过（放行的：${TESTED_NODE_VERSIONS.join("、")}）`);
  let dir: string;
  if (options.from && fs.statSync(options.from).isDirectory()) {
    dir = options.from;
  } else {
    let zip = options.from;
    if (!zip) {
      const base = `${(options.dist ?? NODE_DIST).replace(/\/+$/, "")}/v${wanted}`;
      const name = `node-v${wanted}-win-x64.zip`;
      const transport = componentTransport(process.env, "ergo-build");
      const signal = AbortSignal.timeout(30 * 60_000);
      const sums = parseSums((await getBytes(transport, `${base}/SHASUMS256.txt`, signal)).toString("utf8"));
      const sha = sums.get(name);
      if (!sha) throw new Error(`${base}/SHASUMS256.txt 里没有 ${name}`);
      zip = path.join(options.scratch, name);
      fs.mkdirSync(options.scratch, { recursive: true });
      log(`下载 ${base}/${name}`);
      const head = await transport(`${base}/${name}`, { signal, rangeStart: 0, rangeEnd: 0 });
      head.destroy();
      const size = Number(/\/(\d+)$/.exec(String(head.headers["content-range"] ?? ""))?.[1] ?? head.headers["content-length"] ?? 0);
      await downloadFile({ name, urls: [{ sourceId: "node", title: base, url: `${base}/${name}` }], size, sha256: sha, part: `${zip}.part`, dest: zip }, { transport, signal, stallMs: 60_000, log, onBytes: () => {} });
      if ((await sha256File(zip)) !== sha) throw new Error(`${name} 的 sha256 对不上 SHASUMS256.txt`);
    }
    const out = path.join(options.scratch, `node-${wanted}`);
    fs.rmSync(out, { recursive: true, force: true });
    await extractZip(zip, out);
    const inner = fs.readdirSync(out).map((n) => path.join(out, n)).find((p) => fs.existsSync(path.join(p, "node.exe")));
    dir = inner ?? out;
  }
  const exe = path.join(dir, "node.exe");
  if (!fs.existsSync(exe)) throw new Error(`${dir} 里没有 node.exe`);
  const version = nodeVersionOf(exe);
  if (version !== wanted) throw new Error(`${exe} 是 Node ${version}，要的是 ${wanted}`);
  return { exe, version, licenseDir: dir };
}

/** 构建用的临时目录 */
export function buildScratch(name: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `ergo-${name}-`));
}
