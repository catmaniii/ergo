// 工具注册表（规格第 9 节、第 21 节）：每个工具登记类别标签、参数规则，以及可选的
// "做完告诉我"、"只读或幂等"标记和是否联网。注册表是数据，判定时作为输入传进来。
//
// 登记的工具有四种来源：
// - builtin：pi 自带的文件工具和 bash（bash 本身不按标签判，而是拆成伪工具调用逐个判）；
// - typed_shell：带类型的特殊 bash 工具（执行实现在 28 号票），类别和"做完告诉我"照 28 号票的登记表；
// - mcp：MCP 工具（27 号票登记），用 registerTools 加进来；
// - pseudo：从通用 bash 拆出来的伪工具调用。带类型的工具和 bash 里的同一操作同名、参数名相同
//   （比如 `git push` 拆出来就是 git_push），这样授权项、自定义类别和 05 号票的时序规则对两者一视同仁。
//   伪工具只能由守卫拆 bash 得到，模型直接调用同名工具时按未登记的工具处理。
//
// 参数规则的写法和 AgentSense planguard 场景文件里 `tools.<工具>.args.<参数>` 兼容（pattern、type、list），
// 另加二狗自己的 kind、access 等字段，05 号票的参数名统一建在这上面。
import type { BottomLineId, BuiltinCategoryId } from "./watch-categories.ts";

/**
 * 参数的种类：
 * - path：路径，按 access 过路径围栏和受保护区域；
 * - recipient：收件人；content：对外内容（检查密钥形态）；url：网址；amount：金额；
 * - http_method：HTTP 请求方法，非 GET 的请求落入"以我的名义对外发送或发布"；
 * - command：shell 命令（只有 bash 的 command）；
 * - other：其他。
 */
export type ArgKind = "path" | "recipient" | "content" | "url" | "amount" | "http_method" | "command" | "other";

/** 路径参数怎样碰这个路径。unknown：拆出来的命令不知道读还是写，按写算 */
export type PathAccess = "read" | "write" | "delete" | "unknown";

export interface ArgRule {
  kind: ArgKind;
  /** 路径参数：读、写、删，或不知道 */
  access?: PathAccess;
  /** 路径参数：整个替换目标文件的内容（目标已存在时算覆盖） */
  replaces?: boolean;
  /** 路径参数：不填时取 agent 的工作目录 */
  defaultsToCwd?: boolean;
  /** planguard 兼容：值必须匹配的正则 */
  pattern?: string;
  /** planguard 兼容：值的类型 */
  type?: "string" | "number" | "boolean" | "array";
  /** planguard 兼容：可以是一组值 */
  list?: boolean;
  description?: string;
}

export type ToolSource = "builtin" | "typed_shell" | "mcp" | "pseudo";

export interface ToolDescriptor {
  name: string;
  /** 中文名：说明和审批卡里用 */
  title: string;
  source: ToolSource;
  /** 类别标签 */
  categories: readonly BuiltinCategoryId[];
  /** 底线标签：付款转账、创建账户、改密码或两步验证 */
  bottomLines?: readonly BottomLineId[];
  /** 参数规则 */
  args: Readonly<Record<string, ArgRule>>;
  /** "做完告诉我"：没有类别、但值得一提的操作 */
  notifyWhenDone?: boolean;
  /**
   * "只读或幂等"：被打断后可以直接重跑（23 号票被杀后的恢复用；本票只登记、不参与判定）。
   * 从严：会改工作目录、产物或依赖的（跑测试、构建、装依赖）都不标。
   */
  readOnlyOrIdempotent?: boolean;
  /** 要联网：联网开关关着时直接拒绝 */
  network?: boolean;
  /** 会把参数里的内容发出去：检查对外内容里的密钥形态 */
  outbound?: boolean;
}

/** 工具注册表：工具名 → 登记 */
export type ToolRegistry = Readonly<Record<string, ToolDescriptor>>;

/** 守卫自己要认的工具名：pi 工具、带类型的工具、伪工具（程序表和判定函数都用这些常量） */
export const TOOL = Object.freeze({
  // pi 自带
  read: "read",
  write: "write",
  edit: "edit",
  ls: "ls",
  grep: "grep",
  find: "find",
  bash: "bash",
  // 带类型的特殊 bash 工具
  git_status_diff: "git_status_diff",
  git_commit: "git_commit",
  git_merge: "git_merge",
  git_push: "git_push",
  create_remote_repo: "create_remote_repo",
  run_tests: "run_tests",
  install_deps: "install_deps",
  start_build: "start_build",
  // 伪工具
  delete: "delete",
  move: "move",
  copy: "copy",
  make_dir: "make_dir",
  git_discard: "git_discard",
  git_fetch: "git_fetch",
  http_request: "http_request",
  network_read: "network_read",
  run_package: "run_package",
  network_command: "network_command",
  github_write: "github_write",
  publish_package: "publish_package",
  install_global: "install_global",
  account_command: "account_command",
  account_change: "account_change",
  run_script: "run_script",
  shell_command: "shell_command",
  opaque_shell: "opaque_shell",
} as const);

const path = (access: PathAccess, extra: Partial<ArgRule> = {}): ArgRule => ({ kind: "path", access, ...extra });
const other: ArgRule = { kind: "other" };
const content: ArgRule = { kind: "content" };

/** pi 自带的工具（参数名照 pi 1.0.4 的工具 schema） */
const PI_TOOLS: ToolDescriptor[] = [
  { name: TOOL.read, title: "读文件", source: "builtin", categories: [], args: { path: path("read") }, readOnlyOrIdempotent: true },
  {
    name: TOOL.write,
    title: "写文件",
    source: "builtin",
    categories: [],
    args: { path: path("write", { replaces: true }), content },
  },
  { name: TOOL.edit, title: "改文件", source: "builtin", categories: [], args: { path: path("write"), edits: other } },
  {
    name: TOOL.ls,
    title: "列目录",
    source: "builtin",
    categories: [],
    args: { path: path("read", { defaultsToCwd: true }) },
    readOnlyOrIdempotent: true,
  },
  {
    name: TOOL.grep,
    title: "搜索文件内容",
    source: "builtin",
    categories: [],
    args: { pattern: other, path: path("read", { defaultsToCwd: true }) },
    readOnlyOrIdempotent: true,
  },
  {
    name: TOOL.find,
    title: "查找文件",
    source: "builtin",
    categories: [],
    args: { pattern: other, path: path("read", { defaultsToCwd: true }) },
    readOnlyOrIdempotent: true,
  },
  { name: TOOL.bash, title: "通用 bash", source: "builtin", categories: [], args: { command: { kind: "command" }, timeout: other } },
];

/** 带类型的特殊 bash 工具（执行实现在 28 号票）。"只读或幂等"只有状态和差异 */
const TYPED_SHELL_TOOLS: ToolDescriptor[] = [
  {
    name: TOOL.git_status_diff,
    title: "git 状态和差异",
    source: "typed_shell",
    categories: [],
    args: { repoPath: path("read", { defaultsToCwd: true }), paths: path("read") },
    readOnlyOrIdempotent: true,
  },
  {
    name: TOOL.git_commit,
    title: "git 提交",
    source: "typed_shell",
    categories: [],
    args: { repoPath: path("write", { defaultsToCwd: true }), message: content, paths: path("write") },
    notifyWhenDone: true,
  },
  {
    name: TOOL.git_merge,
    title: "git 合并",
    source: "typed_shell",
    categories: [],
    args: { repoPath: path("write", { defaultsToCwd: true }), branch: other },
    notifyWhenDone: true,
  },
  {
    name: TOOL.git_push,
    title: "git 推送",
    source: "typed_shell",
    categories: ["external_send"],
    args: { repoPath: path("read", { defaultsToCwd: true }), remote: other, branch: other, force: { kind: "other", type: "boolean" } },
    network: true,
    outbound: true,
  },
  {
    name: TOOL.create_remote_repo,
    title: "建远端仓库",
    source: "typed_shell",
    categories: ["external_send"],
    args: { repoPath: path("read", { defaultsToCwd: true }), name: other, visibility: other, description: content },
    network: true,
    outbound: true,
  },
  {
    name: TOOL.run_tests,
    title: "跑测试",
    source: "typed_shell",
    categories: [],
    args: { repoPath: path("write", { defaultsToCwd: true }), args: other },
  },
  {
    name: TOOL.install_deps,
    title: "在工作目录里装依赖",
    source: "typed_shell",
    categories: [],
    args: { repoPath: path("write", { defaultsToCwd: true }), packages: other },
    notifyWhenDone: true,
    network: true,
  },
  {
    name: TOOL.start_build,
    title: "启动构建",
    source: "typed_shell",
    categories: [],
    args: { repoPath: path("write", { defaultsToCwd: true }), args: other },
  },
];

/**
 * 从通用 bash 拆出来的伪工具（和带类型的工具、pi 工具同名的那些直接复用上面的登记）。
 * 删除、覆盖是按路径算的：删除类路径参数、或整个替换内容的写入参数落在项目档案和工作目录内，
 * 才落入"删除或覆盖"（见判定函数）。
 */
const PSEUDO_TOOLS: ToolDescriptor[] = [
  { name: TOOL.delete, title: "删除", source: "pseudo", categories: [], args: { path: path("delete"), recursive: other } },
  {
    name: TOOL.move,
    title: "移动或改名",
    source: "pseudo",
    categories: [],
    args: { from: path("delete"), to: path("write", { replaces: true }) },
  },
  { name: TOOL.copy, title: "复制", source: "pseudo", categories: [], args: { from: path("read"), to: path("write", { replaces: true }) } },
  { name: TOOL.make_dir, title: "建目录", source: "pseudo", categories: [], args: { path: path("write") } },
  {
    name: TOOL.git_discard,
    title: "丢弃 git 改动",
    source: "pseudo",
    categories: ["delete_or_overwrite"],
    args: { repoPath: path("write", { defaultsToCwd: true }), command: content },
  },
  {
    name: TOOL.git_fetch,
    title: "从远端取回（clone、fetch、pull）",
    source: "pseudo",
    categories: [],
    args: { repoPath: path("write", { defaultsToCwd: true }), remote: other, url: { kind: "url" } },
    network: true,
  },
  {
    name: TOOL.http_request,
    title: "发 HTTP 请求",
    source: "pseudo",
    categories: [],
    args: { method: { kind: "http_method" }, url: { kind: "url" }, command: content },
    network: true,
    outbound: true,
  },
  {
    name: TOOL.network_read,
    title: "只读的联网命令（ping、查 GitHub 上的东西……）",
    source: "pseudo",
    categories: [],
    args: { program: other, command: content },
    network: true,
    outbound: true,
  },
  {
    name: TOOL.run_package,
    title: "下载并运行软件包（npx 这类）",
    source: "pseudo",
    categories: [],
    args: { program: other, package: other, command: content },
    network: true,
  },
  {
    name: TOOL.network_command,
    title: "连接远端主机",
    source: "pseudo",
    categories: ["external_send"],
    args: { program: other, command: content },
    network: true,
    outbound: true,
  },
  {
    name: TOOL.github_write,
    title: "在 GitHub 上发布或修改",
    source: "pseudo",
    categories: ["external_send"],
    args: { command: content },
    network: true,
    outbound: true,
  },
  {
    name: TOOL.publish_package,
    title: "发布软件包",
    source: "pseudo",
    categories: ["external_send", "irreversible_commit"],
    args: { program: other, command: content },
    network: true,
    outbound: true,
  },
  {
    name: TOOL.install_global,
    title: "全局装软件",
    source: "pseudo",
    categories: ["account_security"],
    args: { program: other, packages: other },
    network: true,
  },
  {
    name: TOOL.account_command,
    title: "改凭据或权限",
    source: "pseudo",
    categories: ["account_security"],
    args: { program: other, command: content },
  },
  {
    name: TOOL.account_change,
    title: "创建账户或改密码",
    source: "pseudo",
    categories: ["account_security"],
    bottomLines: ["payment_account_auth"],
    args: { program: other, command: content },
  },
  {
    name: TOOL.run_script,
    title: "跑脚本",
    source: "pseudo",
    categories: [],
    args: { interpreter: other, path: path("read") },
  },
  {
    name: TOOL.shell_command,
    title: "其他命令",
    source: "pseudo",
    categories: [],
    args: { program: other, paths: path("unknown") },
  },
  {
    name: TOOL.opaque_shell,
    title: "拆不开的命令",
    source: "pseudo",
    categories: ["unknown_write"],
    args: { reason: other, command: content },
  },
];

/** 框架自带的工具注册表 */
export const BUILTIN_TOOL_REGISTRY: ToolRegistry = buildRegistry([...PI_TOOLS, ...TYPED_SHELL_TOOLS, ...PSEUDO_TOOLS]);

/** 按名字找工具；没登记时为 undefined */
export function findTool(registry: ToolRegistry, name: string): ToolDescriptor | undefined {
  return Object.hasOwn(registry, name) ? registry[name] : undefined;
}

/** 往注册表里加工具（MCP 工具、测试用工具），返回新的注册表；重名时报错 */
export function registerTools(registry: ToolRegistry, ...tools: ToolDescriptor[]): ToolRegistry {
  for (const tool of tools) {
    if (findTool(registry, tool.name)) throw new Error(`工具注册表里已经有 ${tool.name}`);
  }
  return buildRegistry([...Object.values(registry), ...tools]);
}

function buildRegistry(tools: ToolDescriptor[]): ToolRegistry {
  const out: Record<string, ToolDescriptor> = {};
  for (const tool of tools) {
    if (Object.hasOwn(out, tool.name)) throw new Error(`工具注册表里 ${tool.name} 重复`);
    out[tool.name] = Object.freeze({ ...tool });
  }
  return Object.freeze(out);
}
