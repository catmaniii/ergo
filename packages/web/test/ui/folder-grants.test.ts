// 目录授权在网页上（ADR-0049）。用 React 在 Node 里渲染出来查：
// - 审批卡：带着 folderGrant 的多一个"以后都允许（登记这个目录）"，写明会登记哪个目录、哪几种操作；没带的没有；
// - 一行一条授权：目录、操作（只读 / 读、写、删）、到期（没写到期的醒目地写"长期有效"，过期的标"已过期"）、为什么给、谁加的；
// - 状态层的说法：操作、到期、按 agent 分组（个人助理在前）、选的有效期换成到期时间。
import { type ComponentProps, createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test, vi } from "vitest";
import type { Connection } from "../../src/app/connection.ts";
import type { DaemonHttp } from "../../src/app/daemon-http.ts";
import { StoreProvider } from "../../src/app/store.tsx";
import {
  type ApprovalCardPayload,
  type Card,
  type CardState,
  folderGrantExpiresAt,
  folderGrantExpiry,
  folderGrantGroups,
  folderGrantModesText,
  type FolderGrantView,
} from "../../src/state/index.ts";
import { ApprovalCard } from "../../src/ui/cards/cards.tsx";
import { FolderGrantRows } from "../../src/ui/folder-grants.tsx";

vi.mock("../../src/app/build-info.ts", () => ({ APP_VERSION: "0.0.0-test", CHANGELOG: "", PAGE_WEB_VERSION: undefined }));

const offline = { connection: {} as Connection, http: {} as DaemonHttp } as ComponentProps<typeof StoreProvider>;

const approval = (extra: Partial<ApprovalCardPayload> = {}): ApprovalCardPayload => ({
  approvalId: "a-1",
  source: "对话",
  tool: "write",
  toolTitle: "写文件",
  argsSummary: "D:\\笔记\\b.txt",
  categoryTitles: ["越出项目目录"],
  reason: "写文件要写 D:\\笔记\\b.txt",
  ...extra,
});

function renderCard(p: ApprovalCardPayload, act: (action: string) => void = () => {}): string {
  const state = { card: { id: "c-1", type: "approval", typeVersion: 1, version: 1, status: "pending", payload: p, text: "审批", createdAt: "2026-11-03T10:00:00+08:00" } as Card } as CardState;
  return renderToStaticMarkup(createElement(StoreProvider, offline, createElement(ApprovalCard, { state, payload: p, done: false, act })));
}

const grant = (extra: Partial<FolderGrantView> = {}): FolderGrantView => ({
  id: "fg-1",
  agentId: "secretary",
  path: "D:\\笔记",
  modes: ["read"],
  note: "整理读书笔记",
  addedBy: "user",
  addedAt: "2026-10-20T09:00:00.000+08:00",
  state: "active",
  ...extra,
});

describe("审批卡上的以后都允许", () => {
  test("带着要登记的目录：多一个按钮，写明登记哪个目录、哪几种操作", () => {
    const html = renderCard(approval({ folderGrant: { path: "D:\\笔记", modes: ["write"] } }));
    expect(html).toContain("以后都允许（登记这个目录）");
    expect(html).toContain("D:\\笔记");
    expect(html).toContain("长期目录授权（写）");
    expect(html).toContain("批准这一次");
  });

  test("没带的没有这个按钮", () => {
    expect(renderCard(approval())).not.toContain("以后都允许");
  });
});

describe("一行一条授权", () => {
  test("长期有效醒目，只读写成只读；为什么给、谁加的", () => {
    const html = renderToStaticMarkup(createElement(FolderGrantRows, { grants: [grant()], busy: false, onRemove: () => {} }));
    expect(html).toContain("D:\\笔记");
    expect(html).toContain("只读");
    expect(html).toMatch(/af-tag-warn fg-forever">长期有效</);
    expect(html).toContain("整理读书笔记");
    expect(html).toContain("你在 2026-10-20 09:00 加的");
    expect(html).toContain("删掉 D:\\笔记 的授权");
  });

  test("过期的标已过期；审批卡上登记的写明；没给 onRemove 的没有叉", () => {
    const html = renderToStaticMarkup(
      createElement(FolderGrantRows, { grants: [grant({ modes: ["read", "delete"], expiresAt: "2026-10-31T00:00:00.000+08:00", state: "expired", addedBy: "approval" })], busy: false }),
    );
    expect(html).toContain("读、删");
    expect(html).toContain("已过期（2026-10-31 00:00）");
    expect(html).toContain("在审批卡上点了");
    expect(html).not.toContain("af-remove");
  });
});

describe("状态层的说法", () => {
  test("操作、到期、分组、选的有效期", () => {
    expect(folderGrantModesText(["delete", "read"])).toBe("读、删");
    expect(folderGrantModesText(["read"])).toBe("只读");
    expect(folderGrantExpiry(grant({ expiresAt: "2026-11-08T18:00:00.000+08:00" }))).toEqual({ text: "到 2026-11-08 18:00", tone: "until" });
    expect(folderGrantExpiry(grant()).tone).toBe("forever");
    const groups = folderGrantGroups({ grants: [grant({ id: "a", agentId: "pm-1" }), grant({ id: "b" }), grant({ id: "c", agentId: "pm-1" })], authorizedFolders: [] });
    expect(groups.map((g) => [g.agentId, g.grants.map((x) => x.id)])).toEqual([
      ["secretary", ["b"]],
      ["pm-1", ["a", "c"]],
    ]);
    expect(folderGrantExpiresAt("forever", Date.now())).toBeUndefined();
    const week = Date.parse(folderGrantExpiresAt("7", Date.UTC(2026, 10, 3, 4))!);
    expect(week).toBeGreaterThan(Date.UTC(2026, 10, 9));
    expect(week).toBeLessThan(Date.UTC(2026, 10, 11));
  });
});
