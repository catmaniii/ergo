// 程序表：一条简单命令 → 伪工具调用（规格第 9 节：`rm` → 删除、`git push` → 推送、`npm install -g` → 全局装软件、
// `curl`、`wget` → 发 HTTP 请求……）。伪工具的名字和参数名见 tool-registry.ts，和带类型的工具一致。
//
// 不在表里的程序映射成 shell_command（拆得开、不落在任何类别，不打断）；它参数里长得像路径的词一并带上，
// 过路径围栏和受保护区域（不知道读还是写，按写算）。表里的程序处理完后，没用到的、长得像路径的词按"读"补上，
// 保证"命令里出现项目外的路径"一定能看到。

/** 命令里的一个词 */
export interface ShellWord {
  /** 静态值（去掉引号后）；含变量、命令替换等没法静态确定时为 null */
  value: string | null;
  /** 源码原文 */
  text: string;
}

/** 程序表处理一条命令时能用的东西（由 split.ts 提供） */
export interface ProgramContext {
  /** 这条简单命令的原文 */
  text: string;
  /** 标准输入来自管道、here-doc 或重定向 */
  stdin: boolean;
  emit(tool: string, args: Record<string, unknown>): void;
  opaque(reason: string): void;
  /** 把词当路径解析成绝对路径（cd 之后可能有几个）；伪设备返回 undefined */
  path(word: ShellWord): string | string[] | undefined;
  /** 当前目录（可能有几个） */
  cwd(): string | string[];
  /** cd 到某处；不带参数是回主目录 */
  cd(word: ShellWord | undefined): void;
}

/** 一条命令的处理状态：记下哪些词已经用过（当路径用了，或明确不是路径） */
class Invocation {
  readonly used = new Set<ShellWord>();
  readonly ctx: ProgramContext;
  /** 外层是 xargs：命令末尾还会补上没法确定的参数 */
  readonly extraOperands: boolean;

  constructor(ctx: ProgramContext, extraOperands: boolean) {
    this.ctx = ctx;
    this.extraOperands = extraOperands;
  }

  /** 解析成路径，并记下这个词已经用过 */
  path(word: ShellWord): string | string[] | undefined {
    this.used.add(word);
    return this.ctx.path(word);
  }

  skip(...words: (ShellWord | undefined)[]): void {
    for (const w of words) if (w) this.used.add(w);
  }

  emit(tool: string, args: Record<string, unknown>): void {
    this.ctx.emit(tool, args);
  }

  /** 每个路径各发一条（伪设备跳过）；xargs 补上的参数算一个没法确定的路径 */
  emitEachPath(tool: string, words: ShellWord[], extra: Record<string, unknown> = {}, argName = "path"): void {
    const all = this.extraOperands ? [...words, XARGS_WORD] : words;
    for (const w of all) {
      const p = this.path(w);
      if (p !== undefined) this.emit(tool, { [argName]: p, ...extra });
    }
  }
}

const XARGS_WORD: ShellWord = { value: null, text: "<xargs 补上的参数>" };

// ───────────────────────── 选项解析 ─────────────────────────

interface Option {
  name: string;
  /** 选项的值：`--x=v` 里的 v，或带值选项后面那个词 */
  value?: ShellWord;
  word: ShellWord;
}

interface ParsedArgs {
  options: Option[];
  operands: ShellWord[];
}

/**
 * 解析选项：`--` 之后都是操作数；`--name=value`；带值的选项（valueOptions 里的）取下一个词或紧跟的部分（`-XPOST`）；
 * 短选项可以连写（`-rf`）。没法静态确定的词一律当操作数。
 */
function parseArgs(args: readonly ShellWord[], valueOptions: readonly string[] = [], stopAtFirstOperand = false): ParsedArgs {
  const takesValue = new Set(valueOptions);
  const options: Option[] = [];
  const operands: ShellWord[] = [];
  let i = 0;
  let onlyOperands = false;
  while (i < args.length) {
    const word = args[i]!;
    const v = word.value;
    i++;
    if (onlyOperands || v === null || v === "-" || !v.startsWith("-") || v.length === 1) {
      operands.push(word);
      if (stopAtFirstOperand) onlyOperands = true;
      continue;
    }
    if (v === "--") {
      onlyOperands = true;
      continue;
    }
    if (v.startsWith("--")) {
      const eq = v.indexOf("=");
      if (eq > 0) options.push({ name: v.slice(0, eq), value: { value: v.slice(eq + 1), text: v.slice(eq + 1) }, word });
      else if (takesValue.has(v) && i < args.length) options.push({ name: v, value: args[i++], word });
      else options.push({ name: v, word });
      continue;
    }
    // 短选项（可能连写）
    for (let k = 1; k < v.length; k++) {
      const name = `-${v[k]}`;
      if (takesValue.has(name)) {
        const rest = v.slice(k + 1);
        if (rest !== "") options.push({ name, value: { value: rest, text: rest }, word });
        else if (i < args.length) options.push({ name, value: args[i++], word });
        else options.push({ name, word });
        break;
      }
      options.push({ name, word });
    }
  }
  return { options, operands };
}

function has(parsed: ParsedArgs, ...names: string[]): boolean {
  return parsed.options.some((o) => names.includes(o.name));
}

function optionValue(parsed: ParsedArgs, ...names: string[]): ShellWord | undefined {
  return parsed.options.find((o) => names.includes(o.name) && o.value)?.value;
}

// ───────────────────────── 入口 ─────────────────────────

/** 把一条简单命令（argv[0] 是命令名）映射成伪工具调用 */
export function runProgram(ctx: ProgramContext, argv: readonly ShellWord[], extraOperands = false): void {
  const [name, ...args] = argv;
  if (!name) return;
  if (name.value === null) {
    ctx.opaque(`命令名 ${name.text} 是变量或命令替换，没法确定要跑什么`);
    return;
  }
  const program = programName(name.value);
  const inv = new Invocation(ctx, extraOperands);
  const handler = Object.hasOwn(PROGRAMS, program) ? PROGRAMS[program] : undefined;
  if (handler) {
    handler(inv, args, program);
    readLeftoverPaths(inv, args);
  } else if (looksLikePath(name.value)) {
    // ./build.sh、tools/x.py 这类直接执行的脚本
    const path = inv.path(name);
    ctx.emit("run_script", { interpreter: "", path });
    readLeftoverPaths(inv, args);
  } else {
    genericCommand(inv, program, args);
  }
}

/** 程序名：去掉目录和 .exe，小写 */
function programName(value: string): string {
  const base = value.split(/[\\/]/).pop() ?? value;
  return base.replace(/\.exe$/i, "").toLowerCase();
}

/**
 * 长得像路径的词：含 `/` 或 `\`、以 `~` 或 `.` 开头、或者是 `X:` 盘符开头。
 * 网址（`https://…`）和 `host:path`、`git@host:repo` 这类远端地址不算。
 */
export function looksLikePath(v: string): boolean {
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(v)) return false;
  if (/^[^/\\:\s]{2,}:/.test(v)) return false;
  return v.includes("/") || v.includes("\\") || v.startsWith("~") || v.startsWith(".") || /^[a-z]:/i.test(v);
}

/** 词是不是可能指向路径：静态值长得像路径，或者没法确定的词原文里有路径分隔符 */
function mayBePath(word: ShellWord): boolean {
  if (word.value !== null) return looksLikePath(word.value) || looksLikePath(word.value.replace(/^--?[\w-]+=/, ""));
  return /[\\/]/.test(word.text) || word.text.startsWith("~");
}

/** 表里的程序处理完后，没用到的、像路径的词按"读"补上 */
function readLeftoverPaths(inv: Invocation, args: readonly ShellWord[]): void {
  for (const w of args) {
    if (inv.used.has(w) || !mayBePath(w)) continue;
    const target = optionAssignedValue(w) ?? w;
    const p = inv.path(target);
    if (p !== undefined) inv.emit("read", { path: p });
  }
}

/** `--file=/x/y` 里的 /x/y */
function optionAssignedValue(word: ShellWord): ShellWord | undefined {
  const m = word.value === null ? null : /^--?[\w-]+=(.+)$/.exec(word.value);
  return m ? { value: m[1]!, text: m[1]! } : undefined;
}

/** 不在表里的程序：shell_command，带上像路径的词 */
function genericCommand(inv: Invocation, program: string, args: readonly ShellWord[]): void {
  const paths: string[] = [];
  for (const w of args) {
    if (!mayBePath(w)) continue;
    const p = inv.path(optionAssignedValue(w) ?? w);
    if (p !== undefined) paths.push(...(Array.isArray(p) ? p : [p]));
  }
  inv.emit("shell_command", { program, paths });
}

type Handler = (inv: Invocation, args: readonly ShellWord[], program: string) => void;

// ───────────────────────── 文件 ─────────────────────────

/** 只读的命令：每个操作数各读一次；没有操作数时是一条普通命令 */
function readEach(valueOptions: string[] = []): Handler {
  return (inv, args, program) => {
    const parsed = parseArgs(args, valueOptions);
    inv.skip(...parsed.options.map((o) => o.value));
    if (parsed.operands.length === 0 && !inv.extraOperands) {
      inv.emit("shell_command", { program, paths: [] });
      return;
    }
    inv.emitEachPath("read", parsed.operands);
  };
}

/** 第一个操作数是模式或脚本（grep、sed、awk、jq），后面的是文件 */
function patternThenFiles(valueOptions: string[], patternOptions: string[]): Handler {
  return (inv, args, program) => {
    const parsed = parseArgs(args, valueOptions);
    inv.skip(...parsed.options.filter((o) => !["-f", "--file"].includes(o.name)).map((o) => o.value));
    const files = has(parsed, ...patternOptions) ? parsed.operands : parsed.operands.slice(1);
    const pattern = has(parsed, ...patternOptions) ? undefined : parsed.operands[0];
    if ((program === "awk" || program === "gawk" || program === "mawk") && pattern?.value && /\bsystem\s*\(|\|&?\s*getline/.test(pattern.value)) {
      inv.ctx.opaque("awk 程序里调用了外部命令");
      return;
    }
    if (pattern && pattern.value !== null) inv.skip(pattern);
    const inPlace = program === "sed" && parsed.options.some((o) => o.name === "-i" || o.name.startsWith("--in-place"));
    if (files.length === 0 && !inv.extraOperands) {
      inv.emit("shell_command", { program, paths: [] });
      return;
    }
    inv.emitEachPath(inPlace ? "edit" : "read", files);
  };
}

const remove: Handler = (inv, args) => {
  const parsed = parseArgs(args);
  const recursive = has(parsed, "-r", "-R", "--recursive");
  inv.emitEachPath("delete", parsed.operands, { recursive });
};

/** mv、cp：最后一个操作数（或 -t 目录）是目标 */
function transfer(tool: "move" | "copy"): Handler {
  return (inv, args) => {
    const parsed = parseArgs(args, ["-t", "--target-directory", "-S", "--suffix"]);
    const targetDir = optionValue(parsed, "-t", "--target-directory");
    const sources = targetDir ? parsed.operands : parsed.operands.slice(0, -1);
    const dest = targetDir ?? parsed.operands.at(-1) ?? XARGS_WORD;
    const to = inv.path(dest);
    const all = inv.extraOperands ? [...sources, XARGS_WORD] : sources;
    for (const s of all) {
      const from = inv.path(s);
      if (from !== undefined) inv.emit(tool, { from, to });
    }
  };
}

const makeDir: Handler = (inv, args) => {
  const parsed = parseArgs(args, ["-m", "--mode"]);
  inv.skip(...parsed.options.map((o) => o.value));
  inv.emitEachPath("make_dir", parsed.operands);
};

/** 改文件但不整个替换内容：touch、tee -a、ln、chmod */
function editEach(valueOptions: string[], skipFirstOperand = false): Handler {
  return (inv, args) => {
    const parsed = parseArgs(args, valueOptions);
    for (const o of parsed.options) if (o.value) inv.path(o.value);
    const operands = skipFirstOperand ? parsed.operands.slice(1) : parsed.operands;
    if (skipFirstOperand) inv.skip(parsed.operands[0]);
    inv.emitEachPath("edit", operands);
  };
}

const tee: Handler = (inv, args) => {
  const parsed = parseArgs(args);
  inv.emitEachPath(has(parsed, "-a", "--append") ? "edit" : "write", parsed.operands);
};

const truncate: Handler = (inv, args) => {
  const parsed = parseArgs(args, ["-s", "--size", "-r", "--reference"]);
  inv.skip(optionValue(parsed, "-s", "--size"));
  inv.emitEachPath("write", parsed.operands);
};

const dd: Handler = (inv, args) => {
  for (const w of args) {
    const m = w.value === null ? null : /^(if|of)=(.*)$/.exec(w.value);
    if (!m) continue;
    inv.skip(w);
    const p = inv.path({ value: m[2]!, text: m[2]! });
    if (p !== undefined) inv.emit(m[1] === "of" ? "write" : "read", { path: p });
  }
};

const chown: Handler = (inv, args, program) => {
  inv.emit("account_command", { program, command: inv.ctx.text });
  editEach(["--reference"], true)(inv, args, program);
};

// ───────────────────────── git ─────────────────────────

const GIT_READ = new Set([
  "status", "diff", "log", "show", "blame", "rev-parse", "ls-files", "ls-tree", "describe", "shortlog", "grep", "reflog", "cat-file", "whatchanged",
]);

const git: Handler = (inv, args) => {
  // 全局选项：-C <路径>、-c k=v、--git-dir=、--work-tree=
  let i = 0;
  let repo: ShellWord | undefined;
  while (i < args.length) {
    const v = args[i]!.value;
    if (v === "-C" && args[i + 1]) {
      inv.skip(args[i]);
      repo = args[i + 1];
      i += 2;
    } else if (v === "-c" && args[i + 1]) {
      inv.skip(args[i], args[i + 1]);
      i += 2;
    } else if (v !== null && v.startsWith("-")) i++;
    else break;
  }
  const sub = args[i];
  const rest = args.slice(i + 1);
  inv.skip(sub);
  const repoPath = repo ? inv.path(repo) : inv.ctx.cwd();
  const parsed = parseArgs(rest, ["-m", "--message", "-F", "--file", "-C", "-c", "--reuse-message", "-o", "--strategy-option", "-s", "--strategy", "-u", "--set-upstream-to", "-b", "-B", "--depth", "--branch", "--origin"]);
  const subName = sub?.value ?? "";
  switch (subName) {
    case "push": {
      const force =
        parsed.options.some((o) => ["-f", "--force", "--mirror"].includes(o.name) || o.name.startsWith("--force-with-lease") || o.name === "--force-if-includes") ||
        parsed.operands.some((w) => w.value?.startsWith("+") ?? false);
      const [remote, branch] = parsed.operands;
      inv.skip(...parsed.operands);
      inv.emit("git_push", { repoPath, remote: remote?.value ?? remote?.text ?? null, branch: branch?.value ?? branch?.text ?? null, force });
      return;
    }
    case "commit": {
      const message = optionValue(parsed, "-m", "--message");
      inv.skip(message);
      inv.emit("git_commit", { repoPath, message: message?.value ?? message?.text ?? null });
      return;
    }
    case "merge":
      inv.skip(...parsed.operands, ...parsed.options.map((o) => o.value));
      inv.emit("git_merge", { repoPath, branch: parsed.operands[0]?.value ?? null });
      return;
    case "pull": {
      const [remote, branch] = parsed.operands;
      inv.skip(...parsed.operands);
      inv.emit("git_fetch", { repoPath, remote: remote?.value ?? null, url: null });
      inv.emit("git_merge", { repoPath, branch: branch?.value ?? null });
      return;
    }
    case "fetch":
      inv.skip(...parsed.operands);
      inv.emit("git_fetch", { repoPath, remote: parsed.operands[0]?.value ?? null, url: null });
      return;
    case "clone": {
      const [url, dest] = parsed.operands;
      inv.skip(url, ...parsed.options.map((o) => o.value));
      const target = dest ? inv.path(dest) : repoPath;
      inv.emit("git_fetch", { repoPath: target, remote: null, url: url?.value ?? url?.text ?? null });
      return;
    }
    case "reset":
      if (has(parsed, "--hard", "--merge", "--keep")) {
        inv.skip(...parsed.operands);
        inv.emit("git_discard", { repoPath, command: inv.ctx.text });
      } else inv.emit("git_status_diff", { repoPath });
      return;
    case "clean":
      if (has(parsed, "-n", "--dry-run")) inv.emit("git_status_diff", { repoPath });
      else inv.emit("git_discard", { repoPath, command: inv.ctx.text });
      return;
    case "checkout":
    case "restore": {
      const discards = subName === "restore" || has(parsed, "-f", "--force") || rest.some((w) => w.value === "--") || parsed.operands.some((w) => w.value === ".");
      if (discards) {
        inv.skip(...parsed.operands);
        inv.emit("git_discard", { repoPath, command: inv.ctx.text });
      } else {
        inv.skip(...parsed.operands);
        inv.emit("shell_command", { program: "git", paths: [] });
      }
      return;
    }
    case "stash":
      if (["drop", "clear"].includes(parsed.operands[0]?.value ?? "")) inv.emit("git_discard", { repoPath, command: inv.ctx.text });
      else inv.emit("shell_command", { program: "git", paths: [] });
      inv.skip(...parsed.operands);
      return;
    case "rm":
      inv.emitEachPath("delete", parsed.operands, { recursive: has(parsed, "-r") });
      return;
    case "mv":
      transfer("move")(inv, rest, "git");
      return;
    case "config":
      if (has(parsed, "--global", "--system") && !has(parsed, "--get", "--list", "-l", "--get-all", "--get-regexp")) {
        inv.emit("account_command", { program: "git config", command: inv.ctx.text });
      } else inv.emit("shell_command", { program: "git", paths: [] });
      inv.skip(...parsed.operands);
      return;
    case "credential":
      inv.emit("account_command", { program: "git credential", command: inv.ctx.text });
      return;
    default:
      if (GIT_READ.has(subName)) {
        inv.skip(...parsed.operands.filter((w) => !mayBePath(w)), ...parsed.options.map((o) => o.value));
        inv.emit("git_status_diff", { repoPath });
      } else {
        inv.skip(...parsed.operands.filter((w) => !mayBePath(w)), ...parsed.options.map((o) => o.value));
        inv.emit("shell_command", { program: `git ${subName}`.trim(), paths: [] });
      }
  }
};

// ───────────────────────── GitHub 命令行 ─────────────────────────

const GH_WRITE_VERBS = new Set([
  "create", "comment", "edit", "close", "reopen", "merge", "delete", "upload", "review", "ready", "lock", "unlock", "transfer", "pin", "unpin",
  "develop", "set", "remove", "rerun", "cancel", "enable", "disable", "run", "fork", "rename", "archive", "unarchive", "sync", "add",
]);

const gh: Handler = (inv, args) => {
  const [group, verb] = args;
  inv.skip(...args.filter((w) => !mayBePath(w)));
  const g = group?.value ?? "";
  const v = verb?.value ?? "";
  if (g === "auth") {
    inv.emit("account_command", { program: "gh auth", command: inv.ctx.text });
    return;
  }
  if (g === "repo" && v === "create") {
    const parsed = parseArgs(args.slice(2), ["--description", "-d", "--homepage", "-h", "--team", "-t", "--template", "-p", "--source", "-s", "--remote", "-r", "--gitignore", "-g", "--license", "-l"]);
    const visibility = has(parsed, "--public") ? "public" : has(parsed, "--internal") ? "internal" : has(parsed, "--private") ? "private" : null;
    const description = optionValue(parsed, "--description", "-d");
    inv.emit("create_remote_repo", {
      repoPath: inv.ctx.cwd(),
      name: parsed.operands[0]?.value ?? null,
      visibility,
      description: description?.value ?? null,
    });
    return;
  }
  if (g === "repo" && v === "clone") {
    inv.emit("git_fetch", { repoPath: inv.ctx.cwd(), remote: null, url: args[2]?.value ?? null });
    return;
  }
  if (g === "api") {
    const parsed = parseArgs(args.slice(1), ["-X", "--method", "-f", "--raw-field", "-F", "--field", "--input", "-H", "--header", "-q", "--jq", "-t", "--template"]);
    const method = optionValue(parsed, "-X", "--method")?.value?.toUpperCase() ?? (has(parsed, "-f", "--raw-field", "-F", "--field", "--input") ? "POST" : "GET");
    if (method === "GET" || method === "HEAD") inv.emit("network_read", { program: "gh api", command: inv.ctx.text });
    else inv.emit("github_write", { command: inv.ctx.text });
    return;
  }
  if (GH_WRITE_VERBS.has(v)) inv.emit("github_write", { command: inv.ctx.text });
  else inv.emit("network_read", { program: `gh ${g}`.trim(), command: inv.ctx.text });
};

// ───────────────────────── 包管理 ─────────────────────────

const NPM_INSTALL = new Set(["install", "i", "in", "ins", "inst", "add", "ci", "clean-install", "ic", "update", "up", "upgrade", "uninstall", "remove", "rm", "un", "r", "unlink"]);
const NPM_ACCOUNT = new Set(["login", "adduser", "add-user", "logout", "token", "owner", "access", "profile"]);
const TEST_RUNNERS = new Set(["vitest", "jest", "mocha", "ava", "tap", "playwright", "cypress", "pytest", "karma"]);
const BUILD_TOOLS = new Set(["tsc", "vite", "webpack", "rollup", "esbuild", "tsup", "next", "parcel"]);

/** npm、pnpm、yarn、bun 共用：script 名以 test 开头算跑测试，以 build 开头算构建 */
function packageScript(inv: Invocation, script: string | null, program: string): void {
  if (script !== null && /^test(?:[:.-]|$)/.test(script)) inv.emit("run_tests", { repoPath: inv.ctx.cwd(), args: inv.ctx.text });
  else if (script !== null && /^build(?:[:.-]|$)/.test(script)) inv.emit("start_build", { repoPath: inv.ctx.cwd(), args: inv.ctx.text });
  else inv.emit("shell_command", { program: `${program} run ${script ?? ""}`.trim(), paths: [] });
}

function installCall(inv: Invocation, global: boolean, program: string, packages: ShellWord[]): void {
  const names = packages.filter((w) => !mayBePath(w));
  inv.skip(...names);
  if (global) inv.emit("install_global", { program, packages: names.map((w) => w.value ?? w.text) });
  else inv.emit("install_deps", { repoPath: inv.ctx.cwd(), packages: names.map((w) => w.value ?? w.text) });
}

const npmLike: Handler = (inv, args, program) => {
  const parsed = parseArgs(args, ["--prefix", "-C", "--dir", "--filter", "-w", "--workspace", "--registry", "--tag", "--otp"]);
  const [sub, ...operands] = parsed.operands;
  inv.skip(sub, ...parsed.options.map((o) => o.value));
  const global = has(parsed, "-g", "--global", "--location=global");
  const s = sub?.value ?? (program === "yarn" ? "install" : "");
  if (program === "yarn" && s === "global") {
    installCall(inv, true, program, operands.slice(1));
    inv.skip(operands[0]);
    return;
  }
  if (NPM_INSTALL.has(s) || (program === "yarn" && s === "")) installCall(inv, global, program, operands);
  else if (s === "test" || s === "t" || s === "tst") inv.emit("run_tests", { repoPath: inv.ctx.cwd(), args: inv.ctx.text });
  else if (s === "run" || s === "run-script") {
    inv.skip(operands[0]);
    packageScript(inv, operands[0]?.value ?? null, program);
  } else if (s === "publish") inv.emit("publish_package", { program, command: inv.ctx.text });
  else if (NPM_ACCOUNT.has(s)) inv.emit("account_command", { program: `${program} ${s}`, command: inv.ctx.text });
  else if (s === "exec" || s === "x" || s === "dlx") runPackage(inv, operands, program);
  else if (program !== "npm" && s !== "" && !["init", "create", "list", "ls", "outdated", "why", "info", "view", "config", "cache", "audit"].includes(s)) {
    // pnpm build、yarn test、bun run 之外的 `pnpm <script>` 写法
    packageScript(inv, s, program);
  } else inv.emit("shell_command", { program: `${program} ${s}`.trim(), paths: [] });
};

/** npx、bunx、pnpm dlx：跑测试工具算跑测试，跑构建工具算构建，否则可能从网上下载包来跑 */
function runPackage(inv: Invocation, args: readonly ShellWord[], program: string): void {
  const parsed = parseArgs(args, ["-p", "--package", "-c", "--call"], true);
  if (has(parsed, "-c", "--call")) {
    inv.ctx.opaque(`${program} -c 跑的是一段内联命令`);
    return;
  }
  const pkg = parsed.operands[0];
  inv.skip(pkg, ...parsed.options.map((o) => o.value));
  const name = pkg?.value ? programName(pkg.value.replace(/@[^/@]*$/, "")) : "";
  if (TEST_RUNNERS.has(name)) inv.emit("run_tests", { repoPath: inv.ctx.cwd(), args: inv.ctx.text });
  else if (BUILD_TOOLS.has(name)) inv.emit("start_build", { repoPath: inv.ctx.cwd(), args: inv.ctx.text });
  else inv.emit("run_package", { program, package: pkg?.value ?? null, command: inv.ctx.text });
}

const npx: Handler = (inv, args, program) => runPackage(inv, args, program);

const pip: Handler = (inv, args, program) => {
  const parsed = parseArgs(args, ["-r", "--requirement", "-t", "--target", "-c", "--constraint", "-i", "--index-url", "--extra-index-url", "-e", "--editable"]);
  const [sub, ...packages] = parsed.operands;
  inv.skip(sub);
  const s = sub?.value ?? "";
  if (s === "install" || s === "uninstall" || s === "download") {
    const target = optionValue(parsed, "-t", "--target");
    if (target) inv.path(target);
    installCall(inv, target === undefined, program, packages);
  } else inv.emit("shell_command", { program: `${program} ${s}`.trim(), paths: [] });
};

const uv: Handler = (inv, args) => {
  const [sub, ...rest] = args;
  inv.skip(sub);
  const s = sub?.value ?? "";
  if (s === "pip") pip(inv, rest, "uv pip");
  else if (s === "add" || s === "remove" || s === "sync" || s === "lock") installCall(inv, false, `uv ${s}`, parseArgs(rest).operands);
  else if (s === "tool") {
    const [verb, ...packages] = rest;
    inv.skip(verb);
    if (verb?.value === "install" || verb?.value === "uninstall") installCall(inv, true, "uv tool", packages);
    else if (verb?.value === "run") runPackage(inv, packages, "uv tool run");
    else inv.emit("shell_command", { program: "uv tool", paths: [] });
  } else if (s === "run") runProgram(inv.ctx, rest, inv.extraOperands);
  else inv.emit("shell_command", { program: `uv ${s}`.trim(), paths: [] });
};

/** 系统级包管理（choco、winget、scoop、apt、brew……）：装、卸、升级都算全局装软件 */
const systemPackages: Handler = (inv, args, program) => {
  const parsed = parseArgs(args);
  const [sub, ...packages] = parsed.operands;
  inv.skip(sub);
  if (["install", "uninstall", "remove", "upgrade", "update", "add", "reinstall", "purge"].includes(sub?.value ?? "")) {
    installCall(inv, true, program, packages);
  } else inv.emit("shell_command", { program: `${program} ${sub?.value ?? ""}`.trim(), paths: [] });
};

/** cargo、go、dotnet、gem：install 是全局，test / build 对应跑测试和构建 */
const toolchain: Handler = (inv, args, program) => {
  const parsed = parseArgs(args);
  const [sub, ...rest] = parsed.operands;
  inv.skip(sub);
  const s = sub?.value ?? "";
  if (s === "install" || (program === "dotnet" && s === "tool")) installCall(inv, true, program, rest);
  else if (s === "test") inv.emit("run_tests", { repoPath: inv.ctx.cwd(), args: inv.ctx.text });
  else if (s === "build") inv.emit("start_build", { repoPath: inv.ctx.cwd(), args: inv.ctx.text });
  else if (s === "add" || s === "get" || s === "fetch") installCall(inv, false, program, rest);
  else inv.emit("shell_command", { program: `${program} ${s}`.trim(), paths: [] });
};

// ───────────────────────── 联网 ─────────────────────────

const CURL_VALUE_OPTIONS = [
  "-X", "--request", "-d", "--data", "--data-raw", "--data-binary", "--data-urlencode", "--data-ascii", "--json", "-F", "--form", "--form-string",
  "-T", "--upload-file", "-o", "--output", "-H", "--header", "-u", "--user", "-A", "--user-agent", "-e", "--referer", "-b", "--cookie",
  "-c", "--cookie-jar", "-K", "--config", "-x", "--proxy", "--url", "-w", "--write-out", "-m", "--max-time", "--connect-timeout", "-r",
  "--range", "-D", "--dump-header", "--cacert", "--cert", "--key", "-E", "--retry", "-C", "--continue-at", "-z", "--time-cond", "--resolve",
  "--interface", "-Y", "-y", "-U", "--proxy-user", "--max-filesize", "-P", "-Q", "--quote", "--limit-rate", "--output-dir",
];
const CURL_DATA = ["-d", "--data", "--data-raw", "--data-binary", "--data-urlencode", "--data-ascii", "--json", "-F", "--form", "--form-string"];

const curl: Handler = (inv, args) => {
  const parsed = parseArgs(args, CURL_VALUE_OPTIONS);
  const explicit = optionValue(parsed, "-X", "--request")?.value?.toUpperCase();
  const method =
    explicit ??
    (has(parsed, "-G", "--get")
      ? "GET"
      : has(parsed, "-T", "--upload-file")
        ? "PUT"
        : has(parsed, ...CURL_DATA)
          ? "POST"
          : has(parsed, "-I", "--head")
            ? "HEAD"
            : "GET");
  const url = optionValue(parsed, "--url") ?? parsed.operands[0];
  inv.skip(...parsed.operands, ...parsed.options.map((o) => o.value));
  inv.emit("http_request", { method, url: url?.value ?? url?.text ?? null, command: inv.ctx.text });
  // 读：-d @文件、-F x=@文件、-T 文件、-K 配置；写：-o 文件
  for (const o of parsed.options) {
    if (!o.value || o.value.value === null) continue;
    const v = o.value.value;
    if ((CURL_DATA.includes(o.name) || o.name === "--json") && /(?:^|=)[@<]/.test(v)) {
      const file = v.replace(/^[^@<]*[@<]/, "").replace(/;.*$/, "");
      emitPath(inv, "read", file);
    } else if (["-T", "--upload-file", "-K", "--config"].includes(o.name)) emitPath(inv, "read", v);
    else if (["-o", "--output", "-D", "--dump-header", "-c", "--cookie-jar"].includes(o.name)) emitPath(inv, "write", v);
  }
};

const wget: Handler = (inv, args) => {
  const parsed = parseArgs(args, [
    "-O", "--output-document", "-o", "--output-file", "-a", "--append-output", "-P", "--directory-prefix", "--post-data", "--post-file",
    "--body-data", "--body-file", "--method", "--header", "-U", "--user-agent", "-e", "--execute", "-i", "--input-file", "-t", "--tries",
    "-T", "--timeout", "--user", "--password", "--http-user", "--http-password",
  ]);
  const explicit = optionValue(parsed, "--method")?.value?.toUpperCase();
  const method = explicit ?? (has(parsed, "--post-data", "--post-file", "--body-data", "--body-file") ? "POST" : "GET");
  inv.skip(...parsed.operands, ...parsed.options.map((o) => o.value));
  inv.emit("http_request", { method, url: parsed.operands[0]?.value ?? parsed.operands[0]?.text ?? null, command: inv.ctx.text });
  for (const o of parsed.options) {
    const v = o.value?.value;
    if (v === undefined || v === null) continue;
    if (["-O", "--output-document", "-o", "--output-file", "-a", "--append-output"].includes(o.name)) emitPath(inv, "write", v);
    else if (["-P", "--directory-prefix"].includes(o.name)) emitPath(inv, "make_dir", v);
    else if (["--post-file", "--body-file", "-i", "--input-file"].includes(o.name)) emitPath(inv, "read", v);
  }
};

/** httpie / xh：`http POST url a=1` */
const httpie: Handler = (inv, args) => {
  const parsed = parseArgs(args);
  const [first, second, ...items] = parsed.operands;
  const explicit = first?.value && /^[A-Z]+$/.test(first.value) ? first.value : undefined;
  const url = explicit ? second : first;
  const dataItems = (explicit ? items : [second, ...items]).filter((w): w is ShellWord => w !== undefined && /[=@]/.test(w.value ?? w.text));
  inv.skip(...parsed.operands);
  inv.emit("http_request", { method: explicit ?? (dataItems.length > 0 ? "POST" : "GET"), url: url?.value ?? null, command: inv.ctx.text });
};

function emitPath(inv: Invocation, tool: string, value: string): void {
  const p = inv.path({ value, text: value });
  if (p !== undefined) inv.emit(tool, { path: p });
}

/** ssh、scp、nc 这类连接远端主机的命令：一律算对外发送 */
const networkCommand: Handler = (inv, args, program) => {
  if (program === "rsync" && !args.some((w) => /^[^/\\:\s]{2,}:/.test(w.value ?? w.text) || /^rsync:\/\//.test(w.value ?? ""))) {
    transfer("copy")(inv, args.filter((w) => !(w.value ?? "").startsWith("-")), program);
    return;
  }
  inv.skip(...args.filter((w) => /^[^/\\:\s]{2,}:/.test(w.value ?? w.text)));
  inv.emit("network_command", { program, command: inv.ctx.text });
};

/** ping、nslookup 这类只读的联网命令 */
const networkRead: Handler = (inv, args, program) => {
  inv.skip(...args);
  inv.emit("network_read", { program, command: inv.ctx.text });
};

// ───────────────────────── 解释器和脚本 ─────────────────────────

/**
 * 解释器：带脚本文件的是跑脚本；内联代码（-c、-e……）、没有脚本文件（从标准输入读）一律拆不开。
 * inline：给出内联代码的选项；values：带值的其他选项。
 */
function interpreter(inline: string[], values: string[] = []): Handler {
  return (inv, args, program) => {
    const parsed = parseArgs(args, values, true);
    if (has(parsed, ...inline)) {
      inv.ctx.opaque(`${program} 跑的是内联脚本（${parsed.options.find((o) => inline.includes(o.name))!.name}）`);
      return;
    }
    inv.skip(...parsed.options.map((o) => o.value));
    if (program.startsWith("python") || program === "py") {
      const module = optionValue(parsed, "-m");
      if (module) {
        pythonModule(inv, module.value, [...parsed.operands], program);
        return;
      }
    }
    if (program === "node" && has(parsed, "--test")) {
      inv.emit("run_tests", { repoPath: inv.ctx.cwd(), args: inv.ctx.text });
      return;
    }
    const script = parsed.operands[0];
    if (!script || script.value === "-") {
      inv.ctx.opaque(`${program} 从标准输入读脚本${inv.ctx.stdin ? "（管道、here-doc 或重定向喂进来的）" : ""}`);
      return;
    }
    emitScript(inv, script, program);
  };
}

function emitScript(inv: Invocation, script: ShellWord, interpreterName: string): void {
  const v = script.value ?? "";
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(v)) {
    inv.skip(script);
    inv.ctx.opaque(`${interpreterName} 要直接跑网上的脚本 ${v}`);
    return;
  }
  inv.emit("run_script", { interpreter: interpreterName, path: inv.path(script) });
}

function pythonModule(inv: Invocation, module: string | null, rest: ShellWord[], program: string): void {
  if (module === "pip") pip(inv, rest, `${program} -m pip`);
  else if (module === "pytest" || module === "unittest") inv.emit("run_tests", { repoPath: inv.ctx.cwd(), args: inv.ctx.text });
  else if (module === "venv" && rest[0]) inv.emitEachPath("make_dir", [rest[0]]);
  else inv.emit("shell_command", { program: `${program} -m ${module ?? "?"}`, paths: [] });
}

const SHELL_VALUE_OPTIONS = ["-o", "-O", "--rcfile", "--init-file"];

const powershell: Handler = (inv, args, program) => {
  const file = args.findIndex((w) => /^-f(ile)?$/i.test(w.value ?? ""));
  if (file >= 0 && args[file + 1]) {
    inv.skip(args[file]);
    emitScript(inv, args[file + 1]!, program);
    return;
  }
  inv.ctx.opaque(`${program} 跑的是内联命令或编码过的命令`);
};

const alwaysOpaque =
  (reason: string): Handler =>
  (inv, _args, program) =>
    inv.ctx.opaque(`${program}：${reason}`);

const source: Handler = (inv, args, program) => {
  const script = args[0];
  if (!script) return;
  emitScript(inv, script, program);
};

const deno: Handler = (inv, args) => {
  const [sub, ...rest] = args;
  inv.skip(sub);
  const s = sub?.value ?? "";
  if (s === "eval") inv.ctx.opaque("deno eval 跑的是内联脚本");
  else if (s === "test") inv.emit("run_tests", { repoPath: inv.ctx.cwd(), args: inv.ctx.text });
  else if (s === "run") {
    const parsed = parseArgs(rest, [], true);
    if (parsed.operands[0]) emitScript(inv, parsed.operands[0], "deno");
    else inv.ctx.opaque("deno run 没有脚本");
  } else inv.emit("shell_command", { program: `deno ${s}`.trim(), paths: [] });
};

const bun: Handler = (inv, args, program) => {
  const parsed = parseArgs(args, [], true);
  if (has(parsed, "-e", "--eval", "-p", "--print")) {
    inv.ctx.opaque("bun 跑的是内联脚本");
    return;
  }
  const first = parsed.operands[0];
  const s = first?.value ?? "";
  if (s !== "" && looksLikePath(s) && !["install", "add", "i", "test", "run", "x", "publish", "remove", "rm", "update"].includes(s)) {
    emitScript(inv, first!, program);
    return;
  }
  if (s === "x") {
    inv.skip(first);
    runPackage(inv, args.slice(args.indexOf(first!) + 1), "bun x");
    return;
  }
  npmLike(inv, args, program);
};

// ───────────────────────── 包装命令：sudo、env、xargs、find…… ─────────────────────────

/** 跳过包装命令自己的选项，把剩下的当一条命令再判一次 */
function wrapper(values: string[] = [], extra?: (inv: Invocation) => void): Handler {
  return (inv, args, program) => {
    extra?.(inv);
    const parsed = parseArgs(args, values, true);
    inv.skip(...args);
    const start = parsed.operands[0] ? args.indexOf(parsed.operands[0]) : args.length;
    if (program === "timeout") {
      // 第一个操作数是时长
      runProgram(inv.ctx, args.slice(start + 1), inv.extraOperands);
      return;
    }
    if (start < args.length) runProgram(inv.ctx, args.slice(start), inv.extraOperands || program === "xargs");
    else if (program === "xargs") runProgram(inv.ctx, [{ value: "echo", text: "echo" }], true);
  };
}

const sudo = wrapper(["-u", "--user", "-g", "--group", "-C", "-D", "-h", "-p", "-r", "-t", "-U"], (inv) =>
  inv.emit("account_command", { program: "sudo", command: inv.ctx.text }),
);

const env: Handler = (inv, args) => {
  let i = 0;
  while (i < args.length) {
    const v = args[i]!.value;
    if (v === null) break;
    if (v === "-S" || v.startsWith("--split-string")) {
      inv.ctx.opaque("env -S 把一个字符串拆成命令来跑");
      return;
    }
    if (v === "-u" || v === "--unset" || v === "-C" || v === "--chdir") {
      if (v === "-C" || v === "--chdir") inv.ctx.cd(args[i + 1]);
      i += 2;
    } else if (v.startsWith("-") || /^[A-Za-z_][A-Za-z0-9_]*=/.test(v)) i++;
    else break;
  }
  inv.skip(...args);
  if (i < args.length) runProgram(inv.ctx, args.slice(i), inv.extraOperands);
  else inv.emit("shell_command", { program: "env", paths: [] });
};

const command: Handler = (inv, args) => {
  const parsed = parseArgs(args, [], true);
  inv.skip(...args);
  // command -v / -V 只是查命令在哪
  if (has(parsed, "-v", "-V")) {
    inv.emit("shell_command", { program: "command", paths: [] });
    return;
  }
  const start = parsed.operands[0] ? args.indexOf(parsed.operands[0]) : args.length;
  if (start < args.length) runProgram(inv.ctx, args.slice(start), inv.extraOperands);
};

const exec: Handler = (inv, args) => {
  inv.skip(...args);
  if (args.length > 0) runProgram(inv.ctx, args, inv.extraOperands);
};

const find: Handler = (inv, args) => {
  const start = args.findIndex((w) => {
    const v = w.value ?? "";
    return v.startsWith("-") || v === "(" || v === "!" || v === ")";
  });
  const roots = start < 0 ? [...args] : args.slice(0, start);
  const expr = start < 0 ? [] : args.slice(start);
  const rootWords = roots.length > 0 ? roots : [{ value: ".", text: "." }];
  for (const r of rootWords) inv.path(r);
  inv.skip(...expr);
  let deleted = false;
  for (let i = 0; i < expr.length; i++) {
    const v = expr[i]!.value;
    if (v === "-delete") {
      deleted = true;
      inv.emitEachPath("delete", rootWords, { recursive: true });
    } else if (v === "-exec" || v === "-execdir" || v === "-ok" || v === "-okdir") {
      const end = expr.findIndex((w, k) => k > i && (w.value === ";" || w.value === "+"));
      const inner = expr.slice(i + 1, end < 0 ? expr.length : end);
      // {} 换成 find 的起点：要处理的文件都在起点之下
      for (const r of rootWords) runProgram(inv.ctx, inner.map((w) => (w.value === "{}" ? r : w)), inv.extraOperands);
      i = end < 0 ? expr.length : end;
    } else if (v === "-fprint" || v === "-fprint0" || v === "-fprintf" || v === "-fls") {
      const target = expr[i + 1];
      if (target) {
        const p = inv.path(target);
        if (p !== undefined) inv.emit("write", { path: p });
      }
    }
  }
  if (!deleted) {
    for (const r of rootWords) {
      const p = inv.ctx.path(r);
      if (p !== undefined) inv.emit("read", { path: p });
    }
  }
};

const cd: Handler = (inv, args) => {
  const parsed = parseArgs(args);
  const target = parsed.operands[0];
  inv.skip(...args);
  if (target?.value === "-") {
    inv.ctx.cd({ value: null, text: "-" });
    return;
  }
  if (target) {
    const p = inv.ctx.path(target);
    if (p !== undefined) inv.emit("read", { path: p });
  }
  inv.ctx.cd(target);
};

const trap: Handler = (inv, args) => {
  inv.skip(...args);
  // trap '命令' 信号：命令是一段字符串，到时候才跑
  if (args.length >= 2 && args[0]?.value !== "-" && args[0]?.value !== "-p" && args[0]?.value !== "-l") inv.ctx.opaque("trap 里的命令是一段字符串");
  else inv.emit("shell_command", { program: "trap", paths: [] });
};

const alias: Handler = (inv, args) => {
  inv.skip(...args);
  if (args.some((w) => (w.value ?? w.text).includes("="))) inv.ctx.opaque("alias 定义的命令是一段字符串");
  else inv.emit("shell_command", { program: "alias", paths: [] });
};

const shopt: Handler = (inv, args) => {
  inv.skip(...args);
  if (args.some((w) => w.value === "expand_aliases")) inv.ctx.opaque("打开了别名展开");
  else inv.emit("shell_command", { program: "shopt", paths: [] });
};

// ───────────────────────── 账户与安全 ─────────────────────────

const accountChange: Handler = (inv, args, program) => {
  inv.skip(...args);
  inv.emit("account_change", { program, command: inv.ctx.text });
};

const accountCommand: Handler = (inv, args, program) => {
  inv.skip(...args.filter((w) => !mayBePath(w)));
  inv.emit("account_command", { program, command: inv.ctx.text });
};

/** Windows 的 net：`net user 名字 密码`、`net user 名字 /add` 是建账户或改密码 */
const net: Handler = (inv, args, program) => {
  const [sub, name, ...rest] = args;
  inv.skip(...args);
  const s = (sub?.value ?? "").toLowerCase();
  if ((s === "user" || s === "localgroup") && name) {
    if (rest.some((w) => /^\/(add|delete|del)$/i.test(w.value ?? "")) || (s === "user" && rest.some((w) => !(w.value ?? "").startsWith("/")))) {
      inv.emit("account_change", { program: `${program} ${s}`, command: inv.ctx.text });
      return;
    }
    inv.emit("account_command", { program: `${program} ${s}`, command: inv.ctx.text });
    return;
  }
  inv.emit("shell_command", { program: `${program} ${s}`.trim(), paths: [] });
};

// ───────────────────────── 程序表 ─────────────────────────

const READ = readEach();

const PROGRAMS: Readonly<Record<string, Handler>> = {
  // 只读
  cat: READ, tac: READ, less: READ, more: READ, wc: READ, nl: READ, od: READ, hexdump: READ, strings: READ, file: READ, stat: READ,
  tree: readEach(["-L", "-P", "-I"]), ls: READ, dir: READ, vdir: READ, md5sum: READ, sha1sum: READ, sha256sum: READ, sha512sum: READ,
  cksum: READ, diff: READ, cmp: READ, comm: READ, realpath: READ, readlink: READ, du: readEach(["-d", "--max-depth"]),
  head: readEach(["-n", "-c", "--lines", "--bytes"]), tail: readEach(["-n", "-c", "--lines", "--bytes"]),
  sort: (inv, args, program) => {
    const parsed = parseArgs(args, ["-o", "--output", "-k", "--key", "-t", "--field-separator", "-S", "--buffer-size", "-T"]);
    const out = optionValue(parsed, "-o", "--output");
    if (out) {
      const p = inv.path(out);
      if (p !== undefined) inv.emit("write", { path: p });
    }
    inv.skip(...parsed.options.map((o) => o.value));
    readEach()(inv, parsed.operands, program);
  },
  xxd: (inv, args, program) => (args.some((w) => w.value === "-r") ? tee(inv, args.filter((w) => w.value !== "-r").slice(1), program) : READ(inv, args, program)),
  "[": readEach(),
  "[[": readEach(),
  test: readEach(),
  grep: patternThenFiles(["-e", "--regexp", "-f", "--file", "-A", "-B", "-C", "-m", "--max-count", "--include", "--exclude", "--exclude-dir"], ["-e", "--regexp", "-f", "--file"]),
  egrep: patternThenFiles(["-e", "-f", "-A", "-B", "-C", "-m"], ["-e", "-f"]),
  fgrep: patternThenFiles(["-e", "-f", "-A", "-B", "-C", "-m"], ["-e", "-f"]),
  rg: patternThenFiles(["-e", "--regexp", "-f", "--file", "-g", "--glob", "-t", "--type", "-T", "-A", "-B", "-C", "-m", "--max-count"], ["-e", "--regexp", "-f", "--file"]),
  sed: patternThenFiles(["-e", "--expression", "-f", "--file", "-l"], ["-e", "--expression", "-f", "--file"]),
  awk: patternThenFiles(["-F", "-v", "-f"], ["-f"]),
  gawk: patternThenFiles(["-F", "-v", "-f"], ["-f"]),
  mawk: patternThenFiles(["-F", "-v", "-f"], ["-f"]),
  jq: patternThenFiles(["--arg", "--argjson", "--slurpfile", "--rawfile", "-f", "--from-file", "--indent"], ["-f", "--from-file"]),
  // 写、删
  rm: remove, rmdir: remove, unlink: remove, shred: remove,
  mv: transfer("move"), cp: transfer("copy"), install: transfer("copy"),
  mkdir: makeDir,
  touch: editEach(["-d", "--date", "-t", "-r", "--reference"]),
  ln: editEach(["-t", "--target-directory", "-S", "--suffix"]),
  chmod: editEach(["--reference"], true),
  chown: chown, chgrp: chown,
  tee, truncate, dd,
  // 版本库
  git, gh,
  // 包管理
  npm: npmLike, pnpm: npmLike, yarn: npmLike, bun, npx, bunx: npx,
  pip, pip3: pip, pipx: (inv, args) => systemPackages(inv, args, "pipx"), uv, conda: systemPackages, mamba: systemPackages,
  poetry: (inv, args) => {
    const sub = args[0]?.value ?? "";
    inv.skip(args[0]);
    if (["add", "install", "remove", "update", "lock"].includes(sub)) installCall(inv, false, "poetry", parseArgs(args.slice(1)).operands);
    else if (sub === "run") runProgram(inv.ctx, args.slice(1), inv.extraOperands);
    else inv.emit("shell_command", { program: `poetry ${sub}`.trim(), paths: [] });
  },
  choco: systemPackages, winget: systemPackages, scoop: systemPackages, apt: systemPackages, "apt-get": systemPackages, brew: systemPackages,
  dnf: systemPackages, yum: systemPackages, pacman: systemPackages, snap: systemPackages,
  cargo: toolchain, go: toolchain, gem: toolchain, dotnet: toolchain,
  pytest: (inv) => inv.emit("run_tests", { repoPath: inv.ctx.cwd(), args: inv.ctx.text }),
  vitest: (inv) => inv.emit("run_tests", { repoPath: inv.ctx.cwd(), args: inv.ctx.text }),
  jest: (inv) => inv.emit("run_tests", { repoPath: inv.ctx.cwd(), args: inv.ctx.text }),
  tsc: (inv) => inv.emit("start_build", { repoPath: inv.ctx.cwd(), args: inv.ctx.text }),
  // 联网
  curl, wget, http: httpie, https: httpie, xh: httpie,
  ssh: networkCommand, scp: networkCommand, sftp: networkCommand, rsync: networkCommand, nc: networkCommand, ncat: networkCommand,
  netcat: networkCommand, telnet: networkCommand, ftp: networkCommand, socat: networkCommand, "ssh-copy-id": networkCommand,
  ping: networkRead, nslookup: networkRead, dig: networkRead, host: networkRead, traceroute: networkRead, tracert: networkRead, whois: networkRead,
  // 解释器
  bash: interpreter(["-c"], SHELL_VALUE_OPTIONS), sh: interpreter(["-c"], SHELL_VALUE_OPTIONS), zsh: interpreter(["-c"], SHELL_VALUE_OPTIONS),
  dash: interpreter(["-c"], SHELL_VALUE_OPTIONS), ksh: interpreter(["-c"], SHELL_VALUE_OPTIONS), fish: interpreter(["-c", "--command"]),
  python: interpreter(["-c"], ["-m", "-W", "-X"]), python3: interpreter(["-c"], ["-m", "-W", "-X"]), python2: interpreter(["-c"], ["-m", "-W", "-X"]),
  py: interpreter(["-c"], ["-m", "-W", "-X"]), pythonw: interpreter(["-c"], ["-m", "-W", "-X"]),
  node: interpreter(["-e", "--eval", "-p", "--print"], ["-r", "--require", "--import", "--loader", "--experimental-loader", "--env-file"]),
  nodejs: interpreter(["-e", "--eval", "-p", "--print"], ["-r", "--require", "--import"]),
  perl: interpreter(["-e", "-E"], ["-I", "-M"]), ruby: interpreter(["-e"], ["-I", "-r"]), php: interpreter(["-r"], ["-c", "-d"]),
  lua: interpreter(["-e"], ["-l"]), rscript: interpreter(["-e"]), tclsh: interpreter([]),
  deno,
  powershell, pwsh: powershell,
  cmd: alwaysOpaque("cmd 跑的是一段命令字符串"),
  osascript: alwaysOpaque("跑的是一段脚本字符串"),
  wsl: alwaysOpaque("在 WSL 里跑的命令守卫看不到"),
  mshta: alwaysOpaque("跑的是脚本"),
  wscript: interpreter([]), cscript: interpreter([]),
  certutil: alwaysOpaque("certutil 能下载和解码文件"),
  rundll32: alwaysOpaque("直接调 DLL 里的函数"),
  regsvr32: alwaysOpaque("注册 DLL"),
  eval: alwaysOpaque("eval 把字符串当命令跑"),
  source, ".": source,
  exec, command, builtin: exec, trap, alias, shopt,
  // 包装命令
  sudo, doas: sudo, gsudo: sudo, runas: sudo,
  env,
  nohup: wrapper(), time: wrapper(["-f", "--format", "-o", "--output"]), nice: wrapper(["-n", "--adjustment"]), timeout: wrapper(["-s", "--signal", "-k", "--kill-after"]),
  stdbuf: wrapper(["-i", "-o", "-e"]), unbuffer: wrapper(), caffeinate: wrapper(), chronic: wrapper(), watch: wrapper(["-n", "--interval"]),
  xargs: wrapper(["-I", "-i", "-n", "--max-args", "-L", "-P", "--max-procs", "-d", "--delimiter", "-E", "-a", "--arg-file", "-s"]),
  find,
  cd, pushd: cd,
  // 账户与安全（建账户、改密码是底线）
  passwd: accountChange, chpasswd: accountChange, useradd: accountChange, adduser: accountChange,
  userdel: accountCommand, usermod: accountCommand, groupadd: accountCommand, net,
  "ssh-keygen": accountCommand, "ssh-add": accountCommand, gpg: accountCommand, setx: accountCommand, reg: accountCommand,
  icacls: accountCommand, cacls: accountCommand, takeown: accountCommand, setfacl: accountCommand,
};
