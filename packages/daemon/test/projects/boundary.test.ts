// 项目系统的边界（277 号票，方案 C，docs/research/29-plugin-expansion-review.html；照 test/calendar/boundary.test.ts 扫 import）：
// 项目系统是 projects/、work-orders/、operations/、project-ops/、project-services/ 五个目录，对外只有入口 projects/api.ts
// （280 号票起运营层另有自己的入口 project-ops/api.ts，见第 4 条）。
// 1. 这五个目录之外只 import 入口（静态 import、export … from、import() 都算）；组合根 daemon.ts 另外只准 import 组装函数
//    projects/system.ts（278 号票：项目系统的接线收成 createProjectSystem 一处，组合根不再直连内部文件）；
// 2. 入口露的是窄接口：不把项目系统的内部服务（项目服务、派单器、项目的服务、project_ops……）原样转出去，也不 export *；
// 3. 检查本身有效：扫的办法认得出直连（假的直连会红），内核的调用方确实经入口。
// 4. 运营层（280 号票，方案 C 第 4 点：project-ops/、project-services/ 照插件的纪律写）：自己的入口 project-ops/api.ts 也在 ENTRIES 里；
//    项目系统的其余部分只经它用运营层，组装函数 projects/system.ts 另外只经 project-ops/layer.ts 装它（像插件清单装 plugin.ts）；
//    运营层用项目系统的其余部分也只经 projects/api.ts（拆成插件那天不用再改 import）；守卫运行时不再按名字认它的工具（工具自己声明参数要打码）。
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const srcRoot = path.resolve(import.meta.dirname, "../../src");

interface SourceFile {
  path: string;
  content: string;
}

function sourceFiles(dir: string): SourceFile[] {
  return fs
    .readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((d) => d.isFile() && d.name.endsWith(".ts"))
    .map((d) => {
      const file = path.join(d.parentPath, d.name);
      return { path: path.relative(srcRoot, file).split(path.sep).join("/"), content: fs.readFileSync(file, "utf8") };
    });
}

/** 项目系统的五个目录 */
const PROJECT_SYSTEM = ["projects", "work-orders", "operations", "project-ops", "project-services"];
/** 项目系统的入口 */
const PROJECT_ENTRY = "projects/api.ts";
/** 运营层（280 号票）：项目系统里照插件的纪律写的两个目录、它的入口、它的装配（只给组装函数用） */
const OPS_LAYER = ["project-ops", "project-services"];
const OPS_ENTRY = "project-ops/api.ts";
const OPS_ASSEMBLY = "project-ops/layer.ts";
/** 入口：项目系统之外只准 import 这些 */
const ENTRIES = [PROJECT_ENTRY, OPS_ENTRY];
/** 组合根：装配项目系统 */
const COMPOSITION_ROOT = "daemon.ts";
/** 组装函数（278 号票）：组合根只经它装项目系统，不直连别的内部文件 */
const ASSEMBLY = "projects/system.ts";
/** 项目系统的内部服务：入口不转出它们（调用方要的那几样另写成小接口） */
const INTERNAL_SERVICES = [
  "ProjectService",
  "ProjectMaintainers",
  "CharterChanges",
  "StandardChanges",
  "StandardBackfill",
  "StandardTemplates",
  "WorkOrders",
  "Segments",
  "MultiProject",
  "Clarifications",
  "Operations",
  "OperationMeansRegistry",
  "ProjectServices",
  "ServiceThumbnails",
  "ProjectOps",
  "OpsRegistry",
];

/** 一个文件里的相对 import（import … from、export … from、import()、只为副作用的 import），按导入方的位置算成 src 下的路径 */
function importsOf(file: SourceFile): string[] {
  const specifiers = [
    ...file.content.matchAll(/\bfrom\s*["']([^"']+)["']/g),
    ...file.content.matchAll(/\bimport\s*\(\s*["']([^"']+)["']\s*\)/g),
    ...file.content.matchAll(/^\s*import\s*["']([^"']+)["']/gm),
  ].map((m) => m[1]!);
  return specifiers.filter((s) => s.startsWith(".")).map((s) => path.posix.normalize(path.posix.join(path.posix.dirname(file.path), s)));
}

const inProjectSystem = (file: string) => PROJECT_SYSTEM.some((dir) => file.startsWith(`${dir}/`));

/** 一个文件能 import 项目系统里的哪些文件：入口；组合根另外还有组装函数 */
const allowedFor = (file: string) => (file === COMPOSITION_ROOT ? [...ENTRIES, ASSEMBLY] : ENTRIES);

const inOpsLayer = (file: string) => OPS_LAYER.some((dir) => file.startsWith(`${dir}/`));

/**
 * 项目系统里运营层的边界（280 号票）："谁 → 哪个文件"：
 * - 运营层之外（projects/、work-orders/、operations/）只经运营层的入口；组装函数另外只准经运营层的装配；
 * - 运营层用项目系统的其余部分只经项目系统的入口（运营层里互相 import、import 内核的都不管）
 */
function opsLayerCrossings(files: readonly SourceFile[]): string[] {
  return files
    .filter((f) => inProjectSystem(f.path))
    .flatMap((f) =>
      importsOf(f)
        .filter((target) =>
          inOpsLayer(f.path)
            ? inProjectSystem(target) && !inOpsLayer(target) && target !== PROJECT_ENTRY
            : inOpsLayer(target) && target !== OPS_ENTRY && !(f.path === ASSEMBLY && target === OPS_ASSEMBLY),
        )
        .map((target) => `${f.path} → ${target}`),
    );
}

/** 项目系统之外直连项目系统内部文件的（组合根经组装函数的不算）："谁 → 哪个文件" */
function directImports(files: readonly SourceFile[]): string[] {
  return files
    .filter((f) => !inProjectSystem(f.path))
    .flatMap((f) => importsOf(f).filter((target) => inProjectSystem(target) && !allowedFor(f.path).includes(target)).map((target) => `${f.path} → ${target}`));
}

/** 一个文件导出的名字（export 声明、export { … }、export type { … }、export { … } from；改名导出的按原名算：改了名也还是那个服务） */
function exportedNames(code: string): string[] {
  const declared = [...code.matchAll(/^export\s+(?:declare\s+)?(?:abstract\s+)?(?:const|let|var|function|class|interface|type|enum)\s+([A-Za-z_$][\w$]*)/gm)].map((m) => m[1]!);
  const listed = [...code.matchAll(/^export\s+(?:type\s+)?\{([^}]*)\}/gm)].flatMap((m) =>
    m[1]!
      .split(",")
      .map((part) => part.trim().replace(/^type\s+/, ""))
      .filter((part) => part !== "")
      .map((part) => part.split(/\s+as\s+/)[0]!.trim()),
  );
  return [...declared, ...listed];
}

describe("项目系统的边界", () => {
  const files = sourceFiles(srcRoot);

  it("项目系统的目录之外只 import 入口 projects/api.ts；组合根另外只经组装函数 projects/system.ts", () => {
    expect(directImports(files)).toEqual([]);
    // 检查本身有效：入口在，内核的调用方确实经它（提示词表的工具名、秘书的工具、执行名额）
    for (const entry of ENTRIES) expect(files.some((f) => f.path === entry)).toBe(true);
    const viaEntry = files.filter((f) => !inProjectSystem(f.path)).flatMap((f) => (importsOf(f).some((target) => ENTRIES.includes(target)) ? [f.path] : []));
    expect(viaEntry).toEqual(expect.arrayContaining(["prompts/registry.ts", "secretary/tool-list.ts", "tasks/slots.ts"]));
    // 组合根确实经组装函数装项目系统（278 号票），项目系统里只碰它这一个文件
    const root = files.find((f) => f.path === COMPOSITION_ROOT)!;
    expect(importsOf(root).filter(inProjectSystem)).toEqual([ASSEMBLY]);
  });

  it("扫的办法认得出直连：静态 import、export … from、import() 直连内部文件都会红，组合根绕过组装函数也红；项目系统内部、组合根经组装函数、名字像的别的目录不算", () => {
    const fake: SourceFile[] = [
      { path: "board/fake.ts", content: 'import { getProjectRow } from "../projects/views.ts";\nimport { getProject } from "../projects/api.ts";\n' },
      { path: "tasks/fake.ts", content: 'export { getWorkOrder } from "../work-orders/views.ts";\nconst ops = await import("../project-ops/index.ts");\nimport "../operations/means.ts";\n' },
      { path: "tasks/deep/fake.ts", content: 'import type { ProjectServices } from "../../project-services/project-services.ts";\n' },
      { path: "projects/fake.ts", content: 'import type { WorkOrders } from "../work-orders/work-orders.ts";\n' },
      { path: "daemon.ts", content: 'import { createProjectSystem } from "./projects/system.ts";\nimport { createProjectService } from "./projects/projects.ts";\n' },
      { path: "secretary/fake.ts", content: 'import { x } from "../projects-archive/x.ts";\nimport { y } from "@ergo/protocol";\n' },
    ];
    expect(directImports(fake)).toEqual([
      "board/fake.ts → projects/views.ts",
      "tasks/fake.ts → work-orders/views.ts",
      "tasks/fake.ts → project-ops/index.ts",
      "tasks/fake.ts → operations/means.ts",
      "tasks/deep/fake.ts → project-services/project-services.ts",
      "daemon.ts → projects/projects.ts",
    ]);
    // 往真的看板模块里加一处直连：会红
    const board = files.find((f) => f.path === "board/kinds.ts")!;
    const tampered = files.map((f) => (f === board ? { ...f, content: `${f.content}\nimport { getProjectRow } from "../projects/views.ts";\n` } : f));
    expect(directImports(tampered)).toEqual(["board/kinds.ts → projects/views.ts"]);
    // 往真的组合根里加一处绕过组装函数的直连：也红（278 号票）
    const root = files.find((f) => f.path === COMPOSITION_ROOT)!;
    const bypassed = files.map((f) => (f === root ? { ...f, content: `${f.content}\nimport { createWorkOrders } from "./work-orders/work-orders.ts";\n` } : f));
    expect(directImports(bypassed)).toEqual(["daemon.ts → work-orders/work-orders.ts"]);
  });

  it("入口露的是窄接口：不转出项目系统的内部服务，也不 export *", () => {
    for (const entry of ENTRIES) {
      const code = files.find((f) => f.path === entry)!.content;
      expect(code).not.toMatch(/^export\s+(?:type\s+)?\*/m);
      const names = exportedNames(code);
      expect(names.length).toBeGreaterThan(0);
      expect(names.filter((name) => INTERNAL_SERVICES.includes(name))).toEqual([]);
    }
    // 检查本身有效：认得出转出的内部服务
    expect(exportedNames('export type { ProjectService } from "./projects.ts";\nexport { type WorkOrders as W, x } from "../work-orders/work-orders.ts";\n')).toEqual(["ProjectService", "WorkOrders", "x"]);
    expect(exportedNames("export interface ProjectOps {}\nexport const a = 1;\n")).toEqual(["ProjectOps", "a"]);
  });

  it("运营层（280）：项目系统的其余部分只经它的入口 project-ops/api.ts，组装函数另外只经 project-ops/layer.ts 装它；它用项目系统的其余部分只经 projects/api.ts", () => {
    expect(opsLayerCrossings(files)).toEqual([]);
    // 检查本身有效：入口、装配都在，项目系统的其余部分确实经入口（项目系统的入口转出工具名、秘书的工具、项目服务），组装函数确实经装配，
    // 运营层确实经项目系统的入口
    for (const file of [OPS_ENTRY, OPS_ASSEMBLY]) expect(files.some((f) => f.path === file)).toBe(true);
    const importers = (target: string) => files.filter((f) => importsOf(f).includes(target)).map((f) => f.path);
    expect(importers(OPS_ENTRY)).toEqual(expect.arrayContaining([PROJECT_ENTRY, "projects/secretary-tools.ts", "projects/projects.ts"]));
    expect(importers(OPS_ASSEMBLY)).toEqual([ASSEMBLY]);
    expect(importers(PROJECT_ENTRY).filter(inOpsLayer)).toEqual(expect.arrayContaining(["project-ops/tool.ts", "project-services/means.ts", "project-services/views.ts"]));
    // 组装函数在运营层里只碰装配（不再自己建项目的服务、project_ops，也不替它把"服务"插进运营手段）
    const assembly = files.find((f) => f.path === ASSEMBLY)!;
    expect(importsOf(assembly).filter(inOpsLayer)).toEqual([OPS_ASSEMBLY]);
  });

  it("运营层的扫法认得出越界：其余部分直连运营层内部、别人用运营层的装配、组装函数绕过装配、运营层直连项目系统的内部文件都红；经两个入口、组装函数经装配、运营层里互相 import、import 内核的不算", () => {
    const fake: SourceFile[] = [
      { path: "projects/fake.ts", content: 'import { createProjectOps } from "../project-ops/tool.ts";\nimport type { OpsGoLive } from "../project-ops/api.ts";\nimport { createOpsLayer } from "../project-ops/layer.ts";\n' },
      { path: "operations/fake.ts", content: 'import { serviceMeans } from "../project-services/means.ts";\n' },
      { path: "projects/system.ts", content: 'import { createOpsLayer } from "../project-ops/layer.ts";\nimport { createProjectServices } from "../project-services/project-services.ts";\n' },
      {
        path: "project-ops/fake.ts",
        content: 'import { OPERATIONS_CHANNEL } from "../operations/events.ts";\nimport { OPERATIONS_EVENTS } from "../projects/api.ts";\nimport { serviceRows } from "../project-services/views.ts";\nimport type { EventStore } from "../events/event-store.ts";\n',
      },
      { path: "project-services/fake.ts", content: 'import type { ProjectRecordsPaths } from "../projects/records.ts";\nexport { getWorkOrder } from "../work-orders/views.ts";\n' },
    ];
    expect(opsLayerCrossings(fake)).toEqual([
      "projects/fake.ts → project-ops/tool.ts",
      "projects/fake.ts → project-ops/layer.ts",
      "operations/fake.ts → project-services/means.ts",
      "projects/system.ts → project-services/project-services.ts",
      "project-ops/fake.ts → operations/events.ts",
      "project-services/fake.ts → projects/records.ts",
      "project-services/fake.ts → work-orders/views.ts",
    ]);
    // 往真的秘书的工具里加一处直连运营层内部：会红
    const secretaryTools = files.find((f) => f.path === "projects/secretary-tools.ts")!;
    const tampered = files.map((f) => (f === secretaryTools ? { ...f, content: `${f.content}\nimport { switchServicesTool } from "../project-services/secretary-tool.ts";\n` } : f));
    expect(opsLayerCrossings(tampered)).toEqual(["projects/secretary-tools.ts → project-services/secretary-tool.ts"]);
  });

  it("守卫运行时不再按名字认运营层的工具（280）：给人看的参数摘要不 import 项目系统、MCP 的东西，打码看工具自己的登记", () => {
    const describeFile = files.find((f) => f.path === "guard-runtime/describe.ts")!;
    expect(importsOf(describeFile).filter((target) => inProjectSystem(target) || target.startsWith("mcp/"))).toEqual([]);
    expect(describeFile.content).toMatch(/\.maskArgs === true/);
  });
});
