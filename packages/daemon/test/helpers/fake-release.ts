// 假的发布（318 号票）：一个小的发布包（zip 里有 ergo.json 和几个文件，像真的版本目录那样摆）、校验值清单、签名、latest.json，
// 放进本机的假下载服务（fake-downloads.ts）。测试里的 ergo update、安装脚本都对着它，不连外网、不下真的发布包。
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { formatSums, type ReleaseIndex } from "../../src/release/fetch.ts";
import { formatPublicKey, generateKeyPair, type MinisignSecretKey, sign } from "../../src/release/minisign.ts";
import { ZipWriter } from "../../src/release/zip.ts";
import { sha256 } from "./fake-downloads.ts";

export interface FakeReleaseFiles {
  index: ReleaseIndex;
  /** 文件名 → 内容 */
  files: Map<string, Buffer>;
}

/** 发布包里的东西（版本目录的样子）：ergo.json、ergo.cmd、app\packages\daemon\src\cli\main.js、node\node.exe（假的）、额外的 */
export function fakeVersionZip(version: string, extra: Record<string, string | Buffer> = {}): Buffer {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ergo-fake-zip-"));
  try {
    const file = path.join(dir, "r.zip");
    const w = new ZipWriter(file);
    w.add("ergo.json", Buffer.from(JSON.stringify({ format: 1, version, kind: "release", node: "22.23.4" })));
    w.add("ergo.cmd", Buffer.from("@echo off\r\nrem fake\r\n"));
    w.add("node/node.exe", Buffer.from("not really node"));
    w.add("app/packages/daemon/src/cli/main.js", Buffer.from(`console.log("ergo ${version}");\n`));
    for (const [name, body] of Object.entries(extra)) w.add(name, Buffer.isBuffer(body) ? body : Buffer.from(body));
    w.close();
    return fs.readFileSync(file);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/** 一版发布的几个文件（key 不给就不签） */
export function fakeRelease(version: string, key: MinisignSecretKey | undefined, zip: Buffer = fakeVersionZip(version)): FakeReleaseFiles {
  const zipName = `ergo-${version}-win-x64.zip`;
  const sums = Buffer.from(formatSums([[zipName, sha256(zip)]]));
  const index: ReleaseIndex = { format: 1, version, node: "22.23.4", nodeTested: ["22.23.4"], files: { zip: zipName, sums: "SHA256SUMS", signature: "SHA256SUMS.minisig" }, zipSize: zip.length };
  const files = new Map<string, Buffer>([
    ["latest.json", Buffer.from(JSON.stringify(index))],
    [zipName, zip],
    ["SHA256SUMS", sums],
  ]);
  if (key) files.set("SHA256SUMS.minisig", Buffer.from(sign(sums, key, { trustedComment: `ergo ${version} SHA256SUMS` })));
  return { index, files };
}

export interface ReleaseKey {
  secret: MinisignSecretKey;
  /** 公钥文件的内容 */
  publicText: string;
  /** 公钥 base64 那一行（安装脚本的 -PublicKey、ERGO_RELEASE_PUBKEY 都认） */
  publicLine: string;
}

export function releaseKey(): ReleaseKey {
  const secret = generateKeyPair();
  const publicText = formatPublicKey(secret);
  return { secret, publicText, publicLine: publicText.trim().split("\n")[1]! };
}
