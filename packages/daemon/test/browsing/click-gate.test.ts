// browse_click 的两档文案闸门（184 号票，texts.ts 的 clickGateOf）：
// - 带 confirm 才点：种类是 submit 的、字面上像提交、运行、生成、确认的（中英文，英文按整个词）；主会话 2026-10-20 定："确定""OK"
//   和"确认"同一类，也要 confirm；表单的提交按钮里字是搜索、查询、查找、Search、Go 这类的不用 confirm；
// - 带了 confirm 也不点：支付、付款、购买、下单、删除、清空、发布、注销、解绑，"提交订单""确认订单""结算"（主会话 2026-10-20 定），
//   英文 pay、buy、checkout、delete、publish 这类（不放 remove）。
import { describe, expect, it } from "vitest";
import { clickGateOf } from "../../src/browsing/texts.ts";

const gate = (text: string, role: "button" | "submit" | "link" = "button") => clickGateOf({ role, text });

describe("browse_click 的两档闸门（184 号票）", () => {
  it("带了 confirm 也不点：会花钱、删东西、发出去的（中英文）；提交订单、确认订单、结算算这一档；remove 不算", () => {
    for (const text of ["立即支付", "付款", "立即购买", "下单", "提交订单", "确认订单", "去结算", "删除项目", "清空购物车", "发布", "注销账号", "解绑手机"]) expect(gate(text)).toBe("never");
    for (const text of ["Pay now", "Buy", "Checkout", "Place order", "Delete project", "Publish", "Sign out", "Unbind"]) expect(gate(text)).toBe("never");
    // 种类是 submit 的也一样（不会因为是搜索样子的提交按钮就放行）
    expect(gate("提交订单", "submit")).toBe("never");
    expect(gate("Remove background")).toBeUndefined();
  });

  it("带 confirm 才点：提交、运行、生成、确认，确定、OK（主会话 2026-10-20 定），英文按整个词", () => {
    for (const text of ["提交", "立即运行", "开始生成", "确认", "确定", "Submit", "Run", "Run now", "Regenerate", "Generate image", "Confirm", "OK", "Ok"]) expect(gate(text)).toBe("confirm");
    for (const text of ["RunningHub 首页", "Generated images", "Okay so", "Book", "下一页"]) expect(gate(text)).toBeUndefined();
  });

  it("表单的提交按钮：字是搜索、查询、查找、Search、Go 这类的不用 confirm（主会话 2026-10-20 定），别的照旧要 confirm", () => {
    for (const text of ["搜索", "查询", "查找", "Search", "Go", "go", "搜索商品"]) expect(gate(text, "submit")).toBeUndefined();
    for (const text of ["下一步", "保存", "", "提交查询", "Go and submit"]) expect(gate(text, "submit")).toBe("confirm");
    // 不是提交按钮的"搜索"本来就直接点
    expect(gate("搜索")).toBeUndefined();
  });
});
