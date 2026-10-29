// 我的名字（249 号票）：用户**自己**的名字。起名的规矩照个人助理的名字（43 号票）那一条，
// 设置接口 GET/PUT /api/user-name 的路径也在协议包里（守护进程和网页都从这儿取）。
import { describe, expect, it } from "vitest";
import { checkUserName, HTTP_PATHS, parseHttpPath, USER_NAME_MAX } from "../src/index.ts";

describe("我的名字：规矩和给助理起的名字一样", () => {
  it.each<[string, string]>([
    ["小明", "小明"],
    ["  小明 ", "小明"],
    ["小文", "小文"],
    ["一二三四五六七八", "一二三四五六七八"],
    ["Jarvis", "Jarvis"],
    // emoji 算一个字
    ["🐶小文", "🐶小文"],
  ])("「%s」可以，存成「%s」", (raw, name) => {
    expect(checkUserName(raw)).toEqual({ ok: true, name });
  });

  it.each<[string, string, RegExp]>([
    ["空的", "", /不能是空的/],
    ["全是空白", "  　", /不能是空的/],
    ["九个字", "一二三四五六七八九", /最多 8 个字/],
    ["中间有换行", "文\n翰", /不能有换行/],
    ["控制字符", "文\u0007翰", /不能有控制字符/],
    ["带着名字占位的括号", "文⟦翰", /不能含/],
  ])("%s：不合规，说明原因", (_case, raw, reason) => {
    const result = checkUserName(raw);
    expect(result.ok).toBe(false);
    expect(result.ok ? "" : result.error).toMatch(reason);
  });

  it("最多几个字和助理的名字是同一条规矩（8 个）", () => {
    expect(USER_NAME_MAX).toBe(8);
  });
});

describe("我的名字的接口：GET/PUT /api/user-name", () => {
  it("路径是 /api/user-name，拆得回来", () => {
    expect(HTTP_PATHS.userName).toBe("/api/user-name");
    expect(parseHttpPath("/api/user-name")).toEqual({ route: "user_name" });
  });

  it("和助理的名字（/api/assistant-name）是两个地址", () => {
    expect(HTTP_PATHS.assistantName).toBe("/api/assistant-name");
    expect(parseHttpPath(HTTP_PATHS.assistantName)).toEqual({ route: "assistant_name" });
    expect(parseHttpPath(`${HTTP_PATHS.userName}/x`)).toBeUndefined();
  });
});
