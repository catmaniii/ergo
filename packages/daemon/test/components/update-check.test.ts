// 组件查更新（347 号票，ADR-0042）：查的是发布页上的版本清单（components-manifest.json 和它的签名），按发布公钥验过才认。
// - 有新版本：显示"有新版本"，一个字节都不换、不下；点了"更新"才下，换上以后守护进程重启还是新版本（装上的那一条记在 installed.json）；
// - 只取清单：地址上没有查询串，只有这两个请求；
// - 断网、签名不对、清单坏了：不抛错，只记下原因；上次查到的还算数；发布页上还没有这份清单（404）连没查成都不算；
// - 清单不比现在的新（版本号）：不提示；要的依赖这一版没有的：不提示；
// - 更新下到一半失败、取消：旧版本照常用；许可换了版本：要重新确认才下；
// - 重启后：上次查到的还在（重新验签）；被人改过的不认。
// 用自己编的小清单和本机的假下载服务，测试不联网。
import fs from "node:fs";
import path from "node:path";
import { describe, expect, test } from "vitest";
import { type Components, createComponents, createUpdateChecker, LATEST_MANIFEST_NAME, latestManifestUrl, parseManifest } from "../../src/components/index.ts";
import { createHttpTransport, type Transport } from "../../src/components/transport.ts";
import { RequestRejected } from "../../src/errors.ts";
import { parsePublicKey, sign } from "../../src/release/minisign.ts";
import { blob, type FakeDownloads, fakeProbes, sha256, startFakeDownloads } from "../helpers/fake-downloads.ts";
import { releaseKey } from "../helpers/fake-release.ts";
import { waitUntil } from "../helpers/process.ts";
import { makeTempDir } from "../helpers/temp-dir.ts";

const V1 = blob(30_000, 61);
const V2 = blob(40_000, 62);
const OTHER = blob(5_000, 63);

function entry(fake: FakeDownloads, version: string, file: string, body: Buffer, extra: Record<string, unknown> = {}) {
  fake.put(file, body);
  return {
    id: "model",
    version,
    default: "ask",
    enables: ["memory.semantic"],
    target: "models/test/model",
    sources: [{ id: "a", title: "镜像 A", url: fake.source("a") }],
    variants: [{ id: "any", parts: [{ files: [{ path: file, size: body.length, sha256: sha256(body) }] }] }],
    ...extra,
  };
}

function other(fake: FakeDownloads) {
  fake.put("other.bin", OTHER);
  return { id: "other", version: "1", default: "ask", enables: [], target: "components/other", sources: [{ id: "a", title: "镜像 A", url: fake.source("a") }], variants: [{ id: "any", parts: [{ files: [{ path: "other.bin", size: OTHER.length, sha256: sha256(OTHER) }] }] }] };
}

interface Rig {
  fake: FakeDownloads;
  root: string;
  key: ReturnType<typeof releaseKey>;
  url: string;
  /** 把一份清单放到发布页上（默认用发布钥匙签） */
  publish(manifest: Record<string, unknown>, options?: { key?: ReturnType<typeof releaseKey>; signature?: string }): void;
  start(over?: { transport?: Transport; publicKey?: boolean }): Components;
}

async function rig(): Promise<Rig> {
  const fake = await startFakeDownloads();
  const root = makeTempDir("ergo-component-updates-");
  const key = releaseKey();
  const base = `${fake.url}/release`;
  const shipped = { signed: false, manifest: parseManifest({ format: 1, release: "0.1.0", components: [entry(fake, "v1", "v1.bin", V1), other(fake)] }) };
  return {
    fake,
    root,
    key,
    url: latestManifestUrl(base),
    publish(manifest, options = {}) {
      const bytes = Buffer.from(JSON.stringify(manifest));
      fake.put(LATEST_MANIFEST_NAME, bytes);
      fake.put(`${LATEST_MANIFEST_NAME}.minisig`, options.signature ?? sign(bytes, (options.key ?? key).secret, { fileName: LATEST_MANIFEST_NAME, trustedComment: "ergo test components manifest" }));
    },
    start(over = {}) {
      const transport = over.transport ?? createHttpTransport();
      return createComponents({
        root,
        componentsDir: path.join(root, "components"),
        manifest: shipped,
        probes: fakeProbes(),
        transport,
        updates: createUpdateChecker({ componentsDir: path.join(root, "components"), url: latestManifestUrl(base), transport, publicKey: () => (over.publicKey === false ? undefined : releaseKeyOf(key)), timeoutMs: 5000, log }),
        log,
      });
    },
  };
}

const log = () => {};
const releaseKeyOf = (key: ReturnType<typeof releaseKey>) => parsePublicKey(key.publicText);

const one = (components: Components, id = "model") => components.view().components.find((c) => c.id === id)!;
const installedFile = (root: string, name: string) => path.join(root, "models", "test", "model", name);

async function installV1(components: Components) {
  await components.act("model", "install");
  await components.whenIdle();
  expect(one(components).state).toBe("installed");
}

/** 清单里只有文件换过的新版本（发布的是 0.5.0） */
const newer = (r: Rig, extra: Record<string, unknown> = {}) => ({ format: 1, release: "0.5.0", components: [entry(r.fake, "v2", "v2.bin", V2, extra), other(r.fake)] });

describe("查更新", () => {
  test("有新版本：页面写有新版本，什么都不下、不换；点了更新才下，换上以后重启还是新版本", async () => {
    const r = await rig();
    const components = r.start();
    await installV1(components);
    r.publish(newer(r));
    r.fake.requests.length = 0;

    const view = await components.checkUpdates();
    expect(view.updates).toMatchObject({ where: r.url, available: ["model"] });
    expect(view.updates?.error).toBeUndefined();
    expect(view.updates?.checkedAt).toBeTypeOf("string");
    expect(one(components)).toMatchObject({ state: "update", version: "v2", installedVersion: "v1", size: V2.length });
    expect(components.pendingUpdates()).toEqual([{ id: "model", title: one(components).title, version: "v2" }]);
    // 只取了版本清单和签名，别的什么都没下；旧文件还在
    expect(r.fake.requests.map((q) => q.path)).toEqual([LATEST_MANIFEST_NAME, `${LATEST_MANIFEST_NAME}.minisig`]);
    expect(fs.readFileSync(installedFile(r.root, "v1.bin")).equals(V1)).toBe(true);
    expect(fs.existsSync(installedFile(r.root, "v2.bin"))).toBe(false);

    await components.act("model", "update");
    await components.whenIdle();
    expect(one(components)).toMatchObject({ state: "installed", version: "v2", installedVersion: "v2" });
    expect(fs.readFileSync(installedFile(r.root, "v2.bin")).equals(V2)).toBe(true);
    expect(fs.existsSync(installedFile(r.root, "v1.bin"))).toBe(false);
    expect(components.view().updates?.available).toEqual([]);
    expect(components.pendingUpdates()).toEqual([]);
    await components.stop();

    // 重启：随程序的清单还是 v1，装上的那一条记着，不会又说"有新版本"，也不会说要换回 v1
    const again = r.start();
    expect(one(again)).toMatchObject({ state: "installed", version: "v2", installedVersion: "v2" });
    expect(again.view().updates?.available).toEqual([]);
    // 文件大小按装上的那一条认，语音服务那些看"装好了没有"的不会以为没装
    await again.stop();
  });

  test("请求上不带任何东西：只是两个 GET，地址没有查询串，User-Agent 只有组件下载那一句", async () => {
    const r = await rig();
    r.publish(newer(r));
    const seen: string[] = [];
    const real = createHttpTransport({ userAgent: "ergo-components" });
    const components = r.start({
      transport: (url, request) => {
        seen.push(url);
        return real(url, request);
      },
    });
    await components.checkUpdates();
    expect(seen).toEqual([r.url, `${r.url}.minisig`]);
    expect(seen.every((url) => new URL(url).search === "")).toBe(true);
    expect(new Set(r.fake.requests.map((q) => q.userAgent))).toEqual(new Set(["ergo-components"]));
    await components.stop();
  });

  test("默认查的是 GitHub 发布页；给了自己的发布地址查那里", () => {
    expect(latestManifestUrl(undefined)).toBe(`https://github.com/catmaniii/ergo/releases/latest/download/${LATEST_MANIFEST_NAME}`);
    expect(latestManifestUrl("https://mirror.example/ergo/")).toBe(`https://mirror.example/ergo/${LATEST_MANIFEST_NAME}`);
  });

  test("断网：不抛错、不提示，只记下原因；后来通了就清掉", async () => {
    const r = await rig();
    r.publish(newer(r));
    let online = false;
    const real = createHttpTransport();
    const components = r.start({ transport: (url, request) => (online ? real(url, request) : Promise.reject(new Error("connect ECONNREFUSED"))) });
    const failed = await components.checkUpdates();
    expect(failed.updates?.error).toContain("ECONNREFUSED");
    expect(failed.updates?.available).toEqual([]);
    expect(components.pendingUpdates()).toEqual([]);
    online = true;
    const ok = await components.checkUpdates();
    expect(ok.updates?.error).toBeUndefined();
    await components.stop();
  });

  test("发布页上还没有这份清单（404）：不算没查成，重启后还记着；后来有了就正常", async () => {
    const r = await rig();
    const components = r.start();
    await installV1(components);
    const view = await components.checkUpdates();
    expect(view.updates).toMatchObject({ notPublished: true, available: [] });
    expect(view.updates?.error).toBeUndefined();
    expect(view.updates?.checkedAt).toBeTypeOf("string");
    expect(one(components).state).toBe("installed");
    await components.stop();

    const again = r.start();
    expect(again.view().updates?.notPublished).toBe(true);
    r.publish(newer(r));
    const found = await again.checkUpdates();
    expect(found.updates?.notPublished).toBeUndefined();
    expect(found.updates?.available).toEqual(["model"]);
    await again.stop();
  });

  test("清单在、签名没有（404）：这是没查成，写原因，不认", async () => {
    const r = await rig();
    const components = r.start();
    r.fake.put(LATEST_MANIFEST_NAME, JSON.stringify(newer(r)));
    const view = await components.checkUpdates();
    expect(view.updates?.notPublished).toBeUndefined();
    expect(view.updates?.error).toContain("404");
    await components.stop();
  });

  test("清单坏了、签名不对、别的钥匙签的、程序里没有公钥：都不认、不提示", async () => {
    const r = await rig();
    const components = r.start();
    await installV1(components);

    r.fake.put(LATEST_MANIFEST_NAME, "{ not json");
    r.fake.put(`${LATEST_MANIFEST_NAME}.minisig`, sign(Buffer.from("{ not json"), r.key.secret, { fileName: LATEST_MANIFEST_NAME, trustedComment: "t" }));
    expect((await components.checkUpdates()).updates?.error).toBeTruthy();

    r.publish(newer(r), { key: releaseKey() });
    const wrongKey = await components.checkUpdates();
    expect(wrongKey.updates?.error).toContain("签名");
    expect(wrongKey.updates?.available).toEqual([]);
    expect(one(components).state).toBe("installed");

    const body = newer(r);
    r.publish(body, { signature: "untrusted comment: x\nnot a signature\n" });
    expect((await components.checkUpdates()).updates?.available).toEqual([]);
    await components.stop();

    const noKey = r.start({ publicKey: false });
    r.publish(newer(r));
    const refused = await noKey.checkUpdates();
    expect(refused.updates?.error).toContain("公钥");
    expect(refused.updates?.available).toEqual([]);
    await noKey.stop();
  });

  test("清单不比现在用的新、版本一样、要的依赖这一版没有、换了装的位置：不提示", async () => {
    const r = await rig();
    const components = r.start();
    await installV1(components);
    r.publish({ ...newer(r), release: "0.0.9" });
    expect((await components.checkUpdates()).updates?.available).toEqual([]);
    r.publish({ ...newer(r), release: "0.1.0" });
    expect((await components.checkUpdates()).updates?.available).toEqual([]);
    r.publish({ format: 1, release: "0.5.0", components: [entry(r.fake, "v1", "v1.bin", V1), other(r.fake)] });
    expect((await components.checkUpdates()).updates?.available).toEqual([]);
    r.publish({
      format: 1,
      release: "0.5.0",
      components: [entry(r.fake, "v2", "v2.bin", V2, { dependsOn: ["brand-new"] }), { ...other(r.fake), id: "brand-new" }],
    });
    expect((await components.checkUpdates()).updates?.available).toEqual([]);
    r.publish(newer(r, { target: "models/elsewhere" }));
    expect((await components.checkUpdates()).updates?.available).toEqual([]);
    expect(one(components)).toMatchObject({ state: "installed", version: "v1" });
    await components.stop();
  });

  test("没装的组件不提示；点安装装的是查到的新版本", async () => {
    const r = await rig();
    const components = r.start();
    r.publish(newer(r));
    const view = await components.checkUpdates();
    expect(view.updates?.available).toEqual([]);
    expect(one(components)).toMatchObject({ state: "missing", version: "v2" });
    await components.act("model", "install");
    await components.whenIdle();
    expect(one(components)).toMatchObject({ state: "installed", version: "v2", installedVersion: "v2" });
    expect(fs.readFileSync(installedFile(r.root, "v2.bin")).equals(V2)).toBe(true);
    await components.stop();
  });

  test("更新下载失败：旧版本还在、照常算装好了（对应的功能不灰）；取消回到有新版本；再点更新能装上", async () => {
    const r = await rig();
    const components = r.start();
    await installV1(components);
    r.publish(newer(r));
    await components.checkUpdates();
    r.fake.behave("a", { kind: "broken" });
    await components.act("model", "update");
    await components.whenIdle();
    expect(one(components).state).toBe("failed");
    expect(fs.readFileSync(installedFile(r.root, "v1.bin")).equals(V1)).toBe(true);
    expect(components.view().features.find((f) => f.feature === "memory.semantic")?.ready).toBe(true);
    await components.act("model", "cancel");
    expect(one(components)).toMatchObject({ state: "update", installedVersion: "v1", version: "v2" });
    r.fake.behave("a", { kind: "ok" });
    await components.act("model", "update");
    await components.whenIdle();
    expect(one(components)).toMatchObject({ state: "installed", version: "v2" });
    await components.stop();
  });

  test("新版本的许可换了版本：没确认不下载，确认了才下", async () => {
    const r = await rig();
    const components = r.start();
    await installV1(components);
    r.publish(newer(r, { license: { name: "Model License", summary: "s", url: "https://example.com/l", confirm: true, revision: "2" } }));
    await components.checkUpdates();
    expect(one(components).license).toMatchObject({ name: "Model License", confirm: true, accepted: false });
    r.fake.requests.length = 0;
    await expect(components.act("model", "update")).rejects.toBeInstanceOf(RequestRejected);
    expect(r.fake.requests).toEqual([]);
    await components.act("model", "update", { licenseAccepted: true });
    await components.whenIdle();
    expect(one(components)).toMatchObject({ state: "installed", version: "v2", license: { accepted: true } });
    await components.stop();
  });

  test("重启后上次查到的还算数（重新验签）；清单被人改过的不认；只有查到才写文件", async () => {
    const r = await rig();
    const first = r.start();
    await installV1(first);
    r.publish(newer(r));
    await first.checkUpdates();
    await first.stop();

    const second = r.start();
    expect(one(second)).toMatchObject({ state: "update", version: "v2" });
    expect(second.view().updates?.available).toEqual(["model"]);
    expect(second.view().updates?.checkedAt).toBeTypeOf("string");
    await second.stop();

    const file = path.join(r.root, "components", "latest-manifest.json");
    fs.writeFileSync(file, fs.readFileSync(file, "utf8").replace('"v2"', '"v9"'));
    const third = r.start();
    expect(one(third)).toMatchObject({ state: "installed", version: "v1" });
    expect(third.view().updates?.available).toEqual([]);
    await third.stop();
  });

  test("正在下一个更新时又查了一次：手上这个不受影响，下完算新版本", async () => {
    const r = await rig();
    const components = r.start();
    await installV1(components);
    r.publish(newer(r));
    await components.checkUpdates();
    r.fake.behave("a", { kind: "slow", bytesPerTick: 4000, tickMs: 20 });
    await components.act("model", "update");
    await waitUntil(() => one(components).state === "downloading", { timeoutMs: 5000 });
    r.fake.behave("a", { kind: "ok" });
    await components.checkUpdates();
    await components.whenIdle();
    expect(one(components)).toMatchObject({ state: "installed", version: "v2" });
    await components.stop();
  });
});
