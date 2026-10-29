// 项目的服务的入口（133 号票，ui/service-entry.tsx）："打开「X」"按钮、前面的圆点按在不在线换颜色（svc-<kind>），不压缩时后面一句状态；
// 没有网页的只标状态、没有按钮。点了做什么见状态层的 serviceEntryClick（test/state/project-services.test.ts）。用 React 在 Node 里渲染出来查。
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test } from "vitest";
import type { ProjectServiceView } from "../../src/state/index.ts";
import { ServiceEntries, ServiceEntry } from "../../src/ui/service-entry.tsx";
import { ToastProvider } from "../../src/ui/toast.tsx";

const view = (extra: Partial<ProjectServiceView> = {}): ProjectServiceView => ({
  projectId: "p-1",
  key: "web",
  title: "简报站",
  name: "web",
  app: "p-1-web",
  port: 18080,
  autostart: true,
  url: "/apps/p-1-web/",
  rollout: "live",
  status: "online",
  ...extra,
});

const render = (v: ProjectServiceView, compact = false) => renderToStaticMarkup(createElement(ToastProvider, null, createElement(ServiceEntry, { view: v, compact })));

describe("服务的入口", () => {
  test("在线：打开「X」按钮、绿点，后面写在线；压缩的只有按钮", () => {
    const html = render(view());
    expect(html).toContain('class="svc-entry svc-online"');
    expect(html).toContain('<button type="button" class="svc-open" aria-label="打开「简报站」（在线）">');
    expect(html).toContain('<span class="svc-state">在线</span>');
    const compact = render(view(), true);
    expect(compact).toContain("svc-compact");
    expect(compact).not.toContain("svc-state");
    expect(compact).toContain('title="「简报站」在线"');
  });

  test("失败带原因、上线中、要你手动各换颜色；没有网页的没有按钮", () => {
    expect(render(view({ status: "failed", detail: "退出码 1" }))).toContain("svc-failed");
    expect(render(view({ status: "failed", detail: "退出码 1" }))).toContain("失败：退出码 1");
    expect(render(view({ rollout: "pending", status: "unknown" }))).toContain("svc-busy");
    expect(render(view({ rollout: "manual", reason: "LSM 版本不支持名下的服务" }))).toContain("svc-manual");
    const { url: _url, ...noWeb } = view();
    const html = render(noWeb);
    expect(html).not.toContain("<button");
    expect(html).toContain("服务「简报站」");
  });

  test("几个排成一行，没有就什么都不画", () => {
    const two = renderToStaticMarkup(createElement(ToastProvider, null, createElement(ServiceEntries, { views: [view(), view({ key: "api", title: "接口", app: "p-1-api" })] })));
    expect(two.match(/svc-open/g)).toHaveLength(2);
    expect(renderToStaticMarkup(createElement(ToastProvider, null, createElement(ServiceEntries, { views: [] })))).toBe("");
  });
});
