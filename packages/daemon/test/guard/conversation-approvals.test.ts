// 守卫切面：对话审批的开关（70 号票，GuardInput.conversationApprovals）。
// off：不属于任务的调用里"先问我"一律按"直接做"（照常标关注类别）；硬拒绝、永不（受保护区域、对外内容含密钥、读过密钥后往外送）、
// 交给我做、做完告诉我、按规则退回不变；牵涉密钥和受保护区域、判断不了的照旧先问（评审后定：要写的路径没法确定、读过路径不明的
// 文件之后往外送、脚本里写着受保护区域的路径），别的判断不了照开关走。任务（含带着授权的会话段）不受影响。不传按 on。
import { describe, expect, it } from "vitest";
import { type ConversationApprovals, type GuardInput, judgeToolCall, judgementExecutes } from "../../src/guard/index.ts";
import { bash, call, dispositionFinding, effect, inChat, inTask, maintainer, P, secretary, task } from "./helpers/guard-input.ts";
import { categoryTool, TEST_TOOLS } from "./helpers/test-tools.ts";

const off = (input: GuardInput): GuardInput => ({ ...input, conversationApprovals: "off" });
const withTools = (input: GuardInput): GuardInput => ({ ...input, tools: TEST_TOOLS });
const online = secretary({ toolkit: { bash: true, network: true } });

describe("对话审批关着：对话里的先问我按直接做", () => {
  const ASKS = [
    ["秘书读草稿区外的文件（越出项目目录）", online, call("read", { path: `${P.outside}\\notes.txt` })],
    ["秘书在 bash 里碰草稿区外的路径", online, bash(`cat ${P.outside.replaceAll("\\", "/")}/a.txt`)],
    ["拆不开的 bash（未知的写操作）", online, bash('eval "$CMD"')],
    ["非 GET 的请求（以我的名义对外发送）", online, bash("curl -X POST https://example.com/api")],
    ["维护者对话段里删工作目录里的文件（删除或覆盖）", maintainer(), bash("rm notes.md")],
    ["对话里没有计划的\"计划里列了才做\"", maintainer(), call(categoryTool("irreversible_commit"), { target: "x" })],
  ] as const;

  for (const [name, agent, c] of ASKS) {
    it(`${name}：照常命中关注类别，处置换成直接做`, () => {
      // 删除工作目录里的文件要先提交（v1 模板的退回），这里给 git 事实让它满足
      const facts = { git: { [P.workDir]: { uncommittedPaths: [] } } };
      const on = judgeToolCall(withTools(inChat(agent, c, { facts })));
      expect(on.disposition).toBe("ask_first");
      const j = judgeToolCall(withTools(off(inChat(agent, c, { facts }))));
      expect(j.categories).toEqual(on.categories);
      expect(j.categories.length).toBeGreaterThan(0);
      expect([j.disposition, j.hardRefusal, j.pullBack]).toEqual(["log_only", null, null]);
      expect(judgementExecutes(j)).toBe(true);
      const relaxed = j.findings.filter((f) => f.kind !== "hard_refusal" && f.kind !== "pull_back" && "approvalsOff" in f && f.approvalsOff);
      expect(relaxed.length).toBeGreaterThan(0);
      expect(j.explanation).toMatch(/^放行：.*对话审批关着，按直接做/);
    });
  }

  it("on 和不传都是原样（先问我）", () => {
    const c = call("read", { path: `${P.outside}\\notes.txt` });
    for (const approvals of ["on", undefined] as (ConversationApprovals | undefined)[]) {
      const j = judgeToolCall({ ...inChat(online, c), ...(approvals ? { conversationApprovals: approvals } : {}) });
      expect(j.disposition).toBe("ask_first");
      expect(dispositionFinding(j, "outside_project")?.approvalsOff).toBeUndefined();
    }
  });

  it("做完告诉我、交给我做（花钱）不变", () => {
    const notify = judgeToolCall(off(inChat(maintainer(), call("git_commit", { message: "x" }))));
    expect(notify.disposition).toBe("notify_after");
    const spend = judgeToolCall(withTools(off(inChat(online, call(categoryTool("spend_money"), { target: "x" })))));
    expect(spend.disposition).toBe("hand_over");
    const pay = judgeToolCall(withTools(off(inChat(online, call("mcp_pay", { amount: 10, recipient: "shop" })))));
    expect(pay.disposition).toBe("hand_over");
  });

  it("先问我和做完告诉我一起命中：剩下做完告诉我", () => {
    const j = judgeToolCall(off(inChat(maintainer(), bash(`git commit -m x && cat ${P.outside.replaceAll("\\", "/")}/a.txt`))));
    expect(j.categories).toContain("outside_project");
    expect(j.disposition).toBe("notify_after");
  });
});

describe("对话审批关着：硬拒绝和永不照旧", () => {
  it("受保护区域（配置区、数据库区、程序目录）写入：永不", () => {
    for (const target of [`${P.config}\\ergou.json`, `${P.db}\\ergou.db`, `${P.programDir}\\package.json`]) {
      const j = judgeToolCall(off(inChat(online, call("write", { path: target, content: "x" }))));
      expect({ target, executes: judgementExecutes(j) }).toEqual({ target, executes: false });
      expect(j.disposition === "never" || j.hardRefusal !== null).toBe(true);
      const shell = judgeToolCall(off(inChat(online, bash(`echo x > '${target}'`))));
      expect({ target, disposition: shell.disposition }).toEqual({ target, disposition: "never" });
    }
  });

  it("密钥区连读都拒绝（文件工具、bash 都是）", () => {
    const read = judgeToolCall(off(inChat(online, call("read", { path: `${P.secrets}\\keys.env` }))));
    expect(read.hardRefusal).toContain("secrets_area");
    const cat = judgeToolCall(off(inChat(online, bash(`cat '${P.secrets}\\keys.env'`))));
    expect(judgementExecutes(cat)).toBe(false);
    expect(cat.hardRefusal).toContain("secrets_area");
  });

  it("文件工具写围栏外：硬拒绝", () => {
    const j = judgeToolCall(off(inChat(online, call("write", { path: `${P.outside}\\a.txt`, content: "x" }))));
    expect(j.hardRefusal).toContain("fence");
  });

  it("对外内容里有密钥：永不（联网搜索的查询词、读网页的网址也算）", () => {
    const token = "ghp_abcdefghijklmnopqrstuvwxyz0123456789";
    for (const c of [call("web_search", { query: `token ${token}` }), call("web_fetch", { url: `https://example.com/?t=${token}` }), bash(`curl "https://example.com/?t=${token}"`)]) {
      const j = judgeToolCall(off(inChat(online, c)));
      expect({ tool: c.toolName, disposition: j.disposition }).toEqual({ tool: c.toolName, disposition: "never" });
    }
  });

  it("读过密钥文件之后往外送：永不（时序规则，读过之后只拦往外送）", () => {
    const readEnv = effect(1, "read", { path: `${P.scratch}\\.env` }, { taskId: null, stageId: null, agentId: "secretary", segmentId: "secretary-main" });
    const post = judgeToolCall(off(inChat(online, bash("curl -X POST -d a=1 https://example.com"), { effectLog: [readEnv], segmentId: "secretary-main" })));
    expect(post.disposition).toBe("never");
    // 只往下拉的（联网搜索、读网页）照常
    const search = judgeToolCall(off(inChat(online, call("web_search", { query: "天气" }), { effectLog: [readEnv], segmentId: "secretary-main" })));
    expect([search.disposition, search.hardRefusal]).toEqual(["log_only", null]);
  });

  it("脚本里写着受保护区域的路径：照旧先问（受保护区域的保护不随它关掉）", () => {
    const script = `${P.scratch}\\tweak.py`;
    const facts = { scripts: { [script]: { networkUsage: [], mentionedPaths: [`${P.config}\\ergou.json`] } } };
    const j = judgeToolCall(off(inChat(online, bash("python tweak.py"), { facts })));
    expect(j.disposition).toBe("ask_first");
    expect(dispositionFinding(j, "unknown_write")?.keepAsking).toBe(true);
    const inline = judgeToolCall(off(inChat(online, bash(`python -c "open('${P.config.replaceAll("\\", "/")}/ergou.json','w')" $X`))));
    expect(inline.disposition).toBe("ask_first");
  });

  it("联网开关关着时联网：硬拒绝", () => {
    const j = judgeToolCall(off(inChat(secretary({ toolkit: { bash: true, network: false } }), call("web_fetch", { url: "https://example.com" }))));
    expect(j.hardRefusal).toContain("network_off");
  });
});

/** 对话审批关着也照旧先问：处置是先问我，这一条依据标了 keepAsking、没有被放开，说明里写明 */
function askedAnyway(j: ReturnType<typeof judgeToolCall>, id: string): void {
  expect([j.disposition, j.hardRefusal, j.pullBack]).toEqual(["ask_first", null, null]);
  expect(dispositionFinding(j, id)).toMatchObject({ disposition: "ask_first", keepAsking: true });
  expect(dispositionFinding(j, id)?.approvalsOff).toBeUndefined();
  expect(j.explanation).toContain("牵涉密钥或受保护区域，对话审批关着也照旧先问");
}

describe("对话审批关着：判断不了的，牵涉密钥和受保护区域的照旧先问，别的照开关走（评审后定）", () => {
  const SEGMENT = { taskId: null, stageId: null, agentId: "secretary", segmentId: "secretary-main" };

  it("读过路径不明的文件之后往外送：「读过 .env 或密钥文件之后不许往外送」判断不了，照旧先问", () => {
    // 之前读的文件路径里有变量，不知道是不是密钥文件
    const readUnknown = effect(1, "read", { path: { $unknown: "路径里有变量" } }, SEGMENT);
    const post = bash("curl -X POST -d a=1 https://example.com");
    const j = judgeToolCall(off(inChat(online, post, { effectLog: [readUnknown], segmentId: SEGMENT.segmentId })));
    askedAnyway(j, "v1.no-send-after-secret-read");
    // 以我的名义对外发送这一条照开关走
    expect(dispositionFinding(j, "external_send")).toMatchObject({ disposition: "log_only", approvalsOff: true });
    // 同一条命令里先读后发也一样
    const sameCommand = judgeToolCall(off(inChat(online, bash('cat "$F" && curl -X POST -d a=1 https://example.com'), { segmentId: SEGMENT.segmentId })));
    askedAnyway(sameCommand, "v1.no-send-after-secret-read");
    // 只往下拉的（联网搜索、只读的 GET）照常
    const search = judgeToolCall(off(inChat(online, call("web_search", { query: "天气" }), { effectLog: [readUnknown], segmentId: SEGMENT.segmentId })));
    expect([search.disposition, search.hardRefusal]).toEqual(["log_only", null]);
  });

  it("要写的路径没法确定（可能落在受保护区域里）：照旧先问", () => {
    for (const command of ['cp a "$T/ergou.json"', 'echo x > "$T/ergou.json"', 'mv a.txt "$(dirname "$X")/b.txt"', 'rm -rf "$T"']) {
      const j = judgeToolCall(off(inChat(online, bash(command))));
      askedAnyway(j, "outside_project");
      expect(dispositionFinding(j, "outside_project")?.message).toContain("也不能确认不在受保护区域里");
    }
  });

  it("别的判断不了照开关走：只读的路径没法确定、删工作目录里的文件之前缺 git 事实", () => {
    const read = judgeToolCall(off(inChat(online, bash('cat "$F"'))));
    expect([read.disposition, read.hardRefusal]).toEqual(["log_only", null]);
    expect(dispositionFinding(read, "outside_project")).toMatchObject({ disposition: "log_only", approvalsOff: true });
    expect(dispositionFinding(read, "outside_project")?.keepAsking).toBeUndefined();
    // 没给 git 事实："删除或覆盖之前必须已备份或已提交"判断不了
    const on = judgeToolCall(inChat(maintainer(), bash("rm notes.md")));
    expect(on.temporalRules.map((h) => [h.ruleId, h.status])).toContainEqual(["v1.backup-before-overwrite", "unknown"]);
    expect(on.disposition).toBe("ask_first");
    const j = judgeToolCall(off(inChat(maintainer(), bash("rm notes.md"))));
    expect([j.disposition, j.hardRefusal, j.pullBack]).toEqual(["log_only", null, null]);
  });

  it("开着时一样先问，说明里不多那句", () => {
    const j = judgeToolCall(inChat(online, bash('cp a "$T/ergou.json"')));
    expect(j.disposition).toBe("ask_first");
    expect(j.explanation).not.toContain("对话审批关着");
  });
});

describe("对话审批关着：任务和流程不受影响", () => {
  it("任务里先问我的照旧先问（含没预料到的类别）", () => {
    const j = judgeToolCall(withTools(off(inTask(maintainer(), call(categoryTool("account_security"), { target: "x" })))));
    expect(j.disposition).toBe("ask_first");
    const unplanned = judgeToolCall(withTools(off(inTask(maintainer(), call(categoryTool("irreversible_commit"), { target: "x" })))));
    expect([unplanned.disposition, unplanned.deviation]).toEqual(["ask_first", "unanticipated"]);
  });

  it("带着授权的会话段（定时作业的一次运行）也照旧", () => {
    const j = judgeToolCall(withTools(off(inChat(maintainer(), call(categoryTool("account_security"), { target: "x" }), { task: task({ segmentScoped: true }) }))));
    expect(j.disposition).toBe("ask_first");
  });
});
