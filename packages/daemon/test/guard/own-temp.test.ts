// 守卫切面：临时文件（111 号票，用户 2026-10-13 定："覆盖和删除的限制，只对系统已有的资源、数据、配置以及项目阶段交付件。
// 如果是任务中间的临时文件和脚本，以及为了生成每个项目阶段交付件临时生成的脚本和数据，默认可以修改或者删除"；又补充"任务和项目的
// 临时文件都是一样的"）。调用方给了 GuardInput.ownWork（项目的 agent 按项目，项目外任务的 agent 按任务）时，删除、整体重写临时文件：
// - 不落入"删除或覆盖"、不受 v1 模板"删除或覆盖之前必须已备份或已提交"约束（不退回、不标敏感）；
// - 认法：在 agent 的工作目录里（项目档案不算，真实路径也要在里面）；范围开始之后才有的——效果日志里（同一个范围）有一次调用
//   新建了它（EffectRecord.created），或者创建时间（FileFact.createdAt）晚于范围开始；不是交付件——交出去了的阶段的交付件写到的路径，
//   产出区里（交付件认不出路径时工作目录里）最近一次交出去时已经有了的；
// - 递归删除目录：它自己和里面的东西（FileFact.contents）都得是，列不全的不算；带通配符的，展开成的每一个都得是；
// - 项目里不要求是哪一张工单、哪一个任务建的（前一张工单建的靠创建时间认），维护者直接和用户对话时也一样。
// 照旧的：开始之前就在的、认不出的（创建时间读不到又没有效果日志的记录、路径没法确定）、交出去了的交付件、项目档案、
// 不给 ownWork 的（秘书、项目外任务的起草计划）。
import { describe, expect, it } from "vitest";
import {
  BUILTIN_TOOL_REGISTRY,
  type EnvironmentFacts,
  type FileFact,
  type GuardInput,
  type GuardJudgement,
  type GuardOwnWork,
  judgeToolCall,
  type ToolCall,
  V1_TEMPLATE_IDS,
} from "../../src/guard/index.ts";
import { ruleStep } from "../../src/guard/rule-steps.ts";
import { bash, call, effect, inChat, inTask, maintainer, NOW, P, secretary, subAgent } from "./helpers/guard-input.ts";

const W = P.workDir;
const at = (name: string) => `${W}\\${name}`;
/** 任务两小时前开始 */
const STARTED = NOW - 2 * 60 * 60_000;
const AFTER = STARTED + 60_000;
const BEFORE = STARTED - 60_000;
const BACKUP = V1_TEMPLATE_IDS.backupBeforeOverwrite;

const ownWork = (overrides: Partial<GuardOwnWork> = {}): GuardOwnWork => ({ startedAt: STARTED, deliverables: [], handovers: [], ...overrides });
const OUTPUTS = "D:\\ergo-data\\outputs\\task-1";
/** 工作目录不在 git 里：v1 模板"删除或覆盖之前必须已备份或已提交"判得了（没提交、没备份就退回） */
const NOT_REPO: EnvironmentFacts = { git: { [W]: { uncommittedPaths: [], repository: false } } };
const file = (createdAt?: number, extra: Partial<FileFact> = {}): FileFact => ({ exists: true, isDirectory: false, ...(createdAt === undefined ? {} : { createdAt }), ...extra });
/** 效果日志里本任务新建它的那次调用（写文件） */
const created = (seq: number, name: string, overrides: Parameters<typeof effect>[3] = {}) =>
  effect(seq, "write", { path: at(name), content: "…" }, { created: [at(name)], at: STARTED + seq * 60_000, ...overrides });

function judge(toolCall: ToolCall, files: Record<string, FileFact>, extra: Partial<GuardInput> = {}): GuardJudgement {
  return judgeToolCall(inTask(maintainer(), toolCall, { ownWork: ownWork(), facts: { ...NOT_REPO, files }, ...extra }));
}

/** 判定的要点：处置、硬拒绝、按规则退回、命中的类别和时序规则 */
const gist = (j: GuardJudgement) => ({
  disposition: j.disposition,
  hardRefusal: j.hardRefusal,
  pullBack: j.pullBack,
  categories: j.categories,
  rules: j.temporalRules.map((h) => h.ruleId),
});
/** 放开了：不落"删除或覆盖"、不退回、没有时序规则命中，直接做 */
const FREE = { disposition: "log_only", hardRefusal: null, pullBack: null, categories: [], rules: [] };
/** 照旧：落入"删除或覆盖"（任务里做完告诉我），没备份、没提交就按规则退回 */
const GUARDED = { disposition: "notify_after", hardRefusal: null, pullBack: [BACKUP], categories: ["delete_or_overwrite"], rules: [BACKUP] };

describe("任务自己新建的脚本、中间数据：重写、删除不落类别、不退回", () => {
  it("效果日志里有本任务新建它的记录：整体重写（write）、删除（rm）都直接做", () => {
    const facts = { [at("gen.js")]: file() };
    const log = { effectLog: [created(1, "gen.js")] };
    expect(gist(judge(call("write", { path: "gen.js", content: "改过的脚本" }), facts, log))).toEqual(FREE);
    expect(gist(judge(bash("rm gen.js"), facts, log))).toEqual(FREE);
    expect(gist(judge(bash("rm -f gen.js && echo 删了"), facts, log))).toEqual(FREE);
  });

  it("创建时间晚于任务开始（脚本里间接生成、守卫没看见的）：认作临时，删除、覆盖直接做", () => {
    const facts = { [at("data.json")]: file(AFTER), [at("out.csv")]: file(AFTER) };
    expect(gist(judge(bash("rm data.json out.csv"), facts))).toEqual(FREE);
    expect(gist(judge(call("write", { path: "data.json", content: "{}" }), facts))).toEqual(FREE);
    // cp 覆盖、mv 改名（源和目标）
    expect(gist(judge(bash("cp out.csv data.json"), facts))).toEqual(FREE);
    expect(gist(judge(bash("mv data.json out.csv"), facts))).toEqual(FREE);
  });

  it("子 agent 也一样（同一个任务）；效果日志里是维护者新建的也算", () => {
    const j = judgeToolCall(inTask(subAgent(), bash("rm gen.js"), { ownWork: ownWork(), facts: { ...NOT_REPO, files: { [at("gen.js")]: file() } }, effectLog: [created(1, "gen.js")] }));
    expect(gist(j)).toEqual(FREE);
  });

  it("同一个任务的前几个阶段建的也算：效果日志里是 s1 新建的，s2 里删", () => {
    const j = judge(bash("rm gen.js"), { [at("gen.js")]: file() }, { effectLog: [created(1, "gen.js", { stageId: "s1" })], task: { taskId: "task-1", currentStageId: "s2", plan: { grants: [] } } });
    expect(gist(j)).toEqual(FREE);
  });

  it("还在做的阶段里改自己的交付件草稿（阶段还没交出去，交付件不在 ownWork 里）：直接做", () => {
    expect(gist(judge(call("write", { path: "report.md", content: "第二稿" }), { [at("report.md")]: file(AFTER) }, { effectLog: [created(1, "report.md")] }))).toEqual(FREE);
  });
});

describe("系统已有的照旧：落入删除或覆盖、没备份就退回", () => {
  it("任务开始之前就在的文件（创建时间早于任务开始，不管是谁建的）", () => {
    const facts = { [at("old.md")]: file(BEFORE) };
    expect(gist(judge(call("write", { path: "old.md", content: "重写" }), facts))).toEqual(GUARDED);
    expect(gist(judge(bash("rm old.md"), facts))).toEqual(GUARDED);
    expect(judge(bash("rm old.md"), facts).explanation).toMatch(/^退回：.*还没有 git 提交、也没有备份/);
  });

  it("认不出的按已有的算：创建时间读不到、效果日志里也没有新建它的记录", () => {
    expect(gist(judge(bash("rm notes.txt"), { [at("notes.txt")]: file() }))).toEqual(GUARDED);
    // 没有这个文件的环境事实（不知道是文件还是目录）
    expect(gist(judge(bash("rm gen.js"), {}, { effectLog: [created(1, "gen.js")] }))).toEqual(GUARDED);
  });

  it("效果日志里是别的任务新建的：不算这个任务的", () => {
    expect(gist(judge(bash("rm gen.js"), { [at("gen.js")]: file() }, { effectLog: [created(1, "gen.js", { taskId: "task-2" })] }))).toEqual(GUARDED);
  });

  it("效果日志里写过它、但写之前它就在（没记 created）：不算新建", () => {
    const rewrote = effect(1, "write", { path: at("old.md"), content: "…" }, { at: AFTER });
    expect(gist(judge(bash("rm old.md"), { [at("old.md")]: file(BEFORE) }, { effectLog: [rewrote] }))).toEqual(GUARDED);
  });

  it("真实路径在工作目录之外（经目录联接）：不算临时，照旧落入删除或覆盖（越出项目目录照旧；v1 模板按项目外的路径不管）", () => {
    const j = judge(bash("rm link/x.txt"), { [at("link\\x.txt")]: file(AFTER, { realPath: `${P.outside}\\x.txt` }) });
    expect(j.categories).toEqual(["outside_project", "delete_or_overwrite"]);
  });

  it("项目档案一律不算临时文件（运行时自动留旧版本，不退回；照旧落入删除或覆盖）", () => {
    const progress = `${P.records}\\progress.md`;
    const j = judge(call("write", { path: progress, content: "整篇重写" }), { [progress]: file(AFTER, { backedUp: true }) });
    expect([j.categories, j.pullBack]).toEqual([["delete_or_overwrite"], null]);
  });

  it("路径没法确定的照旧", () => {
    const j = judge(bash('rm "$TMP_FILE"'), {});
    expect(j.categories).toContain("delete_or_overwrite");
  });

  it("不给 ownWork（秘书、项目外任务的起草计划）：照旧", () => {
    const facts = { ...NOT_REPO, files: { [at("gen.js")]: file(AFTER) } };
    expect(gist(judgeToolCall(inTask(maintainer(), bash("rm gen.js"), { facts, effectLog: [created(1, "gen.js")] })))).toEqual(GUARDED);
    const chat = judgeToolCall(inChat(maintainer(), bash("rm gen.js"), { facts, effectLog: [created(1, "gen.js", { taskId: null })] }));
    expect(chat.categories).toContain("delete_or_overwrite");
    // 秘书的草稿区本来就不受约束
    const scratch = judgeToolCall(inChat(secretary(), bash("rm a.txt"), { ownWork: ownWork(), facts: { files: { [`${P.scratch}\\a.txt`]: file(BEFORE) } } }));
    expect([scratch.categories, scratch.pullBack]).toEqual([[], null]);
  });
});

describe("交付件：交出去之后照旧受保护", () => {
  it("交出去了的阶段的交付件写到的路径：本任务新建的也照旧（相对路径按工作目录解析，目录连同里面的）", () => {
    const own = { ownWork: ownWork({ deliverables: ["report.md", "charts/"] }), effectLog: [created(1, "report.md"), created(2, "charts\\a.png")] };
    expect(gist(judge(call("write", { path: "report.md", content: "重写" }), { [at("report.md")]: file(AFTER) }, own))).toEqual(GUARDED);
    expect(gist(judge(bash("rm charts/a.png"), { [at("charts\\a.png")]: file(AFTER) }, own))).toEqual(GUARDED);
    // 别的文件照样是临时的
    expect(gist(judge(bash("rm gen.js"), { [at("gen.js")]: file(AFTER) }, own))).toEqual(FREE);
  });

  it("写成绝对路径的交付件", () => {
    const own = { ownWork: ownWork({ deliverables: [at("final\\summary.md")] }) };
    expect(gist(judge(bash("rm final/summary.md"), { [at("final\\summary.md")]: file(AFTER) }, own))).toEqual(GUARDED);
  });

  it("产出区里最近一次交出去时已经有了的算交付件；之后才有的还是临时的", () => {
    const HANDED = STARTED + 30 * 60_000;
    const own = { ownWork: ownWork({ handovers: [{ dir: W, at: HANDED }] }) };
    expect(gist(judge(bash("rm s1-helper.js"), { [at("s1-helper.js")]: file(HANDED - 60_000) }, own))).toEqual(GUARDED);
    expect(gist(judge(bash("rm s2-helper.js"), { [at("s2-helper.js")]: file(HANDED + 60_000) }, own))).toEqual(FREE);
    // 效果日志里新建它的那次在交出去之前
    expect(gist(judge(bash("rm gen.js"), { [at("gen.js")]: file() }, { ...own, effectLog: [created(1, "gen.js")] }))).toEqual(GUARDED);
  });

  it("交付件认不出路径（不写 dir）：工作目录按产出区算——交出去时已经有了的照旧，之后才有的放开", () => {
    const HANDED = STARTED + 30 * 60_000;
    const own = { ownWork: ownWork({ handovers: [{ dir: OUTPUTS, at: HANDED }, { at: HANDED }] }) };
    expect(gist(judge(bash("rm a.md"), { [at("a.md")]: file(HANDED - 1) }, own))).toEqual(GUARDED);
    expect(gist(judge(bash("rm b.md"), { [at("b.md")]: file(HANDED + 1) }, own))).toEqual(FREE);
    // 认得出路径的：工作目录不是产出区，交出去之前建的临时文件照样放开
    expect(gist(judge(bash("rm a.md"), { [at("a.md")]: file(HANDED - 1) }, { ownWork: ownWork({ handovers: [{ dir: OUTPUTS, at: HANDED }] }) }))).toEqual(FREE);
    // 记不起交出去的时间：工作目录里的一律算交付件
    expect(gist(judge(bash("rm b.md"), { [at("b.md")]: file(HANDED + 1) }, { ownWork: ownWork({ handovers: [{}] }) }))).toEqual(GUARDED);
  });
});

/** 项目维护者在一段会话（工单段、对话段）里：不属于任务，效果日志只看这一段 */
const inSegment = (toolCall: ToolCall, files: Record<string, FileFact>, extra: Partial<GuardInput> = {}) =>
  judgeToolCall(inChat(maintainer(), toolCall, { segmentId: "maintainer-notes:wo-2", ownWork: ownWork(), facts: { ...NOT_REPO, files }, ...extra }));

/** 要删除的目录（创建时间），连同里面有什么（相对工作目录的路径和创建时间）、列全了没有 */
const dir = (createdAt: number | undefined, entries: Array<[string, number | undefined]>, complete = true): FileFact =>
  file(createdAt, { isDirectory: true, contents: { complete, entries: entries.map(([name, t]) => ({ path: at(name), ...(t === undefined ? {} : { createdAt: t }) })) } });

describe("项目里按项目认（用户补充：任务和项目的临时文件都是一样的）", () => {
  it("前一张工单建的临时脚本，下一张工单删：效果日志看不到（别的段），靠创建时间认出来，不拦", () => {
    const earlier = created(1, "gen.js", { taskId: null, stageId: null, segmentId: "maintainer-notes:wo-1" });
    const j = inSegment(bash("rm gen.js"), { [at("gen.js")]: file(AFTER) }, { effectLog: [earlier] });
    expect([j.disposition, j.pullBack, j.categories, j.temporalRules]).toEqual(["log_only", null, [], []]);
    // 效果日志看不到、创建时间也读不到：认不出，照旧（对话里删除或覆盖先问，先按规则退回）
    const unknown = inSegment(bash("rm gen.js"), { [at("gen.js")]: file() }, { effectLog: [earlier] });
    expect([unknown.categories, unknown.pullBack]).toEqual([["delete_or_overwrite"], [BACKUP]]);
  });

  it("维护者直接和用户对话（不属于任务）：删项目里自己先前生成的中间数据，不拦", () => {
    const j = inSegment(bash("rm -f data.json && rm -rf tmp"), {
      [at("data.json")]: file(AFTER),
      [at("tmp")]: file(AFTER, { isDirectory: true, contents: { complete: true, entries: [{ path: at("tmp\\a.csv"), createdAt: AFTER }] } }),
    });
    expect([j.disposition, j.pullBack, j.categories]).toEqual(["log_only", null, []]);
  });

  it("项目开始之前就在工作目录里的文件：照旧拦（对话里先问，先按规则退回）", () => {
    const j = inSegment(bash("rm notes.md"), { [at("notes.md")]: file(BEFORE) });
    expect([j.disposition, j.categories, j.pullBack]).toEqual(["ask_first", ["delete_or_overwrite"], [BACKUP]]);
  });

  it("项目里各任务交出去的交付件照旧（命名的、按时间认的）", () => {
    const HANDED = AFTER + 60_000;
    const own = { ownWork: ownWork({ deliverables: ["report.md"], handovers: [{ at: HANDED }] }) };
    expect(inSegment(bash("rm report.md"), { [at("report.md")]: file(HANDED + 60_000) }, own).pullBack).toEqual([BACKUP]);
    expect(inSegment(bash("rm draft.md"), { [at("draft.md")]: file(HANDED - 1) }, own).pullBack).toEqual([BACKUP]);
    expect(inSegment(bash("rm next.md"), { [at("next.md")]: file(HANDED + 1) }, own).pullBack).toBeNull();
  });
});

describe("递归删除一个目录：里面全是这个任务的临时文件才放开", () => {
  it("目录和里面的都是任务开始之后才有的：直接做", () => {
    expect(gist(judge(bash("rm -rf tmp"), { [at("tmp")]: dir(AFTER, [["tmp\\a.json", AFTER], ["tmp\\sub", AFTER], ["tmp\\sub\\b.json", AFTER]]) }))).toEqual(FREE);
    // 里面的东西靠效果日志认出来也行
    expect(gist(judge(bash("rm -rf tmp"), { [at("tmp")]: dir(AFTER, [["tmp\\gen.js", undefined]]) }, { effectLog: [created(1, "tmp\\gen.js")] }))).toEqual(FREE);
  });

  it("夹着已有的：照旧", () => {
    expect(gist(judge(bash("rm -rf tmp"), { [at("tmp")]: dir(AFTER, [["tmp\\a.json", AFTER], ["tmp\\old.json", BEFORE]]) }))).toEqual(GUARDED);
    expect(gist(judge(bash("rm -rf tmp"), { [at("tmp")]: dir(AFTER, [["tmp\\a.json", AFTER], ["tmp\\unknown.json", undefined]]) }))).toEqual(GUARDED);
  });

  it("夹着交出去了的交付件：照旧", () => {
    expect(gist(judge(bash("rm -rf out"), { [at("out")]: dir(AFTER, [["out\\report.md", AFTER], ["out\\tmp.json", AFTER]]) }, { ownWork: ownWork({ deliverables: ["out/report.md"] }) }))).toEqual(GUARDED);
  });

  it("目录本身是任务开始之前就在的、里面列不全（太多、有链接）、没给里面有什么：照旧", () => {
    expect(gist(judge(bash("rm -rf tmp"), { [at("tmp")]: dir(BEFORE, [["tmp\\a.json", AFTER]]) }))).toEqual(GUARDED);
    expect(gist(judge(bash("rm -rf tmp"), { [at("tmp")]: dir(AFTER, [["tmp\\a.json", AFTER]], false) }))).toEqual(GUARDED);
    expect(gist(judge(bash("rm -rf tmp"), { [at("tmp")]: file(AFTER, { isDirectory: true }) }))).toEqual(GUARDED);
  });
});

describe("带通配符的删除：展开成的每一个都得是", () => {
  const glob = at("tmp\\*.json");
  it("展开成的都是临时的：直接做；有一个是已有的、展不开的：照旧", () => {
    const facts = (b: number): EnvironmentFacts => ({
      ...NOT_REPO,
      files: { [glob]: { exists: false }, [at("tmp\\a.json")]: file(AFTER), [at("tmp\\b.json")]: file(b) },
      wildcards: { [glob]: [at("tmp\\a.json"), at("tmp\\b.json")] },
    });
    expect(gist(judgeToolCall(inTask(maintainer(), bash("rm tmp/*.json"), { ownWork: ownWork(), facts: facts(AFTER) })))).toEqual(FREE);
    expect(gist(judgeToolCall(inTask(maintainer(), bash("rm tmp/*.json"), { ownWork: ownWork(), facts: facts(BEFORE) })))).toEqual(GUARDED);
    const unexpanded: EnvironmentFacts = { ...NOT_REPO, files: { [glob]: { exists: false } }, wildcards: { [glob]: [at("tmp")] } };
    expect(gist(judgeToolCall(inTask(maintainer(), bash("rm tmp/*.json"), { ownWork: ownWork(), facts: unexpanded })))).toEqual(GUARDED);
  });
});

describe("v1 模板第 1 条：任务自己的临时文件除外", () => {
  it("规则看到的路径上标着 ownTemp（判定函数认出来交给规则；不给认法的都是 false）", () => {
    const view = { tools: BUILTIN_TOOL_REGISTRY, env: { cwd: W, homeDir: P.home }, agent: maintainer(), facts: { files: { [at("gen.js")]: file(AFTER) } } };
    const source = { id: "c1", tool: "delete", args: { path: at("gen.js") } };
    expect(ruleStep(view, source).paths).toMatchObject([{ path: at("gen.js"), replaced: true, area: "project", ownTemp: false }]);
    expect(ruleStep({ ...view, ownTemp: (p: string) => p === at("gen.js") }, source).paths).toMatchObject([{ ownTemp: true }]);
  });

  it("同一条命令里一个临时、一个已有：只退回已有的那个", () => {
    const j = judge(bash("rm gen.js old.md"), { [at("gen.js")]: file(AFTER), [at("old.md")]: file(BEFORE) });
    expect(gist(j)).toEqual(GUARDED);
    expect(j.findings.find((f) => f.kind === "pull_back")?.message).toContain(`「${at("old.md")}」`);
    expect(j.findings.find((f) => f.kind === "pull_back")?.message).not.toContain(`「${at("gen.js")}」`);
    expect(j.findings.find((f) => f.kind === "category" && f.id === "delete_or_overwrite")?.message).toContain(`要删除 ${at("old.md")}，`);
  });

  it("已经提交、已经备份的照旧满足（不因为临时与否改变）", () => {
    const committed = judge(bash("rm old.md"), { [at("old.md")]: file(BEFORE) }, { facts: { git: { [W]: { uncommittedPaths: [] } }, files: { [at("old.md")]: file(BEFORE) } } });
    expect([committed.categories, committed.pullBack]).toEqual([["delete_or_overwrite"], null]);
  });
});

describe("工作目录本身、.git 和它里面的东西一律不算临时文件（评审返修）", () => {
  it("开发类项目确认立项书时才 git init、工作目录建项目之后才建（创建时间都晚于开始）：删 .git、删整个工作目录照旧", () => {
    expect(gist(judge(bash("rm -rf .git"), { [at(".git")]: dir(AFTER, [[".git\\HEAD", AFTER], [".git\\objects", AFTER]]) }))).toEqual(GUARDED);
    expect(gist(judge(bash("rm .git/index"), { [at(".git\\index")]: file(AFTER) }))).toEqual(GUARDED);
    expect(judge(bash(`rm -rf "${W.replaceAll("\\", "/")}"`), { [W]: dir(AFTER, [["gen.js", AFTER]]) }).pullBack).toEqual([BACKUP]);
    // 递归删一个装着仓库的目录
    expect(gist(judge(bash("rm -rf sub"), { [at("sub")]: dir(AFTER, [["sub\\a.js", AFTER], ["sub\\.git", AFTER], ["sub\\.git\\HEAD", AFTER]]) }))).toEqual(GUARDED);
    // 名字只是带着 .git 的照样是临时的
    expect(gist(judge(bash("rm .gitignore.tmp"), { [at(".gitignore.tmp")]: file(AFTER) }))).toEqual(FREE);
  });
});
