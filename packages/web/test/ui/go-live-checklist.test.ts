// 转运营检查清单（259 号票，ui/cards/cards.tsx 的 GoLiveChecklist）："首版做完了"卡、"转入使用"卡上的一节——每项做到的 ✓、没做到的 ✗
// 写差什么，标题旁的小签写缺几项；还在等时提醒缺的不挡确认，确认过的写照样确认时缺了哪几项。用 React 在 Node 里渲染出来查。
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test } from "vitest";
import type { GoLiveChecklistItem } from "../../src/state/index.ts";
import { GoLiveChecklist } from "../../src/ui/cards/cards.tsx";

const ITEMS: GoLiveChecklistItem[] = [
  { id: "architecture", label: "架构图写清服务和对外接口", done: false, detail: "缺架构图 architecture.md（有服务的项目照开发类要它）" },
  { id: "ops", label: "运营接口清单验收通过（ops.json）", done: false, detail: "缺 ops.json" },
  { id: "services", label: "服务按模板在 LSM 登记（写进运营方案）", done: true, detail: "确认后交给 LSM 登记：「gallery」" },
  { id: "public_entry", label: "要外网的开好 /apps/<项目>/", done: true, detail: "确认后开 /apps/p-photos-gallery/" },
  { id: "progress_written", label: "进展已写回", done: true },
];

const render = (props: Parameters<typeof GoLiveChecklist>[0]) => renderToStaticMarkup(createElement(GoLiveChecklist, props));

describe("转运营检查清单", () => {
  test("还在等：缺几项的小签，每项 ✓ / ✗ 和差什么，提醒缺的不挡确认", () => {
    const html = render({ items: ITEMS, pending: true });
    expect(html).toContain('<span class="chip chip-op">缺 2 项</span>');
    expect(html.match(/golive-item golive-miss/g)).toHaveLength(2);
    expect(html.match(/golive-item golive-ok/g)).toHaveLength(3);
    expect(html).toContain('<span class="golive-label">运营接口清单验收通过（ops.json）</span><span class="golive-detail">缺 ops.json</span>');
    expect(html).toContain("确认后开 /apps/p-photos-gallery/");
    expect(html).toContain("缺的不挡确认：照样确认会写明缺什么，也可以先让维护者补齐。");
  });

  test("都做到了：小签写都做到了，没有提醒；确认过的写照样确认时缺了哪几项", () => {
    const done = ITEMS.map((i) => ({ ...i, done: true }));
    const html = render({ items: done, pending: true });
    expect(html).toContain('<span class="chip chip-ok">都做到了</span>');
    expect(html).not.toContain("缺的不挡确认");
    const confirmed = render({ items: ITEMS, pending: false, missingAtConfirm: ITEMS.filter((i) => !i.done) });
    expect(confirmed).toContain("照样确认时还缺：架构图写清服务和对外接口、运营接口清单验收通过（ops.json）");
    expect(confirmed).not.toContain("缺的不挡确认");
  });
});
