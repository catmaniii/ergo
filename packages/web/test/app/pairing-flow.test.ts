// 配对页的流程（137 号票，app/pairing-flow.ts）：打开页面只问"这台设备有没有配对请求"，点了"请求配对"才发请求；
// 过期、被拒之后回到说明页，不自动重发，要再点一次。配对接口换成记下调用的假的。
import { describe, expect, test } from "vitest";
import { type PairingApi, PairingError, PairingFlow } from "../../src/app/pairing-flow.ts";
import type { PairingRequestView } from "../../src/state/index.ts";

const request = (overrides: Partial<PairingRequestView> = {}): PairingRequestView => ({
  id: "pr-1",
  status: "pending",
  deviceName: "Chrome · Linux",
  shortCode: "482913",
  fingerprint: "9f3ac21e",
  expiresAt: "2026-10-18T09:05:00.000+08:00",
  ...overrides,
});

/** 假的配对接口：current 回 server 里的那一个；create、rename 记下来 */
function fakeApi(initial?: PairingRequestView) {
  const calls = { current: 0, create: [] as Array<string | undefined>, rename: [] as string[] };
  let server = initial;
  let failCreate: string | undefined;
  const api: PairingApi = {
    current: async () => {
      calls.current += 1;
      return server;
    },
    create: async (deviceName) => {
      calls.create.push(deviceName);
      if (failCreate !== undefined) throw new PairingError(failCreate);
      server = request({ id: `pr-${calls.create.length}`, deviceName: deviceName ?? "Chrome · Linux" });
      return server;
    },
    rename: async (deviceName) => {
      calls.rename.push(deviceName);
      server = { ...server!, deviceName };
      return server;
    },
  };
  return {
    api,
    calls,
    /** 守护进程那边变了（批准、拒绝、过期） */
    set: (r: PairingRequestView | undefined) => void (server = r),
    failCreateWith: (message: string | undefined) => void (failCreate = message),
  };
}

describe("配对页的流程", () => {
  test("打开页面：只问一次有没有请求，不发请求；问到之前\"请求配对\"不能点", async () => {
    const fake = fakeApi();
    const flow = new PairingFlow(fake.api);
    expect(flow.getState()).toMatchObject({ loaded: false, busy: false });
    await flow.open();
    expect(fake.calls).toEqual({ current: 1, create: [], rename: [] });
    expect(flow.getState()).toMatchObject({ loaded: true, request: undefined });
    // 问着问着（等批准时的轮询）也不会发请求
    await flow.poll();
    expect(fake.calls.create).toEqual([]);
  });

  test("点了\"请求配对\"才发，带着说明页上的设备名；之后照常等批准", async () => {
    const fake = fakeApi();
    const flow = new PairingFlow(fake.api);
    await flow.open();
    await flow.request("小王的 Linux 电脑");
    expect(fake.calls.create).toEqual(["小王的 Linux 电脑"]);
    expect(flow.getState()).toMatchObject({ busy: false, request: { status: "pending", deviceName: "小王的 Linux 电脑" } });
  });

  test("过期、被拒之后回到说明页：轮询不重发，再点一次才发新的", async () => {
    const fake = fakeApi();
    const flow = new PairingFlow(fake.api);
    await flow.open();
    await flow.request("Chrome · Linux");
    fake.set(request({ status: "expired" }));
    await flow.poll();
    await flow.poll();
    expect(flow.getState().request?.status).toBe("expired");
    expect(fake.calls.create).toHaveLength(1);
    fake.set(request({ status: "denied" }));
    await flow.poll();
    expect(flow.getState().request?.status).toBe("denied");
    expect(fake.calls.create).toHaveLength(1);
    await flow.request("Chrome · Linux");
    expect(fake.calls.create).toHaveLength(2);
    expect(flow.getState().request).toMatchObject({ id: "pr-2", status: "pending" });
  });

  test("刷新了页面、已经有在等的请求：接着等，不再发一个", async () => {
    const fake = fakeApi(request());
    const flow = new PairingFlow(fake.api);
    await flow.open();
    expect(flow.getState().request).toMatchObject({ id: "pr-1", status: "pending" });
    expect(fake.calls.create).toEqual([]);
  });

  test("发请求被拒（太频繁）：留在说明页、写明原因，不自动重试；再点成功后原因清掉", async () => {
    const fake = fakeApi();
    const flow = new PairingFlow(fake.api);
    await flow.open();
    fake.failCreateWith("同一来源 10 分钟内最多 5 个配对请求，请过一会儿再试");
    await flow.request("Chrome · Linux");
    expect(flow.getState()).toMatchObject({ busy: false, request: undefined, error: "同一来源 10 分钟内最多 5 个配对请求，请过一会儿再试" });
    await flow.poll();
    expect(fake.calls.create).toHaveLength(1);
    fake.failCreateWith(undefined);
    await flow.request("Chrome · Linux");
    expect(flow.getState()).toMatchObject({ error: undefined, request: { status: "pending" } });
  });

  test("连点两下只发一个请求", async () => {
    const fake = fakeApi();
    const flow = new PairingFlow(fake.api);
    await flow.open();
    await Promise.all([flow.request("Chrome · Linux"), flow.request("Chrome · Linux")]);
    expect(fake.calls.create).toHaveLength(1);
  });

  test("问不到（网断了）：照样能点\"请求配对\"，原因写出来", async () => {
    const flow = new PairingFlow({ ...fakeApi().api, current: async () => Promise.reject(new Error("Failed to fetch")) });
    await flow.open();
    expect(flow.getState()).toMatchObject({ loaded: true, error: "Failed to fetch" });
  });

  test("等批准时改设备名：成功换成新名字；失败写原因，回报没改成", async () => {
    const fake = fakeApi();
    const flow = new PairingFlow(fake.api);
    await flow.open();
    await flow.request("Chrome · Linux");
    expect(await flow.rename("书房的电脑")).toBe(true);
    expect(flow.getState().request?.deviceName).toBe("书房的电脑");
    const failing = new PairingFlow({ ...fake.api, rename: async () => Promise.reject(new PairingError("这个配对请求已经不在等批准了，不能再改设备名")) });
    await failing.open();
    expect(await failing.rename("别的名字")).toBe(false);
    expect(failing.getState().error).toBe("这个配对请求已经不在等批准了，不能再改设备名");
  });

  test("订阅：状态变了通知；取消订阅后不再通知", async () => {
    const flow = new PairingFlow(fakeApi().api);
    let n = 0;
    const off = flow.subscribe(() => (n += 1));
    await flow.open();
    expect(n).toBeGreaterThan(0);
    const seen = n;
    off();
    await flow.request("Chrome · Linux");
    expect(n).toBe(seen);
  });
});
