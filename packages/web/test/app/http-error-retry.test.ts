// 守护进程重启的几十秒里（写整理记录、重启、夜里整理占用推理库），记忆页会收到 HTML 错误页（网关或 nginx 的 502）。
// 那时候不能把 "Unexpected token '<', "<html> <h"… is not valid JSON" 甩给用户：
// - 非 2xx 的响应体先看能不能读出 { message }，读不出来（HTML、空）给一句人话；
// - 2xx 但 body 不是 JSON 也说清楚；
// - 记忆页取数据时再试两次（retryLoad），第一次 502 不留"读不出来"。
import { describe, expect, test } from "vitest";
import { httpErrorMessage, notJsonMessage } from "../../src/app/http-error.ts";
import { retryLoad } from "../../src/app/retry-load.ts";

const HTML_502 = "<html> <head><title>502 Bad Gateway</title></head><body><h1>502 Bad Gateway</h1></body></html>";

describe("守护进程回 HTML 错误页时给人话，不甩 JSON 解析错误", () => {
  test("502 + HTML：说守护进程没答上来，带上状态码", () => {
    const message = httpErrorMessage(502, HTML_502);
    expect(message).toContain("502");
    expect(message).not.toContain("Unexpected token");
    expect(message).not.toContain("<html");
  });

  test("空 body：也是那句话", () => {
    expect(httpErrorMessage(502, "")).toContain("502");
  });

  test("守护进程自己的 JSON 错误（401）：用它写的原因", () => {
    expect(httpErrorMessage(401, JSON.stringify({ code: "unauthorized", message: "这台设备没有凭证" }))).toBe("这台设备没有凭证");
  });

  test("2xx 但 body 不是 JSON：说清楚让人再试", () => {
    expect(notJsonMessage()).toContain("再试");
  });
});

describe("记忆页取数据多试两次", () => {
  test("第一次成功就不再试", async () => {
    let calls = 0;
    const value = await retryLoad(async () => {
      calls += 1;
      return "ok";
    }, { delayMs: 0 });
    expect(value).toBe("ok");
    expect(calls).toBe(1);
  });

  test("前两次失败、第三次成：能拿到数据", async () => {
    let calls = 0;
    const value = await retryLoad(
      async () => {
        calls += 1;
        if (calls < 3) throw new Error("502");
        return "ok";
      },
      { delayMs: 0 },
    );
    expect(value).toBe("ok");
    expect(calls).toBe(3);
  });

  test("三次都失败：抛最后一次的原因", async () => {
    let calls = 0;
    await expect(
      retryLoad(
        async () => {
          calls += 1;
          throw new Error(`第 ${calls} 次失败`);
        },
        { delayMs: 0 },
      ),
    ).rejects.toThrow("第 3 次失败");
    expect(calls).toBe(3);
  });
});
