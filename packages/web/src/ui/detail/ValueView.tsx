/**
 * 把工具的参数和返回值按结构画出来，而不是甩一段 JSON（56 号票，照搬 AgentSense web/src/ui/ValueView.tsx）。
 *
 * 认得出的字段就该认出来：给字段配中文名、布尔值写"是 / 否"、路径用等宽字体、把对象数组画成表。
 * 真的是自由文本（文件内容、提交说明、命令）就原样显示，不要硬塞进表格里。
 * 和 AgentSense 不同的地方：
 * - 字段字典：AgentSense 是模拟世界里的文件、联系人、订单、航班，二狗是 pi 的文件工具、bash、带类型的 bash 工具
 *   （git、测试、构建、装依赖）和二狗自己的工具；金额、MB/GB 这类单位二狗的工具没有，不搬；命令、匹配用等宽字体（CODE）；
 * - 路径还认 Windows 的盘符（D:\）和 ~/；
 * - 对象里的值带着字段名往下传（field），字段名的规则（状态、命令）在对象里也生效（AgentSense 只在表格里生效）。
 * 整段文字（文件内容、改动）的换行靠样式保留（detail.css 的 .vv-row-block dd）。
 */

/** 字段名 → 中文。同名字段在不同工具里含义不同的，放进 BY_TOOL 覆盖 */
const LABELS: Record<string, string> = {
  // pi 的文件工具和 bash
  path: "路径", paths: "路径", file: "文件", files: "文件", content: "内容", oldText: "原文", newText: "改成", edits: "改动",
  offset: "起始行", limit: "最多几行", pattern: "匹配", glob: "文件筛选", ignoreCase: "忽略大小写", literal: "按字面匹配",
  context: "上下文行数", command: "命令", timeout: "超时（秒）", cwd: "工作目录", workDir: "工作目录",
  // 带类型的 bash 工具（git、测试、构建、装依赖）
  message: "说明", branch: "分支", remote: "远端", ref: "版本", force: "强制", into: "合并进", commit: "提交", headCommit: "提交",
  repoPath: "仓库", status: "状态", staged: "已暂存", conflicts: "冲突", fastForward: "快进", exitCode: "退出码", passed: "通过",
  packages: "依赖", visibility: "可见性", url: "地址", name: "名字", description: "说明", args: "参数", dev: "开发依赖",
  // 二狗自己的工具（任务、阶段、工单、素材、提醒……）
  title: "标题", summary: "摘要", text: "正文", reason: "原因", why: "理由", goal: "目标", instructions: "要求", intro: "介绍",
  taskId: "任务", stageId: "阶段", stageIds: "阶段", workOrderId: "工单", project: "项目", projects: "项目",
  query: "关键词", materialIds: "素材", questions: "问题", answer: "回答", kind: "类型", type: "类型", date: "日期", time: "时间",
  at: "时间", inMinutes: "几分钟后", inDays: "几天后", repeat: "重复", weekday: "周几", reminderId: "提醒",
  toolkit: "工具包", skills: "skill", network: "联网", categories: "关注类别", acceptanceCriteria: "验收标准", results: "结果",
  id: "编号", count: "数量", note: "备注", detail: "说明",
};
const BY_TOOL: Record<string, Record<string, string>> = {
  git_commit: { message: "提交说明" },
  git_merge: { branch: "要合并的分支" },
  write: { content: "写入的内容" },
};

const STATUS: Record<string, string> = { added: "新增", modified: "修改", deleted: "删除", renamed: "改名", untracked: "未跟踪", ok: "成功" };
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
  if (typeof v === "boolean") return <span className={v ? "vv-yes" : "vv-no"}>{v ? "是" : "否"}</span>;
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
  if (!entries.length) return <div className="muted">（无参数）</div>;
  return (
    <dl className="vv-rows">
      {entries.map(([k, v]) => {
        const prose = (PROSE.has(k) || CODE.has(k)) && typeof v === "string" && (v.length > 28 || v.includes("\n"));
        return (
          <div key={k} className={prose ? "vv-row vv-row-block" : "vv-row"}>
            <dt>{labelOf(k, tool)}</dt>
            <dd>{isUnknown(v) ? <span className="vv-unknown">未知</span> : <ValueView value={v} tool={tool} field={k} nested />}</dd>
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
  if (isUnknown(value)) return <span className="vv-unknown">未知</span>;
  if (Array.isArray(value)) {
    if (!value.length) return <span className="vv-null">（空）</span>;
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
