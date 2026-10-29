// 组件的下载器（323 号票）：断点续传、一个镜像慢 / 坏 / 卡住 / 给错内容、校验对不上、中止后接着下、探速、走代理。
// 全部对本机起的假下载服务，不连外网。
import fs from "node:fs";
import path from "node:path";
import { describe, expect, test } from "vitest";
import { DownloadError, type DownloadFile, type DownloadUrl, downloadFile, probeSources } from "../../src/components/downloader.ts";
import { parseRegQuery, proxyResolver } from "../../src/components/proxy.ts";
import { createHttpTransport } from "../../src/components/transport.ts";
import { blob, type FakeDownloads, sha256, startFakeDownloads, startFakeProxy } from "../helpers/fake-downloads.ts";
import { makeTempDir } from "../helpers/temp-dir.ts";

const transport = createHttpTransport({ headersTimeoutMs: 5000 });

function urlsOf(fake: FakeDownloads, file: string, ...mirrors: string[]): DownloadUrl[] {
  return mirrors.map((m) => ({ sourceId: m, title: m, url: fake.source(m).replace("{path}", file) }));
}

function target(dir: string, name: string, body: Buffer, urls: DownloadUrl[], withHash = true): DownloadFile {
  return { name, urls, size: body.length, ...(withHash ? { sha256: sha256(body) } : {}), part: path.join(dir, `${name}.part`), dest: path.join(dir, name) };
}

function context(over: Partial<Parameters<typeof downloadFile>[1]> = {}) {
  const logs: string[] = [];
  const bytes: number[] = [];
  return {
    logs,
    bytes,
    ctx: { transport, signal: new AbortController().signal, stallMs: 2000, log: (l: string) => logs.push(l), onBytes: (done: number) => bytes.push(done), ...over },
  };
}

describe("下载一个文件", () => {
  test("下全、核对 sha256 对了才改成正式的名字；已经有了的不再下", async () => {
    const fake = await startFakeDownloads();
    const body = blob(300_000);
    fake.put("m.bin", body);
    const dir = makeTempDir();
    const file = target(dir, "m.bin", body, urlsOf(fake, "m.bin", "a"));
    const { ctx, bytes } = context();
    await downloadFile(file, ctx);
    expect(fs.readFileSync(file.dest).equals(body)).toBe(true);
    expect(fs.existsSync(file.part)).toBe(false);
    expect(bytes.at(-1)).toBe(body.length);
    await downloadFile(file, ctx);
    expect(fake.requests).toHaveLength(1);
  });

  test("断点续传：连接断了，从已经下到的地方接着下（Range），不重下前面的", async () => {
    const fake = await startFakeDownloads();
    const body = blob(200_000, 2);
    fake.put("m.bin", body);
    fake.behave("a", { kind: "cut", bytes: 70_000, times: 1 });
    const dir = makeTempDir();
    const file = target(dir, "m.bin", body, urlsOf(fake, "m.bin", "a"));
    await downloadFile(file, context().ctx);
    expect(fs.readFileSync(file.dest).equals(body)).toBe(true);
    expect(fake.requests.map((r) => r.range)).toEqual([undefined, "bytes=70000-"]);
  });

  test("中止（暂停）后下了一半的 .part 留着，再下时接着下", async () => {
    const fake = await startFakeDownloads();
    const body = blob(400_000, 3);
    fake.put("m.bin", body);
    fake.behave("a", { kind: "slow", bytesPerTick: 50_000, tickMs: 30 });
    const dir = makeTempDir();
    const file = target(dir, "m.bin", body, urlsOf(fake, "m.bin", "a"));
    const controller = new AbortController();
    const { ctx } = context({ signal: controller.signal, onBytes: (done) => done >= 100_000 && controller.abort() });
    const error = await downloadFile(file, ctx).catch((err: unknown) => err);
    expect(error).toBeInstanceOf(DownloadError);
    expect((error as DownloadError).kind).toBe("stopped");
    const kept = fs.statSync(file.part).size;
    expect(kept).toBeGreaterThanOrEqual(100_000);
    expect(kept).toBeLessThan(body.length);
    fake.behave("a", { kind: "ok" });
    await downloadFile(file, context().ctx);
    expect(fs.readFileSync(file.dest).equals(body)).toBe(true);
    expect(fake.requests.at(-1)?.range).toBe(`bytes=${kept}-`);
  });

  test("一个镜像坏了（500）：换下一个", async () => {
    const fake = await startFakeDownloads();
    const body = blob(50_000, 4);
    fake.put("m.bin", body);
    fake.behave("bad", { kind: "broken" });
    const dir = makeTempDir();
    const file = target(dir, "m.bin", body, urlsOf(fake, "m.bin", "bad", "good"));
    const { ctx, logs } = context();
    await downloadFile(file, ctx);
    expect(fs.readFileSync(file.dest).equals(body)).toBe(true);
    expect(logs.join("\n")).toContain("HTTP 500");
  });

  test("一个镜像下到一半卡住：多久没收到字节就换下一个，接着下（不从头）", async () => {
    const fake = await startFakeDownloads();
    const body = blob(120_000, 5);
    fake.put("m.bin", body);
    fake.behave("stuck", { kind: "stall", bytes: 40_000 });
    const dir = makeTempDir();
    const file = target(dir, "m.bin", body, urlsOf(fake, "m.bin", "stuck", "good"));
    const { ctx, logs } = context({ stallMs: 300 });
    await downloadFile(file, ctx);
    expect(fs.readFileSync(file.dest).equals(body)).toBe(true);
    expect(fake.requests.find((r) => r.mirror === "good")?.range).toBe("bytes=40000-");
    expect(logs.join("\n")).toContain("秒没收到数据");
  });

  test("镜像给的内容和清单的 sha256 对不上：这一份不用，不再用它，换别的地址从头下", async () => {
    const fake = await startFakeDownloads();
    const body = blob(30_000, 6);
    fake.put("m.bin", body);
    fake.behave("evil", { kind: "corrupt" });
    const dir = makeTempDir();
    const file = target(dir, "m.bin", body, urlsOf(fake, "m.bin", "evil", "good"));
    const { ctx, logs } = context();
    await downloadFile(file, ctx);
    expect(fs.readFileSync(file.dest).equals(body)).toBe(true);
    expect(logs.join("\n")).toContain("sha256 对不上");
    expect(fake.requests.filter((r) => r.mirror === "evil")).toHaveLength(1);
    expect(fake.requests.find((r) => r.mirror === "good")?.range).toBeUndefined();
  });

  test("所有地址给的都不对：报校验对不上，正式的名字和 .part 都不留", async () => {
    const fake = await startFakeDownloads();
    const body = blob(30_000, 7);
    fake.put("m.bin", body);
    fake.behave("a", { kind: "corrupt" });
    fake.behave("b", { kind: "wrongSize" });
    const dir = makeTempDir();
    const file = target(dir, "m.bin", body, urlsOf(fake, "m.bin", "a", "b"));
    const error = await downloadFile(file, context().ctx).catch((err: unknown) => err);
    expect((error as DownloadError).kind).toBe("checksum");
    expect(fs.readdirSync(dir)).toEqual([]);
  });

  test("没写 sha256 的小文件只核对大小", async () => {
    const fake = await startFakeDownloads();
    const body = Buffer.from('{"a": 1}\n');
    fake.put("config.json", body);
    const dir = makeTempDir();
    await downloadFile(target(dir, "config.json", body, urlsOf(fake, "config.json", "a"), false), context().ctx);
    expect(fs.readFileSync(path.join(dir, "config.json"), "utf8")).toBe('{"a": 1}\n');
  });

  test("服务端不认 Range、从头给的：下了一半的不要了，照它从头写", async () => {
    const fake = await startFakeDownloads();
    const body = blob(80_000, 8);
    fake.put("m.bin", body);
    fake.behave("a", { kind: "noRange" });
    const dir = makeTempDir();
    const file = target(dir, "m.bin", body, urlsOf(fake, "m.bin", "a"));
    fs.writeFileSync(file.part, body.subarray(0, 10_000));
    await downloadFile(file, context().ctx);
    expect(fs.readFileSync(file.dest).equals(body)).toBe(true);
  });

  test("哪个地址都下不下来：报下不下来，下好的部分留着", async () => {
    const fake = await startFakeDownloads();
    const body = blob(10_000, 9);
    fake.put("m.bin", body);
    fake.behave("a", { kind: "broken" });
    const dir = makeTempDir();
    const error = await downloadFile(target(dir, "m.bin", body, urlsOf(fake, "m.bin", "a")), context().ctx).catch((err: unknown) => err);
    expect((error as DownloadError).kind).toBe("unreachable");
    expect((error as DownloadError).message).toContain("HTTP 500");
  });
});

describe("探速", () => {
  test("慢的、坏的排在后面，快的排最前", async () => {
    const fake = await startFakeDownloads();
    const body = blob(200_000, 10);
    fake.put("m.bin", body);
    fake.behave("slow", { kind: "slow", bytesPerTick: 2000, tickMs: 50 });
    fake.behave("bad", { kind: "broken" });
    const ranked = await probeSources(urlsOf(fake, "m.bin", "slow", "bad", "fast"), { transport, bytes: 64 * 1024, size: body.length, timeoutMs: 400, signal: new AbortController().signal });
    expect(ranked.map((r) => r.sourceId)).toEqual(["fast", "slow", "bad"]);
    expect(ranked[2]?.error).toContain("HTTP 500");
    expect(fake.requests.find((r) => r.mirror === "fast")?.range).toBe("bytes=0-65535");
    fake.releaseAll();
  });
});

describe("走代理", () => {
  test("https 的经 CONNECT 隧道（这里用 http 的目标测隧道那条路）", async () => {
    const fake = await startFakeDownloads();
    const proxy = await startFakeProxy();
    const body = blob(20_000, 11);
    fake.put("m.bin", body);
    const viaProxy = createHttpTransport({ proxyFor: () => new URL(proxy.url), tunnelHttp: true });
    const dir = makeTempDir();
    await downloadFile(target(dir, "m.bin", body, urlsOf(fake, "m.bin", "a")), { ...context().ctx, transport: viaProxy });
    expect(fs.readFileSync(path.join(dir, "m.bin")).equals(body)).toBe(true);
    expect(proxy.seen).toEqual([`CONNECT ${new URL(fake.url).host}`]);
  });

  test("http 的把完整地址交给代理", async () => {
    const fake = await startFakeDownloads();
    const proxy = await startFakeProxy();
    const body = blob(20_000, 12);
    fake.put("m.bin", body);
    const viaProxy = createHttpTransport({ proxyFor: () => new URL(proxy.url) });
    const dir = makeTempDir();
    await downloadFile(target(dir, "m.bin", body, urlsOf(fake, "m.bin", "a")), { ...context().ctx, transport: viaProxy });
    expect(fs.readFileSync(path.join(dir, "m.bin")).equals(body)).toBe(true);
    expect(proxy.seen).toEqual([`${fake.url}/a/m.bin`]);
  });

  test("代理怎么定：环境变量优先、NO_PROXY 不走、本机回环不走；没设环境变量看 Windows 的系统代理", () => {
    const env = proxyResolver({ env: { HTTPS_PROXY: "http://proxy.local:7890", no_proxy: "internal.example,.corp" }, system: () => ({ server: "sys:1" }) });
    expect(env(new URL("https://huggingface.co/x"))?.href).toBe("http://proxy.local:7890/");
    expect(env(new URL("https://internal.example/x"))).toBeUndefined();
    expect(env(new URL("https://a.corp/x"))).toBeUndefined();
    expect(env(new URL("http://127.0.0.1:8810/x"))).toBeUndefined();
    expect(env(new URL("http://plain.example/x"))).toBeUndefined();

    const system = proxyResolver({ env: {}, system: () => ({ server: "http=127.0.0.2:1080;https=127.0.0.2:1081", override: "<local>;*.lan" }) });
    expect(system(new URL("https://hf-mirror.com/x"))?.href).toBe("http://127.0.0.2:1081/");
    expect(system(new URL("http://registry.npmjs.org/x"))?.href).toBe("http://127.0.0.2:1080/");
    expect(system(new URL("https://nas.lan/x"))).toBeUndefined();
    expect(system(new URL("https://intranet/x"))).toBeUndefined();
    expect(proxyResolver({ env: {}, system: () => undefined })(new URL("https://a.example/"))).toBeUndefined();
  });

  test("认 reg query 的输出：开着才算", () => {
    const out = ["", "HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings", "    ProxyEnable    REG_DWORD    0x1", "    ProxyServer    REG_SZ    127.0.0.1:7890", "    ProxyOverride    REG_SZ    <local>", ""].join("\r\n");
    expect(parseRegQuery(out)).toEqual({ server: "127.0.0.1:7890", override: "<local>" });
    expect(parseRegQuery(out.replace("0x1", "0x0"))).toBeUndefined();
  });
});
