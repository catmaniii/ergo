// 守卫切面：控制器的硬检查"某个对象被判过'永不'之后，再对它做对外动作要先问"（规格第 9 节，13 号票）。
// - 只算处置为"永不"的依据（关注类别、底线、受保护区域、一律禁止类时序规则）；按规则退回、判断不了的不算；
// - 对象是对外动作的收件人（没有收件人参数的发送用目标对象：推送是仓库、远端和分支）；
// - 控制器把同一任务里被判过永不的对象交给判定函数（neverObjects），判定函数据此把对它的对外动作至少调到先问。
import { describe, expect, it } from "vitest";
import { type Grant, judgeToolCall, neverObjectsOf } from "../../src/guard/index.ts";
import { call, DAY, inTask, maintainer, NOW, P, task, v1Satisfied } from "./helpers/guard-input.ts";
import { TEST_TOOLS } from "./helpers/test-tools.ts";
import { fakeSecret } from "../helpers/fake-secrets.ts";

const SECRET = fakeSecret("ghp_", "AbCdEfGhIjKlMnOpQrStUvWxYz0123456789");
const email = (to: string, body: string) => call("mcp_send_email", { to, subject: "周报", body });
/** 计划里给发邮件的授权项（不限收件人）：按授权本来直接放行 */
const sendGrant: Grant = { grantId: "send", tool: "mcp_send_email", scope: {}, stageId: "s1", grantedAt: NOW - DAY };
const inPlan = (neverObjects: string[] = []) => ({ tools: TEST_TOOLS, task: task({ plan: { grants: [sendGrant] } }), neverObjects, ...v1Satisfied() });

describe("被判过永不的对象", () => {
  it("把密钥写进发给 boss@example.com 的邮件被判永不：对象记下的是收件人", () => {
    const input = inTask(maintainer(), email("Boss@Example.com", `token: ${SECRET}`), inPlan());
    const j = judgeToolCall(input);
    expect(j.disposition).toBe("never");
    expect(neverObjectsOf(input, j)).toEqual(["boss@example.com"]);
  });

  it("之后再给它发（内容没问题、授权项也覆盖）：先问用户，写明它被判过永不；给别人发照常按授权放行", () => {
    const again = judgeToolCall(inTask(maintainer(), email("boss@example.com", "周报在附件里"), inPlan(["boss@example.com"])));
    expect(again.disposition).toBe("ask_first");
    expect(again.explanation).toContain("boss@example.com");
    expect(again.explanation).toContain("被判过\"永不\"");

    const other = judgeToolCall(inTask(maintainer(), email("team@example.com", "周报在附件里"), inPlan(["boss@example.com"])));
    expect(other.disposition).toBe("log_only");
    expect(other.withinGrant).toBe(true);
  });

  it("推送被一律禁止（force push）：对象是仓库、远端和分支；之后对同一处的普通推送也要先问", () => {
    const grant: Grant = { grantId: "push", tool: "git_push", scope: {}, stageId: "s1", grantedAt: NOW - DAY };
    const base = { task: task({ plan: { grants: [grant] } }), ...v1Satisfied(P.workDir) };
    const force = inTask(maintainer(), call("git_push", { remote: "origin", branch: "main", force: true }), base);
    const forced = judgeToolCall(force);
    expect(forced.disposition).toBe("never");
    const objects = neverObjectsOf(force, forced);
    expect(objects).toHaveLength(1);

    const normal = judgeToolCall(inTask(maintainer(), call("git_push", { remote: "origin", branch: "main" }), { ...base, neverObjects: objects }));
    expect(normal.disposition).toBe("ask_first");
    const elsewhere = judgeToolCall(inTask(maintainer(), call("git_push", { remote: "origin", branch: "dev" }), { ...base, neverObjects: objects }));
    expect(elsewhere.disposition).toBe("log_only");
  });

  it("按规则退回、不对外的永不不记对象", () => {
    // 推送前没跑过测试：按规则退回
    const pulled = inTask(maintainer(), call("git_push", { remote: "origin", branch: "main" }), { task: task(), facts: { git: { [P.workDir]: { uncommittedPaths: [], head: "c1" } } } });
    const pj = judgeToolCall(pulled);
    expect(pj.pullBack).not.toBeNull();
    expect(neverObjectsOf(pulled, pj)).toEqual([]);
    // 写受保护区域是永不，但不是对外动作
    const protectedWrite = inTask(maintainer(), call("write", { path: `${P.config}\\x.json`, content: "{}" }));
    const wj = judgeToolCall(protectedWrite);
    expect(wj.disposition).toBe("never");
    expect(neverObjectsOf(protectedWrite, wj)).toEqual([]);
  });
});
