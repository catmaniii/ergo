// 记忆整理之前同步一遍的那一半（data-sources/service.ts 的 syncPullable）：在假内核里装上假数据源插件（helpers/fake-data-source.ts），
// 再加一个只由设备交来的假数据源，查：
// - 能由电脑拉的、插件在运行、导入开着、连着的同步一次，触发方式记成定期的那种（scheduled），交回同步的结果；
// - 刚同步过的（freshMs 以内成功过）不再同步，交回上次的时间；过了 freshMs 照常同步；上次同步出错的不算刚同步过；
// - 正在同步的交回同一次（不叠着再同步）；
// - 连接出错的不试（每小时再试那一套管），交回原因（密钥换成 ***）；
// - 没连的、导入关着的、插件停用的、设备交来的、只靠导入文件夹的都不在结果里。
import { afterEach, describe, expect, it } from "vitest";
import type { DataSource } from "../../src/data-sources/api.ts";
import type { PullableSync } from "../../src/data-sources/index.ts";
import type { PluginDefinition } from "../../src/plugins/host.ts";
import { FAKE_KEY, FAKE_SOURCE_ID, FAKE_SOURCE_PLUGIN, fakeDataSourcePlugin, fakeRemote, resetFakeRemote } from "../helpers/fake-data-source.ts";
import { type PluginKernel, startPluginKernel } from "../helpers/plugin-kernel.ts";

afterEach(() => resetFakeRemote());

let keySeq = 0;
const key = () => `pull-${++keySeq}`;
const connect = (k: PluginKernel) => k.dataSources.act(FAKE_SOURCE_ID, { action: "configure", values: { key: FAKE_KEY }, idempotencyKey: key() });
const FRESH_MS = 10 * 60_000;
const ids = (pulled: readonly PullableSync[]) => pulled.map((p) => `${p.id}:${p.state}`);

/** 只由设备交来的假数据源（手机那样）：连着、导入开着，但没有 sync */
const deviceOnlyPlugin: PluginDefinition = {
  name: "device-source",
  title: "假手机",
  contracts(ctx) {
    ctx.dataSources.register({
      id: "device",
      title: "假手机",
      usages: { import: { default: true } },
      status: () => ({ connection: "connected" }),
      push: { body: {} as never, receive: () => ({ added: 0 }) },
    } as DataSource);
  },
  setup() {},
};

describe("记忆整理之前同步一遍（syncPullable）", () => {
  it("连着、导入开着的同步一次（记成定期的那种）；设备交来的、只靠导入文件夹的、没连的不在里面", async () => {
    const k = await startPluginKernel({ plugins: [fakeDataSourcePlugin, deviceOnlyPlugin] });
    // 还没连：一个都没有（假账单只靠导入文件夹、假手机由设备交来，都不在）
    expect(k.dataSources.syncPullable({ freshMs: FRESH_MS })).toEqual([]);
    expect(fakeRemote.syncs).toEqual([]);

    await connect(k);
    fakeRemote.next = ["早上跑了步", "下午开了会"];
    const pulled = k.dataSources.syncPullable({ freshMs: FRESH_MS });
    expect(ids(pulled)).toEqual([`${FAKE_SOURCE_ID}:started`]);
    expect(pulled[0]!.title).toBe("假数据源");
    const started = pulled[0]!;
    if (started.state !== "started") throw new Error("应该开始同步了");
    expect(await started.done).toEqual({ added: 2 });
    expect(fakeRemote.syncs).toEqual(["scheduled"]);
    // 记了同步记录，页面上"上次同步"是这一次（定期的那种）
    expect(k.dataSources.view().sources.find((s) => s.id === FAKE_SOURCE_ID)!.lastSync).toMatchObject({ trigger: "scheduled", added: 2 });
  });

  it("刚同步过的不再同步，过了 freshMs 照常同步；上次同步出错的不算刚同步过", async () => {
    const k = await startPluginKernel({ plugins: [fakeDataSourcePlugin] });
    await connect(k);
    await k.dataSources.sync(FAKE_SOURCE_ID, "manual");
    const syncedAt = k.clock.now();
    k.clock.advance(5 * 60_000);
    const fresh = k.dataSources.syncPullable({ freshMs: FRESH_MS });
    expect(ids(fresh)).toEqual([`${FAKE_SOURCE_ID}:fresh`]);
    expect(Date.parse((fresh[0] as Extract<PullableSync, { state: "fresh" }>).at)).toBe(syncedAt);
    expect(fakeRemote.syncs).toEqual(["manual"]);

    // 过了 10 分钟：照常同步
    k.clock.advance(6 * 60_000);
    const again = k.dataSources.syncPullable({ freshMs: FRESH_MS });
    expect(ids(again)).toEqual([`${FAKE_SOURCE_ID}:started`]);
    await (again[0] as Extract<PullableSync, { state: "started" }>).done;
    expect(fakeRemote.syncs).toEqual(["manual", "scheduled"]);

    // 上次成功的是 11 分钟前，之后那一次出错（连接照样连着）：出错的不算刚同步过，再同步一次
    k.clock.advance(11 * 60_000);
    fakeRemote.fail = "那边忙";
    await k.dataSources.sync(FAKE_SOURCE_ID, "manual");
    fakeRemote.fail = undefined;
    k.clock.advance(60_000);
    const afterError = k.dataSources.syncPullable({ freshMs: FRESH_MS });
    expect(ids(afterError)).toEqual([`${FAKE_SOURCE_ID}:started`]);
    await (afterError[0] as Extract<PullableSync, { state: "started" }>).done;
  });

  it("正在同步的交回同一次，不叠着再同步", async () => {
    const k = await startPluginKernel({ plugins: [fakeDataSourcePlugin] });
    await connect(k);
    let release!: () => void;
    fakeRemote.gate = new Promise<void>((resolve) => (release = resolve));
    fakeRemote.next = ["一条"];
    const running = k.dataSources.sync(FAKE_SOURCE_ID, "manual");
    const pulled = k.dataSources.syncPullable({ freshMs: FRESH_MS });
    expect(ids(pulled)).toEqual([`${FAKE_SOURCE_ID}:started`]);
    expect(fakeRemote.syncs).toEqual(["manual"]);
    release();
    expect(await (pulled[0] as Extract<PullableSync, { state: "started" }>).done).toEqual(await running);
    expect(fakeRemote.syncs).toEqual(["manual"]);
  });

  it("连接出错的不试，交回原因；导入关着、插件停用的不在里面", async () => {
    const k = await startPluginKernel({ plugins: [fakeDataSourcePlugin] });
    await connect(k);
    // Key 失效了（连接状态是出错）：不同步，交回原因
    fakeRemote.keyRefused = true;
    const broken = k.dataSources.syncPullable({ freshMs: FRESH_MS });
    expect(broken).toEqual([{ id: FAKE_SOURCE_ID, title: "假数据源", state: "broken", problem: "Key 失效了" }]);
    expect(fakeRemote.syncs).toEqual([]);
    fakeRemote.keyRefused = false;

    // 导入关着
    await k.dataSources.act(FAKE_SOURCE_ID, { action: "usage", usage: "import", on: false, idempotencyKey: key() });
    expect(k.dataSources.syncPullable({ freshMs: FRESH_MS })).toEqual([]);
    await k.dataSources.act(FAKE_SOURCE_ID, { action: "usage", usage: "import", on: true, idempotencyKey: key() });

    // 插件停用
    await k.settings.act(FAKE_SOURCE_PLUGIN, { action: "disable", idempotencyKey: key() });
    expect(k.dataSources.syncPullable({ freshMs: FRESH_MS })).toEqual([]);
    expect(fakeRemote.syncs).toEqual([]);
  });
});
