// 守卫切面（26 号票）：处置的严格程度；自定义类别的确定规则按工具、路径、收件人、金额匹配（bash 拆出的伪工具调用同样适用），
// 两套处置可以是六档里的任何一档，和一同命中的类别取最严；本任务对全局自定义类别的调严跟着全局设置走。
import { describe, expect, it } from "vitest";
import {
  DISPOSITIONS,
  editWatchCategorySettings,
  isStricter,
  judgeToolCall,
  strictest,
  type CustomWatchCategory,
  type Disposition,
  type GuardInput,
  type WatchCategoryEdit,
  type WatchCategorySettings,
} from "../../src/guard/index.ts";
import { bash, call, DAY, inChat, inTask, maintainer, NOW, P, secretary, task, v1Satisfied } from "./helpers/guard-input.ts";
import { TEST_TOOLS } from "./helpers/test-tools.ts";

/** 规格第 9 节的六档，由松到严（独立写一遍，不从实现里取） */
const ORDER: Disposition[] = ["log_only", "notify_after", "plan_listed", "ask_first", "hand_over", "never"];

describe("处置按六档的顺序比较严格程度", () => {
  it("实现里的六档就是规格的顺序", () => {
    expect([...DISPOSITIONS]).toEqual(ORDER);
  });

  for (let i = 0; i < ORDER.length; i++) {
    for (let j = 0; j < ORDER.length; j++) {
      if (i === j) continue;
      const [a, b] = [ORDER[i]!, ORDER[j]!];
      it(`${a} 和 ${b}：${i > j ? a : b} 更严`, () => {
        expect(isStricter(a, b)).toBe(i > j);
        expect(strictest(a, b)).toBe(i > j ? a : b);
      });
    }
  }
});

const MIGRATIONS = `${P.workDir}\\db\\migrations`;
const migrations = (inTaskDisposition: Disposition, chat: Disposition = inTaskDisposition): CustomWatchCategory => ({
  id: "db-migrations",
  title: "动数据库迁移目录",
  match: { paths: [MIGRATIONS] },
  chat,
  task: inTaskDisposition,
});
const settingsWith = (...custom: CustomWatchCategory[]): WatchCategorySettings => ({ custom });
const withTools = (input: GuardInput): GuardInput => ({ ...input, tools: TEST_TOOLS });
/** 测试用的注册表，再加两个快速动作的伪工具 */
const quickTools = (input: GuardInput): GuardInput => ({
  ...input,
  tools: {
    ...TEST_TOOLS,
    "quick_action:send_note": { name: "quick_action:send_note", title: "发便条", source: "host", categories: [], args: { to: { kind: "recipient" } } },
    "quick_action:tidy_note": { name: "quick_action:tidy_note", title: "整理便条", source: "host", categories: [], args: {} },
  },
});
/** 对话里，维护者在工作目录里干活（v1 模板的前提先满足） */
const judgeInChat = (tc: ReturnType<typeof call>, settings: WatchCategorySettings) => judgeToolCall(quickTools(inChat(maintainer(), tc, { ...v1Satisfied(), settings })));
/** 判定的要点：处置、有没有硬拒绝、是不是因为受保护区域 */
const verdictSummary = (j: ReturnType<typeof judgeToolCall>) => ({
  disposition: j.disposition,
  hardRefusal: j.hardRefusal,
  protectedArea: j.findings.some((f) => f.kind === "protected_area"),
  mentionsProtectedArea: /受保护区域/.test(j.explanation),
});
const NEVER_BY_PROTECTED_AREA = { disposition: "never", hardRefusal: null, protectedArea: true, mentionsProtectedArea: true };

describe("自定义类别的确定规则", () => {
  // 每一行：规则、命中的调用、没命中的调用（对话里，维护者在工作目录里干活；v1 模板的前提先满足）
  const CASES: { name: string; match: CustomWatchCategory["match"]; hit: ReturnType<typeof call>; miss: ReturnType<typeof call> }[] = [
    { name: "匹配工具", match: { tools: ["git_commit"] }, hit: call("git_commit", { message: "x" }), miss: call("git_status_diff", {}) },
    { name: "匹配工具：bash 拆出的伪工具", match: { tools: ["git_commit"] }, hit: bash("git commit -m x"), miss: bash("git status") },
    { name: "路径：文件工具写进目录", match: { paths: [MIGRATIONS] }, hit: call("write", { path: `${MIGRATIONS}\\001.sql`, content: "x" }), miss: call("write", { path: `${P.workDir}\\src\\a.ts`, content: "x" }) },
    { name: "路径：bash 拆出的删除", match: { paths: [MIGRATIONS] }, hit: bash("rm db/migrations/001.sql"), miss: bash("rm build/a.o") },
    { name: "路径：目录本身也算", match: { paths: [MIGRATIONS] }, hit: call("ls", { path: MIGRATIONS }), miss: call("ls", { path: `${P.workDir}\\db` }) },
    { name: "路径：同名前缀的兄弟目录不算", match: { paths: [MIGRATIONS] }, hit: call("read", { path: `${MIGRATIONS}\\a.sql` }), miss: call("read", { path: `${MIGRATIONS}-old\\a.sql` }) },
    { name: "路径：不分大小写和斜杠方向", match: { paths: [MIGRATIONS] }, hit: call("read", { path: "e:/WORK/notes/DB/migrations/a.sql" }), miss: call("read", { path: "e:/work/notes/db/seeds/a.sql" }) },
    { name: "收件人（不分大小写、去空白）", match: { recipients: ["Landlord@Mail.com"] }, hit: call("mcp_send_email", { to: " landlord@mail.com ", subject: "s", body: "b" }), miss: call("mcp_send_email", { to: "friend@mail.com", subject: "s", body: "b" }) },
    { name: "金额大于阈值", match: { amountOver: 500 }, hit: call("mcp_pay", { payee: "shop", amount: 501 }), miss: call("mcp_pay", { payee: "shop", amount: 500 }) },
    { name: "几条都写了要同时满足", match: { tools: ["mcp_send_email"], recipients: ["boss@corp.com"] }, hit: call("mcp_send_email", { to: "boss@corp.com", subject: "s", body: "b" }), miss: call("mcp_pay", { payee: "boss@corp.com", amount: 1 }) },
    { name: "快速动作的伪工具", match: { tools: ["quick_action:send_note"] }, hit: call("quick_action:send_note", { to: "x" }), miss: call("quick_action:tidy_note", {}) },
  ];
  for (const c of CASES) {
    it(`${c.name}：命中按它的处置，没命中不影响判定`, () => {
      const category: CustomWatchCategory = { id: "mine", title: "我的类别", match: c.match, chat: "never", task: "never" };
      const judge = judgeInChat;
      const hit = judge(c.hit, settingsWith(category));
      expect(hit.categories).toContain("mine");
      expect(hit.disposition).toBe("never");
      expect(hit.explanation).toMatch(/我的类别/);
      // 没命中：和没有这个类别时一模一样
      const miss = judge(c.miss, settingsWith(category));
      expect(miss.categories).not.toContain("mine");
      const without = judge(c.miss, {});
      expect({ disposition: miss.disposition, categories: miss.categories }).toEqual({ disposition: without.disposition, categories: without.categories });
    });
  }

  describe("两套处置可以是六档里的任何一档，按对话或任务取", () => {
    for (const d of ORDER) {
      it(`设成 ${d}`, () => {
        // 新文件（不算覆盖），只落入这个自定义类别
        const write = call("write", { path: `${MIGRATIONS}\\002.sql`, content: "x" });
        const facts = { files: { [`${MIGRATIONS}\\002.sql`]: { exists: false } } };
        const chat = judgeToolCall(inChat(maintainer(), write, { facts, settings: settingsWith(migrations("log_only", d)) }));
        // 对话里没有计划："计划里列了才做"等同先问
        expect(chat.disposition).toBe(d === "plan_listed" ? "ask_first" : d);
        const inTaskJ = judgeToolCall(inTask(maintainer(), write, { facts, settings: settingsWith(migrations(d, "log_only")) }));
        // 任务里没有覆盖它的授权项："计划里列了才做"改为先问
        expect(inTaskJ.disposition).toBe(d === "plan_listed" ? "ask_first" : d);
        expect(inTaskJ.categories).toEqual(["db-migrations"]);
      });
    }
  });

  it("设成'直接做只记录'，放宽不了一同命中的内置类别", () => {
    // 删除迁移目录里的文件：同时落入"删除或覆盖"（对话里先问我）
    const j = judgeToolCall(inChat(maintainer(), bash("rm db/migrations/001.sql"), { ...v1Satisfied(), settings: settingsWith(migrations("log_only")) }));
    expect(j.categories.toSorted()).toEqual(["db-migrations", "delete_or_overwrite"]);
    expect(j.disposition).toBe("ask_first");
  });

  it("设成'直接做只记录'，放宽不了两条底线", () => {
    const everything: CustomWatchCategory = { id: "all-pay", title: "付款随意", match: { tools: ["mcp_pay", "mcp_send_email"] }, chat: "log_only", task: "log_only" };
    const pay = judgeToolCall(withTools(inTask(maintainer(), call("mcp_pay", { payee: "shop", amount: 1 }), { settings: settingsWith(everything) })));
    expect(pay.disposition).toBe("hand_over");
    const leak = judgeToolCall(withTools(inTask(maintainer(), call("mcp_send_email", { to: "a@b.c", subject: "s", body: "sk-0123456789abcdef0123456789abcdef" }), { settings: settingsWith(everything) })));
    expect(leak.disposition).toBe("never");
  });

  it("秘书在草稿区里的写：自定义类别照样适用（草稿区本身不落入任何类别）", () => {
    const notes = `${P.scratch}\\notes`;
    const category: CustomWatchCategory = { id: "scratch-notes", title: "动草稿区的 notes", match: { paths: [notes] }, chat: "never", task: "never" };
    expect(judgeToolCall(inChat(secretary(), call("write", { path: `${notes}\\a.md`, content: "x" }), { settings: settingsWith(category) })).disposition).toBe("never");
    expect(judgeToolCall(inChat(secretary(), call("write", { path: `${P.scratch}\\b.md`, content: "x" }), { settings: settingsWith(category) })).disposition).toBe("log_only");
  });
});

describe("演示：动工作目录里的数据库迁移目录", () => {
  // 计划里有一条覆盖整个工作目录的写授权项
  const writeAll = task({ plan: { grants: [{ grantId: "w", tool: "write", scope: { path: P.workDir }, stageId: "s1", grantedAt: NOW - DAY }] } });
  const elsewhere = call("write", { path: `${P.workDir}\\src\\new.ts`, content: "x" });
  const intoMigrations = call("write", { path: `${MIGRATIONS}\\003.sql`, content: "x" });
  const judge = (c: ReturnType<typeof call>, settings: WatchCategorySettings) => judgeToolCall(inTask(maintainer(), c, { task: writeAll, settings, facts: { files: { [`${MIGRATIONS}\\003.sql`]: { exists: false }, [`${P.workDir}\\src\\new.ts`]: { exists: false } } } }));

  it("任务里设'先问我'：别处照常直接做；写进迁移目录即使有覆盖它的授权项也先问，写明命中了这个类别", () => {
    const settings = settingsWith(migrations("ask_first"));
    expect(judge(elsewhere, settings).disposition).toBe("log_only");
    const j = judge(intoMigrations, settings);
    expect(j.disposition).toBe("ask_first");
    expect(j.withinGrant).toBe(false);
    expect(j.categories).toEqual(["db-migrations"]);
    expect(j.explanation).toMatch(/动数据库迁移目录/);
  });

  it("改成'直接做只记录'，或者删掉它，同样的写入又照常直接做", () => {
    expect(judge(intoMigrations, settingsWith(migrations("log_only"))).disposition).toBe("log_only");
    const deleted = judge(intoMigrations, {});
    expect(deleted.disposition).toBe("log_only");
    expect(deleted.categories).toEqual([]);
  });
});

describe("本任务对全局自定义类别的调严跟着全局走", () => {
  const intoMigrations = call("write", { path: `${MIGRATIONS}\\004.sql`, content: "x" });
  /** 计划里把全局的 db-migrations 在任务里调成"永不" */
  const tightened = task({ plan: { grants: [], watchCategories: { customOverrides: { "db-migrations": { task: "never" } } } } });
  const judge = (settings: WatchCategorySettings) => judgeToolCall(inTask(maintainer(), intoMigrations, { task: tightened, settings, facts: { files: { [`${MIGRATIONS}\\004.sql`]: { exists: false } } } }));

  it("全局里有它：取全局和本任务里更严的", () => {
    expect(judge(settingsWith(migrations("notify_after"))).disposition).toBe("never");
  });

  it("全局把它改得更严：按更严的", () => {
    // 本任务调成"交给我做"，全局后来改成"永不"
    const handOver = task({ plan: { grants: [], watchCategories: { customOverrides: { "db-migrations": { task: "hand_over" } } } } });
    const j = judgeToolCall(inTask(maintainer(), intoMigrations, { task: handOver, settings: settingsWith(migrations("never")), facts: { files: { [`${MIGRATIONS}\\004.sql`]: { exists: false } } } }));
    expect(j.disposition).toBe("never");
  });

  it("全局改了规则：按新规则匹配", () => {
    const moved = { ...migrations("log_only"), match: { paths: [`${P.workDir}\\db\\seeds`] } };
    const j = judge(settingsWith(moved));
    expect(j.categories).toEqual([]);
    expect(j.disposition).toBe("log_only");
  });

  it("全局删掉了它：本任务的调严不再命中", () => {
    const j = judge({});
    expect(j.categories).toEqual([]);
    expect(j.disposition).toBe("log_only");
  });

  it("本任务新加的类别只存在计划里，和全局同一个调用一起命中时取最严", () => {
    const own: CustomWatchCategory = { id: "t-1-c1", title: "本任务：迁移目录", match: { paths: [MIGRATIONS] }, chat: "hand_over", task: "hand_over" };
    const withOwn = task({ plan: { grants: [], watchCategories: { custom: [own] } } });
    const j = judgeToolCall(inTask(maintainer(), intoMigrations, { task: withOwn, settings: settingsWith(migrations("ask_first")), facts: { files: { [`${MIGRATIONS}\\004.sql`]: { exists: false } } } }));
    expect(j.categories.toSorted()).toEqual(["db-migrations", "t-1-c1"]);
    expect(j.disposition).toBe("hand_over");
  });

  it("同一个 id 在全局和本任务里各有一份时，取更严的那份处置", () => {
    const copy = { ...migrations("never") };
    const withCopy = task({ plan: { grants: [], watchCategories: { custom: [copy] } } });
    const j = judgeToolCall(inTask(maintainer(), intoMigrations, { task: withCopy, settings: settingsWith(migrations("notify_after")), facts: { files: { [`${MIGRATIONS}\\004.sql`]: { exists: false } } } }));
    expect(j.disposition).toBe("never");
  });
});

describe("注册表在配置区：agent 用脚本写它同样是'永不'（尽力而为：脚本里写着受保护区域的路径）", () => {
  const configFile = `${P.config}\\watch-categories.json`;

  it.each([
    ["node -e，正斜杠", `node -e "require('fs').writeFileSync('D:/ergou-data/config/watch-categories.json', '{}')"`],
    ["python -c，反斜杠", `python -c "open(r'D:\\ergou-data\\config\\watch-categories.json', 'w').write('{}')"`],
    ["JS 字符串里转义过的反斜杠", `node -e "require('fs').writeFileSync('D:\\\\ergou-data\\\\Config\\\\x.json', '')"`],
    ["Git Bash 的盘符写法", `sh -c "echo {} > /d/ergou-data/config/watch-categories.json"`],
  ])("内联脚本（%s）", (_name, command) => {
    expect(verdictSummary(judgeToolCall(inChat(secretary(), bash(command))))).toEqual(NEVER_BY_PROTECTED_AREA);
    expect(verdictSummary(judgeToolCall(inTask(maintainer(), bash(command))))).toEqual(NEVER_BY_PROTECTED_AREA);
  });

  it("内联脚本没写受保护区域：照旧按未知的写操作先问", () => {
    const j = judgeToolCall(inChat(maintainer(), bash(`node -e "require('fs').writeFileSync('D:/ergou-data/configs/x.json', '')"`)));
    expect(j.disposition).toBe("ask_first");
    expect(j.categories).toEqual(["unknown_write"]);
  });

  it("跑一个写着受保护区域路径的脚本文件（调用方扫描脚本时报上来）", () => {
    const script = `${P.scratch}\\w.js`;
    const facts = (mentionedPaths: string[]) => ({ scripts: { [script]: { networkUsage: [], mentionedPaths } } });
    expect(verdictSummary(judgeToolCall(inChat(secretary(), bash("node w.js"), { facts: facts([configFile]) })))).toEqual(NEVER_BY_PROTECTED_AREA);
    expect(verdictSummary(judgeToolCall(inChat(secretary(), bash("node w.js"), { facts: facts([`${P.programDir}\\src\\x.ts`]) })))).toEqual(NEVER_BY_PROTECTED_AREA);
    const elsewhere = judgeToolCall(inChat(secretary(), bash("node w.js"), { facts: facts([`${P.scratch}\\out.txt`]) }));
    expect(elsewhere.disposition).toBe("log_only");
  });
});

describe("设置的修改：内置类别只能往严里调，两条底线改不动，自定义类别随便改", () => {
  const before: WatchCategorySettings = {
    builtin: { external_send: { chat: "hand_over" } },
    custom: [migrations("ask_first")],
  };
  const frozen = () => structuredClone(before);

  // 每一行：修改、结果（null 表示被拒，否则是改后的设置里内置类别那部分）
  const BUILTIN_CASES: [string, WatchCategoryEdit, WatchCategorySettings["builtin"] | null][] = [
    ["调严：删除或覆盖在任务里从'做完告诉我'调到'先问我'", { op: "set_builtin", categoryId: "delete_or_overwrite", scene: "task", disposition: "ask_first" }, { external_send: { chat: "hand_over" }, delete_or_overwrite: { task: "ask_first" } }],
    ["比现在的设置松、但不比默认松：可以，和默认一样就去掉这一项", { op: "set_builtin", categoryId: "external_send", scene: "chat", disposition: "ask_first" }, {}],
    ["调松：删除或覆盖在任务里调到'直接做只记录'", { op: "set_builtin", categoryId: "delete_or_overwrite", scene: "task", disposition: "log_only" }, null],
    ["调松：越出项目目录在任务里从'计划里列了才做'调到'做完告诉我'", { op: "set_builtin", categoryId: "outside_project", scene: "task", disposition: "notify_after" }, null],
    ["计划外工单在对话里不适用", { op: "set_builtin", categoryId: "unplanned_work_order", scene: "chat", disposition: "never" }, null],
    ["底线：付款转账……不能改", { op: "set_builtin", categoryId: "payment_account_auth", scene: "chat", disposition: "never" }, null],
    ["底线：把凭据写进对外内容不能改", { op: "set_builtin", categoryId: "secret_in_outbound", scene: "task", disposition: "never" }, null],
    ["没有这个内置类别", { op: "set_builtin", categoryId: "no_such", scene: "task", disposition: "never" }, null],
  ];
  const REJECTED = { ok: false, problems: expect.stringMatching(/只能往严里调|不适用|底线|没有这个内置类别/) };
  it.each(BUILTIN_CASES)("%s", (_name, edit, want) => {
    const settings = frozen();
    const r = editWatchCategorySettings(settings, edit);
    expect(settings).toEqual(before);
    const got = r.ok ? { ok: true, builtin: r.settings.builtin ?? {} } : { ok: false, problems: r.problems.join("；") };
    expect(got).toEqual(want === null ? REJECTED : { ok: true, builtin: want });
  });

  it("改松被拒时说清楚比默认松", () => {
    const r = editWatchCategorySettings(frozen(), { op: "set_builtin", categoryId: "delete_or_overwrite", scene: "task", disposition: "log_only" });
    expect(r).toEqual({ ok: false, problems: [expect.stringMatching(/直接做只记录.*比默认的.*做完告诉我.*松/)] });
  });

  it("新建、改规则、改处置（往松里改也行）、删除自定义类别", () => {
    const mail: CustomWatchCategory = { id: "c-mail", title: "给房东发邮件", match: { recipients: ["landlord@mail.com"] }, chat: "ask_first", task: "never" };
    const created = editWatchCategorySettings(frozen(), { op: "create_custom", category: mail });
    expect(created.ok && created.settings.custom).toEqual([migrations("ask_first"), mail]);

    const looser = { ...migrations("log_only", "log_only"), match: { paths: [`${P.workDir}\\db\\seeds`] } };
    const updated = editWatchCategorySettings(frozen(), { op: "update_custom", category: looser });
    expect(updated.ok && updated.settings.custom).toEqual([looser]);

    const deleted = editWatchCategorySettings(frozen(), { op: "delete_custom", categoryId: "db-migrations" });
    expect(deleted.ok && deleted.settings.custom).toEqual([]);
  });

  it("自定义类别：改、删不存在的，新建时和已有的或内置的重名，规则写错，都被拒", () => {
    const bad: [WatchCategoryEdit, RegExp][] = [
      [{ op: "update_custom", category: { ...migrations("never"), id: "nope" } }, /没有这个自定义类别/],
      [{ op: "delete_custom", categoryId: "nope" }, /没有这个自定义类别/],
      [{ op: "create_custom", category: migrations("never") }, /重复/],
      [{ op: "create_custom", category: { ...migrations("never"), id: "spend_money" } }, /和内置类别重名/],
      [{ op: "create_custom", category: { ...migrations("never"), id: "c-x", match: {} } }, /至少要有一个条件/],
      [{ op: "update_custom", category: { ...migrations("never"), title: " " } }, /名字/],
    ];
    for (const [edit, pattern] of bad) {
      const settings = frozen();
      const r = editWatchCategorySettings(settings, edit);
      expect(r.ok ? "" : r.problems.join("；")).toMatch(pattern);
      expect(settings).toEqual(before);
    }
  });

  it("改出来的设置交给判定：两条底线照旧", () => {
    let settings: WatchCategorySettings = {};
    const all: CustomWatchCategory = { id: "c-all", title: "什么都放行", match: { tools: ["mcp_pay", "mcp_change_password", "mcp_send_email"] }, chat: "log_only", task: "log_only" };
    const edits: WatchCategoryEdit[] = [
      { op: "create_custom", category: all },
      { op: "set_builtin", categoryId: "spend_money", scene: "task", disposition: "never" },
    ];
    for (const edit of edits) {
      const r = editWatchCategorySettings(settings, edit);
      if (!r.ok) throw new Error(r.problems.join("；"));
      settings = r.settings;
    }
    expect(judgeToolCall(withTools(inChat(maintainer(), call("mcp_change_password", { account: "me" }), { settings }))).disposition).toBe("hand_over");
    const leak = call("mcp_send_email", { to: "a@b.c", subject: "s", body: "ghp_AbCdEfGhIjKlMnOpQrStUvWxYz0123456789" });
    expect(judgeToolCall(withTools(inChat(maintainer(), leak, { settings }))).disposition).toBe("never");
  });
});
