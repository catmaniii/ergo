// 守卫切面：判定函数的基本形状——纯函数、同样的输入永远得到同样的判定、时间由调用方传入、给时序规则留的接入点。
import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { judgeToolCall, type GuardInput } from "../../src/guard/index.ts";
import { bash, call, DAY, inChat, inTask, maintainer, NOW, P, task, v1Satisfied } from "./helpers/guard-input.ts";

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object") {
    for (const v of Object.values(value)) deepFreeze(v);
    Object.freeze(value);
  }
  return value;
}

describe("守卫判定：基本", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("维护者在工作目录里读文件：不落在任何类别，直接做只记录", () => {
    const j = judgeToolCall(inChat(maintainer(), call("read", { path: `${P.workDir}\\README.md` })));
    expect(j.disposition).toBe("log_only");
    expect(j.categories).toEqual([]);
    expect(j.genericShell).toBe(false);
    expect(j.temporalRules).toEqual([]);
    expect(j.withinGrant).toBe(false);
    expect(j.explanation).toMatch(/放行/);
    expect(j.calls).toEqual([{ tool: "read", args: { path: `${P.workDir}\\README.md` }, origin: "tool" }]);
  });

  it("同样的输入永远得到同样的判定，而且不改动输入", () => {
    const grants = [{ grantId: "g", tool: "git_push", scope: { remote: "origin" }, maxUses: 2, stageId: "s1", grantedAt: NOW - DAY }];
    const inputs: GuardInput[] = [
      inTask(maintainer(), bash("rm -rf build && git push origin main && curl -X POST https://x.example"), { task: task({ plan: { grants } }) }),
      inChat(maintainer(), call("write", { path: "../../x", content: "sk-0123456789abcdef0123456789abcdef" })),
    ];
    for (const input of inputs) {
      const frozen = deepFreeze(structuredClone(input));
      const first = judgeToolCall(frozen);
      const second = judgeToolCall(frozen);
      expect(second).toEqual(first);
      expect(frozen).toEqual(input);
    }
  });

  it("不看时钟：当前时间只认输入里的 now", () => {
    const grants = [{ grantId: "g", tool: "git_push", scope: {}, stageId: "s1", grantedAt: NOW - DAY }];
    const input = inTask(maintainer(), call("git_push", { remote: "origin" }), { task: task({ plan: { grants } }), ...v1Satisfied() });
    vi.useFakeTimers();
    vi.setSystemTime(NOW + 365 * DAY);
    expect(judgeToolCall(input).disposition).toBe("log_only");
    vi.setSystemTime(NOW - 365 * DAY);
    expect(judgeToolCall(input).disposition).toBe("log_only");
    expect(judgeToolCall({ ...input, now: NOW + 30 * DAY }).disposition).toBe("ask_first");
  });

  it("判定核心的源码不读文件、不跑命令、不看时钟、不读环境变量（只有关注类别注册表的读取例外）", () => {
    const dir = path.resolve(import.meta.dirname, "../../src/guard");
    const files = fs.readdirSync(dir, { recursive: true, encoding: "utf8" }).filter((f) => f.endsWith(".ts") && !f.endsWith("watch-category-store.ts"));
    expect(files.length).toBeGreaterThan(5);
    const forbidden = [/from\s+["']node:(?:fs|child_process|os|process)/, /\bDate\.now\s*\(/, /new Date\(\s*\)/, /process\.(?:env|cwd|platform)/, /Math\.random/];
    for (const f of files) {
      const text = fs.readFileSync(path.join(dir, f), "utf8");
      for (const pattern of forbidden) expect({ file: f, pattern: String(pattern), found: pattern.test(text) }).toEqual({ file: f, pattern: String(pattern), found: false });
    }
  });

  it("时序规则只管触发它的工具：别的调用不受影响", () => {
    const rules = [{ id: "no-deploy", title: "不许部署", trigger: { tool: "git_push" } }];
    const j = judgeToolCall(inTask(maintainer(), call("git_status_diff", {}), { temporalRules: rules }));
    expect(j.disposition).toBe("log_only");
    expect(j.temporalRules).toEqual([]);
  });

  it("工具包没开 bash：bash 调用和带类型的 bash 工具都硬拒绝", () => {
    const noBash = maintainer({ toolkit: { bash: false, network: true } });
    const j = judgeToolCall(inChat(noBash, bash("ls")));
    expect(j.hardRefusal).toEqual(["no_bash"]);
    expect(j.genericShell).toBe(true);
    expect(judgeToolCall(inChat(noBash, call("git_status_diff", {}))).hardRefusal).toEqual(["no_bash"]);
    expect(judgeToolCall(inChat(noBash, call("read", { path: "a.txt" }))).hardRefusal).toBeNull();
  });

  it("工具包没给的工具硬拒绝（传了工具白名单时）", () => {
    const limited = maintainer({ toolkit: { bash: true, network: true, tools: ["read", "ls"] } });
    expect(judgeToolCall(inChat(limited, call("read", { path: "a.txt" }))).hardRefusal).toBeNull();
    const j = judgeToolCall(inChat(limited, call("write", { path: "a.txt", content: "x" })));
    expect(j.hardRefusal).toEqual(["not_in_toolkit"]);
    expect(j.explanation).toMatch(/工具包没有给 write/);
    // bash 和带类型的 bash 工具由 bash 开关管
    expect(judgeToolCall(inChat(limited, bash("ls"))).hardRefusal).toBeNull();
    expect(judgeToolCall(inChat(limited, call("git_status_diff", {}))).hardRefusal).toBeNull();
  });

  it("空命令或只有赋值：没有要判定的调用，直接做", () => {
    for (const command of ["", "   ", "FOO=bar", "# 只是注释"]) {
      const j = judgeToolCall(inChat(maintainer(), bash(command)));
      expect({ command, disposition: j.disposition }).toEqual({ command, disposition: "log_only" });
      expect(j.genericShell).toBe(true);
    }
  });
});
