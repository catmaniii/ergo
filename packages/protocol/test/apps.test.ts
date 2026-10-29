// 转发本机服务的页面（132 号票）：/apps/<应用名>/… 怎么拼、怎么拆，应用名的规矩。守护进程的转发和 Web 的内置浏览器都用这一份。
import { describe, expect, it } from "vitest";
import { APP_BASE_PATH_ENV, APP_PREFIX_HEADER, appBasePath, appUrl, isAppName, parseAppPath } from "../src/index.ts";

describe("应用名", () => {
  it("小写字母、数字、连字符，字母或数字开头结尾，最长 63（一段域名）", () => {
    expect(["intel", "p-3-intel", "a", "9", "a".repeat(63)].filter((n) => !isAppName(n))).toEqual([]);
    expect(["", "Intel", "-intel", "intel-", "in_tel", "in.tel", "简报站", "a".repeat(64), "%61bc", "a/b"].filter((n) => isAppName(n))).toEqual([]);
  });
});

describe("前缀和地址", () => {
  it("前缀不带末尾的斜杠（ERGO_BASE_PATH、X-Forwarded-Prefix 的值）；地址带", () => {
    expect(appBasePath("intel")).toBe("/apps/intel");
    expect(appUrl("intel")).toBe("/apps/intel/");
    expect(appUrl("intel", "reports/1?x=2")).toBe("/apps/intel/reports/1?x=2");
    expect(appUrl("intel", "/reports")).toBe("/apps/intel/reports");
    expect(APP_BASE_PATH_ENV).toBe("ERGO_BASE_PATH");
    expect(APP_PREFIX_HEADER).toBe("x-forwarded-prefix");
  });

  it("拆地址：应用名和后面那一段原样给出；只写到应用名的 rest 不以斜杠开头（网关让它跳到首页）", () => {
    expect(parseAppPath("/apps/intel/")).toEqual({ name: "intel", rest: "/" });
    expect(parseAppPath("/apps/intel/a/b%20c?x=1&y=%2F")).toEqual({ name: "intel", rest: "/a/b%20c?x=1&y=%2F" });
    expect(parseAppPath("/apps/intel")).toEqual({ name: "intel", rest: "" });
    expect(parseAppPath("/apps/intel?x=1")).toEqual({ name: "intel", rest: "?x=1" });
    expect(parseAppPath("/apps/intel/../../api/x")).toEqual({ name: "intel", rest: "/../../api/x" });
  });

  it("不在前缀下、应用名写得不对的拆不出来", () => {
    expect(["/", "/apps", "/apps/", "/apps//x", "/apps/Intel/", "/apps/%69ntel/", "/appsx/intel/", "/api/apps/intel/", "apps/intel/"].filter((u) => parseAppPath(u) !== undefined)).toEqual([]);
  });
});
