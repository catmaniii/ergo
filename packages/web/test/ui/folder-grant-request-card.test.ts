// agent 自己申请目录授权的卡（464，ui/cards/FolderGrantRequestCard.tsx）。用 React 在 Node 里渲染出来查：
// - 没处理：谁、为什么、目录、要的和多久；已有只读的写"现在只读……这次要加写、删"；授权的文件夹里的写"读本来就行"；
//   下面能收窄：只列它要的那几样（不能加没要的），多久的选项里有申请的天数；「不同意」「同意」；
// - 处理之后：写登记成了什么、附的那句话；没同意的写没同意；按钮和收窄的框都没了；
// - 设置里的一行：它申请、你同意的写明；
// - 状态层的说法：多久的选项（申请的天数插进去）、选项换回天数、已有的几种写法、处理结果。
import { type ComponentProps, createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test, vi } from "vitest";
import type { Connection } from "../../src/app/connection.ts";
import type { DaemonHttp } from "../../src/app/daemon-http.ts";
import { StoreProvider } from "../../src/app/store.tsx";
import {
  type Card,
  type CardState,
  cardWaitsForYou,
  type FolderGrantRequestCardPayload,
  folderGrantRequestDays,
  folderGrantRequestDurations,
  folderGrantRequestExisting,
  folderGrantRequestOutcome,
} from "../../src/state/index.ts";
import { FolderGrantRequestCard } from "../../src/ui/cards/FolderGrantRequestCard.tsx";
import { FolderGrantRows } from "../../src/ui/folder-grants.tsx";

vi.mock("../../src/app/build-info.ts", () => ({ APP_VERSION: "0.0.0-test", CHANGELOG: "", PAGE_WEB_VERSION: undefined }));

const offline = { connection: {} as Connection, http: {} as DaemonHttp } as ComponentProps<typeof StoreProvider>;

const request = (extra: Partial<FolderGrantRequestCardPayload> = {}): FolderGrantRequestCardPayload => ({
  agentId: "pm-1",
  agentLabel: "项目「笔记」的负责人",
  path: "D:\\笔记",
  modes: ["write", "delete"],
  days: 3,
  why: "按书归档",
  ...extra,
});

const cardOf = (p: FolderGrantRequestCardPayload, extra: Partial<Card> = {}): Card =>
  ({ id: "c-1", type: "folder_grant_request", typeVersion: 1, version: 1, status: "pending", payload: p, text: "目录授权申请", createdAt: "2026-11-12T10:00:00+08:00", ...extra }) as Card;

function render(p: FolderGrantRequestCardPayload, extra: Partial<Card> = {}): string {
  const card = cardOf(p, extra);
  const state = { card } as CardState;
  return renderToStaticMarkup(createElement(StoreProvider, offline, createElement(FolderGrantRequestCard, { state, payload: p, done: card.status !== "pending", act: () => {} })));
}

describe("没处理的申请卡", () => {
  test("谁、为什么、目录、要的和多久；已有只读的写这次要加什么；能收窄：只列要的那几样，多久里有申请的天数", () => {
    const html = render(request({ existing: { path: "D:\\笔记", modes: ["read"], expired: false } }));
    expect(html).toContain("项目「笔记」的负责人");
    expect(html).toContain("按书归档");
    expect(html).toContain("D:\\笔记");
    expect(html).toContain("写、删 · 3 天");
    expect(html).toContain("现在只读（长期有效），这次要加写、删");
    // 收窄：只有写、删两个勾（没有读），都勾着
    expect(html.match(/type="checkbox"/g)).toHaveLength(2);
    expect(html).not.toMatch(/checkbox"[^>]*>读</);
    expect(html).toContain('<option value="3" selected="">3 天</option>');
    expect(html).toContain("不同意");
    expect(html).toContain("同意");
    expect(cardWaitsForYou(cardOf(request()))).toBe(true);
  });

  test("授权的文件夹里的写读本来就行；没登记过的没有已有那一行", () => {
    const html = render(request({ modes: ["read", "write"], readable: true }));
    expect(html).toContain("读本来就行");
    expect(html).not.toContain("已有");
  });
});

describe("处理之后", () => {
  test("同意的写登记成了什么和附的那句话；没有按钮和收窄的框", () => {
    const decided = { approved: true, at: "2026-11-12T10:05:00+08:00", note: "先这样", granted: { modes: ["write" as const] }, grant: { modes: ["read" as const, "write" as const] } };
    const html = render(request({ decided }), { status: "handled", outcome: { action: "approve" } });
    expect(html).toContain("已同意，登记成：读、写 · 长期有效（先这样）");
    expect(html).not.toContain("checkbox");
    expect(html).not.toContain("<button");
    expect(cardWaitsForYou(cardOf(request({ decided }), { status: "handled" }))).toBe(false);
  });

  test("没同意的写没同意", () => {
    const html = render(request({ decided: { approved: false, at: "2026-11-12T10:05:00+08:00", note: "别删" } }), { status: "handled", outcome: { action: "deny", note: "别删" } });
    expect(html).toContain("没同意：别删");
  });
});

describe("设置里的一行", () => {
  test("它申请、你同意的写明", () => {
    const html = renderToStaticMarkup(
      createElement(FolderGrantRows, {
        grants: [{ id: "fg-1", agentId: "secretary", path: "D:\\课件", modes: ["read", "write"], note: "整理课件", addedBy: "request", addedAt: "2026-11-12T10:05:00.000+08:00", state: "active" }],
        busy: false,
      }),
    );
    expect(html).toContain("它申请、你在 2026-11-12 10:05 同意的");
  });
});

describe("状态层的说法", () => {
  test("多久的选项：申请的天数不在常用的里就按长短插进去；选项换回天数（长期有效是 null）", () => {
    expect(folderGrantRequestDurations(undefined)).toEqual(["forever", "1", "7", "30", "90"]);
    expect(folderGrantRequestDurations(7)).toEqual(["forever", "1", "7", "30", "90"]);
    expect(folderGrantRequestDurations(3)).toEqual(["forever", "1", "3", "7", "30", "90"]);
    expect(folderGrantRequestDurations(365)).toEqual(["forever", "1", "7", "30", "90", "365"]);
    expect(folderGrantRequestDays("forever")).toBeNull();
    expect(folderGrantRequestDays("3")).toBe(3);
  });

  test("已有的几种写法：同一个目录、上级目录、已过期；没有的是 undefined", () => {
    expect(folderGrantRequestExisting(request())).toBeUndefined();
    expect(folderGrantRequestExisting(request({ existing: { path: "d:/笔记/", modes: ["read", "write", "delete"], expiresAt: "2026-12-01T23:59:00.000+08:00", expired: false } }))).toBe("现在已有读、写、删（到 2026-12-01 23:59）");
    expect(folderGrantRequestExisting(request({ path: "D:\\笔记\\书", existing: { path: "D:\\笔记", modes: ["read"], expired: false } }))).toBe("上级目录 D:\\笔记 已登记只读（长期有效）");
    expect(folderGrantRequestExisting(request({ existing: { path: "D:\\笔记", modes: ["read"], expiresAt: "2026-10-31T00:00:00.000+08:00", expired: true } }))).toBe("以前登记过只读，2026-10-31 00:00 已过期");
  });

  test("处理结果：没处理的没有", () => {
    expect(folderGrantRequestOutcome(request())).toBeUndefined();
    expect(folderGrantRequestOutcome(request({ decided: { approved: true, at: "x", grant: { modes: ["read"], expiresAt: "2026-11-15T23:59:00.000+08:00" } } }))).toBe("已同意，登记成：只读 · 到 2026-11-15 23:59");
    expect(folderGrantRequestOutcome(request({ decided: { approved: false, at: "x" } }))).toBe("没同意，没有登记");
  });
});
