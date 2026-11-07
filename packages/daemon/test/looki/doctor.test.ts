// Looki 插件的体检项（414，src/looki/doctor.ts）：
// - "存一份到本地"（archive，插件登记的）：没开、几类都关着是不适用；停下了（原因照抄，比如"Looki 换了接口"）、有存不下来的是注意；
//   别的正常（写上次存下东西的时间）；
// - 数据源那一项二狗替它生成，Looki 的过期按 26 小时（usages.import.staleAfterMs）：25 小时没同步成功还正常、27 小时就是注意；
//   Key 不认是坏了（needsAuth）——Looki 自己不再登记一项重复报；
// - 插件块里有它登记的那一项，停用后跟着没了。
// 假内核 + 本机的假 Looki（不连真的 Looki）；查的时刻经 createDoctor 的 now 给，不拨假内核的时钟。
import path from "node:path";
import { LOOKI_ARCHIVE_DEFAULT_KINDS, type LookiArchiveView } from "@ergo/protocol";
import { describe, expect, it } from "vitest";
import { dataDirLayout } from "../../src/config/data-dir.ts";
import { LOOKI_PLUGIN, LOOKI_SOURCE_ID } from "../../src/looki/api.ts";
import { archiveFinding } from "../../src/looki/doctor.ts";
import { createLookiPlugin, LOOKI_STALE_AFTER_MS } from "../../src/looki/plugin.ts";
import { KERNEL } from "../../src/plugins/kernel.ts";
import { LOOKI_TEST_KEY, startFakeLooki } from "../helpers/fake-looki.ts";
import { blockOf, itemOf, kernelDoctor } from "../helpers/plugin-doctor.ts";
import { extraService, startPluginKernel } from "../helpers/plugin-kernel.ts";
import { makeTempDir } from "../helpers/temp-dir.ts";

const HOUR = 3_600_000;
const AT = new Date("2026-10-25T10:00:00+08:00");

function archive(extra: Partial<LookiArchiveView> = {}): LookiArchiveView {
  return {
    on: true,
    folder: "D:\\Looki",
    defaultFolder: "D:\\Looki",
    kinds: { ...LOOKI_ARCHIVE_DEFAULT_KINDS },
    saved: { photos: 3, clips: 0, journals: 1, vlogs: 0, bytes: 1024, days: 1 },
    pending: 0,
    failed: 0,
    ...extra,
  };
}

describe("存一份到本地（判法）", () => {
  it("没开、几类都关着：不适用", () => {
    expect(archiveFinding(archive({ on: false }))).toEqual({ level: "na", fact: { key: "looki.doctor.archive.off" } });
    const none = Object.fromEntries(Object.keys(LOOKI_ARCHIVE_DEFAULT_KINDS).map((k) => [k, false])) as LookiArchiveView["kinds"];
    expect(archiveFinding(archive({ kinds: none })).level).toBe("na");
  });

  it("停下了：注意，事实照抄原因原文（比如 Looki 换了接口），动作跳到数据源 Looki", () => {
    const problem = "vlog 没存：Looki 换了接口：这个接口停用了（HTTP 400：This endpoint is deprecated）";
    expect(archiveFinding(archive({ problem, lastSavedAt: "2026-10-25T02:35:00+08:00" }))).toEqual({
      level: "warn",
      fact: { key: "looki.doctor.archive.problem", params: { problem } },
      fix: { key: "looki.doctor.archive.fixProblem" },
      action: { kind: "open", route: `#/more/data-sources/${LOOKI_SOURCE_ID}` },
    });
  });

  it("有时刻试了几次都没存下来：注意；别的正常（写上次存下的时间，还没存过也写明）", () => {
    expect(archiveFinding(archive({ failed: 2 }))).toMatchObject({ level: "warn", fact: { key: "looki.doctor.archive.failed", params: { count: 2 } }, fix: { key: "looki.doctor.archive.fixFailed" } });
    expect(archiveFinding(archive({ lastSavedAt: "2026-10-25T02:35:00+08:00" }))).toMatchObject({ level: "ok", fact: { key: "looki.doctor.archive.ok" } });
    expect(archiveFinding(archive())).toEqual({ level: "ok", fact: { key: "looki.doctor.archive.never" } });
  });
});

async function setup() {
  const fake = await startFakeLooki();
  const home = path.join(makeTempDir("ergo-looki-doctor-"), "Looki");
  const plugin = createLookiPlugin({ endpoints: { cn: fake.base, global: fake.base }, rateLimitWaitMs: 10, archive: { defaultFolder: home } });
  const k = await startPluginKernel({ plugins: [plugin], at: AT, services: [extraService(KERNEL.layout, ({ dir }) => dataDirLayout(dir))] });
  return { fake, k };
}

describe("体检页上的 Looki 一块", () => {
  it("插件登记的存一份到本地在块里；过期按 26 小时：25 小时还正常，27 小时注意（从上次成功起）；停用后那一块没了", async () => {
    const { k } = await setup();
    expect(LOOKI_STALE_AFTER_MS).toBe(26 * HOUR);
    expect(k.doctorChecks.list().map((c) => `${c.plugin}:${c.id}`)).toEqual([`${LOOKI_PLUGIN}:archive`]);
    await k.dataSources.act(LOOKI_SOURCE_ID, { action: "configure", values: { key: LOOKI_TEST_KEY }, idempotencyKey: "c-1" });
    await k.dataSources.act(LOOKI_SOURCE_ID, { action: "sync", idempotencyKey: "s-1" });
    const synced = k.dataSources.doctorFacts().find((f) => f.view.id === LOOKI_SOURCE_ID)!;
    expect(synced.staleMs).toBe(26 * HOUR);
    const lastOk = Date.parse(synced.lastOkAt!);

    const fresh = await kernelDoctor(k, { now: () => lastOk + 25 * HOUR }).view();
    expect(blockOf(fresh, LOOKI_PLUGIN)!.items.map((i) => i.id)).toEqual(["plugin", `source:${LOOKI_SOURCE_ID}`, "archive"]);
    expect(itemOf(fresh, LOOKI_PLUGIN, `source:${LOOKI_SOURCE_ID}`)).toMatchObject({ level: "ok", fact: { key: "doctor.source.synced" } });
    expect(itemOf(fresh, LOOKI_PLUGIN, "archive")).toMatchObject({ level: "ok", text: { title: "存一份到本地" } });

    const stale = await kernelDoctor(k, { now: () => lastOk + 27 * HOUR }).view();
    const item = itemOf(stale, LOOKI_PLUGIN, `source:${LOOKI_SOURCE_ID}`)!;
    expect(item).toMatchObject({ level: "warn", fact: { key: "doctor.source.stale", params: { hours: 27 } }, since: synced.lastOkAt });
    expect(item.text.fact).toContain("27 小时没同步成功");
    expect(blockOf(stale, LOOKI_PLUGIN)!.level).toBe("warn");

    await k.host.disable(LOOKI_PLUGIN);
    expect(k.doctorChecks.list()).toEqual([]);
    expect(blockOf(await kernelDoctor(k).view(), LOOKI_PLUGIN)).toBeUndefined();
  });

  it("Key 不认：数据源那一项坏了（二狗替它生成的），Looki 自己不再另报一项", async () => {
    const { fake, k } = await setup();
    await k.dataSources.act(LOOKI_SOURCE_ID, { action: "configure", values: { key: LOOKI_TEST_KEY }, idempotencyKey: "c-1" });
    fake.mode = "revoked";
    await k.dataSources.act(LOOKI_SOURCE_ID, { action: "sync", idempotencyKey: "s-1" });
    const view = await kernelDoctor(k).view();
    const block = blockOf(view, LOOKI_PLUGIN)!;
    expect(block.level).toBe("error");
    expect(block.items.filter((i) => i.level === "error").map((i) => i.id)).toEqual([`source:${LOOKI_SOURCE_ID}`]);
    expect(itemOf(view, LOOKI_PLUGIN, `source:${LOOKI_SOURCE_ID}`)!.text.fact).toContain("要重新授权");
  });
});
