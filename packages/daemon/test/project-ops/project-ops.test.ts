// 秘书的 project_ops（260 号票；268 号票照用户 2026-10-13 的设计草稿补齐）的单元切面：
// - 运营接口清单（manifest.ts）：MCP tools/list 的格式加中文标题、用户可能怎么说、三种操作（旧清单的 readOnlyHint 照读）、风险标记、
//   四种实现方式、测试；规范模板里那份读得通；坏了的说清哪里坏；和通用操作重名的不行；
// - 参数（args.ts）：中文名换成值、补默认值、按 JSON Schema 校验；参数说明本身的毛病（枚举没中文名、默认值不合、required 写了没有的）；
// - 回的东西（reply.ts）：{ say, detail }、CallToolResult 的 structuredContent.say、纯文本；没给 say 时二狗补的那句；
// - 验收和版本号（registry.ts、acceptance.ts）：格式不对、测试没回 say、只读的写了文件不过；服务没在跑的等着；全过了登记，改了重新验、
//   版本号加一，没过的照旧用上一版、告诉维护者一次；转运营检查清单那一项的几种样子；
// - list / describe / call：通用操作和项目自己的操作；参数不对不发、退回说明；say 必有（没给的二狗补、记下）；四种实现方式各一条
//   （假的项目服务、工作目录里的假脚本、二狗自带动作绑参数、转给维护者当工单）；通用操作（状态、最近运行、最新交付件、立即跑一次、
//   暂停恢复、改时间、跟维护者说一句）；记录里带版本号；260 号票的那些（服务关着、连不上、等不到、调用口对不上服务）照旧。
// 真守护进程、真端口的主切面在 test/main/project-ops.test.ts。
import fs from "node:fs";
import path from "node:path";
import { activeLocaleFrom, type JobRun, nowIso, type OperationsPlanView, type Project, type ProjectServiceView, type ScheduledJob, setActiveLocale } from "@ergo/protocol";
import { describe, expect, it, onTestFinished } from "vitest";
import { openEventStore } from "../../src/events/event-store.ts";
import { OPERATIONS_CHANNEL } from "../../src/operations/events.ts";
import {
  createProjectOps,
  fallbackSay,
  OPS_PROBLEM_CODES,
  type OpsManifestRegisteredPayload,
  parseOpsManifest,
  parseReply,
  prepareArgs,
  PROJECT_OPS_EVENTS,
  type ProjectOpCalledPayload,
  problemForModel,
  problemText,
  schemaProblems,
  schemaWarnings,
} from "../../src/project-ops/index.ts";
import { RequestRejected } from "../../src/errors.ts";
import { builtinCatalogs } from "../../src/i18n/index.ts";
import { STANDARD_TEMPLATES_DIR, standardTemplates } from "../../src/projects/standard.ts";
import { freePort } from "../helpers/ports.ts";
import { LEDGER_OPS, startFakeOpsApp } from "../helpers/fake-ops-app.ts";
import { makeTempDir } from "../helpers/temp-dir.ts";

const project = (id: string, name: string, state: Project["state"], extra: Partial<Project> = {}): Project => ({
  id,
  name,
  goal: `${name}的目标`,
  state,
  origin: "suggestion",
  maintainerId: `pm-${id.slice(2)}`,
  workdir: { external: false },
  charterConfirmed: true,
  createdAt: nowIso(),
  updatedAt: nowIso(),
  ...extra,
});

const service = (projectId: string, name: string, port: number, extra: Partial<ProjectServiceView> = {}): ProjectServiceView => ({
  projectId,
  key: name,
  title: name === "ledger" ? "记账本网页" : name,
  name,
  app: `${projectId}-${name}`,
  port,
  autostart: true,
  rollout: "live",
  status: "online",
  ...extra,
});

const job = (id: string, projectId: string, title: string, extra: Partial<ScheduledJob> = {}): ScheduledJob =>
  ({
    id,
    title,
    schedule: { kind: "daily", time: "08:00" },
    each: title,
    projectId,
    maintainerId: "pm-1",
    taskId: `t-${id.slice(2)}`,
    taskTitle: title,
    ownerTaskId: `t-${id.slice(2)}`,
    grants: [],
    temporalRules: [],
    grantInfo: {},
    state: "active",
    nextAt: "2026-10-26T08:00:00.000+08:00",
    lastFailed: false,
    consecutiveFailures: 0,
    runCount: 0,
    createdAt: nowIso(),
    updatedAt: nowIso(),
    ...extra,
  }) as ScheduledJob;

/** 底座：几个项目（各自的档案目录、工作目录）、项目的服务、定时任务、事件存储；ops 是每个项目档案里的 ops.json */
function setup(input: {
  projects: Project[];
  services?: ProjectServiceView[];
  ops?: Record<string, unknown>;
  plans?: Record<string, OperationsPlanView>;
  jobs?: ScheduledJob[];
  runs?: Record<string, JobRun[]>;
  timeoutMs?: number;
  refuseInternal?: string[];
}) {
  const root = makeTempDir("ergo-project-ops-");
  const store = openEventStore({ file: path.join(root, "ergo.db"), views: [] });
  onTestFinished(() => store.close());
  const recordsOf = (projectId: string) => path.join(root, "projects", projectId);
  const workdirOf = (projectId: string) => path.join(recordsOf(projectId), "workdir");
  const opsFile = (projectId: string) => path.join(recordsOf(projectId), "ops.json");
  const writeOps = (projectId: string, content: unknown) => {
    fs.mkdirSync(path.dirname(opsFile(projectId)), { recursive: true });
    fs.writeFileSync(opsFile(projectId), typeof content === "string" ? content : JSON.stringify(content, null, 2));
  };
  for (const p of input.projects) fs.mkdirSync(workdirOf(p.id), { recursive: true });
  for (const [projectId, content] of Object.entries(input.ops ?? {})) writeOps(projectId, content);
  let services = input.services ?? [];
  let projects = input.projects;
  const jobs = input.jobs ?? [];
  const logs: string[] = [];
  const scheduled: string[] = [];
  const told: Array<{ projectId: string; message: string; check?: boolean }> = [];
  const delegated: Array<{ projectId: string; title: string; instructions: string; check?: boolean }> = [];
  const notified: Array<{ projectId: string; text: string; key: string }> = [];
  const checked: string[] = [];
  const ops = createProjectOps({
    store,
    projects: { list: () => projects, records: (projectId) => ({ root: recordsOf(projectId), ops: opsFile(projectId) }), workdir: (p) => workdirOf(p.id) },
    services: { view: () => services },
    pendingPlan: (projectId) => input.plans?.[projectId],
    jobs: { ofProject: (projectId) => jobs.filter((j) => j.projectId === projectId), runsOf: (jobId) => input.runs?.[jobId] ?? [] },
    scheduler: () => ({
      checkRunNow: (jobId) => {
        if (jobId === "j-busy") throw new RequestRejected("not_allowed", "上一次还在跑");
        scheduled.push(`check ${jobId}`);
      },
      runNow: ({ jobId }, key, by) => {
        scheduled.push(`run ${jobId} ${by} ${key}`);
        return { runId: `${jobId}-r9` };
      },
      act: ({ jobId, action }, key) => {
        scheduled.push(`${action} ${jobId} ${key}`);
        return { state: action === "pause" ? "paused" : "active" };
      },
      reschedule: ({ jobId, schedule }, key) => {
        scheduled.push(`reschedule ${jobId} ${JSON.stringify(schedule)} ${key}`);
        return { schedule, nextAt: "2026-10-26T07:30:00.000+08:00" };
      },
    }),
    tellMaintainer: ({ project: p, message, check }) => {
      told.push({ projectId: p.id, message, ...(check ? { check } : {}) });
      return [];
    },
    delegate: ({ project: p, title, instructions, check }) => {
      if (input.refuseInternal?.includes(p.id)) throw new RequestRejected("not_allowed", `项目「${p.name}」已归档`);
      delegated.push({ projectId: p.id, title, instructions, ...(check ? { check } : {}) });
      return check ? {} : { taskId: "t-9" };
    },
    isTemplate: (text) => standardTemplates().isTemplate("ops.json", text),
    notifyMaintainer: (p, text, key) => notified.push({ projectId: p.id, text, key }),
    onChecked: (p) => checked.push(p.id),
    now: nowIso,
    log: (line) => logs.push(line),
    ...(input.timeoutMs === undefined ? {} : { timeoutMs: input.timeoutMs, checkTimeoutMs: input.timeoutMs }),
  });
  const tool = ops.tool();
  const run = async (args: Record<string, unknown>, extra: { toolCallId?: string; inputMessageId?: string } = {}) => {
    const result = await tool.run(args as never, { toolCallId: extra.toolCallId ?? `call-${Math.random().toString(36).slice(2, 8)}`, ...(extra.inputMessageId ? { inputMessageId: extra.inputMessageId } : {}) });
    return { text: result.text, isError: result.isError === true, cardIds: result.cardIds };
  };
  const check = async (projectId: string) => {
    const result = await ops.checkTool({ projectId, maintainerId: `pm-${projectId.slice(2)}` }).run({} as never, { toolCallId: "check-1" });
    return { text: result.text, isError: result.isError === true };
  };
  const called = () => store.read(OPERATIONS_CHANNEL, 0, PROJECT_OPS_EVENTS.called).map((e) => e.payload as ProjectOpCalledPayload);
  const registered = () => store.read(OPERATIONS_CHANNEL, 0, PROJECT_OPS_EVENTS.registered).map((e) => e.payload as OpsManifestRegisteredPayload);
  const timeline = () => store.read("secretary", 0).filter((e) => e.type === "timeline_record").map((e) => (e.payload as { record: { kind: string; summary: string; detail?: string } }).record);
  return {
    ops,
    run,
    check,
    store,
    writeOps,
    workdirOf,
    recordsOf,
    called,
    registered,
    timeline,
    logs,
    scheduled,
    told,
    delegated,
    notified,
    checked,
    setServices: (next: ProjectServiceView[]) => (services = next),
    setProjects: (next: Project[]) => (projects = next),
  };
}

/** 一份坏了的清单说的哪里坏（模型的语言） */
function problem(text: string): string {
  const read = parseOpsManifest(text, ["status"]);
  expect(read.kind).toBe("broken");
  return read.kind === "broken" ? problemForModel(read.problem) : "";
}

/** 一个写全了的操作（照模板），可以改几样 */
const op = (name: string, extra: Record<string, unknown> = {}) => ({
  name,
  title: `操作${name}`,
  description: `${name} 的说明。`,
  userSays: [`帮我${name}`],
  kind: "query",
  inputSchema: { type: "object", properties: {} },
  test: { args: {} },
  ...extra,
});

describe("运营接口清单（ops.json）", () => {
  it("规范模板里那份读得通（没有操作，$ 开头的是说明）；照草稿写的读出中文标题、用户可能怎么说、种类、参数、返回、风险标记、实现方式、用法、测试", () => {
    for (const language of ["zh-CN", "en"]) {
      const template = fs.readFileSync(path.join(STANDARD_TEMPLATES_DIR, "v1", "dev", language, "ops.json"), "utf8");
      expect(parseOpsManifest(template)).toEqual({ kind: "ok", endpoint: { path: "/ops" }, ops: [] });
      // 模板里写清了各个字段、四种实现方式、say、测试标记、通用操作、版本号
      for (const word of ["userSays", "kind", "enumNames", "risk", "impl", "script", "ergo", "maintainer", "say", "ergo/test", "ERGO_OPS_TEST", "tell_maintainer", "check_ops"]) expect(template).toContain(word);
      // 模板里的示例照它自己的规矩写全了：读得通、参数说明没毛病
      const example = (JSON.parse(template) as { $example: unknown }).$example;
      const read = parseOpsManifest(JSON.stringify({ tools: [example] }));
      expect(read.kind === "ok" ? schemaProblems("add_expense", read.ops[0]!.inputSchema) : read).toEqual([]);
    }
    const read = parseOpsManifest(JSON.stringify(LEDGER_OPS));
    expect(read).toMatchObject({
      kind: "ok",
      endpoint: { service: "ledger", path: "/ops" },
      ops: [
        { name: "add_expense", title: "记一笔支出", kind: "action", kindFrom: "kind", userSays: ["记一笔午饭 32 块", "刚打车花了 25"], risk: "direct", impl: { type: "http" }, test: { args: { amount: 1 }, sayIncludes: "测试" } },
        { name: "list_expenses", kind: "query", impl: { type: "http" } },
      ],
    });
  });

  it("旧清单（260 号票的写法）照读：readOnlyHint true 是只读查询、false 是有副作用的动作，都没写的照 MCP 的默认算动作（验收时要写明）；kind 和 readOnlyHint 对不上的不行", () => {
    const read = parseOpsManifest(JSON.stringify({ tools: [{ name: "a", annotations: { readOnlyHint: true } }, { name: "b", annotations: { readOnlyHint: false } }, { name: "c" }] }));
    expect(read).toMatchObject({ kind: "ok", ops: [{ name: "a", kind: "query", kindFrom: "readOnlyHint" }, { name: "b", kind: "action", kindFrom: "readOnlyHint" }, { name: "c", kind: "action", kindFrom: "default" }] });
    expect(problem(JSON.stringify({ tools: [{ name: "a", kind: "query", annotations: { readOnlyHint: false } }] }))).toContain("kind 和 annotations.readOnlyHint 对不上");
    expect(parseOpsManifest(JSON.stringify({ tools: [{ name: "r", kind: "run", annotations: { readOnlyHint: false } }] }))).toMatchObject({ kind: "ok", ops: [{ kind: "run" }] });
  });

  it("四种实现方式：http（默认）、script（工作目录里的脚本，按扩展名）、ergo（二狗自带动作绑参数）、maintainer（转给维护者当工单）", () => {
    const read = parseOpsManifest(
      JSON.stringify({
        tools: [
          { name: "h" },
          { name: "s", impl: { type: "script", file: "scripts/report.mjs", args: ["--json"] } },
          { name: "e", impl: { type: "ergo", action: "run_now", params: { job: "daily" } } },
          { name: "m", impl: { type: "maintainer", instructions: "把 {{url}} 加进信息源" } },
        ],
      }),
    );
    expect(read).toMatchObject({
      kind: "ok",
      ops: [
        { impl: { type: "http" } },
        { impl: { type: "script", file: "scripts/report.mjs", args: ["--json"] } },
        { impl: { type: "ergo", action: "run_now", params: { job: "daily" } } },
        { impl: { type: "maintainer", instructions: "把 {{url}} 加进信息源" } },
      ],
    });
  });

  it("坏了说清哪里坏：不是 JSON、没有 tools、操作没名字、重名、和通用操作重名、字段类型不对、种类风险实现方式写错、脚本路径、测试", () => {
    expect(problem("{ tools: [")).toContain("不是合法的 JSON");
    expect(problem("[]")).toContain("顶层要是一个对象");
    expect(problem(JSON.stringify({ endpoint: { path: "/ops" } }))).toContain("没有 tools");
    expect(problem(JSON.stringify({ tools: [{ description: "x" }] }))).toContain("第 1 个操作没有 name");
    expect(problem(JSON.stringify({ tools: [{ name: "记账" }] }))).toContain("第 1 个操作的 name「记账」");
    expect(problem(JSON.stringify({ tools: [{ name: "a" }, { name: "a" }] }))).toContain("操作 a 写了两次");
    expect(problem(JSON.stringify({ tools: [{ name: "status" }] }))).toContain("和白送的通用操作重名");
    expect(problem(JSON.stringify({ tools: [{ name: "a", inputSchema: "amount" }] }))).toContain("操作 a 的 inputSchema 要是一个对象");
    expect(problem(JSON.stringify({ tools: [{ name: "a", userSays: "记一笔" }] }))).toContain("userSays 要是几句话的列表");
    expect(problem(JSON.stringify({ tools: [{ name: "a", kind: "write" }] }))).toContain("kind「write」只能写 query");
    expect(problem(JSON.stringify({ tools: [{ name: "a", risk: "maybe" }] }))).toContain("risk「maybe」只能写 direct");
    expect(problem(JSON.stringify({ tools: [{ name: "a", impl: { type: "ftp" } }] }))).toContain("impl.type「ftp」只能写 http、script、ergo、maintainer");
    expect(problem(JSON.stringify({ tools: [{ name: "a", impl: { type: "script", file: "../x.mjs" } }] }))).toContain("相对路径");
    expect(problem(JSON.stringify({ tools: [{ name: "a", impl: { type: "script", file: "C:/x.mjs" } }] }))).toContain("相对路径");
    expect(problem(JSON.stringify({ tools: [{ name: "a", impl: { type: "script", file: "x.txt" } }] }))).toContain("不认得是什么类型");
    expect(problem(JSON.stringify({ tools: [{ name: "a", impl: { type: "ergo", action: "rm_rf" } }] }))).toContain("不是二狗自带的动作");
    expect(problem(JSON.stringify({ tools: [{ name: "a", test: { args: [] } }] }))).toContain("test.args 要是一个对象");
    expect(problem(JSON.stringify({ tools: [{ name: "a", annotations: { readOnlyHint: "yes" } }] }))).toContain("readOnlyHint 要写 true 或 false");
    expect(problem(JSON.stringify({ endpoint: { path: "//evil.example/ops" }, tools: [] }))).toContain("endpoint.path 要以 / 开头");
    expect(problem(JSON.stringify({ endpoint: { service: 3 }, tools: [] }))).toContain("endpoint.service");
  });

  it("每种问题中英文都说得出来（语言文件里都有）", () => {
    const params = { name: "a", which: 1, reason: "r", value: "v", file: "f", exts: ".mjs", action: "x", actions: "y", prop: "p", placeholder: "q", service: "s", names: "n", count: 2, expected: "e", say: "s", files: "f", waiting: 1 };
    for (const code of OPS_PROBLEM_CODES) {
      const zh = problemText({ code, params });
      expect(zh).not.toContain("projectOps.problem");
      useLanguage("en");
      try {
        const en = problemText({ code, params });
        expect(en).not.toContain("projectOps.problem");
        expect(en).not.toMatch(/[\u4e00-\u9fff]/);
      } finally {
        useLanguage("zh-CN");
      }
    }
  });
});

describe("参数", () => {
  const schema = LEDGER_OPS.tools[0]!.inputSchema;

  it("call 之前整理：中文名换成值、没写的补默认值；不对的说清哪个参数哪里不对、枚举列出能写的", () => {
    expect(prepareArgs(schema, { amount: 32, category: "吃饭" })).toEqual({ ok: true, args: { amount: 32, category: "food", note: "" }, mapped: ['category：吃饭 → "food"'], defaulted: ["note"] });
    expect(prepareArgs(schema, { amount: 32, category: "transport", note: "打车" })).toMatchObject({ ok: true, args: { amount: 32, category: "transport", note: "打车" } });
    const bad = prepareArgs(schema, { amount: "三十二", category: "零食" });
    expect(bad.ok).toBe(false);
    const problems = bad.ok ? "" : bad.problems.join("\n");
    expect(problems).toContain("参数 amount");
    expect(problems).toContain('参数 category 只能写："food"（吃饭）、"transport"（交通）、"other"（其他）');
    const missing = prepareArgs(schema, {});
    expect(missing.ok).toBe(false);
    // oneOf 里每项 { const, title } 也算带中文名的枚举
    expect(prepareArgs({ type: "object", properties: { size: { oneOf: [{ const: "s", title: "小杯" }, { const: "l", title: "大杯" }] } } }, { size: "大杯" })).toMatchObject({ ok: true, args: { size: "l" } });
  });

  it("参数说明本身的毛病：枚举没中文名、中文名个数不对、默认值不合、required 写了没有的；参数太多、嵌套、可选的没默认值只提醒", () => {
    expect(schemaProblems("a", schema)).toEqual([]);
    expect(codes({ type: "object", properties: { c: { type: "string", enum: ["x", "y"] } } })).toEqual(["schemaEnumNames"]);
    expect(codes({ type: "object", properties: { c: { type: "string", enum: ["x", "y"], enumNames: ["甲"] } } })).toEqual(["schemaEnumNamesLength"]);
    expect(codes({ type: "object", properties: { n: { type: "number", default: "三" } } })).toEqual(["schemaDefaultInvalid"]);
    expect(codes({ type: "object", properties: {}, required: ["x"] })).toEqual(["schemaRequiredUnknown"]);
    const warnings = schemaWarnings("a", { type: "object", properties: { o: { type: "object" }, n: { type: "string" } }, required: [] }).map((m) => m.code);
    expect(warnings).toEqual(["warnNested", "warnNoDefault", "warnNoDefault"]);
  });
});

describe("回的东西：能念的 say 和附件", () => {
  it("{ say, detail }、CallToolResult 的 structuredContent.say、纯文本、别的 JSON；isError", () => {
    expect(parseReply(JSON.stringify({ say: "记好了", detail: { id: 1 } }), "application/json")).toEqual({ say: "记好了", detail: '{"id":1}', isError: false });
    expect(parseReply(JSON.stringify({ say: "记好了", id: 1 }), null)).toEqual({ say: "记好了", detail: '{"id":1}', isError: false });
    expect(parseReply(JSON.stringify({ content: [{ type: "text", text: "细节" }], structuredContent: { say: "好了", n: 2 } }), "application/json")).toEqual({ say: "好了", detail: '细节\n{"n":2}', isError: false });
    expect(parseReply(JSON.stringify({ content: [{ type: "text", text: "锁着" }], isError: true }), "application/json")).toEqual({ detail: "锁着", isError: true });
    expect(parseReply("就一行字", "text/plain")).toEqual({ detail: "就一行字", isError: false });
    expect(parseReply(JSON.stringify({ items: [1] }), "application/json")).toEqual({ detail: '{"items":[1]}', isError: false });
  });

  it("没给 say 时二狗按结果补：一行能念的附件就用它，不然按种类说；没做成的说没做成和一行原因", () => {
    const q = { name: "q", title: "查支出", kind: "query" as const };
    expect(fallbackSay(q, { ok: true, detail: "合计 32 元" })).toBe("合计 32 元");
    expect(fallbackSay(q, { ok: true, detail: '{"total":32}' })).toBe("「查支出」查好了，细节在附件里。");
    expect(fallbackSay({ name: "a", kind: "action" }, { ok: true, detail: "" })).toBe("「a」做好了。");
    expect(fallbackSay({ name: "r", title: "抓一次", kind: "run" }, { ok: true, detail: "{}" })).toBe("「抓一次」开始跑了。");
    expect(fallbackSay(q, { ok: false, detail: "连不上（ECONNREFUSED）\n更多" })).toBe("「查支出」没做成：连不上（ECONNREFUSED）");
  });
});

describe("清单验收和版本号（照 112 号票的自动验收）", () => {
  it("建设中：格式对、每个操作的测试（带测试标记，有副作用的不真做）跑通并回 say、只读的不写——全过；转运营清单那一项打勾；转入使用时登记成第 1 版", async () => {
    const app = await startFakeOpsApp();
    const s = setup({
      projects: [project("p-1", "记账本", "building", { kind: "dev" })],
      plans: { "p-1": { revision: 1, items: [{ name: "记账本网页", service: { name: "ledger", app: "p-1-ledger", port: app.port } }] } as unknown as OperationsPlanView },
      ops: { "p-1": LEDGER_OPS },
    });
    const building = project("p-1", "记账本", "building", { kind: "dev" });
    // 清单上先是"正在验收"（后台开验），验完了 onChecked
    expect(s.ops.checklistItem(building)).toMatchObject({ id: "ops", done: false, detail: "2 个操作，正在验收" });
    await waitFor(() => s.checked.length > 0);
    expect(s.ops.checklistItem(building)).toMatchObject({ id: "ops", done: true, detail: "验收通过：2 个操作的测试都跑通，只读的没写东西" });
    // 测试调用带着测试标记，有副作用的没真记
    expect(app.calls().map((c) => [c.name, c["_meta"]])).toEqual([
      // 312 号票：测试标记另带一份旧名字的（早先做的服务照样认得出）
      ["add_expense", { "ergo/test": true, "ergou/test": true }],
      ["list_expenses", { "ergo/test": true, "ergou/test": true }],
    ]);
    expect(app.expenses()).toEqual([]);
    // 记下了验收全过（同一份内容不再自动验）；建设中不登记
    expect(s.store.read(OPERATIONS_CHANNEL, 0, PROJECT_OPS_EVENTS.checked).map((e) => (e.payload as { outcome: string }).outcome)).toEqual(["passed"]);
    expect(s.registered()).toEqual([]);
    // 转入使用时登记成第 1 版
    const events = s.ops.goLiveEvents(building);
    expect(events).toHaveLength(1);
    s.store.appendBatch(events);
    expect(s.ops.registry.registered("p-1")).toMatchObject({ version: 1, via: "go_live", ops: [{ name: "add_expense" }, { name: "list_expenses" }] });
  });

  it("转入使用那一刻验收还没做完（没登记上）：转入使用后秘书第一次用到时，全过的那份补登记成第 1 版", async () => {
    const app = await startFakeOpsApp();
    const building = project("p-1", "记账本", "building", { kind: "dev" });
    const s = setup({
      projects: [building],
      plans: { "p-1": { revision: 1, items: [{ name: "记账本网页", service: { name: "ledger", app: "p-1-ledger", port: app.port } }] } as unknown as OperationsPlanView },
      ops: { "p-1": LEDGER_OPS },
    });
    // 转入使用时还在验（goLiveEvents 什么都没登记），验完时项目还是建设中的样子
    s.ops.checklistItem(building);
    expect(s.ops.goLiveEvents(building)).toEqual([]);
    await waitFor(() => s.checked.length > 0);
    expect(s.registered()).toEqual([]);
    // 转入使用了：秘书第一次用到时补登记，不再重验
    s.setProjects([{ ...building, state: "in_use" }]);
    s.setServices([service("p-1", "ledger", app.port)]);
    const testCalls = app.calls().length;
    expect((await s.run({ action: "list" })).text).toContain("项目 p-1「记账本」（运营接口清单第 1 版");
    expect(s.registered().map((r) => r.version)).toEqual([1]);
    expect(app.calls().length).toBe(testCalls);
  });

  it("没过的说清：没写中文标题、用户可能怎么说、种类、测试；枚举没中文名；测试回的没有 say；只读查询写了文件；脚本不在工作目录；维护者收不了", async () => {
    const s = setup({ projects: [project("p-1", "记账本", "in_use"), project("p-2", "旅行相册", "in_use")], refuseInternal: ["p-2"] });
    // 自称只读的 leaky_query 往项目的工作目录里写文件
    const app = await startFakeOpsApp({ writeDir: s.workdirOf("p-1") });
    s.setServices([service("p-1", "ledger", app.port)]);
    // 格式不对：一次说全，不跑测试
    s.writeOps("p-1", {
      ...LEDGER_OPS,
      tools: [
        { name: "add_expense", inputSchema: { type: "object", properties: { c: { type: "string", enum: ["a", "b"] } } } },
        op("monthly", { impl: { type: "script", file: "scripts/none.mjs" } }),
      ],
    });
    const failed = await s.check("p-1");
    expect(failed.isError).toBe(true);
    for (const words of ["没写中文标题", "没写什么时候用", "没写用户可能怎么说", "没写种类", "没写测试", "要给每个值写中文名", "脚本 scripts/none.mjs 不在项目的工作目录里"]) expect(failed.text).toContain(words);
    expect(app.calls()).toEqual([]);
    // 测试回的没有 say、只读的写了文件
    s.writeOps("p-1", { ...LEDGER_OPS, tools: [op("legacy_list"), op("leaky_query")] });
    const tested = await s.check("p-1");
    expect(tested.isError).toBe(true);
    expect(tested.text).toContain("操作 legacy_list 的测试回的没有能念的 say");
    expect(tested.text).toContain("只读查询 leaky_query 的测试改了文件");
    expect(s.registered()).toEqual([]);
    // 维护者收不了工单的
    s.writeOps("p-2", { tools: [op("ask", { kind: "action", impl: { type: "maintainer" } })] });
    expect((await s.check("p-2")).text).toContain("要转给维护者当工单，可这个项目现在收不了：项目「旅行相册」已归档");
  });

  it("项目服务没在跑的：别的都过了就等着（清单上打勾、写明确认后再测），服务起来后秘书第一次用到时验、过了登记", async () => {
    const idle = await freePort();
    const building = project("p-1", "记账本", "building", { kind: "dev" });
    const s = setup({
      projects: [building],
      plans: { "p-1": { revision: 1, items: [{ name: "记账本网页", service: { name: "ledger", app: "p-1-ledger", port: idle } }] } as unknown as OperationsPlanView },
      ops: { "p-1": LEDGER_OPS },
    });
    await s.ops.prepareGoLive("p-1");
    expect(s.ops.checklistItem(building)).toMatchObject({ done: true, detail: "2 个操作格式对、能跑的测试都过了；项目服务上的 2 个确认后服务上线时再测" });
    // 转入使用时不登记（还没全过）
    expect(s.ops.goLiveEvents(building)).toEqual([]);
    // 转入使用、服务起来了：秘书第一次用到时验、过了登记
    const app = await startFakeOpsApp();
    s.setProjects([{ ...building, state: "in_use" }]);
    s.setServices([service("p-1", "ledger", app.port)]);
    const listed = await s.run({ action: "list" });
    expect(listed.text).toContain("项目 p-1「记账本」（运营接口清单第 1 版");
    expect(s.registered().map((r) => r.version)).toEqual([1]);
  });

  it("使用中改了清单：重新验收、全过了登记成下一版（秘书马上用新的）；没过的照旧用上一版，告诉维护者一次；记录里带版本号", async () => {
    const app = await startFakeOpsApp();
    const s = setup({ projects: [project("p-1", "记账本", "in_use")], services: [service("p-1", "ledger", app.port)], ops: { "p-1": LEDGER_OPS } });
    // 第一次用到：验、登记第 1 版
    expect((await s.run({ action: "call", project: "记账本", op: "list_expenses" })).text).toContain("（运营接口清单第 1 版）做好了");
    // 加一个操作：用到时重新验收、登记第 2 版
    s.writeOps("p-1", { ...LEDGER_OPS, tools: [...LEDGER_OPS.tools, op("legacy_list_v2", { kind: "query", test: { args: {} } })] });
    // legacy_list_v2 这个名字服务不认得（404）：验收没过，照旧用第 1 版、告诉维护者
    const listed = await s.run({ action: "list" });
    expect(listed.text).toContain("运营接口清单第 1 版");
    expect(listed.text).toContain("档案里的运营接口清单改过了，验收没过：操作 legacy_list_v2 的测试没跑通");
    expect(s.notified).toHaveLength(1);
    expect(s.notified[0]!.text).toContain("秘书照旧用第 1 版");
    expect(s.notified[0]!.text).toContain("check_ops");
    // 同一份内容不再自动验、不再说第二次
    await s.run({ action: "list" });
    expect(s.notified).toHaveLength(1);
    // 新操作没登记，调不了；老的照常用第 1 版
    expect((await s.run({ action: "call", project: "记账本", op: "legacy_list_v2" })).text).toContain("没有操作「legacy_list_v2」");
    // 维护者用 check_ops 验：legacy_list 回的没有 say，没过
    s.writeOps("p-1", { ...LEDGER_OPS, tools: [...LEDGER_OPS.tools, op("legacy_list", { kind: "query", test: { args: {} } })] });
    const report = await s.check("p-1");
    expect(report.isError).toBe(true); // legacy_list 没回 say：没过
    expect(report.text).toContain("秘书照旧用第 1 版");
    // 改对了（这里改的是 add_expense 的用法说明：内容变了就算改）：check_ops 验收全过，登记成第 2 版
    s.writeOps("p-1", { ...LEDGER_OPS, tools: [{ ...LEDGER_OPS.tools[0]!, usage: "金额不清楚先问" }, LEDGER_OPS.tools[1]!] });
    const passed = await s.check("p-1");
    expect(passed.isError).toBe(false);
    expect(passed.text).toContain("登记成第 2 版，秘书马上用它");
    const done = await s.run({ action: "call", project: "记账本", op: "add_expense", args: { amount: 32, note: "午饭" } });
    expect(done.text).toContain("（运营接口清单第 2 版）做好了");
    expect(s.called().map((c) => [c.op, c.version])).toEqual([
      ["list_expenses", 1],
      ["add_expense", 2],
    ]);
    // 档案里的 ops.json 删掉了：照旧用登记着的第 2 版
    fs.rmSync(path.join(s.recordsOf("p-1"), "ops.json"));
    expect((await s.run({ action: "list" })).text).toContain("运营接口清单第 2 版");
  });

  it("转运营清单那一项的几种样子：没交、模板原样、读不通、格式不对", async () => {
    const building = project("p-1", "记账本", "building", { kind: "dev" });
    const s = setup({ projects: [building] });
    expect(s.ops.checklistItem(building)).toMatchObject({ done: false, detail: "缺 ops.json" });
    s.writeOps("p-1", fs.readFileSync(path.join(STANDARD_TEMPLATES_DIR, "v1", "dev", "zh-CN", "ops.json"), "utf8"));
    expect(s.ops.checklistItem(building)).toMatchObject({ done: false, detail: "ops.json 还是模板原样" });
    s.writeOps("p-1", "{ broken");
    expect(s.ops.checklistItem(building).detail).toContain("验收没过（1 处）：不是合法的 JSON");
    s.writeOps("p-1", { tools: [{ name: "a" }] });
    expect(s.ops.checklistItem(building).detail).toContain("验收没过（6 处）：操作 a 没写中文标题");
    // 一个操作都没有（项目只用通用操作）：没有测试要跑，当场全过
    s.writeOps("p-1", { tools: [] });
    expect(s.ops.checklistItem(building)).toMatchObject({ done: true, detail: "验收通过：0 个操作的测试都跑通，只读的没写东西" });
  });
});

describe("list、describe", () => {
  it("list：开头列一次通用操作，每个使用中的项目一段（第几版、调用口、自己的操作标种类和风险标记）；没交清单的只有通用操作；不是使用中的不列", async () => {
    const app = await startFakeOpsApp();
    const s = setup({
      projects: [project("p-1", "记账本", "in_use"), project("p-2", "简报站", "in_use"), project("p-3", "旅行相册", "in_use"), project("p-5", "在建的", "building")],
      services: [service("p-1", "ledger", app.port), service("p-3", "site", 18_003, { paused: true, status: "offline" })],
      ops: { "p-1": LEDGER_OPS, "p-3": "{ broken", "p-5": LEDGER_OPS },
    });
    const listed = await s.run({ action: "list" });
    expect(listed.isError).toBe(false);
    expect(listed.text).toContain("每个使用中的项目都有的通用操作（op 照写）：status「状态」、recent_runs「最近运行」、latest_deliverables「最新交付件」、run_now「立即跑一次」、pause_resume「暂停恢复」、reschedule「改时间」、tell_maintainer「跟维护者说一句」");
    expect(listed.text).toContain(`项目 p-1「记账本」（运营接口清单第 1 版；调用口在服务「记账本网页」（p-1 · p-1-ledger · 端口 ${app.port}）：在线）：`);
    expect(listed.text).toContain("- add_expense「记一笔支出」（有副作用的动作 · 直接做）：记一笔支出：金额（元）、分类和备注。");
    expect(listed.text).toContain("- list_expenses「查支出」（只读查询）：查最近记的支出和合计。");
    expect(listed.text).toContain("项目 p-2「简报站」：");
    expect(listed.text).toContain("项目「简报站」还没交运营接口清单（档案里没有 ops.json），只有通用操作");
    expect(listed.text).toContain("项目「旅行相册」档案里的运营接口清单改过了，验收没过：不是合法的 JSON");
    expect(listed.text).not.toContain("在建的");
    const one = await s.run({ action: "list", project: "记账本" });
    expect(one.text).toContain("add_expense");
    expect(one.text).not.toContain("简报站");
    expect((await s.run({ action: "list", project: "在建的" })).text).toContain("项目「在建的」现在是建设中，不是使用中的");
    const none = setup({ projects: [project("p-1", "在建的", "building")] });
    expect((await none.run({ action: "list" })).text).toContain("现在没有使用中的项目");
  });

  it("describe：中文标题、种类、风险标记、说明、用户可能怎么说、参数逐个（类型、必填还是默认值、枚举的值和中文名）、JSON Schema、返回、实现方式、怎么调；通用操作的 job 列成枚举", async () => {
    const app = await startFakeOpsApp();
    const ledger = project("p-1", "记账本", "in_use", { operations: { revision: 1, confirmedAt: nowIso(), items: [{ key: "daily-report", name: "日报", taskId: "t-1" }] } as unknown as Project["operations"] });
    const s = setup({ projects: [ledger], services: [service("p-1", "ledger", app.port)], ops: { "p-1": LEDGER_OPS }, jobs: [job("j-1", "p-1", "日报"), job("j-2", "p-1", "周报", { ownerTaskId: "t-2", taskId: "t-2" })] });
    const described = await s.run({ action: "describe", project: "p-1", op: "add_expense" });
    expect(described.isError).toBe(false);
    for (const words of [
      "项目 p-1「记账本」的操作 add_expense「记一笔支出」（有副作用的动作 · 直接做；运营接口清单第 1 版）",
      "说明：记一笔支出：金额（元）、分类和备注。用户要记账时用。",
      "用户可能这么说：“记一笔午饭 32 块”、“刚打车花了 25”",
      "- amount（number，必填）：金额（元）",
      '- category（只能写 "food"（吃饭）、"transport"（交通）、"other"（其他），默认 "other"）：分类',
      "返回：say 说记好了什么；detail 是这笔记录。",
      "实现方式：项目服务的本机调用口",
      "风险标记：直接做（现在只显示，使用中的项目调操作不用确认）",
      "action 写 call",
    ])
      expect(described.text).toContain(words);
    // 通用操作：job 照这个项目现在有的列成枚举（运营方案那一条的 key，没有的用触发登记编号）
    const builtin = await s.run({ action: "describe", project: "记账本", op: "run_now" });
    expect(builtin.text).toContain("的操作 run_now「立即跑一次」（触发一次运行 · 直接做；通用操作）");
    expect(builtin.text).toContain('- job（只能写 "daily-report"（日报）、"j-2"（周报），可不写）');
    expect(builtin.text).toContain("调了就开始跑，不等跑完");
    const missing = await s.run({ action: "describe", project: "记账本", op: "delete_all" });
    expect(missing.isError).toBe(true);
    expect(missing.text).toContain("没有操作「delete_all」。它有：add_expense、list_expenses、status");
    expect((await s.run({ action: "describe", project: "不存在", op: "add_expense" })).text).toContain("没有项目「不存在」");
    expect((await s.run({ action: "describe", project: "记账本" })).text).toContain("op");
    expect((await s.run({ action: "call", op: "add_expense" })).text).toContain("project");
  });
});

describe("call", () => {
  it("参数不对不发：说清哪里不对，连同这个操作的说明退回；中文名、默认值整理好了才发；say 必有，没给的二狗补（记下 sayFilled）", async () => {
    const app = await startFakeOpsApp();
    const s = setup({ projects: [project("p-1", "记账本", "in_use")], services: [service("p-1", "ledger", app.port)], ops: { "p-1": LEDGER_OPS } });
    const bad = await s.run({ action: "call", project: "记账本", op: "add_expense", args: { amount: "三十二" } });
    expect(bad.isError).toBe(true);
    expect(bad.text).toContain("项目「记账本」的操作 add_expense 参数不对，没发出去：");
    expect(bad.text).toContain("参数 amount");
    expect(bad.text).toContain("这个操作的说明（照它改了再调）：");
    expect(bad.text).toContain("- amount（number，必填）");
    // 只有验收时的两次测试调用，参数不对的一个都没发
    expect(app.calls().filter((c) => c["_meta"] === undefined)).toEqual([]);
    expect(s.called()).toEqual([]);
    const done = await s.run({ action: "call", project: "记账本", op: "add_expense", args: { amount: 32, category: "吃饭", note: "午饭", api_token: "tok-abcdefgh12345678" }, why: "用户说记一笔午饭 32 块" });
    expect(done.isError).toBe(false);
    expect(done.text).toContain("项目「记账本」的操作 add_expense（运营接口清单第 1 版）做好了。\n能念的一句：记好了：午饭 32 元\n附件（细节，用户问再说）：");
    expect(app.calls().at(-1)).toEqual({ name: "add_expense", arguments: { amount: 32, category: "food", note: "午饭", api_token: "tok-abcdefgh12345678" } });
    expect(s.called()).toMatchObject([
      { op: "add_expense", version: 1, builtin: false, kind: "action", readOnly: false, risk: "direct", impl: "http", say: "记好了：午饭 32 元", sayFilled: false, outcome: "done", why: "用户说记一笔午饭 32 块", app: "p-1-ledger" },
    ]);
    expect(JSON.stringify(s.called())).not.toContain("tok-abcdefgh12345678");
    expect(s.timeline()).toMatchObject([{ kind: "project_op", summary: "秘书调了项目「记账本」的操作 add_expense（记好了：午饭 32 元）" }]);
    expect(s.timeline()[0]!.detail).toContain("运营接口清单第 1 版");
    expect(s.timeline()[0]!.detail).toContain("能念的一句：记好了：午饭 32 元");
    expect(JSON.stringify(s.timeline())).not.toContain("tok-abcdefgh12345678");
    // 服务没给 say 的（登记着的旧写法）：二狗按结果补一句，记下来
    s.store.append({
      channel: OPERATIONS_CHANNEL,
      type: PROJECT_OPS_EVENTS.registered,
      payload: { ...s.registered()[0]!, version: 2, hash: "old-style", ops: [...s.registered()[0]!.ops, { ...parseLegacy(), name: "legacy_list" }] },
    });
    s.writeOps("p-1", "{}"); // 档案里的读不通：照旧用登记着的第 2 版
    const legacy = await s.run({ action: "call", project: "记账本", op: "legacy_list" });
    expect(legacy.isError).toBe(false);
    expect(legacy.text).toContain("能念的一句（实现没给，二狗按结果补的）：「操作legacy_list」查好了，细节在附件里。");
    expect(legacy.text).toContain('{"items":[{"note":"午饭","amount":32}],"total":32}');
    expect(s.called().at(-1)).toMatchObject({ op: "legacy_list", version: 2, sayFilled: true });
    expect(s.timeline().at(-1)!.detail).toContain("实现没给，二狗按结果补的");
  });

  it("服务报错原样带回、说清能念的那句、附上说明；isError 的 200 也算没做成", async () => {
    const app = await startFakeOpsApp();
    const jammed = op("jammed", { kind: "action", test: { args: {} } });
    const s = setup({ projects: [project("p-1", "记账本", "in_use")], services: [service("p-1", "ledger", app.port)], ops: { "p-1": { ...LEDGER_OPS, tools: [...LEDGER_OPS.tools] } } });
    await s.run({ action: "list" });
    // jammed 验收会没过（测试调用报错）：直接登记一版带它的，看秘书调时怎么说
    s.store.append({ channel: OPERATIONS_CHANNEL, type: PROJECT_OPS_EVENTS.registered, payload: { ...s.registered()[0]!, version: 2, hash: "with-jammed", ops: [...s.registered()[0]!.ops, ...asOps([jammed])] } });
    s.writeOps("p-1", "{}");
    const r = await s.run({ action: "call", project: "记账本", op: "jammed" });
    expect(r.isError).toBe(true);
    expect(r.text).toContain("项目「记账本」的操作 jammed 没做成。\n能念的一句：账本被锁着，稍后再试");
    expect(r.text).toContain("账本文件被别的程序锁着");
    expect(r.text).toContain("这个操作的说明");
    expect(s.called().at(-1)).toMatchObject({ op: "jammed", outcome: "failed", say: "账本被锁着，稍后再试", sayFilled: false });
  });

  it("四种实现方式各一条：script（工作目录里的脚本，JSON 进出）、ergo（二狗自带动作绑参数）、maintainer（转给维护者当工单）", async () => {
    const ledger = project("p-1", "记账本", "in_use", { operations: { revision: 1, confirmedAt: nowIso(), items: [{ key: "daily-report", name: "日报", taskId: "t-1" }] } as unknown as Project["operations"] });
    const s = setup({ projects: [ledger], jobs: [job("j-1", "p-1", "日报")] });
    fs.mkdirSync(path.join(s.workdirOf("p-1"), "scripts"), { recursive: true });
    fs.writeFileSync(
      path.join(s.workdirOf("p-1"), "scripts", "month.mjs"),
      [
        'let input = "";',
        'process.stdin.on("data", (c) => (input += c));',
        'process.stdin.on("end", () => {',
        "  const req = JSON.parse(input);",
        '  const test = process.env.ERGO_OPS_TEST === "1";',
        '  if (req.arguments.month === "bad") { console.error("没有这个月"); process.exit(2); }',
        '  process.stdout.write(JSON.stringify({ say: (test ? "测试：" : "") + req.arguments.month + " 月花了 320 元", detail: { op: req.name, args: req.arguments, project: process.env.ERGO_OPS_PROJECT, meta: req._meta ?? null } }));',
        "});",
      ].join("\n"),
    );
    s.writeOps("p-1", {
      tools: [
        op("month_report", { title: "月报", inputSchema: { type: "object", properties: { month: { type: "string", default: "10" } } }, impl: { type: "script", file: "scripts/month.mjs" }, test: { args: { month: "9" }, sayIncludes: "测试" } }),
        op("refresh_report", { title: "刷新日报", kind: "run", impl: { type: "ergo", action: "run_now", params: { job: "daily-report" } }, test: { args: {} } }),
        op("add_source", {
          title: "加信息源",
          kind: "action",
          inputSchema: { type: "object", properties: { url: { type: "string" } }, required: ["url"] },
          impl: { type: "maintainer", instructions: "把 {{url}} 加进信息源" },
          test: { args: { url: "https://example.com/feed" } },
        }),
      ],
    });
    // 验收：脚本带着 ERGO_OPS_TEST 跑；ergo 的立即跑一次只看做不做得了；maintainer 只看收不收、不真建
    const report = await s.check("p-1");
    expect(report.isError).toBe(false);
    expect(report.text).toContain("验收全过：3 个操作的测试都跑通了");
    expect(report.text).toContain("month_report：过了（说：测试：9 月花了 320 元）");
    expect(s.scheduled).toEqual(["check j-1"]);
    expect(s.delegated.every((d) => d.check)).toBe(true);
    // script
    const month = await s.run({ action: "call", project: "记账本", op: "month_report" });
    expect(month.isError).toBe(false);
    expect(month.text).toContain("能念的一句：10 月花了 320 元");
    expect(month.text).toContain('"project":"p-1"');
    expect(month.text).toContain('"meta":null');
    const badMonth = await s.run({ action: "call", project: "记账本", op: "month_report", args: { month: "bad" } });
    expect(badMonth.isError).toBe(true);
    expect(badMonth.text).toContain("没有这个月");
    // ergo：绑定的参数代入后照"立即跑一次"做
    const refreshed = await s.run({ action: "call", project: "记账本", op: "refresh_report" }, { toolCallId: "call-refresh" });
    expect(refreshed.text).toContain("能念的一句：「日报」排上了，马上跑一次。");
    expect(s.scheduled.at(-1)).toBe("run j-1 secretary project-op:call-refresh");
    // maintainer：建一个项目内部的普通任务，任务书写清操作、参数、为什么
    const handed = await s.run({ action: "call", project: "记账本", op: "add_source", args: { url: "https://news.example.com/rss" }, why: "用户要加个源" });
    expect(handed.text).toContain("能念的一句：「加信息源」转给「记账本」的维护者当工单了");
    const real = s.delegated.filter((d) => !d.check);
    expect(real).toHaveLength(1);
    expect(real[0]!.instructions).toContain("把 https://news.example.com/rss 加进信息源");
    expect(real[0]!.instructions).toContain("为什么：用户要加个源");
    expect(s.called().map((c) => [c.op, c.impl, c.script ?? c.action ?? c.taskId])).toEqual([
      ["month_report", "script", "scripts/month.mjs"],
      ["month_report", "script", "scripts/month.mjs"],
      ["refresh_report", "ergo", "run_now"],
      ["add_source", "maintainer", "t-9"],
    ]);
  });

  it("通用操作（不用写清单）：状态、最近运行、最新交付件、立即跑一次、暂停恢复、改时间、跟维护者说一句", async () => {
    const ledger = project("p-1", "记账本", "in_use", { operations: { revision: 1, confirmedAt: nowIso(), items: [{ key: "daily-report", name: "日报", taskId: "t-1" }] } as unknown as Project["operations"] });
    const started = new Date(Date.now() - 60_000).toISOString();
    const ended = new Date(Date.now() + 60_000).toISOString();
    const runs: JobRun[] = [
      { runId: "j-1-r1", jobId: "j-1", trigger: "scheduled", dueAt: started, state: "done", queuedAt: started, startedAt: started, endedAt: ended, summary: "今天的日报写好了" } as JobRun,
      { runId: "j-2-r1", jobId: "j-2", trigger: "manual", dueAt: started, state: "failed", queuedAt: new Date(Date.now() - 120_000).toISOString(), reason: "网站打不开" } as JobRun,
    ];
    const s = setup({
      projects: [ledger],
      services: [service("p-1", "ledger", 18_001)],
      jobs: [job("j-1", "p-1", "日报"), job("j-2", "p-1", "周报", { ownerTaskId: "t-2", taskId: "t-2", state: "paused", pausedBy: "user" })],
      runs: { "j-1": [runs[0]!], "j-2": [runs[1]!] },
    });
    fs.mkdirSync(path.join(s.workdirOf("p-1"), "reports"), { recursive: true });
    fs.writeFileSync(path.join(s.workdirOf("p-1"), "reports", "2026-10-25.md"), "# 日报");

    const status = await s.run({ action: "call", project: "记账本", op: "status" });
    expect(status.text).toContain("能念的一句：「记账本」使用中；服务在线；1/2 条定时 / 事件触发的任务在跑");
    expect(status.text).toContain("「周报」（j-2）：已暂停");
    expect(status.text).toContain("运营接口清单：还没有登记过的版本（只有通用操作）");

    const recent = await s.run({ action: "call", project: "记账本", op: "recent_runs", args: { limit: 5 } });
    expect(recent.text).toContain("能念的一句：最近一次是「日报」");
    expect(recent.text).toContain("今天的日报写好了");
    expect(recent.text).toContain("网站打不开");

    const deliverables = await s.run({ action: "call", project: "记账本", op: "latest_deliverables" });
    expect(deliverables.text).toContain("交了 1 个文件：reports/2026-10-25.md");

    // 立即跑一次：job 写中文名也行（枚举带中文名）；好几条时不写 job 要说清
    expect((await s.run({ action: "call", project: "记账本", op: "run_now" })).text).toContain("有好几条定时 / 事件触发的任务，job 写是哪一条：daily-report（日报）、j-2（周报）");
    const ran = await s.run({ action: "call", project: "记账本", op: "run_now", args: { job: "日报" } }, { toolCallId: "call-run" });
    expect(ran.text).toContain("「日报」排上了，马上跑一次。");
    expect(s.scheduled).toContain("run j-1 secretary project-op:call-run");

    // 暂停恢复：不写 job 是全部；本来就暂停着的说清；action 写中文名
    const paused = await s.run({ action: "call", project: "记账本", op: "pause_resume", args: { action: "暂停" } }, { toolCallId: "call-pause" });
    expect(paused.text).toContain("能念的一句：「日报」暂停了（「周报」本来就暂停着）。");
    expect(s.scheduled).toContain("pause j-1 project-op:call-pause#0");

    // 改时间：只改钟点
    const moved = await s.run({ action: "call", project: "记账本", op: "reschedule", args: { job: "daily-report", time: "7:30" } }, { toolCallId: "call-move" });
    expect(moved.text).toContain("「日报」改成每天 07:30 了");
    expect(s.scheduled.at(-1)).toBe('reschedule j-1 {"kind":"daily","time":"07:30"} project-op:call-move');
    expect((await s.run({ action: "call", project: "记账本", op: "reschedule", args: { time: "25:00" } })).text).toContain("time 要写几点几分");

    // 跟维护者说一句
    const told = await s.run({ action: "call", project: "记账本", op: "tell_maintainer", args: { message: "下个月起分类加一个“宠物”" } });
    expect(told.text).toContain("能念的一句：转给「记账本」的维护者了。");
    expect(s.told).toEqual([{ projectId: "p-1", message: "下个月起分类加一个“宠物”" }]);
    expect((await s.run({ action: "call", project: "记账本", op: "tell_maintainer", args: {} })).text).toContain("参数不对，没发出去");

    // 记录：通用操作没有版本号
    expect(s.called().map((c) => [c.op, c.version, c.builtin, c.kind])).toEqual([
      ["status", null, true, "query"],
      ["recent_runs", null, true, "query"],
      ["latest_deliverables", null, true, "query"],
      ["run_now", null, true, "run"],
      ["run_now", null, true, "run"],
      ["pause_resume", null, true, "action"],
      ["reschedule", null, true, "action"],
      ["reschedule", null, true, "action"],
      ["tell_maintainer", null, true, "action"],
    ]);
    expect(s.timeline().at(-1)!.detail).toContain("通用操作");
  });

  it("服务关着（257）、关闭中、还在上线、上线失败、要你手动：回原因，不去调、不记录（通用操作照样能用）", async () => {
    const app = await startFakeOpsApp();
    const s = setup({ projects: [project("p-1", "记账本", "in_use")], services: [service("p-1", "ledger", app.port)], ops: { "p-1": LEDGER_OPS } });
    await s.run({ action: "list" }); // 先验收、登记
    const before = app.calls().length;
    s.setServices([service("p-1", "ledger", app.port, { paused: true, status: "offline" })]);
    const closed = await s.run({ action: "call", project: "记账本", op: "list_expenses" });
    expect(closed.isError).toBe(true);
    expect(closed.text).toContain("项目「记账本」的服务关着");
    expect(closed.text).toContain("switch_project_services");
    s.setServices([service("p-1", "ledger", app.port, { power: "stopping" })]);
    expect((await s.run({ action: "call", project: "记账本", op: "list_expenses" })).text).toContain("服务关着");
    s.setServices([service("p-1", "ledger", app.port, { rollout: "pending", status: "unknown" })]);
    expect((await s.run({ action: "call", project: "记账本", op: "list_expenses" })).text).toContain("还在上线");
    s.setServices([service("p-1", "ledger", app.port, { rollout: "failed", reason: "端口被占了" })]);
    expect((await s.run({ action: "call", project: "记账本", op: "list_expenses" })).text).toContain("上线失败：端口被占了");
    s.setServices([service("p-1", "ledger", app.port, { rollout: "manual", reason: "LSM 版本不支持名下的服务" })]);
    expect((await s.run({ action: "call", project: "记账本", op: "list_expenses" })).text).toContain("LSM 版本不支持名下的服务");
    expect(app.calls().length).toBe(before);
    expect(s.called()).toEqual([]);
    // 通用操作照样能用
    expect((await s.run({ action: "call", project: "记账本", op: "status" })).isError).toBe(false);
  });

  it("连不上（服务没在跑）、等不到：回原因和服务现在的样子，记成 failed", async () => {
    const app = await startFakeOpsApp();
    const s = setup({ projects: [project("p-1", "记账本", "in_use")], services: [service("p-1", "ledger", app.port)], ops: { "p-1": { ...LEDGER_OPS, tools: [...LEDGER_OPS.tools] } } });
    await s.run({ action: "list" });
    const idle = await freePort();
    s.setServices([service("p-1", "ledger", idle, { status: "failed", detail: "进程退出了" })]);
    const refused = await s.run({ action: "call", project: "记账本", op: "list_expenses" });
    expect(refused.isError).toBe(true);
    expect(refused.text).toContain(`调用口连不上（本机 127.0.0.1:${idle}/ops 没有响应）`);
    expect(refused.text).toContain("进程退出了");
    expect(s.called()).toMatchObject([{ outcome: "failed", sayFilled: true }]);

    const slow = setup({ projects: [project("p-1", "记账本", "in_use")], services: [service("p-1", "ledger", app.port)], timeoutMs: 300 });
    slow.store.append({ channel: OPERATIONS_CHANNEL, type: PROJECT_OPS_EVENTS.registered, payload: registeredPayload("p-1", "记账本", [op("slow", { kind: "action" })]) });
    const waited = await slow.run({ action: "call", project: "记账本", op: "slow" });
    expect(waited.isError).toBe(true);
    expect(waited.text).toContain("等了 0.3 秒没回");
    expect(slow.called()).toMatchObject([{ outcome: "failed" }]);
  });

  it("调用口对不上服务（写的服务不在、几个服务没写是哪个、没有服务）：验收不过，说清楚", async () => {
    const app = await startFakeOpsApp();
    const s = setup({ projects: [project("p-1", "记账本", "in_use")], services: [service("p-1", "ledger", app.port)] });
    s.writeOps("p-1", { ...LEDGER_OPS, endpoint: { service: "api", path: "/ops" } });
    expect((await s.check("p-1")).text).toContain("清单里调用口写在服务「api」上，可这个项目没有这个服务（它的服务：ledger）");
    s.writeOps("p-1", { ...LEDGER_OPS, endpoint: { path: "/ops" } });
    s.setServices([service("p-1", "ledger", app.port), service("p-1", "admin", app.port + 1)]);
    expect((await s.check("p-1")).text).toContain("这个项目有好几个服务（ledger、admin），清单的 endpoint.service 要写调用口在哪个服务上");
    s.setServices([]);
    expect((await s.check("p-1")).text).toContain("这个项目没有在 LSM 上的服务");
    expect(app.calls()).toEqual([]);
  });
});

// ───────────────────────── 小工具 ─────────────────────────

/** 参数说明本身的毛病（code） */
const codes = (schema: Record<string, unknown>) => schemaProblems("a", schema).map((m) => m.code);

const useLanguage = (language: string) => setActiveLocale(activeLocaleFrom(builtinCatalogs().catalogs, language));

async function waitFor(ok: () => boolean, timeoutMs = 10_000): Promise<void> {
  const start = Date.now();
  while (!ok()) {
    if (Date.now() - start > timeoutMs) throw new Error("等不到");
    await new Promise((r) => setTimeout(r, 20));
  }
}

/** 照清单读出来的样子（直接写登记事件用） */
function asOps(tools: unknown[]) {
  const read = parseOpsManifest(JSON.stringify({ tools }));
  if (read.kind !== "ok") throw new Error("清单写坏了");
  return read.ops;
}

/** 一个没写 say 的旧写法操作（legacy_list） */
function parseLegacy() {
  return asOps([op("legacy_list")])[0]!;
}

function registeredPayload(projectId: string, projectName: string, tools: unknown[]): OpsManifestRegisteredPayload {
  return { projectId, projectName, version: 1, hash: "h", endpoint: { path: "/ops" }, ops: asOps(tools), via: "go_live", time: nowIso() };
}
