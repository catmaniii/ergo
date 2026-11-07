// 自动压缩点（420，auto-compact.ts）：生效的点怎么算（跟随默认、单独设的、按模型窗口夹）、范围怎么查（守护进程存之前、
// 设置页和 ⚙ 边改边查用同一个函数）、旧设置文件没写时的默认。
import { describe, expect, it } from "vitest";
import { AUTO_COMPACT_DEFAULT, AUTO_COMPACT_MAX, AUTO_COMPACT_MIN, autoCompactLimit, autoCompactProblem, effectiveAutoCompact } from "../src/auto-compact.ts";
import { autoCompactDefaultOf } from "../src/model-settings.ts";

describe("生效的压缩点", () => {
  it("跟随默认：就是默认值；单独设的优先；窗口还不知道时不夹", () => {
    expect(effectiveAutoCompact({ defaultAt: 700_000 })).toEqual({ at: 700_000, source: "default", configured: 700_000, clamped: false });
    expect(effectiveAutoCompact({ defaultAt: 700_000, own: 300_000 })).toEqual({ at: 300_000, source: "own", configured: 300_000, clamped: false });
  });

  it("上限是窗口减 pi 的 reserveTokens（16384）：没超过照设的，超过了按上限算（clamped）；跟随默认、单独设的都一样", () => {
    expect(autoCompactLimit(1_000_000)).toBe(983_616);
    expect(effectiveAutoCompact({ defaultAt: 700_000, window: 1_000_000, reserveTokens: 16_384 })).toEqual({ at: 700_000, source: "default", configured: 700_000, limit: 983_616, clamped: false });
    // 单独设的比换了模型后的窗口上限大
    expect(effectiveAutoCompact({ defaultAt: 700_000, own: 900_000, window: 128_000, reserveTokens: 16_384 })).toEqual({ at: 111_616, source: "own", configured: 900_000, limit: 111_616, clamped: true });
    // 默认的 70 万比小窗口的模型大
    expect(effectiveAutoCompact({ defaultAt: 700_000, window: 128_000 })).toMatchObject({ at: 111_616, source: "default", clamped: true });
    // 正好等于上限不算超过
    expect(effectiveAutoCompact({ defaultAt: 983_616, window: 1_000_000 })).toMatchObject({ at: 983_616, clamped: false });
  });

  it("旧的设置文件没有这一项：按内置的 70 万", () => {
    expect(AUTO_COMPACT_DEFAULT).toBe(700_000);
    expect(autoCompactDefaultOf({})).toBe(700_000);
    expect(autoCompactDefaultOf({ autoCompactAt: 500_000 })).toBe(500_000);
  });
});

describe("压缩点的范围", () => {
  it("要是整数、最少 5 万、最多一千万；合规的回 undefined", () => {
    expect(autoCompactProblem(AUTO_COMPACT_MIN)).toBeUndefined();
    expect(autoCompactProblem(AUTO_COMPACT_MAX)).toBeUndefined();
    expect(autoCompactProblem(49_999)).toBe("最少 50,000 token：再小压完马上又满");
    expect(autoCompactProblem(AUTO_COMPACT_MAX + 1)).toBe("最多 10,000,000 token");
    expect(autoCompactProblem(70_000.5)).toBe("要填一个整数（token 数）");
    expect(autoCompactProblem(Number.NaN)).toBe("要填一个整数（token 数）");
  });

  it("给了模型窗口（⚙ 里）：不能超过这个模型的上限，说清是窗口减多少", () => {
    expect(autoCompactProblem(983_616, { window: 1_000_000, reserveTokens: 16_384 })).toBeUndefined();
    expect(autoCompactProblem(983_617, { window: 1_000_000, reserveTokens: 16_384 })).toBe("这个模型最多设到 983,616 token（窗口 1,000,000 减 16,384，再往上就是 pi 自己压缩的点了）");
  });
});
