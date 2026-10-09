// 设置里的"工具调用的完整内容"（65 号票）：占了多大、规则、"现在就清理"会清掉多少，清完怎么说。
// 守护进程的回答按协议的 schema 构造。
import { schemaChecker, ToolCallCleanupResult as CleanupSchema, ToolCallStorageView as ViewSchema } from "@ergou/protocol";
import { describe, expect, test } from "vitest";
import { type ToolCallCleanupResult, toolCallCleanupText, type ToolCallStorageView, toolCallStorageText } from "../../src/state/index.ts";

const MB = 1024 ** 2;
const GB = 1024 ** 3;
const checkView = schemaChecker(ViewSchema);
const checkResult = schemaChecker(CleanupSchema);

function view(overrides: Partial<ToolCallStorageView> = {}): ToolCallStorageView {
  const v: ToolCallStorageView = { bytes: 312 * MB, calls: 1234, cleared: 0, retentionDays: 90, maxBytes: 2 * GB, due: { calls: 0, bytes: 0, inUse: 0 }, ...overrides };
  const problem = checkView.firstError(v);
  if (problem) throw new Error(`构造的回答不合 schema：${problem}`);
  return v;
}

function result(overrides: Partial<ToolCallCleanupResult> = {}): ToolCallCleanupResult {
  const r: ToolCallCleanupResult = { trigger: "manual", at: "2026-10-09T21:00:00.000+08:00", expired: 0, overLimit: 0, freedBytes: 0, keptInUse: 0, bytes: 312 * MB, calls: 1234, ...overrides };
  const problem = checkResult.firstError(r);
  if (problem) throw new Error(`构造的回答不合 schema：${problem}`);
  return r;
}

describe("设置里的工具调用完整内容", () => {
  test("占了多大、存着几次；规则写保留天数和总量上限；没有可清的时按钮灰掉", () => {
    expect(toolCallStorageText(view())).toEqual({
      usage: "占 312.0 MB，1234 次调用存着完整内容",
      rule: "保留 90 天、总量最多 2 GB，超出的从最旧的起清；没结束的任务里的、待办里还引用着的不清。每天自动清一次",
      due: "现在没有要清的",
      canClean: false,
      confirm: undefined,
    });
  });

  test("清掉过的、到了该清的（几次、大约多大）、到期了但还被用着的都说出来；有可清的才能点，确认框说清楚清掉什么、找不回来", () => {
    const t = toolCallStorageText(view({ bytes: Math.round(2.3 * GB), cleared: 56, maxBytes: 512 * MB, retentionDays: 30, due: { calls: 3, bytes: Math.round(4.2 * MB), inUse: 2 } }));
    expect(t).toEqual({
      usage: "占 2.30 GB，1234 次调用存着完整内容，56 次已经清掉、只剩摘要",
      rule: "保留 30 天、总量最多 512 MB，超出的从最旧的起清；没结束的任务里的、待办里还引用着的不清。每天自动清一次",
      due: "现在可以清掉 3 次（约 4.2 MB）；另有 2 次到期了但还被用着，先不清",
      canClean: true,
      confirm: "按现在的规则清掉 3 次调用的完整内容（约 4.2 MB）？清掉的只是完整参数和返回：聊天里的记录、要点、效果记录照旧，详情页里退回摘要。清掉后找不回来。",
    });
    expect(toolCallStorageText(view({ due: { calls: 0, bytes: 0, inUse: 1 } })).due).toBe("现在没有要清的；有 1 次到期了但还被用着，先不清");
  });

  test("清完：清了几次、腾出多少；没有可清的照实说", () => {
    expect(toolCallCleanupText(result({ expired: 2, overLimit: 1, freedBytes: Math.round(4.2 * MB) }))).toBe("清掉了 3 次调用的完整内容，腾出 4.2 MB");
    expect(toolCallCleanupText(result({ keptInUse: 2 }))).toBe("没有要清的（2 次到期了但还被用着，先不清）");
    expect(toolCallCleanupText(result())).toBe("没有要清的");
  });
});
