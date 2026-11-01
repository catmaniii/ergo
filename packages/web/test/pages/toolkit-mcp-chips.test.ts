// 工具包区 MCP 那一行（pages/ToolkitEditor.tsx 的 McpChips）：项目自动转的 MCP 在工具包选择里看得到、标明是自动转的；
// 这个项目自己的那个一直在，只显示、不能去掉，也不在"加"的选项里。别的项目、任务照常能加能去。用 React 在 Node 里渲染出来查。
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, test, vi } from "vitest";
import { McpChips } from "../../src/pages/ToolkitEditor.tsx";
import { activeLocale, activeLocaleFrom, type PlanToolkit, setActiveLocale, type ToolkitCatalog, type ToolkitTarget } from "../../src/state/index.ts";
import { TEST_LOCALES } from "../setup-locales.ts";

vi.mock("../../src/app/build-info.ts", () => ({ APP_VERSION: "0.0.0-test", CHANGELOG: "", PAGE_WEB_VERSION: undefined }));

const catalog: ToolkitCatalog = {
  skills: [],
  collections: [],
  mcp: [
    { name: "notes", title: "笔记", tools: [] },
    { name: "project-p-1", title: "记账本", tools: [], auto: { projectId: "p-1", projectName: "记账本" } },
  ],
};
const kit = (mcp: string[] = []): PlanToolkit => ({ skills: [], mcp, bash: false, network: false });
const render = (target: ToolkitTarget, toolkit: PlanToolkit, given: ToolkitCatalog | undefined = catalog) => renderToStaticMarkup(createElement(McpChips, { target, toolkit, catalog: given, onChange: () => {} }));
const zh = activeLocale();
afterEach(() => setActiveLocale(zh));

describe("工具包区的 MCP", () => {
  test("这个项目自己自动转的：一直在，没有去掉的按钮，不在加的选项里", () => {
    const html = render({ kind: "project", projectId: "p-1" }, kit());
    expect(html).toContain("project-p-1：这个项目自动转的，一直在");
    expect(html).not.toContain('aria-label="去掉 MCP project-p-1"');
    expect(html).not.toContain('<option value="project-p-1"');
    expect(html).toContain('<option value="notes"');
  });

  test("工具包里写着自己那个（比如以前加过）：也只显示一次，不能去掉", () => {
    const html = render({ kind: "project", projectId: "p-1" }, kit(["project-p-1"]));
    expect(html.match(/project-p-1/g)).toHaveLength(1);
    expect(html).not.toContain("×");
  });

  test("别的项目、任务：选项里标明是项目自动转的；加进来了能去掉", () => {
    for (const target of [{ kind: "project", projectId: "p-2" }, { kind: "task", taskId: "t-1" }] as ToolkitTarget[]) {
      expect(render(target, kit())).toContain("记账本（project-p-1，项目自动转的）");
      const added = render(target, kit(["project-p-1"]));
      expect(added).toContain("记账本（project-p-1，项目自动转的） ×");
      expect(added).not.toContain('<option value="project-p-1"');
    }
  });

  test("项目不在使用中了：目录里没有它，自己那一行不显示，别人工具包里留着的名字照旧能去掉", () => {
    const gone: ToolkitCatalog = { ...catalog, mcp: catalog.mcp.filter((m) => !m.auto) };
    expect(render({ kind: "project", projectId: "p-1" }, kit(), gone)).not.toContain("project-p-1");
    expect(render({ kind: "project", projectId: "p-2" }, kit(["project-p-1"]), gone)).toContain("project-p-1 ×");
  });

  test("英文也有", () => {
    setActiveLocale(activeLocaleFrom(TEST_LOCALES, "en"));
    expect(render({ kind: "project", projectId: "p-1" }, kit())).toContain("project-p-1: made from this project, always here");
    expect(render({ kind: "project", projectId: "p-2" }, kit())).toContain("记账本 (project-p-1, made from the project)");
  });
});
