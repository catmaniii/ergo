// 取发布包（318 号票）：索引、校验值清单的格式；从自己给的地址 / npmmirror 下；验签名和 sha256——改过的清单、别的钥匙、没签名都不认。
// 全对着本机的假下载服务，不连外网。
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createHttpTransport } from "../../src/components/transport.ts";
import { npmmirrorSource, orderSources, parseIndex, parseSums, type ReleaseSource, urlSource, verifyRelease } from "../../src/release/fetch.ts";
import { parsePublicKey } from "../../src/release/minisign.ts";
import { makeTar, startFakeDownloads } from "../helpers/fake-downloads.ts";
import { fakeRelease, releaseKey } from "../helpers/fake-release.ts";

const dirs: string[] = [];
function tmp(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ergo-fetch-"));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

const transport = createHttpTransport();
const ctx = (log: string[] = []) => ({ signal: AbortSignal.timeout(20_000), log: (l: string) => log.push(l) });

describe("发布的索引和校验值清单", () => {
  it("latest.json 的格式要对：版本号、文件名只能是安全的字", () => {
    const ok = { format: 1, version: "0.3.0", node: "22.23.4", nodeTested: ["22.23.4"], files: { zip: "ergo-0.3.0-win-x64.zip", sums: "SHA256SUMS", signature: "SHA256SUMS.minisig" }, zipSize: 10 };
    expect(parseIndex(ok)).toEqual(ok);
    expect(() => parseIndex({ ...ok, version: "latest" })).toThrow(/格式不对/);
    expect(() => parseIndex({ ...ok, files: { ...ok.files, zip: "../evil.zip" } })).toThrow(/格式不对/);
    expect(() => parseIndex(null)).toThrow(/格式不对/);
  });

  it("SHA256SUMS 认 sha256sum 的两种写法", () => {
    const a = "a".repeat(64);
    const b = "B".repeat(64);
    expect(parseSums(`${a}  ergo.zip\r\n${b} *other.zip\nnot a line\n`)).toEqual(
      new Map([
        ["ergo.zip", a],
        ["other.zip", "b".repeat(64)],
      ]),
    );
  });
});

describe("下发布包、验", () => {
  it("自己给的地址：下最新的、指定的版本，验签名和 sha256", async () => {
    const fake = await startFakeDownloads();
    const key = releaseKey();
    const r = fakeRelease("0.3.0", key.secret);
    for (const [name, body] of r.files) fake.put(name, body);
    const old = fakeRelease("0.2.9", key.secret);
    for (const [name, body] of old.files) fake.put(`0.2.9/${name}`, body);
    const source = urlSource(`${fake.url}/m1`);
    const index = await source.index(transport, AbortSignal.timeout(10_000));
    expect(index.version).toBe("0.3.0");
    const dir = tmp();
    await source.download(index, transport, dir, ctx());
    const ok = await verifyRelease(dir, index, key.secret);
    expect(ok).toEqual({ ok: true, zip: path.join(dir, "ergo-0.3.0-win-x64.zip"), trustedComment: "ergo 0.3.0 SHA256SUMS" });

    const pinned = await source.index(transport, AbortSignal.timeout(10_000), "0.2.9");
    expect(pinned.version).toBe("0.2.9");
    const dir2 = tmp();
    await source.download(pinned, transport, dir2, ctx());
    expect((await verifyRelease(dir2, pinned, key.secret)).ok).toBe(true);
    expect(fake.requests.some((q) => q.path === "0.2.9/ergo-0.2.9-win-x64.zip")).toBe(true);
  });

  it("清单被改过、换了钥匙、没有公钥、包被换了：都不认", async () => {
    const fake = await startFakeDownloads();
    const key = releaseKey();
    const r = fakeRelease("0.3.0", key.secret);
    for (const [name, body] of r.files) fake.put(name, body);
    const source = urlSource(`${fake.url}/m1`);
    const index = await source.index(transport, AbortSignal.timeout(10_000));
    const dir = tmp();
    await source.download(index, transport, dir, ctx());

    expect(await verifyRelease(dir, index, releaseKey().secret)).toMatchObject({ ok: false, reason: expect.stringContaining("别的钥匙") });
    expect(await verifyRelease(dir, index, undefined)).toEqual({ ok: false, reason: "没有发布公钥，验不了签名" });
    expect((await verifyRelease(dir, index, undefined, { allowUnsigned: true })).ok).toBe(true);

    // 清单里的 sha256 改了（签名就对不上了）
    const sums = path.join(dir, "SHA256SUMS");
    const original = fs.readFileSync(sums, "utf8");
    fs.writeFileSync(sums, original.replace(/^./, (c) => (c === "0" ? "1" : "0")));
    expect(await verifyRelease(dir, index, parsePublicKey(key.publicText))).toMatchObject({ ok: false, reason: expect.stringContaining("签名验不过") });
    fs.writeFileSync(sums, original);
    // 包被换了（清单、签名都对，sha256 对不上）
    fs.appendFileSync(path.join(dir, "ergo-0.3.0-win-x64.zip"), "x");
    expect(await verifyRelease(dir, index, key.secret)).toMatchObject({ ok: false, reason: expect.stringContaining("sha256 对不上") });
  });

  it("下载断了接着下（发布包按清单里的 sha256 下）", async () => {
    const fake = await startFakeDownloads();
    const key = releaseKey();
    const r = fakeRelease("0.3.0", key.secret, crypto.randomBytes(300_000));
    for (const [name, body] of r.files) fake.put(name, body);
    const source = urlSource(`${fake.url}/m1`);
    const index = await source.index(transport, AbortSignal.timeout(10_000));
    // 之后的三个请求（清单、签名、发布包）都只给 10 万字节就断：小的两个本来就给全了，发布包下到一半断了
    fake.behave("m1", { kind: "cut", bytes: 100_000, times: 3 });
    const dir = tmp();
    await source.download(index, transport, dir, ctx());
    expect((await verifyRelease(dir, index, key.secret)).ok).toBe(true);
    expect(fake.requests.filter((q) => q.path === "ergo-0.3.0-win-x64.zip" && q.range?.startsWith("bytes=100000-")).length).toBe(1);
  });

  it("npmmirror：平台包的 package.json 里带着索引，tgz 里放着发布的几个文件；integrity 对不上不用", async () => {
    const fake = await startFakeDownloads();
    const key = releaseKey();
    const r = fakeRelease("0.3.0", key.secret);
    const tgz = makeTar(
      [...r.files].map(([name, body]) => ({ path: `package/${name}`, body })),
      true,
    );
    const integrity = `sha512-${crypto.createHash("sha512").update(tgz).digest("base64")}`;
    fake.put("ergo-ai-win32-x64/-/ergo-ai-win32-x64-0.3.0.tgz", tgz);
    const doc = (i: string) => JSON.stringify({ name: "ergo-ai-win32-x64", version: "0.3.0", dist: { tarball: `${fake.url}/reg/ergo-ai-win32-x64/-/ergo-ai-win32-x64-0.3.0.tgz`, integrity: i }, ergo: r.index });
    fake.put("ergo-ai-win32-x64/latest", doc(integrity));
    const source = npmmirrorSource(`${fake.url}/reg`);
    const index = await source.index(transport, AbortSignal.timeout(10_000));
    expect(index).toEqual(r.index);
    const dir = tmp();
    await source.download(index, transport, dir, ctx());
    expect((await verifyRelease(dir, index, key.secret)).ok).toBe(true);

    fake.put("ergo-ai-win32-x64/latest", doc(`sha512-${Buffer.alloc(64).toString("base64")}`));
    const source2 = npmmirrorSource(`${fake.url}/reg`);
    const index2 = await source2.index(transport, AbortSignal.timeout(10_000));
    await expect(source2.download(index2, transport, tmp(), ctx())).rejects.toThrow(/integrity/);
  });

  it("挑地址：给了自己的地址只用它；cn 先 npmmirror；都没给按谁先回", async () => {
    const fast: ReleaseSource = { id: "npmmirror", title: "fast", index: async () => fakeRelease("1.0.0", undefined).index, download: async () => {} };
    const slow: ReleaseSource = {
      id: "github",
      title: "slow",
      index: () => new Promise((resolve) => setTimeout(() => resolve(fakeRelease("1.0.0", undefined).index), 300)),
      download: async () => {},
    };
    const broken: ReleaseSource = { id: "github", title: "broken", index: () => Promise.reject(new Error("down")), download: async () => {} };
    const signal = AbortSignal.timeout(10_000);
    expect((await orderSources({ url: "http://127.0.0.1:1/x", transport, signal })).map((s) => s.id)).toEqual(["url"]);
    expect((await orderSources({ mirror: "cn", transport, signal, sources: [slow, fast] })).map((s) => s.title)).toEqual(["fast", "slow"]);
    expect((await orderSources({ mirror: "github", transport, signal, sources: [slow, fast] })).map((s) => s.title)).toEqual(["slow", "fast"]);
    expect((await orderSources({ transport, signal, sources: [slow, fast] })).map((s) => s.title)).toEqual(["fast", "slow"]);
    expect((await orderSources({ transport, signal, sources: [broken, fast] })).map((s) => s.title)).toEqual(["fast", "broken"]);
  });
});
