// 项目的"运营概况"（140 号票，ui/operations-summary.tsx）怎么画、怎么点：用 React 在 Node 里渲染出来查，点的那几处直接拿到元素调它的 onClick。
// - 收起：一行写清几条、各几点，右边一个展开钮；展开：每条一行（名字、时间表、下次、上次和结果、状态），点一行进任务整页；
// - 没有定时任务的没有那一行、没有服务的没有入口；暂停了的标"已暂停"，上次失败的标出来；
// - 服务：截过图的前面一张缩略图（不在线的灰掉、标"不在线"），上线了还没图的只悄悄取一次（藏着），截不了的只有入口；
// - 项目卡整张能点开项目：展开钮、一行行的链接、缩略图都不往外冒；
// - 257 号票：使用中、有在 LSM 上的服务的，服务前面一行开关——现在怎样和“启动”“关闭”两个按钮（不能点的灰掉，点了不往外冒）；
//   关闭的确认框写清关几个服务、一直关着（取消开机自启）、不是停用。
import { createElement, isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test, vi } from "vitest";
import { type OperationsSummary, type ProjectServiceView, serviceEntryView, type SummaryService, type SummaryTimedTask } from "../../src/state/index.ts";
import { OperationsSummaryBody, StopServicesConfirm, type SummarySize } from "../../src/ui/operations-summary.tsx";
import { ToastProvider } from "../../src/ui/toast.tsx";

const view = (extra: Partial<ProjectServiceView> = {}): ProjectServiceView => ({
  projectId: "p-1",
  key: "site",
  title: "简报站",
  name: "site",
  app: "p-1-site",
  port: 18080,
  autostart: true,
  url: "/apps/p-1-site/",
  rollout: "live",
  status: "online",
  thumbnailAt: "2026-10-18T08:00:00.000+08:00",
  ...extra,
});

const service = (extra: Partial<ProjectServiceView> = {}, more: Partial<SummaryService> = {}): SummaryService => {
  const v = view(extra);
  return { view: v, entry: serviceEntryView(v), thumbnail: { kind: "shot", at: v.thumbnailAt ?? "" }, ...more };
};

const daily: SummaryTimedTask = {
  jobId: "j-1",
  taskId: "t-2",
  name: "日报",
  scheduleText: "每天 08:00",
  brief: "每天 08:00 日报",
  nextAt: "2026-10-19T08:00:00.000+08:00",
  last: { at: "2026-10-18T08:03:00.000+08:00", text: "成功", failed: false },
  status: "active",
  statusText: "运营中",
};
const weekly: SummaryTimedTask = { jobId: "j-2", taskId: "t-3", name: "周报", scheduleText: "每周日 18:00", brief: "每周日 18:00 周报（已暂停）", last: { at: "2026-10-11T18:04:00.000+08:00", text: "失败", failed: true }, status: "paused", statusText: "已暂停" };

const summary = (extra: Partial<OperationsSummary> = {}): OperationsSummary => ({
  services: [service()],
  timed: [daily, weekly],
  line: "2 个定时任务：每天 08:00 日报、每周日 18:00 周报（已暂停）",
  ...extra,
});

const props = (s: OperationsSummary, open = false, size: SummarySize = "card") => ({
  summary: s,
  size,
  open,
  onToggle: vi.fn<() => void>(),
  thumbnailSrc: (x: SummaryService) => (x.thumbnail ? `/thumb/${x.view.app}` : undefined),
  onOpenService: vi.fn<(s: SummaryService) => void>(),
  onPower: vi.fn<(action: "start" | "stop") => void>(),
});

const render = (p: ReturnType<typeof props>) => renderToStaticMarkup(createElement(ToastProvider, null, createElement(OperationsSummaryBody, p)));

/** 画出来的元素树里（不展开别的组件）按条件找元素 */
function find(node: ReactNode, match: (el: ReactElement<Record<string, unknown>>) => boolean): Array<ReactElement<Record<string, unknown>>> {
  const out: Array<ReactElement<Record<string, unknown>>> = [];
  const visit = (n: ReactNode): void => {
    if (Array.isArray(n)) return n.forEach(visit);
    if (!isValidElement<Record<string, unknown>>(n)) return;
    if (match(n)) out.push(n);
    visit(n.props.children as ReactNode);
  };
  visit(node);
  return out;
}

const fakeEvent = () => ({ stopPropagation: vi.fn<() => void>(), preventDefault: vi.fn<() => void>() });

describe("运营概况", () => {
  test("收起：一行写清几条、各几点，右边一个展开钮（▾）；不画每条", () => {
    const html = render(props(summary()));
    expect(html).toContain('<span class="ops-sum-text">2 个定时任务：每天 08:00 日报、每周日 18:00 周报（已暂停）</span>');
    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain("▾");
    expect(html).not.toContain("ops-sum-rows");
  });

  test("展开：每条一行——名字、时间表、下次、上次和结果、状态；点一行进任务整页；暂停了的标“已暂停”，上次失败的标出来", () => {
    const html = render(props(summary(), true));
    expect(html).toContain('aria-expanded="true"');
    expect(html.match(/<li class="ops-sum-row/g)).toHaveLength(2);
    expect(html).toContain('<a class="ops-sum-row-in" href="#/tasks/t-2"><b class="ops-sum-name">日报</b><span class="ops-sum-when">每天 08:00</span><span class="ops-sum-next">下次 10-19 08:00</span><span class="ops-sum-last">上次 10-18 08:03 成功</span><span class="st st-ops">运营中</span></a>');
    expect(html).toContain('<span class="ops-sum-next">下次 —</span><span class="ops-sum-last ops-sum-failed">上次 10-11 18:04 失败</span><span class="st st-paused">已暂停</span>');
  });

  test("上次部分完成的（176 号票）单独一种颜色，不标红", () => {
    const partial: SummaryTimedTask = { ...daily, last: { at: "2026-10-18T08:12:00.000+08:00", text: "部分完成", failed: false, partial: true } };
    const html = render(props(summary({ timed: [partial] }), true));
    expect(html).toContain('<span class="ops-sum-last ops-sum-partial">上次 10-18 08:12 部分完成</span>');
  });

  test("没有定时任务的没有那一行；没有服务的没有入口和缩略图", () => {
    const noTimed = render(props(summary({ timed: [], line: undefined })));
    expect(noTimed).not.toContain("ops-sum-timed");
    expect(noTimed).toContain("打开「简报站」");
    const noServices = render(props(summary({ services: [] })));
    expect(noServices).not.toContain("ops-svc");
    expect(noServices).not.toContain("svc-open");
    expect(noServices).toContain("ops-sum-text");
  });

  test("服务：缩略图在入口前面（点了用内置浏览器打开）；不在线的灰掉、标“不在线”；上线了还没图的只悄悄取一次；截不了的只有入口；停用了的整块标出来", () => {
    const html = render(props(summary()));
    expect(html).toContain('<button type="button" class="ops-thumb" aria-label="打开「简报站」（首页缩略图）" title="打开「简报站」"><img src="/thumb/p-1-site" alt="" loading="lazy" decoding="async"/></button>');
    expect(html.indexOf("ops-thumb")).toBeLessThan(html.indexOf("svc-open"));
    const offline = render(props(summary({ services: [service({ status: "failed" }, { dim: "不在线" })] })));
    expect(offline).toContain('class="ops-thumb ops-thumb-dim"');
    expect(offline).toContain('<span class="ops-thumb-tag">不在线</span>');
    const probe = render(props(summary({ services: [service({ thumbnailAt: undefined }, { thumbnail: { kind: "probe" } })] })));
    expect(probe).toContain('<img class="ops-thumb-probe" src="/thumb/p-1-site" alt="" hidden=""/>');
    expect(probe).not.toContain('class="ops-thumb"');
    const none = render(props(summary({ services: [service({ thumbnailAt: undefined }, { thumbnail: undefined })] })));
    expect(none).not.toContain("<img");
    expect(none).toContain("打开「简报站」");
    const stopped = render(props(summary({ stopped: "已停用", services: [service({ rollout: "withdrawn" }, { dim: "已停用" })] })));
    expect(stopped).toContain('<span class="ops-sum-stopped-tag">已停用</span>');
    expect(stopped).toContain('<span class="ops-thumb-tag">已停用</span>');
  });

  test("点展开钮：展开 / 收起，不往外冒（项目卡整张能点开项目）；点一行、点缩略图同样不往外冒，缩略图打开服务", () => {
    const p = props(summary(), true);
    const tree = OperationsSummaryBody(p);
    const [toggle] = find(tree, (el) => el.type === "button" && el.props.className === "ops-sum-toggle");
    const e = fakeEvent();
    (toggle!.props.onClick as (event: unknown) => void)(e);
    expect(e.stopPropagation).toHaveBeenCalled();
    expect(p.onToggle).toHaveBeenCalledTimes(1);

    const [row] = find(tree, (el) => el.type === "a" && el.props.className === "ops-sum-row-in");
    const r = fakeEvent();
    (row!.props.onClick as (event: unknown) => void)(r);
    expect(r.stopPropagation).toHaveBeenCalled();
    expect(r.preventDefault).not.toHaveBeenCalled();

    const [thumb] = find(tree, (el) => el.type === "button" && el.props.className === "ops-thumb");
    const t = fakeEvent();
    (thumb!.props.onClick as (event: unknown) => void)(t);
    expect(t.stopPropagation).toHaveBeenCalled();
    expect(p.onOpenService).toHaveBeenCalledWith(p.summary.services[0]);
  });
});

describe("服务的“启动”“关闭”（257 号票）", () => {
  test("有开关的在服务前面画一行：现在怎样和两个按钮，不能点的灰掉；失败的写原因；LSM 没连上的两个都灰掉、写原因；没有开关的不画", () => {
    const online = render(props(summary({ power: { state: "online", text: "在线", canStart: false, canStop: true } })));
    expect(online).toContain('<div class="ops-power ops-power-online">');
    expect(online).toContain('<span class="ops-power-text">在线</span>');
    expect(online).toContain('<button type="button" class="btn ghost small ops-power-start" disabled="">启动</button>');
    expect(online).toContain('<button type="button" class="btn ghost small ops-power-stop">关闭</button>');
    expect(online.indexOf("ops-power")).toBeLessThan(online.indexOf("ops-svc"));
    const off = render(props(summary({ power: { state: "off", text: "已关闭", canStart: true, canStop: false } })));
    expect(off).toContain('<button type="button" class="btn ghost small ops-power-start">启动</button>');
    expect(off).toContain('<button type="button" class="btn ghost small ops-power-stop" disabled="">关闭</button>');
    const failed = render(props(summary({ power: { state: "failed", text: "失败", detail: "端口 18080 已被占用", canStart: true, canStop: true } })));
    expect(failed).toContain('<span class="ops-power-detail">端口 18080 已被占用</span>');
    const blocked = render(props(summary({ power: { state: "unknown", text: "状态未知", canStart: false, canStop: false, blocked: "LSM 没连上，现在启动、关闭不了" } })));
    expect(blocked.match(/disabled=""/g)).toHaveLength(2);
    expect(blocked).toContain('<span class="ops-power-blocked">LSM 没连上，现在启动、关闭不了</span>');
    expect(render(props(summary()))).not.toContain("ops-power");
  });

  test("点“启动”“关闭”：交给 onPower，不往外冒（项目卡整张能点开项目）", () => {
    const p = props(summary({ power: { state: "failed", text: "失败", canStart: true, canStop: true } }));
    const tree = OperationsSummaryBody(p);
    const [start] = find(tree, (el) => el.type === "button" && String(el.props.className).includes("ops-power-start"));
    const [stop] = find(tree, (el) => el.type === "button" && String(el.props.className).includes("ops-power-stop"));
    const a = fakeEvent();
    (start!.props.onClick as (event: unknown) => void)(a);
    expect(a.stopPropagation).toHaveBeenCalled();
    expect(p.onPower).toHaveBeenLastCalledWith("start");
    const b = fakeEvent();
    (stop!.props.onClick as (event: unknown) => void)(b);
    expect(b.stopPropagation).toHaveBeenCalled();
    expect(p.onPower).toHaveBeenLastCalledWith("stop");
  });

  test("关闭的确认框：写清关几个服务、一直关着（取消开机自启，重启后也不起来）、不是停用；“先不关”“关闭”", () => {
    const onCancel = vi.fn<() => void>();
    const onConfirm = vi.fn<() => void>();
    const html = renderToStaticMarkup(createElement(StopServicesConfirm, { projectName: "家庭菜谱", services: ["菜谱网页", "菜谱接口"], onCancel, onConfirm }));
    expect(html).toContain("关闭「家庭菜谱」的服务？");
    expect(html).toContain("会经 LSM 把这个项目的 2 个服务（菜谱网页、菜谱接口）全部停掉，并取消开机自启：二狗或电脑重启后也不会自己起来，直到你再点“启动”。");
    expect(html).toContain("这不是停用：项目照旧使用中，定时任务照常。");
    expect(html).toContain('<button type="button" class="btn ghost">先不关</button>');
    expect(html).toContain('<button type="button" class="btn danger">关闭</button>');
  });
});
