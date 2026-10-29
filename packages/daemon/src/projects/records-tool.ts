// 秘书的"读项目档案"工具（规格第 7 节"只读工具"，22 号票）：用户问某个项目进展如何时，秘书按项目（编号或名字）直接读
// 它的项目档案作答，不唤醒、不拉起它的维护者。任意项目都能读，含已归档的（删掉的没有了）。
// 读的是 15 号票建好的最小文档集（立项书、规格、术语表、ADR、进展、项目清单、范围记录），位置由 projectRecordsPaths 给出：
// 秘书不用知道路径（和秘书文件工具对项目档案的只读是两回事）。只读，不落入任何关注类别；没有对应的写工具。
// @i18n-ignore-file model：读项目档案交回模型的结果、说明（结果开头的写法 RECORDS_RESULT_HEAD 要认得出，173 号票）；工具的名字走 t()
import fs from "node:fs";
import path from "node:path";
import { type Project, PROJECT_STATE_LABEL, Type, t, forModel } from "@ergo/protocol";
import { defineHostTool, type HostTool } from "../agent-manager/host-tools.ts";
import { RequestRejected } from "../errors.ts";
import { TOOL } from "../guard/index.ts";
import { findByIdOrName } from "../util/find-by-ref.ts";
import type { ProjectService } from "./projects.ts";
import type { ProjectRecordsPaths } from "./records.ts";
import { READ_PROJECT_RECORDS_TOOL } from "./tool-names.ts";

/** 能读的文档：工具参数里的名字、标题、在档案里的位置 */
const DOCS = [
  { doc: "charter", title: "立项书", file: "charter" },
  { doc: "spec", title: "规格", file: "spec" },
  { doc: "glossary", title: "术语表", file: "glossary" },
  { doc: "adr", title: "决策记录", file: "adr" },
  { doc: "progress", title: "进展", file: "progress" },
  { doc: "manifest", title: "项目清单", file: "manifest" },
  { doc: "scope_records", title: "范围记录", file: "scopeRecords" },
] as const satisfies ReadonlyArray<{ doc: string; title: string; file: keyof ProjectRecordsPaths }>;

type DocName = (typeof DOCS)[number]["doc"];

/** 一个文件最多交给秘书多少字（更长的说明还剩多少、全文在哪，秘书可以用 read 读） */
const MAX_CHARS_PER_FILE = 12_000;

const Params = Type.Object(
  {
    project: Type.String({ minLength: 1, description: "项目编号（p-1）或项目名" }),
    docs: Type.Optional(
      Type.Array(Type.Union(DOCS.map((d) => Type.Literal(d.doc))), {
        minItems: 1,
        description: `只读这几份（不写就全读）：${DOCS.map((d) => `${d.doc}（${d.title}）`).join("、")}`,
      }),
    ),
  },
  { additionalProperties: false },
);

/** 一个文件的内容（太长的截断并说明），没有这个文件时如实说 */
function fileText(file: string): string {
  let text: string;
  try {
    text = fs.readFileSync(file, "utf8").trimEnd();
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return "（还没有这个文件）";
    return `（读不了：${(err as Error).message}）`;
  }
  if (text.length <= MAX_CHARS_PER_FILE) return text;
  return `${text.slice(0, MAX_CHARS_PER_FILE)}\n（后面还有 ${text.length - MAX_CHARS_PER_FILE} 字没列出；要看全文用 ${TOOL.read} 读 ${file}）`;
}

/** 决策记录：adr/ 下每个 markdown 文件（目录说明 README 除外） */
function adrText(dir: string): string {
  let names: string[];
  try {
    names = fs
      .readdirSync(dir)
      .filter((n) => n.endsWith(".md") && n.toLowerCase() !== "readme.md")
      .toSorted();
  } catch {
    return "（还没有这个目录）";
  }
  if (names.length === 0) return "（还没有决策记录）";
  return names.map((n) => `### adr/${n}\n${fileText(path.join(dir, n))}`).join("\n");
}

/** 一个项目的档案（选出的几份）：开头一行写明是哪个项目（"项目 p-1「记账本」……"，projectIdOfRecordsResult 按它认） */
export function projectRecordsText(project: Project, paths: ProjectRecordsPaths, docs: readonly DocName[]): string {
  const sections = DOCS.filter((d) => docs.includes(d.doc)).map((d) => {
    const location = d.doc === "adr" ? "adr/" : path.basename(paths[d.file]);
    const body = d.doc === "adr" ? adrText(paths.adr) : fileText(paths[d.file]);
    return `## ${d.title}（${location}）\n${body}`;
  });
  return [`项目 ${project.id}「${project.name}」（${forModel(() => PROJECT_STATE_LABEL[project.state])}）的项目档案（只读，目录 ${paths.root}）：`, ...sections].join("\n");
}

/** 读项目档案的返回开头的"项目 p-N「"（projectRecordsText 写的） */
const RECORDS_RESULT_HEAD = /^项目 (p-\d+)「/;

/**
 * 读项目档案那次调用读的是哪个项目：按返回开头写的项目编号认（66 号票：删除项目时找读过它的调用）。不按参数里的名字认——
 * 删掉的项目的名字可以被新项目重用；编号不回收。没读成（找不到、有歧义）的返回开头不是这样，为 undefined。
 * 过了保留期清掉的完整内容只剩结果摘要，开头照样是这一句
 */
export function projectIdOfRecordsResult(result: string): string | undefined {
  return RECORDS_RESULT_HEAD.exec(result)?.[1];
}

/**
 * 读项目档案的工具。scope 不给是秘书的（任意项目）；17 号票涉及多个项目的任务的维护者也用它（固定工具包的"读项目档案"），
 * 只能读这个任务涉及的项目（scope.projects），说明另写
 */
export function readProjectRecordsTool(projects: ProjectService, scope?: { projects: () => Project[]; description: string }): HostTool {
  return defineHostTool({
    name: READ_PROJECT_RECORDS_TOOL,
    title: t("projects.tools.readRecords"),
    description:
      scope?.description ??
      "读某个项目（含已归档的）的项目档案：立项书、规格、术语表、决策记录、进展、项目清单、范围记录。用户问某个项目进展如何、当时定了什么时用它作答，不用去问维护者（也不会唤醒它）。只读。",
    parameters: Params,
    readOnlyOrIdempotent: true,
    nature: "look",
    run: (args) => {
      const all = scope ? scope.projects() : projects.list();
      const known = all.map((p) => `${p.id}「${p.name}」`).join("、");
      try {
        const project = findByIdOrName(all, args.project, { nameOf: (p) => p.name, what: "项目", hint: known ? `现有的项目：${known}` : "现在还没有项目" });
        return { text: projectRecordsText(project, projects.records(project.id), args.docs ?? DOCS.map((d) => d.doc)) };
      } catch (err) {
        if (err instanceof RequestRejected) return { text: err.message, isError: true };
        throw err;
      }
    },
  });
}
