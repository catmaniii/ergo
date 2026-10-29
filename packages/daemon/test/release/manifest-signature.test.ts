// 组件清单的签名（318 号票接 323 留的接口）：发布包里清单旁边有 manifest.json.minisig（发版时用发布钥匙签），守护进程按程序里的发布公钥验；
// 验不过、换了钥匙、没有公钥都不用这份清单；没有签名文件（开发时）不验、照"没签名"用。
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { loadManifest, MANIFEST_URL, shippedManifestVerifier } from "../../src/components/manifest.ts";
import { sign } from "../../src/release/minisign.ts";
import { releaseKey } from "../helpers/fake-release.ts";

const dirs: string[] = [];
function tmp(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ergo-manifest-sig-"));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

/** 把随程序的清单复制一份到临时目录（签了的话旁边放签名） */
function copyManifest(secret?: ReturnType<typeof releaseKey>["secret"]): URL {
  const dir = tmp();
  const file = path.join(dir, "manifest.json");
  const bytes = fs.readFileSync(MANIFEST_URL);
  fs.writeFileSync(file, bytes);
  if (secret) fs.writeFileSync(`${file}.minisig`, sign(bytes, secret, { fileName: "manifest.json", trustedComment: "ergo test components manifest" }));
  return pathToFileURL(file);
}

describe("组件清单的签名", () => {
  it("没有签名文件（开发时）：不验，照“没签名”用", () => {
    const url = copyManifest();
    expect(shippedManifestVerifier({ ERGO_RELEASE_PUBKEY: releaseKey().publicLine }, url)).toBeUndefined();
    expect(loadManifest({ url }).signed).toBe(false);
  });

  it("签名对：用，记成验过签名", () => {
    const key = releaseKey();
    const url = copyManifest(key.secret);
    const verify = shippedManifestVerifier({ ERGO_RELEASE_PUBKEY: key.publicLine }, url);
    expect(verify).toBeDefined();
    const loaded = loadManifest({ url, verify: verify! });
    expect(loaded.signed).toBe(true);
    expect(loaded.manifest.components.length).toBeGreaterThan(0);
  });

  it("清单被改过、别的钥匙签的、程序里没有公钥：都不用", () => {
    const key = releaseKey();
    const url = copyManifest(key.secret);
    expect(() => loadManifest({ url, verify: shippedManifestVerifier({ ERGO_RELEASE_PUBKEY: releaseKey().publicLine }, url)! })).toThrow(/签名验不过/);
    expect(() => loadManifest({ url, verify: shippedManifestVerifier({ ERGO_RELEASE_PUBKEY: "" }, url)! })).toThrow(/签名验不过/);
    const file = new URL(url);
    fs.writeFileSync(file, fs.readFileSync(file, "utf8").replace('"release"', ' "release"'));
    expect(() => loadManifest({ url, verify: shippedManifestVerifier({ ERGO_RELEASE_PUBKEY: key.publicLine }, url)! })).toThrow(/签名验不过/);
  });
});
