// OpenStreetMap 瓦片转发（429）：带能认出二狗的 User-Agent、不带 Referer，按缓存头缓存、过期了带条件请求问，
// 上游不通给旧的，同一张同时只取一次、同时在路上的有上限，浏览器断了排队的不去取，超了上限删最老的。全接本机的假 OSM。
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createOsmTiles, expiryOf, OSM_DEFAULT_TTL_MS, TileAborted } from "../../src/map/osm-tiles.ts";
import { MAP_USER_AGENT } from "../../src/map/service.ts";
import { startFakeOsm, TINY_PNG } from "../helpers/fake-map.ts";
import { makeTempDir } from "../helpers/temp-dir.ts";

const tile = (z: number, x: number, y: number) => ({ source: "osm" as const, z, x, y });
const live = () => new AbortController().signal;

async function setup(extra: { maxBytes?: number; concurrency?: number } = {}) {
  const osm = await startFakeOsm();
  const dir = makeTempDir("ergo-osm-tiles-");
  const clock = { now: Date.parse("2026-11-07T10:00:00Z") };
  const logs: string[] = [];
  const tiles = createOsmTiles({ dir, upstream: osm.url, userAgent: MAP_USER_AGENT, now: () => clock.now, log: (l) => logs.push(l), timeoutMs: 5000, ...extra });
  return { osm, dir, clock, logs, tiles };
}

describe("OpenStreetMap 瓦片转发", () => {
  it("第一次去取：地址照官方的写法，User-Agent 写明是二狗、带联系地址，不带 Referer、不发 no-cache；存进缓存，第二次不再去取", async () => {
    const { osm, dir, tiles } = await setup();
    const first = await tiles.get(tile(12, 3428, 1678), live());
    expect(first.status).toBe(200);
    expect(first.headers["Content-Type"]).toBe("image/png");
    expect(first.headers["Cache-Control"]).toBe("private, max-age=3600");
    expect(first.body.equals(TINY_PNG)).toBe(true);
    expect(osm.requests.map((r) => r.url)).toEqual(["/12/3428/1678.png"]);
    const headers = osm.requests[0]!.headers;
    expect(headers["user-agent"]).toMatch(/^ergo\/\d+\.\d+\.\d+ \(.*\+https:\/\/github\.com\/catmaniii\/ergo\)$/);
    expect(headers.referer).toBeUndefined();
    expect(headers["cache-control"]).toBeUndefined();
    expect(headers.pragma).toBeUndefined();
    expect(fs.existsSync(path.join(dir, "12", "3428", "1678.png"))).toBe(true);

    const second = await tiles.get(tile(12, 3428, 1678), live());
    expect(second.status).toBe(200);
    expect(second.body.equals(TINY_PNG)).toBe(true);
    expect(osm.requests).toHaveLength(1);
  });

  it("过期了带 If-None-Match 问一次，304 就续期、不重新下载", async () => {
    const { osm, clock, tiles } = await setup();
    osm.state.mode = { status: 200, headers: { "Cache-Control": "max-age=60" }, etag: '"v1"' };
    await tiles.get(tile(3, 1, 2), live());
    clock.now += 61_000;
    const again = await tiles.get(tile(3, 1, 2), live());
    expect(again.status).toBe(200);
    expect(again.body.equals(TINY_PNG)).toBe(true);
    expect(osm.requests).toHaveLength(2);
    expect(osm.requests[1]!.headers["if-none-match"]).toBe('"v1"');
    // 续了期：一分钟内不再问
    await tiles.get(tile(3, 1, 2), live());
    expect(osm.requests).toHaveLength(2);
  });

  it("缓存头：max-age、Expires 照上游的，读不到的存 7 天，no-store 不存", () => {
    const now = Date.parse("2026-11-07T10:00:00Z");
    expect(expiryOf(new Headers({ "Cache-Control": "public, max-age=86400" }), now)).toBe(now + 86_400_000);
    expect(expiryOf(new Headers({ Expires: "Sat, 07 Nov 2026 12:00:00 GMT" }), now)).toBe(Date.parse("2026-11-07T12:00:00Z"));
    expect(expiryOf(new Headers({}), now)).toBe(now + OSM_DEFAULT_TTL_MS);
    expect(OSM_DEFAULT_TTL_MS).toBe(7 * 24 * 3600 * 1000);
    expect(expiryOf(new Headers({ "Cache-Control": "no-store" }), now)).toBeUndefined();
  });

  it("上游说 no-store 的不存，每次都去取", async () => {
    const { osm, dir, tiles } = await setup();
    osm.state.mode = { status: 200, headers: { "Cache-Control": "no-store" } };
    await tiles.get(tile(1, 0, 0), live());
    await tiles.get(tile(1, 0, 0), live());
    expect(osm.requests).toHaveLength(2);
    expect(fs.existsSync(path.join(dir, "1", "0", "0.png"))).toBe(false);
  });

  it("上游出错：有旧的给旧的（浏览器只缓存 1 分钟），没有回 502；上游说没有回 404", async () => {
    const { osm, clock, logs, tiles } = await setup();
    await tiles.get(tile(2, 1, 1), live());
    clock.now += 2 * 3600_000;
    osm.state.mode = { status: 503, headers: {} };
    const stale = await tiles.get(tile(2, 1, 1), live());
    expect(stale.status).toBe(200);
    expect(stale.headers["Cache-Control"]).toBe("private, max-age=60");
    expect(logs.some((l) => l.includes("2/1/1") && l.includes("HTTP 503"))).toBe(true);
    expect((await tiles.get(tile(2, 2, 2), live())).status).toBe(502);
    osm.state.mode = { status: 404, headers: {} };
    expect((await tiles.get(tile(2, 3, 3), live())).status).toBe(404);
  });

  it("同一张同时只取一次；同时在路上的不超过上限", async () => {
    const { osm, tiles } = await setup({ concurrency: 2 });
    osm.state.slowMs = 80;
    const same = await Promise.all([tiles.get(tile(5, 1, 1), live()), tiles.get(tile(5, 1, 1), live()), tiles.get(tile(5, 1, 1), live())]);
    expect(same.every((r) => r.status === 200)).toBe(true);
    expect(osm.requests).toHaveLength(1);
    const many = await Promise.all([1, 2, 3, 4, 5, 6].map((y) => tiles.get(tile(5, 2, y), live())));
    expect(many.every((r) => r.status === 200)).toBe(true);
    expect(osm.state.maxInFlight).toBeLessThanOrEqual(2);
  });

  it("浏览器断了：还在排队的不去取（不预取没人看的瓦片）", async () => {
    const { osm, tiles } = await setup({ concurrency: 1 });
    osm.state.slowMs = 100;
    const first = tiles.get(tile(6, 0, 0), live());
    const leaving = new AbortController();
    const queued = tiles.get(tile(6, 0, 1), leaving.signal);
    leaving.abort();
    await expect(queued).rejects.toBeInstanceOf(TileAborted);
    await first;
    expect(osm.requests.map((r) => r.url)).toEqual(["/6/0/0.png"]);
  });

  it("超过上限删掉最老的", async () => {
    const { dir, tiles } = await setup({ maxBytes: TINY_PNG.length * 3 });
    for (let y = 0; y < 6; y++) {
      await tiles.get(tile(4, 0, y), live());
      await new Promise((r) => setTimeout(r, 15));
    }
    // 删是在后台做的：等它做完
    for (let i = 0; i < 50 && fs.readdirSync(path.join(dir, "4", "0")).filter((f) => f.endsWith(".png")).length > 3; i++) await new Promise((r) => setTimeout(r, 20));
    const left = fs.readdirSync(path.join(dir, "4", "0")).filter((f) => f.endsWith(".png"));
    expect(left.length).toBeLessThanOrEqual(3);
    expect(left).toContain("5.png");
    expect(left).not.toContain("0.png");
    expect(await tiles.cachedBytes()).toBeLessThanOrEqual(TINY_PNG.length * 3);
  });
});
