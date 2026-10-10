// 通用 bash 说成人话（67 号票）：把参数摘要里的命令（守护进程截到 160 字的一行，guard-runtime/describe.ts 的 summarizeArgs）
// 简单拆开，常见的命令各说一句，用"，"接起来："跑测试，把改动提交：修复登录超时"。
// 用户 2026-10-10 定：前端自己简单拆，不用守护进程守卫那边的拆解结果（guard/shell/split.ts）——那份是给守卫判定用的，
// 要宁可多报；这里只是给人看的一句，认不出的命令不硬说。
// 拆法：引号里的不拆；顶层的 &&、||、;、&、换行分成先后几段，| 后面那段是管道下游（head、grep、wc 这类过滤只看不说）；
// 开头的环境变量赋值和 sudo、env、time 这类包装跳过；> / >> 写进文件的另说一句"写 …"，2>&1、> /dev/null 不算。
// 认不出的命令：整条都认不出时交回 undefined（退回"通用 bash · 命令"），夹在认得的中间的说"运行 某命令"。
// 说法照 AgentSense describe 的写法：动词加对象，不带"了"（用户 2026-10-10 定）。纯函数。
import { pathsText, shortPath, shortUrl } from "./sentence-parts.ts";

/** 拆出来的一段简单命令 */
interface Segment {
  /** 命令和参数（引号去掉了） */
  readonly words: readonly string[];
  /** 管道下游（前面是 |） */
  readonly piped: boolean;
  /** 标准输出写进的文件：path 和是不是追加（>>） */
  readonly writes: readonly { readonly path: string; readonly append: boolean }[];
}

/** 一段命令说成什么：一句话；只是过滤、进目录这类不值得说的是 null；认不出的是 undefined */
type Phrase = string | null | undefined;

/** 一条命令说成人话；一句都说不出（整条都认不出）时是 undefined */
export function bashSentence(command: string): string | undefined {
  const segments = splitCommand(command);
  const said: { prog: string; phrase: Phrase; weak: boolean }[] = [];
  for (const seg of segments) {
    const words = skipPrefix(seg.words);
    if (words.length === 0) continue;
    const prog = programOf(words[0]!);
    const weak = prog === "cd" || prog === "pushd";
    const phrase = weak ? (words[1] ? `进入 ${shortPath(words[1])}` : null) : phraseOf(prog, words[0]!, words.slice(1), seg);
    said.push({ prog, phrase, weak });
    for (const w of seg.writes) said.push({ prog, phrase: `${w.append ? "追加到" : "写"} ${shortPath(w.path)}`, weak: false });
  }
  const known = said.filter((s) => typeof s.phrase === "string");
  if (!known.some((s) => !s.weak)) {
    // 只有进目录的说进目录；有认不出的、或者什么都没说出来的退回原样
    return said.length > 0 && said.every((s) => s.phrase !== undefined) && known.length > 0 ? known.map((s) => s.phrase).join("，") : undefined;
  }
  const phrases: string[] = [];
  for (const s of said) {
    if (s.weak) continue;
    const p = s.phrase === undefined ? `运行 ${s.prog}` : s.phrase;
    if (p !== null && phrases[phrases.length - 1] !== p) phrases.push(p);
  }
  return phrases.length > 3 ? `${phrases.slice(0, 3).join("，")}，还有 ${phrases.length - 3} 步` : phrases.join("，");
}

// ───────────────────────── 拆 ─────────────────────────

/** 按引号、顶层的 && || ; & | 换行和重定向拆成几段（$( )、反引号里的整个当作一个词的一部分） */
function splitCommand(command: string): Segment[] {
  const out: Segment[] = [];
  let words: string[] = [];
  let writes: { path: string; append: boolean }[] = [];
  let piped = false;
  let word = "";
  let inWord = false;
  let quote: "'" | '"' | undefined;
  let depth = 0;
  /** 下一个词是重定向的目标：写进文件（stdout）、丢掉（stderr、/dev/null、&1）、读进来（<） */
  let target: { kind: "write"; append: boolean } | { kind: "skip" } | undefined;
  const endWord = () => {
    if (!inWord) return;
    if (target?.kind === "write" && !/^(\/dev\/null|nul|&\d?)$/i.test(word)) writes.push({ path: word, append: target.append });
    else if (target === undefined) words.push(word);
    target = undefined;
    word = "";
    inWord = false;
  };
  const endSegment = (nextPiped: boolean) => {
    endWord();
    if (words.length > 0 || writes.length > 0) out.push({ words, piped, writes });
    words = [];
    writes = [];
    piped = nextPiped;
  };
  for (let i = 0; i < command.length; i++) {
    const c = command[i]!;
    const next = command[i + 1];
    if (quote) {
      if (c === quote) quote = undefined;
      else if (c === "\\" && quote === '"' && next !== undefined && '"\\$`'.includes(next)) word += command[++i];
      else word += c;
      continue;
    }
    if (depth > 0) {
      if (c === "(") depth++;
      else if (c === ")") depth--;
      word += c;
      continue;
    }
    if (c === "'" || c === '"') {
      quote = c;
      inWord = true;
      continue;
    }
    if (c === "$" && next === "(") {
      depth = 1;
      word += "$(";
      inWord = true;
      i++;
      continue;
    }
    if (c === "\\" && next !== undefined && " '\"\\$&|;<>()".includes(next)) {
      word += next;
      inWord = true;
      i++;
      continue;
    }
    if (c === " " || c === "\t") {
      endWord();
      continue;
    }
    if (c === "\n" || c === ";") {
      endSegment(false);
      continue;
    }
    if (c === "&" && next === "&") {
      endSegment(false);
      i++;
      continue;
    }
    if (c === "|") {
      if (next === "|") {
        endSegment(false);
        i++;
      } else endSegment(true);
      continue;
    }
    if (c === "&" && next === ">") {
      // &> 文件：标准输出和错误一起写进去
      endWord();
      const append = command[i + 2] === ">";
      target = { kind: "write", append };
      i += append ? 2 : 1;
      continue;
    }
    if (c === "&") {
      endSegment(false);
      continue;
    }
    if (c === ">" || c === "<") {
      // 前面紧挨着的数字是文件描述符：2> 是错误输出，不算写文件
      const fd = inWord && /^\d$/.test(word) ? word : undefined;
      if (fd !== undefined) {
        word = "";
        inWord = false;
      } else endWord();
      const append = c === ">" && next === ">";
      if (append) i++;
      if (command[i + 1] === "&") {
        // >&2、2>&1：只是改道，没有文件
        i++;
        while (i + 1 < command.length && /\d/.test(command[i + 1]!)) i++;
        continue;
      }
      target = c === "<" || (fd !== undefined && fd !== "1") ? { kind: "skip" } : { kind: "write", append };
      continue;
    }
    if (c === "(" || c === ")") {
      // 子 shell 的括号：只当分隔
      endWord();
      continue;
    }
    word += c;
    inWord = true;
  }
  endSegment(false);
  return out;
}

/** 跳过开头的环境变量赋值和 sudo、env、time 这类只是包一层的命令 */
function skipPrefix(words: readonly string[]): readonly string[] {
  let i = 0;
  while (i < words.length) {
    const w = words[i]!;
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(w)) i++;
    else if (WRAPPERS.has(w)) {
      i++;
      // timeout 10 cmd、nice -n 5 cmd
      while (i < words.length && (words[i]!.startsWith("-") || /^\d+[smhd]?$/.test(words[i]!))) i++;
    } else break;
  }
  return words.slice(i);
}

const WRAPPERS: ReadonlySet<string> = new Set(["sudo", "env", "time", "nohup", "exec", "command", "nice", "timeout", "cross-env", "winpty"]);

/** 命令名：去掉目录、.exe 这类后缀，转小写 */
function programOf(word: string): string {
  return (word.split(/[\\/]/).pop() ?? word).toLowerCase().replace(/\.(exe|cmd|bat|com)$/, "");
}

/** 参数里不是选项的词（-x、--xx 去掉；选项的值没法分清，个别命令自己处理） */
function plainOf(args: readonly string[]): string[] {
  return args.filter((a) => !a.startsWith("-") || a === "-");
}

/** 选项的值：-m 值、-m值、--message 值、--message=值 */
function optionValue(args: readonly string[], short: readonly string[], long: readonly string[]): string | undefined {
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    for (const l of long) {
      if (a === l) return args[i + 1];
      if (a.startsWith(`${l}=`)) return a.slice(l.length + 1);
    }
    for (const s of short) {
      if (a === s) return args[i + 1];
      if (a.startsWith(s) && !a.startsWith("--") && a.length > s.length) return a.slice(s.length);
    }
  }
  return undefined;
}

/** 参数里去掉选项和选项的值（valued：带值的选项） */
function operandsOf(args: readonly string[], valued: readonly string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === "--") {
      out.push(...args.slice(i + 1));
      break;
    }
    if (valued.includes(a)) {
      i++;
      continue;
    }
    if (a.startsWith("-") && a !== "-") continue;
    out.push(a);
  }
  return out;
}

// ───────────────────────── 每种命令怎么说 ─────────────────────────

/** 管道下游只是筛一筛、数一数的命令：不另说 */
const FILTERS: ReadonlySet<string> = new Set([
  "head", "tail", "grep", "egrep", "fgrep", "rg", "findstr", "sort", "uniq", "wc", "less", "more", "cut", "awk", "sed", "tr", "jq",
  "xargs", "tee", "cat", "column", "nl", "fold", "rev", "tac", "select-string", "select-object", "out-null", "measure-object",
]);

/** 只是设变量、开关选项、判断的：不说 */
const SILENT: ReadonlySet<string> = new Set(["export", "set", "unset", "source", ".", "alias", "true", "false", ":", "exit", "echo", "printf", "test", "[", "popd", "clear", "cls"]);

/** 跑解释器：node x.js、python x.py */
const INTERPRETERS: ReadonlySet<string> = new Set(["node", "python", "python3", "py", "deno", "ruby", "perl", "bash", "sh", "zsh", "pwsh", "powershell", "tsx", "ts-node"]);

/** 测试工具 */
const TEST_TOOLS: ReadonlySet<string> = new Set(["vitest", "jest", "mocha", "ava", "pytest"]);

/** 查代码的工具 */
const LINT_TOOLS: ReadonlySet<string> = new Set(["eslint", "oxlint", "biome", "ruff", "flake8"]);

function phraseOf(prog: string, raw: string, args: readonly string[], seg: Segment): Phrase {
  if (seg.piped && FILTERS.has(prog)) return null;
  if (SILENT.has(prog)) return null;
  // ./build.sh、scripts/deploy.py 这种直接跑的脚本
  if (/^\.{1,2}[\\/]/.test(raw) || /\.(sh|py|js|mjs|cjs|ts|ps1|rb|pl)$/i.test(raw)) return `运行 ${shortPath(raw)}`;
  const plain = plainOf(args);
  switch (prog) {
    case "git":
      return gitPhrase(args);
    case "npm":
    case "pnpm":
    case "yarn":
    case "bun":
      return packagePhrase(prog, args);
    case "npx":
    case "pnpx":
    case "bunx":
      return toolPhrase(plain[0], plain.slice(1));
    case "pip":
    case "pip3":
    case "uv":
      return pipPhrase(plain);
    case "ls":
    case "ll":
    case "la":
    case "dir":
    case "tree":
      return plain.length > 0 ? `列出 ${pathsText(plain)}` : "列出当前目录";
    case "cat":
    case "type":
    case "bat":
    case "less":
    case "more":
    case "head":
    case "tail":
    case "nl": {
      const files = operandsOf(args, ["-n", "-c"]).filter((w) => !/^\+?\d+$/.test(w));
      return files.length > 0 ? `读 ${pathsText(files)}` : null;
    }
    case "rm":
    case "del":
    case "erase":
    case "rmdir":
    case "rd":
    case "unlink":
    case "trash":
      return plain.length > 0 ? `删除 ${pathsText(plain)}` : undefined;
    case "mkdir":
    case "md":
      return plain.length > 0 ? `建目录 ${pathsText(plain)}` : undefined;
    case "touch":
      return plain.length > 0 ? `建文件 ${pathsText(plain)}` : undefined;
    case "cp":
    case "copy":
    case "xcopy":
      return twoEnds("复制到", operandsOf(args, ["-t"]));
    case "scp":
      return twoEnds("复制到", operandsOf(args, ["-i", "-P", "-F", "-o"]));
    case "mv":
    case "move":
    case "ren":
    case "rename":
      return twoEnds("移到", plain);
    case "rsync":
      return twoEnds("同步到", operandsOf(args, ["-e", "--exclude", "--include"]));
    case "chmod":
    case "chown":
      return plain.length > 1 ? `改 ${pathsText(plain.slice(1))} 的权限` : undefined;
    case "grep":
    case "egrep":
    case "fgrep":
    case "rg":
    case "findstr": {
      const ops = operandsOf(args, ["-e", "-f", "-m", "-A", "-B", "-C", "-g", "--glob", "-t", "--type"]);
      const pattern = optionValue(args, ["-e"], ["--regexp"]) ?? ops.shift();
      if (pattern === undefined) return undefined;
      return ops.length > 0 ? `在 ${pathsText(ops)} 里搜「${pattern}」` : `搜「${pattern}」`;
    }
    case "find":
    case "fd": {
      const name = optionValue(args, [], ["-name", "-iname", "-path"]);
      const where = prog === "find" ? args.find((a) => !a.startsWith("-") && a !== name) : plain[1];
      const what = prog === "find" ? name : plain[0];
      return `在${where ? ` ${shortPath(where)} ` : "当前目录"}里找${what ? ` ${what}` : "文件"}`;
    }
    case "sed":
      return args.some((a) => a === "-i" || a.startsWith("-i")) && plain.length > 1 ? `改 ${pathsText(plain.slice(1))}` : undefined;
    case "curl":
    case "wget":
    case "http":
    case "https":
    case "invoke-webrequest":
    case "iwr":
      return requestPhrase(prog, args);
    case "sleep":
      return plain[0] ? `等 ${plain[0]} 秒` : undefined;
    case "pwd":
      return "看当前目录";
    case "which":
    case "where":
    case "whereis":
      return plain[0] ? `找 ${plain[0]} 在哪` : undefined;
    case "wc":
      return plain.length > 0 ? `数 ${pathsText(plain)} 的行数` : undefined;
    case "diff":
    case "cmp":
    case "fc":
      return plain.length >= 2 ? `比较 ${shortPath(plain[0]!)} 和 ${shortPath(plain[1]!)}` : undefined;
    case "tar": {
      // 第一个参数是模式（-xzf、czf……），不带横杠的也是
      const mode = args[0] ?? "";
      const file = optionValue(args, ["-f"], ["--file"]) ?? plain[mode !== "" && !mode.startsWith("-") ? 1 : 0];
      const extract = !mode.startsWith("--") && /^-?[a-z]*x/i.test(mode);
      return file ? `${extract ? "解包" : "打包"} ${shortPath(file)}` : undefined;
    }
    case "unzip":
      return plain[0] ? `解压 ${shortPath(plain[0])}` : undefined;
    case "zip":
      return plain[0] ? `打包 ${shortPath(plain[0])}` : undefined;
    case "ps":
    case "tasklist":
      return "看进程";
    case "kill":
    case "pkill":
    case "taskkill":
      return `结束进程${plain[0] ? ` ${plain[0]}` : ""}`;
    case "ssh":
      return plain[0] ? `连接 ${plain[0]}` : undefined;
    case "gh":
      return plain[0] ? `用 gh ${plain.slice(0, 2).join(" ")}` : undefined;
    case "docker":
      return plain[0] ? `运行 docker ${plain[0]}` : undefined;
    case "make":
      return plain[0] ? `运行 make ${plain[0]}` : "运行 make";
    case "tsc":
      return "类型检查";
    case "cargo":
    case "go":
      return plain[0] === "test" ? "跑测试" : plain[0] === "build" ? "构建" : undefined;
    default:
      if (INTERPRETERS.has(prog)) return interpreterPhrase(args);
      if (TEST_TOOLS.has(prog)) return "跑测试";
      if (LINT_TOOLS.has(prog)) return "检查代码";
      return undefined;
  }
}

/** 复制、移动、同步：最后一个是目标，前面的是源 */
function twoEnds(verb: string, operands: readonly string[]): Phrase {
  if (operands.length < 2) return undefined;
  const to = operands[operands.length - 1]!;
  return `把 ${pathsText(operands.slice(0, -1))} ${verb} ${shortPath(to)}`;
}

/** git 的子命令 */
function gitPhrase(all: readonly string[]): Phrase {
  // 跳过子命令前面的全局选项：-C 目录、-c 键=值、--no-pager……
  let i = 0;
  while (i < all.length && all[i]!.startsWith("-")) i += all[i] === "-C" || all[i] === "-c" ? 2 : 1;
  const sub = all[i];
  const args = all.slice(i + 1);
  const ops = operandsOf(args, ["-m", "--message", "-b", "-B", "-c", "-C", "-n", "--format", "--pretty", "-u", "--set-upstream-to"]);
  const has = (...flags: string[]) => args.some((a) => flags.includes(a));
  switch (sub) {
    case undefined:
      return undefined;
    case "status":
      return "看 git 状态";
    case "diff":
      return ops.length > 0 ? `看 ${pathsText(ops)} 的改动` : "看改动";
    case "log":
      return "看提交记录";
    case "show":
      return ops[0] ? `看提交 ${ops[0]}` : "看最近一次提交";
    case "add":
      return ops.length === 0 || ops.includes(".") || has("-A", "--all") ? "暂存全部改动" : `暂存 ${pathsText(ops)}`;
    case "commit": {
      const message = optionValue(args, ["-m"], ["--message"]);
      const amend = has("--amend");
      if (amend) return message ? `改上一次提交：${message}` : "改上一次提交";
      return message ? `把改动提交：${message}` : "提交改动";
    }
    case "push": {
      const [remote, branch] = ops;
      if (has("--delete", "-d")) return branch ? `删除${remote ? ` ${remote} ` : "远端"}上的分支 ${branch}` : undefined;
      const force = args.some((a) => a === "-f" || a === "--force" || a.startsWith("--force-with-lease"));
      return `${force ? "强推" : "推送"}${branch ? ` ${branch} ` : "当前分支"}到${remote ? ` ${remote}` : "远端"}`;
    }
    case "pull":
      return `从${ops[0] ? ` ${ops[0]} ` : "远端"}拉取`;
    case "fetch":
      return `从${ops[0] ? ` ${ops[0]} ` : "远端"}取回`;
    case "clone":
      return ops[0] ? `克隆 ${shortUrl(ops[0])}` : undefined;
    case "checkout":
    case "switch": {
      const created = optionValue(args, ["-b", "-B", "-c", "-C"], ["--create"]);
      if (created) return `新建分支 ${created}`;
      const dashes = args.indexOf("--");
      if (dashes >= 0) return `丢弃 ${pathsText(args.slice(dashes + 1))} 的改动`;
      return ops[0] ? `切换到 ${ops[0]}` : undefined;
    }
    case "branch":
      if (has("-d", "-D", "--delete")) return ops[0] ? `删除分支 ${ops.join("、")}` : undefined;
      return ops[0] ? `新建分支 ${ops[0]}` : "看分支";
    case "merge":
      return ops[0] ? `合并分支 ${ops[0]}` : undefined;
    case "rebase":
      return ops[0] ? `变基到 ${ops[0]}` : "变基";
    case "reset":
      return has("--hard") ? `丢弃改动${ops[0] ? `，回到 ${ops[0]}` : ""}` : ops[0] ? `重置到 ${ops[0]}` : "撤销暂存";
    case "restore":
      return ops.length > 0 ? (has("--staged", "-S") ? `撤销暂存 ${pathsText(ops)}` : `丢弃 ${pathsText(ops)} 的改动`) : undefined;
    case "stash":
      return ops[0] === "pop" || ops[0] === "apply" ? "取回收起来的改动" : ops[0] === "list" ? "看收起来的改动" : "把改动先收起来";
    case "rm":
      return ops.length > 0 ? `从仓库删除 ${pathsText(ops)}` : undefined;
    case "mv":
      return twoEnds("移到", ops);
    case "tag":
      if (has("-d", "--delete")) return ops[0] ? `删除标签 ${ops[0]}` : undefined;
      return ops[0] ? `打标签 ${ops[0]}` : "看标签";
    case "init":
      return "建 git 仓库";
    case "remote":
      return ops[0] === "add" && ops[1] ? `加远端 ${ops[1]}` : "看远端";
    case "cherry-pick":
      return ops[0] ? `摘取提交 ${ops[0]}` : undefined;
    case "revert":
      return ops[0] ? `撤销提交 ${ops[0]}` : undefined;
    case "worktree":
      return ops[0] === "add" && ops[1] ? `建工作树 ${shortPath(ops[1])}` : "看工作树";
    default:
      return `运行 git ${sub}`;
  }
}

/** npm、pnpm、yarn、bun */
function packagePhrase(pm: string, args: readonly string[]): Phrase {
  const plain = plainOf(args);
  const [sub, ...rest] = plain;
  switch (sub) {
    case undefined:
      return pm === "yarn" ? "装依赖" : undefined;
    case "test":
    case "t":
    case "tst":
      return "跑测试";
    case "install":
    case "i":
    case "ci":
    case "add":
      return rest.length > 0 ? `装依赖 ${rest.join("、")}` : "装依赖";
    case "uninstall":
    case "remove":
    case "rm":
    case "un":
      return rest.length > 0 ? `卸载依赖 ${rest.join("、")}` : undefined;
    case "run":
    case "run-script":
      return rest[0] ? scriptPhrase(rest[0]) : undefined;
    case "exec":
    case "dlx":
    case "x":
      return toolPhrase(rest[0], rest.slice(1));
    default:
      // yarn build、pnpm lint 这种直接写脚本名的
      return pm === "npm" ? `运行 npm ${sub}` : scriptPhrase(sub);
  }
}

/** npm 脚本：test 开头是跑测试，build 开头是构建，lint、typecheck、check 是检查代码，别的写脚本名 */
function scriptPhrase(script: string): string {
  if (script.startsWith("test")) return script === "test" ? "跑测试" : `跑测试（${script}）`;
  if (script.startsWith("build")) return script === "build" ? "构建" : `构建（${script}）`;
  if (/^(lint|typecheck|check)/.test(script)) return `检查代码（${script}）`;
  return `跑 npm 脚本 ${script}`;
}

/** npx 起的工具 */
function toolPhrase(tool: string | undefined, rest: readonly string[]): Phrase {
  if (tool === undefined) return undefined;
  const name = programOf(tool).replace(/@.*$/, "");
  if (TEST_TOOLS.has(name) || (name === "playwright" && rest[0] === "test")) return "跑测试";
  if (name === "tsc") return "类型检查";
  if (LINT_TOOLS.has(name)) return "检查代码";
  if (name === "prettier") return "排版代码";
  return `运行 ${name}`;
}

/** pip install、uv add */
function pipPhrase(plain: readonly string[]): Phrase {
  const words = plain[0] === "pip" ? plain.slice(1) : plain;
  const [sub, ...rest] = words;
  if (sub === "install" || sub === "add" || sub === "sync") return rest.length > 0 ? `装依赖 ${rest.join("、")}` : "装依赖";
  if (sub === "run" && rest[0]) return programOf(rest[0]) === "pytest" ? "跑测试" : `运行 ${rest[0]}`;
  return undefined;
}

/** node x.js、python -m pytest、python -c "…" */
function interpreterPhrase(args: readonly string[]): Phrase {
  if (args.some((a) => ["-e", "--eval", "-p", "--print", "-command", "-Command", "-encodedcommand"].includes(a) || /^-[a-zA-Z]*c$/.test(a))) return "运行内联脚本";
  const module = optionValue(args, ["-m"], []);
  if (module) return TEST_TOOLS.has(module) ? "跑测试" : module === "pip" ? pipPhrase(plainOf(args).slice(1)) : `运行 ${module}`;
  const script = args.find((a) => !a.startsWith("-"));
  return script ? `运行 ${shortPath(script)}` : undefined;
}

/** curl、wget：请求哪个网址，带数据的是发出去 */
function requestPhrase(prog: string, args: readonly string[]): Phrase {
  const url = args.find((a) => /^https?:\/\//i.test(a)) ?? operandsOf(args, ["-X", "--request", "-H", "--header", "-d", "--data", "-o", "--output", "-u", "-F", "-A", "-e", "-b", "-c"]).find((a) => /\.[a-z]{2,}/i.test(a));
  if (url === undefined) return undefined;
  if (prog === "wget") return `下载 ${shortUrl(url)}`;
  const explicit = optionValue(args, ["-X"], ["--request", "-Method"]);
  const sends = args.some((a) => /^(-d|-F|--data.*|--json|--form|-T|--upload-file|-Body|-InFile)$/.test(a) || a.startsWith("--data"));
  const method = (explicit ?? (sends ? "POST" : "GET")).toUpperCase();
  return method === "GET" ? `请求 ${shortUrl(url)}` : `发 ${method} 请求到 ${shortUrl(url)}`;
}
