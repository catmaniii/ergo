// 守卫切面：判定函数的基本形状。
import { describe, expect, it } from "vitest";
import { judgeToolCall } from "../../src/guard/index.ts";
import { call, inChat, maintainer, P } from "./helpers/guard-input.ts";

describe("守卫判定：基本", () => {
  it("维护者在工作目录里读文件：不落在任何类别，直接做只记录", () => {
    const j = judgeToolCall(inChat(maintainer(), call("read", { path: `${P.workDir}\\README.md` })));
    expect(j.disposition).toBe("log_only");
    expect(j.categories).toEqual([]);
    expect(j.genericShell).toBe(false);
    expect(j.temporalRules).toEqual([]);
    expect(j.withinGrant).toBe(false);
    expect(j.explanation).toMatch(/放行/);
  });
});
