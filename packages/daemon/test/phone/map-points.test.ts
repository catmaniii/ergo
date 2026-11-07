// "手机"插件给地图插件的两样（432）：起了名的常去的地方、最近交来的一个位置点（查"从家到公司""附近"时用）。
// 只给这两样，不给轨迹；还没起名、还没交来过位置时是空的、undefined。
import { nowIso, PHONE_LOCATION_SOURCE } from "@ergo/protocol";
import { describe, expect, it } from "vitest";
import { dataDirLayout } from "../../src/config/data-dir.ts";
import { PHONE } from "../../src/phone/api.ts";
import { phonePlugin } from "../../src/phone/plugin.ts";
import { KERNEL } from "../../src/plugins/kernel.ts";
import { extraService, startPluginKernel } from "../helpers/plugin-kernel.ts";

let seq = 0;
const key = () => `mp-${++seq}`;
const day = (d: number, hh: number, mm = 0) => nowIso(new Date(2026, 9, d, hh, mm));

/** 假的个人档案（手机插件要它，这里用不到） */
const files = {
  people: () => [],
  background: () => "",
  withheld: () => [],
  onFieldReplaced: () => () => {},
  replacedValues: () => [],
  addCandidates: () => 0,
  composeCandidates: () => undefined,
};

describe("手机插件给地图的：常去的地方、最近一个位置点", () => {
  it("没起名、没交来过位置时是空的；起了名、交来了以后给名字、中心、范围、系统地名和时间最晚的那一个点", async () => {
    const k = await startPluginKernel({
      plugins: [phonePlugin],
      at: new Date(2026, 9, 27, 9),
      services: [extraService(KERNEL.personalFiles, () => files as never), extraService(KERNEL.layout, ({ dir }) => dataDirLayout(dir))],
    });
    const phone = k.host.service(PHONE)!;
    expect(phone.namedPlaces()).toEqual([]);
    expect(phone.latestPoint()).toBeUndefined();
    await k.dataSources.act(PHONE_LOCATION_SOURCE, { action: "configure", values: { places: "add", name: "家", lat: "30.28", lon: "120.1", address: "杭州市西湖区示例路" }, idempotencyKey: key() });
    await k.dataSources.act(PHONE_LOCATION_SOURCE, { action: "configure", values: { places: "add", name: "公司", lat: "30.26", lon: "120.13", radius: "300" }, idempotencyKey: key() });
    expect(phone.namedPlaces().map(({ id: _id, ...rest }) => rest)).toEqual([
      { name: "家", lat: 30.28, lon: 120.1, radius: 200, address: "杭州市西湖区示例路" },
      { name: "公司", lat: 30.26, lon: 120.13, radius: 300 },
    ]);
    await k.dataSources.push(PHONE_LOCATION_SOURCE, {
      data: {
        state: "granted",
        link: true,
        background: false,
        points: [
          { at: day(25, 9, 0), lat: 30.259, lon: 120.13, accuracy: 50 },
          { at: day(26, 8, 30), lat: 30.2741, lon: 120.1551, accuracy: 20 },
          { at: day(26, 8, 0), lat: 30.28, lon: 120.1 },
        ],
      },
      idempotencyKey: key(),
    });
    expect(phone.latestPoint()).toEqual({ lat: 30.2741, lon: 120.1551, at: day(26, 8, 30), acc: 20 });
  });
});
