// 守卫切面：流程的步骤推出的授权项（58 号票评审、复审后定，guard/workflow-steps.ts 的 workflowGrants）：
// - 步骤里写死的参数全部进对象范围（路径解析成绝对路径，数字、真假按字面）；
// - 非 bash 的步骤只认步骤里写了的参数（exactArgs）：多带了别的参数、参数值不同都算超出；
// - 通用 bash 的步骤按拆出来的伪工具各一项，再限定到这条命令本身（Grant.command）；
// - 路径按真实路径比（realScope）：规划时取不到真实路径的不发授权，执行时真实路径变了、取不到的不放行；
// - 对象不确定的不发授权（变量、拆不开的命令、推送没写明远端和分支）；
// - 次数按步骤数算（一步里出现几次也只算一次）。
// 推出的授权项交给判定函数：同一条命令、同样的参数放行，换了命令、多带参数、超出次数、真实路径对不上的照常问用户。
// 判定函数是纯函数，真实路径由调用方现取后放进 facts，这里写成虚构的事实；真的目录联接见 test/tasks/workflow-plan.test.ts。
import { describe, expect, it } from "vitest";
import { BUILTIN_TOOL_REGISTRY, effectLogArgs, type EnvironmentFacts, type Grant, judgeToolCall, TOOL, workflowGrants } from "../../src/guard/index.ts";
import { bash, call, effect, inTask, maintainer, NOW, P, task, v1Satisfied } from "./helpers/guard-input.ts";

const agent = maintainer();
const NOTES = `${P.workDir}\\notes.md`;
const SUB = `${P.workDir}\\sub`;

/** 文件事实：每个路径的真实路径（不给就是它自己） */
const filesOf = (paths: Record<string, string>): EnvironmentFacts => ({
  files: Object.fromEntries(Object.entries(paths).map(([p, real]) => [p, { exists: true, isDirectory: false, realPath: real }])),
});
const plain = filesOf({ [NOTES]: NOTES, [SUB]: SUB, [P.workDir]: P.workDir });

const grantsOf = (steps: Array<{ id: string; tool: string; args: Record<string, unknown> }>, facts: EnvironmentFacts = plain) =>
  workflowGrants(steps, { tools: BUILTIN_TOOL_REGISTRY, agent, homeDir: P.home, facts });
const step = (id: string, tool: string, args: Record<string, unknown>) => ({ id, tool, args });

/** 推出的授权项挂到当前阶段 s1 上（toGuardGrant 的样子） */
const asGuardGrants = (drafts: ReturnType<typeof grantsOf>): Grant[] =>
  drafts.map((g, i) => ({
    grantId: `g${i + 1}`,
    tool: g.tool,
    scope: g.scope,
    maxUses: g.maxUses,
    ...(g.realScope === undefined ? {} : { realScope: g.realScope }),
    ...(g.exactArgs ? { exactArgs: true as const } : {}),
    ...(g.command === undefined ? {} : { command: g.command }),
    stageId: "s1",
    grantedAt: NOW - 60_000,
  }));

describe("推出的授权项", () => {
  it("带类型的工具：写死的参数全部进对象范围（路径换成绝对路径，真假按字面），只认写了的参数，次数是 1", () => {
    expect(grantsOf([step("s1", TOOL.git_push, { remote: "origin", branch: "main", force: false })])).toEqual([
      { stepIds: ["s1"], tool: TOOL.git_push, scope: { remote: "origin", branch: "main", force: "false" }, maxUses: 1, exactArgs: true },
    ]);
    expect(grantsOf([step("s1", TOOL.write, { path: "notes.md", content: "x" })])).toEqual([
      { stepIds: ["s1"], tool: TOOL.write, scope: { path: NOTES, content: "x" }, realScope: { path: NOTES }, maxUses: 1, exactArgs: true },
    ]);
  });

  it("次数按步骤数算：同一个工具、同样的参数在两步里出现，合成一项、最多 2 次；一步里出现两次只算一次", () => {
    const push = { remote: "origin", branch: "main" };
    expect(grantsOf([step("s1", TOOL.git_push, push), step("s2", TOOL.run_tests, {}), step("s3", TOOL.git_push, push)])).toContainEqual(
      expect.objectContaining({ stepIds: ["s1", "s3"], tool: TOOL.git_push, maxUses: 2 }),
    );
    expect(grantsOf([step("s1", TOOL.bash, { command: "git push origin main && git push origin main" })])).toEqual([
      expect.objectContaining({ stepIds: ["s1"], tool: TOOL.git_push, maxUses: 1 }),
    ]);
  });

  it("通用 bash：按拆出来的伪工具各一项，限定到这条命令本身，不另限参数（命令定了参数也就定了）", () => {
    const [grant] = grantsOf([step("s1", TOOL.bash, { command: "git push origin main" })]);
    expect(grant).toEqual(
      expect.objectContaining({ stepIds: ["s1"], tool: TOOL.git_push, scope: expect.objectContaining({ remote: "origin", branch: "main" }), maxUses: 1, command: "git push origin main", text: "git push origin main" }),
    );
    expect(grant!.exactArgs).toBeUndefined();
  });

  it("路径的真实路径记进授权项（目录联接指到项目外的照实记）；规划时取不到真实路径的不发授权", () => {
    const linked = filesOf({ [SUB]: `${P.outside}\\repo` });
    expect(grantsOf([step("s1", TOOL.git_commit, { repoPath: "sub", message: "x" })], linked)).toEqual([
      expect.objectContaining({ scope: { repoPath: SUB, message: "x" }, realScope: { repoPath: `${P.outside}\\repo` } }),
    ]);
    expect(grantsOf([step("s1", TOOL.git_commit, { repoPath: "sub", message: "x" })], {})).toEqual([]);
  });

  it("对象不确定的不发授权：推送没写明远端和分支、命令里有变量、拆不开的命令", () => {
    expect(grantsOf([step("s1", TOOL.git_push, { remote: "origin" })])).toEqual([]);
    expect(grantsOf([step("s1", TOOL.bash, { command: "git push" })])).toEqual([]);
    expect(grantsOf([step("s1", TOOL.bash, { command: 'curl -X POST "$URL" -d hello' })]).filter((g) => g.tool === TOOL.http_request)).toEqual([]);
    expect(grantsOf([step("s1", TOOL.bash, { command: "eval $CMD" })])).toEqual([]);
  });
});

const judge = (toolCall: ReturnType<typeof call>, grants: Grant[], extra: Parameters<typeof inTask>[2] = {}) =>
  judgeToolCall(inTask(agent, toolCall, { ...v1Satisfied(), task: task({ plan: { grants } }), ...extra }));

/** v1 模板的前提照常满足，再加上路径的事实 */
const withFiles = (facts: EnvironmentFacts) => ({ facts: { ...v1Satisfied().facts, ...facts } });

/** 效果日志里对 notes.md 的一次写、改（68 号票起内容只记长度和摘要哈希） */
const storedEffect = (tool: string, args: Record<string, unknown>) =>
  effect(50, tool, effectLogArgs(tool, { path: NOTES, ...args }, BUILTIN_TOOL_REGISTRY), { at: NOW - 1000 });

describe("推出的授权项交给判定函数", () => {
  it("同一条命令放行（授权内）；换了命令（哪怕拆出来的调用一样）照常问用户", () => {
    const grants = asGuardGrants(grantsOf([step("s1", TOOL.bash, { command: "git push origin main" })]));
    expect(judge(bash("git push origin main"), grants, withFiles(plain))).toMatchObject({ withinGrant: true, disposition: "log_only" });
    const other = judge(bash("git push origin main; echo done"), grants);
    expect(other.withinGrant).toBe(false);
    expect(other.disposition).toBe("ask_first");
  });

  it("参数值和步骤写的不同（推到别的分支）不在授权内", () => {
    const grants = asGuardGrants(grantsOf([step("s1", TOOL.git_push, { remote: "origin", branch: "main", force: false })]));
    expect(judge(call(TOOL.git_push, { remote: "origin", branch: "main", force: false }), grants)).toMatchObject({ withinGrant: true });
    expect(judge(call(TOOL.git_push, { remote: "origin", branch: "dev", force: false }), grants).withinGrant).toBe(false);
  });

  it("步骤里没写的参数不受授权：建远端仓库只写了名字，执行时多带 visibility（私有变公开）照常问用户", () => {
    const grants = asGuardGrants(grantsOf([step("s1", TOOL.create_remote_repo, { name: "notes" })]));
    expect(grants).toEqual([expect.objectContaining({ scope: { name: "notes" }, exactArgs: true })]);
    expect(judge(call(TOOL.create_remote_repo, { name: "notes" }), grants)).toMatchObject({ withinGrant: true });
    const widened = judge(call(TOOL.create_remote_repo, { name: "notes", visibility: "public" }), grants);
    expect(widened.withinGrant).toBe(false);
    expect(widened.disposition).toBe("ask_first");
    expect(widened.explanation).toContain("多带了步骤里没写的参数 visibility");
  });

  it("只认写了的参数的授权项只放行直接调用：bash 里拆出来的同类调用（拆的时候认不出的旗标会丢）一律不算授权内", () => {
    const facts = withFiles(plain);
    const push = asGuardGrants(grantsOf([step("s1", TOOL.git_push, { repoPath: ".", remote: "origin", branch: "main", force: false })]));
    expect(judge(call(TOOL.git_push, { repoPath: ".", remote: "origin", branch: "main", force: false }), push, facts)).toMatchObject({ withinGrant: true });
    for (const command of ["git push origin main", "git push --delete origin main", "git push --tags origin main", "git push --all origin"]) {
      const judged = judge(bash(command), push, facts);
      expect({ command, withinGrant: judged.withinGrant, disposition: judged.disposition }).toEqual({ command, withinGrant: false, disposition: "ask_first" });
    }
    expect(judge(bash("git push --delete origin main"), push, facts).explanation).toContain("从通用 bash 拆出来的同类调用不算");
    // 提交、合并本身不落进内置类别：加一个"计划里列了才做"的自定义类别，看授权项管不管得到
    const settings = { custom: [{ id: "git", title: "提交和合并", match: { tools: [TOOL.git_commit, TOOL.git_merge] }, chat: "ask_first" as const, task: "plan_listed" as const }] };
    const commit = asGuardGrants(grantsOf([step("s1", TOOL.git_commit, { message: "x" })]));
    expect(judge(call(TOOL.git_commit, { message: "x" }), commit, { ...facts, settings }).withinGrant).toBe(true);
    expect(judge(bash('git commit --amend -m "x"'), commit, { ...facts, settings })).toMatchObject({ withinGrant: false, disposition: "ask_first" });
    const merge = asGuardGrants(grantsOf([step("s1", TOOL.git_merge, { branch: "dev" })]));
    expect(judge(call(TOOL.git_merge, { branch: "dev" }), merge, { ...facts, settings }).withinGrant).toBe(true);
    expect(judge(bash("git merge -s ours dev"), merge, { ...facts, settings })).toMatchObject({ withinGrant: false, disposition: "ask_first" });
    const repo = asGuardGrants(grantsOf([step("s1", TOOL.create_remote_repo, { name: "notes" })]));
    expect(judge(call(TOOL.create_remote_repo, { name: "notes" }), repo, facts).withinGrant).toBe(true);
    expect(judge(bash("gh repo create notes --push --source ."), repo, facts)).toMatchObject({ withinGrant: false, disposition: "ask_first" });
  });

  it("数组参数按内容精确比：步骤写的是 paths:[a.txt]，传空数组（提交全部改动）、少了、多了都不算授权内", () => {
    const A = `${P.workDir}\\a.txt`;
    const B = `${P.workDir}\\b.txt`;
    const files = filesOf({ [A]: A, [B]: B, [P.workDir]: P.workDir });
    const grants = asGuardGrants(grantsOf([step("s1", TOOL.git_commit, { paths: ["a.txt"], message: "x" })], files));
    expect(grants).toEqual([expect.objectContaining({ scope: { paths: [A], message: "x" }, realScope: { paths: [A] } })]);
    // 提交本身不落进哪个内置类别：加一个"计划里列了才做"的自定义类别，看授权项管不管得到
    const settings = { custom: [{ id: "commits", title: "提交", match: { tools: [TOOL.git_commit] }, chat: "ask_first" as const, task: "plan_listed" as const }] };
    const commit = (args: Record<string, unknown>) => judge(call(TOOL.git_commit, args), grants, { ...withFiles(files), settings });
    expect(commit({ paths: ["a.txt"], message: "x" }).withinGrant).toBe(true);
    for (const paths of [[], ["a.txt", "b.txt"], ["b.txt"]]) {
      const judged = commit({ paths, message: "x" });
      expect({ paths, withinGrant: judged.withinGrant, disposition: judged.disposition }).toEqual({ paths, withinGrant: false, disposition: "ask_first" });
    }
    expect(commit({ paths: [], message: "x" }).explanation).toContain("paths 是空的");
    // 没给 paths（也是提交全部）：调用里没有步骤写了的参数，不算
    expect(commit({ message: "x" }).withinGrant).toBe(false);
  });

  it("次数用完了照常问用户", () => {
    const grants = asGuardGrants(grantsOf([step("s1", TOOL.git_push, { remote: "origin", branch: "main" })]));
    const used = effect(50, TOOL.git_push, { repoPath: P.workDir, remote: "origin", branch: "main" }, { at: NOW - 1000 });
    const satisfied = v1Satisfied();
    const judged = judge(call(TOOL.git_push, { remote: "origin", branch: "main" }), grants, { effectLog: [...satisfied.effectLog, used] });
    expect(judged.withinGrant).toBe(false);
    expect(judged.disposition).toBe("ask_first");
  });

  it("写文件、改文件的次数照样按效果日志算：效果日志里内容只记了长度和摘要哈希（68 号票），按哈希比，和比原文一样", () => {
    // 写文件、改文件本身不落进内置类别：加一个"计划里列了才做"的自定义类别，看授权项管不管得到
    const settings = { custom: [{ id: "files", title: "写文件", match: { tools: [TOOL.write, TOOL.edit] }, chat: "ask_first" as const, task: "plan_listed" as const }] };
    const BODY = Array.from({ length: 20 }, (_, i) => `第 ${i + 1} 行`).join("\n");
    const edits = [
      { oldText: "第 1 行", newText: "第一行" },
      { oldText: "第 2 行", newText: "第二行" },
    ];
    const grants = asGuardGrants(grantsOf([step("w", TOOL.write, { path: "notes.md", content: BODY }), step("e", TOOL.edit, { path: "notes.md", edits })]));
    const judged = (toolCall: ReturnType<typeof call>, done: ReturnType<typeof effect>[]) =>
      judge(toolCall, grants, { ...withFiles(plain), settings, effectLog: [...v1Satisfied().effectLog, ...done] });
    const writeCall = call(TOOL.write, { path: "notes.md", content: BODY });
    const editCall = call(TOOL.edit, { path: "notes.md", edits });

    expect(judged(writeCall, []).withinGrant).toBe(true);
    expect(judged(editCall, []).withinGrant).toBe(true);
    // 同样的内容写过、改过一次：次数用完
    const used = judged(writeCall, [storedEffect(TOOL.write, { content: BODY })]);
    expect(used).toMatchObject({ withinGrant: false, disposition: "ask_first" });
    expect(used.explanation).toContain("次数已用完");
    expect(judged(editCall, [storedEffect(TOOL.edit, { edits: edits.toReversed() })]).withinGrant).toBe(false);
    // 写的、改的不是步骤里的内容：不算次数
    expect(judged(writeCall, [storedEffect(TOOL.write, { content: `${BODY}\n多一行` })]).withinGrant).toBe(true);
    expect(judged(editCall, [storedEffect(TOOL.edit, { edits: edits.slice(0, 1) })]).withinGrant).toBe(true);
    // （这次的调用里不会有缩过的样子：pi 在守卫之前按工具的 schema 校验过参数，写文件的内容得是字符串）
  });

  it("长程任务的授权项对象范围里写了内容（不只认写了的参数）：效果日志里缩过的按哈希比", () => {
    const settings = { custom: [{ id: "files", title: "写文件", match: { tools: [TOOL.write] }, chat: "ask_first" as const, task: "plan_listed" as const }] };
    const grant: Grant = { grantId: "w", tool: TOOL.write, scope: { content: ["日报", "周报"] }, maxUses: 1, stageId: "s1", grantedAt: NOW - 60_000 };
    const judged = (done: ReturnType<typeof effect>[]) =>
      judge(call(TOOL.write, { path: "notes.md", content: "日报" }), [grant], { ...withFiles(plain), settings, effectLog: [...v1Satisfied().effectLog, ...done] });
    expect(judged([]).withinGrant).toBe(true);
    expect(judged([storedEffect(TOOL.write, { content: "周报" })]).withinGrant).toBe(false);
    expect(judged([storedEffect(TOOL.write, { content: "月报" })]).withinGrant).toBe(true);
  });

  it("按真实路径比：sub 是指到项目外的目录联接——真实路径和规划时一样才放行；联接改指别处、取不到真实路径的照常问用户", () => {
    const planned = filesOf({ [SUB]: `${P.outside}\\repo` });
    const grants = asGuardGrants(grantsOf([step("s1", TOOL.git_commit, { repoPath: "sub", message: "x" })], planned));
    const commit = call(TOOL.git_commit, { repoPath: "sub", message: "x" });
    // 和规划时一样：越出项目目录（计划卡上标出来了），授权内
    const same = judge(commit, grants, withFiles(planned));
    expect(same.findings.some((f) => f.kind === "category" && f.id === "outside_project")).toBe(true);
    expect(same.withinGrant).toBe(true);
    // 联接改指别处
    const moved = judge(commit, grants, withFiles(filesOf({ [SUB]: `${P.outside}\\other` })));
    expect(moved.withinGrant).toBe(false);
    expect(moved.disposition).toBe("ask_first");
    expect(moved.explanation).toContain(`repoPath 的真实路径是 ${P.outside}\\other`);
    // 取不到真实路径
    const unknown = judge(commit, grants, withFiles({ files: { [SUB]: { exists: true, isDirectory: true } } }));
    expect(unknown.withinGrant).toBe(false);
  });
});
