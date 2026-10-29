// 候选文件预备好（149 号票，app/page-stage.ts；用户 2026-10-18："最好在选定图片前，提交图片到上传框的脚本就已经写好了，这样选中的
// 瞬间就可以开始提交"）：取字节、交给 App、丢掉、记日志都换成假的。查：
// - 候选一出来就预备：推荐的先取，一次一个，取回来就交给 App 暂存；预备的加起来超了上限的不预备（点了再取）；
// - 点了"交"：暂存好的直接用、不再取；正在取的等它取完；没取的现取（不排在预备的队后面）；拿走的不会被别的卡放掉；
//   没取成的抛错（已经拿到的告诉 App 丢掉）；记着字节到手、交给 App 各花了多少、用上了几个预备好的；
// - 用不上了就放掉：这张卡预备好的告诉 App 丢掉，排着的不再取，在取的取完就丢；别的卡也要的留着。
import { describe, expect, test } from "vitest";
import { PageStage, PREFETCH_MAX_BYTES } from "../../src/plugins/browsing/page-stage.ts";
import type { PageCommandFile } from "../../src/state/index.ts";

const file = (i: number, size = 1000): PageCommandFile => ({ token: `t${i}`, name: `头像${i}.png`, mime: "image/png", size, image: true });

/** 等排着的回调都跑完 */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

/** 假的：取字节要手动放行（看得出一次几个），交给 App、丢掉都记下 */
function fakes() {
  const fetching: Array<{ token: string; done: () => void; fail: (reason: string) => void }> = [];
  const put: string[] = [];
  const discarded: string[] = [];
  const logs: string[] = [];
  let clock = 1000;
  const stage = new PageStage({
    fetch: (token) =>
      new Promise((resolve, reject) => {
        fetching.push({ token, done: () => resolve(new TextEncoder().encode(`bytes-${token}`)), fail: (reason) => reject(new Error(reason)) });
      }),
    put: (id) => {
      put.push(id);
      return Promise.resolve(true);
    },
    discard: (ids) => discarded.push(...ids),
    log: (line) => logs.push(line),
    now: () => clock,
  });
  /** 放行正在取的那一个 */
  const finish = async (token: string) => {
    const f = fetching.find((x) => x.token === token);
    if (!f) throw new Error(`没在取 ${token}`);
    clock += 50;
    f.done();
    await settle();
  };
  return { stage, fetching, put, discarded, logs, settle, finish, tick: (ms: number) => (clock += ms) };
}

describe("候选一出来就预备", () => {
  test("推荐的先取，一次一个，取回来交给 App 暂存；超了上限的不预备", async () => {
    const f = fakes();
    // 推荐的 t2 放在前面（page-pick.ts 排好的先后）
    f.stage.prefetch("c-1", [file(2), file(1), file(3), file(4, PREFETCH_MAX_BYTES)]);
    await f.settle();
    expect(f.fetching.map((x) => x.token)).toEqual(["t2"]);
    await f.finish("t2");
    expect(f.put).toHaveLength(1);
    expect(f.fetching.map((x) => x.token)).toEqual(["t2", "t1"]);
    await f.finish("t1");
    await f.finish("t3");
    // 超了上限的 t4 没预备
    expect(f.fetching.map((x) => x.token)).toEqual(["t2", "t1", "t3"]);
    expect(f.put).toHaveLength(3);
  });
});

describe("点了就交", () => {
  test("暂存好的直接用、不再取；正在取的等它取完；没取的现取；记着用上了几个预备好的", async () => {
    const f = fakes();
    f.stage.prefetch("c-1", [file(1), file(2), file(3)]);
    await f.finish("t1");
    // t1 暂存好了，t2 正在取，t3 还排着、t9 没预备
    expect(f.fetching.map((x) => x.token)).toEqual(["t1", "t2"]);
    f.tick(1000);
    const taking = f.stage.take([file(1), file(2), file(9)]);
    await f.settle();
    // 没预备的 t9 现取，不排在 t3 后面
    expect(f.fetching.map((x) => x.token)).toEqual(["t1", "t2", "t9"]);
    await f.finish("t2");
    await f.finish("t9");
    const taken = await taking;
    expect(taken.files.map((s) => s.name)).toEqual(["头像1.png", "头像2.png", "头像9.png"]);
    expect(taken.prestaged).toBe(1);
    // t1 不再取：一共只取过一次
    expect(f.fetching.filter((x) => x.token === "t1")).toHaveLength(1);
    expect(f.put).toHaveLength(3);
    f.stage.logDelivery("挑图片窗口", taken, 30, 300);
    expect(f.logs[0]).toMatch(/^交文件（挑图片窗口）3 个，用上预备好的 1 个：点"交"→字节到手 \d+ms → 交给 App \d+ms → 交进框 30ms，共 300ms$/);
  });

  test("全都预备好了：一个都不取，马上交出来；拿走的不会被放掉", async () => {
    const f = fakes();
    f.stage.prefetch("c-1", [file(1), file(2)]);
    await f.finish("t1");
    await f.finish("t2");
    const taken = await f.stage.take([file(2)]);
    expect(taken).toMatchObject({ prestaged: 1, bytesMs: 0, putMs: 0 });
    expect(f.fetching).toHaveLength(2);
    f.stage.release("c-1");
    // 拿走的 t2 不丢（App 交进框后自己删），没用上的 t1 丢掉
    expect(f.discarded).toEqual([f.put[0]]);
  });

  test("有一个没取成：抛错，已经拿到的告诉 App 丢掉", async () => {
    const f = fakes();
    const taking = f.stage.take([file(1), file(2)]);
    await f.settle();
    await f.finish("t1");
    f.fetching.find((x) => x.token === "t2")!.fail("文件取不到了（取件码过期？）");
    await expect(taking).rejects.toThrow("文件取不到了（取件码过期？）");
    expect(f.discarded).toEqual([f.put[0]]);
  });
});

describe("用不上了就放掉", () => {
  test("这张卡预备好的丢掉，排着的不再取，在取的取完就丢；别的卡也要的留着", async () => {
    const f = fakes();
    f.stage.prefetch("c-1", [file(1), file(2), file(3)]);
    f.stage.prefetch("c-2", [file(1)]);
    await f.finish("t1");
    // t2 正在取，t3 排着
    f.stage.release("c-1");
    // t1 c-2 还要：留着；没有暂存好的要丢
    expect(f.discarded).toEqual([]);
    await f.finish("t2");
    // 取完的 t2 没人要了：丢掉；t3 不再取
    expect(f.discarded).toEqual([f.put[1]]);
    await f.settle();
    expect(f.fetching.map((x) => x.token)).toEqual(["t1", "t2"]);
    f.stage.release("c-2");
    expect(f.discarded).toEqual([f.put[1], f.put[0]]);
    expect(f.stage.owners()).toEqual([]);
  });
});
