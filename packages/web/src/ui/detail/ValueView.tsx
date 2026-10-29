/**
 * 把工具的参数和返回值按结构画出来，而不是甩一段 JSON（56 号票）。
 *
 * 认得出的字段就该认出来：给字段配中文名、布尔值写"是 / 否"、路径用等宽字体、把对象数组画成表。
 * 真的是自由文本（文件内容、提交说明、命令）就原样显示，不要硬塞进表格里。
 * 几点：
 * - 字段字典：pi 的文件工具、bash、带类型的 bash 工具
 *   （git、测试、构建、装依赖）和二狗自己的工具；金额、MB/GB 这类单位二狗的工具没有，不认；命令、匹配用等宽字体（CODE）；
 * - 路径还认 Windows 的盘符（D:\）和 ~/；
 * - 对象里的值带着字段名往下传（field），字段名的规则（状态、命令）在对象里也生效（不只在表格里）。
 * 整段文字（文件内容、改动）的换行靠样式保留（detail.css 的 .vv-row-block dd）。
 */
import { t, tTable } from "../../state/index.ts";

/** 字段名 → 中文（168 号票起按当前语言现取）。同名字段在不同工具里含义不同的，放进 BY_TOOL 覆盖 */
const LABELS: Readonly<Record<string, string>> = tTable({
  // pi 的文件工具和 bash
  path: "ui.valueView.field.path",
  paths: "ui.valueView.field.paths",
  file: "ui.valueView.field.file",
  files: "ui.valueView.field.files",
  content: "ui.valueView.field.content",
  oldText: "ui.valueView.field.oldText",
  newText: "ui.valueView.field.newText",
  edits: "ui.valueView.field.edits",
  offset: "ui.valueView.field.offset",
  limit: "ui.valueView.field.limit",
  pattern: "ui.valueView.field.pattern",
  glob: "ui.valueView.field.glob",
  ignoreCase: "ui.valueView.field.ignoreCase",
  literal: "ui.valueView.field.literal",
  context: "ui.valueView.field.context",
  command: "ui.valueView.field.command",
  timeout: "ui.valueView.field.timeout",
  cwd: "ui.valueView.field.cwd",
  workDir: "ui.valueView.field.workDir",
  // 带类型的 bash 工具（git、测试、构建、装依赖）
  message: "ui.valueView.field.message",
  branch: "ui.valueView.field.branch",
  remote: "ui.valueView.field.remote",
  ref: "ui.valueView.field.ref",
  force: "ui.valueView.field.force",
  into: "ui.valueView.field.into",
  commit: "ui.valueView.field.commit",
  headCommit: "ui.valueView.field.headCommit",
  repoPath: "ui.valueView.field.repoPath",
  status: "ui.valueView.field.status",
  staged: "ui.valueView.field.staged",
  conflicts: "ui.valueView.field.conflicts",
  fastForward: "ui.valueView.field.fastForward",
  exitCode: "ui.valueView.field.exitCode",
  passed: "ui.valueView.field.passed",
  packages: "ui.valueView.field.packages",
  visibility: "ui.valueView.field.visibility",
  url: "ui.valueView.field.url",
  name: "ui.valueView.field.name",
  description: "ui.valueView.field.description",
  args: "ui.valueView.field.args",
  dev: "ui.valueView.field.dev",
  // 二狗自己的工具（任务、阶段、工单、素材、提醒……）
  title: "ui.valueView.field.title",
  summary: "ui.valueView.field.summary",
  text: "ui.valueView.field.text",
  reason: "ui.valueView.field.reason",
  why: "ui.valueView.field.why",
  goal: "ui.valueView.field.goal",
  instructions: "ui.valueView.field.instructions",
  intro: "ui.valueView.field.intro",
  taskId: "ui.valueView.field.taskId",
  stageId: "ui.valueView.field.stageId",
  stageIds: "ui.valueView.field.stageIds",
  workOrderId: "ui.valueView.field.workOrderId",
  project: "ui.valueView.field.project",
  projects: "ui.valueView.field.projects",
  query: "ui.valueView.field.query",
  materialIds: "ui.valueView.field.materialIds",
  questions: "ui.valueView.field.questions",
  answer: "ui.valueView.field.answer",
  kind: "ui.valueView.field.kind",
  type: "ui.valueView.field.type",
  date: "ui.valueView.field.date",
  time: "ui.valueView.field.time",
  at: "ui.valueView.field.at",
  inMinutes: "ui.valueView.field.inMinutes",
  inDays: "ui.valueView.field.inDays",
  repeat: "ui.valueView.field.repeat",
  weekday: "ui.valueView.field.weekday",
  reminderId: "ui.valueView.field.reminderId",
  toolkit: "ui.valueView.field.toolkit",
  skills: "ui.valueView.field.skills",
  network: "ui.valueView.field.network",
  categories: "ui.valueView.field.categories",
  acceptanceCriteria: "ui.valueView.field.acceptanceCriteria",
  results: "ui.valueView.field.results",
  id: "ui.valueView.field.id",
  count: "ui.valueView.field.count",
  note: "ui.valueView.field.note",
  detail: "ui.valueView.field.detail",
});
const BY_TOOL: Record<string, Readonly<Record<string, string>>> = {
  git_commit: tTable({ message: "ui.valueView.byTool.gitCommitMessage" }),
  git_merge: tTable({ branch: "ui.valueView.byTool.gitMergeBranch" }),
  write: tTable({ content: "ui.valueView.byTool.writeContent" }),
};

const STATUS: Readonly<Record<string, string>> = tTable({
  added: "ui.valueView.status.added",
  modified: "ui.valueView.status.modified",
  deleted: "ui.valueView.status.deleted",
  renamed: "ui.valueView.status.renamed",
  untracked: "ui.valueView.status.untracked",
  ok: "ui.valueView.status.ok",
});
/** 这些字段常常是整段文字，单独成块显示，不挤在一行里 */
const PROSE = new Set(["text", "content", "detail", "note", "title", "summary", "goal", "reason", "why", "instructions", "intro", "description", "message", "oldText", "newText", "answer"]);
/** 这些字段是代码或命令：等宽字体 */
const CODE = new Set(["command", "pattern", "glob"]);

const isUnknown = (v: unknown) => typeof v === "object" && v !== null && !Array.isArray(v) && "$unknown" in (v as object);
const isPlain = (v: unknown) => typeof v === "object" && v !== null && !Array.isArray(v);
/** 路径：/ 开头、盘符开头（D:\、C:/）、~/ 开头 */
const isPath = (s: string) => s.startsWith("/") || s.startsWith("~/") || /^[A-Za-z]:[\\/]/.test(s);

export const labelOf = (key: string, tool?: string) => (tool && BY_TOOL[tool]?.[key]) || LABELS[key] || key;

function Scalar({ k, v }: { k: string; v: unknown }) {
  if (v === null || v === undefined) return <span className="vv-null">—</span>;
  if (typeof v === "boolean") return <span className={v ? "vv-yes" : "vv-no"}>{v ? t("ui.valueView.yes") : t("ui.valueView.no")}</span>;
  if (typeof v === "number") return <span className="vv-num">{v}</span>;
  const s = String(v);
  if (k === "status" && STATUS[s]) return <span className="vv-badge">{STATUS[s]}</span>;
  if (CODE.has(k)) return <span className="vv-path">{s}</span>;
  if (isPath(s)) return <span className="vv-path">{s}</span>;
  return <span>{s}</span>;
}

/** 一个对象画成「字段 / 值」两列 */
function ObjectRows({ obj, tool }: { obj: Record<string, unknown>; tool?: string | undefined }) {
  const entries = Object.entries(obj);
  if (!entries.length) return <div className="muted">{t("ui.valueView.noParams")}</div>;
  return (
    <dl className="vv-rows">
      {entries.map(([k, v]) => {
        const prose = (PROSE.has(k) || CODE.has(k)) && typeof v === "string" && (v.length > 28 || v.includes("\n"));
        return (
          <div key={k} className={prose ? "vv-row vv-row-block" : "vv-row"}>
            <dt>{labelOf(k, tool)}</dt>
            <dd>{isUnknown(v) ? <span className="vv-unknown">{t("ui.valueView.unknown")}</span> : <ValueView value={v} tool={tool} field={k} nested />}</dd>
          </div>
        );
      })}
    </dl>
  );
}

/** 对象数组画成表：列取各行键的并集，最多 6 列，超出的挪到行下方 */
function ObjectTable({ rows, tool }: { rows: Record<string, unknown>[]; tool?: string | undefined }) {
  const keys: string[] = [];
  for (const r of rows) for (const k of Object.keys(r)) if (!keys.includes(k)) keys.push(k);
  const head = keys.filter((k) => !PROSE.has(k) || rows.every((r) => typeof r[k] !== "string" || String(r[k]).length <= 28)).slice(0, 6);
  const rest = keys.filter((k) => !head.includes(k));
  return (
    <div className="vv-table-wrap">
      <table className="vv-table">
        <thead>
          <tr>
            {head.map((k) => (
              <th key={k}>{labelOf(k, tool)}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            // 行没有稳定 id，位置就是它的身份
            <tr key={i}>
              {head.map((k) => (
                <td key={k}>{k in r ? <Scalar k={k} v={r[k]} /> : <span className="vv-null">—</span>}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      {rest.length > 0 && (
        <div className="vv-rest">
          {rows.map((r, i) =>
            rest.some((k) => r[k] !== undefined) ? (
              // 同上
              <div key={i} className="vv-rest-row">
                <span className="vv-rest-n">{i + 1}</span>
                <ObjectRows obj={Object.fromEntries(rest.filter((k) => r[k] !== undefined).map((k) => [k, r[k]]))} tool={tool} />
              </div>
            ) : null,
          )}
        </div>
      )}
    </div>
  );
}

/** field：这个值所在的字段名（命令、匹配用等宽字体） */
export function ValueView({ value, tool, field = "", nested }: { value: unknown; tool?: string | undefined; field?: string; nested?: boolean }) {
  if (isUnknown(value)) return <span className="vv-unknown">{t("ui.valueView.unknown")}</span>;
  if (Array.isArray(value)) {
    if (!value.length) return <span className="vv-null">{t("ui.valueView.empty")}</span>;
    if (value.every(isPlain)) return <ObjectTable rows={value as Record<string, unknown>[]} tool={tool} />;
    return (
      <div className="vv-chips">
        {value.map((v, i) => (
          // 值本身可能重复
          <span key={i} className="vv-chip">
            {typeof v === "object" ? JSON.stringify(v) : String(v)}
          </span>
        ))}
      </div>
    );
  }
  if (isPlain(value)) return <ObjectRows obj={value as Record<string, unknown>} tool={tool} />;
  if (!nested && typeof value === "string") return <div className="vv-text">{value}</div>;
  return <Scalar k={field} v={value} />;
}
