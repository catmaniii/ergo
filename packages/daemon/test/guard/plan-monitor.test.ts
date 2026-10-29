// 守卫切面：流程执行时的计划检查（59 号票，guard/plan-monitor.ts 的 evaluatePlanCall / tryAutoFix
// 和监控器的外壳）。第一道是现有的守卫判定（关注类别、处置、时序规则），第二道是和已授权的计划比对：
// - 计划外：只读的照常做（记下），会改东西的问用户（点过头的同一件事不再问）；落进了关注类别的每次都问；
// - 超范围：和这个工具的每一步都对不上，问用户；点过头只放过那一个对象（用户定，从严）。
//   口径和 58 号票的授权项一样从严：只认步骤里写了的参数（多带、少带都算）、
//   每个值都要一样（数组不论先后、个数也要一样）、路径按真实路径比（取不到的对不上）；通用 bash 的步骤只比到命令这一层；
//   从通用 bash 拆出来的同类操作对不上带类型工具的步骤；
// - 顺序错：前置步骤没做——这次先不执行，引回前置步骤（不打扰用户）；
// - 重复：只许做一次的（推送、建远端仓库，以及命中"以我的名义对外发送"的通用 bash 命令）做第二次，直接拦下；
// - 禁止：审查时从步骤里剔除的对象，直接拦下；
// - 违反时序规则、而计划里正好有补救它的那一步：引回那一步；参数和计划对不上：按计划改回不认对象的参数，改后两道都通过才放行；
// - 每个"工具 + 步骤"最多自动修 2 次，修不了、超过次数的问用户。
import { describe, expect, it } from "vitest";
import {
  absolutePathArgs,
  BUILTIN_TOOL_REGISTRY,
  evaluatePlanCall,
  findingKey,
  type GuardJudgement,
  type GuardWorkflow,
  judgeToolCall,
  MAX_AUTO_FIX,
  type PlanCheckInput,
  type PlanExecutedCall,
  planPending,
  type TemporalRule,
  TOOL,
  V1_TEMPLATE_IDS,
  v1RuleTemplates,
} from "../../src/guard/index.ts";
import { inTask, maintainer, P, task, v1Satisfied } from "./helpers/guard-input.ts";

const agent = maintainer();
const env = { cwd: P.workDir, homeDir: P.home };

/** 写笔记、读一遍（读在写之后） */
const notes: GuardWorkflow = {
  planId: "t-1-p1",
  goal: "写好笔记并读一遍",
  steps: [
    { id: "s1", title: "写笔记", tool: TOOL.write, args: { path: "notes.md", content: "# 周报\n" }, after: [] },
    { id: "s2", title: "读一遍笔记", tool: TOOL.read, args: { path: "notes.md" }, after: ["s1"] },
  ],
  skipped: [],
};

/** 规划时现取的真实路径（步骤和剔除的对象里的路径）：测试里真实路径就是写的路径 */
const planned = (wf: GuardWorkflow): GuardWorkflow => ({
  ...wf,
  steps: wf.steps.map((s) => ({
    ...s,
    realPaths: Object.fromEntries(
      [s.args, s.excluded ?? {}].flatMap((args) => absolutePathArgs({ tool: s.tool, args }, BUILTIN_TOOL_REGISTRY, env)).map(({ path }) => [path, path]),
    ),
  })),
});

interface Case {
  workflow?: GuardWorkflow;
  /** 调用里路径的真实路径（判定前现取的）；不给就是写的路径 */
  realPathOf?: (path: string) => string | undefined;
  history?: PlanExecutedCall[];
  confirmed?: string[];
  corrections?: Record<string, number>;
  rules?: TemporalRule[];
  extra?: Parameters<typeof inTask>[2];
}

/** 一次调用：先过第一道（真的判定函数），再和计划比对 */
function check(toolName: string, args: Record<string, unknown>, c: Case = {}) {
  const rules = c.rules ?? [];
  const judgeWith = (a: Record<string, unknown>): GuardJudgement =>
    judgeToolCall(inTask(agent, { toolName, args: a }, { task: task({ currentStageId: "flow" }), temporalRules: rules, ...v1Satisfied(), ...c.extra }));
  const input: PlanCheckInput = {
    workflow: planned(c.workflow ?? notes),
    history: c.history ?? [],
    confirmed: new Set(c.confirmed ?? []),
    corrections: new Map(Object.entries(c.corrections ?? {})),
    call: { toolName, args },
    judgement: judgeWith(args),
    tools: BUILTIN_TOOL_REGISTRY,
    env,
    realPathOf: c.realPathOf ?? ((p) => p),
    rules: [...v1RuleTemplates(BUILTIN_TOOL_REGISTRY), ...rules],
    rejudge: judgeWith,
  };
  return evaluatePlanCall(input);
}

const kinds = (o: ReturnType<typeof check>) => (o.assessment.findings ?? []).filter((f) => f.verdict !== "allow" || f.kind !== "off_plan").map((f) => f.kind);

describe("和计划对得上：放行，记下对上的是哪一步", () => {
  it("照步骤做（路径写法不同也认：相对路径、大小写、正反斜杠）", () => {
    expect(check(TOOL.write, { path: "notes.md", content: "# 周报\n" })).toMatchObject({ kind: "pass", assessment: { stepId: "s1", matchedStep: "s1", offPlan: false } });
    expect(check(TOOL.read, { path: `${P.workDir.toUpperCase()}/NOTES.md` }, { history: [{ tool: TOOL.write, step: "s1" }] })).toMatchObject({
      kind: "pass",
      assessment: { stepId: "s2" },
    });
  });
});

describe("计划外", () => {
  it("只读的照常做，只记下一条计划外", () => {
    const o = check(TOOL.ls, {});
    expect(o).toMatchObject({ kind: "pass", assessment: { offPlan: true } });
    expect(o.assessment.findings).toEqual([{ kind: "off_plan", message: "计划里没有 ls 这一步", verdict: "allow" }]);
  });

  it("会改东西的问用户（不自动修）", () => {
    const o = check(TOOL.edit, { path: "notes.md", edits: [] });
    expect(o).toMatchObject({ kind: "ask", assessment: { offPlan: true } });
    if (o.kind !== "ask") return;
    expect(o.askAbout).toEqual([{ kind: "off_plan", message: "计划里没有 edit 这一步", verdict: "confirm" }]);
  });

  it("通用 bash：拆出来全是只读的（cat、ls）照常做；会改东西的问用户", () => {
    expect(check(TOOL.bash, { command: "cat notes.md" })).toMatchObject({ kind: "pass", assessment: { offPlan: true } });
    expect(check(TOOL.bash, { command: "rm notes.md" })).toMatchObject({ kind: "ask", assessment: { offPlan: true } });
  });

  it("会改东西、没落进关注类别的：用户点过头的同一件事不再问", () => {
    const off = { kind: "off_plan", message: "计划里没有 edit 这一步", verdict: "confirm" as const };
    expect(check(TOOL.edit, { path: "notes.md", edits: [] }, { confirmed: [findingKey(off)] })).toMatchObject({ kind: "pass" });
  });

  it("落进了关注类别的（推送是对外发送）：每次都问，点过头也照样问", () => {
    const off = { kind: "off_plan", message: "计划里没有 git_push 这一步", verdict: "confirm" as const };
    const o = check(TOOL.git_push, { remote: "origin", branch: "main" }, { confirmed: [findingKey(off)] });
    expect(o).toMatchObject({ kind: "ask", assessment: { offPlan: true }, askAbout: [off] });
  });
});

/** 真实路径：notes.md 指到了别处（链接） */
const elsewhere = (p: string) => (p.toLowerCase().endsWith("notes.md") ? `${P.home}\\elsewhere\\notes.md` : p);
/** 真实路径：link.md 是指向 notes.md 的链接 */
const linked = (p: string) => (p.toLowerCase().endsWith("link.md") ? `${P.workDir}\\notes.md` : p);

describe("超范围：和步骤对不上（口径同 58 号票的授权项）", () => {
  it("写了别的文件：问用户；没对上任何一步（matchedStep 没有），执行了也不算做过哪一步", () => {
    const o = check(TOOL.write, { path: "other.md", content: "x" });
    expect(o).toMatchObject({ kind: "ask", assessment: { stepId: "s1" } });
    expect(o.assessment.matchedStep).toBeUndefined();
    expect(kinds(o)).toEqual(["out_of_scope"]);
    expect(o.assessment.findings?.[0]?.message).toBe("write 的参数超出了计划声明的范围");
  });

  it("不认对象的参数（写的内容）和步骤不一样也算对不上：按计划改回再执行", () => {
    const o = check(TOOL.write, { path: "notes.md", content: "别的内容" });
    expect(o).toMatchObject({ kind: "rewrite", args: { path: "notes.md", content: "# 周报\n" }, assessment: { matchedStep: "s1" } });
  });

  it("路径按真实路径比：写的一样、真实路径不一样（链接指到了别处）对不上；取不到真实路径的对不上", () => {
    expect(kinds(check(TOOL.write, { path: "notes.md", content: "# 周报\n" }, { realPathOf: elsewhere }))).toEqual(["out_of_scope"]);
    expect(kinds(check(TOOL.write, { path: "notes.md", content: "# 周报\n" }, { realPathOf: () => undefined }))).toEqual(["out_of_scope"]);
    // 写法不同、真实路径一样：对得上
    expect(check(TOOL.write, { path: "link.md", content: "# 周报\n" }, { realPathOf: linked })).toMatchObject({ kind: "pass", assessment: { matchedStep: "s1" } });
  });

  it("通用 bash 的步骤只比到命令这一层：同一条命令（首尾空白不算）对得上，换了命令就超范围", () => {
    const wf: GuardWorkflow = { ...notes, steps: [{ id: "s1", title: "跑脚本", tool: TOOL.bash, args: { command: "node build.mjs --out dist" }, after: [] }] };
    expect(check(TOOL.bash, { command: "  node build.mjs --out dist " }, { workflow: wf })).toMatchObject({ kind: "pass", assessment: { stepId: "s1" } });
    expect(kinds(check(TOOL.bash, { command: "node build.mjs --out tmp" }, { workflow: wf }))).toEqual(["out_of_scope"]);
  });

  it("只认步骤里写了的参数：换了分支、少带了分支、多带了参数（force）都对不上，认对象的参数不改回，问用户", () => {
    const wf: GuardWorkflow = { ...notes, steps: [{ id: "s1", title: "推送", tool: TOOL.git_push, args: { remote: "origin", branch: "main" }, after: [] }] };
    expect(kinds(check(TOOL.git_push, { remote: "origin", branch: "dev" }, { workflow: wf }))).toEqual(["out_of_scope"]);
    expect(kinds(check(TOOL.git_push, { remote: "origin" }, { workflow: wf }))).toEqual(["out_of_scope"]);
    expect(check(TOOL.git_push, { remote: "origin", branch: "main", force: true }, { workflow: wf })).toMatchObject({ kind: "ask" });
    // 不认对象的参数（提交说明）不一样：按计划改回
    expect(check(TOOL.git_commit, { message: "x" }, { workflow: { ...notes, steps: [{ id: "s1", title: "提交", tool: TOOL.git_commit, args: { message: "y" }, after: [] }] } })).toMatchObject({
      kind: "rewrite",
      args: { message: "y" },
    });
  });

  it("数组参数：和步骤写的一模一样才对得上（不论先后，少了、多了都不算）", () => {
    const wf: GuardWorkflow = { ...notes, steps: [{ id: "s1", title: "提交两个文件", tool: TOOL.git_commit, args: { message: "x", paths: ["a.md", "b.md"] }, after: [] }] };
    expect(check(TOOL.git_commit, { message: "x", paths: ["b.md", "a.md"] }, { workflow: wf })).toMatchObject({ kind: "pass", assessment: { matchedStep: "s1" } });
    expect(kinds(check(TOOL.git_commit, { message: "x", paths: ["b.md"] }, { workflow: wf }))).toEqual(["out_of_scope"]);
    expect(kinds(check(TOOL.git_commit, { message: "x", paths: ["a.md", "b.md", "c.md"] }, { workflow: wf }))).toEqual(["out_of_scope"]);
    // 步骤写了要提交哪些文件，调用里不写（全部提交）：超范围
    expect(kinds(check(TOOL.git_commit, { message: "x" }, { workflow: wf }))).toEqual(["out_of_scope"]);
  });

  it("点过头只放过那一个对象（用户定，从严）：同意改 b.ts 之后改 c.ts 仍然要问；bash 换了一条命令、推送换了分支仍然要问", () => {
    const b = check(TOOL.write, { path: "b.ts", content: "x" });
    expect(b.kind).toBe("ask");
    const okB = b.kind === "ask" ? b.askAbout.map(findingKey) : [];
    expect(check(TOOL.write, { path: "b.ts", content: "y" }, { confirmed: okB })).toMatchObject({ kind: "pass" });
    // 写法不同、真实路径一样：同一个对象
    expect(check(TOOL.write, { path: `${P.workDir.toUpperCase()}\\B.TS`, content: "x" }, { confirmed: okB })).toMatchObject({ kind: "pass" });
    expect(check(TOOL.write, { path: "c.ts", content: "x" }, { confirmed: okB })).toMatchObject({ kind: "ask" });

    const build: GuardWorkflow = { ...notes, steps: [{ id: "s1", title: "构建", tool: TOOL.bash, args: { command: "node build.mjs" }, after: [] }] };
    const gen = check(TOOL.bash, { command: "node gen.mjs" }, { workflow: build });
    expect(gen.kind).toBe("ask");
    const okGen = gen.kind === "ask" ? gen.askAbout.map(findingKey) : [];
    expect(check(TOOL.bash, { command: "  node gen.mjs " }, { workflow: build, confirmed: okGen })).toMatchObject({ kind: "pass" });
    expect(check(TOOL.bash, { command: "node gen.mjs --all" }, { workflow: build, confirmed: okGen })).toMatchObject({ kind: "ask" });

    const push: GuardWorkflow = { ...notes, steps: [{ id: "s1", title: "推送", tool: TOOL.git_push, args: { remote: "origin", branch: "main" }, after: [] }] };
    const dev = check(TOOL.git_push, { remote: "origin", branch: "dev" }, { workflow: push });
    const okDev = dev.kind === "ask" ? dev.askAbout.map(findingKey) : [];
    expect(okDev).toHaveLength(1);
    expect(check(TOOL.git_push, { remote: "origin", branch: "dev" }, { workflow: push, confirmed: okDev }).kind).not.toBe("ask");
    expect(check(TOOL.git_push, { remote: "origin", branch: "feature" }, { workflow: push, confirmed: okDev })).toMatchObject({ kind: "ask" });
  });

  it("不被通用 bash 绕过：bash 里的 git push 对不上推送那一步（计划外，问用户），不算做过它", () => {
    const wf: GuardWorkflow = { ...notes, steps: [{ id: "s1", title: "推送", tool: TOOL.git_push, args: { remote: "origin", branch: "main" }, after: [] }] };
    const o = check(TOOL.bash, { command: "git push origin main" }, { workflow: wf });
    expect(o).toMatchObject({ kind: "ask", assessment: { offPlan: true } });
    expect(o.assessment.matchedStep).toBeUndefined();
  });
});

describe("顺序错：引回前置步骤", () => {
  it("前置步骤没做：这次先不执行，告诉维护者先做哪一步、参数是什么；不打扰用户", () => {
    const o = check(TOOL.read, { path: "notes.md" });
    expect(o.kind).toBe("redirect");
    if (o.kind !== "redirect") return;
    expect(o.text).toBe(
      '【自动纠偏】这一步先不执行：步骤 s2 依赖的 s1 还没有执行。按用户已授权的计划，应先执行步骤 s1「写笔记」：调用 write，参数 {"path":"notes.md","content":"# 周报\\n"}。做完再回来执行原来这一步。这是按计划纠偏，不需要询问用户。',
    );
    expect(o.spent).toBe("read|s2");
    expect(o.assessment.correction).toMatchObject({ kind: "redirect", stepId: "s2", target: { id: "s1", title: "写笔记", tool: TOOL.write }, text: "缺了前置步骤：先让维护者做「写笔记」，再回来执行这一步" });
  });

  it("说明跳过的前置步骤不算没做", () => {
    expect(check(TOOL.read, { path: "notes.md" }, { workflow: { ...notes, skipped: ["s1"] } })).toMatchObject({ kind: "pass", assessment: { stepId: "s2" } });
  });

  it(`同一步自动修了 ${MAX_AUTO_FIX} 次还对不上：不再自己修，问用户`, () => {
    const o = check(TOOL.read, { path: "notes.md" }, { corrections: { "read|s2": MAX_AUTO_FIX } });
    expect(o.kind).toBe("ask");
    if (o.kind !== "ask") return;
    expect(o.askAbout).toEqual([{ kind: "out_of_order", message: "步骤 s2 依赖的 s1 还没有执行", verdict: "confirm" }]);
  });
});

describe("违反时序规则时按计划修", () => {
  it("规则的修法是先插一步、计划里正好有还没做的那一步：引回它（推送之前要跑过测试）", () => {
    const wf: GuardWorkflow = {
      ...notes,
      steps: [
        { id: "p1", title: "跑测试", tool: TOOL.run_tests, args: {}, after: [] },
        { id: "s1", title: "推送", tool: TOOL.git_push, args: { remote: "origin", branch: "main" }, after: [] },
      ],
    };
    const o = check(TOOL.git_push, { remote: "origin", branch: "main" }, { workflow: wf, extra: { effectLog: [], facts: { git: { [P.workDir]: { uncommittedPaths: [], head: "new" } } } } });
    expect(o.kind).toBe("redirect");
    if (o.kind !== "redirect") return;
    expect(o.assessment.correction).toMatchObject({ kind: "redirect", target: { id: "p1" } });
    expect(o.assessment.correction?.findings.map((f) => f.kind)).toEqual([`rule:${V1_TEMPLATE_IDS.testBeforePush}`]);
  });

  it("参数和计划对不上导致违反：按计划改回（认对象的参数不改），改后两道都通过才放行", () => {
    const rule: TemporalRule = {
      id: "weekly-title",
      title: "笔记以「# 周报」开头",
      trigger: { tool: TOOL.write },
      require: { check: { startswith: ["$current.args.content", "# 周报"] } },
      on_violation: "pull_back",
    };
    const o = check(TOOL.write, { path: "notes.md", content: "# 笔记\n" }, { rules: [rule] });
    expect(o.kind).toBe("rewrite");
    if (o.kind !== "rewrite") return;
    expect(o.args).toEqual({ path: "notes.md", content: "# 周报\n" });
    expect(o.spent).toBe("write|s1");
    expect(o.judgement.pullBack).toBeNull();
    expect(o.assessment.correction).toMatchObject({ kind: "rewrite", stepId: "s1", changes: [{ arg: "content", from: "# 笔记\n", to: "# 周报\n" }], text: "参数和计划对不上，已按计划改回：content # 笔记\n → # 周报\n" });
    // 改的是别的文件（认对象的参数）：不改，交回第一道（按规则退回）
    expect(check(TOOL.write, { path: "other.md", content: "# 笔记\n" }, { rules: [rule] }).kind).toBe("ask");
  });

  it("没有对应修法的违反（规则没写修法、判断不了）不修：交回第一道", () => {
    const rule: TemporalRule = { id: "no-read", title: "不许读", trigger: { tool: TOOL.read }, on_violation: "pull_back" };
    expect(check(TOOL.read, { path: "notes.md" }, { rules: [rule], history: [{ tool: TOOL.write, step: "s1" }] })).toMatchObject({ kind: "pass" });
  });
});

describe("重复、禁止：直接拦下，不问用户、也不自动修", () => {
  const push: GuardWorkflow = { ...notes, steps: [{ id: "s1", title: "推送", tool: TOOL.git_push, args: { remote: "origin", branch: "main" }, after: [] }] };

  it("只许做一次的（推送、建远端仓库）做第二次", () => {
    const o = check(TOOL.git_push, { remote: "origin", branch: "main" }, { workflow: push, history: [{ tool: TOOL.git_push, step: "s1" }] });
    expect(o).toMatchObject({ kind: "block", reason: "步骤 s1 只能执行一次" });
    expect(kinds(o)).toEqual(["repeat"]);
  });

  it("通用 bash 的步骤里往外送的（发布：命中了对外发送）也只许做一次；不往外送的可以再做", () => {
    const publish: GuardWorkflow = { ...notes, steps: [{ id: "s1", title: "发布", tool: TOOL.bash, args: { command: "npm publish" }, after: [] }] };
    expect(check(TOOL.bash, { command: "npm publish" }, { workflow: publish, history: [{ tool: TOOL.bash, step: "s1" }] })).toMatchObject({ kind: "block", reason: "步骤 s1 只能执行一次" });
    const build: GuardWorkflow = { ...notes, steps: [{ id: "s1", title: "构建", tool: TOOL.bash, args: { command: "node build.mjs" }, after: [] }] };
    expect(check(TOOL.bash, { command: "node build.mjs" }, { workflow: build, history: [{ tool: TOOL.bash, step: "s1" }] })).toMatchObject({ kind: "pass", assessment: { matchedStep: "s1" } });
  });

  it("审查时从步骤里剔除的对象", () => {
    const wf: GuardWorkflow = { ...notes, steps: [{ id: "s1", title: "提交", tool: TOOL.git_commit, args: { message: "x", paths: ["a.md"] }, after: [], excluded: { paths: ["secret.md"] } }] };
    const o = check(TOOL.git_commit, { message: "x", paths: ["a.md", "secret.md"] }, { workflow: wf });
    expect(o).toMatchObject({ kind: "block", reason: "这个对象在审查时被明确排除在计划之外" });
  });
});

describe("收尾：还没执行、也没说明跳过的步骤", () => {
  it("执行过（对上了这一步）的、说明跳过的不算", () => {
    expect(planPending(notes, []).map((f) => f.step)).toEqual(["s1", "s2"]);
    expect(planPending(notes, [{ tool: TOOL.write, step: "s1" }])).toEqual([
      { kind: "skipped", message: "计划步骤 s2「读一遍笔记」没有执行", verdict: "confirm", step: "s2" },
    ]);
    expect(planPending({ ...notes, skipped: ["s2"] }, [{ tool: TOOL.write, step: "s1" }])).toEqual([]);
  });
});
