// 项目规范（258 号票，issue 19 第 1、4、6、11 条）：模板放在框架里按版本分目录、开发类和其他类各一套，每份开头写清写什么、什么时候更新；
// 新项目按类型从模板生成档案（立项时类型还没定，先按其他类那三份；立项书确认成开发类时补上开发类另有的），辅助的几份照旧；
// 只读视图：模板版本、每份文档在不在和最近修改时间（必须有的标出来、还是模板原样的标出来）、当前状态的检查清单、规范改写。
// 259 号票：建设中 → 使用中的检查清单（架构图写清服务和对外接口、ops.json、服务写进运营方案、要外网的有带网页的服务、进展写回），
// 没做到的写差什么；其他类只查进展，运营方案里有服务的照开发类查。
// 261 号票：本项目的规范改写（不要的那份不补回来、视图里标出来、检查清单不列它对应的项，换写法、多出来的），模板出了新版只提示（跟了才补缺的）。
import fs from "node:fs";
import path from "node:path";
import { PROJECT_STANDARD_LATEST, type Project, standardDocState } from "@ergo/protocol";
import { afterEach, describe, expect, test } from "vitest";
import { installBuiltinLocales } from "../../src/i18n/index.ts";
import { ensureProjectRecords, projectRecordsPaths } from "../../src/projects/records.ts";
import { architectureTables, type ChecklistPlan, ensureStandardDocs, goLiveChecklist, projectStandardView, STANDARD_TEMPLATES_DIR, standardTemplates } from "../../src/projects/standard.ts";
import { makeTempDir } from "../helpers/temp-dir.ts";

const T0 = "2026-10-24T09:00:00.000+08:00";

const DEV_FILES = ["adr/README.md", "architecture.md", "ops.json", "progress.md", "spec.md", "tickets/README.md"];
const OTHER_FILES = ["adr/README.md", "progress.md", "spec.md"];
const COMMON_FILES = OTHER_FILES;
const LANGUAGES = ["zh-CN", "en"];

/** 目录下的文件（相对路径，正斜杠，排好序） */
function filesUnder(dir: string): string[] {
  return (fs.readdirSync(dir, { recursive: true, withFileTypes: true }) as fs.Dirent[])
    .filter((e) => e.isFile())
    .map((e) => path.relative(dir, path.join(e.parentPath, e.name)).split(path.sep).join("/"))
    .toSorted();
}

const read = (file: string) => fs.readFileSync(file, "utf8").replace(/\r\n/g, "\n");

function project(overrides: Partial<Project> = {}): Project {
  return {
    id: "p-1",
    name: "记账本",
    goal: "把家里的账管起来",
    state: "preparing",
    origin: "suggestion",
    maintainerId: "pm-1",
    workdir: { external: false },
    charterConfirmed: false,
    standardVersion: PROJECT_STANDARD_LATEST,
    createdAt: T0,
    updatedAt: T0,
    ...overrides,
  };
}

function setup(p: Project = project()) {
  const projectsDir = path.join(fs.realpathSync.native(makeTempDir("ergo-data-")), "projects");
  const paths = projectRecordsPaths(projectsDir, p.id);
  ensureProjectRecords(paths, p);
  return { paths };
}

afterEach(() => installBuiltinLocales());

describe("规范模板：框架里按版本分目录，开发类、其他类各一套", () => {
  test("最新的版本就是 PROJECT_STANDARD_LATEST；每个版本、每类、每种语言的文件都齐（开发类多架构图、票、运营接口清单）", () => {
    const versions = fs.readdirSync(STANDARD_TEMPLATES_DIR).toSorted((a, b) => Number(a.slice(1)) - Number(b.slice(1)));
    expect(versions.at(-1)).toBe(PROJECT_STANDARD_LATEST);
    expect(standardTemplates().versions()).toEqual(versions);
    for (const version of versions) {
      expect(fs.readdirSync(path.join(STANDARD_TEMPLATES_DIR, version)).toSorted()).toEqual(["dev", "other"]);
      for (const language of LANGUAGES) {
        expect(filesUnder(path.join(STANDARD_TEMPLATES_DIR, version, "dev", language))).toEqual(DEV_FILES);
        expect(filesUnder(path.join(STANDARD_TEMPLATES_DIR, version, "other", language))).toEqual(OTHER_FILES);
      }
    }
  });

  test("每份开头写清这份写什么、什么时候更新（Markdown 是标题下面一段引用，ops.json 是 $comment），标着规范的版本", () => {
    /** 不合规矩的：哪一份、哪里不对 */
    const problems: string[] = [];
    for (const version of standardTemplates().versions()) {
      for (const kind of ["dev", "other"] as const) {
        for (const language of LANGUAGES) {
          const dir = path.join(STANDARD_TEMPLATES_DIR, version, kind, language);
          const [what, when] = language === "zh-CN" ? ["**这份写什么**", "**什么时候更新**"] : ["**What goes here**", "**When to update**"];
          for (const rel of filesUnder(dir)) {
            const where = `${version}/${kind}/${language}/${rel}`;
            const text = read(path.join(dir, rel));
            if (rel.endsWith(".json")) {
              const json = JSON.parse(text) as { $comment?: string[]; tools?: unknown[] };
              if (!Array.isArray(json.tools) || json.tools.length > 0) problems.push(`${where}：tools 要是空的`);
              if (!json.$comment?.join("\n").includes(version)) problems.push(`${where}：$comment 里没写版本`);
              continue;
            }
            const [title, blank, whatLine, whenLine, versionLine] = text.split("\n");
            if (!title?.startsWith("# ") || blank !== "") problems.push(`${where}：第一行要是标题，接着空一行`);
            if (!whatLine?.startsWith(`> ${what}`)) problems.push(`${where}：标题下面要先写${what}`);
            if (!whenLine?.startsWith(`> ${when}`)) problems.push(`${where}：接着写${when}`);
            if (!versionLine?.includes(version)) problems.push(`${where}：再一行写规范的版本`);
          }
        }
      }
    }
    expect(problems).toEqual([]);
  });

  test("规格、进展、决策记录两类一字不差（立项时类型还没定，先按其他类生成，开发类也用这三份）", () => {
    const differ = standardTemplates()
      .versions()
      .flatMap((version) => LANGUAGES.flatMap((language) => COMMON_FILES.map((rel) => ({ version, language, rel }))))
      .filter(({ version, language, rel }) => read(path.join(STANDARD_TEMPLATES_DIR, version, "dev", language, rel)) !== read(path.join(STANDARD_TEMPLATES_DIR, version, "other", language, rel)))
      .map(({ version, language, rel }) => `${version}/${language}/${rel}`);
    expect(differ).toEqual([]);
  });

  test("中文的规格、进展里留着原来那句开头的话（只出现一次）：维护者照旧把它整句换成内容", () => {
    const dir = path.join(STANDARD_TEMPLATES_DIR, PROJECT_STANDARD_LATEST, "dev", "zh-CN");
    for (const [rel, line] of [
      ["spec.md", "这个项目要做成什么样：立项问答时由维护者写。"],
      ["progress.md", "做到哪了、下一步做什么：每段工作结束时写回。"],
    ] as const) {
      expect(read(path.join(dir, rel)).split(line)).toHaveLength(2);
    }
  });
});

describe("新项目按类型从模板生成档案", () => {
  test("立项时（类型还没定）：规格、进展、决策记录照模板（其他类那三份），立项书、术语表、项目清单、范围记录照旧生成；没有开发类另有的", () => {
    const { paths } = setup();
    const template = (rel: string) => read(path.join(STANDARD_TEMPLATES_DIR, "v1", "other", "zh-CN", rel));
    expect(read(paths.spec)).toBe(template("spec.md"));
    expect(read(paths.progress)).toBe(template("progress.md"));
    expect(read(path.join(paths.adr, "README.md"))).toBe(template("adr/README.md"));
    expect(read(paths.glossary)).toContain("# 术语表\n\n项目「记账本」（p-1）：把家里的账管起来");
    expect(fs.readdirSync(paths.root).toSorted()).toEqual(["adr", "charter.md", "glossary.md", "manifest.md", "progress.md", "scope-records.md", "spec.md", "workdir"]);
  });

  test("立项书确认成开发类：补上架构图、tickets/、ops.json；已经写了的规格不动", () => {
    const { paths } = setup();
    fs.writeFileSync(paths.spec, "# 规格\n\n导入银行流水，按月出报表。\n");
    ensureProjectRecords(paths, project({ kind: "dev", charterConfirmed: true }));
    const template = (rel: string) => read(path.join(STANDARD_TEMPLATES_DIR, "v1", "dev", "zh-CN", rel));
    expect(read(paths.architecture)).toBe(template("architecture.md"));
    expect(read(path.join(paths.tickets, "README.md"))).toBe(template("tickets/README.md"));
    expect(read(paths.ops)).toBe(template("ops.json"));
    expect(read(paths.spec)).toBe("# 规格\n\n导入银行流水，按月出报表。\n");
  });

  test("立项书确认成其他类：不要架构图和票", () => {
    const { paths } = setup();
    ensureProjectRecords(paths, project({ kind: "other", charterConfirmed: true }));
    expect(fs.readdirSync(paths.root).toSorted()).toEqual(["adr", "charter.md", "glossary.md", "manifest.md", "progress.md", "scope-records.md", "spec.md", "workdir"]);
  });

  test("按建档时的语言写（英文下用英文的模板）", () => {
    installBuiltinLocales("en");
    const { paths } = setup(project({ kind: "dev", charterConfirmed: true }));
    expect(read(paths.spec)).toBe(read(path.join(STANDARD_TEMPLATES_DIR, "v1", "dev", "en", "spec.md")));
    expect(read(paths.architecture)).toBe(read(path.join(STANDARD_TEMPLATES_DIR, "v1", "dev", "en", "architecture.md")));
  });

  test("规范上线之前建的项目（没记模板版本）：照旧的最小文档集，不补开发类的", () => {
    const { paths } = setup(project({ standardVersion: undefined, kind: "dev", charterConfirmed: true }));
    expect(read(paths.spec)).toBe("# 规格\n\n项目「记账本」（p-1）：把家里的账管起来\n\n这个项目要做成什么样：立项问答时由维护者写。\n");
    expect(fs.existsSync(paths.architecture)).toBe(false);
    expect(fs.existsSync(paths.tickets)).toBe(false);
  });
});

const view = (p: Project, paths: ReturnType<typeof projectRecordsPaths>, stateSince = T0) => projectStandardView({ project: p, paths, stateSince });

describe("只读视图", () => {
  test("筹备中（类型还没定）：模板版本；按其他类的三份必须有，再是辅助的；刚生成的都在、都还是模板原样；检查清单是筹备中 → 建设中，进展还没写回；改写是空的", () => {
    const p = project();
    const { paths } = setup(p);
    const v = view(p, paths);
    expect(v).toMatchObject({ projectId: "p-1", version: "v1", latest: PROJECT_STANDARD_LATEST, kind: null, overrides: [] });
    expect(v.docs.map((d) => [d.key, d.path, d.role, d.exists, d.untouched])).toEqual([
      ["spec", "spec.md", "required", true, true],
      ["progress", "progress.md", "required", true, true],
      ["adr", "adr/", "required", true, true],
      ["charter", "charter.md", "auxiliary", true, undefined],
      ["glossary", "glossary.md", "auxiliary", true, undefined],
      ["manifest", "manifest.md", "auxiliary", true, undefined],
      ["scopeRecords", "scope-records.md", "auxiliary", true, undefined],
    ]);
    for (const d of v.docs) expect(Date.parse(d.modifiedAt!)).toBeGreaterThan(0);
    expect(v.checklist).toEqual({ from: "preparing", to: "building", items: [{ id: "progress_written", label: "进展已写回", done: false, detail: "progress.md 还是模板原样" }] });
  });

  test("开发类：四份必须有（多架构图），再是 tickets/、ops.json（转运营前要有）；写过的不再是模板原样，决策记录有一条才算写了", () => {
    const p = project({ kind: "dev", charterConfirmed: true, state: "building" });
    const { paths } = setup(p);
    fs.appendFileSync(paths.spec, "\n导入招行的 CSV。\n");
    fs.writeFileSync(path.join(paths.adr, "0001-sqlite.md"), "# 用 SQLite\n");
    const v = view(p, paths);
    expect(v.kind).toBe("dev");
    expect(v.docs.map((d) => [d.key, d.role, standardDocState(d)])).toEqual([
      ["spec", "required", "written"],
      ["architecture", "required", "template"],
      ["progress", "required", "template"],
      ["adr", "required", "written"],
      ["tickets", "kind", "template"],
      ["ops", "before_in_use", "template"],
      ["charter", "auxiliary", "written"],
      ["glossary", "auxiliary", "written"],
      ["manifest", "auxiliary", "written"],
      ["scopeRecords", "auxiliary", "written"],
    ]);
    expect(v.docs.find((d) => d.key === "tickets")?.path).toBe("tickets/");
    expect(v.checklist).toMatchObject({ from: "building", to: "in_use" });
    // 259 号票：建设中 → 使用中五项，刚生成的档案只有"没有服务"这两项算做到
    expect(v.checklist.items.map((i) => [i.id, i.done, i.detail])).toEqual([
      ["architecture", false, "architecture.md 还是模板原样"],
      ["ops", false, "ops.json 还是模板原样"],
      ["services", true, "没有服务，不用登记"],
      ["public_entry", true, "不要外网"],
      ["progress_written", false, "progress.md 还是模板原样"],
    ]);
  });

  test("文档缺了：exists 是 false、没有修改时间，项目页上是\"缺\"", () => {
    const p = project({ kind: "dev", charterConfirmed: true, state: "building" });
    const { paths } = setup(p);
    fs.rmSync(paths.architecture);
    fs.rmSync(paths.adr, { recursive: true });
    const v = view(p, paths);
    const architecture = v.docs.find((d) => d.key === "architecture")!;
    expect(architecture).toEqual({ key: "architecture", path: "architecture.md", role: "required", exists: false });
    expect(standardDocState(architecture)).toBe("missing");
    expect(standardDocState(v.docs.find((d) => d.key === "adr")!)).toBe("missing");
  });

  test("进展已写回：进入现在这个状态之后改过、不是模板原样才算；已归档没有清单", () => {
    const p = project({ state: "building", kind: "other", charterConfirmed: true });
    const { paths } = setup(p);
    fs.writeFileSync(paths.progress, "# 进展\n\n首版做了一半。\n");
    expect(view(p, paths).checklist.items).toEqual([{ id: "progress_written", label: "进展已写回", done: true }]);
    // 进入现在这个状态是在写回之后：不算
    const later = new Date(Date.now() + 60_000).toISOString();
    expect(view(p, paths, later).checklist.items[0]).toMatchObject({ done: false, detail: "进入现在这个状态之后还没写回过进展" });
    expect(view({ ...p, state: "archived" }, paths).checklist).toEqual({ from: "archived", to: null, items: [] });
  });

  test("规范上线之前建的项目：版本是 null；开发类缺架构图（262 号票据此出补齐任务）；旧的规格不算模板原样", () => {
    const p = project({ standardVersion: undefined, kind: "dev", charterConfirmed: true, state: "in_use" });
    const { paths } = setup(p);
    const v = view(p, paths);
    expect(v.version).toBeNull();
    expect(v.docs.filter((d) => d.role === "required").map((d) => [d.key, standardDocState(d)])).toEqual([
      ["spec", "written"],
      ["architecture", "missing"],
      ["progress", "written"],
      ["adr", "template"],
    ]);
    expect(v.checklist).toMatchObject({ from: "in_use", to: "retired" });
  });
});

// ───────────────────────── 261 号票：本项目的规范改写、模板出了新版只提示 ─────────────────────────

const T1 = "2026-10-24T10:00:00.000+08:00";
const dropArchitecture = { kind: "drop", doc: "architecture", revision: 1, confirmedAt: T1, why: "家里自己用的小工具，不画架构图" } as const;
const weeklyProgress = { kind: "change", doc: "progress", note: "按周写，每周一节", revision: 1, confirmedAt: T1, why: "家里自己用的小工具，不画架构图" } as const;
const runbook = { kind: "add", path: "runbook.md", title: "运维手册", note: "怎么重启、怎么查日志", revision: 2, confirmedAt: T1, why: "要一份运维手册" } as const;
const recipes = { kind: "add", path: "recipes/", title: "菜谱", note: "一道菜一个文件", revision: 2, confirmedAt: T1, why: "要一份运维手册" } as const;

describe("本项目的规范改写（261 号票）", () => {
  test("不要架构图：视图里标本项目不要（不算缺），守护进程再对一遍档案也不从模板补回来；进展换写法照样要；多出来的接在必须有的后面", () => {
    const p = project({ kind: "dev", charterConfirmed: true, state: "building" });
    const { paths } = setup(p);
    fs.rmSync(paths.architecture);
    // 守护进程启动时再对一遍：不要的那份不补
    ensureProjectRecords(paths, p, { dropped: ["architecture"] });
    expect(fs.existsSync(paths.architecture)).toBe(false);
    const v = projectStandardView({ project: p, paths, stateSince: T0, overrides: [dropArchitecture, weeklyProgress, runbook, recipes] });
    expect(v.docs.filter((d) => d.role === "required").map((d) => [d.key, d.path, d.override, d.title, standardDocState(d)])).toEqual([
      ["spec", "spec.md", undefined, undefined, "template"],
      ["architecture", "architecture.md", "drop", undefined, "dropped"],
      ["progress", "progress.md", "change", undefined, "template"],
      ["adr", "adr/", undefined, undefined, "template"],
      ["custom", "runbook.md", "add", "运维手册", "missing"],
      ["custom", "recipes/", "add", "菜谱", "missing"],
    ]);
    // 多出来的写了：文件在就算写了（没有模板）；目录里要有一份
    fs.writeFileSync(path.join(paths.root, "runbook.md"), "# 运维手册\n\n重启：……\n");
    fs.mkdirSync(path.join(paths.root, "recipes"));
    const empty = projectStandardView({ project: p, paths, stateSince: T0, overrides: [runbook, recipes] }).docs.filter((d) => d.key === "custom");
    expect(empty.map((d) => [d.path, d.exists, standardDocState(d)])).toEqual([
      ["runbook.md", true, "written"],
      ["recipes/", true, "template"],
    ]);
    fs.writeFileSync(path.join(paths.root, "recipes", "番茄炒蛋.md"), "# 番茄炒蛋\n");
    expect(standardDocState(projectStandardView({ project: p, paths, stateSince: T0, overrides: [recipes] }).docs.find((d) => d.key === "custom")!)).toBe("written");
    // 改写了的那几条：位置、一句话、为什么、第几次
    expect(v.overrides).toEqual([
      { ...dropArchitecture, path: "architecture.md", summary: "不要架构图" },
      { ...weeklyProgress, path: "progress.md", summary: "进展换一种写法：按周写，每周一节" },
      { ...runbook, summary: "多一份「运维手册」（runbook.md）：怎么重启、怎么查日志" },
      { ...recipes, summary: "多一份「菜谱」（recipes/）：一道菜一个文件" },
    ]);
  });

  test("立项书确认成开发类时（类型刚定）就不要架构图的：补开发类那几份时跳过它；规范上线之前建的项目不要规格：最小文档集里也不补", () => {
    const p = project();
    const { paths } = setup(p);
    ensureProjectRecords(paths, project({ kind: "dev", charterConfirmed: true }), { dropped: ["architecture", "ops"] });
    expect(fs.existsSync(paths.architecture)).toBe(false);
    expect(fs.existsSync(paths.ops)).toBe(false);
    expect(fs.existsSync(path.join(paths.tickets, "README.md"))).toBe(true);
    const legacy = project({ id: "p-2", standardVersion: undefined, kind: "other", charterConfirmed: true });
    const legacyPaths = projectRecordsPaths(path.dirname(paths.root), legacy.id);
    ensureProjectRecords(legacyPaths, legacy, { dropped: ["spec"] });
    expect(fs.existsSync(legacyPaths.spec)).toBe(false);
    expect(fs.existsSync(legacyPaths.progress)).toBe(true);
  });
});

/** 一份假的模板目录：真的 v1，加一个 v2（规格的开头改了一句、开发类多一份安全说明 security.md） */
function templatesWithV2(): string {
  const dir = makeTempDir("ergo-templates-");
  fs.cpSync(path.join(STANDARD_TEMPLATES_DIR, "v1"), path.join(dir, "v1"), { recursive: true });
  fs.cpSync(path.join(STANDARD_TEMPLATES_DIR, "v1"), path.join(dir, "v2"), { recursive: true });
  for (const kind of ["dev", "other"]) {
    const spec = path.join(dir, "v2", kind, "zh-CN", "spec.md");
    fs.writeFileSync(spec, read(spec).replace("v1", "v2"));
  }
  fs.writeFileSync(path.join(dir, "v2", "dev", "zh-CN", "security.md"), "# 安全说明\n\n> **这份写什么**：…\n");
  return dir;
}

describe("模板出了新版只提示（261 号票）", () => {
  test("项目照旧用建档时的版本：新版多的不补、已有的不换，视图里 latest 是新版；跟了新版（版本换成 v2）才补缺的，已有的照旧不动、仍算模板原样", () => {
    const templates = standardTemplates(templatesWithV2());
    expect(templates.versions()).toEqual(["v1", "v2"]);
    const p = project({ kind: "dev", charterConfirmed: true, state: "building" });
    const { paths } = setup(p);
    const v1Spec = read(paths.spec);
    // 守护进程再对一遍（项目记着 v1）：v2 的文件一个都不来
    ensureStandardDocs(paths, "v1", "dev", templates);
    expect(fs.existsSync(path.join(paths.root, "security.md"))).toBe(false);
    const before = projectStandardView({ project: p, paths, stateSince: T0, templates });
    expect(before).toMatchObject({ version: "v1", latest: "v2" });
    // 跟了新版：缺的从 v2 补上，已有的不动（规格还是 v1 的原样，仍算模板原样）
    const upgraded = { ...p, standardVersion: "v2" };
    ensureStandardDocs(paths, "v2", "dev", templates);
    expect(fs.existsSync(path.join(paths.root, "security.md"))).toBe(true);
    expect(read(paths.spec)).toBe(v1Spec);
    const after = projectStandardView({ project: upgraded, paths, stateSince: T0, templates });
    expect(after).toMatchObject({ version: "v2", latest: "v2" });
    expect(after.docs.find((d) => d.key === "spec")?.untouched).toBe(true);
  });
});

/** 写好的架构图：服务、对外接口两张表 */
const ARCHITECTURE = (services: string[], interfaces: string[]) =>
  [
    "# 架构图",
    "",
    "```mermaid",
    "flowchart LR",
    "  web --> site",
    "```",
    "",
    "## 用到的服务",
    "",
    "| 服务名 | 做什么 | 端口 | 健康检查 | 开机自启 |",
    "|---|---|---|---|---|",
    ...services,
    "",
    "## 前端",
    "",
    "| 前端 | 地址 | 说明 |",
    "|---|---|---|",
    "",
    "## 对外接口",
    "",
    "| 接口 | 给谁用 | 走哪条路（本机调用口、/apps/…、公网） |",
    "|---|---|---|",
    ...interfaces,
    "",
  ].join("\n");

/** 运营方案里的一条服务（有网页的写 web） */
const servicePlan = (name: string, web = true): ChecklistPlan["items"][number] => ({ name: `「${name}」服务`, service: { name, app: `p-1-${name}`, ...(web ? { web: { home: "/", prefix: "strip" as const } } : {}) } });

/** 建设中的项目（立项书已确认） */
const building = (kind: "dev" | "other" = "dev") => project({ kind, charterConfirmed: true, state: "building" });
/** 建设中 → 使用中的检查清单 */
const checklist = (p: Project, paths: ReturnType<typeof projectRecordsPaths>, plan?: ChecklistPlan) => goLiveChecklist({ project: p, paths, stateSince: T0, plan });
const item = (items: ReturnType<typeof checklist>, id: string) => items.find((i) => i.id === id)!;

describe("转运营检查清单（259 号票）", () => {

  test("架构图的两张表按 ## 标题认（中英文模板都认），表头、分隔行不算，`反引号`、**加粗**去掉", () => {
    const zh = architectureTables(ARCHITECTURE(["| `site` | 网页 | 18080 | / | 开 |", "| **api** | 接口 | 18081 | /health | 开 |"], ["| 日报网页 | 手机 | /apps/p-1-site/ |"]));
    expect(zh.services?.map((r) => r[0])).toEqual(["site", "api"]);
    expect(zh.interfaces).toEqual([["日报网页", "手机", "/apps/p-1-site/"]]);
    const en = architectureTables("# Architecture\n\n## Services\n\n| Service | What |\n|---|---|\n| site | web |\n\n## Interfaces\n\n| Interface | Used by | Route |\n|---|---|---|\n");
    expect(en).toEqual({ services: [["site", "web"]], interfaces: [] });
    expect(architectureTables("没有标题")).toEqual({});
  });

  test("全做到：架构图写了服务和对外接口、ops.json 交了、服务写进运营方案、要外网的有带网页的服务、进展写回；做到的也带一句说明", () => {
    const p = building();
    const { paths } = setup(p);
    fs.writeFileSync(paths.architecture, ARCHITECTURE(["| site | 日报网页 | 18080 | / | 开 |"], ["| 日报网页 | 手机 | /apps/p-1-site/ |", "| add_note | 秘书 | 本机调用口 |"]));
    fs.writeFileSync(paths.ops, JSON.stringify({ tools: [{ name: "add_note", description: "记一条", inputSchema: { type: "object" } }] }));
    fs.writeFileSync(paths.progress, "# 进展\n\n首版做完了。\n");
    const items = checklist(p, paths, { items: [servicePlan("site")] });
    expect(items.map((i) => [i.id, i.label, i.done, i.detail])).toEqual([
      ["architecture", "架构图写清服务和对外接口", true, undefined],
      ["ops", "运营接口清单验收通过（ops.json）", true, "1 个接口"],
      ["services", "服务按模板在 LSM 登记（写进运营方案）", true, "确认后交给 LSM 登记：「site」"],
      ["public_entry", "要外网的开好 /apps/<项目>/", true, "确认后开 /apps/p-1-site/"],
      ["progress_written", "进展已写回", true, undefined],
    ]);
  });

  test("架构图：缺了、还是模板原样、两张表空着（没有的写一行“无”就算写了）、运营方案里的服务架构图里没写", () => {
    const p = building();
    const { paths } = setup(p);
    expect(item(checklist(p, paths), "architecture").detail).toBe("architecture.md 还是模板原样");
    fs.writeFileSync(paths.architecture, ARCHITECTURE([], []));
    expect(item(checklist(p, paths), "architecture")).toMatchObject({ done: false, detail: "“用到的服务”一节是空的（没有服务就写一行“无”）；“对外接口”一节是空的（没有就写一行“无”）" });
    fs.writeFileSync(paths.architecture, ARCHITECTURE(["| 无 | | | | |"], ["| 无 | | |"]));
    expect(item(checklist(p, paths), "architecture")).toEqual({ id: "architecture", label: "架构图写清服务和对外接口", done: true });
    expect(item(checklist(p, paths, { items: [servicePlan("site")] }), "architecture")).toMatchObject({ done: false, detail: "运营方案里的服务「site」架构图里没写" });
    fs.rmSync(paths.architecture);
    expect(item(checklist(p, paths), "architecture").detail).toBe("缺架构图 architecture.md（有服务的项目照开发类要它）");
  });

  test("ops.json：缺了、模板原样、不是 JSON、没有 tools、接口没写 name；tools 是空列表的也算交了（0 个接口）", () => {
    const p = building();
    const { paths } = setup(p);
    const ops = () => item(checklist(p, paths), "ops");
    expect(ops().detail).toBe("ops.json 还是模板原样");
    fs.writeFileSync(paths.ops, "{ tools: ");
    expect(ops()).toMatchObject({ done: false, detail: expect.stringContaining("ops.json 不是合法的 JSON：") });
    fs.writeFileSync(paths.ops, JSON.stringify({ interfaces: [] }));
    expect(ops().detail).toBe("ops.json 里没有 tools 列表");
    fs.writeFileSync(paths.ops, JSON.stringify({ tools: [{ name: "a" }, { description: "没名字" }] }));
    expect(ops().detail).toBe("ops.json 第 2 个接口没写 name");
    fs.writeFileSync(paths.ops, JSON.stringify({ tools: [] }));
    expect(ops()).toMatchObject({ done: true, detail: "0 个接口" });
    fs.rmSync(paths.ops);
    expect(ops().detail).toBe("缺 ops.json");
  });

  test("服务：架构图里的服务要写进运营方案（名字、应用名、这一条的名字对得上都算）；还没交方案的写明要写哪几个", () => {
    const p = building();
    const { paths } = setup(p);
    fs.writeFileSync(paths.architecture, ARCHITECTURE(["| site | 网页 | 18080 | / | 开 |", "| worker | 抓取 | 18081 | /health | 开 |"], ["| 无 | | |"]));
    expect(item(checklist(p, paths), "services")).toMatchObject({ done: false, detail: "还没交运营方案：架构图里的服务「site」、「worker」要写进运营方案（means: service）" });
    expect(item(checklist(p, paths, { items: [servicePlan("site")] }), "services")).toMatchObject({ done: false, detail: "架构图里的服务「worker」没写进运营方案（means: service）" });
    const plan = { items: [servicePlan("site"), { name: "抓取 worker", service: { name: "fetch", app: "p-1-fetch" } }, { name: "日报" }] };
    expect(item(checklist(p, paths, plan), "services")).toMatchObject({ done: true, detail: "确认后交给 LSM 登记：「site」、「fetch」" });
  });

  test("要外网的：对外接口里走 /apps/、公网的要有对应的带网页的服务；点名了 /apps/<应用名>/ 的按应用名对", () => {
    const p = building();
    const { paths } = setup(p);
    fs.writeFileSync(paths.architecture, ARCHITECTURE(["| site | 网页 | 18080 | / | 开 |"], ["| 日报网页 | 手机 | /apps/p-1-site/ |"]));
    expect(item(checklist(p, paths, { items: [servicePlan("site", false)] }), "public_entry")).toMatchObject({ done: false, detail: "对外接口「日报网页」要走 /apps/ 或公网，运营方案里没有对应的带网页（web）的服务" });
    expect(item(checklist(p, paths, { items: [servicePlan("site")] }), "public_entry")).toMatchObject({ done: true, detail: "确认后开 /apps/p-1-site/" });
    fs.writeFileSync(paths.architecture, ARCHITECTURE(["| site | 网页 | 18080 | / | 开 |"], ["| 日报网页 | 手机 | 公网 |"]));
    expect(item(checklist(p, paths), "public_entry").done).toBe(false);
    expect(item(checklist(p, paths, { items: [servicePlan("site")] }), "public_entry").done).toBe(true);
  });

  test("其他类只查进展；运营方案里真有服务的照开发类查（缺架构图）", () => {
    const p = building("other");
    const { paths } = setup(p);
    expect(checklist(p, paths).map((i) => i.id)).toEqual(["progress_written"]);
    const items = checklist(p, paths, { items: [servicePlan("site")] });
    expect(items.map((i) => i.id)).toEqual(["architecture", "ops", "services", "public_entry", "progress_written"]);
    expect(item(items, "architecture").detail).toBe("缺架构图 architecture.md（有服务的项目照开发类要它）");
  });

  test("只读视图：建设中的清单看要随转入使用生效的运营方案；别的状态只要进展写回", () => {
    const p = building();
    const { paths } = setup(p);
    fs.writeFileSync(paths.architecture, ARCHITECTURE(["| site | 网页 | 18080 | / | 开 |"], ["| 无 | | |"]));
    const v = projectStandardView({ project: p, paths, stateSince: T0, plan: { items: [servicePlan("site")] } });
    expect(v.checklist.items.find((i) => i.id === "services")).toMatchObject({ done: true });
    for (const state of ["preparing", "in_use", "retired"] as const) expect(view({ ...p, state }, paths).checklist.items.map((i) => i.id)).toEqual(["progress_written"]);
  });

  test("按本项目的规范改写（261 号票）：不要架构图的不列架构图那项，服务、/apps/ 两项只看运营方案；不要 ops.json 的不列运营接口清单那项；只读视图同样", () => {
    const p = building();
    const { paths } = setup(p);
    fs.writeFileSync(paths.progress, "# 进展\n\n首版做完了。\n");
    const archDropped = { kind: "drop", doc: "architecture" } as const;
    const opsDropped = { kind: "drop", doc: "ops" } as const;
    // 架构图还是模板原样，但这个项目不要它：不列；运营方案里的服务照样要登记，要外网的看方案里带网页的服务
    const noArchitecture = goLiveChecklist({ project: p, paths, stateSince: T0, plan: { items: [servicePlan("site")] }, overrides: [archDropped] });
    expect(noArchitecture.map((i) => [i.id, i.done])).toEqual([
      ["ops", false],
      ["services", true],
      ["public_entry", true],
      ["progress_written", true],
    ]);
    expect(item(noArchitecture, "services").detail).toBe("确认后交给 LSM 登记：「site」");
    expect(item(noArchitecture, "public_entry").detail).toBe("确认后开 /apps/p-1-site/");
    // 两份都不要、也没有服务：只剩服务（没有，不用登记）、/apps/、进展
    const neither = goLiveChecklist({ project: p, paths, stateSince: T0, overrides: [archDropped, opsDropped] });
    expect(neither.map((i) => [i.id, i.done])).toEqual([
      ["services", true],
      ["public_entry", true],
      ["progress_written", true],
    ]);
    // 只读视图：建设中的清单同样按改写
    const rows = [archDropped, opsDropped].map((o) => ({ ...o, revision: 1, confirmedAt: T0, why: "小工具" }));
    expect(projectStandardView({ project: p, paths, stateSince: T0, overrides: rows }).checklist.items.map((i) => i.id)).toEqual(["services", "public_entry", "progress_written"]);
  });
});
