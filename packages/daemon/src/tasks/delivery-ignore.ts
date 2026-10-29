// 交付统计不算的东西（311 号票，294 号票端到端小测第 5 条：跑 pytest 留下的 __pycache__ 里的 .pyc 也数进了"交了几个文件"）：
// 缓存、依赖、编译产物、版本库这类目录整个不算，编译产物、系统生成的文件不算。秘书转告"交了几个文件"（secretary/task-done.ts）、
// 任务卡"新建 N 个文件"（stage-view.ts 的 observedCounts）、项目"最新交付件"（project-ops/builtin.ts）都按这一份。
// 写法照 project-ops/snapshot.ts 的忽略规则（一组目录名、按文件名判）；隐藏的（点开头的）各处另外照旧跳过。按小写比（Windows 不分大小写）。
// 阶段详情里系统查到的逐条（改了哪些文件）照列：那是"系统查到了什么"，不是交付统计。

/** 整个不算的目录：依赖、各种缓存、虚拟环境、版本库 */
const IGNORED_DIRS: ReadonlySet<string> = new Set([
  "node_modules",
  "__pycache__",
  ".pytest_cache",
  ".mypy_cache",
  ".ruff_cache",
  ".hypothesis",
  ".ipynb_checkpoints",
  ".tox",
  ".nox",
  ".venv",
  "venv",
  ".cache",
  ".parcel-cache",
  ".turbo",
  ".gradle",
  ".git",
  ".svn",
  ".hg",
]);
/** 目录名以这些结尾的也不算（Python 打包时生成的 *.egg-info） */
const IGNORED_DIR_SUFFIXES = [".egg-info"];
/** 不算的文件：编译产物（Python 字节码、Java 类文件、目标文件、TypeScript 增量编译信息） */
const IGNORED_FILE_SUFFIXES = [".pyc", ".pyo", ".class", ".o", ".tsbuildinfo"];
/** 不算的文件：系统生成的 */
const IGNORED_FILES: ReadonlySet<string> = new Set(["thumbs.db", "desktop.ini", ".ds_store"]);

/** 这个目录名整个不算 */
export function ignoredDeliveryDir(name: string): boolean {
  const lower = name.toLowerCase();
  return IGNORED_DIRS.has(lower) || IGNORED_DIR_SUFFIXES.some((s) => lower.endsWith(s));
}

/** 这个文件名不算 */
export function ignoredDeliveryFile(name: string): boolean {
  const lower = name.toLowerCase();
  return IGNORED_FILES.has(lower) || IGNORED_FILE_SUFFIXES.some((s) => lower.endsWith(s));
}

/** 一条路径（相对、绝对，正反斜杠都认）：哪一层目录不算、或者文件名不算，就不算 */
export function ignoredDeliveryPath(p: string): boolean {
  const parts = p.split(/[\\/]+/).filter(Boolean);
  const name = parts.pop();
  return parts.some(ignoredDeliveryDir) || (name !== undefined && ignoredDeliveryFile(name));
}
