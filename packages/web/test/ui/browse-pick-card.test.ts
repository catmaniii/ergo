// 网页候选卡（147 号票，ui/cards/BrowsePickCard.tsx）：秘书在浏览侧边栏里替选中的上传框找文件、拿不准时放进会话的候选。用 React 在 Node 里渲染出来查：
// - 单张的框：一组单选（radio），秘书推荐的预先选上（只取一个），按钮写"交"；多张的框：勾选框，按钮写"交 N 个"，一个没选时灰掉；都有"都不要"；
// - 处理完了：格子里标着选了哪几个、都停用，没有按钮，写处理结果；
// - 点一张（state/browse.ts 的 togglePick）：单张的框换选这一张，多张的框勾上或取消，按候选的先后排；不是候选里的不认；
// - 149 号票：缩略图是守护进程缩好的小图（/api/page-files/<取件码>/thumb），不下原图；点了"交"没交进去，原因记在卡上、还能再点。
import { type ComponentProps, createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test, vi } from "vitest";
import type { Connection } from "../../src/app/connection.ts";
import type { DaemonHttp } from "../../src/app/daemon-http.ts";
import { StoreProvider } from "../../src/app/store.tsx";
import { type BrowsePickCardPayload, type Card, type CardState, initialPick, togglePick } from "../../src/state/index.ts";
import { BrowsePickCard } from "../../src/plugins/browsing/BrowsePickCard.tsx";

vi.mock("../../src/app/build-info.ts", () => ({ APP_VERSION: "0.0.0-test", CHANGELOG: "", PAGE_WEB_VERSION: undefined }));

const offline = {
  connection: {} as Connection,
  http: { pageFileUrl: (token: string) => `/api/page-files/${token}`, pageFileThumbUrl: (token: string) => `/api/page-files/${token}/thumb` } as DaemonHttp,
} as ComponentProps<typeof StoreProvider>;

function payload(multiple: boolean, extra: Partial<BrowsePickCardPayload> = {}): BrowsePickCardPayload {
  return {
    page: { title: "报名 · 示例", url: "https://form.example.cn/apply" },
    field: "「上传头像」（上传框）",
    fieldId: "f5",
    browser: "b-0123456789abcdef",
    multiple,
    files: [
      { token: "t1", name: "头像1.png", mime: "image/png", size: 2000, image: true },
      { token: "t2", name: "头像2.png", mime: "image/png", size: 2000, image: true },
      { token: "t3", name: "简历.pdf", mime: "application/pdf", size: 9000, image: false },
    ],
    recommended: ["t2", "t1"],
    expiresAt: "2026-10-18T10:15:00+08:00",
    ...extra,
  };
}

function state(p: BrowsePickCardPayload, status: Card["status"] = "pending", outcome?: Card["outcome"]): CardState {
  return { card: { id: "c-1", type: "browse_pick", typeVersion: 1, version: status === "pending" ? 1 : 2, status, payload: p, text: "候选", createdAt: "2026-10-18T10:00:00+08:00", ...(outcome ? { outcome } : {}) } };
}

const render = (p: BrowsePickCardPayload, status: Card["status"] = "pending", outcome?: Card["outcome"]) =>
  renderToStaticMarkup(createElement(StoreProvider, offline, createElement(BrowsePickCard, { state: state(p, status, outcome), payload: p, done: status !== "pending", act: () => {} })));

function buttonWith(html: string, text: string): string {
  const at = html.indexOf(`>${text}</button>`);
  expect(at, `找不到按钮「${text}」`).toBeGreaterThan(-1);
  return html.slice(html.lastIndexOf("<button", at), at + 1);
}

describe("网页候选卡", () => {
  test("单张的框：一组单选，推荐的只预先选上一个，按钮写交；有都不要；缩略图是守护进程缩好的小图（凭取件码），不是图片的画名字", () => {
    const html = render(payload(false, { recommended: ["t2"] }));
    expect(html).toContain("网页「报名 · 示例」上 「上传头像」（上传框）");
    expect(html).toContain('role="radiogroup"');
    expect(html.match(/role="radio"/g)).toHaveLength(3);
    expect(html).toMatch(/<button[^>]*role="radio"[^>]*aria-checked="false"[^>]*title="头像1\.png/);
    expect(html).toMatch(/<button[^>]*role="radio"[^>]*aria-checked="true"[^>]*title="头像2\.png/);
    expect(html).toContain('src="/api/page-files/t1/thumb"');
    expect(html).not.toContain('src="/api/page-files/t1"');
    expect(html).toContain("简历.pdf</span>");
    expect(buttonWith(html, "交")).not.toContain("disabled");
    expect(buttonWith(html, "都不要")).not.toContain("disabled");
  });

  test("多张的框：每张能勾，推荐的都选上，按钮写交 N 个；一个没选时灰掉", () => {
    const html = render(payload(true));
    expect(html).toContain('role="group"');
    expect(html.match(/role="checkbox"/g)).toHaveLength(3);
    expect(buttonWith(html, "交 2 个")).not.toContain("disabled");
    expect(buttonWith(render(payload(true, { recommended: [] })), "交 0 个")).toContain("disabled");
  });

  test("处理完了：标着选了哪几个、都停用，没有按钮，写处理结果", () => {
    const html = render(payload(false, { picked: ["t3"], delivered: 1 }), "handled", { action: "confirm", note: "选了 1 个，交进去了 1 个" });
    expect(html).toMatch(/<button[^>]*aria-checked="true"[^>]*title="简历\.pdf[^>]*disabled/);
    expect(html).toMatch(/<button[^>]*aria-checked="false"[^>]*title="头像2\.png/);
    expect(html).not.toContain(">都不要</button>");
    expect(html).toContain("选了 1 个，交进去了 1 个");
  });

  test("没交进去（149 号票）：原因写在卡上（网页上的挑图片窗口里点的也一样），还能再点交", () => {
    const html = render(payload(false, { recommended: ["t1"], failed: "没交进去：浏览器已经换了网页，原来的上传框不在了" }));
    expect(html).toContain('class="xcard-pick-note failed"');
    expect(html).toContain("没交进去：浏览器已经换了网页，原来的上传框不在了（可以再点交）");
    expect(buttonWith(html, "交")).not.toContain("disabled");
  });

  test("点一张：单张的框换选这一张，多张的框勾上或取消，按候选的先后排；不是候选里的不认", () => {
    const order = ["t1", "t2", "t3"];
    expect(togglePick(["t2"], "t3", false, order)).toEqual(["t3"]);
    expect(togglePick(["t3"], "t1", true, order)).toEqual(["t1", "t3"]);
    expect(togglePick(["t1", "t3"], "t1", true, order)).toEqual(["t3"]);
    expect(togglePick(["t1"], "x", true, order)).toEqual(["t1"]);
    expect(initialPick(payload(false))).toEqual(["t1"]);
    expect(initialPick(payload(true))).toEqual(["t1", "t2"]);
  });
});
