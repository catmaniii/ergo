// 日历插件的体检项（414，src/calendar/doctor.ts）"数据源交来的日程"，和内核记的次数（data-sources/service.ts 的 calendarProblems）：
// - 没拿不到过：正常；有数据源现在还拿不到：注意，写哪个数据源、连着几次、最近一次的时间和原因，从这一串开头起；
// - 后来又拿到了：正常，写这次开机以来一共几次；内核按数据源记，拿到一次连着的清零、一共的留着。
// 假内核：日历插件 + 一个会抛错的假数据源（calendar() 由测试拨开关），日历插件要的内核服务给假的。
import { describe, expect, it } from "vitest";
import { externalFinding } from "../../src/calendar/doctor.ts";
import { calendarPlugin } from "../../src/calendar/plugin.ts";
import type { DataSource } from "../../src/data-sources/api.ts";
import type { PluginDefinition } from "../../src/plugins/host.ts";
import { type ExternalCalendars, KERNEL } from "../../src/plugins/kernel.ts";
import { itemOf, kernelDoctor } from "../helpers/plugin-doctor.ts";
import { extraService, type PluginKernel, startPluginKernel } from "../helpers/plugin-kernel.ts";

const problem = (extra: Partial<Parameters<typeof externalFinding>[0][number]> = {}) => ({
  source: "phone-calendar",
  title: "手机 · 日历",
  failures: 2,
  total: 2,
  since: "2026-11-07T08:00:00+08:00",
  at: "2026-11-07T09:00:00+08:00",
  error: "读不了日程",
  ...extra,
});

describe("数据源交来的日程（判法）", () => {
  it("没拿不到过：正常；现在还拿不到：注意（写哪个、几次、原因，从这一串开头起）；后来又拿到了：正常，写一共几次", () => {
    expect(externalFinding([])).toEqual({ level: "ok", fact: { key: "calendar.doctor.external.ok" } });
    const failing = externalFinding([problem(), problem({ source: "google-calendar", title: "Google · 日历", failures: 0, total: 1 })]);
    expect(failing).toMatchObject({ level: "warn", fix: { key: "calendar.doctor.external.fix" }, since: "2026-11-07T08:00:00+08:00", action: { kind: "open", route: "#/more/data-sources" } });
    expect(String(failing.fact.params!.sources)).toMatch(/^「手机 · 日历」连着 2 次拿不到（最近一次 .+：读不了日程）$/);
    expect(externalFinding([problem({ failures: 0, total: 3 })])).toEqual({ level: "ok", fact: { key: "calendar.doctor.external.recovered", params: { count: 3 } } });
  });
});

/** 会抛错的假数据源：交给日历的日程，broken 时抛 */
const flaky = { broken: false };
const flakyPlugin: PluginDefinition = {
  name: "flaky",
  title: "会出错的",
  contracts(ctx) {
    const source: DataSource = {
      id: "flaky",
      title: "会出错的日历",
      usages: { import: { default: true } },
      sync: () => Promise.resolve({ added: 0 }),
      calendar: () => {
        if (flaky.broken) throw new Error("读不了日程");
        return [{ id: "e1", title: "开会", at: "2026-11-07T10:00:00+08:00", allDay: false }];
      },
    };
    ctx.dataSources.register(source);
  },
  setup() {},
};

async function start() {
  let kernel: PluginKernel | undefined;
  const external: ExternalCalendars = {
    events: (from, to) => kernel!.dataSources.calendarEvents(from, to),
    version: () => kernel!.dataSources.calendarVersion(),
    problems: () => kernel!.dataSources.calendarProblems(),
  };
  kernel = await startPluginKernel({
    plugins: [calendarPlugin, flakyPlugin],
    at: new Date("2026-11-07T09:00:00+08:00"),
    services: [
      extraService(KERNEL.externalCalendars, () => external),
      extraService(KERNEL.workdayCalendar, () => ({ current: () => ({}), onChange: () => () => {} }) as never),
      extraService(KERNEL.scheduledJobs, () => ({ calendar: () => [] }) as never),
    ],
  });
  return kernel;
}

describe("体检页上的日历一块", () => {
  it("日历插件登记了这一项；数据源的日程拿不到：内核记下次数，那一项注意；又拿到了：正常，写一共几次", async () => {
    const k = await start();
    expect(k.doctorChecks.list().map((c) => `${c.plugin}:${c.id}`)).toEqual(["calendar:external-events"]);
    const month = () => k.dataSources.calendarEvents(new Date(2026, 10, 1), new Date(2026, 11, 1));
    expect(month()).toHaveLength(1);
    expect(itemOf(await kernelDoctor(k).view(), "calendar", "external-events")).toMatchObject({ level: "ok", text: { title: "数据源交来的日程", fact: "都拿得到" } });

    flaky.broken = true;
    expect(month()).toEqual([]);
    expect(month()).toEqual([]);
    expect(k.dataSources.calendarProblems()).toEqual([{ source: "flaky", title: "会出错的日历", failures: 2, total: 2, since: expect.any(String), at: expect.any(String), error: "读不了日程" }]);
    const broken = itemOf(await kernelDoctor(k).view(), "calendar", "external-events")!;
    expect(broken).toMatchObject({ level: "warn", since: expect.any(String) });
    expect(broken.text.fact).toMatch(/^日历里少了这些日程：「会出错的日历」连着 2 次拿不到（最近一次 .+：读不了日程）$/);

    flaky.broken = false;
    expect(month()).toHaveLength(1);
    expect(k.dataSources.calendarProblems()[0]).toMatchObject({ failures: 0, total: 2 });
    expect(itemOf(await kernelDoctor(k).view(), "calendar", "external-events")).toMatchObject({ level: "ok", text: { fact: "这次开机以来拿不到过 2 次，后来又拿到了" } });
  });
});
