// 网关发页面时认不认 gzip（450）：浏览器、ArkWeb 说收 gzip 才压缩了发，q=0 的不算；没写 gzip 的看 *。
import { describe, expect, test } from "vitest";
import { acceptsGzip } from "../../src/gateway/gateway.ts";

describe("Accept-Encoding 里收不收 gzip", () => {
  test("浏览器常见的写法都收", () => {
    expect(acceptsGzip("gzip, deflate, br, zstd")).toBe(true);
    expect(acceptsGzip("gzip")).toBe(true);
    expect(acceptsGzip("deflate, GZIP;q=0.5")).toBe(true);
    expect(acceptsGzip("*")).toBe(true);
  });

  test("没说、只说别的、q=0 的不收；写明 gzip 的不看 *", () => {
    expect(acceptsGzip(undefined)).toBe(false);
    expect(acceptsGzip("")).toBe(false);
    expect(acceptsGzip("identity")).toBe(false);
    expect(acceptsGzip("br, deflate")).toBe(false);
    expect(acceptsGzip("gzip;q=0")).toBe(false);
    expect(acceptsGzip("gzip; q=0.0, *")).toBe(false);
    expect(acceptsGzip("*;q=0")).toBe(false);
  });
});
