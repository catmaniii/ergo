// 发起任务对话框里"事件发生时"的编辑：只能写在运营方案里的来源（项目的服务）这里不列，另外两种照常；万一拿到一个这种来源的值也画得出来、不出错。
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test } from "vitest";
import { defaultEventTrigger, type EventTrigger } from "../../src/state/index.ts";
import { EventTriggerEditor } from "../../src/ui/event-trigger-editor.tsx";

const render = (value: EventTrigger) => renderToStaticMarkup(createElement(EventTriggerEditor, { value, onChange: () => {}, tasks: [], projects: [] }));

describe("事件发生时的编辑", () => {
  test("来源只列二狗内部事件、本机文件夹变化；不列项目的服务", () => {
    const html = render(defaultEventTrigger());
    expect(html).toContain("二狗内部事件");
    expect(html).toContain("本机文件夹变化");
    expect(html).not.toContain("项目的服务");
    expect(html).not.toContain("事件名");
  });

  test("拿到项目的服务这种来源的值也不出错：照登记表画出填事件名的一栏", () => {
    const html = render({ kind: "event", source: "service", events: ["reported"], filter: { name: "评论异常" } });
    expect(html).toContain("事件名");
    expect(html).toContain('value="评论异常"');
  });
});
